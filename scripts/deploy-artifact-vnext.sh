#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

PROJECT_ID="zimeiti-caopanshou"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/deploy-artifact-vnext.sh --plan \
    --release-mode WEB|VOICE --service web|voice \
    --artifact FILE --sha256 HEX --release-id ID --root ABSOLUTE_ROOT

  DEPLOY_EXECUTION_APPROVED=ID bash scripts/deploy-artifact-vnext.sh --execute \
    --release-mode WEB|VOICE --service web|voice \
    --artifact FILE --sha256 HEX --release-id ID --root ABSOLUTE_ROOT

  bash scripts/deploy-artifact-vnext.sh --verify-sensitive-root DIRECTORY

This deployer accepts only a Linux-built, schema-v2, deployable immutable
artifact. It never pulls Git, installs dependencies, builds on the server,
creates/seeds mutable business data, migrates a database, or deletes an old
release.

The standalone sensitive-path verifier is read-only and exists for focused,
zero-network release-gate regression tests.

Execute mode requires EUID=0. The promoted code release is fully hashed,
sealed root:root with all write bits removed, verified again from the sealed
tree, and only then made active. Plan mode remains read-only and may be run by
an appropriately permissioned non-root auditor.

FULL is deliberately blocked. A future FULL coordinator must make the Web,
Voice and asset-pointer switches one composite transaction; running two
single-service switches and calling them FULL would permit a mixed release.

Persistent server contract (must be provisioned before deployment):
  shared/data                         mutable JSON business data
  shared/runtime                      mutable runtime state
  shared/runtime/llm-request-idempotency  persistent request idempotency state
  shared/uploads                      mutable user uploads
  shared/logs                         process/deploy logs
  shared/backups                      independently managed backups
  shared/voice/voice.db               persistent Voice SQLite database
  shared/voice/reference-audio        persistent Voice reference audio
  shared/assets/releases/sha256-<digest>/public/...
  shared/assets/current -> releases/sha256-<digest>

Production assets are allowlisted under product-assets, youcai-media,
short-drama, cover-references, avatars, cover-presets, help, cover-assets,
cover-generated-samples, official-home, downloads and model-brands.
storyboard-reviews and demo-assets are test/evidence stores and are always
rejected from a production asset manifest; uploads stay in shared/uploads.

An immutable asset release is READY only when its .release directory contains
public-assets.v1.json plus public-assets.ready.v1.json produced after a full
per-file SHA-256 verification. Web deployment compares those receipts with the
asset manifest embedded in the code artifact, then switches current atomically.

The asset and Web links are not one kernel-level two-pointer atomic operation.
When the asset digest changes, activation is allowed only if the new manifest
keeps the same asset policy and is a forward-compatible superset: every old URL
keeps identical bytes/SHA and only new URLs are added. Otherwise deployment
fails closed; use new asset paths or a future single-bundle pointer transaction.

  ASSET_DELIVERY_MODE defaults to auto and is only an optional policy constraint
  for the target asset release. Every current/target/rollback release derives its
  actual disk|cos backend from its own signed READY receipt, so a controlled
  disk-to-COS migration never guesses both sides from one process-wide value.
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

verify_sensitive_artifact_paths() {
  local input_mode="$1"
  local input_path="$2"
  local types_path="${3:-}"
  node - "$input_mode" "$input_path" "$types_path" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [inputMode, inputPath, typesPath] = process.argv.slice(2);
const sensitiveDataExtensions = new Set(["", ".bin", ".conf", ".config", ".csv", ".dat", ".ini", ".json", ".properties", ".txt", ".xml", ".yaml", ".yml"]);
const privateKeyExtensions = new Set([".key", ".keystore", ".p12", ".pfx"]);
const sensitiveNameMarker = /(^|[._-])(?:api[._-]?key|private[._-]?key|secret(?:s)?|token(?:s)?|cookie(?:s)?|credential(?:s)?|service[._-]?account)(?=$|[._-])/iu;

function normalize(relativePath) {
  return relativePath.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}
function isKnownNonSecretDependencySchema(relativePath) {
  const normalizedPath = normalize(relativePath).toLowerCase();
  const schemaPath = "node_modules/har-schema/lib/cookie.json";
  return normalizedPath === schemaPath || normalizedPath.endsWith(`/${schemaPath}`);
}
function sensitiveReason(relativePath, kind) {
  const normalizedPath = normalize(relativePath);
  const parts = normalizedPath.split("/").filter(Boolean);
  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    if (lowerPart === ".env" || lowerPart.startsWith(".env.")) return "environment file";
    if (lowerPart === ".npmrc") return "package-manager credential file";
    if (lowerPart === ".secure") return "secure-material path";
  }
  if (kind !== "file" || parts.length === 0) return null;
  if (isKnownNonSecretDependencySchema(normalizedPath)) return null;
  const fileName = parts.at(-1).toLowerCase();
  const extension = path.posix.extname(fileName);
  if (privateKeyExtensions.has(extension)) return "private-key container";
  if (["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"].includes(fileName)) return "SSH private key";
  if (sensitiveDataExtensions.has(extension)) {
    const stem = extension ? fileName.slice(0, -extension.length) : fileName;
    if (sensitiveNameMarker.test(stem)) return "credential, key, token, cookie, or secret data file";
  }
  return null;
}
function assertSafe(relativePath, kind) {
  const reason = sensitiveReason(relativePath, kind);
  if (reason) throw new Error(`forbidden sensitive artifact path (${reason}): ${normalize(relativePath)}`);
}

if (inputMode === "archive") {
  const names = fs.readFileSync(inputPath, "utf8").split("\n").filter(Boolean);
  const verbose = fs.readFileSync(typesPath, "utf8").split("\n").filter(Boolean);
  if (names.length !== verbose.length) throw new Error("archive listing/type count mismatch during sensitive-path audit");
  names.forEach((rawName, index) => {
    const normalizedPath = normalize(rawName);
    if (!normalizedPath || normalizedPath === ".") return;
    assertSafe(normalizedPath, verbose[index][0] === "d" ? "directory" : "file");
  });
} else if (inputMode === "tree") {
  const root = fs.realpathSync(inputPath);
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
      const stats = fs.lstatSync(entryPath);
      assertSafe(relativePath, stats.isDirectory() ? "directory" : "file");
      if (stats.isSymbolicLink()) throw new Error(`artifact tree contains a symlink: ${relativePath}`);
      if (stats.isDirectory()) walk(entryPath);
      else if (!stats.isFile()) throw new Error(`artifact tree contains a non-regular entry: ${relativePath}`);
    }
  }
  walk(root);
} else {
  throw new Error(`unsupported sensitive-path verification mode: ${inputMode}`);
}
NODE
}

MODE=""
RELEASE_MODE=""
SERVICE=""
ARTIFACT=""
EXPECTED_SHA256=""
RELEASE_ID=""
RELEASE_ROOT=""
SENSITIVE_VERIFY_ROOT=""
ASSET_DELIVERY_MODE="${ASSET_DELIVERY_MODE:-auto}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      [[ -z "$MODE" || "$MODE" == "plan" ]] || die "--plan and --execute are mutually exclusive"
      MODE="plan"
      shift
      ;;
    --execute)
      [[ -z "$MODE" || "$MODE" == "execute" ]] || die "--plan and --execute are mutually exclusive"
      MODE="execute"
      shift
      ;;
    --release-mode) RELEASE_MODE="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --artifact) ARTIFACT="${2:-}"; shift 2 ;;
    --sha256) EXPECTED_SHA256="${2:-}"; shift 2 ;;
    --release-id) RELEASE_ID="${2:-}"; shift 2 ;;
    --root) RELEASE_ROOT="${2:-}"; shift 2 ;;
    --verify-sensitive-root) SENSITIVE_VERIFY_ROOT="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$SENSITIVE_VERIFY_ROOT" ]]; then
  [[ -z "$MODE$RELEASE_MODE$SERVICE$ARTIFACT$EXPECTED_SHA256$RELEASE_ID$RELEASE_ROOT" ]] || \
    die "--verify-sensitive-root is a standalone read-only verification mode"
  require_command node
  [[ -d "$SENSITIVE_VERIFY_ROOT" && ! -L "$SENSITIVE_VERIFY_ROOT" ]] || die "sensitive-path verification root must be a regular directory"
  verify_sensitive_artifact_paths tree "$SENSITIVE_VERIFY_ROOT"
  echo "PASS artifact sensitive-path policy: $SENSITIVE_VERIFY_ROOT"
  exit 0
fi

[[ "$MODE" == "plan" || "$MODE" == "execute" ]] || die "exactly one of --plan or --execute is required"
RELEASE_MODE="${RELEASE_MODE^^}"
if [[ "$RELEASE_MODE" == "FULL" ]]; then
  die "FULL is disabled until a tested composite Web+Voice+asset transaction exists"
