#!/bin/bash
# ============================================
# 学员数据每日备份脚本
# 用法: bash runtime-tools/backup-data.sh
# 策略: 每日一次，新备份覆盖旧备份
# 存储: 独立持久化 BACKUP_DIR（7天轮转）；异地复制由外部备份作业负责。
# ============================================

set -e

# ---- 读取环境变量 ----
ENV_FILE="$(dirname "$0")/../.env.local"
if [ -f "$ENV_FILE" ]; then
  COZE_SUPABASE_URL="${COZE_SUPABASE_URL:-$(sed -n 's/^COZE_SUPABASE_URL=//p' "$ENV_FILE" | head -1)}"
  COZE_SUPABASE_SERVICE_ROLE_KEY="${COZE_SUPABASE_SERVICE_ROLE_KEY:-$(sed -n 's/^COZE_SUPABASE_SERVICE_ROLE_KEY=//p' "$ENV_FILE" | head -1)}"
fi

SUPABASE_URL="${COZE_SUPABASE_URL}"
SUPABASE_KEY="${COZE_SUPABASE_SERVICE_ROLE_KEY}"
export SUPABASE_URL SUPABASE_KEY

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "❌ 缺少 Supabase 环境变量 (COZE_SUPABASE_URL / COZE_SUPABASE_SERVICE_ROLE_KEY)"
  exit 1
fi

