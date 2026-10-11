#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PROJECT_ID="zimeiti-caopanshou"
CANDIDATE_USER="zimeiti-candidate"
CANDIDATE_HOME="/nonexistent"
CANDIDATE_SHELL="/usr/sbin/nologin"

DATA_ROOT="/data"
WEB_ROOT="/data/web"
MARKER_PATH="/data/.zimeiti-storage-root"
CONFIG_DIR="/etc/zimeiti"
CONFIG_PATH="/etc/zimeiti/deploy-storage.conf"
GUARD_DIR="/usr/local/libexec/zimeiti"
GUARD_TARGET="/usr/local/libexec/zimeiti/verify-deploy-storage-runtime.sh"
FIXTURE_TARGET="/usr/local/libexec/zimeiti/prepare-candidate-readiness-fixtures.py"
DROPIN_DIR="/etc/systemd/system/pm2-root.service.d"
DROPIN_TARGET="/etc/systemd/system/pm2-root.service.d/20-zimeiti-data-mount.conf"
RECEIPT_PATH="/run/zimeiti/storage-readiness.json"
LOCK_PATH="/run/zimeiti-runtime-safety-provision.lock"

GUARD_SHA256="5acc4a75929668b9aa77b0ec965b983708a23079e35347fb67527346ee8ce400"
FIXTURE_SHA256="ea62e6aa0676b26514491109fe13e950799585f51d41398b82817f83a860c3c6"
DROPIN_SHA256="7aa7ef2694091b5ea4a1c457844c9cf447357c18620880e9282e5654104c2b04"
MIN_AVAILABLE_BYTES="21474836480"
MIN_AVAILABLE_INODES="200000"

usage() {
  cat <<'USAGE'
Usage:
  sudo bash scripts/provision-production-runtime-safety.sh --plan \
    --operation-id <operation-id>

  sudo env RUNTIME_SAFETY_EXECUTION_APPROVED=<operation-id> \
    bash scripts/provision-production-runtime-safety.sh --execute \
    --operation-id <operation-id>

--plan is strictly read-only. It validates the real /data mount, the reviewed
control-plane sources, the existing candidate identity, and every existing
managed target. It does not create a lock, account, directory, file, receipt,
or systemd manager change.

--execute is idempotent and fail-closed. The approval environment value must
exactly equal the --operation-id value. It only provisions the dedicated
candidate account, storage identity contract, reviewed startup guard, pinned
candidate-fixture helper, and pm2-root.service drop-in; then it runs systemctl
daemon-reload, the guard, and the fixture helper's zero-cost self-test.

This script never restarts or reloads PM2, deploys code, touches Git, changes a
database, or reads/writes application business data.
USAGE
}

die() {
  printf 'BLOCKED: %s\n' "$*" >&2
  exit 2
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

MODE=""
OPERATION_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      [[ -z "$MODE" ]] || die "exactly one --plan or --execute flag is allowed"
      MODE="plan"
      shift
      ;;
    --execute)
      [[ -z "$MODE" ]] || die "exactly one --plan or --execute flag is allowed"
      MODE="execute"
      shift
      ;;
    --operation-id)
      [[ -z "$OPERATION_ID" ]] || die "--operation-id may be provided only once"
      [[ $# -ge 2 && -n "${2:-}" ]] || die "--operation-id requires a value"
      OPERATION_ID="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$MODE" == "plan" || "$MODE" == "execute" ]] || die "exactly one of --plan or --execute is required"
