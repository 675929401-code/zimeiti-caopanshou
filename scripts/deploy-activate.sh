#!/bin/bash
# deploy-activate.sh —— 服务器端候选验收与原子切换（三轨制 A 轨执行器）
# 用法: bash deploy-activate.sh <release_id> <package_tar_path>
# 原则: 候选先验,同身份 env(继承当前生产进程),原子指针切换,失败零生产影响,绝不触碰业务数据。
set -euo pipefail

RELEASE_ID="${1:?missing release_id}"
PKG="${2:?missing package path}"
RELEASES=/data/web/releases
CURRENT=/data/web/current-web
TARGET_DIR="$RELEASES/$RELEASE_ID"
TARGET="$TARGET_DIR/web"
TOOLCHAIN_NODE=/data/direct-deploy/toolchain/bin/node
CANDIDATE_PORT=5100
RECEIPTS=/data/direct-deploy/receipts
EXPECTED_SOURCE_VERSION="${EXPECTED_SOURCE_VERSION:-}"

log() { echo "[activate] $*"; }
fail() { echo "[activate] FATAL: $*" >&2; exit 1; }

# ─── 0. 前置检查 ─────────────────────────────────────────
[ -f "$PKG" ] || fail "package missing: $PKG"
[ -x "$TOOLCHAIN_NODE" ] || fail "toolchain node missing"
[ -e "$TARGET_DIR" ] && fail "target already exists: $TARGET_DIR"
CURRENT_TARGET=$(readlink -f "$CURRENT") || fail "current-web unreadable"
log "current=$CURRENT_TARGET -> new=$TARGET"

WEB_PID=$(pgrep -f 'current-web/server.js' | head -1 || true)
[ -n "$WEB_PID" ] || fail "cannot find running web process (current-web/server.js)"
log "production web pid=$WEB_PID"

# ─── 1. 解包新 release ───────────────────────────────────
mkdir -p "$TARGET"
tar -xzf "$PKG" -C "$TARGET"
[ -f "$TARGET/server.js" ] || fail "server.js missing in package"
[ -f "$TARGET/release-manifest.json" ] || fail "release-manifest.json missing in package"
chmod -R a-w "$TARGET" || true
log "unpacked: $(du -sh "$TARGET" | awk '{print $1}')"

# ─── 2. 继承 runtime-tools（ffmpeg/ffprobe/backup-data.sh，服务器端复制零传输） ───
NEW_BUILD_ID=$("$TOOLCHAIN_NODE" -e "const m=require('$TARGET/release-manifest.json');process.stdout.write(m.buildId||'')")
[ -n "$NEW_BUILD_ID" ] || fail "buildId missing in release-manifest.json"
NEW_COMMIT_SHA=$("$TOOLCHAIN_NODE" -e "const m=require('$TARGET/release-manifest.json');process.stdout.write(m.commitSha||'unknown')")
log "new BUILD_ID=$NEW_BUILD_ID commit=$NEW_COMMIT_SHA"
if [ -d "$CURRENT_TARGET/runtime-tools" ]; then
  chmod -R u+w "$TARGET"
  cp -a "$CURRENT_TARGET/runtime-tools" "$TARGET/runtime-tools"
  chmod -R a-w "$TARGET"
  log "runtime-tools inherited"
fi

# ─── 3. 构造同身份候选 env（从当前生产进程 /proc 提取） ───
CAND_ENV=/tmp/candidate-env-$$.json
"$TOOLCHAIN_NODE" - "$WEB_PID" "$CANDIDATE_PORT" "$RELEASE_ID" "$TARGET" "$CAND_ENV" "$NEW_BUILD_ID" "$NEW_COMMIT_SHA" <<'NODEEOF'
const fs = require('fs');
const [pid, port, releaseId, releaseRoot, outFile, buildId, commitSha] = process.argv.slice(2);
const raw = fs.readFileSync(`/proc/${pid}/environ`);
const skip = /^(PM2_|pm2_|NODE_CHANNEL_|BASH_FUNC_|PWD$|OLDPWD$|SHLVL$|_$|PORT$|HOSTNAME$)/;
const env = {
  PATH: '/data/direct-deploy/toolchain/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/root',
  NODE_ENV: 'production',
};
for (const line of raw.toString('utf8').split('\0')) {
  if (!line) continue;
  const i = line.indexOf('=');
  if (i < 1) continue;
  const k = line.slice(0, i);
  if (skip.test(k)) continue;
  env[k] = line.slice(i + 1);
}
env.PORT = port;
env.HOSTNAME = '127.0.0.1';
env.RELEASE_ID = releaseId;
env.RELEASE_ROOT = releaseRoot;
env.EXPECTED_BUILD_ID = buildId;
env.DEPLOY_COMMIT_SHA = commitSha;
env.COZE_PROJECT_ENV = 'PROD';
fs.writeFileSync(outFile, JSON.stringify(env));
NODEEOF
log "candidate env prepared from production pid $WEB_PID"