fi
[[ "$RELEASE_MODE" == "WEB" || "$RELEASE_MODE" == "VOICE" ]] || die "--release-mode must be WEB or VOICE"
[[ "$SERVICE" == "web" || "$SERVICE" == "voice" ]] || die "--service must be web or voice"
[[ "$RELEASE_MODE" == "${SERVICE^^}" ]] || die "--release-mode $RELEASE_MODE does not match --service $SERVICE"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] || die "--release-id must contain 8-80 safe characters"
[[ "$EXPECTED_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || die "--sha256 must be a 64-character SHA-256"
[[ "$ASSET_DELIVERY_MODE" == "auto" || "$ASSET_DELIVERY_MODE" == "disk" || "$ASSET_DELIVERY_MODE" == "cos" ]] || \
  die "ASSET_DELIVERY_MODE must be auto, disk, or cos"
[[ -n "$ARTIFACT" && -f "$ARTIFACT" && ! -L "$ARTIFACT" ]] || die "artifact must be an existing regular non-symlink file"
[[ "$RELEASE_ROOT" == /* ]] || die "--root must be an absolute Linux path"

for command_name in readlink sha256sum awk tar node mktemp grep head rm; do
  require_command "$command_name"
done
tar --version 2>/dev/null | head -n 1 | grep -q "GNU tar" || die "GNU tar is required for deterministic safe extraction"

ARTIFACT="$(readlink -f -- "$ARTIFACT")"
[[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || die "release root must already exist and cannot be a symlink"
RELEASE_ROOT="$(readlink -f -- "$RELEASE_ROOT")"
case "$RELEASE_ROOT" in
  /|/root|/home|/srv|/var|/www) die "release root is too broad: $RELEASE_ROOT" ;;
esac

ROOT_MARKER="$RELEASE_ROOT/.zimeiti-release-root"
[[ -f "$ROOT_MARKER" && ! -L "$ROOT_MARKER" ]] || die "missing regular server ownership marker: $ROOT_MARKER"

RELEASES_ROOT="$RELEASE_ROOT/releases"
STAGING_ROOT="$RELEASE_ROOT/staging"
CURRENT_LINK="$RELEASE_ROOT/current-$SERVICE"
CANDIDATE="$RELEASES_ROOT/$RELEASE_ID/$SERVICE"
SHARED_ROOT="$RELEASE_ROOT/shared"
ENV_ROOT="$SHARED_ROOT/env"
PROTECTED_ENV_FILE="$ENV_ROOT/.env.local"
APP_DATA_DIR="$SHARED_ROOT/data"
APP_RUNTIME_DIR="$SHARED_ROOT/runtime"
COMMERCE_DATA_DIR="$APP_RUNTIME_DIR/commerce-agent"
COMMERCE_DISCOVERY_ROOT="$APP_RUNTIME_DIR/commerce-discovery"
COMMERCE_DISCOVERY_CATALOG="$COMMERCE_DISCOVERY_ROOT/catalog.json"
COMMERCE_GATEWAY_KEY_FILE="$COMMERCE_DATA_DIR/main-gateway.key"
IDEMPOTENCY_DIR="$APP_RUNTIME_DIR/llm-request-idempotency"
UPLOAD_ROOT="$SHARED_ROOT/uploads"
LOG_ROOT="$SHARED_ROOT/logs"
BACKUP_ROOT="$SHARED_ROOT/backups"
VOICE_ROOT="$SHARED_ROOT/voice"
VOICE_DATABASE_PATH="$VOICE_ROOT/voice.db"
VOICE_REFERENCE_AUDIO_ROOT="$VOICE_ROOT/reference-audio"
ASSET_ROOT="$SHARED_ROOT/assets"
ASSET_RELEASES_ROOT="$ASSET_ROOT/releases"
ASSET_CURRENT_LINK="$ASSET_ROOT/current"

if [[ "$SERVICE" == "web" ]]; then
  APP_NAME="agent-hub-web"
  LIVE_PORT="5000"
  HEALTH_PATH="/api/version"
  READINESS_PATH="/api/release-readiness"
  CANDIDATE_PORT_MIN="15100"
  CANDIDATE_PORT_MAX="15149"
else
  APP_NAME="agent-hub-voice"
  LIVE_PORT="5001"
  HEALTH_PATH="/voice-platform"
  READINESS_PATH="/voice-platform/api/release-readiness"
  CANDIDATE_PORT_MIN="15150"
  CANDIDATE_PORT_MAX="15199"
fi

assert_regular_directory() {
  local directory="$1"
  local label="$2"
  [[ -d "$directory" && ! -L "$directory" ]] || die "$label must be a pre-provisioned regular directory: $directory"
}

assert_current_asset_pointer() {
  [[ -L "$ASSET_CURRENT_LINK" ]] || die "asset current pointer must be a symbolic link: $ASSET_CURRENT_LINK"
  local target
  target="$(readlink -f -- "$ASSET_CURRENT_LINK")" || die "asset current pointer is broken"
  [[ -d "$target" && ! -L "$target" ]] || die "asset current target is not a regular directory: $target"
  [[ "$target" == "$ASSET_RELEASES_ROOT"/* ]] || die "asset current target escapes the digest release root: $target"
  [[ "$(basename -- "$target")" =~ ^sha256-[0-9a-f]{64}$ ]] || die "asset current target is not content-addressed: $target"
  printf '%s\n' "$target"
}

assert_service_pointer_if_present() {
  [[ -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]] || return 0
  [[ -L "$CURRENT_LINK" ]] || die "service current pointer is not a symlink: $CURRENT_LINK"
  local target relative release_component
  target="$(readlink -f -- "$CURRENT_LINK")" || die "service current pointer is broken"
  [[ -d "$target" && ! -L "$target" ]] || die "service current target is not a regular directory: $target"
  [[ "$target" == "$RELEASES_ROOT"/* ]] || die "service current target escapes the release root: $target"
  relative="${target#"$RELEASES_ROOT"/}"
  [[ "$relative" == */"$SERVICE" && "$relative" != */*/* ]] || die "service current target has an invalid release layout: $target"
  release_component="${relative%/*}"
  [[ "$release_component" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] || die "service current target has an invalid release id: $target"
}

validate_shared_state() {
  assert_regular_directory "$SHARED_ROOT" "shared persistent root"
  assert_regular_directory "$ENV_ROOT" "shared protected environment root"
  [[ -f "$PROTECTED_ENV_FILE" && ! -L "$PROTECTED_ENV_FILE" && -r "$PROTECTED_ENV_FILE" ]] || \
    die "protected production environment must be a readable regular non-symlink file: $PROTECTED_ENV_FILE"
  [[ "$(stat -c '%u' -- "$PROTECTED_ENV_FILE")" == "0" ]] || \
    die "protected production environment must be owned by root"
  local protected_env_mode
  protected_env_mode="$(stat -c '%a' -- "$PROTECTED_ENV_FILE")"
  (( (8#$protected_env_mode & 8#077) == 0 )) || \
    die "protected production environment must not grant group or other permissions"
  assert_regular_directory "$APP_DATA_DIR" "shared data"
  assert_regular_directory "$APP_RUNTIME_DIR" "shared runtime"
  assert_regular_directory "$COMMERCE_DATA_DIR" "shared commerce data"
  assert_regular_directory "$COMMERCE_DISCOVERY_ROOT" "shared commerce discovery mirror"
  assert_regular_directory "$COMMERCE_DISCOVERY_ROOT/media" "shared commerce discovery media"
  [[ -f "$COMMERCE_DISCOVERY_CATALOG" && ! -L "$COMMERCE_DISCOVERY_CATALOG" && -r "$COMMERCE_DISCOVERY_CATALOG" ]] || \
    die "commerce discovery catalog must be a readable regular non-symlink file: $COMMERCE_DISCOVERY_CATALOG"
  [[ -f "$COMMERCE_GATEWAY_KEY_FILE" && ! -L "$COMMERCE_GATEWAY_KEY_FILE" && -r "$COMMERCE_GATEWAY_KEY_FILE" ]] || \
    die "commerce gateway key must be a readable regular non-symlink file: $COMMERCE_GATEWAY_KEY_FILE"
  [[ "$(stat -c '%u' -- "$COMMERCE_GATEWAY_KEY_FILE")" == "0" ]] || \
    die "commerce gateway key must be owned by root"
  local commerce_gateway_key_mode
  commerce_gateway_key_mode="$(stat -c '%a' -- "$COMMERCE_GATEWAY_KEY_FILE")"
  (( (8#$commerce_gateway_key_mode & 8#077) == 0 )) || \
    die "commerce gateway key must not grant group or other permissions"
  COMMERCE_GATEWAY_KEY_FILE="$COMMERCE_GATEWAY_KEY_FILE" node -e \
    'const fs=require("node:fs");const value=fs.readFileSync(process.env.COMMERCE_GATEWAY_KEY_FILE,"utf8").trim();if(value.length<40)process.exit(1)' || \
    die "commerce gateway key must contain at least 40 non-whitespace characters"
  assert_regular_directory "$IDEMPOTENCY_DIR" "shared idempotency runtime"
  assert_regular_directory "$UPLOAD_ROOT" "shared uploads"
  assert_regular_directory "$LOG_ROOT" "shared logs"
  assert_regular_directory "$BACKUP_ROOT" "shared backups"
  assert_regular_directory "$VOICE_ROOT" "shared Voice root"
  assert_regular_directory "$VOICE_REFERENCE_AUDIO_ROOT" "shared Voice reference audio"
  assert_regular_directory "$ASSET_ROOT" "shared asset root"
  assert_regular_directory "$ASSET_RELEASES_ROOT" "shared asset releases"
  local mutable_directory
  for mutable_directory in \
    "$APP_DATA_DIR" "$APP_RUNTIME_DIR" "$COMMERCE_DATA_DIR" "$IDEMPOTENCY_DIR" "$UPLOAD_ROOT" \
    "$LOG_ROOT" "$BACKUP_ROOT" "$VOICE_REFERENCE_AUDIO_ROOT"; do
    [[ -r "$mutable_directory" && -w "$mutable_directory" && -x "$mutable_directory" ]] || \
      die "mutable shared directory is not readable/writable/traversable by the deploy service user: $mutable_directory"
  done
  [[ -r "$RELEASE_ROOT" && -w "$RELEASE_ROOT" && -x "$RELEASE_ROOT" ]] || \
    die "release root is not readable/writable/traversable by the deploy service user: $RELEASE_ROOT"
  [[ -r "$ASSET_ROOT" && -w "$ASSET_ROOT" && -x "$ASSET_ROOT" ]] || \
    die "asset pointer root is not readable/writable/traversable by the deploy service user: $ASSET_ROOT"
  [[ -r "$ASSET_RELEASES_ROOT" && -x "$ASSET_RELEASES_ROOT" ]] || \
    die "asset release root is not readable/traversable by the deploy service user: $ASSET_RELEASES_ROOT"
  local managed_log
  for managed_log in \
    "$LOG_ROOT/agent-hub-web-error.log" \
    "$LOG_ROOT/agent-hub-web-out.log" \
    "$LOG_ROOT/agent-hub-voice-error.log" \
    "$LOG_ROOT/agent-hub-voice-out.log"; do
    if [[ -e "$managed_log" || -L "$managed_log" ]]; then
      [[ -f "$managed_log" && ! -L "$managed_log" && -w "$managed_log" ]] || \
        die "managed PM2 log path is not a writable regular non-symlink file: $managed_log"
    fi
  done
  [[ -f "$VOICE_DATABASE_PATH" && ! -L "$VOICE_DATABASE_PATH" && -s "$VOICE_DATABASE_PATH" && \
     -r "$VOICE_DATABASE_PATH" && -w "$VOICE_DATABASE_PATH" ]] || \
    die "persistent Voice database is missing, empty, a symlink, or not readable/writable: $VOICE_DATABASE_PATH"

  node - "$APP_DATA_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = fs.realpathSync(process.argv[2]);
const required = [
  "engine-configs.json",
  "custom-voices.json",
  "generations.json",
  "service-cards.json",
  "studio-config.json",
  "voices.json",
  "voice-studio/service-cards.json",
  "voice-studio/voices.json",
];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) throw new Error(`shared data contains a forbidden symlink: ${relativePath}`);
    if (stats.isDirectory()) walk(filePath);
    else if (!stats.isFile()) throw new Error(`shared data contains a non-regular entry: ${relativePath}`);
    else if (relativePath.endsWith(".json")) JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
}

for (const relativePath of required) {
  const filePath = path.join(root, ...relativePath.split("/"));
  if (!fs.existsSync(filePath)) throw new Error(`required shared data file is missing: ${relativePath}`);
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`required shared data path is not a regular file: ${relativePath}`);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (relativePath === "custom-voices.json" && !Array.isArray(parsed)) throw new Error("custom-voices.json must contain a JSON array");
}
walk(root);
NODE

  assert_current_asset_pointer >/dev/null
  assert_service_pointer_if_present
}

load_protected_environment() {
  local line key value first last required_name
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *=* ]] || die "protected production environment contains a malformed line"
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "protected production environment contains an invalid variable name"
    case "$key" in
      DIRECT_*|PM2_HOME|PUBLIC_ACCEPTANCE_URL|PATH|NODE_OPTIONS|NODE_ENV|PORT|HOSTNAME|RELEASE_ROOT|APP_DATA_DIR|APP_RUNTIME_DIR|COMMERCE_DATA_DIR|COMMERCE_DISCOVERY_CATALOG|COMMERCE_GATEWAY_KEY_FILE|IDEMPOTENCY_DIR|BACKUP_DIR|PUBLIC_ASSET_ROOT|STORAGE_LOCAL_BASE_PATH|VOICE_SQLITE_PATH|VOICE_REFERENCE_AUDIO_DIR|WEB_RELEASE_DIR|VOICE_RELEASE_DIR|VOICE_DATABASE_URL|ASSET_DIGEST|ASSET_MANIFEST_SHA256|RELEASE_ID|DEPLOY_COMMIT_SHA|DEPLOY_EXECUTION_APPROVED|EXPECTED_BUILD_ID|COZE_PROJECT_ENV)
        continue
        ;;
    esac
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if (( ${#value} >= 2 )); then
      first="${value:0:1}"
      last="${value: -1}"
      if [[ ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    export "$key=$value"
  done < "$PROTECTED_ENV_FILE"
  for required_name in COZE_SUPABASE_URL COZE_SUPABASE_ANON_KEY COZE_SUPABASE_SERVICE_ROLE_KEY JWT_SECRET; do
    [[ -n "${!required_name:-}" ]] || die "protected production environment is missing required variable: $required_name"
  done
}

case "$ARTIFACT" in
  *.tar.gz|*.tgz) TAR_COMPRESSION=(--gzip) ;;
  *.tar.zst) TAR_COMPRESSION=(--zstd) ;;
  *) die "supported immutable artifact extensions are .tar.gz, .tgz, and .tar.zst" ;;
esac

AUDIT_DIR="$(mktemp -d)"
STAGING_DIR=""
PAYLOAD_DIR=""
candidate_pid=""
APP_TEMP_LINK=""
ASSET_TEMP_LINK=""
HISTORY_FD=""
SWITCH_STARTED="0"
DEPLOY_COMPLETE="0"
IN_ROLLBACK="0"
ROLLBACK_ATTEMPTED="0"
ROLLBACK_SUCCEEDED="0"
FAILURE_CONTEXT=""
DIRECT_PREPARED="0"
DIRECT_ROLLBACK_COMPLETE="0"

# Optional direct-push transaction participant. The controller and every import
# are installed immutably in an identity-scoped root-owned directory. No hook
# supplied by the product archive or by the application environment is allowed.
direct_hook() {
  [[ -n "${DIRECT_HOOK_PATH:-}" ]] || return 0
  node - "$DIRECT_HOOK_PATH" "${DIRECT_HOOK_SHA256:-}" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [p,sha]=process.argv.slice(2);
if(!/^\/data\/direct-deploy\/bin\/V[1-9][0-9]*\.[0-9]+-[a-f0-9]{12}\/transaction-hook\.mjs$/.test(p)||!/^[a-f0-9]{64}$/.test(sha))throw Error('DIRECT_HOOK_IDENTITY_INVALID');
for(let d=path.dirname(p);;d=path.dirname(d)){const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(d)!==d||s.uid!==0||s.gid!==0||(s.mode&0o022))throw Error('DIRECT_HOOK_DIRECTORY_UNSAFE');if(d==='/')break;}
const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==0||s.gid!==0||(s.mode&0o077)||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==sha)throw Error('DIRECT_HOOK_CHANGED');
NODE
  [[ "$?" -eq 0 ]] || return 1
  node "$DIRECT_HOOK_PATH" "$1" "${DIRECT_TRANSACTION_ROOT:?}"
}

cleanup_candidate() {
  if [[ -n "$candidate_pid" ]] && kill -0 "$candidate_pid" 2>/dev/null; then
    kill "$candidate_pid" 2>/dev/null || true
    local attempt
    for ((attempt = 1; attempt <= 25; attempt += 1)); do
      kill -0 "$candidate_pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$candidate_pid" 2>/dev/null; then kill -KILL "$candidate_pid" 2>/dev/null || true; fi
    wait "$candidate_pid" 2>/dev/null || true
  fi
  candidate_pid=""
}

safe_remove_staging() {
  [[ -n "$STAGING_DIR" ]] || return 0
  case "$STAGING_DIR" in
    "$STAGING_ROOT"/*)
      [[ "$STAGING_DIR" != "$STAGING_ROOT" && "$STAGING_DIR" != "$RELEASE_ROOT" ]] || return 1
      rm -rf -- "$STAGING_DIR"
      ;;
    *) return 1 ;;
  esac
}

final_cleanup() {
  local exit_status=$?
  # EXIT cleanup is the last-resort rollback coordinator. Disable every
  # re-entry path before it inspects state or calls any fallback so a second
  # signal/ERR/EXIT cannot race the first rollback attempt.
  trap - EXIT ERR
  trap '' HUP INT TERM
  set +e
  if [[ "$SWITCH_STARTED" == "1" && "$DEPLOY_COMPLETE" != "1" && "$ROLLBACK_ATTEMPTED" != "1" ]] && \
     declare -F rollback_release >/dev/null 2>&1; then
    FAILURE_CONTEXT="${FAILURE_CONTEXT:-exit=$exit_status}"
    if ! rollback_release "EXIT cleanup before deployment commit (exit $exit_status)"; then
      FAILURE_CONTEXT="${FAILURE_CONTEXT};rollback=failed"
      [[ "$exit_status" -ne 0 ]] || exit_status=1
    fi
    set +e
  fi
  cleanup_candidate
  if [[ "$DIRECT_PREPARED" == "1" && "$DEPLOY_COMPLETE" != "1" && "$DIRECT_ROLLBACK_COMPLETE" != "1" ]]; then
    if direct_hook rollback-before && direct_hook rollback-after; then
      DIRECT_ROLLBACK_COMPLETE="1"
    else
      FAILURE_CONTEXT="${FAILURE_CONTEXT};direct-rollback=unconfirmed"
      exit_status=1
    fi
  fi
  if [[ -n "$APP_TEMP_LINK" && -L "$APP_TEMP_LINK" ]]; then rm -- "$APP_TEMP_LINK" || true; fi
  if [[ -n "$ASSET_TEMP_LINK" && -L "$ASSET_TEMP_LINK" ]]; then rm -- "$ASSET_TEMP_LINK" || true; fi
  if [[ -n "$HISTORY_FD" ]]; then
    if [[ "$DEPLOY_COMPLETE" != "1" ]]; then
      printf '%s\tFAILED\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$(date -u +%FT%TZ)" "$RELEASE_ID" "$SERVICE" "${ACTUAL_SHA256,,}" "$COMMIT_SHA" "${ASSET_DIGEST:--}" "$DEPLOY_ACTOR" "${FAILURE_CONTEXT:-exit=$exit_status}" \
        >&"$HISTORY_FD" || true
    fi
    exec {HISTORY_FD}>&- || true
  fi
  if [[ -n "$STAGING_DIR" ]]; then safe_remove_staging || true; fi
  if [[ -n "$AUDIT_DIR" && -d "$AUDIT_DIR" ]]; then rm -rf -- "$AUDIT_DIR" || true; fi
  exit "$exit_status"
}
trap final_cleanup EXIT

archive_audit() {
  local names_file="$AUDIT_DIR/archive-names.txt"
  local types_file="$AUDIT_DIR/archive-types.txt"
  tar "${TAR_COMPRESSION[@]}" --list --quoting-style=escape --file "$ARTIFACT" >"$names_file"
  tar "${TAR_COMPRESSION[@]}" --list --verbose --quoting-style=escape --file "$ARTIFACT" >"$types_file"

  node - "$names_file" "$types_file" <<'NODE'
const fs = require("node:fs");
const [namesPath, typesPath] = process.argv.slice(2);
const names = fs.readFileSync(namesPath, "utf8").split("\n").filter(Boolean);
const verbose = fs.readFileSync(typesPath, "utf8").split("\n").filter(Boolean);
if (names.length === 0) throw new Error("archive is empty");
if (verbose.length !== names.length) throw new Error("archive listing/type count mismatch");
const seen = new Set();
const normalizedNames = new Set();
for (const line of verbose) {
  const type = line[0];
  if (type !== "-" && type !== "d") throw new Error(`archive contains a forbidden non-regular entry type: ${type || "unknown"}`);
}
for (const rawName of names) {
  if (/[\\\u0000-\u001f\u007f]/u.test(rawName)) throw new Error("archive path contains a control character or escape");
  if (rawName.startsWith("/") || /^[A-Za-z]:/u.test(rawName)) throw new Error(`archive path is absolute: ${rawName}`);
  let name = rawName;
  while (name.startsWith("./")) name = name.slice(2);
  name = name.replace(/\/+$/u, "");
  if (!name || name === ".") continue;
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`archive path is unsafe: ${rawName}`);
  if (seen.has(name)) throw new Error(`archive contains a duplicate path: ${name}`);
  seen.add(name);
  normalizedNames.add(name);
}
  for (const required of ["release-manifest.json", "server.js", ".release/ecosystem.config.cjs"]) {
  if (!normalizedNames.has(required)) throw new Error(`archive is missing required member: ${required}`);
}
NODE
  verify_sensitive_artifact_paths archive "$names_file" "$types_file"
}

extract_named_member() {
  local archive_name="$1"
  local output_path="$2"
  tar "${TAR_COMPRESSION[@]}" --extract --to-stdout --file "$ARTIFACT" -- "$archive_name" >"$output_path"
  [[ -s "$output_path" ]] || fail "archive member is empty: $archive_name"
}

validate_manifest_contract() {
  local manifest_path="$1"
  local metadata_path="$2"
  node - "$manifest_path" "$RELEASE_ID" "$SERVICE" "$metadata_path" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const [manifestPath, releaseId, service, metadataPath] = process.argv.slice(2);
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const hex64 = /^[0-9a-f]{64}$/u;
const sensitiveDataExtensions = new Set(["", ".bin", ".conf", ".config", ".csv", ".dat", ".ini", ".json", ".properties", ".txt", ".xml", ".yaml", ".yml"]);
const privateKeyExtensions = new Set([".key", ".keystore", ".p12", ".pfx"]);
const sensitiveNameMarker = /(^|[._-])(?:api[._-]?key|private[._-]?key|secret(?:s)?|token(?:s)?|cookie(?:s)?|credential(?:s)?|service[._-]?account)(?=$|[._-])/iu;
const gitHash = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
function requireCondition(condition, message) { if (!condition) throw new Error(message); }

requireCondition(manifest.schemaVersion === 2, "release manifest schemaVersion must be 2");
requireCondition(manifest.projectId === "zimeiti-caopanshou", "release manifest project identity mismatch");
requireCondition(manifest.kind === "immutable-standalone-service-artifact", "unexpected artifact kind");
requireCondition(manifest.releaseId === releaseId, "release id mismatch");
requireCondition(manifest.service === service, "service mismatch");
requireCondition(manifest.deployable === true, "artifact is a rehearsal/non-deployable artifact");
requireCondition(manifest.rehearsal === false, "deployable artifact cannot be marked as a rehearsal");
requireCondition(typeof manifest.commitSha === "string" && gitHash.test(manifest.commitSha), "invalid Git commit SHA");
requireCondition(typeof manifest.buildId === "string" && /^[A-Za-z0-9._-]{1,256}$/u.test(manifest.buildId), "missing or unsafe build id");
requireCondition(typeof manifest.sourceManifestSha256 === "string" && hex64.test(manifest.sourceManifestSha256), "invalid source manifest SHA-256");
requireCondition(typeof manifest.sourceFingerprint === "string" && hex64.test(manifest.sourceFingerprint), "invalid source fingerprint");
requireCondition(typeof manifest.builtAt === "string" && Number.isFinite(Date.parse(manifest.builtAt)), "invalid build timestamp provenance");
requireCondition(typeof manifest.packagedAt === "string" && Number.isFinite(Date.parse(manifest.packagedAt)) && Date.parse(manifest.packagedAt) >= Date.parse(manifest.builtAt), "invalid package timestamp provenance");
if (service === "web") {
  requireCondition(typeof manifest.assetDigest === "string" && hex64.test(manifest.assetDigest), "Web artifact requires an asset digest");
  requireCondition(typeof manifest.assetManifestSha256 === "string" && hex64.test(manifest.assetManifestSha256), "Web artifact requires an asset manifest SHA-256");
  requireCondition(manifest.assetVersion === `sha256-${manifest.assetDigest}`, "Web artifact asset version/digest mismatch");
}
if (manifest.assetDigest !== null && manifest.assetDigest !== undefined) requireCondition(typeof manifest.assetDigest === "string" && hex64.test(manifest.assetDigest), "invalid asset digest");
if (manifest.assetManifestSha256 !== null && manifest.assetManifestSha256 !== undefined) requireCondition(typeof manifest.assetManifestSha256 === "string" && hex64.test(manifest.assetManifestSha256), "invalid asset manifest SHA-256");
requireCondition(manifest.healthPath === (service === "web" ? "/api/version" : "/voice-platform"), "health path contract mismatch");
requireCondition(manifest.readinessPath === (service === "web" ? "/api/release-readiness" : "/voice-platform/api/release-readiness"), "readiness path contract mismatch");
requireCondition(manifest.port === (service === "web" ? 5000 : 5001), "service port contract mismatch");

const build = manifest.buildEnvironment;
requireCondition(build && typeof build === "object" && !Array.isArray(build), "missing buildEnvironment");
requireCondition(build.platform === "linux", "artifact was not built on Linux");
requireCondition(build.arch === "x64", "production artifact architecture must be x64");
requireCondition(build.arch === process.arch, `artifact architecture ${String(build.arch)} does not match server ${process.arch}`);
requireCondition(String(build.nodeModulesAbi) === String(process.versions.modules), `Node module ABI ${String(build.nodeModulesAbi)} does not match server ${process.versions.modules}`);
const requiredNodeVersion = "24.19.0";
requireCondition(build.nodeVersion === `v${requiredNodeVersion}`, `production artifact must be built with exact Node v${requiredNodeVersion}`);
requireCondition(process.versions.node === requiredNodeVersion, `deployment server must run exact Node ${requiredNodeVersion}; current=${process.versions.node}`);
requireCondition(typeof build.pnpmVersion === "string" && /^\d+\.\d+\.\d+/u.test(build.pnpmVersion), "invalid pnpm version provenance");
requireCondition(build.pnpmVersion === "9.0.0", "production artifact must be built with pnpm 9.0.0");
requireCondition(typeof build.lockfileSha256 === "string" && hex64.test(build.lockfileSha256), "invalid lockfile SHA-256 provenance");
requireCondition(build.libc === "glibc" || build.libc === "musl", "build libc must be glibc or musl");
const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
const reportText = report ? JSON.stringify([report.header, report.sharedObjects]) : "";
const serverLibc = report?.header?.glibcVersionRuntime ? "glibc" : (/musl/iu.test(reportText) ? "musl" : null);
requireCondition(serverLibc !== null, "unable to determine server libc; deployment fails closed");
requireCondition(build.libc === serverLibc, `artifact libc ${build.libc} does not match server ${serverLibc}`);

const metadata = {
  releaseId: manifest.releaseId,
  service: manifest.service,
  commitSha: manifest.commitSha,
  buildId: manifest.buildId,
  sourceManifestSha256: manifest.sourceManifestSha256,
  assetDigest: manifest.assetDigest ?? null,
  assetVersion: manifest.assetDigest ? `sha256-${manifest.assetDigest}` : null,
  assetManifestSha256: manifest.assetManifestSha256 ?? null,
  manifestSha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"),
};
fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600 });
NODE
}

metadata_value() {
  local key="$1"
  node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]]; if (value === null || value === undefined) process.exit(3); process.stdout.write(String(value));' "$MANIFEST_METADATA" "$key"
}

validate_payload_inventory() {
  local payload="$1"
  node - "$payload" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = fs.realpathSync(process.argv[2]);
const manifestPath = path.join(root, "release-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const expected = Array.isArray(manifest.files) ? manifest.files : null;
if (!expected) throw new Error("release manifest files must be an array");
const hex64 = /^[0-9a-f]{64}$/u;
const sensitiveDataExtensions = new Set(["", ".bin", ".conf", ".config", ".csv", ".dat", ".ini", ".json", ".properties", ".txt", ".xml", ".yaml", ".yml"]);
const privateKeyExtensions = new Set([".key", ".keystore", ".p12", ".pfx"]);
const sensitiveNameMarker = /(^|[._-])(?:api[._-]?key|private[._-]?key|secret(?:s)?|token(?:s)?|cookie(?:s)?|credential(?:s)?|service[._-]?account)(?=$|[._-])/iu;

function validateRelative(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(relativePath)) return false;
  if (relativePath.startsWith("/") || /^[A-Za-z]:/u.test(relativePath)) return false;
  const parts = relativePath.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && path.posix.normalize(relativePath) === relativePath;
}

function isKnownNonSecretDependencySchema(relativePath) {
  const normalizedPath = relativePath.toLowerCase();
  const schemaPath = "node_modules/har-schema/lib/cookie.json";
  return normalizedPath === schemaPath || normalizedPath.endsWith(`/${schemaPath}`);
}

function sensitiveReason(relativePath, kind = "file") {
  const parts = relativePath.split("/");
  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    if (lowerPart === ".env" || lowerPart.startsWith(".env.")) return "environment file";
    if (lowerPart === ".npmrc") return "package-manager credential file";
    if (lowerPart === ".secure") return "secure-material path";
  }
  if (kind !== "file") return null;
  if (isKnownNonSecretDependencySchema(relativePath)) return null;
  const fileName = parts.at(-1).toLowerCase();
  const extension = path.posix.extname(fileName);
  if (privateKeyExtensions.has(extension)) return "private-key container";
  if (["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"].includes(fileName)) return "SSH private key";
  if (sensitiveDataExtensions.has(extension)) {
    const stem = extension ? fileName.slice(0, -extension.length) : fileName;
    if (sensitiveNameMarker.test(stem)) return "credential, key, token, cookie, or secret data file";
  }
  return null;
}

function assertNotSensitive(relativePath, label, kind = "file") {
  const reason = sensitiveReason(relativePath, kind);
  if (reason) throw new Error(`${label} contains forbidden sensitive path (${reason}): ${relativePath}`);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

const actualPaths = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    const stats = fs.lstatSync(filePath);
    assertNotSensitive(relativePath, "extracted payload", stats.isDirectory() ? "directory" : "file");
    if (stats.isSymbolicLink()) throw new Error(`extracted payload contains a symlink: ${relativePath}`);
    if (stats.isDirectory()) walk(filePath);
    else if (stats.isFile()) { if (relativePath !== "release-manifest.json") actualPaths.push(relativePath); }
    else throw new Error(`extracted payload contains a non-regular entry: ${relativePath}`);
  }
}
walk(root);
actualPaths.sort((left, right) => left.localeCompare(right, "en"));
for (const relativePath of actualPaths) {
  if (relativePath === "public/storyboard-reviews" || relativePath.startsWith("public/storyboard-reviews/") ||
      relativePath === "public/demo-assets" || relativePath.startsWith("public/demo-assets/")) {
    throw new Error(`test/evidence content is forbidden in a production service artifact: ${relativePath}`);
  }
}

const seen = new Set();
let previousPath = "";
let totalBytes = 0;
for (const file of expected) {
  if (!validateRelative(file?.path)) throw new Error(`unsafe manifest inventory path: ${String(file?.path)}`);
  assertNotSensitive(file.path, "manifest inventory");
  if (seen.has(file.path)) throw new Error(`duplicate manifest inventory path: ${file.path}`);
  if (previousPath && previousPath.localeCompare(file.path, "en") >= 0) throw new Error("manifest inventory is not strictly sorted");
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !hex64.test(file.sha256)) throw new Error(`invalid inventory metadata: ${file.path}`);
  seen.add(file.path);
  previousPath = file.path;
  totalBytes += file.bytes;
}
if (actualPaths.length !== expected.length || actualPaths.some((value, index) => value !== expected[index].path)) throw new Error("extracted file set does not exactly match the signed inventory");
for (const file of expected) {
  const filePath = path.join(root, ...file.path.split("/"));
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`inventory entry is not a regular file: ${file.path}`);
  if (stats.size !== file.bytes) throw new Error(`inventory byte count mismatch: ${file.path}`);
  if (sha256File(filePath) !== file.sha256) throw new Error(`inventory SHA-256 mismatch: ${file.path}`);
}
const artifactDigest = crypto.createHash("sha256").update(expected.map((file) => `${file.sha256}  ${file.path}\n`).join("")).digest("hex");
if (manifest.artifactDigest !== artifactDigest) throw new Error("artifact digest mismatch");
if (manifest.fileCount !== expected.length) throw new Error("artifact fileCount mismatch");
if (manifest.totalBytes !== totalBytes) throw new Error("artifact totalBytes mismatch");
for (const required of ["server.js", ".release/ecosystem.config.cjs"]) if (!seen.has(required)) throw new Error(`artifact inventory omits required runtime file: ${required}`);

for (const required of [".next/BUILD_ID", ".release/source-files.v1.json", ".release/build-provenance.v1.json"]) {
  if (!seen.has(required)) throw new Error(`artifact inventory omits required provenance file: ${required}`);
}
const embeddedBuildId = fs.readFileSync(path.join(root, ".next", "BUILD_ID"), "utf8").trim();
if (embeddedBuildId !== manifest.buildId) throw new Error("embedded BUILD_ID does not match release manifest");
const sourceManifestPath = path.join(root, ".release", "source-files.v1.json");
if (sha256File(sourceManifestPath) !== manifest.sourceManifestSha256) throw new Error("embedded source manifest SHA-256 mismatch");
const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
if (sourceManifest.schemaVersion !== 1 || sourceManifest.projectId !== manifest.projectId || sourceManifest.kind !== "clean-source-snapshot") {
  throw new Error("embedded source manifest identity/schema mismatch");
}
if (sourceManifest.sourceFingerprint !== manifest.sourceFingerprint) throw new Error("source fingerprint provenance mismatch");
const expectedLockfilePath = manifest.service === "web" ? "pnpm-lock.yaml" : "voice-platform/pnpm-lock.yaml";
const sourceLockfiles = Array.isArray(sourceManifest.files)
  ? sourceManifest.files.filter((file) => file?.path === expectedLockfilePath)
  : [];
if (sourceLockfiles.length !== 1 || sourceLockfiles[0].path !== expectedLockfilePath ||
    sourceLockfiles[0].sha256 !== manifest.buildEnvironment.lockfileSha256) {
  throw new Error(`source manifest and ${manifest.service} build lockfile path/SHA-256 provenance mismatch: ${expectedLockfilePath}`);
}
if (manifest.service === "web" && (sourceManifest.assetManifestSha256 !== manifest.assetManifestSha256 || sourceManifest.assetDigest !== manifest.assetDigest)) {
  throw new Error("source and Web asset provenance are not pinned together");
}

const provenance = JSON.parse(fs.readFileSync(path.join(root, ".release", "build-provenance.v1.json"), "utf8"));
if (provenance.schemaVersion !== 1 || provenance.projectId !== manifest.projectId || provenance.kind !== "release-build-provenance") {
  throw new Error("embedded build provenance identity/schema mismatch");
}
for (const key of ["service", "sourceManifestSha256", "sourceFingerprint", "buildId", "builtAt"]) {
  if (provenance[key] !== manifest[key]) throw new Error(`build provenance mismatch: ${key}`);
}
if (provenance.sourceCommit !== manifest.commitSha || provenance.deployable !== true || provenance.rehearsal !== false) {
  throw new Error("build provenance commit/deployable identity mismatch");
}
if (!/^[0-9a-f]{64}$/u.test(sourceManifest.policySha256) || provenance.policySha256 !== sourceManifest.policySha256) {
  throw new Error("source/build release-policy provenance mismatch");
}
for (const key of ["platform", "arch", "nodeVersion", "nodeModulesAbi", "libc", "pnpmVersion", "lockfileSha256"]) {
  if (provenance.buildEnvironment?.[key] !== manifest.buildEnvironment?.[key]) throw new Error(`build environment provenance mismatch: ${key}`);
}
if (manifest.service === "web") {
  for (const key of ["assetManifestSha256", "assetDigest", "assetVersion"]) {
    if (provenance[key] !== manifest[key]) throw new Error(`Web build/asset provenance mismatch: ${key}`);
  }
} else if (sourceManifest.assetManifestSha256 !== provenance.assetManifestSha256 || sourceManifest.assetDigest !== provenance.assetDigest) {
  throw new Error("Voice build and source asset provenance are not pinned together");
}
NODE
}

seal_candidate_release() {
  local target="$1"
  [[ "$EUID" -eq 0 ]] || return 1
  [[ -d "$target" && ! -L "$target" && "$target" == "$CANDIDATE" ]] || return 1
  [[ -d "$RELEASE_PARENT" && ! -L "$RELEASE_PARENT" ]] || return 1

  # Protect both the bytes and the directory entries that name them. Execute
  # deployments run as root; mutable business paths under shared/ retain their
  # independently provisioned ownership and are never included here.
  chown root:root -- "$RELEASE_ROOT" "$RELEASES_ROOT" "$RELEASE_PARENT" || return 1
  chmod 0755 -- "$RELEASE_ROOT" "$RELEASES_ROOT" || return 1
  chmod 0555 -- "$RELEASE_PARENT" || return 1
  chown --recursive --no-dereference -- root:root "$target" || return 1
  find "$target" -type d -exec chmod 0555 -- {} + || return 1
  find "$target" -type f -perm /111 -exec chmod 0555 -- {} + || return 1
  find "$target" -type f ! -perm /111 -exec chmod 0444 -- {} + || return 1
}

verify_candidate_release_seal() {
  local target="$1"
  node - "$target" "$RELEASE_ROOT" "$RELEASES_ROOT" "$RELEASE_PARENT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [targetInput, releaseRootInput, releasesRootInput, releaseParentInput] = process.argv.slice(2);
const target = fs.realpathSync(targetInput);

function assertDirectorySeal(input, expectedMode, label) {
  const resolved = fs.realpathSync(input);
  const stats = fs.lstatSync(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  if (stats.uid !== 0 || stats.gid !== 0) throw new Error(`${label} is not root:root owned`);
  if ((stats.mode & 0o777) !== expectedMode) throw new Error(`${label} mode is not ${expectedMode.toString(8)}`);
  return resolved;
}

const releaseRoot = assertDirectorySeal(releaseRootInput, 0o755, "release root");
const releasesRoot = assertDirectorySeal(releasesRootInput, 0o755, "releases root");
const releaseParent = assertDirectorySeal(releaseParentInput, 0o555, "release parent");
if (path.dirname(releasesRoot) !== releaseRoot || path.dirname(releaseParent) !== releasesRoot || path.dirname(target) !== releaseParent) {
  throw new Error("sealed candidate containment identity is invalid");
}

function walk(entryPath) {
  const stats = fs.lstatSync(entryPath);
  const relativePath = path.relative(target, entryPath).split(path.sep).join("/") || ".";
  if (stats.isSymbolicLink()) throw new Error(`sealed candidate contains a symlink: ${relativePath}`);
  if (stats.uid !== 0 || stats.gid !== 0) throw new Error(`sealed candidate entry is not root:root owned: ${relativePath}`);
  const mode = stats.mode & 0o777;
  if (stats.isDirectory()) {
    if (mode !== 0o555) throw new Error(`sealed candidate directory mode is not 0555: ${relativePath}`);
    for (const name of fs.readdirSync(entryPath)) walk(path.join(entryPath, name));
    return;
  }
  if (!stats.isFile() || stats.nlink !== 1) throw new Error(`sealed candidate contains a non-regular or hard-linked entry: ${relativePath}`);
  if (mode !== 0o444 && mode !== 0o555) throw new Error(`sealed candidate file mode is not 0444/0555: ${relativePath}`);
}

walk(target);
NODE
}

read_asset_release_backend() {
  local target="$1"
  local expected_digest="$2"
  node - "$target" "$expected_digest" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [targetPath, expectedDigest] = process.argv.slice(2);
const hex64 = /^[0-9a-f]{64}$/u;
if (!hex64.test(expectedDigest)) throw new Error("invalid expected asset digest");
const target = fs.realpathSync(targetPath);
if (path.basename(target) !== `sha256-${expectedDigest}`) throw new Error("asset release directory does not match expected digest");
const readyPath = path.join(target, ".release", "public-assets.ready.v1.json");
const stats = fs.lstatSync(readyPath);
if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size <= 0 || stats.size > 64 * 1024) {
  throw new Error("asset READY receipt is unsafe or unbounded");
}
const receipt = JSON.parse(fs.readFileSync(readyPath, "utf8"));
if (receipt.schemaVersion !== 1 || receipt.projectId !== "zimeiti-caopanshou" ||
    receipt.kind !== "public-assets-readiness-receipt" || receipt.status !== "READY") {
  throw new Error("asset READY receipt identity is invalid");
}
if (receipt.assetDigest !== expectedDigest || receipt.assetVersion !== `sha256-${expectedDigest}` ||
    receipt.location !== target || receipt.verificationMode !== "full-sha256" ||
    receipt.issuerId !== "install-public-asset-release-vnext") {
  throw new Error("asset READY receipt is not bound to its immutable release");
}
if (receipt.storageBackend !== "disk" && receipt.storageBackend !== "cos") {
  throw new Error("asset READY receipt storageBackend must be disk or cos");
}
process.stdout.write(`${receipt.storageBackend}\n`);
NODE
}

validate_asset_release() {
  local embedded_manifest="$1"
  local expected_digest="$2"
  local target="$3"
  local expected_manifest_sha="${4:-}"
  local delivery_mode="$5"
  [[ "$delivery_mode" == "disk" || "$delivery_mode" == "cos" ]] || return 1
  node - "$embedded_manifest" "$expected_digest" "$target" "$expected_manifest_sha" "$delivery_mode" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [embeddedPath, expectedDigest, targetPath, expectedManifestSha, deliveryMode] = process.argv.slice(2);
const hex64 = /^[0-9a-f]{64}$/u;
const productionRoots = new Set([
  "product-assets",
  "youcai-media",
  "short-drama",
  "cover-references",
  "avatars",
  "cover-presets",
  "help",
  "cover-assets",
  "cover-generated-samples",
  "official-home",
  "downloads",
  "model-brands",
]);
const forbiddenEvidenceRoots = new Set(["storyboard-reviews", "demo-assets"]);
const cosRedirectedBinaryExtensions = new Set([
  ".aac", ".avi", ".flac", ".gif", ".ico", ".jpeg", ".jpg", ".m4a", ".m4v", ".mkv", ".mov",
  ".mp3", ".mp4", ".mpeg", ".mpg", ".ogg", ".pdf", ".png", ".svg", ".wav", ".webm", ".webp", ".zip",
]);
const maxReceiptBytes = 64 * 1024;
const maxManifestBytes = 16 * 1024 * 1024;
const manifestRelativePath = ".release/public-assets.v1.json";
const transportRelativePath = ".release/public-assets.bundle.v1.json";
const cosPublisherRelativePath = ".release/public-assets.cos.ready.v1.json";
const readyRelativePath = ".release/public-assets.ready.v1.json";
const materializerId = "materialize-public-asset-release-vnext";
const installerId = "install-public-asset-release-vnext";
const publisherId = "publish-public-assets-cos-vnext";
const supportedPublisherScriptSha256 = "0946a03c20f0df7cd7e5f3d2894ffd60bb5420b043ec3ec76fd7f1ea7c2ad086";
const remoteVerification = "head-content-type-cache-control-metadata-sha256-and-full-body-sha256";
const overwriteProtocol = "put-object-forbid-overwrite";
const publicationOrder = "assets-then-manifest-then-ready";
function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function requireExactKeys(value, expectedKeys, label) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be a JSON object`);
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...expectedKeys].sort((left, right) => left.localeCompare(right, "en"));
  requireCondition(actual.length === expected.length && actual.every((entry, index) => entry === expected[index]), `${label} contains missing or unexpected fields`);
}
function readReceipt(filePath, label) {
  const stats = fs.lstatSync(filePath);
  requireCondition(stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1 && stats.size > 0 && stats.size <= maxReceiptBytes, `${label} is unsafe or exceeds ${maxReceiptBytes} bytes`);
  const bytes = fs.readFileSync(filePath);
  requireCondition(bytes.length === stats.size, `${label} changed while being read`);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}
function requireVerifiedAt(value, label) {
  requireCondition(typeof value === "string" && Number.isFinite(Date.parse(value)), `${label} verifiedAt is invalid`);
}
function validateCosLocation(value, assetVersion) {
  requireCondition(typeof value === "string" && value.startsWith("cos://") && !/[\\?#]/u.test(value), "COS remote location is not canonical");
  const withoutScheme = value.slice("cos://".length);
  const slashIndex = withoutScheme.indexOf("/");
  requireCondition(slashIndex > 0 && slashIndex < withoutScheme.length - 1, "COS remote location must include bucket and prefix");
  const bucket = withoutScheme.slice(0, slashIndex);
  const key = withoutScheme.slice(slashIndex + 1);
  requireCondition(/^[a-z0-9][a-z0-9.-]*$/u.test(bucket), "COS remote bucket is not canonical");
  const segments = key.split("/");
  requireCondition(segments.every((segment) => segment && segment !== "." && segment !== ".."), "COS remote prefix contains an unsafe segment");
  requireCondition(segments.at(-1) === assetVersion, "COS remote location is not bound to the asset version");
  return value;
}
function validRelative(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(relativePath)) return false;
  if (relativePath.startsWith("/") || /^[A-Za-z]:/u.test(relativePath)) return false;
  const parts = relativePath.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && path.posix.normalize(relativePath) === relativePath;
}
if (!hex64.test(expectedDigest)) throw new Error("invalid expected asset digest");
const target = fs.realpathSync(targetPath);
if (path.basename(target) !== `sha256-${expectedDigest}`) throw new Error("asset release directory does not match expected digest");

const targetStats = fs.lstatSync(target);
requireCondition(targetStats.isDirectory() && !targetStats.isSymbolicLink(), "asset release root is not a real directory");
const serverManifestPath = path.join(target, ...manifestRelativePath.split("/"));
const transportPath = path.join(target, ...transportRelativePath.split("/"));
const cosPublisherPath = path.join(target, ...cosPublisherRelativePath.split("/"));
const receiptPath = path.join(target, ...readyRelativePath.split("/"));
const metadataDirectory = path.join(target, ".release");
const metadataStats = fs.lstatSync(metadataDirectory);
if (!metadataStats.isDirectory() || metadataStats.isSymbolicLink()) throw new Error("asset release metadata directory is not a regular directory");
const requiredMetadataPaths = [serverManifestPath, transportPath, receiptPath];
if (deliveryMode === "cos") requiredMetadataPaths.push(cosPublisherPath);
for (const filePath of requiredMetadataPaths) {
  if (!fs.existsSync(filePath)) throw new Error(`asset release metadata is missing: ${filePath}`);
  const stats = fs.lstatSync(filePath);
  const sizeLimit = filePath === serverManifestPath ? maxManifestBytes : maxReceiptBytes;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size <= 0 || stats.size > sizeLimit) {
    throw new Error(`asset release metadata is not a bounded single-link regular file: ${filePath}`);
  }
}

const embeddedStats = fs.lstatSync(embeddedPath);
requireCondition(embeddedStats.isFile() && !embeddedStats.isSymbolicLink() && embeddedStats.nlink === 1 && embeddedStats.size > 0 && embeddedStats.size <= maxManifestBytes, "embedded asset manifest is unsafe or too large");
const embeddedBytes = fs.readFileSync(embeddedPath);
const serverBytes = fs.readFileSync(serverManifestPath);
const manifestSha256 = crypto.createHash("sha256").update(embeddedBytes).digest("hex");
const serverManifestSha256 = crypto.createHash("sha256").update(serverBytes).digest("hex");
if (manifestSha256 !== serverManifestSha256) throw new Error("server asset manifest does not match the code artifact");
if (expectedManifestSha && expectedManifestSha !== manifestSha256) throw new Error("release-manifest asset manifest SHA-256 mismatch");

const manifest = JSON.parse(embeddedBytes.toString("utf8"));
if (manifest.schemaVersion !== 1 || manifest.projectId !== "zimeiti-caopanshou" || manifest.kind !== "public-assets") throw new Error("invalid public asset manifest identity/schema");
if (!hex64.test(manifest.assetPolicySha256) || manifest.contentAddressing !== "sha256-files-and-asset-policy" || manifest.mutableUploadsIncluded !== false) {
  throw new Error("public asset manifest content-addressing/policy/mutable-data boundary is invalid");
}
if (manifest.digest !== expectedDigest || manifest.assetVersion !== `sha256-${expectedDigest}`) throw new Error("public asset manifest digest/version mismatch");
if (!Array.isArray(manifest.files)) throw new Error("public asset manifest files must be an array");
const publicDirectory = path.join(target, "public");
const publicStats = fs.lstatSync(publicDirectory);
if (!publicStats.isDirectory() || publicStats.isSymbolicLink()) throw new Error("asset release public root is not a regular directory");
let totalBytes = 0;
let transportFileCount = 0;
let transportBytes = 0;
let previousPath = "";
const seen = new Set();
const manifestByPath = new Map();
for (const file of manifest.files) {
  if (!validRelative(file?.path) || !file.path.startsWith("public/") || file.path.startsWith("public/uploads/")) throw new Error(`out-of-bound public asset path: ${String(file?.path)}`);
  const parts = file.path.split("/");
  const externalRoot = parts[1];
  if (forbiddenEvidenceRoots.has(externalRoot)) throw new Error(`test/evidence content is forbidden in a production asset release: ${file.path}`);
  if (!productionRoots.has(externalRoot)) throw new Error(`public asset path is outside the production root allowlist: ${file.path}`);
  if (seen.has(file.path) || (previousPath && previousPath.localeCompare(file.path, "en") >= 0)) throw new Error("public asset manifest paths are duplicated or unsorted");
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !hex64.test(file.sha256)) throw new Error(`invalid public asset inventory metadata: ${file.path}`);
  seen.add(file.path);
  manifestByPath.set(file.path, file);
  previousPath = file.path;
  totalBytes += file.bytes;
  requireCondition(Number.isSafeInteger(totalBytes), "public asset byte total exceeds safe integer range");

  const extension = path.posix.extname(file.path).toLowerCase();
  const mustExistLocally = deliveryMode === "disk" || !cosRedirectedBinaryExtensions.has(extension);
  if (mustExistLocally) {
    transportFileCount += 1;
    transportBytes += file.bytes;
    requireCondition(Number.isSafeInteger(transportBytes), "asset transport byte total exceeds safe integer range");
  }
  let currentPath = target;
  let locallyPresent = true;
  for (let index = 0; index < parts.length; index += 1) {
    currentPath = path.join(currentPath, parts[index]);
    const stats = fs.lstatSync(currentPath, { throwIfNoEntry: false });
    if (!stats) {
      locallyPresent = false;
      break;
    }
    if (stats.isSymbolicLink()) throw new Error(`READY asset path traverses a symlink: ${file.path}`);
    if (index < parts.length - 1 && !stats.isDirectory()) throw new Error(`READY asset parent path is not a directory: ${file.path}`);
  }
  if (mustExistLocally && !locallyPresent) throw new Error(`READY asset file is missing: ${file.path}`);
  if (locallyPresent) {
    const fileStats = fs.lstatSync(currentPath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.nlink !== 1 || fileStats.size !== file.bytes) {
      throw new Error(`READY local asset file type/link/size mismatch: ${file.path}`);
    }
    fs.accessSync(currentPath, fs.constants.R_OK);
    const realFilePath = fs.realpathSync(currentPath);
    if (realFilePath !== target && !realFilePath.startsWith(`${target}${path.sep}`)) throw new Error(`READY asset path escapes its release: ${file.path}`);
    if (sha256File(currentPath) !== file.sha256) throw new Error(`READY local asset file SHA-256 mismatch: ${file.path}`);
  }
}
const canonicalFiles = manifest.files.map((file) => `${file.sha256}  ${file.path}\n`).join("");
const canonicalDigest = crypto.createHash("sha256")
  .update(`asset-policy-sha256  ${manifest.assetPolicySha256}\n${canonicalFiles}`)
  .digest("hex");
if (canonicalDigest !== expectedDigest || manifest.fileCount !== manifest.files.length || manifest.totalBytes !== totalBytes) throw new Error("public asset manifest aggregate digest/count/bytes mismatch");

const logicalLocation = `shared/assets/releases/${manifest.assetVersion}`;
const { bytes: transportReceiptBytes, value: transport } = readReceipt(transportPath, "asset transport receipt");
const expectedTransport = {
  schemaVersion: 1,
  projectId: "zimeiti-caopanshou",
  kind: "public-assets-transport-receipt",
  status: "VERIFIED",
  assetVersion: manifest.assetVersion,
  assetDigest: manifest.digest,
  assetPolicySha256: manifest.assetPolicySha256,
  manifestSha256,
  fileCount: manifest.fileCount,
  totalBytes: manifest.totalBytes,
  transportFileCount,
  transportBytes,
  mutableUploadsIncluded: false,
  verificationMode: "full-sha256",
  storageBackend: deliveryMode,
  location: logicalLocation,
  issuerId: materializerId,
  issuerProtocolVersion: 1,
};
let publisher = null;
let publisherReceiptSha256 = null;
if (deliveryMode === "cos") {
  const publisherRead = readReceipt(cosPublisherPath, "preserved COS publisher receipt");
  publisher = publisherRead.value;
  publisherReceiptSha256 = crypto.createHash("sha256").update(publisherRead.bytes).digest("hex");
  requireCondition(hex64.test(publisher.publisherScriptSha256) && publisher.publisherScriptSha256 === supportedPublisherScriptSha256, "COS publisher script SHA-256 is unsupported");
  const remoteLocation = validateCosLocation(publisher.location, manifest.assetVersion);
  const expectedPublisher = {
    schemaVersion: 1,
    projectId: "zimeiti-caopanshou",
    kind: "public-assets-readiness-receipt",
    status: "READY",
    assetVersion: manifest.assetVersion,
    assetDigest: manifest.digest,
    assetPolicySha256: manifest.assetPolicySha256,
    manifestSha256,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    mutableUploadsIncluded: false,
    verificationMode: "full-sha256",
    storageBackend: "cos",
    location: remoteLocation,
    publisherId,
    publisherProtocolVersion: 1,
    publisherScriptSha256: publisher.publisherScriptSha256,
    remoteVerification,
    remoteVerifiedFileCount: manifest.fileCount,
    remoteVerifiedTotalBytes: manifest.totalBytes,
    remoteContentTypeVerified: true,
    remoteCacheControlVerified: true,
    overwriteProtocol,
    publicationOrder,
  };
  requireExactKeys(publisher, [...Object.keys(expectedPublisher), "verifiedAt"], "preserved COS publisher receipt");
  for (const [field, value] of Object.entries(expectedPublisher)) {
    requireCondition(publisher[field] === value, `preserved COS publisher receipt mismatch: ${field}`);
  }
  requireVerifiedAt(publisher.verifiedAt, "preserved COS publisher receipt");
  Object.assign(expectedTransport, {
    remoteLocation,
    publisherReadyReceiptPath: cosPublisherRelativePath,
    publisherReadyReceiptSha256: publisherReceiptSha256,
    publisherId,
    publisherProtocolVersion: 1,
    publisherScriptSha256: publisher.publisherScriptSha256,
    remoteVerification,
    remoteVerifiedFileCount: manifest.fileCount,
    remoteVerifiedTotalBytes: manifest.totalBytes,
    remoteContentTypeVerified: true,
    remoteCacheControlVerified: true,
    overwriteProtocol,
    publicationOrder,
  });
}
requireExactKeys(transport, [...Object.keys(expectedTransport), "verifiedAt"], "asset transport receipt");
for (const [field, value] of Object.entries(expectedTransport)) {
  requireCondition(transport[field] === value, `asset transport receipt mismatch: ${field}`);
}
requireVerifiedAt(transport.verifiedAt, "asset transport receipt");
requireCondition(transportReceiptBytes.length <= maxReceiptBytes, "asset transport receipt exceeds its size contract");

const { value: receipt } = readReceipt(receiptPath, "server asset readiness receipt");
const expectedReady = {
  schemaVersion: 1,
  projectId: "zimeiti-caopanshou",
  kind: "public-assets-readiness-receipt",
  status: "READY",
  assetVersion: manifest.assetVersion,
  assetDigest: manifest.digest,
  assetPolicySha256: manifest.assetPolicySha256,
  manifestSha256,
  fileCount: manifest.fileCount,
  totalBytes: manifest.totalBytes,
  mutableUploadsIncluded: false,
  verificationMode: "full-sha256",
  storageBackend: deliveryMode,
  location: target,
  issuerId: installerId,
  issuerProtocolVersion: 1,
};
if (deliveryMode === "cos") {
  Object.assign(expectedReady, {
    remoteLocation: transport.remoteLocation,
    publisherReadyReceiptPath: cosPublisherRelativePath,
    publisherReadyReceiptSha256: publisherReceiptSha256,
    publisherId,
    publisherProtocolVersion: 1,
    publisherScriptSha256: publisher.publisherScriptSha256,
    remoteVerification,
    remoteVerifiedFileCount: manifest.fileCount,
    remoteVerifiedTotalBytes: manifest.totalBytes,
    remoteContentTypeVerified: true,
    remoteCacheControlVerified: true,
    overwriteProtocol,
    publicationOrder,
  });
}
requireExactKeys(receipt, [...Object.keys(expectedReady), "verifiedAt"], "server asset readiness receipt");
for (const [field, value] of Object.entries(expectedReady)) {
  requireCondition(receipt[field] === value, `server asset readiness receipt mismatch: ${field}`);
}
requireVerifiedAt(receipt.verifiedAt, "server asset readiness receipt");
requireCondition(Date.parse(receipt.verifiedAt) >= Date.parse(transport.verifiedAt), "server READY predates transport verification");

const actualFiles = new Map();
const actualDirectories = new Set();
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const filePath = path.join(directory, entry.name);
    const relativePath = path.relative(target, filePath).split(path.sep).join("/");
    requireCondition(validRelative(relativePath), `unsafe installed asset path: ${relativePath}`);
    const stats = fs.lstatSync(filePath);
    requireCondition(!stats.isSymbolicLink(), `installed asset release contains a symbolic link: ${relativePath}`);
    requireCondition(stats.dev === targetStats.dev, `installed asset path crosses a filesystem boundary: ${relativePath}`);
    if (stats.isDirectory()) {
      actualDirectories.add(relativePath);
      walk(filePath);
    } else if (stats.isFile()) {
      requireCondition(stats.nlink === 1, `installed asset release contains a hard-linked file: ${relativePath}`);
      actualFiles.set(relativePath, stats);
    } else {
      throw new Error(`installed asset release contains a non-regular entry: ${relativePath}`);
    }
  }
}
walk(target);
const metadataFiles = new Set([manifestRelativePath, transportRelativePath, readyRelativePath]);
if (deliveryMode === "cos") metadataFiles.add(cosPublisherRelativePath);
const requiredFiles = new Set(metadataFiles);
for (const file of manifest.files) {
  const extension = path.posix.extname(file.path).toLowerCase();
  if (deliveryMode === "disk" || !cosRedirectedBinaryExtensions.has(extension)) requiredFiles.add(file.path);
}
for (const relativePath of actualFiles.keys()) {
  requireCondition(requiredFiles.has(relativePath), `installed asset release contains an extra file: ${relativePath}`);
}
for (const relativePath of requiredFiles) {
  requireCondition(actualFiles.has(relativePath), `installed asset release is missing a required file: ${relativePath}`);
}
const expectedDirectories = new Set([".release", "public"]);
for (const relativePath of actualFiles.keys()) {
  let parent = path.posix.dirname(relativePath);
  while (parent && parent !== ".") {
    expectedDirectories.add(parent);
    parent = path.posix.dirname(parent);
  }
}
requireCondition(actualDirectories.size === expectedDirectories.size, "installed asset release contains an extra or missing directory");
for (const relativePath of actualDirectories) {
  requireCondition(expectedDirectories.has(relativePath), `installed asset release contains an extra directory: ${relativePath}`);
}
NODE
}

validate_asset_forward_compatibility() {
  local current_manifest="$1"
  local next_manifest="$2"
  node - "$current_manifest" "$next_manifest" <<'NODE'
const fs = require("node:fs");
const [currentPath, nextPath] = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
const next = JSON.parse(fs.readFileSync(nextPath, "utf8"));
if (current.digest === next.digest) process.exit(0);
if (!Array.isArray(current.files) || !Array.isArray(next.files)) throw new Error("asset compatibility manifests require file inventories");
if (current.contentAddressing !== "sha256-files-and-asset-policy" || next.contentAddressing !== current.contentAddressing ||
    next.assetPolicySha256 !== current.assetPolicySha256) {
  throw new Error("asset policy changed; sequential asset+Web pointers cannot prove old-URL compatibility");
}
const nextByPath = new Map(next.files.map((file) => [file.path, file]));
for (const previousFile of current.files) {
  const nextFile = nextByPath.get(previousFile.path);
  if (!nextFile) throw new Error(`new asset release deletes an active URL: ${previousFile.path}`);
  if (nextFile.sha256 !== previousFile.sha256 || nextFile.bytes !== previousFile.bytes) {
    throw new Error(`new asset release mutates an active immutable URL: ${previousFile.path}`);
  }
}
NODE
}

capture_data_snapshot() {
  local output_path="$1"
  node - "$APP_DATA_DIR" >"$output_path" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = fs.realpathSync(process.argv[2]);
const files = [];

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const filePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) throw new Error(`shared data symlink appeared during deployment: ${relativePath}`);
    if (stats.isDirectory()) walk(filePath);
    else if (stats.isFile()) files.push({ path: relativePath, bytes: stats.size, sha256: sha256File(filePath) });
    else throw new Error(`shared data non-regular entry appeared during deployment: ${relativePath}`);
  }
}
walk(root);
files.sort((a, b) => a.path.localeCompare(b.path, "en"));
const digest = crypto.createHash("sha256").update(files.map((file) => `${file.sha256}  ${file.path}\n`).join("")).digest("hex");
process.stdout.write(`${JSON.stringify({ fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), digest, files })}\n`);
NODE
}

compare_data_snapshot() {
  local before="$1"
  local after="$2"
  node - "$before" "$after" <<'NODE'
const fs = require("node:fs");
const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
if (before.digest !== after.digest || before.fileCount !== after.fileCount || before.totalBytes !== after.totalBytes) throw new Error("shared/data changed during deployment; deployment never restores or overwrites business data");
NODE
}

ACTUAL_SHA256="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
[[ "${ACTUAL_SHA256,,}" == "${EXPECTED_SHA256,,}" ]] || fail "artifact SHA-256 mismatch"
archive_audit

PLAN_MANIFEST="$AUDIT_DIR/release-manifest.json"
extract_named_member "./release-manifest.json" "$PLAN_MANIFEST"
MANIFEST_METADATA="$AUDIT_DIR/manifest-metadata.json"
validate_manifest_contract "$PLAN_MANIFEST" "$MANIFEST_METADATA"
COMMIT_SHA="$(metadata_value commitSha)"
BUILD_ID="$(metadata_value buildId)"
SOURCE_MANIFEST_SHA256="$(metadata_value sourceManifestSha256)"
ASSET_DIGEST=""
ASSET_VERSION=""
ASSET_MANIFEST_SHA256=""
EMBEDDED_ASSET_MANIFEST=""

validate_shared_state
CURRENT_ASSET_TARGET="$(assert_current_asset_pointer)"
CURRENT_ASSET_VERSION="$(basename -- "$CURRENT_ASSET_TARGET")"
CURRENT_ASSET_DIGEST="${CURRENT_ASSET_VERSION#sha256-}"
CURRENT_ASSET_BACKEND="$(read_asset_release_backend "$CURRENT_ASSET_TARGET" "$CURRENT_ASSET_DIGEST")" || \
  die "current asset release READY receipt is invalid"
if [[ "$SERVICE" == "web" ]]; then
  ASSET_DIGEST="$(metadata_value assetDigest)"
  ASSET_VERSION="sha256-$ASSET_DIGEST"
  if ASSET_MANIFEST_SHA256="$(metadata_value assetManifestSha256 2>/dev/null)"; then :; else ASSET_MANIFEST_SHA256=""; fi
  ASSET_TARGET="$ASSET_RELEASES_ROOT/$ASSET_VERSION"
  [[ -d "$ASSET_TARGET" && ! -L "$ASSET_TARGET" ]] || die "required immutable asset release is not provisioned: $ASSET_TARGET"
  ASSET_TARGET="$(readlink -f -- "$ASSET_TARGET")"
  ASSET_TARGET_BACKEND="$(read_asset_release_backend "$ASSET_TARGET" "$ASSET_DIGEST")" || \
    die "target asset release READY receipt is invalid"
  if [[ "$ASSET_DELIVERY_MODE" != "auto" && "$ASSET_TARGET_BACKEND" != "$ASSET_DELIVERY_MODE" ]]; then
    die "target asset backend $ASSET_TARGET_BACKEND does not satisfy ASSET_DELIVERY_MODE=$ASSET_DELIVERY_MODE"
  fi
  EMBEDDED_ASSET_MANIFEST="$AUDIT_DIR/public-assets.v1.json"
  extract_named_member "./.release/public-assets.v1.json" "$EMBEDDED_ASSET_MANIFEST"
  CURRENT_EMBEDDED_ASSET_MANIFEST="$CURRENT_ASSET_TARGET/.release/public-assets.v1.json"
  [[ -f "$CURRENT_EMBEDDED_ASSET_MANIFEST" && ! -L "$CURRENT_EMBEDDED_ASSET_MANIFEST" ]] || die "current asset release manifest is missing"
  if [[ "$MODE" == "plan" ]]; then
    validate_asset_release "$EMBEDDED_ASSET_MANIFEST" "$ASSET_DIGEST" "$ASSET_TARGET" "$ASSET_MANIFEST_SHA256" "$ASSET_TARGET_BACKEND"
    if [[ "$ASSET_TARGET" != "$CURRENT_ASSET_TARGET" ]]; then
      validate_asset_release "$CURRENT_EMBEDDED_ASSET_MANIFEST" "$CURRENT_ASSET_DIGEST" "$CURRENT_ASSET_TARGET" "" "$CURRENT_ASSET_BACKEND"
    fi
  fi
  validate_asset_forward_compatibility "$CURRENT_EMBEDDED_ASSET_MANIFEST" "$EMBEDDED_ASSET_MANIFEST"
else
  ASSET_TARGET="$CURRENT_ASSET_TARGET"
  ASSET_TARGET_BACKEND="$CURRENT_ASSET_BACKEND"
  CURRENT_EMBEDDED_ASSET_MANIFEST="$CURRENT_ASSET_TARGET/.release/public-assets.v1.json"
  [[ -f "$CURRENT_EMBEDDED_ASSET_MANIFEST" && ! -L "$CURRENT_EMBEDDED_ASSET_MANIFEST" ]] || die "current asset release manifest is missing"
  if [[ "$MODE" == "plan" ]]; then
    validate_asset_release "$CURRENT_EMBEDDED_ASSET_MANIFEST" "$CURRENT_ASSET_DIGEST" "$CURRENT_ASSET_TARGET" "" "$CURRENT_ASSET_BACKEND"
  fi
fi

[[ ! -e "$CANDIDATE" && ! -L "$CANDIDATE" ]] || die "immutable release already exists: $CANDIDATE"

echo "MODE=$MODE"
echo "RELEASE_MODE=$RELEASE_MODE"
echo "SERVICE=$SERVICE"
echo "RELEASE_ID=$RELEASE_ID"
echo "COMMIT_SHA=$COMMIT_SHA"
echo "BUILD_ID=$BUILD_ID"
echo "SOURCE_MANIFEST_SHA256=$SOURCE_MANIFEST_SHA256"
echo "ARTIFACT=$ARTIFACT"
echo "ARTIFACT_SHA256=${ACTUAL_SHA256,,}"
echo "CANDIDATE=$CANDIDATE"
echo "CURRENT_LINK=$CURRENT_LINK"
echo "ASSET_TARGET=$ASSET_TARGET"
echo "CURRENT_ASSET_BACKEND=$CURRENT_ASSET_BACKEND"
echo "TARGET_ASSET_BACKEND=$ASSET_TARGET_BACKEND"
echo "ASSET_DELIVERY_MODE_POLICY=$ASSET_DELIVERY_MODE"
echo "READINESS=http://127.0.0.1:$LIVE_PORT$READINESS_PATH"

if [[ "$MODE" == "plan" ]]; then
  echo "PASS PLAN ONLY: artifact identity, archive safety, shared mounts/data JSON, and asset READY receipt validated."
  if [[ "$SERVICE" == "web" && "$ASSET_DIGEST" != "$CURRENT_ASSET_DIGEST" ]]; then
    echo "PASS asset transition is a verified forward-compatible superset; sequential asset+Web pointers are safe but not kernel-level dual-atomic."
  fi
  echo "No persistent files, processes, symlinks, database, or network state were changed."
  exit 0
fi

[[ "${DEPLOY_EXECUTION_APPROVED:-}" == "$RELEASE_ID" ]] || die "DEPLOY_EXECUTION_APPROVED must exactly equal the release id"
[[ "$EUID" -eq 0 ]] || die "--execute requires EUID=0 so the promoted release can be sealed root:root before activation"
for command_name in curl pm2 ss flock cmp mv id stat mkdir ln tail tr env sleep date chown chmod find; do require_command "$command_name"; done
mv --version 2>/dev/null | head -n 1 | grep -q "GNU coreutils" || die "GNU coreutils mv is required for atomic symlink replacement"
DEPLOY_ACTOR="${DEPLOY_OPERATOR:-$(id -un)}"
[[ "$DEPLOY_ACTOR" =~ ^[A-Za-z0-9@._-]{1,128}$ ]] || die "DEPLOY_OPERATOR contains unsafe audit characters"

LOCK_FILE="$RELEASE_ROOT/.deploy.lock"
if [[ -e "$LOCK_FILE" || -L "$LOCK_FILE" ]]; then
  [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || die "deploy lock is not a regular file: $LOCK_FILE"
fi
exec 9>>"$LOCK_FILE"
[[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || die "deploy lock path changed while it was opened"
[[ "$(readlink -f -- "/proc/$$/fd/9")" == "$(readlink -f -- "$LOCK_FILE")" ]] || die "deploy lock file descriptor escaped its expected path"
flock -n 9 || die "another release transaction already holds $LOCK_FILE"

DEPLOY_HISTORY_PATH="$LOG_ROOT/deploy-history.tsv"
if [[ -e "$DEPLOY_HISTORY_PATH" || -L "$DEPLOY_HISTORY_PATH" ]]; then
  [[ -f "$DEPLOY_HISTORY_PATH" && ! -L "$DEPLOY_HISTORY_PATH" ]] || die "deploy history is not a regular file: $DEPLOY_HISTORY_PATH"
fi
exec {HISTORY_FD}>>"$DEPLOY_HISTORY_PATH"
[[ -f "$DEPLOY_HISTORY_PATH" && ! -L "$DEPLOY_HISTORY_PATH" ]] || die "deploy history path changed while it was opened"
[[ "$(readlink -f -- "/proc/$$/fd/$HISTORY_FD")" == "$(readlink -f -- "$DEPLOY_HISTORY_PATH")" ]] || die "deploy history file descriptor escaped its expected path"

validate_shared_state
[[ ! -e "$CANDIDATE" && ! -L "$CANDIDATE" ]] || die "immutable release appeared while waiting for lock: $CANDIDATE"
LOCKED_CURRENT_ASSET_TARGET="$(assert_current_asset_pointer)"
[[ "$LOCKED_CURRENT_ASSET_TARGET" == "$CURRENT_ASSET_TARGET" ]] || die "asset current pointer changed between plan and execute lock"
EXECUTE_ARTIFACT_SHA256="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
[[ "${EXECUTE_ARTIFACT_SHA256,,}" == "${EXPECTED_SHA256,,}" ]] || fail "artifact changed after plan audit and before extraction"
for managed_root in "$RELEASES_ROOT" "$STAGING_ROOT"; do
  if [[ -e "$managed_root" || -L "$managed_root" ]]; then
    [[ -d "$managed_root" && ! -L "$managed_root" ]] || die "managed release path is not a regular directory: $managed_root"
  else
    mkdir --mode=0750 -- "$managed_root"
  fi
  [[ -r "$managed_root" && -w "$managed_root" && -x "$managed_root" ]] || \
    die "managed release path is not readable/writable/traversable by the deploy service user: $managed_root"
done
[[ "$(stat -c '%d' -- "$RELEASES_ROOT")" == "$(stat -c '%d' -- "$STAGING_ROOT")" ]] || \
  die "staging and releases roots are on different filesystems; atomic candidate promotion is impossible"

STAGING_DIR="$STAGING_ROOT/$RELEASE_ID-$SERVICE-$$"
[[ ! -e "$STAGING_DIR" && ! -L "$STAGING_DIR" ]] || die "staging path already exists: $STAGING_DIR"
mkdir --mode=0750 -- "$STAGING_DIR"
PAYLOAD_DIR="$STAGING_DIR/payload"
mkdir --mode=0750 -- "$PAYLOAD_DIR"

tar "${TAR_COMPRESSION[@]}" --extract --restrict --no-same-owner --no-same-permissions \
  --delay-directory-restore --file "$ARTIFACT" --directory "$PAYLOAD_DIR"
POST_EXTRACT_ARTIFACT_SHA256="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
[[ "${POST_EXTRACT_ARTIFACT_SHA256,,}" == "${EXPECTED_SHA256,,}" ]] || fail "artifact changed during extraction"
verify_sensitive_artifact_paths tree "$PAYLOAD_DIR"

PAYLOAD_MANIFEST="$PAYLOAD_DIR/release-manifest.json"
PAYLOAD_PM2_CONFIG="$PAYLOAD_DIR/.release/ecosystem.config.cjs"
[[ -f "$PAYLOAD_MANIFEST" && ! -L "$PAYLOAD_MANIFEST" && -f "$PAYLOAD_DIR/server.js" && ! -L "$PAYLOAD_DIR/server.js" && \
   -f "$PAYLOAD_PM2_CONFIG" && ! -L "$PAYLOAD_PM2_CONFIG" ]] || fail "extracted artifact lacks a regular manifest, standalone server, or PM2 contract"

EXECUTE_METADATA="$STAGING_DIR/manifest-metadata.json"
validate_manifest_contract "$PAYLOAD_MANIFEST" "$EXECUTE_METADATA"
cmp --silent "$MANIFEST_METADATA" "$EXECUTE_METADATA" || fail "manifest identity changed between plan audit and staged extraction"
validate_payload_inventory "$PAYLOAD_DIR"

if [[ "$SERVICE" == "web" ]]; then
  validate_asset_release "$PAYLOAD_DIR/.release/public-assets.v1.json" "$ASSET_DIGEST" "$ASSET_TARGET" "$ASSET_MANIFEST_SHA256" "$ASSET_TARGET_BACKEND"
  if [[ "$ASSET_TARGET" != "$CURRENT_ASSET_TARGET" ]]; then
    validate_asset_release "$CURRENT_EMBEDDED_ASSET_MANIFEST" "$CURRENT_ASSET_DIGEST" "$CURRENT_ASSET_TARGET" "" "$CURRENT_ASSET_BACKEND"
  fi
  validate_asset_forward_compatibility "$CURRENT_EMBEDDED_ASSET_MANIFEST" "$PAYLOAD_DIR/.release/public-assets.v1.json"
else
  validate_asset_release "$CURRENT_EMBEDDED_ASSET_MANIFEST" "$CURRENT_ASSET_DIGEST" "$CURRENT_ASSET_TARGET" "" "$CURRENT_ASSET_BACKEND"
fi

DATA_BEFORE="$STAGING_DIR/data-before.json"
DATA_AFTER_CANDIDATE="$STAGING_DIR/data-after-candidate.json"
DATA_AFTER_LIVE="$STAGING_DIR/data-after-live.json"
capture_data_snapshot "$DATA_BEFORE"

port_in_use() {
  ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .
}

choose_candidate_port() {
  local port
  for ((port = CANDIDATE_PORT_MIN; port <= CANDIDATE_PORT_MAX; port += 1)); do
    if ! port_in_use "$port"; then printf '%s\n' "$port"; return 0; fi
  done
  return 1
}

CANDIDATE_PORT="$(choose_candidate_port)" || die "no free candidate port in $CANDIDATE_PORT_MIN-$CANDIDATE_PORT_MAX"
if port_in_use "$CANDIDATE_PORT"; then die "candidate port became occupied before launch: $CANDIDATE_PORT"; fi
CANDIDATE_LOG="$LOG_ROOT/candidate-$SERVICE-$RELEASE_ID.log"
[[ ! -e "$CANDIDATE_LOG" && ! -L "$CANDIDATE_LOG" ]] || die "candidate log already exists; release ids are immutable: $CANDIDATE_LOG"
set -o noclobber
if ! exec {CANDIDATE_LOG_FD}>"$CANDIDATE_LOG"; then
  set +o noclobber
  die "unable to create candidate log without overwriting an existing path"
fi
set +o noclobber
[[ -f "$CANDIDATE_LOG" && ! -L "$CANDIDATE_LOG" ]] || die "candidate log path changed while it was opened"
[[ "$(readlink -f -- "/proc/$$/fd/$CANDIDATE_LOG_FD")" == "$(readlink -f -- "$CANDIDATE_LOG")" ]] || die "candidate log file descriptor escaped its expected path"
PUBLIC_ASSET_ROOT="$ASSET_TARGET/public"
load_protected_environment
if [[ -n "${DIRECT_HOOK_PATH:-}" ]]; then
  DIRECT_PREPARED="1"
  direct_hook prepare || fail "direct configuration/process preparation failed"
fi

if [[ "$SERVICE" == "web" ]]; then
  (
    cd "$PAYLOAD_DIR"
    exec env NODE_ENV=production PORT="$CANDIDATE_PORT" HOSTNAME=127.0.0.1 \
      RELEASE_ROOT="$RELEASE_ROOT" APP_DATA_DIR="$APP_DATA_DIR" APP_RUNTIME_DIR="$APP_RUNTIME_DIR" COMMERCE_DATA_DIR="$COMMERCE_DATA_DIR" COMMERCE_DISCOVERY_CATALOG="$COMMERCE_DISCOVERY_CATALOG" COMMERCE_GATEWAY_KEY_FILE="$COMMERCE_GATEWAY_KEY_FILE" \
      IDEMPOTENCY_DIR="$IDEMPOTENCY_DIR" BACKUP_DIR="$BACKUP_ROOT" \
      PUBLIC_ASSET_ROOT="$PUBLIC_ASSET_ROOT" STORAGE_LOCAL_BASE_PATH="$UPLOAD_ROOT" \
      VOICE_SQLITE_PATH="$VOICE_DATABASE_PATH" VOICE_REFERENCE_AUDIO_DIR="$VOICE_REFERENCE_AUDIO_ROOT" \
      ASSET_DIGEST="$ASSET_DIGEST" ASSET_MANIFEST_SHA256="$ASSET_MANIFEST_SHA256" \
      RELEASE_ID="$RELEASE_ID" DEPLOY_COMMIT_SHA="$COMMIT_SHA" EXPECTED_BUILD_ID="$BUILD_ID" \
      COZE_PROJECT_ENV=PROD node server.js
  ) >&"$CANDIDATE_LOG_FD" 2>&1 &
else
  (
    cd "$PAYLOAD_DIR"
    exec env NODE_ENV=production PORT="$CANDIDATE_PORT" HOSTNAME=127.0.0.1 \
      RELEASE_ROOT="$RELEASE_ROOT" APP_DATA_DIR="$APP_DATA_DIR" APP_RUNTIME_DIR="$APP_RUNTIME_DIR" COMMERCE_DATA_DIR="$COMMERCE_DATA_DIR" COMMERCE_DISCOVERY_CATALOG="$COMMERCE_DISCOVERY_CATALOG" COMMERCE_GATEWAY_KEY_FILE="$COMMERCE_GATEWAY_KEY_FILE" \
      IDEMPOTENCY_DIR="$IDEMPOTENCY_DIR" BACKUP_DIR="$BACKUP_ROOT" \
      PUBLIC_ASSET_ROOT="$PUBLIC_ASSET_ROOT" VOICE_SQLITE_PATH="$VOICE_DATABASE_PATH" \
      VOICE_REFERENCE_AUDIO_DIR="$VOICE_REFERENCE_AUDIO_ROOT" \
      DATABASE_URL="file:$VOICE_DATABASE_PATH" RELEASE_ID="$RELEASE_ID" DEPLOY_COMMIT_SHA="$COMMIT_SHA" EXPECTED_BUILD_ID="$BUILD_ID" \
      COZE_PROJECT_ENV=PROD node server.js
  ) >&"$CANDIDATE_LOG_FD" 2>&1 &
fi
candidate_pid=$!
exec {CANDIDATE_LOG_FD}>&-

wait_http() {
  local url="$1"
  local output="$2"
  local attempt
  for ((attempt = 1; attempt <= 45; attempt += 1)); do
    if curl --fail --silent --connect-timeout 2 --max-time 5 --output "$output" "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

assert_readiness_identity() {
  local response_file="$1"
  local expected_release="$2"
  local expected_commit="$3"
  local expected_build="$4"
  local expected_asset_digest="$5"
  node - "$response_file" "$SERVICE" "$expected_release" "$expected_commit" "$expected_build" "$expected_asset_digest" <<'NODE'
const fs = require("node:fs");
const [filePath, service, releaseId, commitSha, buildId, assetDigest] = process.argv.slice(2);
const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
if (body.ready !== true) throw new Error(`readiness is not true: ${String(body.ready)}`);
if (body.service !== service) throw new Error(`readiness service mismatch: ${String(body.service)}`);
if (body.releaseId !== releaseId) throw new Error(`readiness release identity mismatch: ${String(body.releaseId)}`);
if (body.commitSha !== commitSha) throw new Error(`readiness commit identity mismatch: ${String(body.commitSha)}`);
if (body.buildId !== buildId) throw new Error(`readiness build identity mismatch: ${String(body.buildId)}`);
if (service === "web" && body.assetDigest !== assetDigest) throw new Error(`readiness asset digest mismatch: ${String(body.assetDigest)}`);
NODE
}

verify_service_http() {
  local port="$1"
  local expected_release="$2"
  local expected_commit="$3"
  local expected_build="$4"
  local expected_asset_digest="$5"
  local label="$6"
  local response_file="$STAGING_DIR/$label-health.json"
  wait_http "http://127.0.0.1:$port$READINESS_PATH" "$response_file" || return 1
  assert_readiness_identity "$response_file" "$expected_release" "$expected_commit" "$expected_build" "$expected_asset_digest" || return 1
}

verify_service_http "$CANDIDATE_PORT" "$RELEASE_ID" "$COMMIT_SHA" "$BUILD_ID" "$ASSET_DIGEST" "candidate" || \
  fail "candidate readiness/identity/data/database check failed; see $CANDIDATE_LOG"
LISTENER_DETAIL="$(ss -H -ltnp "sport = :$CANDIDATE_PORT" 2>/dev/null || true)"
grep -Fq "pid=$candidate_pid," <<<"$LISTENER_DETAIL" || fail "candidate port is not owned by the launched candidate PID $candidate_pid"

cleanup_candidate
port_in_use "$CANDIDATE_PORT" && fail "candidate process stopped but its port remains occupied"
validate_payload_inventory "$PAYLOAD_DIR"
capture_data_snapshot "$DATA_AFTER_CANDIDATE"
compare_data_snapshot "$DATA_BEFORE" "$DATA_AFTER_CANDIDATE" || fail "candidate startup changed shared/data; code was not activated"

PREVIOUS_TARGET=""
PREVIOUS_ASSET_TARGET="$CURRENT_ASSET_TARGET"
if [[ -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]]; then
  [[ -L "$CURRENT_LINK" ]] || die "service current pointer is not a symlink: $CURRENT_LINK"
  PREVIOUS_TARGET="$(readlink -f -- "$CURRENT_LINK")" || die "service current pointer is broken"
  [[ -d "$PREVIOUS_TARGET" && ! -L "$PREVIOUS_TARGET" ]] || die "previous release target is invalid: $PREVIOUS_TARGET"
  case "$PREVIOUS_TARGET" in
    "$RELEASES_ROOT"/*/"$SERVICE") ;;
    *) die "previous release target escapes the service release root: $PREVIOUS_TARGET" ;;
  esac
fi

EXISTING_PM2_PID="$(pm2 pid "$APP_NAME" 2>/dev/null | tail -n 1 | tr -d '[:space:]' || true)"
if [[ -z "$PREVIOUS_TARGET" && -n "$EXISTING_PM2_PID" && "$EXISTING_PM2_PID" != "0" ]]; then
  die "PM2 process $APP_NAME exists without a managed current symlink"
fi

read_release_identity() {
  local release_target="$1"
  node - "$release_target/release-manifest.json" "$SERVICE" <<'NODE'
const fs = require("node:fs");
const [manifestPath, service] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.service !== service) throw new Error("rollback manifest service mismatch");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(manifest.releaseId)) throw new Error("rollback release id is invalid");
if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(manifest.commitSha)) throw new Error("rollback commit SHA is invalid");
if (typeof manifest.buildId !== "string" || !manifest.buildId) throw new Error("rollback build id is missing");
const assetDigest = service === "web" ? manifest.assetDigest : "-";
const assetManifestSha256 = service === "web" ? manifest.assetManifestSha256 : "-";
if (service === "web" && (!/^[0-9a-f]{64}$/u.test(assetDigest) || !/^[0-9a-f]{64}$/u.test(assetManifestSha256))) {
  throw new Error("rollback Web asset identity is invalid");
}
process.stdout.write(`${manifest.releaseId}\t${manifest.commitSha}\t${manifest.buildId}\t${assetDigest}\t${assetManifestSha256}\n`);
NODE
}

