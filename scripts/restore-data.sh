#!/usr/bin/env bash
# Linux-only restore into a newly provisioned cluster and isolated encrypted mount.

set -Eeuo pipefail
umask 077

MODE="${1:---plan}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HELPER="$PROJECT_ROOT/scripts/backup-recovery-helper.mjs"
PHASE="preflight"
START_EPOCH="$(date +%s)"
ERROR_RECEIPT_ARMED=0
PLAIN_STAGE_NAME="zimeiti-restore-plaintext-staging"
FILES_STAGE_NAME="zimeiti-restore-files-staging"

die() {
  printf 'RESTORE_BLOCKED:%s\n' "$1" >&2
  if [[ "$ERROR_RECEIPT_ARMED" = "1" ]]; then on_error "${2:-2}"; else exit "${2:-2}"; fi
}
require_command() { command -v "$1" >/dev/null 2>&1 || die "COMMAND_REQUIRED:$1"; }
require_absolute_file() {
  local name="$1" value="${!1:-}"
  [[ "$value" = /* ]] || die "ABSOLUTE_FILE_REQUIRED:$name"
  [[ ! "$value" =~ [[:cntrl:]] ]] || die "CONTROL_CHARACTER_IN_PATH:$name"
  [[ ! -L "$value" ]] || die "SYMLINK_NOT_ALLOWED:$name"
  [[ -f "$value" ]] || die "FILE_NOT_FOUND:$name"
}
require_absolute_dir() {
  local name="$1" value="${!1:-}"
  [[ "$value" = /* ]] || die "ABSOLUTE_DIRECTORY_REQUIRED:$name"
  [[ ! "$value" =~ [[:cntrl:]] ]] || die "CONTROL_CHARACTER_IN_PATH:$name"
  [[ ! -L "$value" ]] || die "SYMLINK_NOT_ALLOWED:$name"
  [[ -d "$value" ]] || die "DIRECTORY_NOT_FOUND:$name"
}
require_controlled_secret_file() {
  local name="$1" value="${!1:-}" owner mode
  require_absolute_file "$name"
  owner="$(stat -Lc '%u' "$value")"
  mode="$(stat -Lc '%a' "$value")"
  [[ "$owner" = "$(id -u)" ]] || die "CONTROL_FILE_OWNER_MISMATCH:$name"
  (( (8#$mode & 077) == 0 )) || die "CONTROL_FILE_PERMISSIONS_TOO_OPEN:$name"
}
device_number() { stat -Lc '%d' "$1"; }
is_inside_or_equal() {
  local parent="$1" child="$2"
  [[ "$child" = "$parent" || "$child" = "$parent"/* ]]
}
require_disjoint() {
  local left right label="$3"
  left="$(realpath -e "$1")"
  right="$(realpath -e "$2")"
  if is_inside_or_equal "$left" "$right" || is_inside_or_equal "$right" "$left"; then
    die "PATHS_MUST_BE_BIDIRECTIONALLY_DISJOINT:$label"
  fi
  node "$HELPER" assert-disjoint --left "$left" --right "$right"
}
validate_secure_mount() {
  local name="$1" mount_path="${!1:-}" filesystem source block_type root_dev mount_dev
  require_absolute_dir "$name"
  mountpoint -q "$mount_path" || die "SECURE_MOUNT_REQUIRED:$name"
  filesystem="$(findmnt -n -o FSTYPE -T "$mount_path")"
  if [[ "$filesystem" != "tmpfs" ]]; then
    source="$(findmnt -n -o SOURCE -T "$mount_path")"
    source="${source%%\[*}"
    [[ "$source" = /dev/* ]] || die "SECURE_MOUNT_MUST_BE_TMPFS_OR_DMCRYPT:$name"
    block_type="$(lsblk -ndo TYPE "$source" 2>/dev/null | head -n 1)"
    [[ "$block_type" = "crypt" ]] || die "SECURE_MOUNT_MUST_BE_TMPFS_OR_DMCRYPT:$name"
  fi
  root_dev="$(device_number /)"
  mount_dev="$(device_number "$mount_path")"
  [[ -n "$mount_dev" && "$mount_dev" != "$root_dev" ]] || die "SECURE_MOUNT_MUST_NOT_USE_SYSTEM_DEVICE:$name"
}

print_usage() {
  cat <<'USAGE'
Usage: bash scripts/restore-data.sh --plan|--preflight|--execute

Required controlled inputs:
  RESTORE_PACKAGE, RESTORE_EXPECTED_PACKAGE_SHA256, RESTORE_AGE_IDENTITY_FILE
  RESTORE_ISOLATION_MOUNTPOINT, RESTORE_PLAINTEXT_STAGING_MOUNTPOINT
  RESTORE_ROOT, RESTORE_RECEIPT_DIR, RESTORE_PG_SERVICE
  RESTORE_EXPECTED_TARGET_SYSTEM_IDENTIFIER, RESTORE_EXPECTED_TARGET_DATABASE
  RESTORE_EXPECTED_TARGET_ROLE, RESTORE_PRODUCTION_IDENTITY_FILE
  RESTORE_PROVISIONING_RECEIPT, RESTORE_PROVISIONING_HMAC_KEY_FILE

The target must be a different PostgreSQL system_identifier from production,
empty, provisioned with a signed nonce, and accessed by the expected
non-superuser restore role. Same-cluster different-database restores are refused.
USAGE
}

validate_configuration() {
  [[ "$(uname -s)" = "Linux" ]] || die "LINUX_ONLY"
  [[ -f "$HELPER" ]] || die "HELPER_NOT_FOUND"
  require_absolute_file RESTORE_PACKAGE
  require_controlled_secret_file RESTORE_AGE_IDENTITY_FILE
  require_controlled_secret_file RESTORE_PRODUCTION_IDENTITY_FILE
  require_controlled_secret_file RESTORE_PROVISIONING_RECEIPT
  require_controlled_secret_file RESTORE_PROVISIONING_HMAC_KEY_FILE
  [[ "${RESTORE_EXPECTED_PACKAGE_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ ]] || die "EXPECTED_PACKAGE_SHA256_REQUIRED"
  [[ "${RESTORE_PG_SERVICE:-}" =~ ^[A-Za-z0-9._-]+$ ]] || die "RESTORE_PG_SERVICE_INVALID"
  [[ "${RESTORE_EXPECTED_TARGET_SYSTEM_IDENTIFIER:-}" =~ ^[0-9]{10,20}$ ]] || die "EXPECTED_TARGET_SYSTEM_IDENTIFIER_INVALID"
  [[ "${RESTORE_EXPECTED_TARGET_DATABASE:-}" =~ ^zimeiti_restore_[a-z0-9_]+$ ]] || die "EXPECTED_TARGET_DATABASE_INVALID"
  [[ "${RESTORE_EXPECTED_TARGET_ROLE:-}" =~ ^[a-z_][a-z0-9_-]{0,62}$ ]] || die "EXPECTED_TARGET_ROLE_INVALID"

  validate_secure_mount RESTORE_ISOLATION_MOUNTPOINT
  validate_secure_mount RESTORE_PLAINTEXT_STAGING_MOUNTPOINT
  local isolation_root plaintext_root isolation_dev plaintext_dev restore_parent receipt_root
  isolation_root="$(realpath -e "$RESTORE_ISOLATION_MOUNTPOINT")"
  plaintext_root="$(realpath -e "$RESTORE_PLAINTEXT_STAGING_MOUNTPOINT")"
  is_inside_or_equal "$isolation_root" "$plaintext_root" || die "PLAINTEXT_STAGING_MUST_BE_NESTED_UNDER_ISOLATION_MOUNT"
  isolation_dev="$(device_number "$isolation_root")"
  plaintext_dev="$(device_number "$plaintext_root")"
  [[ "$isolation_dev" != "$plaintext_dev" ]] || die "PLAINTEXT_STAGING_MUST_USE_DEDICATED_DEVICE"

  [[ "${RESTORE_ROOT:-}" = /* ]] || die "ABSOLUTE_DIRECTORY_REQUIRED:RESTORE_ROOT"
  [[ ! "$RESTORE_ROOT" =~ [[:cntrl:]] ]] || die "CONTROL_CHARACTER_IN_PATH:RESTORE_ROOT"
  [[ "$(basename "$RESTORE_ROOT")" = zimeiti-restore-* ]] || die "RESTORE_ROOT_NAME_MUST_BE_ISOLATED"
  [[ ! -e "$RESTORE_ROOT" ]] || die "RESTORE_ROOT_MUST_NOT_EXIST"
  [[ -d "$(dirname "$RESTORE_ROOT")" && -w "$(dirname "$RESTORE_ROOT")" ]] || die "RESTORE_ROOT_PARENT_NOT_WRITABLE"
  restore_parent="$(realpath -e "$(dirname "$RESTORE_ROOT")")"
  is_inside_or_equal "$isolation_root" "$restore_parent" || die "RESTORE_ROOT_OUTSIDE_ISOLATION_MOUNT"
  [[ "$(device_number "$restore_parent")" = "$isolation_dev" ]] || die "RESTORE_ROOT_UNEXPECTED_DEVICE"

  require_absolute_dir RESTORE_RECEIPT_DIR
  [[ -w "$RESTORE_RECEIPT_DIR" ]] || die "RESTORE_RECEIPT_DIRECTORY_NOT_WRITABLE"
  receipt_root="$(realpath -e "$RESTORE_RECEIPT_DIR")"
  require_disjoint "$receipt_root" "$plaintext_root" "receipt-plaintext-workspace"
  node "$HELPER" assert-path-absent --path "$plaintext_root/$PLAIN_STAGE_NAME" || die "PLAINTEXT_STAGING_RESIDUE_REQUIRES_MANUAL_REVIEW"
  node "$HELPER" assert-path-absent --path "$isolation_root/$FILES_STAGE_NAME" || die "RESTORE_FILES_STAGING_RESIDUE_REQUIRES_MANUAL_REVIEW"
}

validate_tools() {
  for tool in age pg_restore psql node tar sha256sum realpath mountpoint findmnt stat id lsblk uname; do
    require_command "$tool"
  done
}

emit_plan() {
  cat <<'EOF'
{
  "schemaVersion": "zimeiti-restore-plan.v2",
  "platform": "linux-only",
  "source": "authenticated-age-package",
  "targetPolicy": "new-empty-different-cluster-only",
  "clusterIdentity": "system-identifier-plus-signed-provisioning-nonce",
  "sameClusterDifferentDatabaseAllowed": false,
  "plaintextWorkspace": "dedicated-tmpfs-or-verified-dmcrypt-under-isolation-mount",
  "serviceRpoRtoMeasured": false,
  "productionOverwriteAllowed": false
}
EOF
}

case "$MODE" in
  -h|--help) print_usage; exit 0 ;;
  --plan) emit_plan; exit 0 ;;
  --preflight)
    validate_tools
    validate_configuration
    ACTUAL_SHA="$(sha256sum "$RESTORE_PACKAGE" | awk '{print $1}')"
    [[ "${ACTUAL_SHA,,}" = "${RESTORE_EXPECTED_PACKAGE_SHA256,,}" ]] || die "ENCRYPTED_PACKAGE_SHA256_MISMATCH"
    printf 'RESTORE_PREFLIGHT_OK\n'
    exit 0
    ;;
  --execute) ;;
  *) print_usage >&2; die "MODE_INVALID:$MODE" ;;
esac

validate_tools
validate_configuration
ACTUAL_SHA="$(sha256sum "$RESTORE_PACKAGE" | awk '{print $1}')"
[[ "${ACTUAL_SHA,,}" = "${RESTORE_EXPECTED_PACKAGE_SHA256,,}" ]] || die "ENCRYPTED_PACKAGE_SHA256_MISMATCH"

RESTORE_ID="restore-$(date -u +%Y%m%dT%H%M%SZ)-$$"
WORK_ROOT="$RESTORE_PLAINTEXT_STAGING_MOUNTPOINT/$PLAIN_STAGE_NAME"
PLAIN_ARCHIVE="$WORK_ROOT/package.tar.gz"
EXTRACTED="$WORK_ROOT/extracted"
FILES_STAGING="$RESTORE_ISOLATION_MOUNTPOINT/$FILES_STAGE_NAME"
SUCCESS_RECEIPT="$RESTORE_RECEIPT_DIR/${RESTORE_ID}.receipt.json"
FAILURE_RECEIPT="$RESTORE_RECEIPT_DIR/${RESTORE_ID}.failed.json"
TARGET_DATABASE="unknown"

cleanup() {
  case "$WORK_ROOT" in
    "$RESTORE_PLAINTEXT_STAGING_MOUNTPOINT/$PLAIN_STAGE_NAME") rm -rf -- "$WORK_ROOT" ;;
    *) printf 'RESTORE_PLAINTEXT_CLEANUP_REFUSED\n' >&2 ;;
  esac
  case "$FILES_STAGING" in
    "$RESTORE_ISOLATION_MOUNTPOINT/$FILES_STAGE_NAME") rm -rf -- "$FILES_STAGING" ;;
    *) printf 'RESTORE_FILES_CLEANUP_REFUSED\n' >&2 ;;
  esac
}
on_error() {
  local status="${1:-1}" failed_epoch
  trap - ERR
  ERROR_RECEIPT_ARMED=0
  failed_epoch="$(date +%s)"
  node "$HELPER" write-restore-failure-receipt --output "$FAILURE_RECEIPT" --restore-id "$RESTORE_ID" --phase "$PHASE" --target-database "$TARGET_DATABASE" --started-epoch "$START_EPOCH" --completed-epoch "$failed_epoch" --package-sha256 "$ACTUAL_SHA" 2>/dev/null || true
  if [[ -f "$FAILURE_RECEIPT" ]]; then node "$HELPER" validate-receipt --kind restore --document "$FAILURE_RECEIPT" 2>/dev/null || true; fi
  cleanup
  exit "$status"
}
trap 'on_error "$?"' ERR
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ERROR_RECEIPT_ARMED=1
mkdir "$WORK_ROOT"
[[ "$(device_number "$WORK_ROOT")" = "$(device_number "$RESTORE_PLAINTEXT_STAGING_MOUNTPOINT")" ]] || die "PLAINTEXT_WORKSPACE_UNEXPECTED_DEVICE"

query_target_identity() {
  local output="$1"
  PGSERVICE="$RESTORE_PG_SERVICE" psql -qAtX -v ON_ERROR_STOP=1 > "$output" <<'SQL'
select json_build_object(
  'systemIdentifier', (select system_identifier::text from pg_control_system()),
  'database', current_database(),
  'role', current_user,
  'provisioningNonce', current_setting('zimeiti.restore_provisioning_nonce', true),
  'roleSuper', r.rolsuper,
  'roleCreateRole', r.rolcreaterole,
  'roleCreateDb', r.rolcreatedb,
  'roleReplication', r.rolreplication,
  'roleBypassRls', r.rolbypassrls,
  'databaseConnect', has_database_privilege(current_user,current_database(),'CONNECT'),
  'databaseCreate', has_database_privilege(current_user,current_database(),'CREATE'),
  'databaseTemporary', has_database_privilege(current_user,current_database(),'TEMP'),
  'publicSchemaCreate', has_schema_privilege(current_user,'public','CREATE')
) from pg_roles r where r.rolname=current_user;
SQL
}

validate_identity() {
  local identity_file="$1" phase="$2" output="$3"
  local args=(validate-restore-identity --identity "$identity_file" --production-identity "$RESTORE_PRODUCTION_IDENTITY_FILE" --provisioning-receipt "$RESTORE_PROVISIONING_RECEIPT" --attestation-key "$RESTORE_PROVISIONING_HMAC_KEY_FILE" --expected-target-system-identifier "$RESTORE_EXPECTED_TARGET_SYSTEM_IDENTIFIER" --expected-target-database "$RESTORE_EXPECTED_TARGET_DATABASE" --expected-target-role "$RESTORE_EXPECTED_TARGET_ROLE" --phase "$phase" --now-epoch "$(date +%s)" --output "$output")
  if [[ "$phase" = "after" ]]; then args+=(--expected-before-report "$WORK_ROOT/identity-before-report.json"); fi
  node "$HELPER" "${args[@]}"
}

PHASE="validate-isolated-target"
query_target_identity "$WORK_ROOT/identity-before.json"
validate_identity "$WORK_ROOT/identity-before.json" before "$WORK_ROOT/identity-before-report.json"
TARGET_DATABASE="$RESTORE_EXPECTED_TARGET_DATABASE"
TABLE_COUNT="$(PGSERVICE="$RESTORE_PG_SERVICE" psql -qAtX -v ON_ERROR_STOP=1 -c "select count(*) from pg_tables where schemaname <> 'information_schema' and schemaname !~ '^pg_';")"
[[ "$TABLE_COUNT" = "0" ]] || die "TARGET_DATABASE_MUST_BE_EMPTY"

PHASE="decrypt-and-verify"
age --decrypt -i "$RESTORE_AGE_IDENTITY_FILE" -o "$PLAIN_ARCHIVE" "$RESTORE_PACKAGE"
[[ -s "$PLAIN_ARCHIVE" ]] || die "DECRYPTED_ARCHIVE_EMPTY"
mkdir "$EXTRACTED"
tar -tzf "$PLAIN_ARCHIVE" > "$WORK_ROOT/archive-members.txt"
while IFS= read -r member; do
  [[ -n "$member" ]] || die "ARCHIVE_EMPTY_MEMBER"
  case "$member" in
    /*|../*|*/../*|*/..|..|*//*|*[$'\001'-$'\037']*) die "ARCHIVE_PATH_INVALID" ;;
  esac
done < "$WORK_ROOT/archive-members.txt"
tar -tvzf "$PLAIN_ARCHIVE" | awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" { exit 1 }' || die "ARCHIVE_MEMBER_TYPE_INVALID"
tar --no-same-owner --no-same-permissions -xzf "$PLAIN_ARCHIVE" -C "$EXTRACTED"
rm -f -- "$PLAIN_ARCHIVE"
node "$HELPER" verify-manifest --root "$EXTRACTED" --manifest "$EXTRACTED/manifest.json"
node "$HELPER" validate-backup-metadata --document "$EXTRACTED/metadata/package.json"
for required in postgres/database.dump postgres/schema.sql postgres/globals.sql postgres/version.json sqlite/commerce.sqlite sqlite/voice.sqlite audits/postgres-row-counts.json audits/postgres-financial-check.json audits/commerce-sqlite.json audits/voice-sqlite.json metadata/package.json; do
  [[ -f "$EXTRACTED/$required" ]] || die "PACKAGE_REQUIRED_FILE_MISSING"
done

PHASE="prepare-isolated-files"
mkdir "$FILES_STAGING"
[[ "$(device_number "$FILES_STAGING")" = "$(device_number "$RESTORE_ISOLATION_MOUNTPOINT")" ]] || die "RESTORE_FILES_STAGING_UNEXPECTED_DEVICE"
node "$HELPER" copy-tree --source "$EXTRACTED/files/app-data" --destination "$FILES_STAGING/app-data"
mkdir "$FILES_STAGING/commerce" "$FILES_STAGING/voice"
cp "$EXTRACTED/sqlite/commerce.sqlite" "$FILES_STAGING/commerce/commerce.sqlite"
cp "$EXTRACTED/sqlite/voice.sqlite" "$FILES_STAGING/voice/voice.db"
node "$HELPER" copy-tree --source "$EXTRACTED/files/commerce-assets" --destination "$FILES_STAGING/commerce/assets"
node "$HELPER" copy-tree --source "$EXTRACTED/files/voice-reference-audio" --destination "$FILES_STAGING/voice/reference-audio"
node "$HELPER" copy-tree --source "$EXTRACTED/files/uploads" --destination "$FILES_STAGING/uploads"
node "$HELPER" copy-tree --source "$EXTRACTED/files/public-assets" --destination "$FILES_STAGING/public-assets"
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/app-data" --actual-root "$FILES_STAGING/app-data" --label APP_DATA
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/commerce-assets" --actual-root "$FILES_STAGING/commerce/assets" --label COMMERCE_ASSETS
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/voice-reference-audio" --actual-root "$FILES_STAGING/voice/reference-audio" --label VOICE_REFERENCE_AUDIO
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/uploads" --actual-root "$FILES_STAGING/uploads" --label UPLOADS
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/public-assets" --actual-root "$FILES_STAGING/public-assets" --label PUBLIC_ASSETS
node "$HELPER" sqlite-audit --source "$FILES_STAGING/commerce/commerce.sqlite" --report "$WORK_ROOT/commerce-restore-audit.json"
node "$HELPER" sqlite-audit --source "$FILES_STAGING/voice/voice.db" --report "$WORK_ROOT/voice-restore-audit.json"
node "$HELPER" compare-sqlite-audit --expected "$EXTRACTED/audits/commerce-sqlite.json" --actual "$WORK_ROOT/commerce-restore-audit.json" --label COMMERCE_SQLITE
node "$HELPER" compare-sqlite-audit --expected "$EXTRACTED/audits/voice-sqlite.json" --actual "$WORK_ROOT/voice-restore-audit.json" --label VOICE_SQLITE

PHASE="pre-pgrestore-identity-recheck"
query_target_identity "$WORK_ROOT/identity-pre-pgrestore.json"
validate_identity "$WORK_ROOT/identity-pre-pgrestore.json" before "$WORK_ROOT/identity-pre-pgrestore-report.json"
node "$HELPER" compare-json --expected "$WORK_ROOT/identity-before-report.json" --actual "$WORK_ROOT/identity-pre-pgrestore-report.json" --label PRE_PGRESTORE_IDENTITY

PHASE="restore-postgresql"
PGSERVICE="$RESTORE_PG_SERVICE" pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname="service=$RESTORE_PG_SERVICE" "$EXTRACTED/postgres/database.dump"

PHASE="validate-postgresql"
PGSERVICE="$RESTORE_PG_SERVICE" psql -qAtX -v ON_ERROR_STOP=1 > "$WORK_ROOT/postgres-row-counts.json" <<'SQL'
create temporary table backup_row_counts(name text primary key, rows text not null) on commit drop;
do $$
declare item record; total text;
begin
  for item in select schemaname, tablename from pg_tables where schemaname <> 'information_schema' and schemaname !~ '^pg_' order by schemaname,tablename loop
    execute format('select count(*)::text from %I.%I', item.schemaname, item.tablename) into total;
    insert into backup_row_counts values (item.schemaname || '.' || item.tablename, total);
  end loop;
end $$;
select jsonb_object_agg(name, rows order by name) from backup_row_counts;
SQL
PGSERVICE="$RESTORE_PG_SERVICE" psql -qAtX -v ON_ERROR_STOP=1 > "$WORK_ROOT/postgres-financial-check.json" <<'SQL'
select jsonb_build_object(
  'users', (select count(*)::text from public.users),
  'creditsBalance', (select coalesce(sum(credits),0)::text from public.users),
  'cashBalance', (select coalesce(sum(cash_balance),0)::text from public.users),
  'creditsReserved', (select coalesce(sum(credits_reserved),0)::text from public.users),
  'creditTransactions', (select count(*)::text from public.credit_transactions),
  'creditTransactionAmount', (select coalesce(sum(amount),0)::text from public.credit_transactions),
  'cashTransactions', (select count(*)::text from public.cash_transactions),
  'cashTransactionAmount', (select coalesce(sum(amount),0)::text from public.cash_transactions),
  'walletLedgerEntries', (select count(*)::text from public.wallet_ledger_entries),
  'walletLedgerDelta', (select coalesce(sum(delta),0)::text from public.wallet_ledger_entries),
  'paymentOrders', (select count(*)::text from public.payment_orders),
  'paymentOrderAmount', (select coalesce(sum(amount),0)::text from public.payment_orders)
);
SQL
node "$HELPER" compare-json --expected "$EXTRACTED/audits/postgres-row-counts.json" --actual "$WORK_ROOT/postgres-row-counts.json" --label POSTGRES_ROW_COUNTS
node "$HELPER" compare-json --expected "$EXTRACTED/audits/postgres-financial-check.json" --actual "$WORK_ROOT/postgres-financial-check.json" --label POSTGRES_FINANCIAL_CHECK

query_target_identity "$WORK_ROOT/identity-after.json"
validate_identity "$WORK_ROOT/identity-after.json" after "$WORK_ROOT/identity-after-report.json"

PHASE="commit-isolated-files"
mv -n "$FILES_STAGING" "$RESTORE_ROOT" || die "RESTORE_ROOT_COMMIT_FAILED"
[[ -d "$RESTORE_ROOT" && ! -e "$FILES_STAGING" ]] || die "RESTORE_ROOT_COMMIT_INCOMPLETE"
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/app-data" --actual-root "$RESTORE_ROOT/app-data" --label APP_DATA_POST_COMMIT
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/commerce-assets" --actual-root "$RESTORE_ROOT/commerce/assets" --label COMMERCE_ASSETS_POST_COMMIT
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/voice-reference-audio" --actual-root "$RESTORE_ROOT/voice/reference-audio" --label VOICE_REFERENCE_AUDIO_POST_COMMIT
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/uploads" --actual-root "$RESTORE_ROOT/uploads" --label UPLOADS_POST_COMMIT
node "$HELPER" compare-tree --expected-root "$EXTRACTED/files/public-assets" --actual-root "$RESTORE_ROOT/public-assets" --label PUBLIC_ASSETS_POST_COMMIT

PHASE="post-restore-package-hash"
FINAL_PACKAGE_SHA="$(sha256sum "$RESTORE_PACKAGE" | awk '{print $1}')"
[[ "${FINAL_PACKAGE_SHA,,}" = "${ACTUAL_SHA,,}" && "${FINAL_PACKAGE_SHA,,}" = "${RESTORE_EXPECTED_PACKAGE_SHA256,,}" ]] || die "POST_RESTORE_PACKAGE_SHA256_MISMATCH"

PHASE="write-receipt"
END_EPOCH="$(date +%s)"
node "$HELPER" write-restore-success-receipt --output "$SUCCESS_RECEIPT" --restore-id "$RESTORE_ID" --phase complete --target-database "$TARGET_DATABASE" --started-epoch "$START_EPOCH" --completed-epoch "$END_EPOCH" --package-sha256 "$FINAL_PACKAGE_SHA" --metadata "$EXTRACTED/metadata/package.json" --before-identity "$WORK_ROOT/identity-before-report.json" --after-identity "$WORK_ROOT/identity-after-report.json" --isolated-file-root "$RESTORE_ROOT"
node "$HELPER" validate-receipt --kind restore --document "$SUCCESS_RECEIPT"
trap - ERR
ERROR_RECEIPT_ARMED=0
printf 'RESTORE_COMPLETE:%s\n' "$SUCCESS_RECEIPT"
