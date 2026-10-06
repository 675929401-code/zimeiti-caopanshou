#!/usr/bin/env bash
set -Eeuo pipefail

# LEGACY_DEPLOY_DISABLED
printf '%s\n' 'BLOCKED: 旧 Gitee 拉取部署入口已冻结；生产部署需在新私有仓和独立发布流水线建立后重新授权。' >&2
exit 2

# Safe Git based deployment for 自媒体操盘手.
# Code is pulled from Git and released into a new immutable directory.
# Business data, secrets and uploads are kept under DATA_ROOT and are never
# overwritten by Git release files.

APP_NAME="${APP_NAME:-agent-hub}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-git@gitee.com:zhujunguo/wangzhanbeifen.git}"
SOURCE_SUBDIR="${SOURCE_SUBDIR:-自媒体操盘手/V2.6_20260806_沙箱项目定稿/源码}"

DATA_MOUNT="${DATA_MOUNT:-/data}"
DATA_ROOT="${DATA_ROOT:-/data/agent-hub}"
REPO_DIR="${REPO_DIR:-$DATA_ROOT/repo}"
ENV_FILE="${ENV_FILE:-$DATA_ROOT/env/.env.local}"
UPLOADS_DIR="${UPLOADS_DIR:-$DATA_ROOT/uploads}"
AVATARS_DIR="${AVATARS_DIR:-$DATA_ROOT/avatars}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_ROOT/backups}"
LOG_DIR="${LOG_DIR:-$DATA_ROOT/logs}"
RELEASE_ROOT="${RELEASE_ROOT:-/data/web/releases}"
CURRENT_LINK="${CURRENT_LINK:-/data/web/current}"
RELEASE_KEEP="${RELEASE_KEEP:-1}"
PORT="${PORT:-5000}"
DEPLOY_MODE="${DEPLOY_MODE:-full}"
REQUIRE_DATA_MOUNT="${REQUIRE_DATA_MOUNT:-1}"

mkdir -p "$DATA_ROOT" "$LOG_DIR" "$BACKUP_DIR" "$RELEASE_ROOT"
LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d).log"
LOCK_FILE="$DATA_ROOT/deploy.lock"
DEPLOYED_COMMIT_FILE="$DATA_ROOT/deployed-commit"

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE"
}

die() {
  log "ERROR: $*"
  exit 1
}

if [ "$DEPLOY_MODE" != "full" ]; then
  die "Only full Git releases are allowed. Set DEPLOY_MODE=full or omit it."
fi

if [ "$REQUIRE_DATA_MOUNT" = "1" ] && ! findmnt -rn "$DATA_MOUNT" >/dev/null 2>&1; then
  die "$DATA_MOUNT is not a mounted data disk. Attach and mount the stable data disk first."
fi

if [ ! -f "$ENV_FILE" ]; then
  die "Protected env file not found: $ENV_FILE"
fi

exec 9>"$LOCK_FILE"
flock -n 9 || die "Another deployment is already running."

mkdir -p "$UPLOADS_DIR" "$AVATARS_DIR"

if [ ! -d "$REPO_DIR/.git" ]; then
  log "Cloning $REPO_URL into $REPO_DIR"
  rm -rf "$REPO_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
git fetch origin "$BRANCH"
OLD_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
NEW_COMMIT="$(git rev-parse HEAD)"
DEPLOYED_COMMIT="$(cat "$DEPLOYED_COMMIT_FILE" 2>/dev/null || true)"

# Keep only the explicitly supported source snapshots in the server checkout:
# V2.6 is the current release and V2.5 is the stable source snapshot. Older
# snapshots remain available in Git history/tags but are not needed on disk.
SOURCE_SNAPSHOT_ROOT="$REPO_DIR/自媒体操盘手"
find "$SOURCE_SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'V2.*' \
  ! -name 'V2.5_20260801_完整工程版' \
  ! -name 'V2.6_20260806_沙箱项目定稿' \
  -prune -exec rm -rf -- {} +

if [ "$DEPLOYED_COMMIT" = "$NEW_COMMIT" ]; then
  log "Commit already deployed on $BRANCH ($NEW_COMMIT)."
  exit 0
fi

CHANGE_LIST="$BACKUP_DIR/changed-files-$NEW_COMMIT.txt"
if [ -n "$OLD_COMMIT" ]; then
  git diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" > "$CHANGE_LIST" || true
else
  git ls-files > "$CHANGE_LIST"
fi

log "Deploy mode: $DEPLOY_MODE"
log "Old commit: ${OLD_COMMIT:-none}"
log "New commit: $NEW_COMMIT"
log "Previously deployed commit: ${DEPLOYED_COMMIT:-none}"
log "Changed files list: $CHANGE_LIST"

RELEASE_DIR="$RELEASE_ROOT/release-$(date +%Y%m%d-%H%M)-${NEW_COMMIT:0:8}"
mkdir -p "$RELEASE_DIR"
if ! git cat-file -e "$NEW_COMMIT:$SOURCE_SUBDIR" 2>/dev/null; then
  die "Source subdir not found in Git commit: $SOURCE_SUBDIR"
