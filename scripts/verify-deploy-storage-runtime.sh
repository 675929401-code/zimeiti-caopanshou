#!/usr/bin/env bash
set -Eeuo pipefail

# Startup-time, fail-closed proof that production storage is the dedicated
# /data volume. This file is intentionally self-contained so it can be
# installed on the system disk and run before PM2 touches anything on /data.
umask 077

fail() {
  printf '[storage-readiness] FATAL: %s\n' "$*" >&2
  exit 1
}

TEST_ONLY="${ZIMEITI_STORAGE_GUARD_TEST_ONLY:-0}"
if [[ "$TEST_ONLY" == "1" ]]; then
  TEST_ROOT="${ZIMEITI_STORAGE_GUARD_TEST_ROOT:?test mode requires ZIMEITI_STORAGE_GUARD_TEST_ROOT}"
  [[ "$TEST_ROOT" == /* && "$TEST_ROOT" != "/" && "$TEST_ROOT" != "/data" && "$TEST_ROOT" != "/etc" && "$TEST_ROOT" != "/run" ]] \
    || fail "unsafe test root"
  DATA_ROOT="$TEST_ROOT/data"
  WEB_ROOT="$DATA_ROOT/web"
  CONFIG_PATH="$TEST_ROOT/etc/zimeiti/deploy-storage.conf"
  FSTAB_PATH="$TEST_ROOT/etc/fstab"
  BOOT_ID_PATH="$TEST_ROOT/proc/sys/kernel/random/boot_id"
  RUNTIME_DIR="$TEST_ROOT/run/zimeiti"
else
  [[ "${EUID:-$(id -u)}" == "0" ]] || fail "must run as root"
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
  DATA_ROOT=/data
  WEB_ROOT=/data/web
  CONFIG_PATH=/etc/zimeiti/deploy-storage.conf
  FSTAB_PATH=/etc/fstab
  BOOT_ID_PATH=/proc/sys/kernel/random/boot_id
  RUNTIME_DIR=/run/zimeiti
fi
RECEIPT_PATH="$RUNTIME_DIR/storage-readiness.json"
MARKER_PATH="$DATA_ROOT/.zimeiti-storage-root"

for command_name in awk cat chmod chown date df findmnt install mktemp mountpoint mv readlink rm sha256sum stat sync; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command missing: $command_name"
done

require_uint() {
  local label="$1" value="$2" floor="$3"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$label must be an unsigned integer"
  ((${#value} <= 16)) || fail "$label exceeds the JSON-safe integer range"
  ((value >= floor && value <= 9007199254740991)) || fail "$label is below its floor or exceeds the JSON-safe integer range"
}

mode_json() {
  local mode="$1"
  if ((${#mode} == 3)); then printf '0%s' "$mode"; else printf '%s' "$mode"; fi
}

file_metadata() {
  stat -c '%u %g %a %F' -- "$1" 2>/dev/null || fail "cannot stat $2: $1"
}

require_root_file() {
  local path="$1" label="$2" policy="$3" metadata uid gid mode kind
  [[ -e "$path" && ! -L "$path" && -f "$path" ]] || fail "$label must be a non-symlink regular file: $path"
  metadata=$(file_metadata "$path" "$label")
  read -r uid gid mode kind <<< "$metadata"
  [[ "$uid" == "0" && "$gid" == "0" && "$kind" == "regular file" ]] || fail "$label must be root:root regular file: $path"
  [[ "$mode" =~ ^0?[0-7]{3}$ ]] || fail "$label mode is invalid or contains special bits: $path"
  case "$policy" in
    exact-600) [[ "$mode" == "600" || "$mode" == "0600" ]] || fail "$label must use mode 0600: $path" ;;
    no-write) (( (8#$mode & 8#022) == 0 )) || fail "$label must not be group/other writable: $path" ;;
    *) fail "internal file mode policy error" ;;
  esac
  REQUIRED_FILE_MODE="$mode"
}

require_root_directory() {
  local path="$1" label="$2" policy="$3" metadata uid gid mode kind
  [[ -d "$path" && ! -L "$path" ]] || fail "$label must be a non-symlink directory: $path"
  metadata=$(file_metadata "$path" "$label")
  read -r uid gid mode kind <<< "$metadata"
  [[ "$uid" == "0" && "$gid" == "0" && "$kind" == "directory" ]] || fail "$label must be a root:root directory: $path"
  [[ "$mode" =~ ^0?[0-7]{3}$ ]] || fail "$label mode is invalid or contains special bits: $path"
  case "$policy" in
    exact-700) [[ "$mode" == "700" || "$mode" == "0700" ]] || fail "$label must use mode 0700: $path" ;;
    no-write) (( (8#$mode & 8#022) == 0 )) || fail "$label must not be group/other writable: $path" ;;
    *) fail "internal directory mode policy error" ;;
  esac
  REQUIRED_DIRECTORY_MODE="$mode"
}

findmnt_value() {
  local field="$1" target="$2" value
  value=$(findmnt -n -o "$field" --target "$target" 2>/dev/null) || fail "findmnt failed for $field on $target"
  [[ "$value" != *$'\n'* ]] || fail "findmnt returned zero or multiple $field values for $target"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [[ -n "$value" ]] || fail "findmnt returned zero or multiple $field values for $target"
  printf '%s' "$value"
}

load_contract() {
  local raw key value
  declare -A seen=()
  DATA_MOUNT_SOURCE=""
  DATA_MOUNT_UUID=""
  DATA_MARKER_SHA256=""
  MIN_AVAILABLE_BYTES=""
  MIN_AVAILABLE_INODES=""
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    raw="${raw%$'\r'}"
    [[ -z "$raw" || "$raw" == \#* ]] && continue
    [[ "$raw" =~ ^([A-Z_][A-Z0-9_]*)=([^[:space:]]+)$ ]] || fail "invalid storage contract line"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ -z "${seen[$key]:-}" ]] || fail "duplicate storage contract key: $key"
    seen[$key]=1
    case "$key" in
      DATA_MOUNT_SOURCE) DATA_MOUNT_SOURCE="$value" ;;
      DATA_MOUNT_UUID) DATA_MOUNT_UUID="$value" ;;
      DATA_MARKER_SHA256) DATA_MARKER_SHA256="$value" ;;
      MIN_AVAILABLE_BYTES) MIN_AVAILABLE_BYTES="$value" ;;
      MIN_AVAILABLE_INODES) MIN_AVAILABLE_INODES="$value" ;;
      *) fail "unsupported storage contract key: $key" ;;
    esac
  done < "$CONFIG_PATH"
  ((${#seen[@]} == 5)) || fail "storage contract must contain exactly five keys"
  [[ "$DATA_MOUNT_SOURCE" =~ ^/dev/[A-Za-z0-9._/+:-]+$ ]] || fail "invalid DATA_MOUNT_SOURCE"
  [[ "$DATA_MOUNT_UUID" =~ ^[A-Za-z0-9._:-]{4,128}$ ]] || fail "invalid DATA_MOUNT_UUID"
  [[ "$DATA_MARKER_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "invalid DATA_MARKER_SHA256"
  require_uint MIN_AVAILABLE_BYTES "$MIN_AVAILABLE_BYTES" 5368709120
  require_uint MIN_AVAILABLE_INODES "$MIN_AVAILABLE_INODES" 50000
}

require_root_file "$CONFIG_PATH" "storage contract" exact-600
CONFIG_MODE=$(mode_json "$REQUIRED_FILE_MODE")
CONFIG_SHA256=$(sha256sum -- "$CONFIG_PATH" | awk 'NR == 1 {print $1}')
[[ "$CONFIG_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "cannot hash storage contract"
load_contract

mountpoint -q -- "$DATA_ROOT" || fail "$DATA_ROOT is not a mountpoint"
[[ "$(readlink -f -- "$DATA_ROOT")" == "$DATA_ROOT" ]] || fail "$DATA_ROOT must not be a symlink or redirected path"
require_root_directory "$DATA_ROOT" "data root" no-write
DATA_ROOT_MODE=$(mode_json "$REQUIRED_DIRECTORY_MODE")

ROOT_TARGET=$(findmnt_value TARGET /)
DATA_TARGET=$(findmnt_value TARGET "$DATA_ROOT")
ROOT_DEVICE=$(findmnt_value 'MAJ:MIN' /)
DATA_DEVICE=$(findmnt_value 'MAJ:MIN' "$DATA_ROOT")
ROOT_SOURCE=$(findmnt_value SOURCE /)
DATA_SOURCE=$(findmnt_value SOURCE "$DATA_ROOT")
DATA_UUID=$(findmnt_value UUID "$DATA_ROOT")
DATA_FSTYPE=$(findmnt_value FSTYPE "$DATA_ROOT")

[[ "$ROOT_TARGET" == "/" ]] || fail "system root mount target is not /"
[[ "$DATA_TARGET" == "$DATA_ROOT" ]] || fail "data mount target mismatch"
[[ "$ROOT_DEVICE" =~ ^[0-9]+:[0-9]+$ && "$DATA_DEVICE" =~ ^[0-9]+:[0-9]+$ ]] || fail "invalid mount device identity"
[[ "$ROOT_SOURCE" =~ ^[A-Za-z0-9._/+:-]+$ ]] || fail "unsafe system root source identity"
[[ "$ROOT_TARGET" != "$DATA_TARGET" ]] || fail "system and data mount targets are identical"
[[ "$ROOT_DEVICE" != "$DATA_DEVICE" ]] || fail "$DATA_ROOT fell back to the system root device"
[[ "$ROOT_SOURCE" != "$DATA_SOURCE" ]] || fail "$DATA_ROOT fell back to the system root source"
[[ "$DATA_SOURCE" == "$DATA_MOUNT_SOURCE" ]] || fail "data mount source mismatch"
[[ "$DATA_UUID" == "$DATA_MOUNT_UUID" ]] || fail "data mount UUID mismatch"
case "$DATA_FSTYPE" in ext4|xfs) ;; *) fail "data filesystem must be ext4 or xfs" ;; esac

require_root_file "$FSTAB_PATH" "fstab" no-write
FSTAB_MODE=$(mode_json "$REQUIRED_FILE_MODE")
FSTAB_ROWS=$(findmnt --fstab -n -o SOURCE,FSTYPE,TARGET --target "$DATA_ROOT" 2>/dev/null) || fail "cannot read persistent data mount from fstab"
FSTAB_ROW_COUNT=$(printf '%s\n' "$FSTAB_ROWS" | awk 'NF { count++ } END { print count + 0 }')
[[ "$FSTAB_ROW_COUNT" == "1" ]] || fail "fstab must contain exactly one matching data mount"
read -r FSTAB_SOURCE FSTAB_FSTYPE FSTAB_TARGET <<< "$FSTAB_ROWS"
case "$FSTAB_SOURCE" in
  "UUID=$DATA_MOUNT_UUID"|"/dev/disk/by-uuid/$DATA_MOUNT_UUID") ;;
  *) fail "fstab data source is not bound to the expected UUID" ;;
esac
[[ "$FSTAB_TARGET" == "$DATA_ROOT" ]] || fail "fstab data target mismatch"
[[ "$FSTAB_FSTYPE" == "$DATA_FSTYPE" ]] || fail "live and persistent filesystem types differ"

require_root_directory "$WEB_ROOT" "web root" no-write
WEB_ROOT_MODE=$(mode_json "$REQUIRED_DIRECTORY_MODE")
[[ "$(readlink -f -- "$WEB_ROOT")" == "$WEB_ROOT" ]] || fail "web root must not be redirected"
WEB_TARGET=$(findmnt_value TARGET "$WEB_ROOT")
WEB_DEVICE=$(findmnt_value 'MAJ:MIN' "$WEB_ROOT")
[[ "$WEB_DEVICE" =~ ^[0-9]+:[0-9]+$ ]] || fail "invalid web root device identity"
[[ "$WEB_TARGET" == "$DATA_ROOT" && "$WEB_DEVICE" == "$DATA_DEVICE" ]] || fail "web root is not on the verified data mount"

require_root_file "$MARKER_PATH" "storage marker" exact-600
MARKER_MODE=$(mode_json "$REQUIRED_FILE_MODE")
[[ "$(readlink -f -- "$MARKER_PATH")" == "$MARKER_PATH" ]] || fail "storage marker must not be redirected"
MARKER_TARGET=$(findmnt_value TARGET "$MARKER_PATH")
MARKER_DEVICE=$(findmnt_value 'MAJ:MIN' "$MARKER_PATH")
[[ "$MARKER_DEVICE" =~ ^[0-9]+:[0-9]+$ ]] || fail "invalid storage marker device identity"
[[ "$MARKER_TARGET" == "$DATA_ROOT" && "$MARKER_DEVICE" == "$DATA_DEVICE" ]] || fail "storage marker is not on the verified data mount"
MARKER_SHA256=$(sha256sum -- "$MARKER_PATH" | awk 'NR == 1 {print $1}')
[[ "$MARKER_SHA256" == "$DATA_MARKER_SHA256" ]] || fail "storage marker SHA-256 mismatch"

AVAILABLE_BYTES=$(df -B1 --output=avail "$DATA_ROOT" | awk 'NR == 2 {print $1}')
AVAILABLE_INODES=$(df --output=iavail "$DATA_ROOT" | awk 'NR == 2 {print $1}')
require_uint availableBytes "$AVAILABLE_BYTES" "$MIN_AVAILABLE_BYTES"
require_uint availableInodes "$AVAILABLE_INODES" "$MIN_AVAILABLE_INODES"

IFS= read -r BOOT_ID < "$BOOT_ID_PATH" || fail "cannot read boot_id"
[[ "$BOOT_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "invalid boot_id"

if [[ -L "$RUNTIME_DIR" ]]; then fail "runtime receipt directory must not be a symlink"; fi
if [[ ! -e "$RUNTIME_DIR" ]]; then install -d -o root -g root -m 0700 -- "$RUNTIME_DIR"; fi
require_root_directory "$RUNTIME_DIR" "runtime receipt directory" exact-700
RUNTIME_DIR_MODE=$(mode_json "$REQUIRED_DIRECTORY_MODE")
if [[ -L "$RECEIPT_PATH" ]]; then fail "storage readiness receipt must not be a symlink"; fi
if [[ -e "$RECEIPT_PATH" ]]; then require_root_file "$RECEIPT_PATH" "existing storage readiness receipt" exact-600; fi

VERIFIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
VERIFIED_EPOCH=$(date -u +%s)
require_uint verifiedEpoch "$VERIFIED_EPOCH" 1
TMP_RECEIPT=$(mktemp "$RUNTIME_DIR/.storage-readiness.json.tmp.XXXXXX") || fail "cannot allocate receipt temp file"
cleanup_temp() { [[ -z "${TMP_RECEIPT:-}" ]] || rm -f -- "$TMP_RECEIPT"; }
trap cleanup_temp EXIT INT TERM

cat > "$TMP_RECEIPT" <<EOF
{
  "schemaVersion": "zimeiti-storage-readiness.v1",
  "status": "ready",
  "verifiedAt": "$VERIFIED_AT",
  "verifiedEpoch": $VERIFIED_EPOCH,
  "bootId": "$BOOT_ID",
  "guard": {
    "script": "verify-deploy-storage-runtime.sh",
    "configPath": "$CONFIG_PATH",
    "configSha256": "$CONFIG_SHA256",
    "fstypeBinding": "detected-and-fstab-bound-not-config-declared"
  },
  "mount": {
    "rootTarget": "$ROOT_TARGET",
    "target": "$DATA_TARGET",
    "rootSource": "$ROOT_SOURCE",
    "source": "$DATA_SOURCE",
    "uuid": "$DATA_UUID",
    "fstype": "$DATA_FSTYPE",
    "rootMajorMinor": "$ROOT_DEVICE",
    "majorMinor": "$DATA_DEVICE",
    "fstabSource": "$FSTAB_SOURCE",
    "fstabFstype": "$FSTAB_FSTYPE",
    "fstabTarget": "$FSTAB_TARGET",
    "independent": true
  },
  "marker": {
    "path": "$MARKER_PATH",
    "sha256": "$MARKER_SHA256"
  },
  "capacity": {
    "availableBytes": $AVAILABLE_BYTES,
    "minimumAvailableBytes": $MIN_AVAILABLE_BYTES,
    "availableInodes": $AVAILABLE_INODES,
    "minimumAvailableInodes": $MIN_AVAILABLE_INODES
  },
  "paths": {
    "dataRoot": "$DATA_ROOT",
    "webRoot": "$WEB_ROOT",
    "rootAndDataTargetsDistinct": true,
    "rootAndDataDevicesDistinct": true,
    "rootAndDataSourcesDistinct": true,
    "webRootOnDataDevice": true
  },
  "security": {
    "configRootOwned": true,
    "configMode": "$CONFIG_MODE",
    "fstabRootOwned": true,
    "fstabMode": "$FSTAB_MODE",
    "dataRootOwned": true,
    "dataRootMode": "$DATA_ROOT_MODE",
    "webRootOwned": true,
    "webRootMode": "$WEB_ROOT_MODE",
    "markerRootOwned": true,
    "markerMode": "$MARKER_MODE",
    "runtimeDirectoryRootOwned": true,
    "runtimeDirectoryMode": "$RUNTIME_DIR_MODE",
    "symlinksRejected": true
  },
  "receipt": {
    "path": "$RECEIPT_PATH",
    "ownerUid": 0,
    "ownerGid": 0,
    "mode": "0600",
    "atomicWrite": true
  }
}
EOF
chmod 0600 -- "$TMP_RECEIPT"
chown 0:0 -- "$TMP_RECEIPT"
sync -f "$TMP_RECEIPT"
mv -fT -- "$TMP_RECEIPT" "$RECEIPT_PATH"
TMP_RECEIPT=""
sync -f "$RUNTIME_DIR"
require_root_file "$RECEIPT_PATH" "storage readiness receipt" exact-600
trap - EXIT INT TERM

printf '[storage-readiness] READY boot_id=%s mount=%s source=%s uuid=%s fstype=%s receipt=%s\n' \
  "$BOOT_ID" "$DATA_TARGET" "$DATA_SOURCE" "$DATA_UUID" "$DATA_FSTYPE" "$RECEIPT_PATH"
