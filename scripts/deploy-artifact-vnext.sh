#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

PROJECT_ID="zimeiti-caopanshou"
STORAGE_GUARD_PATH="/usr/local/libexec/zimeiti/verify-deploy-storage-runtime.sh"
STORAGE_GUARD_SHA256="c7d32c01a8747cc2e354aa2f12bc6990970d4860daa5b22c345b6c2c4e8c52b6"
STORAGE_READINESS_RECEIPT="/run/zimeiti/storage-readiness.json"
CANDIDATE_FIXTURE_HELPER_PATH="/usr/local/libexec/zimeiti/prepare-candidate-readiness-fixtures.py"
CANDIDATE_FIXTURE_HELPER_SHA256="ea62e6aa0676b26514491109fe13e950799585f51d41398b82817f83a860c3c6"
DEPLOY_NODE_BIN="/data/direct-deploy/toolchain/bin/node"
DEPLOY_RUNTIME_PATH="/data/direct-deploy/toolchain/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ASSET_POLICY_TRANSITION_VERIFIER_SHA256="55294aef46841fe6362f2a41df44c6d13fe196e7ffb904543b9b062743187bee"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/deploy-artifact-vnext.sh --plan \
    --release-mode WEB|VOICE --service web|voice \
    --artifact FILE --sha256 HEX --release-id ID --root ABSOLUTE_ROOT \
    [--asset-policy-transition-receipt FILE --asset-policy-transition-sha256 HEX]

  DEPLOY_EXECUTION_APPROVED=ID bash scripts/deploy-artifact-vnext.sh --execute \
    --release-mode WEB|VOICE --service web|voice \
    --artifact FILE --sha256 HEX --release-id ID --root ABSOLUTE_ROOT \
    [--asset-policy-transition-receipt FILE --asset-policy-transition-sha256 HEX]

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
When the asset digest changes, activation first requires a fully verified URL
superset: every old URL keeps identical bytes/SHA and only new URLs are added.
An asset-policy digest change is a separate gate. It requires a SHA-bound proof
showing that every policy field except requiredPaths is unchanged and that
requiredPaths only grows. A URL proof can never waive a policy change, and a
policy proof can never waive a URL mutation. Otherwise deployment fails closed.

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

