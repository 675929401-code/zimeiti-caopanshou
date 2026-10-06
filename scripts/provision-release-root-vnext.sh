#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

PROJECT_ID="zimeiti-caopanshou"
MARKER_CONTENT="zimeiti-caopanshou release-root v1"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/provision-release-root-vnext.sh --plan --root /srv/zimeiti-caopanshou

  RELEASE_ROOT_PROVISION_APPROVED=/srv/zimeiti-caopanshou \
  bash scripts/provision-release-root-vnext.sh --execute --root /srv/zimeiti-caopanshou

This provisioner creates only the owned release-directory skeleton and the
project identity marker. It is idempotent and never overwrites an existing
file, creates business-data defaults, initializes SQLite, restores a backup,
deploys code, changes a current pointer, starts a process, or uses the network.

The following persistent state must come from a separately verified backup or
migration workflow and is never synthesized here:
  shared/voice/voice.db
  shared/data/engine-configs.json
  shared/data/custom-voices.json
  shared/data/generations.json
  shared/data/service-cards.json
  shared/data/studio-config.json
  shared/data/voices.json
  shared/data/voice-studio/service-cards.json
  shared/data/voice-studio/voices.json

On a new server, --plan reports the directory work and exits 2 while persistent
state is absent. An explicitly approved --execute creates the safe skeleton and
also exits 2 until the real database and JSON files have been restored. Rerun
--plan and --execute after restoration; both then validate the state without
overwriting it.
USAGE
}

die() {
  echo "BLOCKED: $*" >&2
  exit 2
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

MODE=""
RELEASE_ROOT=""

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
    --root)
      [[ -z "$RELEASE_ROOT" ]] || die "--root may be provided only once"
      [[ $# -ge 2 && -n "${2:-}" ]] || die "--root requires a value"
      RELEASE_ROOT="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$MODE" == "plan" || "$MODE" == "execute" ]] || die "exactly one of --plan or --execute is required"