# ─── 4. 候选端口启动与验收 ────────────────────────────────
CAND_LOG=/tmp/candidate-$$.log
CAND_PID_FILE=/tmp/candidate-$$.pid
"$TOOLCHAIN_NODE" - "$TARGET" "$CAND_ENV" "$CAND_PID_FILE" <<'NODEEOF' > "$CAND_LOG" 2>&1 &
const fs = require('fs');
const { spawn } = require('child_process');
const [target, envFile, pidFile] = process.argv.slice(2);
const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
const child = spawn('/data/direct-deploy/toolchain/bin/node', ['server.js'], {
  cwd: target, env, stdio: 'inherit',
});
fs.writeFileSync(pidFile, String(child.pid));
child.on('exit', (code) => process.exit(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { try { child.kill(sig); } catch {} });
NODEEOF
WRAPPER_PID=$!

cleanup_candidate() {
  [ -f "$CAND_PID_FILE" ] && kill "$(cat "$CAND_PID_FILE")" 2>/dev/null || true
  kill "$WRAPPER_PID" 2>/dev/null || true
  wait "$WRAPPER_PID" 2>/dev/null || true
}

READY=""
for i in $(seq 1 24); do
  sleep 5
  VERSION_JSON=$(curl --noproxy '*' -fsS --connect-timeout 2 --max-time 6 "http://127.0.0.1:$CANDIDATE_PORT/api/version" 2>/dev/null) && { READY=1; break; } || true
done
if [ -z "$READY" ]; then
  echo "[activate] candidate failed to become ready; last log:" >&2
  tail -30 "$CAND_LOG" >&2 || true
  cleanup_candidate
  chmod -R u+w "$TARGET_DIR" || true
  rm -rf "$TARGET_DIR"
  fail "candidate readiness timeout; release removed, production untouched"
fi
CAND_SOURCE=$(printf '%s' "$VERSION_JSON" | "$TOOLCHAIN_NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log((j.sourceVersion||'')+' '+(j.buildId||''))}catch{console.log('')}})")
log "candidate ready: $CAND_SOURCE"
if [ -n "$EXPECTED_SOURCE_VERSION" ]; then
  case "$CAND_SOURCE" in
    "$EXPECTED_SOURCE_VERSION"*) ;;
    *) cleanup_candidate; chmod -R u+w "$TARGET_DIR" || true; rm -rf "$TARGET_DIR"; fail "sourceVersion mismatch: expect $EXPECTED_SOURCE_VERSION got $CAND_SOURCE" ;;
  esac
fi
curl --noproxy '*' -fsS --connect-timeout 2 --max-time 8 "http://127.0.0.1:$CANDIDATE_PORT/api/release-readiness" > /dev/null 2>&1 \
  && log "release-readiness OK" \
  || log "release-readiness returned non-2xx (recorded, continuing; version endpoint verified)"
cleanup_candidate
log "candidate stopped"

# ─── 5. 原子切换 current 指针 ─────────────────────────────
ln -sfn "$TARGET" "$CURRENT.tmp.$$"
mv -T "$CURRENT.tmp.$$" "$CURRENT"
log "current switched -> $(readlink -f "$CURRENT")"

# ─── 6. 重载生产进程（注入 release 身份三键；不动 voice 等其他应用） ─────────────
RELEASE_ID="$RELEASE_ID" DEPLOY_COMMIT_SHA="$NEW_COMMIT_SHA" EXPECTED_BUILD_ID="$NEW_BUILD_ID" COZE_PROJECT_ENV=PROD \
  pm2 reload agent-hub-web --update-env
RELEASE_ID="$RELEASE_ID" DEPLOY_COMMIT_SHA="$NEW_COMMIT_SHA" EXPECTED_BUILD_ID="$NEW_BUILD_ID" COZE_PROJECT_ENV=PROD \
  pm2 reload agent-hub-media-worker --update-env || log "media-worker reload returned non-zero (check manually)"
sleep 5

# ─── 7. 生产验证与回执 ───────────────────────────────────
PROD_VERSION=$(curl --noproxy '*' -fsS --connect-timeout 3 --max-time 10 "http://127.0.0.1:5000/api/version" 2>/dev/null || echo '{}')
PROD_SUMMARY=$(printf '%s' "$PROD_VERSION" | "$TOOLCHAIN_NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log((j.sourceVersion||'')+' '+(j.buildId||''))}catch{console.log('')}})")
log "production after switch: $PROD_SUMMARY"
PM2_STATE=$(pm2 jlist 2>/dev/null | "$TOOLCHAIN_NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d);console.log(a.filter(p=>/agent-hub/.test(p.name)).map(p=>p.name+':'+p.pm2_env.status).join(','))}catch{console.log('unknown')}})")

mkdir -p "$RECEIPTS"
cat > "$RECEIPTS/$RELEASE_ID-activate.json" <<EOF
{
  "releaseId": "$RELEASE_ID",
  "previousCurrent": "$CURRENT_TARGET",
  "newCurrent": "$(readlink -f "$CURRENT")",
  "candidate": "$CAND_SOURCE",
  "production": "$PROD_SUMMARY",
  "pm2": "$PM2_STATE",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
log "receipt: $RECEIPTS/$RELEASE_ID-activate.json"
log "DONE production=$PROD_SUMMARY"