fi
git archive "$NEW_COMMIT:$SOURCE_SUBDIR" | tar -x -C "$RELEASE_DIR"

for required_file in package.json pnpm-lock.yaml next.config.ts tsconfig.json src/app/page.tsx src/app/api/version/route.ts scripts/release-preflight.mjs scripts/git-auto-deploy.sh; do
  [ -f "$RELEASE_DIR/$required_file" ] || die "Incomplete release archive, missing: $required_file"
done

# Static semantic avatars are part of the UI release contract. Keep this check
# before install/build so a bad package can never become the active release.
[ -f "$RELEASE_DIR/public/avatars/cute-semantic/agent-cute-01.webp" ] || die "Release is missing static avatar assets"
[ -f "$RELEASE_DIR/public/avatars/cute-semantic/agent-cute-10.webp" ] || die "Release is missing static avatar assets"
[ -f "$RELEASE_DIR/public/avatars/agent-cyber-01.png" ] || die "Release is missing legacy avatar assets"

node "$RELEASE_DIR/scripts/release-preflight.mjs" --root "$RELEASE_DIR" || die "Release preflight failed for packaged Git source."

mkdir -p "$RELEASE_DIR/public"
cat > "$RELEASE_DIR/public/version.json" <<EOF
{"version":"${NEW_COMMIT:0:8}-$(date +%Y%m%d%H%M%S)","hash":"$NEW_COMMIT","timestamp":$(date +%s000),"env":"PROD"}
EOF

ln -sfn "$ENV_FILE" "$RELEASE_DIR/.env.local"
ln -sfn "$UPLOADS_DIR" "$RELEASE_DIR/public/uploads"

# Keep the avatar collection on the data disk so admin-generated additions are
# not lost when a new immutable release is activated. Seed it from the first
# packaged release, then expose it at the stable public path.
if [ -d "$RELEASE_DIR/public/avatars" ] && [ -z "$(find "$AVATARS_DIR" -type f -print -quit 2>/dev/null)" ]; then
  cp -a "$RELEASE_DIR/public/avatars/." "$AVATARS_DIR/"
fi
rm -rf "$RELEASE_DIR/public/avatars"
ln -sfn "$AVATARS_DIR" "$RELEASE_DIR/public/avatars"

cd "$RELEASE_DIR"
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@9.0.0 --activate >/dev/null 2>&1 || true
if ! pnpm install --frozen-lockfile; then
  # ffmpeg-static downloads optional README/LICENSE files after its binary.
  # Those auxiliary downloads can time out even when the executable is ready.
  # Retry without lifecycle scripts only when that required binary exists;
  # this keeps the normal install path strict while making releases resilient
  # to an unavailable third-party metadata endpoint.
  FFMPEG_BINARY="$(find "$RELEASE_DIR/node_modules/.pnpm" -path '*/ffmpeg-static/ffmpeg' -type f -perm -u+x -print -quit 2>/dev/null || true)"
  if [ -n "$FFMPEG_BINARY" ]; then
    log "pnpm lifecycle script timed out after ffmpeg-static binary was installed; retrying with --ignore-scripts."
    pnpm install --frozen-lockfile --ignore-scripts
  else
    die "Dependency installation failed and ffmpeg-static binary was not produced."
  fi
fi
pnpm exec next build

start_app() {
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  cd "$CURRENT_LINK"
  pm2 start npx --name "$APP_NAME" --interpreter node --interpreter-args="--max-old-space-size=768" -- next start -p "$PORT" --keepAliveTimeout 65000
  pm2 save >/dev/null || true
}

PREVIOUS_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
start_app

sleep 3
for path in "/" "/api/settings" "/api/bots" "/api/nav-items" "/api/shortcuts" "/api/chat-models" "/api/video/models" "/avatars/cute-semantic/agent-cute-01.webp" "/avatars/agent-cyber-01.png"; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$path" || true)"
  [ "$code" = "200" ] || {
    log "Health check failed on $path: $code"
    if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
      ln -sfn "$PREVIOUS_TARGET" "$CURRENT_LINK"
      start_app
    fi
    die "Deployment rolled back to previous release."
  }
done

VERIFY_PUBLIC_ONLY=1 BASE_URL="http://127.0.0.1:$PORT" pnpm run verify:runtime || {
  log "Runtime contract verification failed."
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    ln -sfn "$PREVIOUS_TARGET" "$CURRENT_LINK"
    start_app
  fi
  die "Deployment rolled back to previous release."
}

case "$RELEASE_KEEP" in
  ''|*[!0-9]*) die "RELEASE_KEEP must be a non-negative integer" ;;
esac
find "$RELEASE_ROOT" -maxdepth 1 -mindepth 1 -type d -name 'release-*' \
  -printf '%T@ %p\n' | sort -nr | awk -v keep="$RELEASE_KEEP" 'NR>keep {print $2}' | while IFS= read -r old_release; do
    case "$old_release" in
      "$RELEASE_ROOT"/release-*) rm -rf "$old_release" ;;
      *) log "Skip unexpected release prune target: $old_release" ;;
    esac
done

printf '%s\n' "$NEW_COMMIT" > "$DEPLOYED_COMMIT_FILE"
log "Deployment complete: $RELEASE_DIR"
