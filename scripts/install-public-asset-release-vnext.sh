#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/install-public-asset-release-vnext.sh --plan \
    --bundle-dir /srv/zimeiti-caopanshou/staging/assets/sha256-<digest> \
    --manifest-sha256 <64-hex> --asset-digest <64-hex> \
    --delivery-mode disk|cos --root /srv/zimeiti-caopanshou \
    [--initialize-current]

  ASSET_INSTALLATION_APPROVED=sha256-<digest> \
  bash scripts/install-public-asset-release-vnext.sh --execute \
    --bundle-dir /srv/zimeiti-caopanshou/staging/assets/sha256-<digest> \
    --manifest-sha256 <64-hex> --asset-digest <64-hex> \
    --delivery-mode disk|cos --root /srv/zimeiti-caopanshou

The installer is offline and provision-only. It validates the materializer's
transport receipt and exact bundle inventory, repeats every required SHA-256 on
the target server, issues the server-only READY receipt, then atomically moves
the same validated directory into:
  shared/assets/releases/sha256-<digest>

It never builds, downloads, copies mutable uploads, creates/seeds business data,
deletes an old release, or switches an existing shared/assets/current pointer.

`--initialize-current` is allowed only when current does not exist at all. In
execute mode it additionally requires:
  ASSET_INITIALIZATION_APPROVED=sha256-<digest>

Subsequent asset activation belongs to the Web deployer's compatibility-
superset gate. The installer must never bypass that coordinated transition.

For disk delivery, every manifest file must be present and fully SHA-256
verified. For COS delivery, every non-binary file must be local and verified;
content-addressed heavy binaries may remain remote only when the preserved COS
publisher READY receipt and transport receipt prove the exact remote full-body
SHA/HTTP metadata contract. Materialized bundles must not pre-claim server
READY. Both modes reject uploads, test evidence, links, extra files and paths
outside the 12 production asset roots.
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
BUNDLE_DIR=""
EXPECTED_MANIFEST_SHA256=""
EXPECTED_ASSET_DIGEST=""
DELIVERY_MODE=""
RELEASE_ROOT=""
INITIALIZE_CURRENT="0"

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
    --bundle-dir) BUNDLE_DIR="${2:-}"; shift 2 ;;
    --manifest-sha256) EXPECTED_MANIFEST_SHA256="${2:-}"; shift 2 ;;
    --asset-digest) EXPECTED_ASSET_DIGEST="${2:-}"; shift 2 ;;
    --delivery-mode) DELIVERY_MODE="${2:-}"; shift 2 ;;
    --root) RELEASE_ROOT="${2:-}"; shift 2 ;;
    --initialize-current) INITIALIZE_CURRENT="1"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$MODE" == "plan" || "$MODE" == "execute" ]] || die "exactly one of --plan or --execute is required"
