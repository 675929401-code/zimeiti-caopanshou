#!/bin/bash
# 启动智音工坊独立服务（端口 3001）
# 由主站 server.ts 通过反向代理 /voice-studio/ → http://localhost:3001

cd "$(dirname "$0")/../voice-platform"

# 确保依赖已安装
if [ ! -d "node_modules" ]; then
  echo "[voice-platform] 安装依赖..."
  npm install
fi

# 确保 Prisma client 已生成
if [ ! -d "node_modules/.prisma/client" ]; then
  echo "[voice-platform] 生成 Prisma client..."
  npx prisma generate
fi

# 启动服务
echo "[voice-platform] 启动智音工坊 (端口 3001, basePath: /voice-studio-app)..."
export PORT=3001
exec npx next dev -p 3001