require_trusted_root_executable() {
  local path="$1" label="$2" metadata uid gid mode links
  [[ -f "$path" && ! -L "$path" && -x "$path" ]] || \
    die "$label is not a regular executable: $path"
  metadata="$(stat -c '%u:%g:%a:%h' -- "$path" 2>/dev/null)" || \
    die "cannot stat $label: $path"
  IFS=: read -r uid gid mode links <<<"$metadata"
  [[ "$uid" == "0" && "$gid" == "0" && "$links" == "1" ]] || \
    die "$label must be a single-link root:root executable: $path"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "$label mode is invalid: $path mode=$mode"
  (( (8#$mode & 8#022) == 0 )) || die "$label must not be group/other writable: $path mode=$mode"
  [[ "$(readlink -f -- "$path")" == "$path" ]] || die "$label is not canonical: $path"
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
const forbiddenArtifactExtensions = new Set([".pem", ".key", ".pub", ".crt", ".cer", ".p7b", ".p12", ".pfx", ".map"]);
const sensitiveNameMarker = /(^|[._-])(?:api[._-]?key|private[._-]?key|secret(?:s)?|token(?:s)?|cookie(?:s)?|credential(?:s)?|service[._-]?account)(?=$|[._-])/iu;
const hiddenMetadataDirectoryNames = new Set([".git", ".svn", ".hg", ".history", ".cache"]);

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
    if (hiddenMetadataDirectoryNames.has(lowerPart)) return "source-control, history, or cache metadata path";
  }
  if (kind !== "file" || parts.length === 0) return null;
  if (isKnownNonSecretDependencySchema(normalizedPath)) return null;
  const fileName = parts.at(-1).toLowerCase();
  const extension = path.posix.extname(fileName);
  if (forbiddenArtifactExtensions.has(extension)) return "key, certificate, or source-map file";
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
const privateKeyPemPattern = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----([\s\S]{1,1048576}?)-----END \1-----/gu;
function containsStructurallyValidPrivateKeyPem(body) {
  const text = body.toString("latin1");
  privateKeyPemPattern.lastIndex = 0;
  for (const match of text.matchAll(privateKeyPemPattern)) {
    const label = match[1];
    const lines = match[2].replace(/\r/gu, "").split("\n");
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && /^[A-Za-z0-9-]+:[\t -~]*$/u.test(lines[0].trim())) lines.shift();
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && !lines.at(-1).trim()) lines.pop();
    if (lines.length === 0) continue;
    const encodedLines = lines.map((line) => line.trim());
    if (encodedLines.some((line) => !/^[A-Za-z0-9+/]+={0,2}$/u.test(line))) continue;
    const encoded = encodedLines.join("");
    if (encoded.length < 44 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) continue;
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length < 32 || decoded.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) continue;
    if (label === "OPENSSH PRIVATE KEY") {
      if (decoded.subarray(0, 15).equals(Buffer.from("openssh-key-v1\0", "ascii"))) return true;
    } else if (decoded[0] === 0x30) {
      return true;
    }
  }
  return false;
}
function assertSafeContent(filePath, relativePath) {
  const body = fs.readFileSync(filePath);
  if (containsStructurallyValidPrivateKeyPem(body)) {
    throw new Error(`forbidden private-key PEM content: ${normalize(relativePath)}`);
  }
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
      else assertSafeContent(entryPath, relativePath);
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
ASSET_POLICY_TRANSITION_RECEIPT=""
ASSET_POLICY_TRANSITION_SHA256=""

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
    --asset-policy-transition-receipt) ASSET_POLICY_TRANSITION_RECEIPT="${2:-}"; shift 2 ;;
    --asset-policy-transition-sha256) ASSET_POLICY_TRANSITION_SHA256="${2:-}"; shift 2 ;;
    --verify-sensitive-root) SENSITIVE_VERIFY_ROOT="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$SENSITIVE_VERIFY_ROOT" ]]; then
  [[ -z "$MODE$RELEASE_MODE$SERVICE$ARTIFACT$EXPECTED_SHA256$RELEASE_ID$RELEASE_ROOT$ASSET_POLICY_TRANSITION_RECEIPT$ASSET_POLICY_TRANSITION_SHA256" ]] || \
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
if [[ -n "$ASSET_POLICY_TRANSITION_RECEIPT" || -n "$ASSET_POLICY_TRANSITION_SHA256" ]]; then
  [[ "$SERVICE" == "web" ]] || die "asset policy transition proof is valid only for the Web release"
  [[ -n "$ASSET_POLICY_TRANSITION_RECEIPT" && "$ASSET_POLICY_TRANSITION_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || \
    die "asset policy transition receipt and its 64-character SHA-256 must be supplied together"
fi
[[ -n "$ARTIFACT" && -f "$ARTIFACT" && ! -L "$ARTIFACT" ]] || die "artifact must be an existing regular non-symlink file"
[[ "$RELEASE_ROOT" == /* ]] || die "--root must be an absolute Linux path"
[[ ! "$RELEASE_ROOT" =~ [[:space:]] ]] || die "--root must not contain whitespace"

for command_name in readlink sha256sum awk tar mktemp grep head rm stat; do
  require_command "$command_name"
done
require_trusted_root_executable "$DEPLOY_NODE_BIN" "deployment Node runtime"
PATH="$DEPLOY_RUNTIME_PATH"
export PATH
require_command node
[[ "$(readlink -f -- "$(command -v node)")" == "$DEPLOY_NODE_BIN" ]] || \
  die "deployment PATH did not select the pinned Node runtime"
[[ "$(node -p 'process.version + ":" + process.versions.modules')" == "v24.19.0:137" ]] || \
  die "deployment Node runtime must be exact Node v24.19.0 with ABI 137"
tar --version 2>/dev/null | head -n 1 | grep -q "GNU tar" || die "GNU tar is required for deterministic safe extraction"

ARTIFACT="$(readlink -f -- "$ARTIFACT")"
DEPLOY_SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
DEPLOY_SCRIPT_DIR="${DEPLOY_SCRIPT_PATH%/*}"
CONTROL_PLANE_ROOT="$(readlink -f -- "$DEPLOY_SCRIPT_DIR/..")"
ASSET_POLICY_TRANSITION_VERIFIER="$CONTROL_PLANE_ROOT/scripts/asset-policy-transition-proof-vnext.mjs"
PREFLIGHT_CREATOR="$CONTROL_PLANE_ROOT/scripts/create-production-preflight-receipt.mjs"
PREFLIGHT_VERIFIER="$CONTROL_PLANE_ROOT/scripts/verify-production-preflight-receipt.mjs"
PREFLIGHT_SCHEMA="$CONTROL_PLANE_ROOT/scripts/contracts/production-preflight-receipt.v1.schema.json"
PREFLIGHT_REFERENCE_CONTRACT="$CONTROL_PLANE_ROOT/scripts/contracts/production-preflight-reference.v1.json"
PREFLIGHT_DATABASE_CONTRACT="$CONTROL_PLANE_ROOT/deploy/policies/database-contract.v1.json"
PREFLIGHT_SEMANTIC_CONTRACT="$CONTROL_PLANE_ROOT/deploy/policies/database-semantic-contract.v1.json"
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
CANDIDATE_USER="zimeiti-candidate"
CANDIDATE_HOME="/nonexistent"
CANDIDATE_SHELL="/usr/sbin/nologin"
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

verify_boot_bound_storage_receipt() {
  [[ -f "$STORAGE_READINESS_RECEIPT" && ! -L "$STORAGE_READINESS_RECEIPT" ]] || \
    die "boot-bound storage readiness receipt is missing: $STORAGE_READINESS_RECEIPT"
  node - "$STORAGE_READINESS_RECEIPT" <<'NODE'
const fs = require("node:fs");
const receiptPath = process.argv[2];
const stats = fs.lstatSync(receiptPath);
if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.uid !== 0 || stats.gid !== 0 || (stats.mode & 0o777) !== 0o600 || stats.size > 65536) {
  throw new Error("storage readiness receipt metadata is unsafe");
}
const value = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
const exactKeys = (object, keys, label) => {
  if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error(`${label} is not an object`);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} contains unexpected fields`);
};
exactKeys(value, ["schemaVersion", "status", "verifiedAt", "verifiedEpoch", "bootId", "guard", "mount", "marker", "capacity", "paths", "security", "receipt"], "storage receipt");
if (value.schemaVersion !== "zimeiti-storage-readiness.v1" || value.status !== "ready") throw new Error("storage receipt identity mismatch");
const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
if (value.bootId !== bootId) throw new Error("storage receipt belongs to a different boot");
const now = Math.floor(Date.now() / 1000);
if (!Number.isSafeInteger(value.verifiedEpoch) || value.verifiedEpoch > now + 5 || now - value.verifiedEpoch > 60) throw new Error("storage receipt is stale");
if (value.mount?.rootTarget !== "/" || value.mount?.target !== "/data" || value.mount?.independent !== true
    || !["ext4", "xfs"].includes(value.mount?.fstype) || value.mount?.source === value.mount?.rootSource
    || value.mount?.majorMinor === value.mount?.rootMajorMinor) throw new Error("storage mount isolation receipt is invalid");
if (value.paths?.dataRoot !== "/data" || value.paths?.webRoot !== "/data/web"
    || value.paths?.rootAndDataTargetsDistinct !== true || value.paths?.rootAndDataDevicesDistinct !== true
    || value.paths?.rootAndDataSourcesDistinct !== true || value.paths?.webRootOnDataDevice !== true) {
  throw new Error("storage path isolation receipt is invalid");
}
if (value.guard?.script !== "verify-deploy-storage-runtime.sh" || value.guard?.configPath !== "/etc/zimeiti/deploy-storage.conf"
    || value.receipt?.path !== receiptPath || value.receipt?.ownerUid !== 0 || value.receipt?.ownerGid !== 0
    || value.receipt?.mode !== "0600" || value.receipt?.atomicWrite !== true) throw new Error("storage receipt provenance is invalid");
if (!Number.isSafeInteger(value.capacity?.availableBytes) || !Number.isSafeInteger(value.capacity?.minimumAvailableBytes)
    || value.capacity.availableBytes < value.capacity.minimumAvailableBytes
    || !Number.isSafeInteger(value.capacity?.availableInodes) || !Number.isSafeInteger(value.capacity?.minimumAvailableInodes)
    || value.capacity.availableInodes < value.capacity.minimumAvailableInodes) throw new Error("storage capacity receipt is invalid");
NODE
}

run_storage_boot_guard() {
  require_trusted_controller_file "$STORAGE_GUARD_PATH" "trusted storage guard"
  [[ -x "$STORAGE_GUARD_PATH" ]] || \
    die "trusted storage guard is not installed on the system disk: $STORAGE_GUARD_PATH"
  local actual_sha
  actual_sha="$(sha256sum "$STORAGE_GUARD_PATH" | awk '{print $1}')"
  [[ "$actual_sha" == "$STORAGE_GUARD_SHA256" ]] || die "trusted storage guard SHA-256 mismatch"
  "$STORAGE_GUARD_PATH" >/dev/null || die "dedicated storage runtime guard rejected this boot"
  verify_boot_bound_storage_receipt || die "boot-bound storage readiness receipt validation failed"
}

require_trusted_controller_file() {
  local file="$1" label="$2" resolved metadata uid gid mode links directory
  [[ -f "$file" && ! -L "$file" ]] || die "$label is not a regular non-symlink file: $file"
  resolved="$(readlink -f -- "$file")" || die "cannot resolve $label"
  [[ "$resolved" == "$file" ]] || die "$label path is not canonical: $file"
  metadata="$(stat -c '%u:%g:%a:%h' -- "$file")" || die "cannot stat $label"
  IFS=: read -r uid gid mode links <<<"$metadata"
  [[ "$uid" == "0" && "$gid" == "0" && "$links" == "1" ]] || \
    die "$label must be a single-link root:root regular file"
  [[ "$mode" =~ ^0?[0-7]{3}$ ]] || die "$label mode is invalid"
  (( (8#$mode & 8#022) == 0 )) || die "$label must not be group/other writable"
  directory="${file%/*}"
  while [[ "$directory" != "/" ]]; do
    [[ -d "$directory" && ! -L "$directory" ]] || die "$label parent is not a regular directory: $directory"
    metadata="$(stat -c '%u:%g:%a' -- "$directory")" || die "cannot stat $label parent"
    IFS=: read -r uid gid mode <<<"$metadata"
    [[ "$uid" == "0" && "$gid" == "0" && "$mode" =~ ^0?[0-7]{3}$ ]] || \
      die "$label parent chain is not root-controlled: $directory"
    (( (8#$mode & 8#022) == 0 )) || die "$label parent chain is writable by group/other: $directory"
    directory="${directory%/*}"
    [[ -n "$directory" ]] || directory="/"
  done
}

run_production_preflight() {
  local trusted_file source_version migration_manifest_sha receipt_path creator_summary verifier_summary receipt_metadata
  for trusted_file in \
    "$PREFLIGHT_CREATOR" "$PREFLIGHT_VERIFIER" "$PREFLIGHT_SCHEMA" \
    "$PREFLIGHT_REFERENCE_CONTRACT" "$PREFLIGHT_DATABASE_CONTRACT" "$PREFLIGHT_SEMANTIC_CONTRACT"; do
    require_trusted_controller_file "$trusted_file" "production preflight controller input"
  done
  source_version="$(node - "$PAYLOAD_DIR/public/version.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const stats = fs.lstatSync(file);
if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) throw new Error("public version identity is unsafe");
const value = JSON.parse(fs.readFileSync(file, "utf8"));
if (typeof value.sourceVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.sourceVersion)) {
  throw new Error("public sourceVersion is invalid");
}
process.stdout.write(value.sourceVersion);
NODE
)" || die "candidate sourceVersion is unavailable for production preflight binding"
  migration_manifest_sha="$(node - "$PREFLIGHT_SEMANTIC_CONTRACT" <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.schemaVersion !== 1 || value.kind !== "database-semantic-contract"
    || typeof value.migrationManifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.migrationManifestSha256)) {
  throw new Error("database semantic contract migration identity is invalid");
}
process.stdout.write(value.migrationManifestSha256);
NODE
)" || die "migration manifest identity is unavailable for production preflight binding"

  receipt_path="$LOG_ROOT/production-preflight-$SERVICE-$RELEASE_ID.json"
  PRODUCTION_PREFLIGHT_RECEIPT_PATH="$receipt_path"
  creator_summary="$STAGING_DIR/production-preflight-create-summary.json"
  verifier_summary="$STAGING_DIR/production-preflight-verify-summary.json"
  [[ ! -e "$receipt_path" && ! -L "$receipt_path" ]] || die "immutable production preflight receipt already exists: $receipt_path"
  export PRODUCTION_PREFLIGHT_RECEIPT_HMAC_KEY
  export PRODUCTION_PREFLIGHT_RECEIPT_KEY_ID
  PRODUCTION_PREFLIGHT_RECEIPT_HMAC_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')"
  PRODUCTION_PREFLIGHT_RECEIPT_KEY_ID="ephemeral-$SERVICE-$RELEASE_ID-$$"
  if ! node "$PREFLIGHT_CREATOR" \
    --output "$receipt_path" \
    --release-id "$RELEASE_ID" \
    --artifact-sha256 "${ACTUAL_SHA256,,}" \
    --commit "$COMMIT_SHA" \
    --source-version "$source_version" \
    --build-id "$BUILD_ID" \
    --migration-manifest-sha256 "$migration_manifest_sha" \
    >"$creator_summary" 2>"$creator_summary.error"; then
    unset PRODUCTION_PREFLIGHT_RECEIPT_HMAC_KEY PRODUCTION_PREFLIGHT_RECEIPT_KEY_ID
    fail "trusted GET-only production preflight failed; see $creator_summary.error"
  fi
  if ! node "$PREFLIGHT_VERIFIER" \
    --receipt "$receipt_path" \
    --release-id "$RELEASE_ID" \
    --artifact-sha256 "${ACTUAL_SHA256,,}" \
    --commit "$COMMIT_SHA" \
    --source-version "$source_version" \
    --build-id "$BUILD_ID" \
    --migration-manifest-sha256 "$migration_manifest_sha" \
    >"$verifier_summary" 2>"$verifier_summary.error"; then
    unset PRODUCTION_PREFLIGHT_RECEIPT_HMAC_KEY PRODUCTION_PREFLIGHT_RECEIPT_KEY_ID
    fail "production preflight receipt verification failed; see $verifier_summary.error"
  fi
  unset PRODUCTION_PREFLIGHT_RECEIPT_HMAC_KEY PRODUCTION_PREFLIGHT_RECEIPT_KEY_ID
  [[ -f "$receipt_path" && ! -L "$receipt_path" ]] || die "production preflight receipt is not a regular non-symlink file"
  receipt_metadata="$(stat -c '%u:%g:%a:%h' -- "$receipt_path")" || die "cannot stat production preflight receipt"
  [[ "$receipt_metadata" == "0:0:600:1" ]] || die "production preflight receipt metadata is unsafe"
  PRODUCTION_PREFLIGHT_RECEIPT_SHA256="$(sha256sum "$receipt_path" | awk '{print $1}')"
  [[ "$PRODUCTION_PREFLIGHT_RECEIPT_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "production preflight receipt SHA-256 is invalid"
}

assert_fresh_production_preflight_receipt() {
  [[ -n "$PRODUCTION_PREFLIGHT_RECEIPT_PATH" && -f "$PRODUCTION_PREFLIGHT_RECEIPT_PATH" && ! -L "$PRODUCTION_PREFLIGHT_RECEIPT_PATH" ]] || \
    die "production preflight receipt disappeared before activation"
  local current_sha
  current_sha="$(sha256sum "$PRODUCTION_PREFLIGHT_RECEIPT_PATH" | awk '{print $1}')"
  [[ "$current_sha" == "$PRODUCTION_PREFLIGHT_RECEIPT_SHA256" ]] || die "production preflight receipt changed before activation"
  node - "$PRODUCTION_PREFLIGHT_RECEIPT_PATH" "$RELEASE_ID" "${ACTUAL_SHA256,,}" "$COMMIT_SHA" "$BUILD_ID" <<'NODE'
const fs = require("node:fs");
const [file, releaseId, artifactSha256, commitSha, buildId] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const now = Math.floor(Date.now() / 1000);
if (value.status !== "passed" || value.binding?.releaseId !== releaseId
    || value.binding?.artifactSha256 !== artifactSha256 || value.binding?.commitSha !== commitSha
    || value.binding?.buildId !== buildId) throw new Error("production preflight receipt binding changed");
if (!Number.isSafeInteger(value.issuedAtEpoch) || !Number.isSafeInteger(value.expiresAtEpoch)
    || value.expiresAtEpoch - value.issuedAtEpoch !== 300 || value.issuedAtEpoch > now + 5
    || value.expiresAtEpoch <= now) throw new Error("production preflight receipt expired before activation");
for (const counter of ["databaseWrites", "rpcRequests", "providerRequests", "paidRequests"]) {
  if (value.counters?.[counter] !== 0) throw new Error(`production preflight counter is nonzero: ${counter}`);
}
NODE
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
candidate_unit=""
candidate_cgroup=""
CANDIDATE_LOG=""
CANDIDATE_PRIVATE_LOG=""
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
PRODUCTION_PREFLIGHT_RECEIPT_SHA256="-"
PRODUCTION_PREFLIGHT_RECEIPT_PATH=""

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

candidate_cgroup_empty() {
  local control_group="$1"
  local cgroup_path populated
  [[ "$control_group" =~ ^/system\.slice/zimeiti-candidate-(web|voice)-[0-9]+\.service$ ]] || return 1
  cgroup_path="/sys/fs/cgroup$control_group"
  if [[ ! -e "$cgroup_path" && ! -L "$cgroup_path" ]]; then return 0; fi
  [[ -d "$cgroup_path" && ! -L "$cgroup_path" && -r "$cgroup_path/cgroup.events" ]] || return 1
  populated="$(awk '
    $1 == "populated" { count += 1; value = $2 }
    END { if (count != 1 || (value != "0" && value != "1")) exit 1; print value }
  ' "$cgroup_path/cgroup.events" 2>/dev/null)" || return 1
  [[ "$populated" == "0" ]]
}

candidate_unit_stopped() {
  local load_state active_state main_pid current_cgroup
  [[ -n "$candidate_unit" ]] || return 0
  load_state="$(systemctl show --property=LoadState --value "$candidate_unit" 2>/dev/null || true)"
  if [[ -z "$load_state" || "$load_state" == "not-found" ]]; then
    [[ -n "$candidate_cgroup" ]] && candidate_cgroup_empty "$candidate_cgroup"
    return
  fi
  active_state="$(systemctl show --property=ActiveState --value "$candidate_unit" 2>/dev/null || true)"
  main_pid="$(systemctl show --property=MainPID --value "$candidate_unit" 2>/dev/null || true)"
  current_cgroup="$(systemctl show --property=ControlGroup --value "$candidate_unit" 2>/dev/null || true)"
  if [[ -n "$current_cgroup" ]]; then
    [[ "$current_cgroup" =~ ^/system\.slice/zimeiti-candidate-(web|voice)-[0-9]+\.service$ ]] || return 1
    candidate_cgroup="$current_cgroup"
  fi
  [[ "$active_state" == "inactive" && "$main_pid" == "0" && -n "$candidate_cgroup" ]] || return 1
  candidate_cgroup_empty "$candidate_cgroup"
}

wait_candidate_unit_stopped() {
  local attempt
  for ((attempt = 1; attempt <= 25; attempt += 1)); do
    candidate_unit_stopped && return 0
    sleep 0.2
  done
  return 1
}

publish_candidate_log() {
  [[ -n "$CANDIDATE_PRIVATE_LOG" && -n "$CANDIDATE_LOG" ]] || return 0
  [[ -e "$CANDIDATE_PRIVATE_LOG" && ! -L "$CANDIDATE_PRIVATE_LOG" ]] || return 1
  node - "$CANDIDATE_PRIVATE_LOG" "$CANDIDATE_LOG" "$CANDIDATE_UID" "$SERVICE" "$RELEASE_ID" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [sourcePath, destinationPath, expectedUidText, service, releaseId] = process.argv.slice(2);
const expectedUid = Number(expectedUidText);
const noFollow = fs.constants.O_NOFOLLOW || 0;
const sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
let sourceBytes;
let tailSourceBytes;
let bodyBuffer;
try {
  const stats = fs.fstatSync(sourceFd);
  if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== expectedUid || stats.size > 134217728) {
    throw new Error("private candidate log metadata is unsafe");
  }
  sourceBytes = stats.size;
  tailSourceBytes = Math.min(stats.size, 262144);
  const buffer = Buffer.alloc(tailSourceBytes);
  if (tailSourceBytes) fs.readSync(sourceFd, buffer, 0, tailSourceBytes, stats.size - tailSourceBytes);
  const body = buffer.toString("utf8")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?")
    .replace(/((?:api[_-]?key|secret|token|password|authorization)[^:=\n]{0,32}[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]");
  bodyBuffer = Buffer.from(body, "utf8");
} finally {
  fs.closeSync(sourceFd);
}
const payloadSha256 = crypto.createHash("sha256").update(bodyBuffer).digest("hex");
const header = Buffer.from(
  `candidate-log.v2 service=${service} release=${releaseId} source_bytes=${sourceBytes} `
  + `source_tail_bytes=${tailSourceBytes} payload_bytes=${bodyBuffer.length} payload_sha256=${payloadSha256}\n`,
  "utf8",
);
const completeLog = Buffer.concat([header, bodyBuffer]);

function validatePublishedLog(buffer) {
  const newline = buffer.indexOf(0x0a);
  if (newline <= 0) throw new Error("published candidate log header is missing or truncated");
  const headerText = buffer.subarray(0, newline).toString("utf8");
  const match = /^candidate-log\.v2 service=([^ ]+) release=([^ ]+) source_bytes=([0-9]+) source_tail_bytes=([0-9]+) payload_bytes=([0-9]+) payload_sha256=([a-f0-9]{64})$/u.exec(headerText);
  if (!match || match[1] !== service || match[2] !== releaseId) {
    throw new Error("published candidate log identity header is invalid");
  }
  const declaredSourceBytes = Number(match[3]);
  const declaredTailSourceBytes = Number(match[4]);
  const declaredPayloadBytes = Number(match[5]);
  const payload = buffer.subarray(newline + 1);
  if (!Number.isSafeInteger(declaredSourceBytes) || declaredSourceBytes !== sourceBytes
      || !Number.isSafeInteger(declaredTailSourceBytes) || declaredTailSourceBytes !== tailSourceBytes
      || !Number.isSafeInteger(declaredPayloadBytes) || declaredPayloadBytes !== payload.length) {
    throw new Error("published candidate log length summary is invalid");
  }
  const observedSha256 = crypto.createHash("sha256").update(payload).digest("hex");
  if (observedSha256 !== match[6]) throw new Error("published candidate log payload digest is invalid");
  if (!buffer.equals(completeLog)) throw new Error("published candidate log does not match the retained private log tail");
}

function validateExistingDestination() {
  const existing = fs.lstatSync(destinationPath);
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : existing.uid;
  const effectiveGid = typeof process.getegid === "function" ? process.getegid() : existing.gid;
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1
      || existing.uid !== effectiveUid || existing.gid !== effectiveGid
      || existing.size !== completeLog.length) {
    throw new Error("published candidate log path or complete length is unsafe");
  }
  validatePublishedLog(fs.readFileSync(destinationPath));
}

if (fs.existsSync(destinationPath)) {
  validateExistingDestination();
  process.exit(0);
}

const temporaryPath = path.join(
  path.dirname(destinationPath),
  `.${path.basename(destinationPath)}.tmp.${process.pid}.${crypto.randomBytes(12).toString("hex")}`,
);
const destinationFd = fs.openSync(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
try {
  fs.writeFileSync(destinationFd, completeLog);
  fs.fchmodSync(destinationFd, 0o600);
  fs.fsyncSync(destinationFd);
} finally {
  fs.closeSync(destinationFd);
}
let linked = false;
try {
  try {
    fs.linkSync(temporaryPath, destinationPath);
    linked = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    validateExistingDestination();
  }
} finally {
  fs.unlinkSync(temporaryPath);
}
if (linked) validateExistingDestination();
NODE
}

cleanup_candidate() {
  [[ -n "$candidate_unit" ]] || return 0
  systemctl stop -- "$candidate_unit" >/dev/null 2>&1 || true
  systemctl reset-failed -- "$candidate_unit" >/dev/null 2>&1 || true
  if ! wait_candidate_unit_stopped; then
    systemctl kill --kill-whom=all --signal=SIGKILL -- "$candidate_unit" >/dev/null 2>&1 || true
    systemctl stop -- "$candidate_unit" >/dev/null 2>&1 || true
    systemctl reset-failed -- "$candidate_unit" >/dev/null 2>&1 || true
    wait_candidate_unit_stopped || return 1
  fi
  publish_candidate_log || return 1
  systemctl reset-failed -- "$candidate_unit" >/dev/null 2>&1 || true
  candidate_pid=""
  candidate_unit=""
  candidate_cgroup=""
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
  local candidate_cleanup_ok="1"
  if ! cleanup_candidate; then
    candidate_cleanup_ok="0"
    FAILURE_CONTEXT="${FAILURE_CONTEXT};candidate-cleanup=unconfirmed"
    exit_status=1
    echo "CLEANUP BLOCKED: candidate unit remains controlled; staging is retained for safe recovery: $candidate_unit" >&2
  fi
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
  if [[ -n "$STAGING_DIR" ]]; then
    if [[ "$candidate_cleanup_ok" == "1" && -z "$candidate_unit" ]]; then
      safe_remove_staging || true
    else
      echo "CLEANUP RETAINED: $STAGING_DIR" >&2
    fi
  fi
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
requireCondition(typeof manifest.sourceVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(manifest.sourceVersion), "missing or unsafe source version");
requireCondition(typeof manifest.buildOutputDigest === "string" && hex64.test(manifest.buildOutputDigest), "invalid build output digest");
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
  sourceVersion: manifest.sourceVersion,
  buildOutputDigest: manifest.buildOutputDigest,
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
const forbiddenArtifactExtensions = new Set([".pem", ".key", ".pub", ".crt", ".cer", ".p7b", ".p12", ".pfx", ".map"]);
const sensitiveNameMarker = /(^|[._-])(?:api[._-]?key|private[._-]?key|secret(?:s)?|token(?:s)?|cookie(?:s)?|credential(?:s)?|service[._-]?account)(?=$|[._-])/iu;
const hiddenMetadataDirectoryNames = new Set([".git", ".svn", ".hg", ".history", ".cache"]);

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
    if (hiddenMetadataDirectoryNames.has(lowerPart)) return "source-control, history, or cache metadata path";
  }
  if (kind !== "file") return null;
  if (isKnownNonSecretDependencySchema(relativePath)) return null;
  const fileName = parts.at(-1).toLowerCase();
  const extension = path.posix.extname(fileName);
  if (forbiddenArtifactExtensions.has(extension)) return "key, certificate, or source-map file";
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

const privateKeyPemPattern = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----([\s\S]{1,1048576}?)-----END \1-----/gu;
function containsStructurallyValidPrivateKeyPem(body) {
  const text = body.toString("latin1");
  privateKeyPemPattern.lastIndex = 0;
  for (const match of text.matchAll(privateKeyPemPattern)) {
    const label = match[1];
    const lines = match[2].replace(/\r/gu, "").split("\n");
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && /^[A-Za-z0-9-]+:[\t -~]*$/u.test(lines[0].trim())) lines.shift();
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && !lines.at(-1).trim()) lines.pop();
    if (lines.length === 0) continue;
    const encodedLines = lines.map((line) => line.trim());
    if (encodedLines.some((line) => !/^[A-Za-z0-9+/]+={0,2}$/u.test(line))) continue;
    const encoded = encodedLines.join("");
    if (encoded.length < 44 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) continue;
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length < 32 || decoded.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) continue;
    if (label === "OPENSSH PRIVATE KEY") {
      if (decoded.subarray(0, 15).equals(Buffer.from("openssh-key-v1\0", "ascii"))) return true;
    } else if (decoded[0] === 0x30) {
      return true;
    }
  }
  return false;
}
function assertSafeContent(filePath, relativePath) {
  const body = fs.readFileSync(filePath);
  if (containsStructurallyValidPrivateKeyPem(body)) {
    throw new Error(`extracted payload contains forbidden private-key PEM content: ${relativePath}`);
  }
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const actual = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const filePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    const stats = fs.lstatSync(filePath);
    assertNotSensitive(relativePath, "extracted payload", stats.isDirectory() ? "directory" : "file");
    if (stats.isSymbolicLink()) throw new Error(`extracted payload contains a symlink: ${relativePath}`);
    if (stats.isDirectory()) {
      actual.push({ path: relativePath, kind: "directory", mode: stats.mode & 0o777, bytes: 0, sha256: null });
      walk(filePath);
    }
    else if (stats.isFile()) {
      assertSafeContent(filePath, relativePath);
      if (relativePath !== "release-manifest.json") {
        actual.push({ path: relativePath, kind: "file", mode: stats.mode & 0o777, bytes: stats.size, sha256: sha256File(filePath) });
      }
    }
    else throw new Error(`extracted payload contains a non-regular entry: ${relativePath}`);
  }
}
walk(root);
actual.sort((left, right) => left.path.localeCompare(right.path, "en"));
for (const { path: relativePath } of actual) {
  if (relativePath === "public/storyboard-reviews" || relativePath.startsWith("public/storyboard-reviews/") ||
      relativePath === "public/demo-assets" || relativePath.startsWith("public/demo-assets/")) {
    throw new Error(`test/evidence content is forbidden in a production service artifact: ${relativePath}`);
  }
}

const seen = new Set();
let previousPath = "";
let totalBytes = 0;
let expectedFileCount = 0;
for (const item of expected) {
  if (!validateRelative(item?.path)) throw new Error(`unsafe manifest inventory path: ${String(item?.path)}`);
  if (!new Set(["file", "directory"]).has(item.kind)) throw new Error(`invalid inventory kind: ${item.path}`);
  assertNotSensitive(item.path, "manifest inventory", item.kind);
  if (seen.has(item.path)) throw new Error(`duplicate manifest inventory path: ${item.path}`);
  if (previousPath && previousPath.localeCompare(item.path, "en") >= 0) throw new Error("manifest inventory is not strictly sorted");
  if (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777 || (item.mode & 0o022) !== 0) {
    throw new Error(`invalid or writable inventory mode: ${item.path}`);
  }
  if (item.kind === "directory") {
    if (item.bytes !== 0 || item.sha256 !== null) throw new Error(`invalid directory inventory metadata: ${item.path}`);
  } else {
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !hex64.test(item.sha256)) {
      throw new Error(`invalid file inventory metadata: ${item.path}`);
    }
    expectedFileCount += 1;
    totalBytes += item.bytes;
  }
  seen.add(item.path);
  previousPath = item.path;
}
if (actual.length !== expected.length || actual.some((value, index) => value.path !== expected[index].path || value.kind !== expected[index].kind)) {
  throw new Error("extracted path/type set does not exactly match the signed inventory");
}
for (let index = 0; index < expected.length; index += 1) {
  const item = expected[index];
  const observed = actual[index];
  if (observed.mode !== item.mode) throw new Error(`inventory mode mismatch: ${item.path}`);
  if (item.kind === "file" && (observed.bytes !== item.bytes || observed.sha256 !== item.sha256)) {
    throw new Error(`inventory content mismatch: ${item.path}`);
  }
}
const artifactDigest = crypto.createHash("sha256").update(canonicalJson(expected)).digest("hex");
if (manifest.artifactDigest !== artifactDigest) throw new Error("artifact digest mismatch");
if (manifest.fileCount !== expectedFileCount) throw new Error("artifact fileCount mismatch");
if (manifest.totalBytes !== totalBytes) throw new Error("artifact totalBytes mismatch");
for (const required of ["server.js", ".release/ecosystem.config.cjs"]) {
  if (!seen.has(required) || expected.find((entry) => entry.path === required)?.kind !== "file") {
    throw new Error(`artifact inventory omits required runtime file: ${required}`);
  }
}

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
  local actual_verifier_sha receipt_real actual_receipt_sha
  local -a verifier_args
  require_trusted_controller_file "$ASSET_POLICY_TRANSITION_VERIFIER" "asset policy transition verifier"
  actual_verifier_sha="$(sha256sum "$ASSET_POLICY_TRANSITION_VERIFIER" | awk '{print $1}')"
  [[ "$actual_verifier_sha" == "$ASSET_POLICY_TRANSITION_VERIFIER_SHA256" ]] || \
    die "asset policy transition verifier SHA-256 mismatch"
  verifier_args=(
    --verify
    --current-manifest "$current_manifest"
    --next-manifest "$next_manifest"
  )
  if [[ -n "$ASSET_POLICY_TRANSITION_RECEIPT" ]]; then
    require_trusted_controller_file "$ASSET_POLICY_TRANSITION_RECEIPT" "asset policy transition receipt"
    receipt_real="$(readlink -f -- "$ASSET_POLICY_TRANSITION_RECEIPT")"
    [[ "$receipt_real" == "$CONTROL_PLANE_ROOT/receipts/"* ]] || \
      die "asset policy transition receipt must stay below the trusted control receipts directory"
    actual_receipt_sha="$(sha256sum "$receipt_real" | awk '{print $1}')"
    [[ "$actual_receipt_sha" == "${ASSET_POLICY_TRANSITION_SHA256,,}" ]] || \
      die "asset policy transition receipt SHA-256 mismatch"
    verifier_args+=(--receipt "$receipt_real" --receipt-sha256 "${ASSET_POLICY_TRANSITION_SHA256,,}")
  fi
  node "$ASSET_POLICY_TRANSITION_VERIFIER" "${verifier_args[@]}"
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
SOURCE_VERSION="$(metadata_value sourceVersion)"
BUILD_OUTPUT_DIGEST="$(metadata_value buildOutputDigest)"
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
echo "SOURCE_VERSION=$SOURCE_VERSION"
echo "BUILD_OUTPUT_DIGEST=$BUILD_OUTPUT_DIGEST"
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
for command_name in curl pm2 ss flock cmp cp mv id stat mkdir ln dirname tail tr env sleep date chown chmod find systemd-run systemctl nsenter getent passwd python3; do require_command "$command_name"; done
mv --version 2>/dev/null | head -n 1 | grep -q "GNU coreutils" || die "GNU coreutils mv is required for atomic symlink replacement"
SYSTEMD_VERSION="$(systemd-run --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
[[ "$SYSTEMD_VERSION" =~ ^[0-9]+$ && "$SYSTEMD_VERSION" -ge 255 ]] || \
  die "systemd 255 or newer is required for the isolated candidate environment contract"
run_storage_boot_guard
DEPLOY_ACTOR="${DEPLOY_OPERATOR:-$(id -un)}"
[[ "$DEPLOY_ACTOR" =~ ^[A-Za-z0-9@._-]{1,128}$ ]] || die "DEPLOY_OPERATOR contains unsafe audit characters"

[[ -f "$CANDIDATE_FIXTURE_HELPER_PATH" && ! -L "$CANDIDATE_FIXTURE_HELPER_PATH" && -x "$CANDIDATE_FIXTURE_HELPER_PATH" ]] || \
  die "trusted candidate fixture helper is not provisioned: $CANDIDATE_FIXTURE_HELPER_PATH"
[[ "$(stat -c '%u:%g:%a:%h' -- "$CANDIDATE_FIXTURE_HELPER_PATH")" == "0:0:755:1" ]] || \
  die "trusted candidate fixture helper must be a single-link root:root 0755 regular file"
[[ "$(sha256sum -- "$CANDIDATE_FIXTURE_HELPER_PATH" | awk 'NR == 1 { print $1 }')" == "$CANDIDATE_FIXTURE_HELPER_SHA256" ]] || \
  die "trusted candidate fixture helper SHA-256 does not match the reviewed control plane"

CANDIDATE_PASSWD="$(getent passwd "$CANDIDATE_USER" || true)"
[[ -n "$CANDIDATE_PASSWD" && "$CANDIDATE_PASSWD" != *$'\n'* ]] || \
  die "dedicated candidate sandbox user is missing or ambiguous: $CANDIDATE_USER"
IFS=: read -r candidate_name _ CANDIDATE_UID CANDIDATE_GID _ candidate_home candidate_shell <<<"$CANDIDATE_PASSWD"
[[ "$candidate_name" == "$CANDIDATE_USER" && "$CANDIDATE_UID" =~ ^[0-9]+$ && \
   "$CANDIDATE_GID" =~ ^[0-9]+$ && "$CANDIDATE_UID" != "0" ]] || \
  die "candidate sandbox user must have the exact non-root numeric identity"
[[ "$candidate_home" == "$CANDIDATE_HOME" && "$candidate_shell" == "$CANDIDATE_SHELL" ]] || \
  die "candidate sandbox user must use $CANDIDATE_HOME and $CANDIDATE_SHELL"
[[ ! -e "$CANDIDATE_HOME" && ! -L "$CANDIDATE_HOME" ]] || die "candidate no-home path unexpectedly exists"
[[ "$(getent passwd "$CANDIDATE_UID")" == "$CANDIDATE_PASSWD" ]] || die "candidate uid reverse lookup is not unique"
CANDIDATE_GROUP="$(getent group "$CANDIDATE_USER" || true)"
[[ -n "$CANDIDATE_GROUP" && "$CANDIDATE_GROUP" != *$'\n'* ]] || die "candidate primary group is missing or ambiguous"
IFS=: read -r candidate_group_name _ candidate_group_gid candidate_group_members <<<"$CANDIDATE_GROUP"
[[ "$candidate_group_name" == "$CANDIDATE_USER" && "$candidate_group_gid" == "$CANDIDATE_GID" && -z "$candidate_group_members" ]] || \
  die "candidate must have its own empty primary group"
[[ "$(getent group "$CANDIDATE_GID")" == "$CANDIDATE_GROUP" ]] || die "candidate gid reverse lookup is not unique"
[[ "$(id -u "$CANDIDATE_USER")" == "$CANDIDATE_UID" && "$(id -g "$CANDIDATE_USER")" == "$CANDIDATE_GID" ]] || \
  die "candidate id lookup does not match passwd/group"
[[ "$(id -G "$CANDIDATE_USER" | tr -s ' ' | awk '{$1=$1; print}')" == "$CANDIDATE_GID" ]] || \
  die "candidate sandbox user must not belong to supplementary groups"
CANDIDATE_SHADOW="$(getent shadow "$CANDIDATE_USER" || true)"
[[ -n "$CANDIDATE_SHADOW" && "$CANDIDATE_SHADOW" != *$'\n'* ]] || die "candidate shadow identity is missing or ambiguous"
candidate_shadow_password="${CANDIDATE_SHADOW#*:}"
candidate_shadow_password="${candidate_shadow_password%%:*}"
[[ "$candidate_shadow_password" == '!'* || "$candidate_shadow_password" == '*'* ]] || die "candidate password is not locked"
passwd -S "$CANDIDATE_USER" | awk 'NR == 1 { exit !($2 == "L" || $2 == "LK") }' || die "candidate account is not reported locked"
[[ -f "$CANDIDATE_SHELL" && ! -L "$CANDIDATE_SHELL" && -x "$CANDIDATE_SHELL" ]] || die "candidate nologin shell is unsafe"
candidate_shell_metadata="$(stat -c '%u:%g:%a' -- "$CANDIDATE_SHELL")"
IFS=: read -r candidate_shell_uid candidate_shell_gid candidate_shell_mode <<<"$candidate_shell_metadata"
[[ "$candidate_shell_uid" == "0" && "$candidate_shell_gid" == "0" && \
   $((8#$candidate_shell_mode & 8#022)) -eq 0 ]] || die "candidate nologin shell must be root-owned and not group/other writable"
CANDIDATE_PROCESS_COUNT=0
for candidate_status_path in /proc/[0-9]*/status; do
  [[ -r "$candidate_status_path" ]] || continue
  candidate_process_uid="$(awk '$1 == "Uid:" { print $2; exit }' "$candidate_status_path" 2>/dev/null || true)"
  [[ "$candidate_process_uid" != "$CANDIDATE_UID" ]] || CANDIDATE_PROCESS_COUNT=$((CANDIDATE_PROCESS_COUNT + 1))
done
(( CANDIDATE_PROCESS_COUNT == 0 )) || die "candidate user already owns active processes"

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
PUBLIC_ASSET_ROOT="$ASSET_TARGET/public"
CANDIDATE_STATE_ROOT="$STAGING_DIR/candidate-state"
CANDIDATE_HOME_DIR="$CANDIDATE_STATE_ROOT/home"
CANDIDATE_DATA_DIR="$CANDIDATE_STATE_ROOT/data"
CANDIDATE_RUNTIME_DIR="$CANDIDATE_STATE_ROOT/runtime"
CANDIDATE_COMMERCE_DIR="$CANDIDATE_RUNTIME_DIR/commerce-agent"
CANDIDATE_DISCOVERY_DIR="$CANDIDATE_RUNTIME_DIR/commerce-discovery"
CANDIDATE_IDEMPOTENCY_DIR="$CANDIDATE_RUNTIME_DIR/llm-request-idempotency"
CANDIDATE_BACKUP_DIR="$CANDIDATE_STATE_ROOT/backups"
CANDIDATE_UPLOAD_DIR="$CANDIDATE_STATE_ROOT/uploads"
CANDIDATE_VOICE_DIR="$CANDIDATE_STATE_ROOT/voice"
CANDIDATE_REFERENCE_AUDIO_DIR="$CANDIDATE_VOICE_DIR/reference-audio"
CANDIDATE_VOICE_DATABASE="$CANDIDATE_VOICE_DIR/voice.db"
CANDIDATE_COMMERCE_KEY="$CANDIDATE_COMMERCE_DIR/main-gateway.key"
mkdir --mode=0711 -- "$CANDIDATE_STATE_ROOT"
mkdir --mode=0700 -- "$CANDIDATE_HOME_DIR" "$CANDIDATE_RUNTIME_DIR" \
  "$CANDIDATE_COMMERCE_DIR" "$CANDIDATE_DISCOVERY_DIR" "$CANDIDATE_DISCOVERY_DIR/media" \
  "$CANDIDATE_IDEMPOTENCY_DIR" "$CANDIDATE_BACKUP_DIR" "$CANDIDATE_UPLOAD_DIR" \
  "$CANDIDATE_VOICE_DIR" "$CANDIDATE_REFERENCE_AUDIO_DIR"
# Candidate code receives only generated empty fixtures. The pinned, root-owned
# helper may read the production Voice schema through SQLite's online backup
# API, but it VACUUMs every user table to zero rows before writing candidate
# state. It never imports code or native modules from the unactivated payload.
CANDIDATE_FIXTURE_RECEIPT="$STAGING_DIR/candidate-fixture-receipt.json"
if [[ "$SERVICE" == "web" ]]; then
  "$CANDIDATE_FIXTURE_HELPER_PATH" --service web \
    --input-root "$VOICE_ROOT" --input "$VOICE_DATABASE_PATH" \
    --output-root "$CANDIDATE_STATE_ROOT" --output "$CANDIDATE_DATA_DIR" \
    --voice-output "$CANDIDATE_VOICE_DATABASE" > "$CANDIDATE_FIXTURE_RECEIPT"
else
  "$CANDIDATE_FIXTURE_HELPER_PATH" --service voice \
    --input-root "$VOICE_ROOT" --input "$VOICE_DATABASE_PATH" \
    --output-root "$CANDIDATE_STATE_ROOT" --output "$CANDIDATE_VOICE_DATABASE" > "$CANDIDATE_FIXTURE_RECEIPT"
  mkdir --mode=0700 -- "$CANDIDATE_DATA_DIR"
fi
node - "$CANDIDATE_FIXTURE_RECEIPT" "$SERVICE" <<'NODE'
const fs = require("node:fs");
const [receiptPath, service] = process.argv.slice(2);
const stats = fs.lstatSync(receiptPath);
if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.uid !== 0 || stats.gid !== 0 || stats.size > 4096) {
  throw new Error("candidate fixture receipt metadata is unsafe");
}
const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
const sha256 = /^[a-f0-9]{64}$/u;
if (receipt.schemaVersion !== "zimeiti-candidate-fixture.v1" || receipt.status !== "ready" || receipt.service !== service
  || receipt.records !== 0 || receipt.productionRecordsCopied !== 0 || receipt.quickCheck !== "ok"
  || !Number.isSafeInteger(receipt.tableCount) || receipt.tableCount < 8
  || receipt.schemaContractVersion !== "zimeiti-voice-sqlite-readiness.v1"
  || !sha256.test(receipt.schemaContractSha256) || !sha256.test(receipt.sourceSchemaSha256)
  || !sha256.test(receipt.outputSchemaSha256)
  || receipt.sourceSchemaSha256 !== receipt.outputSchemaSha256) {
  throw new Error("candidate fixture helper did not attest the Voice schema contract/fingerprint and a zero-record output");
}
if (service === "web" && receipt.fileCount !== 7) throw new Error("candidate Web fixture inventory is incomplete");
NODE
chmod 0600 -- "$CANDIDATE_FIXTURE_RECEIPT"
[[ -d "$CANDIDATE_DATA_DIR" && ! -L "$CANDIDATE_DATA_DIR" ]] || die "candidate data fixture directory is unsafe"
[[ -f "$CANDIDATE_VOICE_DATABASE" && ! -L "$CANDIDATE_VOICE_DATABASE" && -s "$CANDIDATE_VOICE_DATABASE" ]] || \
  die "candidate Voice fixture is missing, empty, or redirected"
printf '%s\n' '{"schema":1,"items":[],"order":{"video":[],"image":[],"canvas":[]},"homeOrder":{"video":[],"image":[],"canvas":[]}}' \
  > "$CANDIDATE_DISCOVERY_DIR/catalog.json"
node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))' > "$CANDIDATE_COMMERCE_KEY"
chmod 0600 -- "$CANDIDATE_COMMERCE_KEY" "$CANDIDATE_VOICE_DATABASE" "$CANDIDATE_DISCOVERY_DIR/catalog.json"
CANDIDATE_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))')"
CANDIDATE_PRIVATE_LOG="$CANDIDATE_STATE_ROOT/candidate.log"
set -o noclobber
if ! exec {CANDIDATE_LOG_FD}>"$CANDIDATE_PRIVATE_LOG"; then
  set +o noclobber
  die "unable to create the private candidate log without overwriting an existing path"
