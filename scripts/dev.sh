#!/bin/bash
set -Eeuo pipefail


PORT=5000
COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT}}"


cd "${COZE_WORKSPACE_PATH}"

kill_port_if_listening() {
    local port_to_kill="${1:-${DEPLOY_RUN_PORT}}"
    local pids
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${port_to_kill}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -z "${pids}" ]]; then
      echo "Port ${port_to_kill} is free."
      return
    fi
    echo "Port ${port_to_kill} in use by PIDs: ${pids} (SIGKILL)"
    echo "${pids}" | xargs -I {} kill -9 {}
    sleep 1
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${port_to_kill}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -n "${pids}" ]]; then
      echo "Warning: port ${port_to_kill} still busy after SIGKILL, PIDs: ${pids}"
    else
      echo "Port ${port_to_kill} cleared."
    fi
}

echo "Clearing port ${DEPLOY_RUN_PORT} before start."
kill_port_if_listening "${DEPLOY_RUN_PORT}"

# 防护：清理残留 lockfile（同 prepare.sh，双保险）
if [ -f "/pnpm-lock.yaml" ]; then
  echo "WARN: Found stale /pnpm-lock.yaml, removing..."
  rm -f /pnpm-lock.yaml
fi

# 启动智音工坊独立服务 (端口 5001，与 next.config.ts rewrites 一致)
VOICE_PLATFORM_DIR="${COZE_WORKSPACE_PATH}/voice-platform"
VOICE_PLATFORM_PORT=5001

# 清理智音工坊端口，防止重启时端口被旧进程占用
echo "Clearing port ${VOICE_PLATFORM_PORT} before start."
kill_port_if_listening "${VOICE_PLATFORM_PORT}"

if [ -d "$VOICE_PLATFORM_DIR" ] && [ -f "$VOICE_PLATFORM_DIR/package.json" ]; then
  echo "Building and starting 智音工坊 on port ${VOICE_PLATFORM_PORT} (production mode)..."
  (cd "$VOICE_PLATFORM_DIR" && \
   [ ! -d "node_modules" ] && pnpm install 2>&1 | tail -3
   pnpm prisma generate 2>&1 | tail -1
   [ ! -d ".next" ] && pnpm build 2>&1 | tail -3
   # 加载 .env 环境变量（Prisma 需要 DATABASE_URL 等）
   VOICE_ENV=$(grep -v '^#' .env 2>/dev/null | grep -v '^$' | xargs) || true
   nohup env $VOICE_ENV pnpm next start -p ${VOICE_PLATFORM_PORT} > /app/work/logs/bypass//voice-platform.log 2>&1 &) || true
  sleep 3
fi

echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for dev..."

# 启动主服务：如果 tsx 不可用，先重装依赖再启动（防止 OOM 导致安装不完整）
if ! pnpm exec tsx --version > /dev/null 2>&1; then
  echo "WARN: tsx not found, reinstalling dependencies..."
  PUPPETEER_SKIP_DOWNLOAD=1 pnpm install --prefer-offline 2>&1 || PUPPETEER_SKIP_DOWNLOAD=1 pnpm install 2>&1
fi

PORT=${DEPLOY_RUN_PORT} pnpm exec tsx watch src/server.ts &
MAIN_PID=$!

# 写 PID 文件，供看门狗使用
echo "$MAIN_PID" > /tmp/next-dev.pid

# 更新 .preview 文件，确保沙箱能识别服务运行状态
PREVIEW_FILE="${COZE_WORKSPACE_PATH}/.preview"
if [ -f "$PREVIEW_FILE" ]; then
  cat > "$PREVIEW_FILE" << PREVIEW_EOF
pid = ${MAIN_PID}
server_port = ${DEPLOY_RUN_PORT}
status = "running"
worktree_name = ""
backend_port = ${VOICE_PLATFORM_PORT}
PREVIEW_EOF
  echo "Updated .preview: pid=${MAIN_PID}, port=${DEPLOY_RUN_PORT}"
fi

# ---------- 启动沙箱看门狗 ----------
WATCHDOG_SCRIPT="${COZE_WORKSPACE_PATH}/scripts/watch-sandbox.sh"
if [ -f "$WATCHDOG_SCRIPT" ]; then
  echo "Starting sandbox watchdog..."
  (bash "$WATCHDOG_SCRIPT") &
  WATCHDOG_PID=$!
  echo "Watchdog started with PID $WATCHDOG_PID"

  # 主进程退出时，连带杀掉看门狗（防止孤儿进程）
  trap 'echo "Stopping watchdog (PID=$WATCHDOG_PID)..."; kill $WATCHDOG_PID 2>/dev/null || true; wait $WATCHDOG_PID 2>/dev/null || true' EXIT
else
  echo "WARN: Watchdog script not found at $WATCHDOG_SCRIPT, skipping"
fi
# ------------------------------------

wait $MAIN_PID