validate_asset_manifest_binding() {
  local embedded_manifest="$1"
  local server_manifest="$2"
  local expected_manifest_sha="$3"
  [[ "$expected_manifest_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ -f "$embedded_manifest" && ! -L "$embedded_manifest" && -f "$server_manifest" && ! -L "$server_manifest" ]] || return 1
  local embedded_sha server_sha
  embedded_sha="$(sha256sum "$embedded_manifest" | awk '{print $1}')" || return 1
  server_sha="$(sha256sum "$server_manifest" | awk '{print $1}')" || return 1
  [[ "${embedded_sha,,}" == "$expected_manifest_sha" && "${server_sha,,}" == "$expected_manifest_sha" ]]
}

PREVIOUS_RELEASE_ID=""
PREVIOUS_COMMIT_SHA=""
PREVIOUS_BUILD_ID=""
PREVIOUS_ASSET_DIGEST=""
PREVIOUS_ASSET_MANIFEST_SHA256=""
if [[ -n "$PREVIOUS_TARGET" ]]; then
  IFS=$'\t' read -r PREVIOUS_RELEASE_ID PREVIOUS_COMMIT_SHA PREVIOUS_BUILD_ID PREVIOUS_ASSET_DIGEST PREVIOUS_ASSET_MANIFEST_SHA256 < <(read_release_identity "$PREVIOUS_TARGET")
  validate_payload_inventory "$PREVIOUS_TARGET"
  if [[ "$SERVICE" == "web" ]]; then
    [[ "$PREVIOUS_ASSET_DIGEST" == "$CURRENT_ASSET_DIGEST" ]] || die "active Web release and current asset pointer are already inconsistent"
    validate_asset_manifest_binding "$PREVIOUS_TARGET/.release/public-assets.v1.json" "$CURRENT_EMBEDDED_ASSET_MANIFEST" "$PREVIOUS_ASSET_MANIFEST_SHA256" || \
      die "active Web release asset manifest is not bound to the already-verified current asset release"
  fi
fi

atomic_symlink() {
  local target="$1"
  local link_path="$2"
  local temporary="$3"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
  ln -s -- "$target" "$temporary" || return 1
  if ! mv -Tf -- "$temporary" "$link_path"; then
    [[ -L "$temporary" ]] && rm -- "$temporary"
    return 1
  fi
  [[ -L "$link_path" && "$(readlink -f -- "$link_path")" == "$(readlink -f -- "$target")" ]]
}

APP_TEMP_LINK="$RELEASE_ROOT/.current-$SERVICE-$RELEASE_ID-$$.tmp"
ASSET_TEMP_LINK="$ASSET_ROOT/.current-$RELEASE_ID-$$.tmp"

activate_pm2() {
  local config_path="$1"
  local active_release_id="$2"
  local active_commit_sha="$3"
  local active_build_id="$4"
  local active_asset_digest="$5"
  local active_asset_manifest_sha256="$6"
  export RELEASE_ROOT APP_DATA_DIR APP_RUNTIME_DIR COMMERCE_DATA_DIR COMMERCE_DISCOVERY_CATALOG COMMERCE_GATEWAY_KEY_FILE IDEMPOTENCY_DIR
  export BACKUP_DIR="$BACKUP_ROOT"
  export PUBLIC_ASSET_ROOT="$ASSET_CURRENT_LINK/public"
  export VOICE_SQLITE_PATH="$VOICE_DATABASE_PATH"
  export VOICE_REFERENCE_AUDIO_DIR="$VOICE_REFERENCE_AUDIO_ROOT"
  export RELEASE_ID="$active_release_id"
  export DEPLOY_COMMIT_SHA="$active_commit_sha"
  export EXPECTED_BUILD_ID="$active_build_id"
  export COZE_PROJECT_ENV="PROD"
  if [[ "$SERVICE" == "web" ]]; then
    export WEB_RELEASE_DIR="$CURRENT_LINK"
    export STORAGE_LOCAL_BASE_PATH="$UPLOAD_ROOT"
    export ASSET_DIGEST="$active_asset_digest"
    export ASSET_MANIFEST_SHA256="$active_asset_manifest_sha256"
    pm2 startOrReload "$config_path" --only "$APP_NAME" --env production --update-env
  else
    export VOICE_RELEASE_DIR="$CURRENT_LINK"
    export VOICE_DATABASE_URL="file:$VOICE_DATABASE_PATH"
    pm2 startOrReload "$config_path" --only "$APP_NAME" --env production --update-env
  fi
}

verify_pm2_identity() {
  local expected_target="$1"
  local expected_release="$2"
  local expected_commit="$3"
  local expected_build_id="$4"
  local expected_asset_digest="${5:--}"
  local expected_asset_manifest_sha256="${6:--}"
  local pm2_pid
  pm2_pid="$(pm2 jlist | node -e '
const fs = require("node:fs");
const [name, target, releaseId, commitSha, buildId, service, assetDigest, assetManifestSha256] = process.argv.slice(1);
const processes = JSON.parse(fs.readFileSync(0, "utf8"));
const matches = processes.filter((entry) => entry?.name === name);
if (matches.length !== 1) throw new Error(`expected one PM2 process ${name}, found ${matches.length}`);
const processInfo = matches[0];
const env = processInfo.pm2_env || {};
if (env.status !== "online") throw new Error(`PM2 process is not online: ${String(env.status)}`);
const cwd = fs.realpathSync(env.pm_cwd);
const expected = fs.realpathSync(target);
if (cwd !== expected) throw new Error(`PM2 cwd mismatch: ${cwd}`);
if (env.RELEASE_ID !== releaseId || env.DEPLOY_COMMIT_SHA !== commitSha || env.EXPECTED_BUILD_ID !== buildId || env.COZE_PROJECT_ENV !== "PROD") throw new Error("PM2 release identity environment mismatch");
if (service === "web" && (env.ASSET_DIGEST !== assetDigest || env.ASSET_MANIFEST_SHA256 !== assetManifestSha256)) {
  throw new Error("PM2 Web asset identity environment mismatch");
}
if (typeof processInfo.pid !== "number" || processInfo.pid <= 0) throw new Error("PM2 process PID is invalid");
process.stdout.write(String(processInfo.pid));
' "$APP_NAME" "$expected_target" "$expected_release" "$expected_commit" "$expected_build_id" "$SERVICE" "$expected_asset_digest" "$expected_asset_manifest_sha256")" || return 1
  local listener
  listener="$(ss -H -ltnp "sport = :$LIVE_PORT" 2>/dev/null || true)"
  grep -Fq "pid=$pm2_pid," <<<"$listener"
}

link_resolves_to() {
  local link_path="$1"
  local expected_target="$2"
  local actual expected
  [[ -L "$link_path" ]] || return 1
  actual="$(readlink -f -- "$link_path" 2>/dev/null)" || return 1
  expected="$(readlink -f -- "$expected_target" 2>/dev/null)" || return 1
  [[ "$actual" == "$expected" ]]
}

verify_pm2_absent() {
  pm2 jlist | node -e '
const fs = require("node:fs");
const name = process.argv[1];
const processes = JSON.parse(fs.readFileSync(0, "utf8"));
if (processes.some((entry) => entry?.name === name)) process.exit(1);
' "$APP_NAME" || return 1
  ! port_in_use "$LIVE_PORT"
}

verify_exact_first_deploy_composite() {
  local expected_asset_target="$1"
  [[ -z "$PREVIOUS_TARGET" ]] || return 1
  [[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]] || return 1
  link_resolves_to "$ASSET_CURRENT_LINK" "$expected_asset_target" || return 1
  verify_pm2_absent || return 1
}

verify_exact_active_composite() {
  local expected_target="$1"
  local expected_release="$2"
  local expected_commit="$3"
  local expected_build="$4"
  local expected_asset_target="$5"
  local expected_asset_digest="$6"
  local expected_asset_manifest_sha256="$7"
  local label="$8"
  link_resolves_to "$CURRENT_LINK" "$expected_target" || return 1
  link_resolves_to "$ASSET_CURRENT_LINK" "$expected_asset_target" || return 1
  # PM2 reports online before Node has bound the HTTP listener. Wait for the
  # exact release readiness first, then bind that listener back to its PM2 PID.
  verify_service_http "$LIVE_PORT" "$expected_release" "$expected_commit" "$expected_build" "$expected_asset_digest" "$label" || return 1
  verify_pm2_identity "$expected_target" "$expected_release" "$expected_commit" "$expected_build" \
    "$expected_asset_digest" "$expected_asset_manifest_sha256" || return 1
}

if [[ -n "$PREVIOUS_TARGET" ]]; then
  verify_exact_active_composite "$PREVIOUS_TARGET" "$PREVIOUS_RELEASE_ID" "$PREVIOUS_COMMIT_SHA" "$PREVIOUS_BUILD_ID" \
    "$PREVIOUS_ASSET_TARGET" "$PREVIOUS_ASSET_DIGEST" "$PREVIOUS_ASSET_MANIFEST_SHA256" "predeploy" || \
    die "rollback target code/asset/PM2/listener/readiness composite identity is not healthy before activation"
else
  verify_exact_first_deploy_composite "$PREVIOUS_ASSET_TARGET" || \
    die "first managed deployment requires current/previous/PM2 absence and the exact predeploy asset pointer"
fi

RELEASE_PARENT="$RELEASES_ROOT/$RELEASE_ID"
if [[ -e "$RELEASE_PARENT" || -L "$RELEASE_PARENT" ]]; then
  [[ -d "$RELEASE_PARENT" && ! -L "$RELEASE_PARENT" ]] || die "release parent is not a regular directory: $RELEASE_PARENT"
else
  mkdir --mode=0750 -- "$RELEASE_PARENT"
fi
[[ -d "$PAYLOAD_DIR" && ! -L "$PAYLOAD_DIR" ]] || fail "validated staging payload is no longer a regular directory"
[[ ! -e "$CANDIDATE" && ! -L "$CANDIDATE" ]] || die "immutable release target appeared before promotion: $CANDIDATE"
EXPECTED_CANDIDATE="$CANDIDATE"
[[ "$(stat -c '%d' -- "$PAYLOAD_DIR")" == "$(stat -c '%d' -- "$RELEASE_PARENT")" ]] || \
  die "validated payload and exact release parent are on different filesystems; atomic promotion is impossible"
VALIDATED_PAYLOAD_ID="$(stat -c '%d:%i' -- "$PAYLOAD_DIR")"
if ! mv -Tn -- "$PAYLOAD_DIR" "$CANDIDATE"; then
  fail "atomic immutable candidate promotion failed; the staged payload was not activated"
fi
if [[ -e "$PAYLOAD_DIR" || -L "$PAYLOAD_DIR" ]]; then
  fail "immutable candidate target appeared during promotion; it was not overwritten"
fi
PAYLOAD_DIR=""
CANDIDATE="$(readlink -f -- "$CANDIDATE")"
[[ "$CANDIDATE" == "$EXPECTED_CANDIDATE" ]] || fail "promoted candidate resolved outside its exact immutable path"
[[ "$VALIDATED_PAYLOAD_ID" == "$(stat -c '%d:%i' -- "$CANDIDATE")" ]] || \
  fail "atomic candidate promotion did not preserve the validated directory identity"
validate_payload_inventory "$CANDIDATE"
seal_candidate_release "$CANDIDATE" || fail "promoted candidate could not be sealed root:root and read-only"
verify_candidate_release_seal "$CANDIDATE" || fail "promoted candidate root-owned seal verification failed"
CANDIDATE_PM2_CONFIG="$CANDIDATE/.release/ecosystem.config.cjs"

rollback_release() {
  # This must be the first state-changing action in rollback. A secondary
  # HUP/INT/TERM cannot enter the handler between the idempotency check and the
  # ROLLBACK_ATTEMPTED commit.
  trap '' HUP INT TERM
  local reason="$1"
  trap - ERR
  set +e
  if [[ "$ROLLBACK_ATTEMPTED" == "1" ]]; then
    local repeated_status=1
    [[ "$ROLLBACK_SUCCEEDED" == "1" ]] && repeated_status=0
    trap 'unexpected_error "$?" "$LINENO"' ERR
    set -e
    return "$repeated_status"
  fi
  ROLLBACK_ATTEMPTED="1"
  IN_ROLLBACK="1"
  echo "ROLLBACK: $reason" >&2
  cleanup_candidate

  if ! direct_hook rollback-before; then
    echo "ROLLBACK FAILED: configuration/worker restoration prerequisite is unconfirmed." >&2
    IN_ROLLBACK="0"
    return 1
  fi

  # Web and asset pointers are separate atomic operations. Stop the live
  # process before restoring either pointer so rollback never serves new Web
  # code against the old asset tree (or the reverse) during the transition.
  pm2 stop "$APP_NAME" >/dev/null 2>&1 || true
  local stop_attempt
  for ((stop_attempt = 1; stop_attempt <= 50; stop_attempt += 1)); do
    port_in_use "$LIVE_PORT" || break
    sleep 0.2
  done
  if port_in_use "$LIVE_PORT"; then
    echo "ROLLBACK FAILED: live port $LIVE_PORT could not be quiesced; pointers were not restored and manual recovery is required." >&2
    trap 'unexpected_error "$?" "$LINENO"' ERR
    set -e
    IN_ROLLBACK="0"
    return 1
  fi

  local pointer_ok=0
  local process_ok=0
  if [[ "$SERVICE" == "web" ]]; then
    if ! atomic_symlink "$PREVIOUS_ASSET_TARGET" "$ASSET_CURRENT_LINK" "$ASSET_TEMP_LINK"; then
      pointer_ok=1
    fi
  fi

  if [[ -n "$PREVIOUS_TARGET" ]]; then
    if ! atomic_symlink "$PREVIOUS_TARGET" "$CURRENT_LINK" "$APP_TEMP_LINK"; then
      pointer_ok=1
    fi
    if [[ "$pointer_ok" -eq 0 ]] && validate_payload_inventory "$PREVIOUS_TARGET"; then
      activate_pm2 "$PREVIOUS_TARGET/.release/ecosystem.config.cjs" "$PREVIOUS_RELEASE_ID" "$PREVIOUS_COMMIT_SHA" "$PREVIOUS_BUILD_ID" "$PREVIOUS_ASSET_DIGEST" "$PREVIOUS_ASSET_MANIFEST_SHA256" >/dev/null 2>&1
      if ! verify_exact_active_composite "$PREVIOUS_TARGET" "$PREVIOUS_RELEASE_ID" "$PREVIOUS_COMMIT_SHA" "$PREVIOUS_BUILD_ID" \
        "$PREVIOUS_ASSET_TARGET" "$PREVIOUS_ASSET_DIGEST" "$PREVIOUS_ASSET_MANIFEST_SHA256" "rollback"; then
        process_ok=1
      fi
    else
      process_ok=1
    fi
  else
    if [[ -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]]; then
      if link_resolves_to "$CURRENT_LINK" "$CANDIDATE"; then
        rm -- "$CURRENT_LINK" || pointer_ok=1
      else
        pointer_ok=1
      fi
    fi
    if [[ -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]]; then pointer_ok=1; fi
    pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
    local attempt
    for ((attempt = 1; attempt <= 25; attempt += 1)); do
      port_in_use "$LIVE_PORT" || break
      sleep 0.2
    done
    if ! verify_exact_first_deploy_composite "$PREVIOUS_ASSET_TARGET"; then
      pointer_ok=1
      process_ok=1
    fi
  fi

  if [[ "$pointer_ok" -eq 0 && "$process_ok" -eq 0 ]]; then
    if ! direct_hook rollback-after; then
      echo "ROLLBACK FAILED: previous workers/runtime identity not restored." >&2
      IN_ROLLBACK="0"
      return 1
    fi
    DIRECT_ROLLBACK_COMPLETE="1"
    ROLLBACK_SUCCEEDED="1"
    echo "ROLLBACK PASS: code/process and asset pointer invariants are restored; shared data was not restored or overwritten." >&2
    trap 'unexpected_error "$?" "$LINENO"' ERR
    set -e
    IN_ROLLBACK="0"
    return 0
  fi
  echo "ROLLBACK FAILED: manual recovery is required; shared data was not restored or overwritten." >&2
  trap 'unexpected_error "$?" "$LINENO"' ERR
  set -e
  IN_ROLLBACK="0"
  return 1
}

handle_termination() {
  trap '' HUP INT TERM
  local signal_name="$1"
  local signal_status="$2"
  trap - ERR
  set +e
  FAILURE_CONTEXT="signal=$signal_name;exit=$signal_status"
  if [[ "$SWITCH_STARTED" == "1" && "$DEPLOY_COMPLETE" != "1" && "$ROLLBACK_ATTEMPTED" != "1" ]]; then
    rollback_release "received $signal_name before deployment commit" || true
  fi
  exit "$signal_status"
}

unexpected_error() {
  trap '' HUP INT TERM
  trap - ERR
  set +e
  local status="$1"
  local line="$2"
  FAILURE_CONTEXT="error=line-$line;exit=$status"
  if [[ "$SWITCH_STARTED" == "1" && "$DEPLOY_COMPLETE" != "1" && "$ROLLBACK_ATTEMPTED" != "1" ]]; then
    rollback_release "unexpected error at line $line (exit $status)" || true
  fi
  exit "$status"
}
trap 'unexpected_error "$?" "$LINENO"' ERR
trap 'handle_termination HUP 129' HUP
trap 'handle_termination INT 130' INT
trap 'handle_termination TERM 143' TERM

[[ "$(assert_current_asset_pointer)" == "$PREVIOUS_ASSET_TARGET" ]] || die "asset pointer changed before activation"
if [[ -n "$PREVIOUS_TARGET" ]]; then
  [[ -L "$CURRENT_LINK" && "$(readlink -f -- "$CURRENT_LINK")" == "$PREVIOUS_TARGET" ]] || die "service pointer changed before activation"
else
  [[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]] || die "service pointer appeared before first activation"
fi
verify_candidate_release_seal "$CANDIDATE" || fail "candidate root-owned seal changed before activation"
validate_payload_inventory "$CANDIDATE" || fail "sealed candidate full SHA-256 inventory changed before activation"
[[ "$VALIDATED_PAYLOAD_ID" == "$(stat -c '%d:%i' -- "$CANDIDATE")" ]] || \
  fail "sealed candidate directory identity changed before activation"

SWITCH_STARTED="1"
if [[ "$SERVICE" == "web" ]]; then
  if ! atomic_symlink "$ASSET_TARGET" "$ASSET_CURRENT_LINK" "$ASSET_TEMP_LINK"; then
    rollback_release "asset pointer switch failed" || true
    fail "asset pointer switch failed"
  fi
fi
if ! atomic_symlink "$CANDIDATE" "$CURRENT_LINK" "$APP_TEMP_LINK"; then
  rollback_release "service pointer switch failed" || true
  fail "service pointer switch failed"
fi

if ! activate_pm2 "$CANDIDATE_PM2_CONFIG" "$RELEASE_ID" "$COMMIT_SHA" "$BUILD_ID" "${ASSET_DIGEST:--}" "${ASSET_MANIFEST_SHA256:--}"; then
  rollback_release "PM2 activation failed" || true
  fail "PM2 activation failed"
fi
if ! direct_hook activated; then
  rollback_release "direct worker/runtime activation failed" || true
  fail "direct worker/runtime activation failed"
fi
if ! verify_exact_active_composite "$CANDIDATE" "$RELEASE_ID" "$COMMIT_SHA" "$BUILD_ID" \
  "$ASSET_TARGET" "${ASSET_DIGEST:--}" "${ASSET_MANIFEST_SHA256:--}" "production"; then
  rollback_release "production code/asset/PM2/listener/readiness composite identity failed" || true
  fail "production code/asset/PM2/listener/readiness composite identity failed"
fi

capture_data_snapshot "$DATA_AFTER_LIVE"
if ! compare_data_snapshot "$DATA_BEFORE" "$DATA_AFTER_LIVE"; then
  rollback_release "shared/data changed during candidate or activation checks" || true
  fail "shared/data changed; code rollback attempted without touching business data"
fi

if ! verify_exact_active_composite "$CANDIDATE" "$RELEASE_ID" "$COMMIT_SHA" "$BUILD_ID" \
  "$ASSET_TARGET" "${ASSET_DIGEST:--}" "${ASSET_MANIFEST_SHA256:--}" "precommit"; then
  rollback_release "final precommit composite identity changed after data verification" || true
  fail "final precommit composite identity changed after data verification"
fi

# Direct local-to-server releases may require a public-domain identity check.
# Keep it inside the existing rollback commit boundary: a stale CDN/Nginx/PM2
# route must restore the previous code, process and asset pointers rather than
# being reported as a successful deployment. Git-queue releases are unchanged
# unless they explicitly provide PUBLIC_ACCEPTANCE_URL.
if [[ "$SERVICE" == "web" && -n "${PUBLIC_ACCEPTANCE_URL:-}" ]]; then
  PUBLIC_VERSION_URL="$(node -e '
const base = new URL(process.argv[1]);
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) process.exit(2);
base.pathname = `${base.pathname.replace(/\/+$/u, "")}/api/version`;
base.searchParams.set("direct_release", process.argv[2]);
process.stdout.write(base.toString());
' "$PUBLIC_ACCEPTANCE_URL" "$RELEASE_ID")" || {
    rollback_release "public acceptance URL validation failed" || true
    fail "public acceptance URL validation failed"
  }
  EXPECTED_SOURCE_VERSION="$(node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof value.sourceVersion !== "string" || !value.sourceVersion.trim()) process.exit(2);
