#!/bin/bash
# ============================================================
# 沙箱看门狗 (Sandbox Watchdog)
# 纯 bash 实现，零依赖。只要容器活着就能跑。
#
# 职责：监控 Next.js 开发服务，异常时自动递进修复
# 触发：由 dev.sh 启动 Next.js 后后台拉起
# 退出：父进程(dev.sh)退出时自动带走（子进程跟随）
#
# 四层检测：
#   1. 端口监听 (ss)
#   2. 进程存活 (pgrep)
#   3. HTTP 200 (curl)
#   4. 编译死锁 (长时间无输出 + 报错)
#
# 三级修复：
#   L1 - 轻量重启 (重新拉起进程)
#   L2 - 中度修复 (清 lockfile + 清 .next 缓存 + 重装依赖 + 重启)
#   L3 - 深度修复 (杀光 node + 删 .next + 重装 + 重启)
# ============================================================

set -u

# ---------- 配置 ----------
WATCHDOG_PORT="${DEPLOY_RUN_PORT:-5000}"
WATCHDOG_INTERVAL=10                  # 检测间隔（秒）
WATCHDOG_LOG="/app/work/logs/bypass//watchdog.log"
WATCHDOG_PID_FILE="/tmp/sandbox-watchdog.pid"
NEXT_PID_FILE="/tmp/next-dev.pid"     # Next.js 进程 PID 文件（由 dev.sh 写入）
STATUS_PAGE_PORT=9001                 # 构建中状态页端口（不冲突主服务）
MEM_WARN_PCT=85                       # 内存使用率告警阈值 (%)
MEM_KILL_PCT=95                       # 内存使用率触发深度修复阈值 (%)

# 连续失败计数
fail_count=0
l1_count=0
l2_count=0
last_ok_ts=0
status_page_pid=""                    # 状态页进程 PID

# 工作目录
WATCHDOG_CWD="${COZE_WORKSPACE_PATH:-$(pwd)}"

# ---------- 工具函数 ----------
log() {
  local level="$1"; shift
  mkdir -p "$(dirname "$WATCHDOG_LOG")" 2>/dev/null || true
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*" >> "$WATCHDOG_LOG" 2>/dev/null || true
}

# 获取内存使用率（%）
mem_usage_pct() {
  if command -v free >/dev/null 2>&1; then
    free -m 2>/dev/null | awk '/^Mem:/ {printf "%d", $3/$2*100}'
  else
    echo "0"
  fi
}

# 检测 Node 进程泄漏（数量异常多）
detect_node_leak() {
  local count
  count=$(pgrep -f "node" 2>/dev/null | wc -l || echo 0)
  # 正常应该 2-5 个 node 进程（tsx watch + next + postcss 等）
  # 超过 15 个说明有泄漏
  # 注意：无论是否泄漏都 return 0，保证函数只输出单个整数；
  # 否则调用处 `|| echo 0` 会再补一个 "0"，导致命令替换结果为 "0\n0"，
  # 后续 `[ "$leak_count" -gt 0 ]` 报 "integer expression expected"。
  if [ "$count" -gt 15 ]; then
    echo "$count"
    return 0
  fi
  echo "0"
  return 0
}