[[ "$RELEASE_ROOT" =~ ^/([A-Za-z0-9][A-Za-z0-9._-]*/)*[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || \
  die "--root must be a normalized absolute Linux path containing only safe components"
[[ "${RELEASE_ROOT#/}" == */* ]] || die "release root must be nested below a top-level system directory"
case "$RELEASE_ROOT" in
  /|/root|/home|/srv|/var|/www|/opt|/mnt) die "release root is too broad: $RELEASE_ROOT" ;;
esac

for command_name in readlink node; do
  require_command "$command_name"
done
if [[ "$MODE" == "execute" ]]; then
  require_command mkdir
fi

ROOT_PARENT="${RELEASE_ROOT%/*}"
[[ -n "$ROOT_PARENT" ]] || ROOT_PARENT="/"
[[ -d "$ROOT_PARENT" && ! -L "$ROOT_PARENT" ]] || die "release-root parent must already be a real directory: $ROOT_PARENT"

assert_existing_directory_chain() {
  local target="$1"
  local relative="${target#/}"
  local current=""
  local component
  local -a components=()
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    current="$current/$component"
    if [[ -e "$current" || -L "$current" ]]; then
      [[ -d "$current" && ! -L "$current" ]] || die "path component is a symlink or non-directory: $current"
    fi
  done
}

assert_existing_directory_chain "$RELEASE_ROOT"
[[ "$(readlink -f -- "$ROOT_PARENT")" == "$ROOT_PARENT" ]] || die "release-root parent is not canonical: $ROOT_PARENT"

ROOT_EXISTS="0"
if [[ -e "$RELEASE_ROOT" || -L "$RELEASE_ROOT" ]]; then
  [[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || die "release root exists but is not a real directory"
  [[ "$(readlink -f -- "$RELEASE_ROOT")" == "$RELEASE_ROOT" ]] || die "release root is not canonical"
  [[ -r "$RELEASE_ROOT" && -w "$RELEASE_ROOT" && -x "$RELEASE_ROOT" ]] || \
    die "release root is not readable/writable/traversable by the provisioning user"
  ROOT_EXISTS="1"
else
  [[ -r "$ROOT_PARENT" && -w "$ROOT_PARENT" && -x "$ROOT_PARENT" ]] || \
    die "release-root parent is not readable/writable/traversable by the provisioning user"
fi

CONTRACT_DIRECTORIES=(
  "releases"
  "staging"
  "staging/assets"
  "shared"
  "shared/assets"
  "shared/assets/releases"
  "shared/data"
  "shared/data/voice-studio"
  "shared/runtime"
  "shared/runtime/llm-request-idempotency"
  "shared/uploads"
  "shared/logs"
  "shared/backups"
  "shared/voice"
  "shared/voice/reference-audio"
)

PERSISTENT_PATHS=(
  "shared/voice/voice.db"
  "shared/data/engine-configs.json"
  "shared/data/custom-voices.json"
  "shared/data/generations.json"
  "shared/data/service-cards.json"
  "shared/data/studio-config.json"
  "shared/data/voices.json"
  "shared/data/voice-studio/service-cards.json"
  "shared/data/voice-studio/voices.json"
)

MISSING_DIRECTORIES=()
inspect_contract_directories() {
  MISSING_DIRECTORIES=()
  local relative_path full_path
  for relative_path in "${CONTRACT_DIRECTORIES[@]}"; do
    full_path="$RELEASE_ROOT/$relative_path"
    assert_existing_directory_chain "$full_path"
    if [[ -e "$full_path" || -L "$full_path" ]]; then
      [[ -d "$full_path" && ! -L "$full_path" ]] || die "contract path is not a real directory: $full_path"
      [[ "$(readlink -f -- "$full_path")" == "$full_path" ]] || die "contract directory is not canonical: $full_path"
      [[ -r "$full_path" && -w "$full_path" && -x "$full_path" ]] || \
        die "contract directory is not readable/writable/traversable: $full_path"
    else
      MISSING_DIRECTORIES+=("$relative_path")
    fi
  done
}

MARKER_PATH="$RELEASE_ROOT/.zimeiti-release-root"

validate_existing_marker() {
  [[ -e "$MARKER_PATH" || -L "$MARKER_PATH" ]] || return 1
  [[ -f "$MARKER_PATH" && ! -L "$MARKER_PATH" && -r "$MARKER_PATH" ]] || \
    die "release-root marker is not a readable regular non-symlink file"
  node -e '
const fs = require("node:fs");
const [filePath, markerContent] = process.argv.slice(1);
const stats = fs.lstatSync(filePath);
const actual = fs.readFileSync(filePath);
const expected = Buffer.from(`${markerContent}\n`, "utf8");
if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !actual.equals(expected)) process.exit(2);
' "$MARKER_PATH" "$MARKER_CONTENT" || die "release-root marker content/link contract does not match $PROJECT_ID release-root v1"
  return 0
}

create_marker_exclusive() {
  node - "$RELEASE_ROOT" "$MARKER_CONTENT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [rootInput, markerContent] = process.argv.slice(2);
const root = fs.realpathSync(rootInput);
const rootStats = fs.lstatSync(root);
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("release root changed before marker creation");
const markerPath = path.join(root, ".zimeiti-release-root");
if (fs.lstatSync(markerPath, { throwIfNoEntry: false })) throw new Error("release-root marker appeared before exclusive creation");
const bytes = Buffer.from(`${markerContent}\n`, "utf8");
let descriptor;
let created = false;
try {
  descriptor = fs.openSync(markerPath, "wx", 0o640);
  created = true;
  fs.writeFileSync(descriptor, bytes);
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  descriptor = undefined;
  fs.chmodSync(markerPath, 0o640);
  if (process.platform !== "win32") {
    const directoryDescriptor = fs.openSync(root, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  }
} catch (error) {
  if (descriptor !== undefined) {
    try { fs.closeSync(descriptor); } catch {}
  }
  if (created) {
    const stats = fs.lstatSync(markerPath, { throwIfNoEntry: false });
    if (stats?.isFile() && !stats.isSymbolicLink() && stats.nlink === 1) {
      try { fs.unlinkSync(markerPath); } catch {}
    }
  }
  throw error;
}
NODE
}

validate_persistent_state() {
  node --no-warnings - "$RELEASE_ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = fs.realpathSync(process.argv[2]);
const specs = [
  ["shared/voice/voice.db", "sqlite"],
  ["shared/data/engine-configs.json", "array"],
  ["shared/data/custom-voices.json", "array"],
  ["shared/data/generations.json", "array"],
  ["shared/data/service-cards.json", "array"],
  ["shared/data/studio-config.json", "object"],
  ["shared/data/voices.json", "array"],
  ["shared/data/voice-studio/service-cards.json", "array"],
  ["shared/data/voice-studio/voices.json", "array"],
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

for (const [relativePath, kind] of specs) {
  const filePath = path.join(root, ...relativePath.split("/"));
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) {
    process.stdout.write(`MISSING\t${relativePath}\n`);
    continue;
  }
  requireCondition(stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1 && stats.size > 0, `${relativePath} is not a non-empty single-link regular file`);
  fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
  const realFilePath = fs.realpathSync(filePath);
  requireCondition(isInside(root, realFilePath), `${relativePath} escapes the release root`);
  if (kind === "sqlite") {
    const descriptor = fs.openSync(filePath, "r");
    const header = Buffer.alloc(16);
    try {
      requireCondition(fs.readSync(descriptor, header, 0, header.length, 0) === header.length, "voice.db has a truncated SQLite header");
    } finally {
      fs.closeSync(descriptor);
    }
    requireCondition(header.equals(Buffer.from("SQLite format 3\u0000", "binary")), "voice.db does not have a valid SQLite 3 header");
    const database = new DatabaseSync(filePath, { readOnly: true, allowExtension: false });
    try {
      const rows = database.prepare("PRAGMA quick_check").all();
      requireCondition(rows.length === 1 && rows[0].quick_check === "ok", "voice.db failed SQLite PRAGMA quick_check");
    } finally {
      database.close();
    }
  } else {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (kind === "array") requireCondition(Array.isArray(parsed), `${relativePath} must contain a JSON array`);
    else requireCondition(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${relativePath} must contain a JSON object`);
  }
  process.stdout.write(`VERIFIED\t${relativePath}\n`);
}
NODE
}

PERSISTENT_REPORT=""
MISSING_PERSISTENT_COUNT="0"
collect_persistent_report() {
  if [[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]]; then
    PERSISTENT_REPORT="$(validate_persistent_state)" || die "persistent state validation failed"
  else
    PERSISTENT_REPORT=""
    local relative_path
    for relative_path in "${PERSISTENT_PATHS[@]}"; do
      PERSISTENT_REPORT+="MISSING"$'\t'"$relative_path"$'\n'
    done
    PERSISTENT_REPORT="${PERSISTENT_REPORT%$'\n'}"
  fi
  local status relative_path count=0
  while IFS=$'\t' read -r status relative_path; do
    if [[ "$status" == "MISSING" ]]; then count=$((count + 1)); fi
  done <<<"$PERSISTENT_REPORT"
  MISSING_PERSISTENT_COUNT="$count"
}

print_persistent_report() {
  local status relative_path
  while IFS=$'\t' read -r status relative_path; do
    [[ -n "$status" ]] || continue
    printf 'PERSISTENT_%s=%s\n' "$status" "$relative_path"
  done <<<"$PERSISTENT_REPORT"
}

if [[ "$ROOT_EXISTS" == "1" ]]; then inspect_contract_directories; else MISSING_DIRECTORIES=("${CONTRACT_DIRECTORIES[@]}"); fi
MARKER_STATE="MISSING"
if [[ "$ROOT_EXISTS" == "1" ]] && validate_existing_marker; then MARKER_STATE="VERIFIED"; fi
collect_persistent_report

echo "MODE=$MODE"
echo "RELEASE_ROOT=$RELEASE_ROOT"
echo "MARKER_STATE=$MARKER_STATE"
for relative_path in "${MISSING_DIRECTORIES[@]}"; do echo "DIRECTORY_WILL_CREATE=$relative_path"; done
print_persistent_report

if [[ "$MODE" == "plan" ]]; then
  echo "PLAN_DIRECTORY_CREATE_COUNT=${#MISSING_DIRECTORIES[@]}"
  echo "PLAN_MUTATIONS=0"
  if [[ "$MISSING_PERSISTENT_COUNT" != "0" ]]; then
    die "$MISSING_PERSISTENT_COUNT required persistent files are absent; restore verified business data before deployment"
  fi
  echo "PASS PLAN ONLY: release-root identity, directories, permissions, SQLite integrity and JSON shapes are ready."
  exit 0
fi

[[ "${RELEASE_ROOT_PROVISION_APPROVED:-}" == "$RELEASE_ROOT" ]] || \
  die "RELEASE_ROOT_PROVISION_APPROVED must exactly equal $RELEASE_ROOT"

CREATED_DIRECTORIES="0"
if [[ "$ROOT_EXISTS" == "0" ]]; then
  [[ ! -e "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || die "release root appeared after preflight"
  mkdir --mode=0750 -- "$RELEASE_ROOT" || fail "unable to create release root"
  CREATED_DIRECTORIES=$((CREATED_DIRECTORIES + 1))
fi

assert_existing_directory_chain "$RELEASE_ROOT"
[[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" && "$(readlink -f -- "$RELEASE_ROOT")" == "$RELEASE_ROOT" ]] || \
  fail "release root was not created as the exact real directory"
[[ -r "$RELEASE_ROOT" && -w "$RELEASE_ROOT" && -x "$RELEASE_ROOT" ]] || fail "created release root has unusable permissions"

if ! validate_existing_marker; then
  create_marker_exclusive || fail "exclusive release-root marker creation failed"
fi
validate_existing_marker || fail "release-root marker verification failed after creation"

for relative_path in "${CONTRACT_DIRECTORIES[@]}"; do
  full_path="$RELEASE_ROOT/$relative_path"
  if [[ ! -e "$full_path" && ! -L "$full_path" ]]; then
    mkdir --mode=0750 -- "$full_path" || fail "unable to create contract directory: $full_path"
    CREATED_DIRECTORIES=$((CREATED_DIRECTORIES + 1))
  fi
  assert_existing_directory_chain "$full_path"
  [[ -d "$full_path" && ! -L "$full_path" && "$(readlink -f -- "$full_path")" == "$full_path" ]] || \
    fail "contract directory is unsafe after provisioning: $full_path"
  [[ -r "$full_path" && -w "$full_path" && -x "$full_path" ]] || \
    fail "contract directory has unusable permissions after provisioning: $full_path"
done

inspect_contract_directories
[[ "${#MISSING_DIRECTORIES[@]}" == "0" ]] || fail "contract directory set remains incomplete after provisioning"
collect_persistent_report
print_persistent_report

echo "EXECUTE_DIRECTORY_CREATE_COUNT=$CREATED_DIRECTORIES"
echo "MARKER_STATE=VERIFIED"
if [[ "$MISSING_PERSISTENT_COUNT" != "0" ]]; then
  die "directory skeleton is provisioned, but $MISSING_PERSISTENT_COUNT persistent files are absent; no empty business data was generated"
fi

echo "PASS provisioned and verified release root $RELEASE_ROOT"
echo "PASS persistent database and eight JSON files were preserved and validated without overwrite"