fi
set +o noclobber
[[ -f "$CANDIDATE_PRIVATE_LOG" && ! -L "$CANDIDATE_PRIVATE_LOG" ]] || die "private candidate log path changed while it was opened"
[[ "$(readlink -f -- "/proc/$$/fd/$CANDIDATE_LOG_FD")" == "$(readlink -f -- "$CANDIDATE_PRIVATE_LOG")" ]] || \
  die "private candidate log file descriptor escaped its expected path"
exec {CANDIDATE_LOG_FD}>&-
chmod 0600 -- "$CANDIDATE_PRIVATE_LOG"
chown -R "$CANDIDATE_UID:$CANDIDATE_GID" -- "$CANDIDATE_HOME_DIR" "$CANDIDATE_DATA_DIR" \
  "$CANDIDATE_RUNTIME_DIR" "$CANDIDATE_BACKUP_DIR" "$CANDIDATE_UPLOAD_DIR" "$CANDIDATE_VOICE_DIR"
chown "$CANDIDATE_UID:$CANDIDATE_GID" -- "$CANDIDATE_PRIVATE_LOG"
[[ -d "$CANDIDATE_STATE_ROOT" && ! -L "$CANDIDATE_STATE_ROOT" ]] || \
  die "candidate state root is not a regular directory"