[[ "$EXPECTED_MANIFEST_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || die "--manifest-sha256 must be a 64-character SHA-256"
[[ "$EXPECTED_ASSET_DIGEST" =~ ^[0-9a-fA-F]{64}$ ]] || die "--asset-digest must be a 64-character SHA-256"
[[ "$DELIVERY_MODE" == "disk" || "$DELIVERY_MODE" == "cos" ]] || die "--delivery-mode must be disk or cos"
[[ "$RELEASE_ROOT" == /* ]] || die "--root must be an absolute Linux path"
[[ "$BUNDLE_DIR" == /* ]] || die "--bundle-dir must be an absolute Linux path"

for command_name in readlink node stat mv flock ln rm chmod grep head basename; do
  require_command "$command_name"
done
mv --version 2>/dev/null | head -n 1 | grep -q "GNU coreutils" || die "GNU coreutils mv is required for atomic directory/pointer replacement"

[[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] || die "release root must already exist and cannot be a symlink"
RELEASE_ROOT="$(readlink -f -- "$RELEASE_ROOT")"
case "$RELEASE_ROOT" in
  /|/root|/home|/srv|/var|/www) die "release root is too broad: $RELEASE_ROOT" ;;
esac

ROOT_MARKER="$RELEASE_ROOT/.zimeiti-release-root"
[[ -f "$ROOT_MARKER" && ! -L "$ROOT_MARKER" ]] || die "missing regular server ownership marker: $ROOT_MARKER"

SHARED_ROOT="$RELEASE_ROOT/shared"
ASSET_ROOT="$SHARED_ROOT/assets"
ASSET_RELEASES_ROOT="$ASSET_ROOT/releases"
ASSET_CURRENT_LINK="$ASSET_ROOT/current"
STAGING_ROOT="$RELEASE_ROOT/staging"
STAGING_ASSET_ROOT="$STAGING_ROOT/assets"
ASSET_DIGEST="${EXPECTED_ASSET_DIGEST,,}"
MANIFEST_SHA256="${EXPECTED_MANIFEST_SHA256,,}"
ASSET_VERSION="sha256-$ASSET_DIGEST"
TARGET="$ASSET_RELEASES_ROOT/$ASSET_VERSION"

for directory in "$SHARED_ROOT" "$ASSET_ROOT" "$ASSET_RELEASES_ROOT" "$STAGING_ROOT" "$STAGING_ASSET_ROOT"; do
  [[ -d "$directory" && ! -L "$directory" ]] || die "required server asset directory must be a real pre-provisioned directory: $directory"
done
[[ -r "$ASSET_RELEASES_ROOT" && -w "$ASSET_RELEASES_ROOT" && -x "$ASSET_RELEASES_ROOT" ]] || \
  die "asset releases root is not readable/writable/traversable by the installer user"
[[ -r "$ASSET_ROOT" && -w "$ASSET_ROOT" && -x "$ASSET_ROOT" ]] || \
  die "asset pointer root is not readable/writable/traversable by the installer user"
[[ -r "$STAGING_ASSET_ROOT" && -w "$STAGING_ASSET_ROOT" && -x "$STAGING_ASSET_ROOT" ]] || \
  die "asset staging root is not readable/writable/traversable by the installer user"
[[ -r "$RELEASE_ROOT" && -w "$RELEASE_ROOT" && -x "$RELEASE_ROOT" ]] || \
  die "release root is not readable/writable/traversable by the installer user"

[[ -d "$BUNDLE_DIR" && ! -L "$BUNDLE_DIR" ]] || die "bundle must be an existing real directory"
BUNDLE_DIR="$(readlink -f -- "$BUNDLE_DIR")"
EXPECTED_BUNDLE_DIR="$STAGING_ASSET_ROOT/$ASSET_VERSION"
[[ "$BUNDLE_DIR" == "$EXPECTED_BUNDLE_DIR" ]] || die "bundle must be staged at the exact managed path: $EXPECTED_BUNDLE_DIR"
[[ "$(basename -- "$BUNDLE_DIR")" == "$ASSET_VERSION" ]] || die "bundle directory name does not match asset digest"
[[ ! -e "$TARGET" && ! -L "$TARGET" ]] || die "immutable asset release target already exists and cannot be overwritten: $TARGET"
BUNDLE_DEVICE="$(stat -c '%d' -- "$BUNDLE_DIR")"
RELEASES_DEVICE="$(stat -c '%d' -- "$ASSET_RELEASES_ROOT")"
[[ "$BUNDLE_DEVICE" == "$RELEASES_DEVICE" ]] || die "bundle staging and asset releases are on different filesystems; atomic mv is impossible"

validate_current_pointer() {
  if [[ ! -e "$ASSET_CURRENT_LINK" && ! -L "$ASSET_CURRENT_LINK" ]]; then
    printf '%s\n' "ABSENT"
    return 0
  fi
  [[ -L "$ASSET_CURRENT_LINK" ]] || die "asset current path exists but is not a symbolic link: $ASSET_CURRENT_LINK"
  local current_target
  current_target="$(readlink -f -- "$ASSET_CURRENT_LINK")" || die "asset current pointer is broken"
  [[ -d "$current_target" && ! -L "$current_target" ]] || die "asset current target is not a real directory"
  [[ "$current_target" == "$ASSET_RELEASES_ROOT"/* ]] || die "asset current target escapes the immutable release root"
  [[ "$(basename -- "$current_target")" =~ ^sha256-[0-9a-f]{64}$ ]] || die "asset current target is not content-addressed"
  printf '%s\n' "$current_target"
}

CURRENT_STATE="$(validate_current_pointer)"
if [[ "$INITIALIZE_CURRENT" == "1" && "$CURRENT_STATE" != "ABSENT" ]]; then
  die "--initialize-current is only allowed when shared/assets/current is completely absent"
fi

validate_bundle() {
  local bundle_path="${1:-$BUNDLE_DIR}"
  local ready_state="${2:-absent}"
  [[ "$ready_state" == "absent" || "$ready_state" == "ready" ]] || die "internal invalid READY validation state"
  node - "$bundle_path" "$TARGET" "$ASSET_DIGEST" "$MANIFEST_SHA256" "$DELIVERY_MODE" "$ready_state" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [bundleInput, targetInput, expectedDigest, expectedManifestSha, deliveryMode, readyState] = process.argv.slice(2);
const bundle = fs.realpathSync(bundleInput);
const target = path.resolve(targetInput);
const hex64 = /^[0-9a-f]{64}$/u;
const maxReceiptBytes = 64 * 1024;
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
const forbiddenRoots = new Set(["storyboard-reviews", "demo-assets", "uploads"]);
const binaryExtensions = new Set([
  ".aac", ".avi", ".flac", ".gif", ".ico", ".jpeg", ".jpg", ".m4a", ".m4v", ".mkv", ".mov",
  ".mp3", ".mp4", ".mpeg", ".mpg", ".ogg", ".pdf", ".png", ".svg", ".wav", ".webm", ".webp", ".zip",
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireExactKeys(value, expectedKeys, label) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be a JSON object`);
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...expectedKeys].sort((left, right) => left.localeCompare(right, "en"));
  requireCondition(actual.length === expected.length && actual.every((entry, index) => entry === expected[index]), `${label} contains missing or unexpected fields`);
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
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function validRelative(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(relativePath)) return false;
  if (relativePath.startsWith("/") || /^[A-Za-z]:/u.test(relativePath)) return false;
  const parts = relativePath.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && path.posix.normalize(relativePath) === relativePath;
}

requireCondition(hex64.test(expectedDigest), "expected asset digest is invalid");
requireCondition(hex64.test(expectedManifestSha), "expected manifest SHA-256 is invalid");
requireCondition(deliveryMode === "disk" || deliveryMode === "cos", "delivery mode is invalid");
requireCondition(readyState === "absent" || readyState === "ready", "READY validation state is invalid");
const rootStats = fs.lstatSync(bundle);
requireCondition(rootStats.isDirectory() && !rootStats.isSymbolicLink(), "bundle root is not a real directory");
requireCondition(path.basename(bundle) === `sha256-${expectedDigest}`, "bundle root does not match expected asset version");

const manifestPath = path.join(bundle, ...manifestRelativePath.split("/"));
const transportPath = path.join(bundle, ...transportRelativePath.split("/"));
const cosPublisherPath = path.join(bundle, ...cosPublisherRelativePath.split("/"));
const readyPath = path.join(bundle, ...readyRelativePath.split("/"));
const requiredMetadataPaths = [manifestPath, transportPath];
if (deliveryMode === "cos") requiredMetadataPaths.push(cosPublisherPath);
if (readyState === "ready") requiredMetadataPaths.push(readyPath);
for (const filePath of requiredMetadataPaths) {
  requireCondition(fs.existsSync(filePath), `bundle metadata is missing: ${filePath}`);
  const stats = fs.lstatSync(filePath);
  requireCondition(stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1, `bundle metadata must be a single-link regular file: ${filePath}`);
}
if (readyState === "absent") {
  requireCondition(!fs.existsSync(readyPath) && !fs.lstatSync(readyPath, { throwIfNoEntry: false }), "transport bundle must not contain a server READY receipt before installation");
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

const manifestBytes = fs.readFileSync(manifestPath);
const actualManifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");
requireCondition(actualManifestSha === expectedManifestSha, "asset manifest external SHA-256 mismatch");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
requireCondition(manifest.schemaVersion === 1 && manifest.projectId === "zimeiti-caopanshou" && manifest.kind === "public-assets", "asset manifest identity/schema mismatch");
requireCondition(manifest.contentAddressing === "sha256-files-and-asset-policy" && hex64.test(manifest.assetPolicySha256), "asset manifest policy/content-addressing contract mismatch");
requireCondition(manifest.mutableUploadsIncluded === false && Array.isArray(manifest.files), "asset manifest includes mutable data or lacks an inventory");

const manifestByPath = new Map();
let previousPath = "";
let totalBytes = 0;
let canonicalFiles = "";
let transportFileCount = 0;
let transportBytes = 0;
for (const file of manifest.files) {
  requireCondition(validRelative(file?.path), `unsafe asset manifest path: ${String(file?.path)}`);
  const parts = file.path.split("/");
  requireCondition(parts.length >= 3 && parts[0] === "public", `asset path is not rooted under public: ${file.path}`);
  requireCondition(productionRoots.has(parts[1]) && !forbiddenRoots.has(parts[1]), `asset path is outside the production allowlist: ${file.path}`);
  requireCondition(!manifestByPath.has(file.path), `duplicate asset manifest path: ${file.path}`);
  requireCondition(!previousPath || previousPath.localeCompare(file.path, "en") < 0, "asset manifest paths are not strictly sorted");
  requireCondition(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && hex64.test(file.sha256), `invalid asset inventory metadata: ${file.path}`);
  manifestByPath.set(file.path, file);
  previousPath = file.path;
  totalBytes += file.bytes;
  requireCondition(Number.isSafeInteger(totalBytes), "asset byte total exceeds safe integer range");
  canonicalFiles += `${file.sha256}  ${file.path}\n`;
  const extension = path.posix.extname(file.path).toLowerCase();
  if (deliveryMode === "disk" || !binaryExtensions.has(extension)) {
    transportFileCount += 1;
    transportBytes += file.bytes;
    requireCondition(Number.isSafeInteger(transportBytes), "transport byte total exceeds safe integer range");
  }
}
const calculatedDigest = crypto.createHash("sha256")
  .update(`asset-policy-sha256  ${manifest.assetPolicySha256}\n${canonicalFiles}`)
  .digest("hex");
requireCondition(calculatedDigest === expectedDigest && manifest.digest === expectedDigest, "asset digest does not match files and asset policy");
requireCondition(manifest.assetVersion === `sha256-${expectedDigest}`, "asset version/digest mismatch");
requireCondition(manifest.fileCount === manifest.files.length && manifest.totalBytes === totalBytes, "asset manifest count/bytes mismatch");

const logicalLocation = `shared/assets/releases/${manifest.assetVersion}`;
const { bytes: transportBytesRaw, value: transport } = readReceipt(transportPath, "asset transport receipt");
const expectedTransport = {
  schemaVersion: 1,
  projectId: "zimeiti-caopanshou",
  kind: "public-assets-transport-receipt",
  status: "VERIFIED",
  assetVersion: manifest.assetVersion,
  assetDigest: manifest.digest,
  assetPolicySha256: manifest.assetPolicySha256,
  manifestSha256: actualManifestSha,
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
    manifestSha256: actualManifestSha,
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
requireCondition(transportBytesRaw.length <= maxReceiptBytes, "asset transport receipt exceeds its size contract");

if (readyState === "ready") {
  const { value: receipt } = readReceipt(readyPath, "server asset readiness receipt");
  const expectedReady = {
    schemaVersion: 1,
    projectId: "zimeiti-caopanshou",
    kind: "public-assets-readiness-receipt",
    status: "READY",
    assetVersion: manifest.assetVersion,
    assetDigest: manifest.digest,
    assetPolicySha256: manifest.assetPolicySha256,
    manifestSha256: actualManifestSha,
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
}

const actualFiles = new Map();
const actualDirectories = new Set();
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const filePath = path.join(directory, entry.name);
    const relativePath = path.relative(bundle, filePath).split(path.sep).join("/");
    requireCondition(validRelative(relativePath), `unsafe bundle path: ${relativePath}`);
    const stats = fs.lstatSync(filePath);
    requireCondition(!stats.isSymbolicLink(), `bundle contains a forbidden symbolic link: ${relativePath}`);
    requireCondition(stats.dev === rootStats.dev, `bundle path crosses a filesystem boundary: ${relativePath}`);
    if (stats.isDirectory()) {
      actualDirectories.add(relativePath);
      walk(filePath);
    } else if (stats.isFile()) {
      requireCondition(stats.nlink === 1, `bundle contains a forbidden hard-linked file: ${relativePath}`);
      actualFiles.set(relativePath, { filePath, stats });
    } else {
      throw new Error(`bundle contains a forbidden non-regular entry: ${relativePath}`);
    }
  }
}
walk(bundle);

const metadataFiles = new Set([manifestRelativePath, transportRelativePath]);
if (deliveryMode === "cos") metadataFiles.add(cosPublisherRelativePath);
if (readyState === "ready") metadataFiles.add(readyRelativePath);
const requiredFiles = new Set(metadataFiles);
for (const file of manifest.files) {
  const extension = path.posix.extname(file.path).toLowerCase();
  if (deliveryMode === "disk" || !binaryExtensions.has(extension)) requiredFiles.add(file.path);
}
for (const relativePath of actualFiles.keys()) {
  requireCondition(requiredFiles.has(relativePath), `bundle contains an extra file: ${relativePath}`);
}
for (const relativePath of requiredFiles) {
  requireCondition(actualFiles.has(relativePath), `bundle is missing a required local file: ${relativePath}`);
}

for (const [relativePath, actual] of actualFiles) {
  if (metadataFiles.has(relativePath)) continue;
  const expected = manifestByPath.get(relativePath);
  requireCondition(expected && actual.stats.size === expected.bytes, `bundle file size mismatch: ${relativePath}`);
  requireCondition(sha256File(actual.filePath) === expected.sha256, `bundle file SHA-256 mismatch: ${relativePath}`);
  fs.accessSync(actual.filePath, fs.constants.R_OK);
}

const expectedDirectories = new Set([".release", "public"]);
for (const relativePath of actualFiles.keys()) {
  let parent = path.posix.dirname(relativePath);
  while (parent && parent !== ".") {
    expectedDirectories.add(parent);
    parent = path.posix.dirname(parent);
  }
}
requireCondition(actualDirectories.size === expectedDirectories.size, "bundle contains an extra or missing directory");
for (const relativePath of actualDirectories) {
  requireCondition(expectedDirectories.has(relativePath), `bundle contains an extra directory: ${relativePath}`);
}

const localAssetFiles = [...actualFiles.keys()].filter((relativePath) => manifestByPath.has(relativePath)).length;
process.stdout.write(`${JSON.stringify({
  ok: true,
  assetVersion: manifest.assetVersion,
  manifestSha256: actualManifestSha,
  manifestFiles: manifest.fileCount,
  manifestBytes: manifest.totalBytes,
  localAssetFiles,
  remoteOnlyFiles: manifest.fileCount - localAssetFiles,
  deliveryMode,
  readyState,
  transportReceiptSha256: crypto.createHash("sha256").update(transportBytesRaw).digest("hex"),
})}\n`);
NODE
}

write_server_ready_receipt() {
  node - "$BUNDLE_DIR" "$TARGET" "$ASSET_DIGEST" "$MANIFEST_SHA256" "$DELIVERY_MODE" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [bundleInput, targetInput, expectedDigest, expectedManifestSha, deliveryMode] = process.argv.slice(2);
const bundle = fs.realpathSync(bundleInput);
const target = path.resolve(targetInput);
const manifestPath = path.join(bundle, ".release", "public-assets.v1.json");
const transportPath = path.join(bundle, ".release", "public-assets.bundle.v1.json");
const readyPath = path.join(bundle, ".release", "public-assets.ready.v1.json");
const manifestBytes = fs.readFileSync(manifestPath);
const manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
if (manifestSha256 !== expectedManifestSha) throw new Error("manifest changed before server READY issuance");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.digest !== expectedDigest || manifest.assetVersion !== `sha256-${expectedDigest}`) throw new Error("manifest identity changed before server READY issuance");
const transport = JSON.parse(fs.readFileSync(transportPath, "utf8"));
const receipt = {
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
  issuerId: "install-public-asset-release-vnext",
  issuerProtocolVersion: 1,
  ...(deliveryMode === "cos" ? {
    remoteLocation: transport.remoteLocation,
    publisherReadyReceiptPath: ".release/public-assets.cos.ready.v1.json",
    publisherReadyReceiptSha256: transport.publisherReadyReceiptSha256,
    publisherId: "publish-public-assets-cos-vnext",
    publisherProtocolVersion: 1,
    publisherScriptSha256: transport.publisherScriptSha256,
    remoteVerification: "head-content-type-cache-control-metadata-sha256-and-full-body-sha256",
    remoteVerifiedFileCount: manifest.fileCount,
    remoteVerifiedTotalBytes: manifest.totalBytes,
    remoteContentTypeVerified: true,
    remoteCacheControlVerified: true,
    overwriteProtocol: "put-object-forbid-overwrite",
    publicationOrder: "assets-then-manifest-then-ready",
  } : {}),
  verifiedAt: new Date().toISOString(),
};
const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
if (bytes.length <= 0 || bytes.length > 64 * 1024) throw new Error("server READY receipt exceeds its size contract");
const descriptor = fs.openSync(readyPath, "wx", 0o640);
try {
  fs.writeFileSync(descriptor, bytes);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
const directoryDescriptor = fs.openSync(path.dirname(readyPath), "r");
try {
  fs.fsyncSync(directoryDescriptor);
} finally {
  fs.closeSync(directoryDescriptor);
}
NODE
}

make_ready_metadata_writable() {
  node - "$BUNDLE_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = fs.realpathSync(process.argv[2]);
const rootStats = fs.lstatSync(root);
const metadataDirectory = path.join(root, ".release");
const metadataStats = fs.lstatSync(metadataDirectory);
const readyPath = path.join(metadataDirectory, "public-assets.ready.v1.json");
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("bundle root changed before READY issuance");
if (!metadataStats.isDirectory() || metadataStats.isSymbolicLink() || metadataStats.dev !== rootStats.dev) {
  throw new Error("bundle metadata directory is unsafe before READY issuance");
}
if (fs.lstatSync(readyPath, { throwIfNoEntry: false })) throw new Error("server READY path appeared before issuance");
fs.chmodSync(metadataDirectory, 0o750);
NODE
}

protect_bundle() {
  node - "$BUNDLE_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = fs.realpathSync(process.argv[2]);

function protect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) throw new Error(`refusing to protect a symlink: ${filePath}`);
    if (stats.isDirectory()) {
      protect(filePath);
      fs.chmodSync(filePath, 0o555);
    } else if (stats.isFile() && stats.nlink === 1) {
      fs.chmodSync(filePath, 0o444);
    } else {
      throw new Error(`refusing to protect a non-regular or hard-linked entry: ${filePath}`);
    }
  }
}
protect(root);
fs.chmodSync(root, 0o555);
NODE
}

echo "MODE=$MODE"
echo "ASSET_VERSION=$ASSET_VERSION"
echo "DELIVERY_MODE=$DELIVERY_MODE"
echo "BUNDLE_DIR=$BUNDLE_DIR"
echo "TARGET=$TARGET"
echo "CURRENT_STATE=$CURRENT_STATE"
echo "INITIALIZE_CURRENT=$INITIALIZE_CURRENT"
validate_bundle "$BUNDLE_DIR" "absent"

if [[ "$MODE" == "plan" ]]; then
  echo "PASS PLAN ONLY: transport receipt, bundle inventory, content-addressed digest, production roots and all required local SHA-256 values validated."
  echo "The installer would issue the server READY receipt only after repeating these checks under the deployment lock."
  echo "No directories, files, permissions, locks, symlinks, data, processes, or network state were changed."
  exit 0
fi

[[ "${ASSET_INSTALLATION_APPROVED:-}" == "$ASSET_VERSION" ]] || \
  die "ASSET_INSTALLATION_APPROVED must exactly equal $ASSET_VERSION"
if [[ "$INITIALIZE_CURRENT" == "1" ]]; then
  [[ "${ASSET_INITIALIZATION_APPROVED:-}" == "$ASSET_VERSION" ]] || \
    die "ASSET_INITIALIZATION_APPROVED must exactly equal $ASSET_VERSION"
fi

CURRENT_TEMP_LINK=""
GENERATED_READY_PATH=""
READY_DIRECTORY_OPENED="0"
cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ -n "$CURRENT_TEMP_LINK" && -L "$CURRENT_TEMP_LINK" ]]; then
    rm -- "$CURRENT_TEMP_LINK" || true
  fi
  if [[ "$READY_DIRECTORY_OPENED" == "1" && -d "$BUNDLE_DIR/.release" && ! -L "$BUNDLE_DIR/.release" ]]; then
    chmod 0750 -- "$BUNDLE_DIR/.release" || true
    if [[ -n "$GENERATED_READY_PATH" && -f "$GENERATED_READY_PATH" && ! -L "$GENERATED_READY_PATH" ]]; then
      rm -- "$GENERATED_READY_PATH" || true
    fi
    chmod 0555 -- "$BUNDLE_DIR/.release" || true
  fi
  exit "$exit_status"
}
trap cleanup EXIT

LOCK_FILE="$RELEASE_ROOT/.deploy.lock"
if [[ -e "$LOCK_FILE" || -L "$LOCK_FILE" ]]; then
  [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || die "deploy lock is not a regular file: $LOCK_FILE"
fi
exec 9>>"$LOCK_FILE"
[[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || die "deploy lock path changed while it was opened"
[[ "$(readlink -f -- "/proc/$$/fd/9")" == "$(readlink -f -- "$LOCK_FILE")" ]] || die "deploy lock descriptor escaped its expected path"
flock -n 9 || die "another release/asset transaction already holds $LOCK_FILE"

[[ -d "$BUNDLE_DIR" && ! -L "$BUNDLE_DIR" && "$(readlink -f -- "$BUNDLE_DIR")" == "$EXPECTED_BUNDLE_DIR" ]] || \
  die "bundle changed while waiting for the release lock"
[[ ! -e "$TARGET" && ! -L "$TARGET" ]] || die "immutable asset target appeared while waiting for the release lock"
LOCKED_CURRENT_STATE="$(validate_current_pointer)"
[[ "$LOCKED_CURRENT_STATE" == "$CURRENT_STATE" ]] || die "asset current pointer changed between plan validation and execute lock"
if [[ "$INITIALIZE_CURRENT" == "1" && "$LOCKED_CURRENT_STATE" != "ABSENT" ]]; then
  die "asset current pointer appeared before first initialization"
fi

LOCKED_BUNDLE_ID="$(stat -c '%d:%i' -- "$BUNDLE_DIR")"
validate_bundle "$BUNDLE_DIR" "absent"
GENERATED_READY_PATH="$BUNDLE_DIR/.release/public-assets.ready.v1.json"
READY_DIRECTORY_OPENED="1"
make_ready_metadata_writable
write_server_ready_receipt
validate_bundle "$BUNDLE_DIR" "ready"
protect_bundle
validate_bundle "$BUNDLE_DIR" "ready"
[[ "$LOCKED_BUNDLE_ID" == "$(stat -c '%d:%i' -- "$BUNDLE_DIR")" ]] || die "bundle inode changed after locked validation"

BUNDLE_DEVICE="$(stat -c '%d' -- "$BUNDLE_DIR")"
RELEASES_DEVICE="$(stat -c '%d' -- "$ASSET_RELEASES_ROOT")"
[[ "$BUNDLE_DEVICE" == "$RELEASES_DEVICE" ]] || die "bundle staging and asset releases are on different filesystems; atomic mv is impossible"

if ! mv -Tn -- "$BUNDLE_DIR" "$TARGET"; then
  fail "atomic asset bundle promotion failed; staging bundle remains provisioned"
fi
if [[ -e "$BUNDLE_DIR" || -L "$BUNDLE_DIR" ]]; then
  fail "immutable asset target appeared during promotion; existing target was not overwritten and staging bundle remains"
fi
[[ -d "$TARGET" && ! -L "$TARGET" && "$(readlink -f -- "$TARGET")" == "$TARGET" ]] || \
  fail "asset bundle promotion did not produce the exact immutable target"
[[ "$LOCKED_BUNDLE_ID" == "$(stat -c '%d:%i' -- "$TARGET")" ]] || \
  fail "atomic asset bundle promotion did not preserve the validated directory identity"
GENERATED_READY_PATH=""
READY_DIRECTORY_OPENED="0"
validate_bundle "$TARGET" "ready"

if [[ "$INITIALIZE_CURRENT" == "1" ]]; then
  CURRENT_TEMP_LINK="$ASSET_ROOT/.current-$ASSET_VERSION-$$.tmp"
  [[ ! -e "$CURRENT_TEMP_LINK" && ! -L "$CURRENT_TEMP_LINK" ]] || fail "temporary current pointer already exists"
  ln -s -- "$TARGET" "$CURRENT_TEMP_LINK"
  if ! mv -Tn -- "$CURRENT_TEMP_LINK" "$ASSET_CURRENT_LINK"; then
    fail "first asset current pointer initialization failed; release remains safely provisioned"
  fi
  if [[ -e "$CURRENT_TEMP_LINK" || -L "$CURRENT_TEMP_LINK" ]]; then
    fail "asset current pointer appeared during initialization; it was not overwritten and the release remains safely provisioned"
  fi
  if [[ ! -L "$ASSET_CURRENT_LINK" || "$(readlink -f -- "$ASSET_CURRENT_LINK")" != "$TARGET" ]]; then
    fail "first asset current pointer verification failed; release remains safely provisioned"
  fi
  CURRENT_TEMP_LINK=""
fi

echo "PASS installed immutable asset release $ASSET_VERSION"
echo "PASS target=$TARGET deliveryMode=$DELIVERY_MODE currentInitialized=$INITIALIZE_CURRENT"