[[ "$OPERATION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ ]] || \
  die "--operation-id must be 8-128 safe audit characters"
[[ "${EUID:-$(id -u)}" == "0" ]] || die "$MODE requires EUID=0; non-root provisioning is forbidden"

PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

for command_name in awk cat chmod chown cmp date df dirname env findmnt flock getent grep id install ln mkdir mktemp mountpoint mv node passwd python3 readlink rm sha256sum stat sync systemctl tr useradd; do
  require_command "$command_name"
done
MV_VERSION="$(mv --version 2>/dev/null)" || die "cannot identify the installed mv implementation"
[[ "$MV_VERSION" == *'GNU coreutils'* ]] || die "GNU coreutils are required for atomic -T installation and strict metadata checks"

SCRIPT_INPUT="$(readlink -m -- "$0")" || die "cannot normalize the provisioner path"
SCRIPT_PATH="$(readlink -f -- "$0")" || die "cannot resolve the provisioner path"
[[ "$SCRIPT_INPUT" == "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] || \
  die "provisioner path or one of its parent components is redirected by a symlink"
SCRIPT_DIR="$(dirname -- "$SCRIPT_PATH")"
CONTROL_ROOT="$(dirname -- "$SCRIPT_DIR")"
GUARD_SOURCE="$CONTROL_ROOT/scripts/verify-deploy-storage-runtime.sh"
FIXTURE_SOURCE="$CONTROL_ROOT/scripts/prepare-candidate-readiness-fixtures.py"
DROPIN_SOURCE="$CONTROL_ROOT/deploy/systemd/pm2-root.service.d/20-zimeiti-data-mount.conf.example"

mode_has_forbidden_write_or_special_bits() {
  local mode="$1"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 0
  (( (8#$mode & 8#7022) != 0 ))
}

require_root_directory() {
  local path="$1" label="$2" metadata uid gid mode kind
  [[ -d "$path" && ! -L "$path" ]] || die "$label must be a real non-symlink directory: $path"
  metadata="$(stat -c '%u:%g:%a:%F' -- "$path" 2>/dev/null)" || die "cannot stat $label: $path"
  IFS=: read -r uid gid mode kind <<<"$metadata"
  [[ "$uid" == "0" && "$gid" == "0" && "$kind" == "directory" ]] || \
    die "$label must be a root:root directory: $path"
  ! mode_has_forbidden_write_or_special_bits "$mode" || \
    die "$label has group/other write or special permission bits: $path mode=$mode"
  [[ "$(readlink -f -- "$path")" == "$path" ]] || die "$label is not canonical: $path"
}

require_root_file() {
  local path="$1" label="$2" expected_mode="${3:-}" metadata uid gid mode links kind
  [[ -f "$path" && ! -L "$path" ]] || die "$label must be a real non-symlink regular file: $path"
  metadata="$(stat -c '%u:%g:%a:%h:%F' -- "$path" 2>/dev/null)" || die "cannot stat $label: $path"
  IFS=: read -r uid gid mode links kind <<<"$metadata"
  [[ "$uid" == "0" && "$gid" == "0" && "$kind" == "regular file" && "$links" == "1" ]] || \
    die "$label must be a single-link root:root regular file: $path"
  ! mode_has_forbidden_write_or_special_bits "$mode" || \
    die "$label has group/other write or special permission bits: $path mode=$mode"
  if [[ -n "$expected_mode" ]]; then
    [[ "$mode" == "$expected_mode" ]] || die "$label must use mode 0$expected_mode: $path (actual $mode)"
  fi
  [[ "$(readlink -f -- "$path")" == "$path" ]] || die "$label is not canonical: $path"
}

assert_secure_existing_chain() {
  local target="$1" label="$2" relative component current=""
  [[ "$target" == /* && "$target" != *'//' && "$target" != */../* && "$target" != */./* ]] || \
    die "$label is not a normalized absolute path: $target"
  require_root_directory / "system root"
  relative="${target#/}"
  local -a components=()
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="$current/$component"
    if [[ -e "$current" || -L "$current" ]]; then
      require_root_directory "$current" "$label path component"
    else
      break
    fi
  done
}

require_reviewed_source() {
  local path="$1" label="$2" expected_sha="$3" actual_sha
  require_root_file "$path" "$label"
  actual_sha="$(sha256sum -- "$path" | awk 'NR == 1 {print $1}')"
  [[ "$actual_sha" == "$expected_sha" ]] || \
    die "$label SHA-256 mismatch: expected $expected_sha, got $actual_sha"
}

assert_secure_existing_chain "$CONTROL_ROOT" "control-plane root"
require_root_file "$SCRIPT_PATH" "runtime-safety provisioner"
require_reviewed_source "$GUARD_SOURCE" "storage startup guard source" "$GUARD_SHA256"
require_reviewed_source "$FIXTURE_SOURCE" "candidate fixture helper source" "$FIXTURE_SHA256"
require_reviewed_source "$DROPIN_SOURCE" "systemd drop-in source" "$DROPIN_SHA256"

findmnt_value() {
  local field="$1" target="$2" value
  value="$(findmnt -n -o "$field" --target "$target" 2>/dev/null)" || \
    die "findmnt failed for $field on $target"
  [[ "$value" != *$'\n'* ]] || \
    die "findmnt returned zero or multiple $field values for $target"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [[ -n "$value" ]] || \
    die "findmnt returned zero or multiple $field values for $target"
  printf '%s' "$value"
}

DATA_SOURCE=""
DATA_UUID=""
DATA_FSTYPE=""
ROOT_SOURCE=""
ROOT_DEVICE=""
DATA_DEVICE=""
AVAILABLE_BYTES=""
AVAILABLE_INODES=""
EXPECTED_MARKER_SHA256=""
EXPECTED_CONFIG_SHA256=""

marker_content() {
  printf '%s\n' \
    'schema=zimeiti-storage-root.v1' \
    'target=/data' \
    "source=$DATA_SOURCE" \
    "uuid=$DATA_UUID" \
    "fstype=$DATA_FSTYPE"
}

config_content() {
  printf '%s\n' \
    "DATA_MOUNT_SOURCE=$DATA_SOURCE" \
    "DATA_MOUNT_UUID=$DATA_UUID" \
    "DATA_MARKER_SHA256=$EXPECTED_MARKER_SHA256" \
    "MIN_AVAILABLE_BYTES=$MIN_AVAILABLE_BYTES" \
    "MIN_AVAILABLE_INODES=$MIN_AVAILABLE_INODES"
}

inspect_live_storage() {
  local root_target data_target fstab_rows fstab_count fstab_source fstab_fstype fstab_target
  mountpoint -q -- "$DATA_ROOT" || die "$DATA_ROOT is not a mountpoint"
  require_root_directory "$DATA_ROOT" "data root"
  require_root_directory "$WEB_ROOT" "web root"

  root_target="$(findmnt_value TARGET /)"
  data_target="$(findmnt_value TARGET "$DATA_ROOT")"
  ROOT_DEVICE="$(findmnt_value 'MAJ:MIN' /)"
  DATA_DEVICE="$(findmnt_value 'MAJ:MIN' "$DATA_ROOT")"
  ROOT_SOURCE="$(findmnt_value SOURCE /)"
  DATA_SOURCE="$(findmnt_value SOURCE "$DATA_ROOT")"
  DATA_UUID="$(findmnt_value UUID "$DATA_ROOT")"
  DATA_FSTYPE="$(findmnt_value FSTYPE "$DATA_ROOT")"

  [[ "$root_target" == "/" && "$data_target" == "$DATA_ROOT" ]] || die "root or data mount target mismatch"
  [[ "$ROOT_DEVICE" =~ ^[0-9]+:[0-9]+$ && "$DATA_DEVICE" =~ ^[0-9]+:[0-9]+$ ]] || \
    die "root or data mount has an invalid MAJ:MIN identity"
  [[ "$ROOT_DEVICE" != "$DATA_DEVICE" && "$ROOT_SOURCE" != "$DATA_SOURCE" ]] || \
    die "$DATA_ROOT is not independent from the system root filesystem"
  [[ "$DATA_SOURCE" =~ ^/dev/[A-Za-z0-9._/+:-]+$ ]] || die "data mount source is not a safe /dev path"
  [[ "$DATA_UUID" =~ ^[A-Za-z0-9._:-]{4,128}$ ]] || die "data mount UUID is absent or unsafe"
  case "$DATA_FSTYPE" in ext4|xfs) ;; *) die "data filesystem must be ext4 or xfs, got $DATA_FSTYPE" ;; esac

  require_root_file /etc/fstab "fstab"
  fstab_rows="$(findmnt --fstab -n -o SOURCE,FSTYPE,TARGET --target "$DATA_ROOT" 2>/dev/null)" || \
    die "cannot read the persistent /data mount from fstab"
  fstab_count="$(printf '%s\n' "$fstab_rows" | awk 'NF { count++ } END { print count + 0 }')"
  [[ "$fstab_count" == "1" ]] || die "fstab must contain exactly one matching /data mount"
  read -r fstab_source fstab_fstype fstab_target <<<"$fstab_rows"
  case "$fstab_source" in
    "UUID=$DATA_UUID"|"/dev/disk/by-uuid/$DATA_UUID") ;;
    *) die "fstab /data source is not bound to the live mount UUID" ;;
  esac
  [[ "$fstab_fstype" == "$DATA_FSTYPE" && "$fstab_target" == "$DATA_ROOT" ]] || \
    die "fstab and live /data filesystem identities differ"

  AVAILABLE_BYTES="$(df -B1 --output=avail "$DATA_ROOT" | awk 'NR == 2 {print $1}')"
  AVAILABLE_INODES="$(df -i --output=iavail "$DATA_ROOT" | awk 'NR == 2 {print $1}')"
  [[ "$AVAILABLE_BYTES" =~ ^[0-9]+$ && "$AVAILABLE_INODES" =~ ^[0-9]+$ ]] || \
    die "cannot read /data free-byte or free-inode capacity"
  (( AVAILABLE_BYTES >= MIN_AVAILABLE_BYTES )) || \
    die "/data has fewer than $MIN_AVAILABLE_BYTES available bytes"
  (( AVAILABLE_INODES >= MIN_AVAILABLE_INODES )) || \
    die "/data has fewer than $MIN_AVAILABLE_INODES available inodes"

  EXPECTED_MARKER_SHA256="$(marker_content | sha256sum | awk 'NR == 1 {print $1}')"
  [[ "$EXPECTED_MARKER_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "cannot derive marker SHA-256"
  EXPECTED_CONFIG_SHA256="$(config_content | sha256sum | awk 'NR == 1 {print $1}')"
  [[ "$EXPECTED_CONFIG_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "cannot derive config SHA-256"
}

USER_STATE=""
CANDIDATE_UID=""
CANDIDATE_PROCESS_COUNT=""
inspect_candidate_user() {
  local passwd_row group_row shadow_row name password uid gid gecos home shell
  local group_name group_password group_gid group_members shadow_password groups
  local status_path process_uid process_count=0
  if ! passwd_row="$(getent passwd "$CANDIDATE_USER")"; then
    getent group "$CANDIDATE_USER" >/dev/null 2>&1 && \
      die "candidate group exists without its exact candidate user"
    USER_STATE="MISSING"
    CANDIDATE_UID=""
    CANDIDATE_PROCESS_COUNT="0"
    return
  fi
  [[ -n "$passwd_row" && "$passwd_row" != *$'\n'* ]] || die "candidate passwd identity is ambiguous"
  IFS=: read -r name password uid gid gecos home shell <<<"$passwd_row"
  [[ "$name" == "$CANDIDATE_USER" && "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ && "$uid" != "0" ]] || \
    die "candidate user has an invalid name or root/nonnumeric identity"
  [[ "$home" == "$CANDIDATE_HOME" && "$shell" == "$CANDIDATE_SHELL" ]] || \
    die "candidate user must use home $CANDIDATE_HOME and shell $CANDIDATE_SHELL"
  [[ ! -e "$CANDIDATE_HOME" && ! -L "$CANDIDATE_HOME" ]] || \
    die "candidate no-home path unexpectedly exists: $CANDIDATE_HOME"

  group_row="$(getent group "$CANDIDATE_USER")" || die "candidate primary group is missing"
  [[ -n "$group_row" && "$group_row" != *$'\n'* ]] || die "candidate group identity is ambiguous"
  IFS=: read -r group_name group_password group_gid group_members <<<"$group_row"
  [[ "$group_name" == "$CANDIDATE_USER" && "$group_gid" == "$gid" && -z "$group_members" ]] || \
    die "candidate must have its own empty primary group"

  groups="$(id -G "$CANDIDATE_USER" | tr -s ' ' | awk '{$1=$1; print}')" || die "cannot read candidate groups"
  [[ "$groups" == "$gid" ]] || die "candidate user belongs to supplementary groups: $groups"
  [[ "$(id -u "$CANDIDATE_USER")" == "$uid" && "$(id -g "$CANDIDATE_USER")" == "$gid" ]] || \
    die "candidate id lookup does not match passwd/group"

  # Provisioning and deploy execution are the only supported users of this
  # identity. A pre-existing process can retain stale mounts, credentials, or
  # groups, so both read-only plan and execute fail closed until it is gone.
  for status_path in /proc/[0-9]*/status; do
    [[ -r "$status_path" ]] || continue
    process_uid="$(awk '$1 == "Uid:" { print $2; exit }' "$status_path" 2>/dev/null || true)"
    [[ "$process_uid" =~ ^[0-9]+$ ]] || continue
    [[ "$process_uid" != "$uid" ]] || process_count=$((process_count + 1))
  done
  (( process_count == 0 )) || die "candidate user has $process_count active process(es); provisioning requires zero"

  shadow_row="$(getent shadow "$CANDIDATE_USER")" || die "candidate shadow identity is missing"
  [[ -n "$shadow_row" && "$shadow_row" != *$'\n'* ]] || die "candidate shadow identity is ambiguous"
  shadow_password="${shadow_row#*:}"
  shadow_password="${shadow_password%%:*}"
  [[ "$shadow_password" == '!'* || "$shadow_password" == '*'* ]] || die "candidate password is not locked"
  passwd -S "$CANDIDATE_USER" | awk 'NR == 1 { exit !($2 == "L" || $2 == "LK") }' || \
    die "candidate account is not reported locked"
  CANDIDATE_UID="$uid"
  CANDIDATE_PROCESS_COUNT="$process_count"
  USER_STATE="VERIFIED"
}

MARKER_STATE=""
CONFIG_STATE=""
GUARD_STATE=""
FIXTURE_STATE=""
DROPIN_STATE=""

inspect_managed_targets() {
  local actual_sha
  MARKER_STATE="MISSING"
  if [[ -e "$MARKER_PATH" || -L "$MARKER_PATH" ]]; then
    require_root_file "$MARKER_PATH" "storage marker" 600
    cmp -s -- "$MARKER_PATH" <(marker_content) || \
      die "existing storage marker does not match the live /data identity"
    actual_sha="$(sha256sum -- "$MARKER_PATH" | awk 'NR == 1 {print $1}')"
    [[ "$actual_sha" == "$EXPECTED_MARKER_SHA256" ]] || die "storage marker hash mismatch"
    MARKER_STATE="VERIFIED"
  fi

  CONFIG_STATE="MISSING"
  if [[ -e "$CONFIG_PATH" || -L "$CONFIG_PATH" ]]; then
    require_root_file "$CONFIG_PATH" "storage contract" 600
    cmp -s -- "$CONFIG_PATH" <(config_content) || \
      die "existing storage contract does not exactly match the live /data identity and fixed thresholds"
    actual_sha="$(sha256sum -- "$CONFIG_PATH" | awk 'NR == 1 {print $1}')"
    [[ "$actual_sha" == "$EXPECTED_CONFIG_SHA256" ]] || die "storage contract hash mismatch"
    CONFIG_STATE="VERIFIED"
  fi

  GUARD_STATE="MISSING"
  if [[ -e "$GUARD_TARGET" || -L "$GUARD_TARGET" ]]; then
    require_root_file "$GUARD_TARGET" "installed storage guard" 755
    actual_sha="$(sha256sum -- "$GUARD_TARGET" | awk 'NR == 1 {print $1}')"
    if [[ "$actual_sha" == "$GUARD_SHA256" ]]; then GUARD_STATE="VERIFIED"; else GUARD_STATE="REPLACE"; fi
  fi

  FIXTURE_STATE="MISSING"
  if [[ -e "$FIXTURE_TARGET" || -L "$FIXTURE_TARGET" ]]; then
    require_root_file "$FIXTURE_TARGET" "installed candidate fixture helper" 755
    actual_sha="$(sha256sum -- "$FIXTURE_TARGET" | awk 'NR == 1 {print $1}')"
    if [[ "$actual_sha" == "$FIXTURE_SHA256" ]]; then FIXTURE_STATE="VERIFIED"; else FIXTURE_STATE="REPLACE"; fi
  fi

  DROPIN_STATE="MISSING"
  if [[ -e "$DROPIN_TARGET" || -L "$DROPIN_TARGET" ]]; then
    require_root_file "$DROPIN_TARGET" "installed systemd drop-in" 644
    actual_sha="$(sha256sum -- "$DROPIN_TARGET" | awk 'NR == 1 {print $1}')"
    if [[ "$actual_sha" == "$DROPIN_SHA256" ]]; then DROPIN_STATE="VERIFIED"; else DROPIN_STATE="REPLACE"; fi
  fi

  if [[ -e "$RECEIPT_PATH" || -L "$RECEIPT_PATH" ]]; then
    require_root_file "$RECEIPT_PATH" "existing runtime storage receipt" 600
  fi
}

assert_target_parents() {
  assert_secure_existing_chain "$CONFIG_DIR" "storage config directory"
  assert_secure_existing_chain "/usr/local/libexec" "local libexec directory"
  assert_secure_existing_chain "$GUARD_DIR" "guard directory"
  assert_secure_existing_chain "$DROPIN_DIR" "systemd drop-in directory"
  if [[ -e /run/zimeiti || -L /run/zimeiti ]]; then
    require_root_directory /run/zimeiti "runtime receipt directory"
    [[ "$(stat -c '%a' -- /run/zimeiti)" == "700" ]] || die "runtime receipt directory must use mode 0700"
  fi
}

inspect_systemd_unit() {
  local load_state
  load_state="$(systemctl show --property=LoadState --value pm2-root.service 2>/dev/null)" || \
    die "cannot inspect pm2-root.service"
  [[ "$load_state" == "loaded" ]] || die "pm2-root.service must already exist and be loadable"
}

run_preflight() {
  require_root_file "$CANDIDATE_SHELL" "nologin shell"
  [[ -x "$CANDIDATE_SHELL" ]] || die "nologin shell is not executable: $CANDIDATE_SHELL"
  inspect_live_storage
  inspect_candidate_user
  assert_target_parents
  inspect_managed_targets
  inspect_systemd_unit
}

print_plan() {
  printf 'MODE=%s\n' "$MODE"
  printf 'OPERATION_ID=%s\n' "$OPERATION_ID"
  printf 'CONTROL_ROOT=%s\n' "$CONTROL_ROOT"
  printf 'DATA_MOUNT_SOURCE=%s\n' "$DATA_SOURCE"
  printf 'DATA_MOUNT_UUID=%s\n' "$DATA_UUID"
  printf 'DATA_MOUNT_FSTYPE=%s\n' "$DATA_FSTYPE"
  printf 'DATA_AVAILABLE_BYTES=%s\n' "$AVAILABLE_BYTES"
  printf 'DATA_AVAILABLE_INODES=%s\n' "$AVAILABLE_INODES"
  printf 'DATA_MARKER_SHA256=%s\n' "$EXPECTED_MARKER_SHA256"
  printf 'STORAGE_CONFIG_SHA256=%s\n' "$EXPECTED_CONFIG_SHA256"
  printf 'CANDIDATE_USER_STATE=%s\n' "$USER_STATE"
  printf 'CANDIDATE_UID=%s\n' "${CANDIDATE_UID:-not-created}"
  printf 'CANDIDATE_ACTIVE_PROCESS_COUNT=%s\n' "$CANDIDATE_PROCESS_COUNT"
  printf 'MARKER_STATE=%s\n' "$MARKER_STATE"
  printf 'CONFIG_STATE=%s\n' "$CONFIG_STATE"
  printf 'GUARD_STATE=%s\n' "$GUARD_STATE"
  printf 'CANDIDATE_FIXTURE_HELPER_STATE=%s\n' "$FIXTURE_STATE"
  printf 'DROPIN_STATE=%s\n' "$DROPIN_STATE"
}

run_preflight
print_plan

if [[ "$MODE" == "plan" ]]; then
  printf 'PLAN_MUTATIONS=0\n'
  [[ "$USER_STATE" == "VERIFIED" ]] || printf 'PLAN_ACTION=create locked no-home candidate user %s\n' "$CANDIDATE_USER"
  [[ "$MARKER_STATE" == "VERIFIED" ]] || printf 'PLAN_ACTION=create root-owned storage marker %s\n' "$MARKER_PATH"
  [[ "$CONFIG_STATE" == "VERIFIED" ]] || printf 'PLAN_ACTION=create five-key storage contract %s\n' "$CONFIG_PATH"
  [[ "$GUARD_STATE" == "VERIFIED" ]] || printf 'PLAN_ACTION=install pinned storage guard %s\n' "$GUARD_TARGET"
  [[ "$FIXTURE_STATE" == "VERIFIED" ]] || printf 'PLAN_ACTION=install pinned candidate fixture helper %s\n' "$FIXTURE_TARGET"
  [[ "$DROPIN_STATE" == "VERIFIED" ]] || printf 'PLAN_ACTION=install pm2-root.service drop-in %s\n' "$DROPIN_TARGET"
  printf 'PLAN_ACTION=systemctl daemon-reload (execute mode only)\n'
  printf 'PLAN_ACTION=run storage guard and strictly validate %s (execute mode only)\n' "$RECEIPT_PATH"
  printf 'PLAN_ACTION=run pinned candidate fixture helper self-test (execute mode only)\n'
  printf 'PASS PLAN ONLY: no account, file, directory, receipt, service, process, database, business data, Git, or deployment state changed.\n'
  printf 'REMAINING_GATE=maintenance-window restart of pm2-root.service is still required; this script never restarts or reloads PM2.\n'
  printf 'REMAINING_GATE=missing-disk and wrong-disk boot drills are still required before production acceptance.\n'
  exit 0
fi

[[ "${RUNTIME_SAFETY_EXECUTION_APPROVED:-}" == "$OPERATION_ID" ]] || \
  die "RUNTIME_SAFETY_EXECUTION_APPROVED must exactly equal --operation-id"

TEMP_PATH=""
cleanup_temp() {
  [[ -z "${TEMP_PATH:-}" ]] || rm -f -- "$TEMP_PATH"
}
trap cleanup_temp EXIT INT TERM

if [[ -e "$LOCK_PATH" || -L "$LOCK_PATH" ]]; then
  require_root_file "$LOCK_PATH" "runtime-safety lock" 600
fi
exec 9>>"$LOCK_PATH"
require_root_file "$LOCK_PATH" "runtime-safety lock" 600
[[ "$(readlink -f -- "/proc/$$/fd/9")" == "$LOCK_PATH" ]] || die "runtime-safety lock descriptor escaped its path"
flock -n 9 || die "another runtime-safety provisioning operation holds $LOCK_PATH"

# The mount, sources, user and targets may have changed while an operator read
# the plan. Re-evaluate every precondition under the execution lock.
run_preflight

ensure_directory() {
  local path="$1" create_mode="$2" label="$3"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    install -d -o root -g root -m "$create_mode" -- "$path" || fail "cannot create $label: $path"
  fi
  require_root_directory "$path" "$label"
}

atomic_create_generated_file() {
  local destination="$1" mode="$2" label="$3" generator="$4" parent
  [[ ! -e "$destination" && ! -L "$destination" ]] || die "$label appeared before exclusive creation"
  parent="$(dirname -- "$destination")"
  TEMP_PATH="$(mktemp "$parent/.${destination##*/}.tmp.XXXXXX")" || fail "cannot allocate $label temp file"
  "$generator" >"$TEMP_PATH" || fail "cannot write $label temp file"
  chown 0:0 -- "$TEMP_PATH"
  chmod "$mode" -- "$TEMP_PATH"
  require_root_file "$TEMP_PATH" "$label temp file" "$mode"
  ln -- "$TEMP_PATH" "$destination" || fail "$label destination appeared or could not be created exclusively"
  rm -f -- "$TEMP_PATH"
  TEMP_PATH=""
  sync -f "$destination"
  sync -f "$parent"
  require_root_file "$destination" "$label" "$mode"
}

atomic_install_reviewed_file() {
  local source="$1" destination="$2" mode="$3" label="$4" expected_sha="$5" parent actual_sha
  parent="$(dirname -- "$destination")"
  if [[ -e "$destination" || -L "$destination" ]]; then
    require_root_file "$destination" "$label" "$mode"
    actual_sha="$(sha256sum -- "$destination" | awk 'NR == 1 {print $1}')"
    [[ "$actual_sha" == "$expected_sha" ]] && return 0
  fi
  TEMP_PATH="$(mktemp "$parent/.${destination##*/}.tmp.XXXXXX")" || fail "cannot allocate $label temp file"
  install -o root -g root -m "$mode" -- "$source" "$TEMP_PATH" || fail "cannot stage $label"
  require_root_file "$TEMP_PATH" "$label temp file" "$mode"
  actual_sha="$(sha256sum -- "$TEMP_PATH" | awk 'NR == 1 {print $1}')"
  [[ "$actual_sha" == "$expected_sha" ]] || fail "$label temp-file SHA-256 mismatch"
  mv -fT -- "$TEMP_PATH" "$destination" || fail "cannot atomically install $label"
  TEMP_PATH=""
  sync -f "$destination"
  sync -f "$parent"
  require_root_file "$destination" "$label" "$mode"
}

if [[ "$USER_STATE" == "MISSING" ]]; then
  useradd --system --user-group --no-create-home --home-dir "$CANDIDATE_HOME" \
    --shell "$CANDIDATE_SHELL" --password '!' -- "$CANDIDATE_USER" || fail "cannot create candidate user"
fi
inspect_candidate_user
[[ "$USER_STATE" == "VERIFIED" ]] || fail "candidate user did not pass strict readback"

ensure_directory "$CONFIG_DIR" 0750 "storage config directory"
ensure_directory /usr/local/libexec 0755 "local libexec directory"
ensure_directory "$GUARD_DIR" 0755 "guard directory"
ensure_directory "$DROPIN_DIR" 0755 "systemd drop-in directory"

if [[ "$MARKER_STATE" == "MISSING" ]]; then
  atomic_create_generated_file "$MARKER_PATH" 600 "storage marker" marker_content
fi
if [[ "$CONFIG_STATE" == "MISSING" ]]; then
  atomic_create_generated_file "$CONFIG_PATH" 600 "storage contract" config_content
fi
atomic_install_reviewed_file "$GUARD_SOURCE" "$GUARD_TARGET" 755 "installed storage guard" "$GUARD_SHA256"
atomic_install_reviewed_file "$FIXTURE_SOURCE" "$FIXTURE_TARGET" 755 "installed candidate fixture helper" "$FIXTURE_SHA256"
atomic_install_reviewed_file "$DROPIN_SOURCE" "$DROPIN_TARGET" 644 "installed systemd drop-in" "$DROPIN_SHA256"

# systemctl daemon-reload only makes systemd re-read unit metadata. This script
# deliberately never calls restart, reload, try-restart, start, stop, or PM2.
systemctl daemon-reload || fail "systemctl daemon-reload failed"

DROPIN_PATHS="$(systemctl show --property=DropInPaths --value pm2-root.service 2>/dev/null | tr '\n' ' ')" || \
  fail "cannot read back pm2-root.service drop-in paths"
case " $DROPIN_PATHS " in
  *" $DROPIN_TARGET "*) ;;
  *) fail "systemd did not load the exact runtime-safety drop-in" ;;
esac

# Re-read all durable state before invoking the reviewed guard. No unverified
# installed bytes are ever executed.
inspect_live_storage
inspect_candidate_user
inspect_managed_targets
[[ "$USER_STATE" == "VERIFIED" && "$MARKER_STATE" == "VERIFIED" && "$CONFIG_STATE" == "VERIFIED" && \
   "$GUARD_STATE" == "VERIFIED" && "$FIXTURE_STATE" == "VERIFIED" && "$DROPIN_STATE" == "VERIFIED" ]] || \
  fail "durable runtime-safety state failed strict readback"

"$FIXTURE_TARGET" --self-test || fail "installed candidate fixture helper self-test failed"

GUARD_START_EPOCH="$(date -u +%s)"
if ! GUARD_OUTPUT="$(env -u ZIMEITI_STORAGE_GUARD_TEST_ONLY -u ZIMEITI_STORAGE_GUARD_TEST_ROOT "$GUARD_TARGET")"; then
  fail "installed storage guard rejected the live runtime"
fi
printf '%s\n' "$GUARD_OUTPUT"

BOOT_ID="$(awk 'NR == 1 {print; exit}' /proc/sys/kernel/random/boot_id)"
GUARD_END_EPOCH="$(date -u +%s)"
node --no-warnings - "$RECEIPT_PATH" "$DATA_SOURCE" "$DATA_UUID" "$DATA_FSTYPE" \
  "$EXPECTED_MARKER_SHA256" "$EXPECTED_CONFIG_SHA256" "$MIN_AVAILABLE_BYTES" "$MIN_AVAILABLE_INODES" \
  "$BOOT_ID" "$GUARD_START_EPOCH" "$GUARD_END_EPOCH" <<'NODE'
const fs = require("node:fs");

const [
  receiptPath,
  expectedSource,
  expectedUuid,
  expectedFstype,
  expectedMarkerSha256,
  expectedConfigSha256,
  expectedMinBytesRaw,
  expectedMinInodesRaw,
  expectedBootId,
  startedRaw,
  endedRaw,
] = process.argv.slice(2);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys differ: ${actual.join(",")}`);
}

const stats = fs.lstatSync(receiptPath);
assert(stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1, "receipt must be a single-link regular file");
assert(stats.uid === 0 && stats.gid === 0 && (stats.mode & 0o7777) === 0o600, "receipt must be root:root 0600");
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));

assertKeys(receipt, ["schemaVersion", "status", "verifiedAt", "verifiedEpoch", "bootId", "guard", "mount", "marker", "capacity", "paths", "security", "receipt"], "receipt");
assertKeys(receipt.guard, ["script", "configPath", "configSha256", "fstypeBinding"], "guard");
assertKeys(receipt.mount, ["rootTarget", "target", "rootSource", "source", "uuid", "fstype", "rootMajorMinor", "majorMinor", "fstabSource", "fstabFstype", "fstabTarget", "independent"], "mount");
assertKeys(receipt.marker, ["path", "sha256"], "marker");
assertKeys(receipt.capacity, ["availableBytes", "minimumAvailableBytes", "availableInodes", "minimumAvailableInodes"], "capacity");
assertKeys(receipt.paths, ["dataRoot", "webRoot", "rootAndDataTargetsDistinct", "rootAndDataDevicesDistinct", "rootAndDataSourcesDistinct", "webRootOnDataDevice"], "paths");
assertKeys(receipt.security, ["configRootOwned", "configMode", "fstabRootOwned", "fstabMode", "dataRootOwned", "dataRootMode", "webRootOwned", "webRootMode", "markerRootOwned", "markerMode", "runtimeDirectoryRootOwned", "runtimeDirectoryMode", "symlinksRejected"], "security");
assertKeys(receipt.receipt, ["path", "ownerUid", "ownerGid", "mode", "atomicWrite"], "receipt metadata");

const minBytes = Number(expectedMinBytesRaw);
const minInodes = Number(expectedMinInodesRaw);
const started = Number(startedRaw);
const ended = Number(endedRaw);
assert(receipt.schemaVersion === "zimeiti-storage-readiness.v1" && receipt.status === "ready", "receipt status/schema mismatch");
assert(receipt.bootId === expectedBootId, "receipt boot ID is stale");
assert(Number.isSafeInteger(receipt.verifiedEpoch) && receipt.verifiedEpoch >= started && receipt.verifiedEpoch <= ended + 5, "receipt verification time is outside this guard run");
assert(new Date(receipt.verifiedAt).toISOString().replace(".000Z", "Z") === receipt.verifiedAt, "receipt verifiedAt is not canonical UTC");
assert(receipt.guard.script === "verify-deploy-storage-runtime.sh" && receipt.guard.configPath === "/etc/zimeiti/deploy-storage.conf", "guard identity mismatch");
assert(receipt.guard.configSha256 === expectedConfigSha256, "config SHA-256 mismatch");
assert(receipt.guard.fstypeBinding === "detected-and-fstab-bound-not-config-declared", "guard fstype binding mismatch");
assert(receipt.mount.rootTarget === "/" && receipt.mount.target === "/data" && receipt.mount.source === expectedSource, "mount target/source mismatch");
assert(receipt.mount.uuid === expectedUuid && receipt.mount.fstype === expectedFstype, "mount UUID/fstype mismatch");
assert(receipt.mount.fstabTarget === "/data" && receipt.mount.fstabFstype === expectedFstype && receipt.mount.independent === true, "persistent mount binding mismatch");
assert(receipt.mount.fstabSource === `UUID=${expectedUuid}` || receipt.mount.fstabSource === `/dev/disk/by-uuid/${expectedUuid}`, "fstab UUID source mismatch");
assert(receipt.marker.path === "/data/.zimeiti-storage-root" && receipt.marker.sha256 === expectedMarkerSha256, "marker receipt mismatch");
assert(receipt.capacity.minimumAvailableBytes === minBytes && receipt.capacity.availableBytes >= minBytes, "byte threshold mismatch");
assert(receipt.capacity.minimumAvailableInodes === minInodes && receipt.capacity.availableInodes >= minInodes, "inode threshold mismatch");
for (const key of ["rootAndDataTargetsDistinct", "rootAndDataDevicesDistinct", "rootAndDataSourcesDistinct", "webRootOnDataDevice"]) assert(receipt.paths[key] === true, `path proof failed: ${key}`);
assert(receipt.paths.dataRoot === "/data" && receipt.paths.webRoot === "/data/web", "receipt path roots mismatch");
for (const key of ["configRootOwned", "fstabRootOwned", "dataRootOwned", "webRootOwned", "markerRootOwned", "runtimeDirectoryRootOwned", "symlinksRejected"]) assert(receipt.security[key] === true, `security proof failed: ${key}`);
assert(receipt.security.configMode === "0600" && receipt.security.markerMode === "0600" && receipt.security.runtimeDirectoryMode === "0700", "security modes mismatch");
assert(receipt.receipt.path === receiptPath && receipt.receipt.ownerUid === 0 && receipt.receipt.ownerGid === 0 && receipt.receipt.mode === "0600" && receipt.receipt.atomicWrite === true, "receipt self-metadata mismatch");
process.stdout.write("RECEIPT_READBACK=VERIFIED\n");
NODE

trap - EXIT INT TERM
TEMP_PATH=""

printf 'PASS EXECUTE: runtime-safety account, storage contract, guard, candidate fixture helper, systemd drop-in, and current-boot receipt are strictly verified.\n'
printf 'PM2_ACTIONS=0\n'
printf 'DATABASE_ACTIONS=0\n'
printf 'BUSINESS_DATA_ACTIONS=0\n'
printf 'GIT_ACTIONS=0\n'
printf 'DEPLOYMENT_ACTIONS=0\n'
printf 'REMAINING_GATE=maintenance-window restart of pm2-root.service is still required; this script never restarts or reloads PM2.\n'
printf 'REMAINING_GATE=missing-disk and wrong-disk boot drills are still required before production acceptance.\n'
