#!/bin/bash
# ============================================
# 数据恢复脚本
# 用法: bash scripts/restore-data.sh [备份文件路径]
# 默认使用 backups/latest.json
# ⚠️  恢复会 UPSERT 数据（按 id 匹配），不会删除已有记录
# ============================================

set -e

BACKUP_DIR="$(dirname "$0")/../backups"
BACKUP_FILE="${1:-$BACKUP_DIR/latest.json}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ 备份文件不存在: $BACKUP_FILE"
  echo "用法: bash scripts/restore-data.sh [备份文件路径]"
  exit 1
fi

# ---- 读取环境变量 ----
ENV_FILE="$(dirname "$0")/../.env.local"
if [ -f "$ENV_FILE" ]; then
  COZE_SUPABASE_URL="${COZE_SUPABASE_URL:-$(sed -n 's/^COZE_SUPABASE_URL=//p' "$ENV_FILE" | head -1)}"
  COZE_SUPABASE_SERVICE_ROLE_KEY="${COZE_SUPABASE_SERVICE_ROLE_KEY:-$(sed -n 's/^COZE_SUPABASE_SERVICE_ROLE_KEY=//p' "$ENV_FILE" | head -1)}"
fi

SUPABASE_URL="${COZE_SUPABASE_URL}"
SUPABASE_KEY="${COZE_SUPABASE_SERVICE_ROLE_KEY}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "❌ 缺少 Supabase 环境变量"
  exit 1
fi

echo "=========================================="
echo "  数据恢复"
echo "=========================================="
echo "  备份文件: $BACKUP_FILE"
echo "  备份时间: $(python3 -c "import json; print(json.load(open('$BACKUP_FILE')).get('backup_time','未知'))" 2>/dev/null || echo '未知')"
echo ""

# ---- 确认 ----
read -p "⚠️  确认要恢复数据吗？此操作会向数据库写入数据 (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "已取消"
  exit 0
fi

# ---- 恢复函数 ----
restore_table() {
  local category="$1"
  local table="$2"

  local data
  data=$(python3 -c "
import json
d = json.load(open('$BACKUP_FILE'))
rows = d.get('$category', {}).get('$table', [])
if not rows:
    print('EMPTY')
else:
    print(json.dumps(rows))
" 2>/dev/null)

  if [ "$data" = "EMPTY" ] || [ -z "$data" ]; then
    echo "  ⏭️  $table: 无数据，跳过"
    return
  fi

  local count
  count=$(echo "$data" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")

  # 使用 PostgREST 的 POST + Prefer: resolution=merge-duplicates 实现 UPSERT
  local url="${SUPABASE_URL}/rest/v1/${table}"
  local response
  response=$(curl -s -w "\n%{http_code}" --max-time 60 \
    -X POST \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates" \
    -d "$data" \
    "$url" 2>/dev/null)

  local http_code
  http_code=$(echo "$response" | tail -1)

  if [ "$http_code" = "201" ] || [ "$http_code" = "200" ]; then
    echo "  ✅ $table: ${count} 条记录已恢复 (HTTP $http_code)"
  else
    local error_msg
    error_msg=$(echo "$response" | head -n -1)
    echo "  ❌ $table: 恢复失败 (HTTP $http_code)"
    echo "     错误: $(echo "$error_msg" | head -c 200)"
  fi
}

# ---- 恢复顺序：先配置表 → 核心表 → 日志表 ----
# 这样确保外键依赖正确

echo "=== 恢复配置数据 ==="
CONFIG_TABLES=("categories" "agents" "platform_settings" "video_models" "cover_models" "announcements")
for table in "${CONFIG_TABLES[@]}"; do
  restore_table "config" "$table"
done

echo ""
echo "=== 恢复核心数据（学员资产）==="
CORE_TABLES=("users" "credit_transactions" "cash_transactions" "revenue_records" "payment_orders")
for table in "${CORE_TABLES[@]}"; do
  restore_table "core" "$table"
done

echo ""
echo "=== 恢复日志与历史数据 ==="
LOG_TABLES=("login_logs" "video_tasks" "video_channel_health" "conversations" "conversation_messages" "prompt_guard_logs" "security_events" "formatter_history" "segmenter_history" "system_logs" "health_checks" "auto_fixes")
for table in "${LOG_TABLES[@]}"; do
  restore_table "logs" "$table"
done

echo ""
echo "=========================================="
echo "  ✅ 数据恢复完成！"
echo "=========================================="