# 启动构建中状态页（服务挂了的时候显示给用户看，不是白屏）
start_status_page() {
  # 如果已经在跑了就不重启
  if [ -n "$status_page_pid" ] && kill -0 "$status_page_pid" 2>/dev/null; then
    return 0
  fi

  # 检查端口是否被占
  if ss -H -lntp 2>/dev/null | awk -v p="$STATUS_PAGE_PORT" '$4 ~ ":"p"$"' | grep -q .; then
    # 杀掉占用者（应该是之前的状态页残留）
    local old_pid
    old_pid=$(ss -H -lntp 2>/dev/null | awk -v p="$STATUS_PAGE_PORT" '$4 ~ ":"p"$"' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "$old_pid" ] && kill -9 "$old_pid" 2>/dev/null || true
    sleep 1
  fi

  # 用 Python 起一个极简 HTTP 服务（Python 在任何沙箱都有）
  local status_html="/tmp/sandbox-status-$$.html"
  cat > "$status_html" << 'STATUS_HTML'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>服务正在恢复中...</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #fff;
  }
  .container {
    text-align: center;
    padding: 40px;
    max-width: 480px;
  }
  .spinner {
    width: 56px;
    height: 56px;
    border: 4px solid rgba(255,255,255,0.15);
    border-top-color: #7C5CFF;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin: 0 auto 24px;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 12px;
    background: linear-gradient(90deg, #7C5CFF, #69E7FF);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  p {
    font-size: 14px;
    color: rgba(255,255,255,0.6);
    line-height: 1.7;
    margin-bottom: 8px;
  }
  .status {
    margin-top: 28px;
    padding: 16px 20px;
    background: rgba(255,255,255,0.05);
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.08);
    font-size: 13px;
    color: rgba(255,255,255,0.7);
    text-align: left;
  }
  .status span {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f59e0b;
    margin-right: 10px;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .auto-refresh {
    margin-top: 20px;
    font-size: 12px;
    color: rgba(255,255,255,0.4);
  }
</style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h1>服务正在恢复中</h1>
    <p>检测到服务异常，正在自动修复...</p>
    <p>请稍候，页面将自动刷新</p>
    <div class="status">
      <p><span></span>正在检查服务状态</p>
      <p><span></span>如有问题将自动重启</p>
      <p><span></span>预计 10-30 秒恢复</p>
    </div>
    <p class="auto-refresh">每 5 秒自动检测...</p>
  </div>
  <script>
    // 每 5 秒尝试访问主站，如果通了就跳转
    setInterval(() => {
      fetch('/api/health?liveness=true', { cache: 'no-store' })
        .then(r => { if (r.ok) window.location.reload(); })
        .catch(() => {});
    }, 5000);
  </script>
</body>
</html>
STATUS_HTML

  # Python 3 起一个极简 HTTP 服务
  if command -v python3 >/dev/null 2>&1; then
    (cd /tmp && python3 -c "
import http.server
import os
import sys

html_file = '$status_html'

class StatusHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            with open(html_file, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except:
            self.send_response(500)
            self.end_headers()
    def log_message(self, format, *args):
        pass  # 静默，不打日志

httpd = http.server.HTTPServer(('0.0.0.0', $STATUS_PAGE_PORT), StatusHandler)
httpd.serve_forever()
" > /dev/null 2>&1) &
    status_page_pid=$!
    log "INFO" "构建状态页已启动 (port=$STATUS_PAGE_PORT, pid=$status_page_pid)"
  fi
}

# 停止构建状态页
stop_status_page() {
  local cleaned=false
  if [ -n "$status_page_pid" ] && kill -0 "$status_page_pid" 2>/dev/null; then
    kill "$status_page_pid" 2>/dev/null || true
    wait "$status_page_pid" 2>/dev/null || true
    cleaned=true
  fi
  status_page_pid=""
  # 兜底：清理所有残留在状态页端口的孤儿进程（历史版本因只杀记录的 pid，
  # 服务重启时曾遗留孤儿状态页长期占用 9001）
  local old_pid
  old_pid=$(ss -H -lntp 2>/dev/null | awk -v p="$STATUS_PAGE_PORT" '$4 ~ ":"p"$"' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  if [ -n "$old_pid" ]; then
    kill -9 "$old_pid" 2>/dev/null || true
    cleaned=true
  fi
  # 清理临时 HTML
  rm -f /tmp/sandbox-status-*.html 2>/dev/null || true
  if $cleaned; then
    log "INFO" "构建状态页已停止"
  fi
}

# 端口是否在监听
port_listening() {
  ss -H -lntp 2>/dev/null | awk -v p="$WATCHDOG_PORT" '$4 ~ ":"p"$"' | grep -q .
}

# HTTP 是否返回 2xx
http_ok() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    "http://localhost:${WATCHDOG_PORT}/" 2>/dev/null || echo "000")
  [[ "$code" =~ ^2[0-9][0-9]$ ]]
}

# 读取 Next.js 主进程 PID
get_next_pid() {
  if [[ -f "$NEXT_PID_FILE" ]]; then
    local pid
    pid=$(cat "$NEXT_PID_FILE" 2>/dev/null || echo "")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  # fallback：从端口反查
  ss -H -lntp 2>/dev/null | awk -v p="$WATCHDOG_PORT" '$4 ~ ":"p"$"' | \
    grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

# 杀掉 Next.js 相关进程
kill_next() {
  log "INFO" "Killing Next.js processes on port ${WATCHDOG_PORT}..."

  # 1. 先尝试 PID 文件里的进程
  if [[ -f "$NEXT_PID_FILE" ]]; then
    local pid
    pid=$(cat "$NEXT_PID_FILE" 2>/dev/null || echo "")
    if [[ -n "$pid" ]]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  # 2. 从端口找进程，杀掉
  local pids
  pids=$(ss -H -lntp 2>/dev/null | awk -v p="$WATCHDOG_PORT" '$4 ~ ":"p"$"' | \
    grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u | paste -sd' ' - || true)
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
    sleep 1
  fi

  rm -f "$NEXT_PID_FILE" 2>/dev/null || true

  # 3. 确认端口释放
  local waited=0
  while port_listening && [[ $waited -lt 10 ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if port_listening; then
    log "WARN" "Port ${WATCHDOG_PORT} still busy after kill attempt"
  else
    log "INFO" "Port ${WATCHDOG_PORT} cleared"
  fi
}

# 杀所有 node 进程（深度修复用）
kill_all_node() {
  log "WARN" "L3: Killing ALL node processes (deep repair)..."
  pkill -9 -f "node" 2>/dev/null || true
  sleep 2
  # 清理端口
  local pids
  pids=$(ss -H -lntp 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u | paste -sd' ' - || true)
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
  sleep 1
}

# ---------- 修复级别 ----------

# L1: 轻量重启 —— 直接重新拉起 Next.js
do_l1_restart() {
  log "WARN" "L1: Light restart (attempt $((l1_count + 1)))"
  kill_next
  start_next_dev
}

# L2: 中度修复 —— 清 lockfile + 清 .next 缓存 + 重装依赖 + 重启
do_l2_repair() {
  log "WARN" "L2: Medium repair (attempt $((l2_count + 1)))"

  kill_next

  # 清理根目录残留 lockfile（Turbopack 白屏元凶）
  if [[ -f "/pnpm-lock.yaml" ]]; then
    log "INFO" "L2: Removing stale /pnpm-lock.yaml"
    rm -f /pnpm-lock.yaml
  fi

  # 清理 .next 缓存（保留 turbo 缓存以提速）
  if [[ -d "${WATCHDOG_CWD}/.next" ]]; then
    log "INFO" "L2: Clearing .next build cache"
    rm -rf "${WATCHDOG_CWD}/.next/cache" 2>/dev/null || true
    rm -f "${WATCHDOG_CWD}/.next/lock" 2>/dev/null || true
  fi

  # 重装依赖
  log "INFO" "L2: Reinstalling dependencies..."
  cd "$WATCHDOG_CWD"
  if ! pnpm install --prefer-offline 2>&1 | tail -5 >> "$WATCHDOG_LOG" 2>&1; then
    log "WARN" "L2: pnpm install with cache failed, trying fresh..."
    pnpm install 2>&1 | tail -10 >> "$WATCHDOG_LOG" 2>&1 || true
  fi

  start_next_dev
}

# L3: 深度修复 —— 杀光 node + 删 .next + 重装 + 重启
do_l3_deep() {
  log "ERROR" "L3: DEEP REPAIR — all previous attempts failed!"

  kill_all_node

  # 清理根目录 lockfile
  rm -f /pnpm-lock.yaml 2>/dev/null || true

  # 彻底删除 .next
  log "INFO" "L3: Removing entire .next directory"
  rm -rf "${WATCHDOG_CWD}/.next" 2>/dev/null || true

  # 清理 node_modules 缓存
  rm -rf "${WATCHDOG_CWD}/node_modules/.cache" 2>/dev/null || true

  # 重装依赖
  log "INFO" "L3: Fresh pnpm install..."
  cd "$WATCHDOG_CWD"
  pnpm install 2>&1 | tail -20 >> "$WATCHDOG_LOG" 2>&1 || true

  start_next_dev
}

# ---------- 启动 Next.js ----------
start_next_dev() {
  cd "$WATCHDOG_CWD"

  # 确保环境变量
  export DEPLOY_RUN_PORT="${WATCHDOG_PORT}"
  export COZE_WORKSPACE_PATH="${WATCHDOG_CWD}"
  export PORT="${WATCHDOG_PORT}"
  export PUPPETEER_SKIP_DOWNLOAD=1
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

  log "INFO" "Starting Next.js dev server on port ${WATCHDOG_PORT}..."

  # 后台启动，写 PID 文件
  # 注意：项目使用自定义 server.ts + tsx watch 启动，不是 next dev
  nohup bash -c "PORT=${WATCHDOG_PORT} pnpm exec tsx watch src/server.ts" \
    > /app/work/logs/bypass//next-dev.log 2>&1 &
  local new_pid=$!
  echo "$new_pid" > "$NEXT_PID_FILE"
  log "INFO" "Next.js (tsx watch) started with PID $new_pid"

  # 等待启动（最多 60 秒）
  local waited=0
  while ! http_ok && [[ $waited -lt 60 ]]; do
    sleep 2
    waited=$((waited + 2))
  done

  if http_ok; then
    log "INFO" "Next.js is healthy after ${waited}s"
    return 0
  else
    log "ERROR" "Next.js failed to become healthy after 60s"
    return 1
  fi
}

# ---------- 主循环 ----------
main() {
  # 写自己的 PID
  echo $$ > "$WATCHDOG_PID_FILE"
  log "INFO" "===== Watchdog started (PID=$$, port=${WATCHDOG_PORT}) ====="

  # 初始延迟，等服务先起来
  sleep 15

  while true; do
    # 检测父进程是否还活着（防孤儿进程）
    if [[ -n "${PPID:-}" ]] && [[ "$PPID" != "1" ]]; then
      if ! kill -0 "$PPID" 2>/dev/null; then
        log "INFO" "Parent process died, watchdog exiting gracefully"
        rm -f "$WATCHDOG_PID_FILE"
        exit 0
      fi
    fi

    # 四层检测 + 内存检测 + 进程泄漏检测
    local healthy=true
    local need_l3=false

    # 1. 端口
    if ! port_listening; then
      log "WARN" "Check failed: port ${WATCHDOG_PORT} not listening"
      healthy=false
    fi

    # 2. 进程
    local np
    np=$(get_next_pid)
    if [[ -z "$np" ]]; then
      log "WARN" "Check failed: no Next.js process found"
      healthy=false
    fi

    # 3. HTTP 200（只有端口通的时候才测，避免误判）
    if $healthy && ! http_ok; then
      log "WARN" "Check failed: HTTP not returning 200"
      healthy=false
    fi

    # 4. 内存水位检测（即使服务正常，内存过高也需要干预）
    local mem_pct
    mem_pct=$(mem_usage_pct)
    if [ "$mem_pct" -ge "$MEM_KILL_PCT" ]; then
      log "ERROR" "Memory usage ${mem_pct}% >= ${MEM_KILL_PCT}%, 触发深度修复"
      need_l3=true
      healthy=false
    elif [ "$mem_pct" -ge "$MEM_WARN_PCT" ]; then
      log "WARN" "Memory usage high: ${mem_pct}% (threshold: ${MEM_WARN_PCT}%)"
    fi

    # 5. 进程泄漏检测
    local leak_count
    leak_count=$(detect_node_leak || echo 0)
    if [ "$leak_count" -gt 0 ]; then
      log "WARN" "Node process leak detected: ${leak_count} processes (threshold: 15)"
      # 进程泄漏但服务还正常的话，先不重启，记录告警
    fi

    if $healthy; then
      # 正常，停止状态页，清零计数
      if [[ $fail_count -gt 0 ]]; then
        log "INFO" "Service recovered, resetting failure counters"
      fi
      stop_status_page
      fail_count=0
      l1_count=0
      l2_count=0
      last_ok_ts=$(date +%s)
      sleep "$WATCHDOG_INTERVAL"
      continue
    fi

    # 异常！启动状态页 + 递进修复
    start_status_page
    fail_count=$((fail_count + 1))
    log "WARN" "Failure count: ${fail_count}"

    if $need_l3 || [[ $fail_count -gt 6 ]]; then
      # L3: 内存爆了或 7 次以上失败 → 深度修复
      do_l3_deep || true
      fail_count=0
    elif [[ $fail_count -le 3 ]]; then
      # L1: 前 3 次失败用轻量重启
      l1_count=$((l1_count + 1))
      do_l1_restart || true
    else
      # L2: 4-6 次用中度修复
      l2_count=$((l2_count + 1))
      do_l2_repair || true
    fi

    # 修复后等一轮间隔再检测
    sleep "$WATCHDOG_INTERVAL"
  done
}

# 捕获退出信号，清理
cleanup() {
  log "INFO" "Watchdog received signal, exiting..."
  stop_status_page
  rm -f "$WATCHDOG_PID_FILE" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT HUP

main "$@"
