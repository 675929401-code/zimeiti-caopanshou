#!/bin/bash
set -e

# LEGACY_DEPLOY_DISABLED
echo 'BLOCKED: 禁止从旧 Git 仓库 pull/rsync 覆盖本地主站 当前版本/。灾难恢复必须 clone 到全新目录后人工比对。' >&2
exit 2

# ============================================================
# Git 仓库 → 沙箱 同步脚本
# 用法: bash scripts/sync-from-git.sh [版本目录名]
#
# 场景: 第三方工具（如 Warp IDE）修改代码并推送到 Gitee 后，
#       在沙箱执行此脚本，将仓库最新代码同步到当前工作区。
#       用户确认无误后，再通过 sync-deploy.sh 推送到生产服务器。
#
# 闭环流程:
#   沙箱 → (sync-deploy.sh) → 服务器 + Gitee备份
#   Gitee ← (第三方工具修改)
#   Gitee → (sync-from-git.sh) → 沙箱 → 确认 → 服务器
# ============================================================

GITEE_URL="${GITEE_URL:-git@gitee.com:zhujunguo/wangzhanbeifen.git}"
TEMP_DIR="/tmp/gitee-sync-$$"
PROJECT_ROOT="${COZE_WORKSPACE_PATH:-/workspace/projects}"

# 确定要同步的版本目录
# 优先级: 命令行参数 > 最新 STANDARD.md 版本 > 项目备份/最新完整备份
BACKUP_DIR_NAME="${1:-}"

echo "=========================================="
echo "  Git 仓库 → 沙箱 同步"
echo "  工作区: ${PROJECT_ROOT}"
if [ -n "$BACKUP_DIR_NAME" ]; then
  echo "  版本目录: 自媒体操盘手/${BACKUP_DIR_NAME}/源码/"
else
  echo "  版本目录: 自动检测最新版本"
fi
echo "=========================================="

# Step 1: 克隆仓库
echo "[1/4] 克隆 Gitee 仓库..."
rm -rf "$TEMP_DIR"
git clone --depth 1 "$GITEE_URL" "$TEMP_DIR" 2>&1 | tail -3

cd "$TEMP_DIR"

# Step 2: 确定源码目录
if [ -n "$BACKUP_DIR_NAME" ]; then
  SOURCE_PATH="自媒体操盘手/${BACKUP_DIR_NAME}/源码"
else
  # 查找最新的版本目录
  LATEST_DIR=$(ls -d 自媒体操盘手/V*/ 2>/dev/null | sort -V | tail -1)
  if [ -z "$LATEST_DIR" ]; then
    # 尝试项目备份目录
    if [ -d "项目备份/2025-07-06-v2-最新完整备份" ]; then
      SOURCE_PATH="项目备份/2025-07-06-v2-最新完整备份"
    else
      echo "❌ 未找到任何备份版本目录"
      echo "可用目录:"
      ls -d 自媒体操盘手/V*/ 2>/dev/null || echo "  (无)"
      ls -d 项目备份/*/ 2>/dev/null || echo "  (无)"
      exit 1
    fi
  else
    # 检查是否有源码子目录
    if [ -d "${LATEST_DIR}源码" ]; then
      SOURCE_PATH="${LATEST_DIR}源码"
    else
      SOURCE_PATH="${LATEST_DIR%/}"
    fi
  fi
fi

echo "[2/4] 源码路径: ${SOURCE_PATH}"

if [ ! -d "$SOURCE_PATH" ]; then
  echo "❌ 目录不存在: $SOURCE_PATH"
  exit 1
fi

# 读取备份说明（如果存在）
if [ -f "${SOURCE_PATH}/备份说明.md" ] || [ -f "${TEMP_DIR}/$(dirname ${SOURCE_PATH})/备份说明.md" ]; then
  echo ""
  echo "=== 备份说明 ==="
  cat "${SOURCE_PATH}/备份说明.md" 2>/dev/null || cat "${TEMP_DIR}/$(dirname ${SOURCE_PATH})/备份说明.md" 2>/dev/null || true
  echo "================="
fi

# Step 3: 同步代码到工作区（先备份当前状态）
echo ""
echo "[3/4] 备份当前工作区状态..."
cd "$PROJECT_ROOT"
git stash 2>/dev/null || echo "  (无未提交更改，跳过 stash)"

echo "[4/4] 同步代码..."
# 使用 rsync 同步，排除不需要的目录
rsync -av --delete \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.git' \
  --exclude='.preview' \
  --exclude='.cozeproj' \
  --exclude='.codebuddy' \
  --exclude='.codegraph' \
  --exclude='public/videos' \
  --exclude='tsconfig.tsbuildinfo' \
  --exclude='.env.local' \
  "${TEMP_DIR}/${SOURCE_PATH}/" "${PROJECT_ROOT}/"

# 清理
rm -rf "$TEMP_DIR"

echo ""
echo "=========================================="
echo "  ✅ 同步完成！"
echo "  代码已从 Git 仓库更新到沙箱工作区"
echo ""
echo "  下一步:"
echo "  1. 检查代码是否正确 (git diff)"
echo "  2. 运行 pnpm install 安装依赖"
echo "  3. 运行 pnpm ts-check 检查类型"
echo "  4. 确认无误后，执行 bash scripts/sync-deploy.sh 推送到服务器"
echo "=========================================="