[[ "$(stat -c '%u:%g:%a' -- "$CANDIDATE_STATE_ROOT")" == "0:0:711" ]] || \
  die "candidate state root must remain root-owned and non-writable by the candidate"
# The application tree stays root-owned and non-writable. Only the staging
# parent needs search permission so the unprivileged service can reach it.
chmod 0711 -- "$STAGING_DIR"
chmod 0755 -- "$PAYLOAD_DIR"
find "$PAYLOAD_DIR" -xdev -type d -exec chmod go-w,o+rx -- {} +
find "$PAYLOAD_DIR" -xdev -type f -exec chmod go-w,o+r -- {} +

NODE_BIN="$(readlink -f -- "$(command -v node)")"
ENV_BIN="$(readlink -f -- "$(command -v env)")"
for trusted_binary in "$NODE_BIN" "$ENV_BIN"; do
  require_trusted_root_executable "$trusted_binary" "candidate launcher binary"
done
CANDIDATE_UNIT="zimeiti-candidate-$SERVICE-$$.service"
candidate_unit="$CANDIDATE_UNIT"
candidate_cgroup="/system.slice/$CANDIDATE_UNIT"
CANDIDATE_INACCESSIBLE_PATHS="-/root -/home -/run/secrets -/run/postgresql -/var/run/postgresql -/run/pm2 -/var/run/pm2 -/etc/zimeiti -/etc/agent-hub -/var/lib/pgsql -/data/direct-deploy $ENV_ROOT $APP_DATA_DIR $APP_RUNTIME_DIR $UPLOAD_ROOT $LOG_ROOT $BACKUP_ROOT $VOICE_ROOT"
CANDIDATE_ENVIRONMENT=(
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  "HOME=$CANDIDATE_HOME_DIR"
  "NODE_ENV=production"
  "NEXT_TELEMETRY_DISABLED=1"
  "PORT=$CANDIDATE_PORT"
  "HOSTNAME=127.0.0.1"
  "RELEASE_READINESS_PROFILE=candidate-runtime-v1"
  "RELEASE_CANDIDATE_MODE=isolated"
  "SERVER_ENV_DISCOVERY_DISABLED=1"
  "DEV_READ_ONLY_MODE=1"
  "RELEASE_ROOT=$PAYLOAD_DIR"
  "APP_DATA_DIR=$CANDIDATE_DATA_DIR"
  "APP_RUNTIME_DIR=$CANDIDATE_RUNTIME_DIR"
  "COMMERCE_DATA_DIR=$CANDIDATE_COMMERCE_DIR"
  "COMMERCE_DISCOVERY_CATALOG=$CANDIDATE_DISCOVERY_DIR/catalog.json"
  "COMMERCE_GATEWAY_KEY_FILE=$CANDIDATE_COMMERCE_KEY"
  "IDEMPOTENCY_DIR=$CANDIDATE_IDEMPOTENCY_DIR"
  "BACKUP_DIR=$CANDIDATE_BACKUP_DIR"
  "PUBLIC_ASSET_ROOT=$PUBLIC_ASSET_ROOT"
  "VOICE_SQLITE_PATH=$CANDIDATE_VOICE_DATABASE"
  "VOICE_REFERENCE_AUDIO_DIR=$CANDIDATE_REFERENCE_AUDIO_DIR"
  "ASSET_DIGEST=$ASSET_DIGEST"
  "ASSET_MANIFEST_SHA256=$ASSET_MANIFEST_SHA256"
  "RELEASE_ID=$RELEASE_ID"
  "DEPLOY_COMMIT_SHA=$COMMIT_SHA"
  "EXPECTED_BUILD_ID=$BUILD_ID"
  "RELEASE_SOURCE_VERSION=$SOURCE_VERSION"
  "RELEASE_BUILD_OUTPUT_DIGEST=$BUILD_OUTPUT_DIGEST"
  "COZE_PROJECT_ENV=PROD"
)
if [[ "$SERVICE" == "web" ]]; then
  CANDIDATE_ENVIRONMENT+=(
    "JWT_SECRET=$CANDIDATE_AUTH_SECRET"
    "STORAGE_LOCAL_BASE_PATH=$CANDIDATE_UPLOAD_DIR"
  )
