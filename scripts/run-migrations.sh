#!/usr/bin/env bash
# 兼容入口仅允许受控只读命令；凭据只能由环境注入。
set +x
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND="${1:-plan}"
if [ "$#" -gt 0 ]; then shift; fi
case "$COMMAND" in
  plan|status) ;;
  apply|adopt)
    printf '%s\n' 'BLOCKED: 此兼容入口暂禁 apply/adopt。正式工具 scripts/db-migration-release.mjs 的写入流程必须先集成同身份 REST/PostgreSQL 预检：users、video_tasks、user_files 的 count 和 ordered ID hash 全部一致，并验证可恢复备份、manifest SHA-256 及目标 host 确认；这些条件未满足不得执行。' >&2
    exit 2
    ;;
  *)
    printf '%s\n' 'BLOCKED: 禁止旧 host/password 调用。仅支持 plan/status，数据库连接只能由受控环境注入 DEPLOY_DATABASE_URL。' >&2
    exit 2
    ;;
esac

OPTIONS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --include-applied|--write-evidence)
      OPTIONS+=("$1")
      shift
      ;;
    --only)
      if [ "$#" -lt 2 ] || [[ ! "$2" =~ ^[a-zA-Z0-9_,.-]+$ ]]; then
        printf '%s\n' 'BLOCKED: --only 必须提供迁移名称、版本或 slug 列表。' >&2
        exit 2
      fi
      OPTIONS+=("--only" "$2")
      shift 2
      ;;
    --only=*)
      if [[ ! "${1#--only=}" =~ ^[a-zA-Z0-9_,.-]+$ ]]; then
        printf '%s\n' 'BLOCKED: --only 必须提供迁移名称、版本或 slug 列表。' >&2
        exit 2
      fi
      OPTIONS+=("$1")
      shift
      ;;
    *)
      printf '%s\n' 'BLOCKED: 参数不在只读白名单中；禁止 host/password、连接串、root 或 database-url-env 覆写。' >&2
      exit 2
      ;;
  esac
done

# 显式导出空值，防止正式工具从 .env.local 补入未受控连接。
export DEPLOY_DATABASE_URL="${DEPLOY_DATABASE_URL:-}"
if [ "$COMMAND" = status ] && [[ ! "$DEPLOY_DATABASE_URL" =~ [^[:space:]] ]]; then
  printf '%s\n' 'BLOCKED: status 需要受控环境注入 DEPLOY_DATABASE_URL；未连接数据库。' >&2
  exit 2
fi
NODE_EXECUTABLE="${NODE_EXECUTABLE:-node}"
exec "$NODE_EXECUTABLE" "$ROOT/scripts/db-migration-release.mjs" "$COMMAND" --root "$ROOT" --database-url-env DEPLOY_DATABASE_URL "${OPTIONS[@]}"