# ---- 配置 ----
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "${NODE_ENV:-development}" = "production" ]; then
  case "${BACKUP_DIR:-}" in
    /*) ;;
    *) echo "❌ 生产环境要求 BACKUP_DIR 为已挂载的绝对路径" >&2; exit 2 ;;
  esac
else
  BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
fi
BACKUP_FILE="$BACKUP_DIR/latest.json"
BACKUP_DAILY="$BACKUP_DIR/daily_$(date +%u).json"  # 周一到周日轮转1-7
BACKUP_TIMESTAMP_FILE="$BACKUP_DIR/latest.timestamp"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
DATE_LABEL=$(date '+%Y%m%d')
export BACKUP_FILE TIMESTAMP DATE_LABEL

mkdir -p "$BACKUP_DIR"

echo "=========================================="
echo "  学员数据备份 - $TIMESTAMP"
echo "=========================================="

# ---- 使用 Python 执行备份（避免 Bash 拼接 JSON 的特殊字符问题）----
python3 << 'PYTHON_SCRIPT'
import json, os, re, urllib.request, urllib.error, sys

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
BACKUP_FILE = os.environ.get("BACKUP_FILE", "")
TIMESTAMP = os.environ.get("TIMESTAMP", "")
DATE_LABEL = os.environ.get("DATE_LABEL", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ 缺少环境变量")
    sys.exit(1)

CORE_TABLES = ["users", "credit_transactions", "cash_transactions", "revenue_records", "payment_orders"]
CONFIG_TABLES = ["agents", "categories", "platform_settings", "video_models", "cover_models", "announcements"]
LOG_TABLES = ["login_logs", "video_tasks", "video_channel_health", "conversations", "conversation_messages",
              "prompt_guard_logs", "security_events", "formatter_history", "segmenter_history",
              "system_logs", "health_checks", "auto_fixes"]
# 补充表（邀请码/技能/插件/模型等 — 完整灾备必需）
SUPP_TABLES = ["invitation_codes", "invitation_records", "invitation_benefits",
               "skills", "agent_skills", "plugins", "crami_codes",
               "trial_plans", "trial_plan_agents", "user_trial_activations",
               "llm_models", "user_favorites", "daily_usage_stats", "voice_tasks",
               "user_voices", "voice_nest_slots"]

def export_table(table_name):
    """通过 Supabase REST API 导出表数据"""
    url = f"{SUPABASE_URL}/rest/v1/{table_name}?select=*&limit=100000&order=id.asc"
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}"
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            count = len(data) if isinstance(data, list) else 0
            print(f"  ✅ {table_name}: {count} 条记录")
            return data
    except urllib.error.HTTPError as e:
        # 某些表可能不存在
        print(f"  ⚠️  {table_name}: 导出失败 (HTTP {e.code}), 跳过")
        return []
    except Exception as e:
        print(f"  ⚠️  {table_name}: 导出异常 ({str(e)[:80]}), 跳过")
        return []

def export_category(tables, label):
    """导出一个分类下的所有表"""
    print(f"\n=== {label} ===")
    result = {}
    for table in tables:
        result[table] = export_table(table)
    return result

def validate_auth_snapshot(users):
    """备份必须保留有效 password_hash，否则恢复后原密码无法登录。"""
    issues = []
    bcrypt_re = re.compile(r"^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$")
    if not isinstance(users, list):
        return ["core.users 缺失，不能作为可恢复登录的数据快照"]
    if len(users) == 0:
        return ["core.users 为空，不能作为可恢复登录的数据快照"]
    for idx, user in enumerate(users, start=1):
        if not isinstance(user, dict):
            issues.append(f"第 {idx} 条用户记录不是对象")
            continue
        identity = user.get("username") or user.get("email") or user.get("phone") or user.get("id") or f"row-{idx}"
        password_hash = user.get("password_hash")
        if not isinstance(password_hash, str) or not password_hash.strip():
            issues.append(f"用户 {identity} 缺少 password_hash")
        elif not bcrypt_re.match(password_hash.strip()):
            issues.append(f"用户 {identity} 的 password_hash 不是有效 bcrypt 哈希")
    return issues

# 执行备份
core_data = export_category(CORE_TABLES, "核心数据（学员资产）")
config_data = export_category(CONFIG_TABLES, "配置数据（平台运营）")
log_data = export_category(LOG_TABLES, "日志与历史数据")
supp_data = export_category(SUPP_TABLES, "补充数据（邀请码/技能/插件/模型）")

auth_issues = validate_auth_snapshot(core_data.get("users", []))
if auth_issues:
    print("\n❌ 认证快照校验失败，已停止保存备份：")
    for issue in auth_issues[:20]:
        print(f"  - {issue}")
    if len(auth_issues) > 20:
        print(f"  - 其余 {len(auth_issues) - 20} 项已省略")
    sys.exit(2)

backup = {
    "backup_time": TIMESTAMP,
    "date_label": DATE_LABEL,
    "version": "2.0",
    "auth_snapshot": {
        "ok": True,
        "checkedUsers": len(core_data.get("users", [])),
        "passwordHashAlgorithm": "bcrypt"
    },
    "core": core_data,
    "config": config_data,
    "logs": log_data,
    "supplement": supp_data,
}

# 保存文件
with open(BACKUP_FILE, "w", encoding="utf-8") as f:
    json.dump(backup, f, ensure_ascii=False, indent=2)

# 统计
total_core = sum(len(v) for v in core_data.values())
total_supp = sum(len(v) for v in supp_data.values())
file_size = os.path.getsize(BACKUP_FILE)
size_str = f"{file_size / 1024:.1f} KB" if file_size < 1024 * 1024 else f"{file_size / 1024 / 1024:.1f} MB"

# 资产统计
users = core_data.get("users", [])
total_credits = sum(u.get("credits", 0) or 0 for u in users)
total_cash = sum(u.get("cash_balance", 0) or 0 for u in users)

print(f"\n==========================================")
print(f"  ✅ 备份完成！")
print(f"  时间: {TIMESTAMP}")
print(f"  核心数据: {total_core} 条")
print(f"  补充数据: {total_supp} 条")
print(f"  用户数: {len(users)}")
print(f"  积分合计: {total_credits:.2f}")
print(f"  现金合计: ¥{total_cash:.2f}")
print(f"  文件大小: {size_str}")
print(f"  路径: {BACKUP_FILE}")
print(f"==========================================")
PYTHON_SCRIPT

  # 轮转备份：复制到 daily_1~7.json（周一到周日）
cp "$BACKUP_FILE" "$BACKUP_DAILY" 2>/dev/null && echo "📅 轮转备份: $BACKUP_DAILY" || true

# 保存时间戳
echo "$TIMESTAMP" > "$BACKUP_TIMESTAMP_FILE"

# 数据库快照永远不得进入普通 Git/Gitee 代码仓。
if [ "${PUSH_DATA_BACKUP_TO_GIT:-0}" = "1" ]; then
  echo "❌ 已阻止：数据库快照不得进入代码仓。请由加密的异地备份作业复制 BACKUP_DIR。" >&2
  exit 2
fi
