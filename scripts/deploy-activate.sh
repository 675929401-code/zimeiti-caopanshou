#!/bin/bash
# deploy-activate.sh —— 服务器端候选验收与原子切换（三轨制 A 轨执行器）
# 用法: bash deploy-activate.sh <release_id> <package_tar_path>
# 原则: 候选先验,同身份 env(继承当前生产进程),原子指针切换,失败零生产影响,绝不触碰业务数据。
set -euo pipefail

RELEASE_ID="${1:?missing release_id}"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo '[activate] FATAL: invalid release_id' >&2; exit 1; }
PKG="${2:?missing package path}"
RELEASES=/data/web/releases
CURRENT=/data/web/current-web
TARGET_DIR="$RELEASES/$RELEASE_ID"
TARGET="$TARGET_DIR/web"
TOOLCHAIN_NODE=/data/direct-deploy/toolchain/bin/node
CANDIDATE_PORT=5100
RECEIPTS=/data/direct-deploy/receipts
EXPECTED_SOURCE_VERSION="${EXPECTED_SOURCE_VERSION:?missing EXPECTED_SOURCE_VERSION}"
umask 077

log() { echo "[activate] $*"; }
fail() { echo "[activate] FATAL: $*" >&2; exit 1; }

# ─── 0. 前置检查 ─────────────────────────────────────────
[ -f "$PKG" ] || fail "package missing: $PKG"
[ -x "$TOOLCHAIN_NODE" ] || fail "toolchain node missing"
[ -e "$TARGET_DIR" ] && fail "target already exists: $TARGET_DIR"
CURRENT_TARGET=$(readlink -f "$CURRENT") || fail "current-web unreadable"
log "current=$CURRENT_TARGET -> new=$TARGET"

WEB_PID=""
# next-server 会改写进程标题，按 cwd（符号链接解析后=当前 release）匹配
for p in $(pgrep -f 'next-server' 2>/dev/null); do
  [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$CURRENT_TARGET" ] && { WEB_PID=$p; break; }
done
[ -n "$WEB_PID" ] || fail "cannot find running web process (cwd=$CURRENT_TARGET)"
log "production web pid=$WEB_PID"

# ─── 1. 解包新 release ───────────────────────────────────
mkdir -p "$TARGET"
tar -xzf "$PKG" -C "$TARGET"
[ -f "$TARGET/server.js" ] || fail "server.js missing in package"
[ -f "$TARGET/release-manifest.json" ] || fail "release-manifest.json missing in package"

# ─── 1.5 修复 pnpm 符号链接（Windows 打包的绝对路径链接在 Linux 悬空，重写为包内相对链接） ───
NM="$TARGET/node_modules"
if [ -d "$NM/.pnpm" ]; then
  LINKS_FIXED=0
  # 顶层及 scope 层链接（排除 .pnpm 内部）
  while IFS= read -r link; do
    target=$(readlink "$link")
    case "$target" in
      */node_modules/.pnpm/*)
        rel=".pnpm/${target#*/node_modules/.pnpm/}"
        rm "$link" && ln -s "$rel" "$link" && LINKS_FIXED=$((LINKS_FIXED+1)) ;;
    esac
  done < <(find "$NM" -maxdepth 2 -type l -not -path "*/.pnpm/*")
  # .pnpm 内部 peer 互链（绝对路径 → 包内相对）
  while IFS= read -r link; do
    target=$(readlink "$link")
    case "$target" in
      */node_modules/.pnpm/*)
        rest="${target#*/node_modules/.pnpm/}"
        abs="$NM/.pnpm/$rest"
        if [ -e "$abs" ]; then
          rel=$(realpath --relative-to="$(dirname "$link")" "$abs")
          rm "$link" && ln -s "$rel" "$link" && LINKS_FIXED=$((LINKS_FIXED+1))
        fi ;;
    esac
  done < <(find "$NM/.pnpm" -maxdepth 5 -type l)
  log "pnpm links rewritten: $LINKS_FIXED"
fi

chmod -R a-w "$TARGET" || true
log "unpacked: $(du -sh "$TARGET" | awk '{print $1}')"

