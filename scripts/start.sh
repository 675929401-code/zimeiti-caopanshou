#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

PORT=5000
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-$PORT}"

cd "${COZE_WORKSPACE_PATH}"

# 清理端口，防止重启时旧进程占用
kill_port_if_listening() {
    local port_to_kill="${1}"
    local pids
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${port_to_kill}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -z "${pids}" ]]; then
      echo "Port ${port_to_kill} is free."
      return
    fi
    echo "Port ${port_to_kill} in use by PIDs: ${pids} (SIGKILL)"
    echo "${pids}" | xargs -I {} kill -9 {}
    sleep 1
}

# 启动智音工坊独立服务 (端口 5001，与 next.config.ts rewrites 一致)
VOICE_PLATFORM_DIR="${COZE_WORKSPACE_PATH}/voice-platform"
VOICE_PLATFORM_PORT=5001
VOICE_BUILD_SCRIPT="${COZE_WORKSPACE_PATH}/scripts/build-voice-platform.sh"

# 清理智音工坊端口
echo "Clearing port ${VOICE_PLATFORM_PORT} before start."
kill_port_if_listening "${VOICE_PLATFORM_PORT}"

if [ -d "$VOICE_PLATFORM_DIR" ] && [ -f "$VOICE_PLATFORM_DIR/package.json" ]; then
  echo "Starting 智音工坊 on port ${VOICE_PLATFORM_PORT}..."
  (cd "$VOICE_PLATFORM_DIR" && \
   # 如果 .next 不存在，先构建（部署沙箱跳过了构建，需在此补建）
   if [ ! -d ".next" ]; then
     echo "[voice-platform] .next not found, running isolated build..."
     bash "$VOICE_BUILD_SCRIPT"
   fi
   corepack pnpm --dir "$VOICE_PLATFORM_DIR" --ignore-workspace exec prisma generate 2>&1 | tail -1
   # 加载 .env 环境变量（Prisma 需要 DATABASE_URL 等）
   VOICE_ENV=$(grep -v '^#' .env 2>/dev/null | grep -v '^$' | xargs) || true
   nohup env $VOICE_ENV corepack pnpm --dir "$VOICE_PLATFORM_DIR" --ignore-workspace exec next start -p ${VOICE_PLATFORM_PORT} > /app/work/logs/bypass//voice-platform.log 2>&1 &) || true
  sleep 2
fi

echo "Starting HTTP service on port ${DEPLOY_RUN_PORT}..."
# keepAliveTimeout=65000ms > Nginx upstream keepalive_timeout=60s
# 防止 Node.js 在 Nginx upstream pool 空闲期间关闭 keep-alive 连接
# headersTimeout 必须大于 keepAliveTimeout，Next.js 会自动设置
PORT=${DEPLOY_RUN_PORT} npx next start -p ${DEPLOY_RUN_PORT} --keepAliveTimeout 65000 &

# 等待 Node 进程启动
sleep 3

# 降低 Node 进程的 OOM 优先级（-500=更不容易被 OOM Killer 杀掉）
# 这样 OOM 时内核会优先杀其他进程而非我们的服务
NODE_PID=$(pgrep -f "next-server" | head -1)
if [ -n "$NODE_PID" ]; then
  echo "$NODE_PID" > /tmp/agent-hub-node.pid
  echo "-500" > /proc/$NODE_PID/oom_score_adj 2>/dev/null && \
    echo "Set oom_score_adj=-500 for Node PID=$NODE_PID" || \
    echo "Warning: Cannot set oom_score_adj (needs root)"
fi

# 等待 Node 子进程（实际这个脚本是被 PM2 fork 的，需要 wait）
wait
