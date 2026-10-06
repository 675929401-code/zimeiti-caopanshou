#!/bin/bash
# 健康检查 + 自动恢复脚本
# 用法: 添加到 crontab，每分钟执行一次
# * * * * * /www/agent-hub/scripts/health-check.sh >> /var/log/agent-hub-health.log 2>&1

MAX_RESTARTS=5          # 5分钟内最多重启次数
RESTART_WINDOW=300      # 5分钟窗口
LOG_FILE="/var/log/agent-hub-health.log"
RESTART_COUNTER="/tmp/agent-hub-restarts"
APP_NAME="agent-hub"
PORT=5000
CHECK_URL="http://localhost:${PORT}"

# 记录日志
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# 检查 HTTP 响应
http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$CHECK_URL" 2>/dev/null)

if [ "$http_code" = "200" ]; then
  # 服务正常，检查 PM2 进程状态
  pm2_status=$(pm2 jlist 2>/dev/null | python3 -c "
import sys,json
try:
  procs = json.load(sys.stdin)
  for p in procs:
    if p['name'] == '$APP_NAME':
      restarts = p.get('pm2_env',{}).get('restart_time',0)
      status = p.get('pm2_env',{}).get('status','unknown')
      print(f'{status}:{restarts}')
      break
  else:
    print('not_found:0')
except:
  print('error:0')
" 2>/dev/null)

  # 正常运行时清理重启计数
  if [ -f "$RESTART_COUNTER" ]; then
    last_restart=$(cat "$RESTART_COUNTER" 2>/dev/null | head -1)
    now=$(date +%s)
    if [ -n "$last_restart" ] && [ $((now - last_restart)) -gt $RESTART_WINDOW ]; then
      rm -f "$RESTART_COUNTER"
    fi
  fi

  exit 0
fi

# 服务异常！
log "检测到服务异常！HTTP=$http_code"

# 统计近期重启次数
restart_count=0
if [ -f "$RESTART_COUNTER" ]; then
  while IFS= read -r line; do
    ts=$(echo "$line" | cut -d: -f1)
    now=$(date +%s)
    if [ $((now - ts)) -lt $RESTART_WINDOW ]; then
      restart_count=$((restart_count + 1))
    fi
  done < "$RESTART_COUNTER"
fi

if [ "$restart_count" -ge "$MAX_RESTARTS" ]; then
  log "已达最大重启次数($MAX_RESTARTS)，执行深度修复..."
  # 杀掉所有相关进程
  pkill -f "next start" 2>/dev/null
  sleep 2
  # 清理可能的锁文件
  rm -rf /www/agent-hub/.next/lock 2>/dev/null
  # 重启 PM2
  pm2 restart "$APP_NAME" 2>/dev/null
  log "深度修复完成"
  echo "$(date +%s):deep" >> "$RESTART_COUNTER"
else
  log "尝试重启服务(第$((restart_count+1))次)..."
  pm2 restart "$APP_NAME" 2>/dev/null
  echo "$(date +%s):normal" >> "$RESTART_COUNTER"
fi

# 重启后等待5秒验证
sleep 5
new_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$CHECK_URL" 2>/dev/null)
if [ "$new_code" = "200" ]; then
  log "服务已恢复！HTTP=200"
else
  log "服务仍未恢复！HTTP=$new_code，可能需要人工介入"
fi