process.stdout.write(value.sourceVersion.trim());
' "$CANDIDATE/public/version.json")" || {
    rollback_release "candidate sourceVersion is unavailable" || true
    fail "candidate sourceVersion is unavailable"
  }
  PUBLIC_VERSION_RESPONSE="$STAGING_DIR/public-version-response.json"
  if ! curl --fail --silent --show-error --max-time 20 \
    -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "$PUBLIC_VERSION_URL" >"$PUBLIC_VERSION_RESPONSE"; then
    rollback_release "public version endpoint request failed" || true
    fail "public version endpoint request failed"
  fi
  if ! node - "$PUBLIC_VERSION_RESPONSE" "$COMMIT_SHA" "$RELEASE_ID" "$BUILD_ID" "$EXPECTED_SOURCE_VERSION" <<'NODE'
const fs = require("node:fs");
const [file, commitSha, releaseId, buildId, sourceVersion] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, "utf8"));
if (value.deployCommitSha !== commitSha) throw new Error("public deployCommitSha mismatch");
if (value.releaseId !== releaseId) throw new Error("public releaseId mismatch");
if (value.buildId !== buildId) throw new Error("public buildId mismatch");
if (value.sourceVersion !== sourceVersion) throw new Error("public sourceVersion mismatch");
NODE
  then
    rollback_release "public release identity mismatch" || true
    fail "public release identity mismatch"
  fi
  echo "PASS public release identity commit=$COMMIT_SHA release=$RELEASE_ID build=$BUILD_ID sourceVersion=$EXPECTED_SOURCE_VERSION"