# ─── 2. 继承 runtime-tools（ffmpeg/ffprobe/backup-data.sh，服务器端复制零传输） ───
NEW_BUILD_ID=$("$TOOLCHAIN_NODE" - "$TARGET" "$RELEASE_ID" <<'NODEEOF'
const fs = require('fs');
const path = require('path');
const [target, releaseId] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(target, 'release-manifest.json'), 'utf8'));
if (manifest.releaseId !== releaseId || manifest.service !== 'web') throw new Error('package release/service mismatch');
if (manifest.deployable !== true || manifest.rehearsal !== false) throw new Error('only deployable non-rehearsal artifacts may activate');
if (typeof manifest.buildId !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(manifest.buildId)) throw new Error('invalid buildId');
if (typeof manifest.commitSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(manifest.commitSha)) throw new Error('invalid commitSha');
if (fs.readFileSync(path.join(target, '.next', 'BUILD_ID'), 'utf8').trim() !== manifest.buildId) throw new Error('embedded BUILD_ID mismatch');
process.stdout.write(manifest.buildId);
NODEEOF
)
NEW_COMMIT_SHA=$("$TOOLCHAIN_NODE" - "$TARGET/release-manifest.json" <<'NODEEOF'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).commitSha);
NODEEOF
)
log "new BUILD_ID=$NEW_BUILD_ID commit=$NEW_COMMIT_SHA"
if [ -d "$CURRENT_TARGET/runtime-tools" ]; then
  chmod -R u+w "$TARGET"
  cp -a "$CURRENT_TARGET/runtime-tools" "$TARGET/runtime-tools"
  chmod -R a-w "$TARGET"
  log "runtime-tools inherited"
fi

# ─── 2.5 继承旧 release 的 public 文件（只补缺，不覆盖新构建文件） ───
if [ -d "$CURRENT_TARGET/public" ]; then
  chmod -R u+w "$TARGET"
  cp -an "$CURRENT_TARGET/public/." "$TARGET/public/" 2>/dev/null || true
  chmod -R a-w "$TARGET"
  log "public inherited (no-clobber)"
fi

# ─── 2.6 并入共享资产根（硬链接，零额外磁盘） ───
# 生产静态资产真相源是 PUBLIC_ASSET_ROOT（/data/web/shared/assets/current/public）。
# release 自带的 public 只是精简集；缺少的文件会让 Next 内部回退成 HTML，
# 导致 /_next/image 优化器 400（"isn't a valid image"）。用硬链接并集修复。
SHARED_PUBLIC="${PUBLIC_ASSET_ROOT:-/data/web/shared/assets/current/public}"
if [ -d "$SHARED_PUBLIC" ] && command -v rsync >/dev/null 2>&1; then
  chmod -R u+w "$TARGET"
  rsync -a --ignore-existing --link-dest="$SHARED_PUBLIC" "$SHARED_PUBLIC/" "$TARGET/public/" \
    && log "shared asset root unioned (hardlink, from $SHARED_PUBLIC)"
  chmod -R a-w "$TARGET"
fi

# ─── 3. 构造同身份候选 env（从当前生产进程 /proc 提取） ───
CAND_ENV=/tmp/candidate-env-$$.json
"$TOOLCHAIN_NODE" - "$WEB_PID" "$CANDIDATE_PORT" "$RELEASE_ID" "$CAND_ENV" "$NEW_BUILD_ID" "$NEW_COMMIT_SHA" <<'NODEEOF'
const fs = require('fs');
const [pid, port, releaseId, outFile, buildId, commitSha] = process.argv.slice(2);
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
// RELEASE_ROOT 参与 .env.local 查找；与正式激活一样保留生产原值（缺省时不注入）。
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
  if [ -n "${WRAPPER_PID:-}" ]; then
    kill "$WRAPPER_PID" 2>/dev/null || true
    wait "$WRAPPER_PID" 2>/dev/null || true
    WRAPPER_PID=""
  fi
  rm -f "$CAND_ENV" "$CAND_PID_FILE"
}
trap cleanup_candidate EXIT

