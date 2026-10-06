#!/usr/bin/env bash
set -Eeuo pipefail

# LEGACY_DEPLOY_DISABLED
printf '%s\n' 'BLOCKED: 旧 Gitee 发布入口已冻结；请先建立干净私有 origin/backup 并取得当次发布授权。' >&2
exit 2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

REPO_URL="${REPO_URL:-git@gitee.com:zhujunguo/wangzhanbeifen.git}"
BRANCH="${BRANCH:-main}"
SOURCE_SUBDIR="${SOURCE_SUBDIR:-自媒体操盘手/V2.6_20260806_沙箱项目定稿/源码}"
COMMIT_MSG="${1:-release: full source $(date '+%Y-%m-%d %H:%M:%S')}"
TEMP_DIR="${TEMP_DIR:-/tmp/agent-hub-gitee-full-$$}"

EXCLUDES=(
  "--exclude=.git"
  "--exclude=.next"
  "--exclude=node_modules"
  "--exclude=.env"
  "--exclude=.env.local"
  "--exclude=.env.local*"
  "--exclude=.env.production"
  "--exclude=.env.production*"
  "--exclude=.env.development.local"
  "--exclude=.env.test.local"
  "--exclude=.secure"
  "--exclude=.tmp-e2e"
  "--exclude=tmp"
  "--exclude=backups"
  "--exclude=logs"
  "--exclude=public/uploads"
  "--exclude=scripts/tencent_key"
  "--exclude=tsconfig.tsbuildinfo"
  "--exclude=*.log"
  "--exclude=*.tmp"
  "--exclude=*.temp"
)

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

cleanup() {
  if [[ -n "${TEMP_DIR:-}" && "$TEMP_DIR" == /tmp/agent-hub-gitee-full-* ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

command -v git >/dev/null 2>&1 || die "git is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

log "Running local release preflight"
node "$PROJECT_ROOT/scripts/release-preflight.mjs" --root "$PROJECT_ROOT"

rm -rf "$TEMP_DIR"
log "Cloning $REPO_URL#$BRANCH"
git clone --branch "$BRANCH" "$REPO_URL" "$TEMP_DIR"

cd "$TEMP_DIR"
git config user.email "${GIT_USER_EMAIL:-release@agent-hub.local}"
git config user.name "${GIT_USER_NAME:-Agent Hub Release Bot}"

TARGET_DIR="$TEMP_DIR/$SOURCE_SUBDIR"
case "$TARGET_DIR" in
  "$TEMP_DIR"/*) ;;
  *) die "Refusing to write outside temp repo: $TARGET_DIR" ;;
esac

mkdir -p "$TARGET_DIR"
find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

log "Copying full source into repo path: $SOURCE_SUBDIR"
(
  cd "$PROJECT_ROOT"
  tar cf - "${EXCLUDES[@]}" .
) | (
  cd "$TARGET_DIR"
  tar xf -
)

cat > "$TARGET_DIR/deploy-manifest.json" <<EOF
{
  "kind": "agent-hub-full-source-release",
  "source_subdir": "$SOURCE_SUBDIR",
  "published_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "commit_message": "$COMMIT_MSG",
  "data_policy": "code plus static avatars; env, uploads, backups, node_modules and build outputs are excluded"
}
EOF

log "Running packaged release preflight"
node "$TARGET_DIR/scripts/release-preflight.mjs" --root "$TARGET_DIR"

if find "$TARGET_DIR" \( -name '.env.local' -o -name 'node_modules' -o -name '.next' \) -print -quit | grep -q .; then
  die "Packaged release contains forbidden runtime/build files"
fi

git add -A "$SOURCE_SUBDIR"

if git diff --cached --quiet; then
  log "No source changes to publish."
  exit 0
fi

git commit -m "$COMMIT_MSG"
git push origin "$BRANCH"

NEW_COMMIT="$(git rev-parse HEAD)"
log "Published full source release: $NEW_COMMIT"
log "Server webhook should deploy this exact commit from: $SOURCE_SUBDIR"