else
  CANDIDATE_ENVIRONMENT+=(
    "AUTH_SECRET=$CANDIDATE_AUTH_SECRET"
    "DATABASE_URL=file:$CANDIDATE_VOICE_DATABASE"
  )
fi

if ! systemd-run --quiet --collect --expand-environment=no --unit="$CANDIDATE_UNIT" --service-type=simple \
  --property="User=$CANDIDATE_USER" --property="Group=$CANDIDATE_GID" \
  --property="SupplementaryGroups=" --property="WorkingDirectory=$PAYLOAD_DIR" \
  --property="UMask=0077" --property="NoNewPrivileges=yes" \
  --property="CapabilityBoundingSet=" --property="AmbientCapabilities=" \
  --property="PrivateNetwork=yes" --property="PrivateTmp=yes" --property="PrivateDevices=yes" --property="PrivateIPC=yes" \
  --property="ProtectSystem=strict" --property="ProtectHome=yes" \
  --property="ProtectProc=invisible" --property="ProcSubset=pid" \
  --property="ProtectKernelTunables=yes" --property="ProtectKernelModules=yes" \
  --property="ProtectKernelLogs=yes" --property="ProtectControlGroups=yes" \
  --property="ProtectClock=yes" --property="ProtectHostname=yes" \
  --property="RestrictSUIDSGID=yes" --property="RestrictRealtime=yes" \
  --property="RestrictNamespaces=yes" --property="LockPersonality=yes" \
  --property="RestrictAddressFamilies=AF_INET AF_INET6" \
  --property="SystemCallArchitectures=native" \
  --property="ReadOnlyPaths=$PAYLOAD_DIR $PUBLIC_ASSET_ROOT" \
  --property="ReadWritePaths=$CANDIDATE_STATE_ROOT" \
  --property="InaccessiblePaths=$CANDIDATE_INACCESSIBLE_PATHS" \
  --property="StandardOutput=append:$CANDIDATE_PRIVATE_LOG" --property="StandardError=append:$CANDIDATE_PRIVATE_LOG" \
  --property="MemoryMax=1073741824" --property="MemorySwapMax=0" --property="TasksMax=256" \
  --property="CPUQuota=100%" --property="LimitFSIZE=134217728" \
  --property="KillMode=mixed" --property="TimeoutStopSec=5s" --property="RuntimeMaxSec=180s" \
  -- "$ENV_BIN" -i -- "${CANDIDATE_ENVIRONMENT[@]}" "$NODE_BIN" "$PAYLOAD_DIR/server.js"; then
  fail "unable to start the non-root private-network candidate sandbox"
