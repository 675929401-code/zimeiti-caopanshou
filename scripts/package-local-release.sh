#!/bin/bash
# 一键打包本地 Windows 构建制品（V1.0 · 2026-10-08）
# 用法：
#   bash scripts/package-local-release.sh --release-id web-direct-v4.4-xxxxxx \
#     [--commit-sha <全哈希>] [--staging-dir <目录>] [--out <tar路径>]
# 默认从 .next/BUILD_ID、git HEAD、public/version.json 自动取值。
# 固化的 7 项自检见 deploy 引导文档第四节，任何一项不过即退出（set -e + 显式校验）。
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
NEXTVER=""
STAGING=""
RELEASE_ID=""
OUT_TAR=""
COMMIT_SHA=""
SOURCE_VERSION=""
BUILD_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --release-id) RELEASE_ID="$2"; shift 2;;
    --commit-sha) COMMIT_SHA="$2"; shift 2;;
    --staging-dir) STAGING="$2"; shift 2;;
    --out) OUT_TAR="$2"; shift 2;;
    *) echo "未知参数: $1" >&2; exit 2;;
  esac
done

[ -z "$RELEASE_ID" ] && { echo "必须传 --release-id（形如 web-direct-v4.4-<commit短哈希>）" >&2; exit 2; }
STAGING="${STAGING:-C:/Users/Administrator/AppData/Local/Temp/zimeiti-pkg-${RELEASE_ID#web-direct-}}"
OUT_TAR="${OUT_TAR:-$(dirname "$STAGING")/${RELEASE_ID}.tar.gz}"

SA="$PROJ/.next/standalone"
NEXTVER_DIR=$(ls -d "$PROJ/node_modules/.pnpm"/next@*/node_modules/next 2>/dev/null | head -1)
[ -z "$NEXTVER_DIR" ] && { echo "自检失败: 找不到完整 next 包" >&2; exit 1; }
NEXTVER=$(basename "$(dirname "$(dirname "$NEXTVER_DIR")")")

COMMIT_SHA="${COMMIT_SHA:-$(git -C "$PROJ" rev-parse HEAD)}"
BUILD_ID=$(cat "$SA/.next/BUILD_ID")
SOURCE_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).sourceVersion)" "$PROJ/public/version.json")
[ -z "$SOURCE_VERSION" ] && { echo "自检失败: public/version.json 无 sourceVersion" >&2; exit 1; }

echo "[0/7] 参数: releaseId=$RELEASE_ID commit=${COMMIT_SHA:0:8} buildId=$BUILD_ID sourceVersion=$SOURCE_VERSION next=$NEXTVER"

# 自检前置：.next/standalone 与 BUILD_ID 必须来自本轮构建
[ -d "$SA" ] || { echo "自检失败: $SA 不存在（先跑构建）" >&2; exit 1; }

echo "[1/7] 全新暂存目录"
[ ! -e "$STAGING" ] || { echo "自检失败: 暂存目录已存在，请使用全新目录" >&2; exit 1; }
mkdir -p "$STAGING"

echo "[2/7] standalone 核心（server.js/package.json/node_modules/.next）"
cp "$SA/server.js" "$SA/package.json" "$STAGING/"
cp -r "$SA/node_modules" "$STAGING/"
cp -r "$SA/.next" "$STAGING/"
[ -f "$STAGING/.next/BUILD_ID" ] || { echo "自检失败: 暂存缺 .next/BUILD_ID" >&2; exit 1; }

echo "[3/7] 代码轨 public 30 文件（来源=项目内清单，version.json 强制刷新）"
MANIFEST="$PROJ/deploy/manifests/public-code-track.v1.txt"
[ -f "$MANIFEST" ] || { echo "自检失败: 缺 $MANIFEST" >&2; exit 1; }
MISSING=0
while IFS= read -r f; do
  case "$f" in ''|\#*) continue;; esac
  if [ -f "$PROJ/public/$f" ]; then
    mkdir -p "$STAGING/public/$(dirname "$f")"
    cp "$PROJ/public/$f" "$STAGING/public/$f"
  else
    echo "  清单文件缺失: public/$f"; MISSING=1
  fi
done < "$MANIFEST"
[ "$MISSING" = "1" ] && { echo "自检失败: public 清单有缺失文件" >&2; exit 1; }
mkdir -p "$STAGING/public"
cp "$PROJ/public/version.json" "$STAGING/public/version.json"   # 禁止沿用任何旧 staging 的 version.json
grep -q "$SOURCE_VERSION" "$STAGING/public/version.json" || { echo "自检失败: version.json 刷新后仍不匹配" >&2; exit 1; }

echo "[4/7] 完整 next 覆盖"
STG_NEXT="$STAGING/node_modules/.pnpm/$NEXTVER/node_modules/next"
if [ -e "$STG_NEXT" ] || [ -L "$STG_NEXT" ]; then
  mkdir -p "$STAGING/.package-quarantine"
  mv "$STG_NEXT" "$STAGING/.package-quarantine/next-traced"
fi
mkdir -p "$(dirname "$STG_NEXT")"
cp -r "$NEXTVER_DIR" "$STG_NEXT"

echo "[5/7] 删除 win32 sharp"
mkdir -p "$STAGING/.package-quarantine"
for platform_dir in "$STAGING/node_modules/.pnpm/"@img+sharp-win32-x64@*; do
  [ -e "$platform_dir" ] || continue
  mv "$platform_dir" "$STAGING/.package-quarantine/"
done

echo "[6/7] 写 release-manifest.json"
cat > "$STAGING/release-manifest.json" << JSON
{
  "schemaVersion": 2,
  "projectId": "zimeiti-caopanshou",
  "kind": "immutable-standalone-service-artifact",
  "deployable": true,
  "rehearsal": false,
  "releaseId": "$RELEASE_ID",
  "service": "web",
  "commitSha": "$COMMIT_SHA",
  "buildId": "$BUILD_ID",
  "identity": "${RELEASE_ID#web-direct-}",
  "healthPath": "/api/version",
  "readinessPath": "/api/release-readiness",
  "port": 5000,
  "generatedBy": "scripts/package-local-release.sh v1.0",
  "sourceVersion": "$SOURCE_VERSION",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
JSON

echo "[7/7] 校验 + 打包"
[ -f "$STG_NEXT/dist/lib/metadata/get-metadata-route.js" ] || { echo "自检失败: next 覆盖不完整" >&2; exit 1; }
[ "$(cat "$STAGING/.next/BUILD_ID")" = "$BUILD_ID" ] || { echo "自检失败: BUILD_ID 漂移" >&2; exit 1; }
! ls -d "$STAGING/node_modules/.pnpm/"@img+sharp-win32-x64@* >/dev/null 2>&1 || { echo "自检失败: win32 sharp 未删除" >&2; exit 1; }

cd "$STAGING"
tar --force-local --exclude='./.package-quarantine' -czf "$OUT_TAR" .
cd - >/dev/null

echo "---- 产出 ----"
ls -lh "$OUT_TAR"
sha256sum "$OUT_TAR"
echo "PUBLIC-CODE-TRACK: $(find "$STAGING/public" -type f | wc -l) 文件（含 version.json）"
echo "PKG-DONE releaseId=$RELEASE_ID sourceVersion=$SOURCE_VERSION"