fi

if ! direct_hook precommit; then
  rollback_release "direct transaction precommit verification failed" || true
  fail "direct transaction precommit verification failed"
fi

# SUCCESS and DEPLOY_COMPLETE form one short commit boundary. A termination
# before this block rolls back; a termination after it preserves the new release.
trap '' HUP INT TERM
if ! printf '%s\tSUCCESS\t%s\t%s\t%s\t%s\t%s\t%s\t-\n' \
  "$(date -u +%FT%TZ)" "$RELEASE_ID" "$SERVICE" "${ACTUAL_SHA256,,}" "$COMMIT_SHA" "${ASSET_DIGEST:--}" "$DEPLOY_ACTOR" \
  >&"$HISTORY_FD"; then
  FAILURE_CONTEXT="history-success-write-failed;exit=1"
  rollback_release "unable to append the deployment SUCCESS record" || true
  fail "unable to append the deployment SUCCESS record"
fi
DEPLOY_COMPLETE="1"
exec {HISTORY_FD}>&- || true
HISTORY_FD=""
trap - HUP INT TERM

echo "PASS deployed immutable $SERVICE release $RELEASE_ID"
echo "PASS PM2/readiness identity commit=$COMMIT_SHA build=$BUILD_ID"
echo "PASS shared/data digest remained unchanged; no database or uploads were copied or seeded"
if [[ "$SERVICE" == "web" && "$ASSET_DIGEST" != "$CURRENT_ASSET_DIGEST" ]]; then
  echo "PASS non-atomic asset+Web pointer sequence was allowed only by the forward-compatible asset-superset proof"
fi
