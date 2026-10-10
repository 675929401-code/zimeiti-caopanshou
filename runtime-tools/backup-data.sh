#!/usr/bin/env bash
# Linux-only encrypted backup control plane. It never claims a cross-component snapshot.

set -Eeuo pipefail
umask 077

MODE="${1:---plan}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HELPER="$PROJECT_ROOT/scripts/backup-recovery-helper.mjs"
PLAIN_STAGE_NAME="zimeiti-backup-plaintext-staging"

die() { printf 'BACKUP_BLOCKED:%s\n' "$1" >&2; exit "${2:-2}"; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "COMMAND_REQUIRED:$1"; }
require_absolute_dir() {
  local name="$1" value="${!1:-}"
  [[ "$value" = /* ]] || die "ABSOLUTE_DIRECTORY_REQUIRED:$name"
  [[ ! "$value" =~ [[:cntrl:]] ]] || die "CONTROL_CHARACTER_IN_PATH:$name"
  [[ ! -L "$value" ]] || die "SYMLINK_NOT_ALLOWED:$name"
  [[ -d "$value" ]] || die "DIRECTORY_NOT_FOUND:$name"
}
require_absolute_file() {
  local name="$1" value="${!1:-}"
  [[ "$value" = /* ]] || die "ABSOLUTE_FILE_REQUIRED:$name"
  [[ ! "$value" =~ [[:cntrl:]] ]] || die "CONTROL_CHARACTER_IN_PATH:$name"
  [[ ! -L "$value" ]] || die "SYMLINK_NOT_ALLOWED:$name"
  [[ -f "$value" ]] || die "FILE_NOT_FOUND:$name"
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
validate_plaintext_staging_mount() {
  local mount_name="$1" mount_path="${!1:-}" filesystem source block_type root_dev mount_dev
  require_absolute_dir "$mount_name"
  mountpoint -q "$mount_path" || die "PLAINTEXT_STAGING_MOUNT_REQUIRED:$mount_name"
  filesystem="$(findmnt -n -o FSTYPE -T "$mount_path")"
  if [[ "$filesystem" != "tmpfs" ]]; then
    source="$(findmnt -n -o SOURCE -T "$mount_path")"
    source="${source%%\[*}"
    [[ "$source" = /dev/* ]] || die "PLAINTEXT_STAGING_MUST_BE_TMPFS_OR_DMCRYPT:$mount_name"
    block_type="$(lsblk -ndo TYPE "$source" 2>/dev/null | head -n 1)"
    [[ "$block_type" = "crypt" ]] || die "PLAINTEXT_STAGING_MUST_BE_TMPFS_OR_DMCRYPT:$mount_name"
  fi
  root_dev="$(device_number /)"
  mount_dev="$(device_number "$mount_path")"
  [[ -n "$mount_dev" && "$mount_dev" != "$root_dev" ]] || die "PLAINTEXT_STAGING_MUST_NOT_USE_SYSTEM_DEVICE:$mount_name"
  node "$HELPER" assert-path-absent --path "$mount_path/$PLAIN_STAGE_NAME" || die "PLAINTEXT_STAGING_RESIDUE_REQUIRES_MANUAL_REVIEW:$mount_name"
}

print_usage() {
  cat <<'USAGE'
Usage: bash runtime-tools/backup-data.sh --plan|--preflight|--execute

Required controlled inputs:
  DEPLOY_DATABASE_URL, PERSISTENT_DATA_MOUNTPOINT, BACKUP_DIR
  BACKUP_PLAINTEXT_STAGING_MOUNTPOINT, BACKUP_AGE_RECIPIENTS_FILE
  APP_DATA_DIR, COMMERCE_DATA_DIR, VOICE_SQLITE_PATH
  VOICE_REFERENCE_AUDIO_DIR, STORAGE_LOCAL_BASE_PATH, PUBLIC_ASSET_ROOT

The plaintext staging mount must be a dedicated tmpfs or verified dm-crypt
block-device mount. Any residue from a killed run blocks the next run.
USAGE
}

validate_configuration() {
  [[ "$(uname -s)" = "Linux" ]] || die "LINUX_ONLY"
  [[ -f "$HELPER" ]] || die "HELPER_NOT_FOUND"
  [[ -n "${DEPLOY_DATABASE_URL:-}" ]] || die "DEPLOY_DATABASE_URL_REQUIRED"
  require_absolute_dir PERSISTENT_DATA_MOUNTPOINT
  require_absolute_dir BACKUP_DIR
  require_controlled_secret_file BACKUP_AGE_RECIPIENTS_FILE
  require_absolute_dir APP_DATA_DIR
  require_absolute_dir COMMERCE_DATA_DIR
  require_absolute_file VOICE_SQLITE_PATH
  require_absolute_dir VOICE_REFERENCE_AUDIO_DIR
  require_absolute_dir STORAGE_LOCAL_BASE_PATH
  require_absolute_dir PUBLIC_ASSET_ROOT
  [[ ! -L "$COMMERCE_DATA_DIR/commerce.sqlite" && -f "$COMMERCE_DATA_DIR/commerce.sqlite" ]] || die "COMMERCE_SQLITE_REQUIRED"
  [[ ! -L "$COMMERCE_DATA_DIR/assets" && -d "$COMMERCE_DATA_DIR/assets" ]] || die "COMMERCE_ASSETS_REQUIRED"
  grep -Eq '^[[:space:]]*(age1|ssh-(rsa|ed25519)|plugin:)' "$BACKUP_AGE_RECIPIENTS_FILE" || die "AGE_RECIPIENT_REQUIRED"
  mountpoint -q "$PERSISTENT_DATA_MOUNTPOINT" || die "PERSISTENT_DATA_MOUNTPOINT_NOT_MOUNTED"

  local system_dev expected_dev data_root backup_root source source_root source_dev
  system_dev="$(device_number /)"
  expected_dev="$(device_number "$PERSISTENT_DATA_MOUNTPOINT")"
  [[ -n "$system_dev" && -n "$expected_dev" && "$system_dev" != "$expected_dev" ]] || die "PERSISTENT_DATA_MUST_NOT_USE_SYSTEM_DEVICE"
  data_root="$(realpath -e "$PERSISTENT_DATA_MOUNTPOINT")"
  backup_root="$(realpath -e "$BACKUP_DIR")"
  is_inside_or_equal "$data_root" "$backup_root" || die "BACKUP_DIR_OUTSIDE_PERSISTENT_MOUNT"
  [[ "$(device_number "$backup_root")" = "$expected_dev" ]] || die "BACKUP_DIR_UNEXPECTED_DEVICE"

  for source in "$APP_DATA_DIR" "$COMMERCE_DATA_DIR" "$VOICE_SQLITE_PATH" "$VOICE_REFERENCE_AUDIO_DIR" "$STORAGE_LOCAL_BASE_PATH" "$PUBLIC_ASSET_ROOT"; do
    source_root="$(realpath -e "$source")"
    is_inside_or_equal "$data_root" "$source_root" || die "SOURCE_DATA_OUTSIDE_PERSISTENT_MOUNT"
    source_dev="$(device_number "$source_root")"
    [[ "$source_dev" = "$expected_dev" ]] || die "SOURCE_DATA_UNEXPECTED_DEVICE"
    require_disjoint "$backup_root" "$source_root" "backup-source"
  done

  validate_plaintext_staging_mount BACKUP_PLAINTEXT_STAGING_MOUNTPOINT
  local staging_root staging_dev
  staging_root="$(realpath -e "$BACKUP_PLAINTEXT_STAGING_MOUNTPOINT")"
  staging_dev="$(device_number "$staging_root")"
  [[ "$staging_dev" != "$expected_dev" ]] || die "PLAINTEXT_STAGING_MUST_USE_DEDICATED_DEVICE"
  require_disjoint "$staging_root" "$backup_root" "staging-backup"
  for source in "$APP_DATA_DIR" "$COMMERCE_DATA_DIR" "$VOICE_SQLITE_PATH" "$VOICE_REFERENCE_AUDIO_DIR" "$STORAGE_LOCAL_BASE_PATH" "$PUBLIC_ASSET_ROOT"; do
    require_disjoint "$staging_root" "$source" "staging-source"
  done
}

validate_tools() {
  for tool in age pg_dump pg_dumpall pg_restore psql node tar sha256sum realpath mountpoint findmnt stat id lsblk uname; do
    require_command "$tool"
  done
}

emit_plan() {
  cat <<'EOF'
{
  "schemaVersion": "zimeiti-backup-plan.v2",
  "platform": "linux-only",
  "mode": "encrypted-component-snapshots",
  "componentSnapshotCount": 8,
  "sharedSnapshot": false,
  "productionConsistency": "incomplete",
  "plaintextStaging": "dedicated-tmpfs-or-verified-dmcrypt",
  "plaintextFinalPackageAllowed": false,
  "atomicEncryptedCommit": true
}
EOF
}

case "$MODE" in
  -h|--help) print_usage; exit 0 ;;
  --plan) emit_plan; exit 0 ;;
  --preflight) validate_tools; validate_configuration; printf 'BACKUP_PREFLIGHT_OK\n'; exit 0 ;;
  --execute) ;;
  *) print_usage >&2; die "MODE_INVALID:$MODE" ;;
esac

validate_tools
validate_configuration
[[ -w "$BACKUP_DIR" ]] || die "BACKUP_DIRECTORY_NOT_WRITABLE"

START_EPOCH="$(date +%s)"
BACKUP_ID="backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"
PLAIN_WORK_ROOT="$BACKUP_PLAINTEXT_STAGING_MOUNTPOINT/$PLAIN_STAGE_NAME"
STAGING="$PLAIN_WORK_ROOT/payload"
PLAIN_ARCHIVE="$PLAIN_WORK_ROOT/package.tar.gz"
COMPLETE_STAGING="$BACKUP_DIR/.${BACKUP_ID}.commit"
ENCRYPTED_PARTIAL="$COMPLETE_STAGING/package.tar.gz.age.partial"
FINAL_PACKAGE="$COMPLETE_STAGING/package.tar.gz.age"
FINAL_RECEIPT="$COMPLETE_STAGING/receipt.json"
FINAL_DIR="$BACKUP_DIR/$BACKUP_ID"

cleanup() {
  case "$PLAIN_WORK_ROOT" in
    "$BACKUP_PLAINTEXT_STAGING_MOUNTPOINT/$PLAIN_STAGE_NAME") rm -rf -- "$PLAIN_WORK_ROOT" ;;
    *) printf 'BACKUP_PLAINTEXT_CLEANUP_REFUSED\n' >&2 ;;
  esac
  case "$COMPLETE_STAGING" in
    "$BACKUP_DIR"/.backup-*.commit) rm -rf -- "$COMPLETE_STAGING" ;;
    *) printf 'BACKUP_COMMIT_CLEANUP_REFUSED\n' >&2 ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$PLAIN_WORK_ROOT" "$STAGING" "$COMPLETE_STAGING"
[[ "$(device_number "$PLAIN_WORK_ROOT")" = "$(device_number "$BACKUP_PLAINTEXT_STAGING_MOUNTPOINT")" ]] || die "PLAINTEXT_WORKSPACE_UNEXPECTED_DEVICE"
[[ "$(device_number "$COMPLETE_STAGING")" = "$(device_number "$BACKUP_DIR")" ]] || die "ENCRYPTED_COMMIT_UNEXPECTED_DEVICE"
mkdir "$STAGING/postgres" "$STAGING/sqlite" "$STAGING/files" "$STAGING/audits" "$STAGING/metadata"

node "$PROJECT_ROOT/scripts/backup-postgres-consistent.mjs" --output-root "$STAGING"
node "$HELPER" sqlite-backup --source "$COMMERCE_DATA_DIR/commerce.sqlite" --destination "$STAGING/sqlite/commerce.sqlite" --report "$STAGING/audits/commerce-sqlite.json" --label commerce-sqlite
node "$HELPER" sqlite-backup --source "$VOICE_SQLITE_PATH" --destination "$STAGING/sqlite/voice.sqlite" --report "$STAGING/audits/voice-sqlite.json" --label voice-sqlite

node "$HELPER" stable-copy-tree --source "$APP_DATA_DIR" --destination "$STAGING/files/app-data" --report "$STAGING/audits/app-data-tree.json" --label app-data
node "$HELPER" stable-copy-tree --source "$COMMERCE_DATA_DIR/assets" --destination "$STAGING/files/commerce-assets" --report "$STAGING/audits/commerce-assets-tree.json" --label commerce-assets
node "$HELPER" stable-copy-tree --source "$VOICE_REFERENCE_AUDIO_DIR" --destination "$STAGING/files/voice-reference-audio" --report "$STAGING/audits/voice-reference-audio-tree.json" --label voice-reference-audio
node "$HELPER" stable-copy-tree --source "$STORAGE_LOCAL_BASE_PATH" --destination "$STAGING/files/uploads" --report "$STAGING/audits/uploads-tree.json" --label uploads
node "$HELPER" stable-copy-tree --source "$PUBLIC_ASSET_ROOT" --destination "$STAGING/files/public-assets" --report "$STAGING/audits/public-assets-tree.json" --label public-assets

SOURCE_VERSION="unknown"
if [[ -f "$PROJECT_ROOT/public/version.json" ]]; then
  cp "$PROJECT_ROOT/public/version.json" "$STAGING/metadata/source-version.json"
  SOURCE_VERSION="$(node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).sourceVersion||"unknown";if(!/^[A-Za-z0-9._-]+$/.test(v))process.exit(2);process.stdout.write(v)' "$PROJECT_ROOT/public/version.json")"
fi

node "$HELPER" write-backup-metadata --output "$STAGING/metadata/package.json" --backup-id "$BACKUP_ID" --source-version "$SOURCE_VERSION" --created-epoch "$START_EPOCH" \
  --component-report "$STAGING/audits/postgres-component-snapshot.json" \
  --component-report "$STAGING/audits/commerce-sqlite.json" \
  --component-report "$STAGING/audits/voice-sqlite.json" \
  --component-report "$STAGING/audits/app-data-tree.json" \
  --component-report "$STAGING/audits/commerce-assets-tree.json" \
  --component-report "$STAGING/audits/voice-reference-audio-tree.json" \
  --component-report "$STAGING/audits/uploads-tree.json" \
  --component-report "$STAGING/audits/public-assets-tree.json"
node "$HELPER" build-manifest --root "$STAGING" --metadata "$STAGING/metadata/package.json" --output "$STAGING/manifest.json"
node "$HELPER" verify-manifest --root "$STAGING" --manifest "$STAGING/manifest.json"

tar --format=posix --numeric-owner --owner=0 --group=0 -C "$STAGING" -czf "$PLAIN_ARCHIVE" .
age -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$ENCRYPTED_PARTIAL" "$PLAIN_ARCHIVE"
[[ -s "$ENCRYPTED_PARTIAL" ]] || die "ENCRYPTED_PACKAGE_EMPTY"
node "$HELPER" verify-manifest --root "$STAGING" --manifest "$STAGING/manifest.json"
mv -n "$ENCRYPTED_PARTIAL" "$FINAL_PACKAGE" || die "FINAL_PACKAGE_COMMIT_FAILED"
END_EPOCH="$(date +%s)"
node "$HELPER" write-backup-receipt --output "$FINAL_RECEIPT" --metadata "$STAGING/metadata/package.json" --encrypted-package "$FINAL_PACKAGE" --manifest "$STAGING/manifest.json" --completed-epoch "$END_EPOCH"
node "$HELPER" validate-receipt --kind backup --document "$FINAL_RECEIPT"
rm -f -- "$PLAIN_ARCHIVE"
mv -n "$COMPLETE_STAGING" "$FINAL_DIR" || die "BACKUP_DIRECTORY_COMMIT_FAILED"
[[ -f "$FINAL_DIR/package.tar.gz.age" && -f "$FINAL_DIR/receipt.json" ]] || die "BACKUP_DIRECTORY_COMMIT_INCOMPLETE"
printf 'BACKUP_COMPLETE:%s\n' "$FINAL_DIR/receipt.json"