fi

observed_candidate_cgroup="$(systemctl show --property=ControlGroup --value "$CANDIDATE_UNIT" 2>/dev/null || true)"
[[ -z "$observed_candidate_cgroup" || "$observed_candidate_cgroup" == "$candidate_cgroup" ]] || \
  fail "candidate unit entered an unexpected control group"

candidate_pid=""
for ((candidate_start_attempt = 1; candidate_start_attempt <= 40; candidate_start_attempt += 1)); do
  candidate_pid="$(systemctl show --property=MainPID --value "$CANDIDATE_UNIT" 2>/dev/null || true)"
  if [[ "$candidate_pid" =~ ^[1-9][0-9]*$ && -r "/proc/$candidate_pid/environ" ]]; then break; fi
  systemctl is-failed --quiet "$CANDIDATE_UNIT" 2>/dev/null && break
  sleep 0.25
done
[[ "$candidate_pid" =~ ^[1-9][0-9]*$ && -r "/proc/$candidate_pid/environ" ]] || \
  fail "candidate sandbox exited before its process identity could be verified; see $CANDIDATE_LOG"
[[ "$(stat -c '%u' -- "/proc/$candidate_pid")" == "$CANDIDATE_UID" ]] || \
  fail "candidate sandbox process is not running as the dedicated non-root user"