READY=""
for i in $(seq 1 24); do
  sleep 5
  if ! kill -0 "$WRAPPER_PID" 2>/dev/null; then
    echo "[activate] candidate process exited early; last log:" >&2
    tail -30 "$CAND_LOG" >&2 || true
    chmod -R u+w "$TARGET_DIR" || true
    rm -rf "$TARGET_DIR"
    fail "candidate crashed on start; release removed, production untouched"
  fi
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
check_version() {
  "$TOOLCHAIN_NODE" -e '
const [sourceVersion, buildId, deployCommitSha, releaseId] = process.argv.slice(1);
let data = "";
process.stdin.on("data", chunk => data += chunk).on("end", () => {
  try {
    const body = JSON.parse(data);
    for (const [key, expected] of Object.entries({sourceVersion, buildId, deployCommitSha, releaseId})) {
      if (body[key] !== expected) throw new Error(`${key} mismatch`);
    }
    process.stdout.write(`${sourceVersion} ${buildId} ${deployCommitSha} ${releaseId}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});' "$EXPECTED_SOURCE_VERSION" "$NEW_BUILD_ID" "$NEW_COMMIT_SHA" "$RELEASE_ID"
}
CAND_SOURCE=$(printf '%s' "$VERSION_JSON" | check_version) || fail "candidate source/build/commit/release identity mismatch"
log "candidate ready: $CAND_SOURCE"
READINESS_JSON=$(curl --noproxy '*' -fsS --connect-timeout 2 --max-time 8 "http://127.0.0.1:$CANDIDATE_PORT/api/release-readiness") \
  || fail "release-readiness failed; production untouched"
printf '%s' "$READINESS_JSON" | "$TOOLCHAIN_NODE" -e '
const [releaseId, commitSha, buildId] = process.argv.slice(1);
let data = "";
process.stdin.on("data", chunk => data += chunk).on("end", () => {
  try {
    const body = JSON.parse(data);
    if (body.ready !== true || body.service !== "web" || body.releaseId !== releaseId || body.commitSha !== commitSha || body.buildId !== buildId) throw new Error("readiness identity mismatch");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});' "$RELEASE_ID" "$NEW_COMMIT_SHA" "$NEW_BUILD_ID" || fail "release-readiness identity mismatch; production untouched"
log "release-readiness OK"
cleanup_candidate
log "candidate stopped"

# ─── 5. 快照实际配置；按 ID 重建 fork 进程，避免 reload 遗留固定旧路径 ───
PM2_BIN=$(command -v pm2) || fail "pm2 missing"
PM2_MODULE=$(dirname "$(dirname "$(readlink -f "$PM2_BIN")")")
TX_DIR=$(mktemp -d /tmp/activate-XXXXXX)
TX_HELPER="$TX_DIR/pm2-transaction.cjs"
TX_SNAPSHOT="$TX_DIR/processes.json"
TX_HTTP_SNAPSHOT="$TX_DIR/http-identities.json"
mkdir -p "$RECEIPTS"
TX_LOG="$RECEIPTS/$RELEASE_ID-pm2-transaction.log"
POINTER_SWITCHED=0
ACTIVATION_COMMITTED=0
ROLLBACK_FAILED=0
cat > "$TX_HELPER" <<'NODEEOF'
const fs = require('fs');
const path = require('path');
const [action, modulePath, snapshotFile, target, releaseId, buildId, commitSha] = process.argv.slice(2);
const pm2 = require(modulePath);
const names = new Set(['agent-hub-web', 'agent-hub-media-worker']);
const call = (method, ...args) => new Promise((resolve, reject) => pm2[method](...args, (error, result) => error ? reject(error) : resolve(result)));
const portOf = entry => String(entry.pm2_env?.env?.PORT ?? entry.pm2_env?.PORT ?? '');
const entries = async () => (await call('list')).filter(entry => names.has(entry.name));
function actualEnv(pid) {
  const env = {};
  for (const line of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index);
    if (/^(PM2_|pm2_|NODE_CHANNEL_|NODE_UNIQUE_ID$)/.test(key)) continue;
    env[key] = line.slice(index + 1);
  }
  return env;
}
function configuration(entry, env) {
  const e = entry.pm2_env;
  // pm2_env also flattens every process environment variable and internal
  // runtime field. Replaying that object as an app declaration lets values
  // such as `time="..."` or `autorestart="true"` collide with PM2's typed
  // options. Build a small, typed declaration from an explicit allowlist.
  const config = {name: entry.name,
    cwd: fs.realpathSync(`/proc/${entry.pid}/cwd`), script: fs.realpathSync(e.pm_exec_path),
    interpreter: fs.realpathSync(`/proc/${entry.pid}/exe`), out_file: e.pm_out_log_path, error_file: e.pm_err_log_path,
    exec_mode: 'fork', instances: 1, force: true,
    autorestart: typeof e.autorestart === 'boolean' ? e.autorestart : String(e.autorestart) !== 'false',
    autostart: typeof e.autostart === 'boolean' ? e.autostart : String(e.autostart) !== 'false',
    treekill: typeof e.treekill === 'boolean' ? e.treekill : String(e.treekill) !== 'false',
    windowsHide: typeof e.windowsHide === 'boolean' ? e.windowsHide : String(e.windowsHide) === 'true',
    instance_var: `ACTIVATION_PM2_INSTANCE_${entry.pm_id}`, env};
  for (const key of ['merge_logs', 'watch', 'wait_ready']) {
    if (typeof e[key] === 'boolean') config[key] = e[key];
  }
  for (const key of ['kill_retry_time', 'restart_delay', 'kill_timeout', 'listen_timeout', 'max_restarts']) {
    if (typeof e[key] === 'number' && Number.isFinite(e[key])) config[key] = e[key];
  }
  for (const key of ['max_memory_restart', 'min_uptime', 'namespace', 'log_date_format']) {
    if (typeof e[key] === 'string' || typeof e[key] === 'number') config[key] = e[key];
  }
  if (Array.isArray(e.node_args)) config.node_args = [...e.node_args];
  if (Array.isArray(e.args)) config.args = [...e.args];
  else if (typeof e.args === 'string') config.args = e.args;
  return config;
}
function assertState(live, saved, newRelease) {
  if (live.length !== saved.length) throw new Error('managed process count mismatch');
  for (const original of saved) {
    const matches = live.filter(entry => entry.name === original.config.name && portOf(entry) === original.env.PORT);
    if (matches.length !== 1) throw new Error('managed process/port mapping mismatch');
    const entry = matches[0], e = entry.pm2_env;
    const cwd = newRelease ? target : original.actualCwd;
    const script = newRelease ? path.join(target, 'server.js') : original.actualScript;
    if (!entry.pid || e.status !== 'online' || e.exec_mode !== 'fork_mode'
      || fs.realpathSync(e.pm_cwd) !== cwd || fs.realpathSync(`/proc/${entry.pid}/cwd`) !== cwd
      || fs.realpathSync(e.pm_exec_path) !== script
      || fs.realpathSync(`/proc/${entry.pid}/exe`) !== original.actualInterpreter) throw new Error('PM2/actual process path mismatch');
    const env = actualEnv(entry.pid);
    const expected = {...original.env};
    delete expected.PWD;
    if (newRelease) Object.assign(expected, {RELEASE_ID: releaseId, EXPECTED_BUILD_ID: buildId, DEPLOY_COMMIT_SHA: commitSha, COZE_PROJECT_ENV: 'PROD'});
    for (const [key, value] of Object.entries(expected)) {
      if (env[key] !== value) throw new Error(`process environment mismatch: ${key}`);
    }
  }
}
function assertStartPeers(live, config) {
  const peers = live.filter(entry => entry.name === config.name && entry.pm2_env.pm_exec_path === config.script);
  if (peers.some(entry => !entry.pid || entry.pm2_env.status !== 'online' || entry.pm2_env.exec_mode !== 'fork_mode')) {
    throw new Error('unsafe same-name/script peer status; refusing PM2 name-restart fallback');
  }
  if (new Set(peers.map(portOf)).size !== peers.length || live.some(entry => entry.name === config.name && portOf(entry) === config.env.PORT)) {
    throw new Error('unsafe duplicate process port before start');
  }
}
async function waitStarted(original, newRelease, config) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const live = await entries();
      const matches = live.filter(entry => entry.name === config.name && portOf(entry) === config.env.PORT);
      assertState(matches, [original], newRelease);
      const peers = live.filter(entry => entry.name === config.name && entry.pm2_env.pm_exec_path === config.script);
      if (peers.some(entry => !entry.pid || entry.pm2_env.status !== 'online' || entry.pm2_env.exec_mode !== 'fork_mode')) throw new Error('peer not online');
      if (new Set(peers.map(portOf)).size !== peers.length) throw new Error('duplicate peer port');
      return;
    } catch (error) {
      if (attempt === 29) throw new Error(`started process did not become ready: ${config.name}/${config.env.PORT}: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
async function main() {
  await call('connect');
  try {
    if (action === 'snapshot') {
      const live = await entries();
      const web = live.filter(entry => entry.name === 'agent-hub-web');
      const workers = live.filter(entry => entry.name === 'agent-hub-media-worker');
      if (web.length !== 1 || workers.length !== 2 || portOf(web[0]) !== '5000'
        || workers.map(portOf).sort().join(',') !== '5102,5103') throw new Error('unsupported managed process topology; production untouched');
      const saved = live.map(entry => {
        const e = entry.pm2_env;
        if (!entry.pid || e.status !== 'online' || e.exec_mode !== 'fork_mode') throw new Error('only healthy fork processes supported');
        const env = actualEnv(entry.pid);
        if (env.PORT !== portOf(entry)) throw new Error('PM2/actual PORT mismatch');
        const actualCwd = fs.realpathSync(`/proc/${entry.pid}/cwd`);
        const actualScript = fs.realpathSync(e.pm_exec_path);
        const actualInterpreter = fs.realpathSync(`/proc/${entry.pid}/exe`);
        if (path.basename(actualScript) !== 'server.js' || actualScript !== path.join(actualCwd, 'server.js')
          || fs.realpathSync(e.exec_interpreter) !== actualInterpreter) throw new Error('unsupported process script/interpreter');
        return {id: entry.pm_id, config: configuration(entry, env), env, actualCwd, actualScript, actualInterpreter};
      });
      fs.writeFileSync(snapshotFile, JSON.stringify(saved), {mode: 0o600});
      console.log('snapshot: web=1 workers=2 ports=5000,5102,5103');
      return;
    }
    const saved = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    if (action === 'verify' || action === 'verify-rollback') {
      assertState(await entries(), saved, action === 'verify');
      console.log(`${action}: PM2 paths and per-process environments match`);
      return;
    }
    if (action !== 'activate' && action !== 'rollback') throw new Error('invalid transaction action');
    // 不按同名批量删除，避免把两个 worker 的环境/端口合并。
    if (action === 'activate') {
      const live = await entries();
      if (live.length !== saved.length || saved.some(original => !live.some(entry => entry.pm_id === original.id && entry.name === original.config.name && portOf(entry) === original.env.PORT))) throw new Error('process list changed after snapshot');
    }
    for (const original of saved) {
      const live = await entries();
      const matches = live.filter(entry => entry.name === original.config.name && portOf(entry) === original.env.PORT);
      if (matches.length > 1) throw new Error('ambiguous process mapping');
      if (matches.length) await call('delete', matches[0].pm_id);
      const config = {...original.config, env: {...original.env}};
      if (action === 'activate') {
        config.cwd = target;
        config.script = path.join(target, 'server.js');
        Object.assign(config.env, {RELEASE_ID: releaseId, EXPECTED_BUILD_ID: buildId, DEPLOY_COMMIT_SHA: commitSha, COZE_PROJECT_ENV: 'PROD'});
      }
      config.env.PWD = config.cwd;
      // 与候选环境一致保留 RELEASE_ROOT 的 .env.local 查找位置；只调整代码路径和发布身份。
      // PM2 7.0.1/7.0.4 对同名同路径异常进程会忽略 force 并按名称 restart。
      // 启动前拒绝异常同组，启动后逐 PORT 验实际进程；list/start 间仍有 TOCTOU，不能视为原子隔离。
      assertStartPeers(await entries(), config);
      await call('start', config.script, {...config, scriptArgs: config.args});
      await waitStarted(original, action === 'activate', config);
      console.log(`${action}: ${config.name} port=${config.env.PORT} cwd=${config.cwd}`);
    }
  } finally { pm2.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
NODEEOF
pm2_transaction() {
  "$TOOLCHAIN_NODE" "$TX_HELPER" "$1" "$PM2_MODULE" "$TX_SNAPSHOT" "$TARGET" "$RELEASE_ID" "$NEW_BUILD_ID" "$NEW_COMMIT_SHA" >> "$TX_LOG" 2>&1
}
http_identity_transaction() {
  local action="$1"
  for port in 5000 5102 5103; do
    curl --noproxy '*' -fsS --connect-timeout 2 --max-time 6 "http://127.0.0.1:$port/api/version" \
      > "$TX_DIR/http-$action-$port.json" 2>> "$TX_LOG" || return 1
  done
  "$TOOLCHAIN_NODE" - "$action" "$TX_DIR" "$TX_HTTP_SNAPSHOT" <<'NODEEOF' >> "$TX_LOG" 2>&1
const fs = require('fs');
const path = require('path');
const [action, directory, snapshotFile] = process.argv.slice(2);
const keys = ['sourceVersion', 'buildId', 'deployCommitSha', 'releaseId'];
const current = {};
for (const port of [5000, 5102, 5103]) {
  const body = JSON.parse(fs.readFileSync(path.join(directory, `http-${action}-${port}.json`), 'utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid version object');
  current[port] = keys.map(key => Object.hasOwn(body, key) ? {key, present: true, value: body[key]} : {key, present: false});
}
if (action === 'snapshot') {
  // 保留旧端口原始身份，包括字段缺省和已存在的源码/release 错配；不套用新发布合同。
  fs.writeFileSync(snapshotFile, JSON.stringify(current), {mode: 0o600});
} else if (action === 'verify-rollback') {
  const saved = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  for (const port of [5000, 5102, 5103]) {
    if (JSON.stringify(current[port]) !== JSON.stringify(saved[port])) throw new Error(`rollback HTTP identity mismatch: ${port}`);
  }
} else throw new Error('invalid HTTP identity transaction');
console.log(`${action}: HTTP identities captured/matched on 5000,5102,5103`);
NODEEOF
}
cleanup_activation() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_candidate
  if [ "$POINTER_SWITCHED" = 1 ] && [ "$ACTIVATION_COMMITTED" = 0 ]; then
    log "activation failed; restoring pointer and original web/worker configurations (log=$TX_LOG)"
    if ln -sfn "$CURRENT_TARGET" "$CURRENT.tmp.$$" && mv -T "$CURRENT.tmp.$$" "$CURRENT"; then
      if pm2_transaction rollback; then
        local restored=0
        for i in $(seq 1 12); do
          if pm2_transaction verify-rollback && http_identity_transaction verify-rollback; then restored=1; break; fi
          sleep 2
        done
        if [ "$restored" != 1 ]; then
          ROLLBACK_FAILED=1
          log "FATAL: rollback verification failed; manual recovery required (log=$TX_LOG)"
        fi
      else
        ROLLBACK_FAILED=1
        log "FATAL: rollback process restoration failed; manual recovery required (log=$TX_LOG)"
      fi
    else
      ROLLBACK_FAILED=1
      log "FATAL: rollback pointer restoration failed; manual recovery required (log=$TX_LOG)"
    fi
    status=1
  fi
  rm -f "$CURRENT.tmp.$$"
  if [ "$ROLLBACK_FAILED" = 0 ]; then
    rm -rf "$TX_DIR"
  else
    log "protected recovery configuration retained: $TX_SNAPSHOT"
  fi
  exit "$status"
}
trap cleanup_activation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pm2_transaction snapshot || fail "cannot snapshot supported production configuration; production untouched (log=$TX_LOG)"
http_identity_transaction snapshot || fail "cannot snapshot original HTTP identities; production untouched (log=$TX_LOG)"

# ─── 6. 原子切换指针并重建 web 和两个 worker；不触碰 voice ───
ln -sfn "$TARGET" "$CURRENT.tmp.$$"
POINTER_SWITCHED=1
mv -T "$CURRENT.tmp.$$" "$CURRENT"
log "current switched -> $(readlink -f "$CURRENT")"
pm2_transaction activate || fail "production process activation failed (log=$TX_LOG)"

# ─── 7. 三个实际进程和三端四项身份严格验收；失败由 EXIT trap 回滚 ───
PRODUCTION_READY=0
for i in $(seq 1 24); do
  ALL_MATCH=1
  if ! pm2_transaction verify; then ALL_MATCH=0; fi
  for port in 5000 5102 5103; do
    if VERSION_JSON=$(curl --noproxy '*' -fsS --connect-timeout 2 --max-time 6 "http://127.0.0.1:$port/api/version" 2>/dev/null) \
      && SUMMARY=$(printf '%s' "$VERSION_JSON" | check_version 2>> "$TX_LOG"); then
      [ "$port" = 5000 ] && PROD_SUMMARY="$SUMMARY"
    else
      ALL_MATCH=0
    fi
  done
  if [ "$ALL_MATCH" = 1 ]; then PRODUCTION_READY=1; break; fi
  sleep 5
done
[ "$PRODUCTION_READY" = 1 ] || fail "production web/worker path or source/build/commit/release mismatch (log=$TX_LOG)"
log "production after switch: $PROD_SUMMARY"
PM2_STATE="agent-hub-web:online,agent-hub-media-worker:online,agent-hub-media-worker:online"

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
ACTIVATION_COMMITTED=1
log "receipt: $RECEIPTS/$RELEASE_ID-activate.json"
log "DONE production=$PROD_SUMMARY"
