#!/bin/bash
# 一键同步扣子代码到腾讯云服务器
# 用法: bash sync.sh
set -e

SERVER="root@134.175.87.247"
SSH_KEY="$HOME/.ssh/tencent_server"
REMOTE_DIR="/www/agent-hub"
TMP_FILE="/tmp/agent-hub-sync.tar.gz"

echo "📦 打包最新代码..."
cd /workspace/projects
tar -czf $TMP_FILE \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.git' \
  --exclude='public/assets' \
  --exclude='*.log' \
  --exclude='sync*.sh' \
  --exclude='DEPLOY-GUIDE.md' \
  .

SIZE=$(du -h $TMP_FILE | cut -f1)
echo "📦 包大小: $SIZE"

echo "📤 上传到服务器..."
# 使用 ssh + stdin 传输，避免依赖 scp
cat $TMP_FILE | ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SERVER "cat > /tmp/agent-hub-sync.tar.gz"

echo "🔧 服务器端：解压、构建、重启..."
ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SERVER << 'REMOTE'
set -e
cd /www/agent-hub

echo "  ⏹ 停止服务..."
pm2 stop agent-hub 2>/dev/null || true

echo "  📂 解压代码..."
tar -xzf /tmp/agent-hub-sync.tar.gz --overwrite
rm -f /tmp/agent-hub-sync.tar.gz

echo "  📦 安装依赖..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "  🔨 构建项目..."
pnpm build

echo "  ▶️ 重启服务（先删再建，避免重复进程）..."
pm2 delete agent-hub 2>/dev/null || true
pm2 start pnpm --name agent-hub -- start
pm2 save

echo "  ⏳ 等待服务启动..."
for i in $(seq 1 15); do
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5000 2>/dev/null)
  if [ "$HTTP_CODE" = "200" ]; then
    echo "  ✅ 服务启动成功！(耗时 ${i}s)"
    break
  fi
  if [ $i -eq 15 ]; then
    echo "  ❌ 服务启动超时，请检查: pm2 logs agent-hub"
  fi
  sleep 1
done
REMOTE

rm -f $TMP_FILE
echo ""
echo "🎉 同步完成！访问 https://zycheni9.com 查看最新版本"