node - "/proc/$candidate_pid/environ" "/proc/$candidate_pid/status" "$PAYLOAD_DIR" "$SERVICE" "$CANDIDATE_UID" "$CANDIDATE_GID" <<'NODE'
const fs = require("node:fs");
const [environmentPath, statusPath, payloadRoot, service, expectedUid, expectedGid] = process.argv.slice(2);
const entries = fs.readFileSync(environmentPath).toString("utf8").split("\0").filter(Boolean);
const environment = new Map(entries.map((entry) => {
  const separator = entry.indexOf("=");
  return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
}));
if (environment.size !== entries.length) throw new Error("candidate environment contains duplicate names");
const expectedNames = new Set([
  "PATH", "HOME", "NODE_ENV", "NEXT_TELEMETRY_DISABLED", "PORT", "HOSTNAME",
  "RELEASE_READINESS_PROFILE", "RELEASE_CANDIDATE_MODE", "SERVER_ENV_DISCOVERY_DISABLED",
  "DEV_READ_ONLY_MODE", "RELEASE_ROOT", "APP_DATA_DIR", "APP_RUNTIME_DIR", "COMMERCE_DATA_DIR",
  "COMMERCE_DISCOVERY_CATALOG", "COMMERCE_GATEWAY_KEY_FILE", "IDEMPOTENCY_DIR", "BACKUP_DIR",
  "PUBLIC_ASSET_ROOT", "VOICE_SQLITE_PATH", "VOICE_REFERENCE_AUDIO_DIR", "ASSET_DIGEST",
  "ASSET_MANIFEST_SHA256", "RELEASE_ID", "DEPLOY_COMMIT_SHA", "EXPECTED_BUILD_ID",
  "RELEASE_SOURCE_VERSION", "RELEASE_BUILD_OUTPUT_DIGEST", "COZE_PROJECT_ENV",
  ...(service === "web" ? ["JWT_SECRET", "STORAGE_LOCAL_BASE_PATH"] : ["AUTH_SECRET", "DATABASE_URL"]),
]);
const names = new Set(environment.keys());
const missing = [...expectedNames].filter((name) => !names.has(name));
const unexpected = [...names].filter((name) => !expectedNames.has(name));
if (missing.length || unexpected.length) {
  throw new Error(`candidate environment is not the exact allowlist (missing=${missing.join(",") || "-"}; unexpected=${unexpected.join(",") || "-"})`);
}
if (environment.get("SERVER_ENV_DISCOVERY_DISABLED") !== "1") throw new Error("candidate environment discovery is not disabled");
if (environment.get("RELEASE_ROOT") !== payloadRoot) throw new Error("candidate release root is not confined to the payload");
if (environment.get("RELEASE_READINESS_PROFILE") !== "candidate-runtime-v1") throw new Error("candidate readiness profile is not isolated");
const status = fs.readFileSync(statusPath, "utf8");
const field = (name) => status.match(new RegExp(`^${name}:\\s+(.+)$`, "mu"))?.[1]?.trim() || "";
if (field("Uid").split(/\s+/u).some((value) => value !== expectedUid) || field("Uid").split(/\s+/u).length !== 4) {
  throw new Error("candidate process uid tuple is not isolated");
}
if (field("Gid").split(/\s+/u).some((value) => value !== expectedGid) || field("Gid").split(/\s+/u).length !== 4) {
  throw new Error("candidate process gid tuple is not isolated");
}
if (field("Groups").split(/\s+/u).filter(Boolean).join(" ") !== expectedGid) throw new Error("candidate process has supplementary groups");
if (field("NoNewPrivs") !== "1") throw new Error("candidate process does not have NoNewPrivileges");
NODE
CANDIDATE_UNIT_SECURITY="$(systemctl show "$CANDIDATE_UNIT" \
  --property=User --property=PrivateNetwork --property=NoNewPrivileges --property=ProtectSystem \
  --property=ProtectHome --property=PrivateDevices --property=PrivateIPC --property=ProtectProc \
  --property=ProcSubset --property=RestrictAddressFamilies --property=MemoryMax --property=MemorySwapMax \
  --property=TasksMax --property=CPUQuotaPerSecUSec --property=LimitFSIZE \
  --property=ReadOnlyPaths --property=ReadWritePaths --property=InaccessiblePaths \
  --property=CapabilityBoundingSet --property=AmbientCapabilities --property=RestrictNamespaces \
  --property=KillMode --property=RuntimeMaxUSec --property=TimeoutStopUSec --property=UMask)"
for expected_property in \
  "User=$CANDIDATE_USER" "PrivateNetwork=yes" "NoNewPrivileges=yes" "ProtectSystem=strict" \
  "ProtectHome=yes" "PrivateDevices=yes" "PrivateIPC=yes" "ProtectProc=invisible" "ProcSubset=pid" \
  "RestrictAddressFamilies=AF_INET AF_INET6" "MemoryMax=1073741824" "MemorySwapMax=0" \
  "TasksMax=256" "CPUQuotaPerSecUSec=1s" "LimitFSIZE=134217728" \
  "ReadOnlyPaths=$PAYLOAD_DIR $PUBLIC_ASSET_ROOT" "ReadWritePaths=$CANDIDATE_STATE_ROOT" \
  "InaccessiblePaths=$CANDIDATE_INACCESSIBLE_PATHS" "CapabilityBoundingSet=" "AmbientCapabilities=" \
  "RestrictNamespaces=yes" "KillMode=mixed" "RuntimeMaxUSec=3min" "TimeoutStopUSec=5s" "UMask=0077"; do
  grep -Fxq "$expected_property" <<<"$CANDIDATE_UNIT_SECURITY" || fail "candidate sandbox security property is not active: $expected_property"
done

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

wait_candidate_http() {
  local url="$1"
  local output="$2"
  local attempt
  for ((attempt = 1; attempt <= 45; attempt += 1)); do
    if systemctl is-active --quiet "$CANDIDATE_UNIT" 2>/dev/null && \
       nsenter --target "$candidate_pid" --net -- \
         curl --fail --silent --connect-timeout 2 --max-time 5 --output "$output" "$url" 2>/dev/null; then
      return 0
    fi
    systemctl is-failed --quiet "$CANDIDATE_UNIT" 2>/dev/null && return 1
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
  local expected_source_version="$6"
  local expected_build_output_digest="$7"
  local label="$8"
  node - "$response_file" "$SERVICE" "$expected_release" "$expected_commit" "$expected_build" "$expected_asset_digest" "$expected_source_version" "$expected_build_output_digest" "$label" <<'NODE'
const fs = require("node:fs");
const [filePath, service, releaseId, commitSha, buildId, assetDigest, sourceVersion, buildOutputDigest, label] = process.argv.slice(2);
const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
if (body.ready !== true) throw new Error(`readiness is not true: ${String(body.ready)}`);
if (body.service !== service) throw new Error(`readiness service mismatch: ${String(body.service)}`);
if (body.releaseId !== releaseId) throw new Error(`readiness release identity mismatch: ${String(body.releaseId)}`);
if (body.commitSha !== commitSha) throw new Error(`readiness commit identity mismatch: ${String(body.commitSha)}`);
if (body.buildId !== buildId) throw new Error(`readiness build identity mismatch: ${String(body.buildId)}`);
if (body.sourceVersion !== sourceVersion) throw new Error(`readiness source version mismatch: ${String(body.sourceVersion)}`);
if (body.buildOutputDigest !== buildOutputDigest) throw new Error(`readiness build output digest mismatch: ${String(body.buildOutputDigest)}`);
if (service === "web" && body.assetDigest !== assetDigest) throw new Error(`readiness asset digest mismatch: ${String(body.assetDigest)}`);
if (label === "candidate") {
  if (body.readinessProfile !== "candidate-runtime-v1" || body.activationReady !== false) {
    throw new Error("candidate readiness must be credential-free and non-activating");
  }
  if (service === "web") {
    for (const key of ["database", "referenceData"]) {
      const check = body.checks?.[key];
      if (check?.state !== "external-attestation-required" || check?.probeExecuted !== false || check?.requiredBeforeActivation !== true) {
        throw new Error(`candidate ${key} must require an external preflight attestation`);
      }
    }
  }
}
if (label !== "candidate" && (body.readinessProfile !== "production-full-v1" || body.activationReady !== true)) {
  throw new Error("live readiness must be production-full-v1 and activation-ready");
}
NODE
}

verify_service_http() {
  local port="$1"
  local expected_release="$2"
  local expected_commit="$3"
  local expected_build="$4"
  local expected_asset_digest="$5"
  local expected_source_version="$6"
  local expected_build_output_digest="$7"
  local label="$8"
  local response_file="$STAGING_DIR/$label-health.json"
  if [[ "$label" == "candidate" ]]; then
    wait_candidate_http "http://127.0.0.1:$port$READINESS_PATH" "$response_file" || return 1
  else
    wait_http "http://127.0.0.1:$port$READINESS_PATH" "$response_file" || return 1
  fi
  assert_readiness_identity "$response_file" "$expected_release" "$expected_commit" "$expected_build" "$expected_asset_digest" \
    "$expected_source_version" "$expected_build_output_digest" "$label" || return 1
}

verify_service_http "$CANDIDATE_PORT" "$RELEASE_ID" "$COMMIT_SHA" "$BUILD_ID" "$ASSET_DIGEST" \
  "$SOURCE_VERSION" "$BUILD_OUTPUT_DIGEST" "candidate" || \
  fail "isolated candidate runtime readiness/identity/data check failed; see $CANDIDATE_LOG"
LISTENER_DETAIL="$(nsenter --target "$candidate_pid" --net -- ss -H -ltnp "sport = :$CANDIDATE_PORT" 2>/dev/null || true)"
grep -Fq "pid=$candidate_pid," <<<"$LISTENER_DETAIL" || fail "candidate port is not owned by the launched candidate PID $candidate_pid"

cleanup_candidate || fail "candidate sandbox could not be proven inactive with an empty cgroup; staging was retained"
validate_payload_inventory "$PAYLOAD_DIR"
capture_data_snapshot "$DATA_AFTER_CANDIDATE"
compare_data_snapshot "$DATA_BEFORE" "$DATA_AFTER_CANDIDATE" || fail "candidate startup changed shared/data; code was not activated"

# Production credentials and direct activation hooks are loaded only after the
# isolated candidate has exited and the persistent data snapshot is unchanged.
load_protected_environment
run_production_preflight
if [[ -n "${DIRECT_HOOK_PATH:-}" ]]; then
  DIRECT_PREPARED="1"
  direct_hook prepare || fail "direct configuration/process preparation failed"
