#!/bin/bash
# ============================================
# 同步更新脚本 - 在腾讯云服务器上执行
# ============================================
# 使用方式：
#   1. 将 agent-hub-sync.tar.gz 上传到服务器 /tmp/
#   2. 执行此脚本：bash sync-from-coze.sh
# ============================================

set -e

SYNC_TMP="/tmp/agent-hub-sync.tar.gz"
DEPLOY_DIR="/www/agent-hub"

if [ ! -f "$SYNC_TMP" ]; then
  echo "[ERROR] 未找到 $SYNC_TMP"
  echo "请先将代码包上传到服务器：scp agent-hub-sync.tar.gz root@134.175.87.247:/tmp/"
  exit 1
fi

echo "============================================"
echo "  安哥智能体工作平台 - 从扣子同步更新"
echo "============================================"

cd "$DEPLOY_DIR"

echo "[1/4] 停止服务..."
pm2 stop agent-hub 2>/dev/null || true

echo "[2/4] 解压代码..."
tar -xzf "$SYNC_TMP" --overwrite
rm -f "$SYNC_TMP"

echo "[3/4] 安装依赖并构建..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build

echo "[4/4] 重启服务..."
pm2 delete agent-hub 2>/dev/null || true
pm2 start pnpm --name agent-hub -- start
pm2 save

echo ""
echo "✅ 同步完成！https://zycheni9.com 已更新到最新版本"
echo "============================================"