fi

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
if (typeof manifest.sourceVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(manifest.sourceVersion)) throw new Error("rollback source version is invalid");
if (!/^[0-9a-f]{64}$/u.test(manifest.buildOutputDigest)) throw new Error("rollback build output digest is invalid");
const assetDigest = service === "web" ? manifest.assetDigest : "-";
const assetManifestSha256 = service === "web" ? manifest.assetManifestSha256 : "-";
if (service === "web" && (!/^[0-9a-f]{64}$/u.test(assetDigest) || !/^[0-9a-f]{64}$/u.test(assetManifestSha256))) {
  throw new Error("rollback Web asset identity is invalid");
}
process.stdout.write(`${manifest.releaseId}\t${manifest.commitSha}\t${manifest.buildId}\t${manifest.sourceVersion}\t${manifest.buildOutputDigest}\t${assetDigest}\t${assetManifestSha256}\n`);
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
PREVIOUS_SOURCE_VERSION=""
PREVIOUS_BUILD_OUTPUT_DIGEST=""
PREVIOUS_ASSET_DIGEST=""
PREVIOUS_ASSET_MANIFEST_SHA256=""
if [[ -n "$PREVIOUS_TARGET" ]]; then
  IFS=$'\t' read -r PREVIOUS_RELEASE_ID PREVIOUS_COMMIT_SHA PREVIOUS_BUILD_ID PREVIOUS_SOURCE_VERSION PREVIOUS_BUILD_OUTPUT_DIGEST PREVIOUS_ASSET_DIGEST PREVIOUS_ASSET_MANIFEST_SHA256 < <(read_release_identity "$PREVIOUS_TARGET")
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
  local active_source_version="$7"
  local active_build_output_digest="$8"
  export RELEASE_ROOT APP_DATA_DIR APP_RUNTIME_DIR COMMERCE_DATA_DIR COMMERCE_DISCOVERY_CATALOG COMMERCE_GATEWAY_KEY_FILE IDEMPOTENCY_DIR
  export BACKUP_DIR="$BACKUP_ROOT"
  export PUBLIC_ASSET_ROOT="$ASSET_CURRENT_LINK/public"
  export VOICE_SQLITE_PATH="$VOICE_DATABASE_PATH"
  export VOICE_REFERENCE_AUDIO_DIR="$VOICE_REFERENCE_AUDIO_ROOT"
  export RELEASE_ID="$active_release_id"
  export DEPLOY_COMMIT_SHA="$active_commit_sha"
  export EXPECTED_BUILD_ID="$active_build_id"
  export RELEASE_SOURCE_VERSION="$active_source_version"
  export RELEASE_BUILD_OUTPUT_DIGEST="$active_build_output_digest"
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
  local expected_source_version="$7"
  local expected_build_output_digest="$8"
  local pm2_pid
  pm2_pid="$(pm2 jlist | node -e '
const fs = require("node:fs");
const [name, target, releaseId, commitSha, buildId, service, assetDigest, assetManifestSha256, sourceVersion, buildOutputDigest] = process.argv.slice(1);
const processes = JSON.parse(fs.readFileSync(0, "utf8"));
const matches = processes.filter((entry) => entry?.name === name);
if (matches.length !== 1) throw new Error(`expected one PM2 process ${name}, found ${matches.length}`);
const processInfo = matches[0];
const env = processInfo.pm2_env || {};
if (env.status !== "online") throw new Error(`PM2 process is not online: ${String(env.status)}`);
const cwd = fs.realpathSync(env.pm_cwd);
const expected = fs.realpathSync(target);
if (cwd !== expected) throw new Error(`PM2 cwd mismatch: ${cwd}`);
if (env.RELEASE_ID !== releaseId || env.DEPLOY_COMMIT_SHA !== commitSha || env.EXPECTED_BUILD_ID !== buildId
  || env.RELEASE_SOURCE_VERSION !== sourceVersion || env.RELEASE_BUILD_OUTPUT_DIGEST !== buildOutputDigest
  || env.COZE_PROJECT_ENV !== "PROD") throw new Error("PM2 release identity environment mismatch");
if (service === "web" && (env.ASSET_DIGEST !== assetDigest || env.ASSET_MANIFEST_SHA256 !== assetManifestSha256)) {
  throw new Error("PM2 Web asset identity environment mismatch");
}
if (typeof processInfo.pid !== "number" || processInfo.pid <= 0) throw new Error("PM2 process PID is invalid");
process.stdout.write(String(processInfo.pid));
' "$APP_NAME" "$expected_target" "$expected_release" "$expected_commit" "$expected_build_id" "$SERVICE" "$expected_asset_digest" "$expected_asset_manifest_sha256" "$expected_source_version" "$expected_build_output_digest")" || return 1
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
  local expected_source_version="$8"
  local expected_build_output_digest="$9"
  local label="${10}"
  link_resolves_to "$CURRENT_LINK" "$expected_target" || return 1
  link_resolves_to "$ASSET_CURRENT_LINK" "$expected_asset_target" || return 1
  # PM2 reports online before Node has bound the HTTP listener. Wait for the
  # exact release readiness first, then bind that listener back to its PM2 PID.
  verify_service_http "$LIVE_PORT" "$expected_release" "$expected_commit" "$expected_build" "$expected_asset_digest" \
    "$expected_source_version" "$expected_build_output_digest" "$label" || return 1
  verify_pm2_identity "$expected_target" "$expected_release" "$expected_commit" "$expected_build" \
    "$expected_asset_digest" "$expected_asset_manifest_sha256" "$expected_source_version" "$expected_build_output_digest" || return 1
}

if [[ -n "$PREVIOUS_TARGET" ]]; then
  verify_exact_active_composite "$PREVIOUS_TARGET" "$PREVIOUS_RELEASE_ID" "$PREVIOUS_COMMIT_SHA" "$PREVIOUS_BUILD_ID" \
    "$PREVIOUS_ASSET_TARGET" "$PREVIOUS_ASSET_DIGEST" "$PREVIOUS_ASSET_MANIFEST_SHA256" \
    "$PREVIOUS_SOURCE_VERSION" "$PREVIOUS_BUILD_OUTPUT_DIGEST" "predeploy" || \
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
  if ! cleanup_candidate; then
    echo "ROLLBACK FAILED: candidate sandbox could not be proven inactive; pointers were not changed." >&2
    IN_ROLLBACK="0"
    return 1
  fi

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
      activate_pm2 "$PREVIOUS_TARGET/.release/ecosystem.config.cjs" "$PREVIOUS_RELEASE_ID" "$PREVIOUS_COMMIT_SHA" "$PREVIOUS_BUILD_ID" \
        "$PREVIOUS_ASSET_DIGEST" "$PREVIOUS_ASSET_MANIFEST_SHA256" "$PREVIOUS_SOURCE_VERSION" "$PREVIOUS_BUILD_OUTPUT_DIGEST" >/dev/null 2>&1
      if ! verify_exact_active_composite "$PREVIOUS_TARGET" "$PREVIOUS_RELEASE_ID" "$PREVIOUS_COMMIT_SHA" "$PREVIOUS_BUILD_ID" \
        "$PREVIOUS_ASSET_TARGET" "$PREVIOUS_ASSET_DIGEST" "$PREVIOUS_ASSET_MANIFEST_SHA256" \
        "$PREVIOUS_SOURCE_VERSION" "$PREVIOUS_BUILD_OUTPUT_DIGEST" "rollback"; then
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
run_storage_boot_guard
assert_fresh_production_preflight_receipt

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

if ! activate_pm2 "$CANDIDATE_PM2_CONFIG" "$RELEASE_ID" "$COMMIT_SHA" "$BUILD_ID" \
  "${ASSET_DIGEST:--}" "${ASSET_MANIFEST_SHA256:--}" "$SOURCE_VERSION" "$BUILD_OUTPUT_DIGEST"; then
  rollback_release "PM2 activation failed" || true
  fail "PM2 activation failed"
fi
if ! direct_hook activated; then
  rollback_release "direct worker/runtime activation failed" || true
  fail "direct worker/runtime activation failed"
fi
if ! verify_exact_active_composite "$CANDIDATE" "$RELEASE_ID" "$COMMIT_SHA" "$BUILD_ID" \
  "$ASSET_TARGET" "${ASSET_DIGEST:--}" "${ASSET_MANIFEST_SHA256:--}" \
  "$SOURCE_VERSION" "$BUILD_OUTPUT_DIGEST" "production"; then
  rollback_release "production code/asset/PM2/listener/readiness composite identity failed" || true
  fail "production code/asset/PM2/listener/readiness composite identity failed"
fi

capture_data_snapshot "$DATA_AFTER_LIVE"
if ! compare_data_snapshot "$DATA_BEFORE" "$DATA_AFTER_LIVE"; then
  rollback_release "shared/data changed during candidate or activation checks" || true
  fail "shared/data changed; code rollback attempted without touching business data"
fi

if ! verify_exact_active_composite "$CANDIDATE" "$RELEASE_ID" "$COMMIT_SHA" "$BUILD_ID" \
  "$ASSET_TARGET" "${ASSET_DIGEST:--}" "${ASSET_MANIFEST_SHA256:--}" \
  "$SOURCE_VERSION" "$BUILD_OUTPUT_DIGEST" "precommit"; then
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
if [[ ! "$PRODUCTION_PREFLIGHT_RECEIPT_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  rollback_release "production preflight receipt identity missing at commit boundary" || true
  fail "production preflight receipt identity missing at commit boundary"
fi

# SUCCESS and DEPLOY_COMPLETE form one short commit boundary. A termination
# before this block rolls back; a termination after it preserves the new release.
trap '' HUP INT TERM
if ! printf '%s\tSUCCESS\t%s\t%s\t%s\t%s\t%s\t%s\tpreflight=%s\n' \
  "$(date -u +%FT%TZ)" "$RELEASE_ID" "$SERVICE" "${ACTUAL_SHA256,,}" "$COMMIT_SHA" "${ASSET_DIGEST:--}" "$DEPLOY_ACTOR" "$PRODUCTION_PREFLIGHT_RECEIPT_SHA256" \
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
