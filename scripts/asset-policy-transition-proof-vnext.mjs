#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "zimeiti-caopanshou";
const KIND = "asset-policy-transition-proof";
const GENERATOR_ID = "asset-policy-transition-proof-vnext";
const MAX_JSON_BYTES = 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/u;

const allowedOptions = new Set([
  "--create",
  "--verify",
  "--current-policy",
  "--current-manifest",
  "--next-policy",
  "--next-manifest",
  "--receipt",
  "--receipt-sha256",
  "--output",
]);
const flagOptions = new Set(["--create", "--verify"]);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!allowedOptions.has(argument) || options.has(argument)) throw new Error(`unknown or duplicate option: ${argument}`);
  if (flagOptions.has(argument)) {
    options.set(argument, "1");
    continue;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
  options.set(argument, value);
  index += 1;
}

const createMode = options.has("--create");
const verifyMode = options.has("--verify");
if (createMode === verifyMode) throw new Error("exactly one of --create or --verify is required");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readRegularJson(input, label) {
  if (!input) throw new Error(`${label} path is required`);
  const resolved = path.resolve(input);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size <= 0 || stats.size > MAX_JSON_BYTES) {
    throw new Error(`${label} must be a bounded single-link regular file`);
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.length !== stats.size) throw new Error(`${label} changed while being read`);
  return { resolved, bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, "en"));
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function canonicalPublicPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("public/") || value.includes("\\") || value.includes("\0") ||
      path.posix.normalize(value) !== value || value.split("/").some((entry) => !entry || entry === "." || entry === "..")) {
    throw new Error(`${label} is not a canonical public path`);
  }
  return value;
}

function policyProjection(policy, label) {
  if (!policy || policy.schemaVersion !== 1 || policy.projectId !== PROJECT_ID || !policy.assets || typeof policy.assets !== "object") {
    throw new Error(`${label} release policy identity/assets contract is invalid`);
  }
  const projection = { schemaVersion: 1, projectId: PROJECT_ID, assets: policy.assets };
  const sha256 = sha256Buffer(Buffer.from(stableJson(projection), "utf8"));
  return { projection, sha256 };
}

function validateManifest(bytes, manifest, expectedPolicySha, label) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.projectId !== PROJECT_ID || manifest.kind !== "public-assets" ||
      manifest.contentAddressing !== "sha256-files-and-asset-policy" || manifest.mutableUploadsIncluded !== false ||
      !HEX64.test(manifest.assetPolicySha256) || !HEX64.test(manifest.digest) || !Array.isArray(manifest.files)) {
    throw new Error(`${label} manifest identity/content-addressing contract is invalid`);
  }
  if (expectedPolicySha && manifest.assetPolicySha256 !== expectedPolicySha) throw new Error(`${label} manifest policy digest mismatch`);
  let previous = "";
  let totalBytes = 0;
  const seen = new Set();
  for (const [index, file] of manifest.files.entries()) {
    canonicalPublicPath(file?.path, `${label}.files[${index}].path`);
    if (seen.has(file.path) || (previous && previous.localeCompare(file.path, "en") >= 0)) throw new Error(`${label} manifest paths are duplicated or unsorted`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HEX64.test(file.sha256)) throw new Error(`${label} manifest file metadata is invalid: ${file.path}`);
    seen.add(file.path);
    previous = file.path;
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes)) throw new Error(`${label} manifest byte total exceeds the safe integer range`);
  }
  const canonicalFiles = manifest.files.map((file) => `${file.sha256}  ${file.path}\n`).join("");
  const digest = sha256Buffer(Buffer.from(`asset-policy-sha256  ${manifest.assetPolicySha256}\n${canonicalFiles}`, "utf8"));
  if (digest !== manifest.digest || manifest.assetVersion !== `sha256-${digest}` ||
      manifest.fileCount !== manifest.files.length || manifest.totalBytes !== totalBytes) {
    throw new Error(`${label} manifest aggregate digest/count/bytes mismatch`);
  }
  return { manifestSha256: sha256Buffer(bytes), filesByPath: new Map(manifest.files.map((file) => [file.path, file])) };
}

function compareAssetPolicies(currentProjection, nextProjection, nextFiles) {
  const currentAssets = structuredClone(currentProjection.assets);
  const nextAssets = structuredClone(nextProjection.assets);
  const currentRequired = currentAssets.requiredPaths;
  const nextRequired = nextAssets.requiredPaths;
  if (!Array.isArray(currentRequired) || !Array.isArray(nextRequired)) throw new Error("both asset policies must declare requiredPaths arrays");
  delete currentAssets.requiredPaths;
  delete nextAssets.requiredPaths;
  if (stableJson(currentAssets) !== stableJson(nextAssets)) {
    throw new Error("asset policy fields other than requiredPaths changed");
  }
  const currentSet = new Set(currentRequired.map((entry, index) => canonicalPublicPath(entry, `current requiredPaths[${index}]`)));
  const nextSet = new Set(nextRequired.map((entry, index) => canonicalPublicPath(entry, `next requiredPaths[${index}]`)));
  if (currentSet.size !== currentRequired.length || nextSet.size !== nextRequired.length) throw new Error("asset policy requiredPaths contain duplicates");
  for (const entry of currentSet) if (!nextSet.has(entry)) throw new Error(`next asset policy removes a required path: ${entry}`);
  const addedRequiredPaths = [...nextSet].filter((entry) => !currentSet.has(entry)).sort((left, right) => left.localeCompare(right, "en"));
  if (addedRequiredPaths.length === 0) throw new Error("policy digests differ without an additive requiredPaths transition");
  for (const entry of addedRequiredPaths) if (!nextFiles.has(entry)) throw new Error(`new required asset is absent from the next manifest: ${entry}`);
  return addedRequiredPaths;
}

function compareUrlInventories(current, next) {
  const nextByPath = new Map(next.files.map((file) => [file.path, file]));
  for (const previousFile of current.files) {
    const nextFile = nextByPath.get(previousFile.path);
    if (!nextFile) throw new Error(`new asset release deletes an active URL: ${previousFile.path}`);
    if (nextFile.sha256 !== previousFile.sha256 || nextFile.bytes !== previousFile.bytes) {
      throw new Error(`new asset release mutates an active immutable URL: ${previousFile.path}`);
    }
  }
  const currentPaths = new Set(current.files.map((file) => file.path));
  const addedFiles = next.files.filter((file) => !currentPaths.has(file.path));
  return {
    preservedUrlCount: current.files.length,
    addedUrlCount: addedFiles.length,
    addedBytes: addedFiles.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function receiptSide(manifest, manifestSha256, policy) {
  return {
    assetVersion: manifest.assetVersion,
    assetDigest: manifest.digest,
    assetPolicySha256: manifest.assetPolicySha256,
    manifestSha256,
    assetPolicy: policy,
  };
}

const scriptPath = fileURLToPath(import.meta.url);
const generatorScriptSha256 = sha256Buffer(fs.readFileSync(scriptPath));

if (createMode) {
  const currentPolicyRead = readRegularJson(options.get("--current-policy"), "current policy");
  const nextPolicyRead = readRegularJson(options.get("--next-policy"), "next policy");
  const currentManifestRead = readRegularJson(options.get("--current-manifest"), "current manifest");
  const nextManifestRead = readRegularJson(options.get("--next-manifest"), "next manifest");
  const currentPolicy = policyProjection(currentPolicyRead.value, "current");
  const nextPolicy = policyProjection(nextPolicyRead.value, "next");
  if (currentPolicy.sha256 === nextPolicy.sha256) throw new Error("asset policies are identical; a transition proof is unnecessary");
  const currentManifest = validateManifest(currentManifestRead.bytes, currentManifestRead.value, currentPolicy.sha256, "current");
  const nextManifest = validateManifest(nextManifestRead.bytes, nextManifestRead.value, nextPolicy.sha256, "next");
  const addedRequiredPaths = compareAssetPolicies(currentPolicy.projection, nextPolicy.projection, nextManifest.filesByPath);
  const urlProof = compareUrlInventories(currentManifestRead.value, nextManifestRead.value);
  const receipt = {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    kind: KIND,
    status: "VERIFIED",
    transitionMode: "required-paths-additive-only",
    current: receiptSide(currentManifestRead.value, currentManifest.manifestSha256, currentPolicy.projection),
    next: receiptSide(nextManifestRead.value, nextManifest.manifestSha256, nextPolicy.projection),
    addedRequiredPaths,
    urlProof,
    generator: { id: GENERATOR_ID, protocolVersion: 1, scriptSha256: generatorScriptSha256 },
    verifiedAt: new Date().toISOString(),
  };
  const output = options.get("--output");
  if (!output) throw new Error("--output is required in create mode");
  const outputPath = path.resolve(output);
  if (path.parse(outputPath).root === outputPath) throw new Error("output path is too broad");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fs.writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    const descriptor = fs.openSync(temporaryPath, "r+");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (fs.existsSync(outputPath)) throw new Error(`output already exists: ${outputPath}`);
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  console.log(JSON.stringify({ ok: true, mode: "create", output: outputPath, receiptSha256: sha256Buffer(bytes), addedRequiredPaths, urlProof }));
  process.exit(0);
}

const currentManifestRead = readRegularJson(options.get("--current-manifest"), "current manifest");
const nextManifestRead = readRegularJson(options.get("--next-manifest"), "next manifest");
const currentManifestWithoutPolicy = validateManifest(currentManifestRead.bytes, currentManifestRead.value, null, "current");
const nextManifestWithoutPolicy = validateManifest(nextManifestRead.bytes, nextManifestRead.value, null, "next");
if (currentManifestRead.value.digest === nextManifestRead.value.digest) {
  if (options.has("--receipt") || options.has("--receipt-sha256")) throw new Error("a transition receipt is forbidden when the asset digest is unchanged");
  console.log(JSON.stringify({ ok: true, mode: "verify", transitionMode: "unchanged-asset-digest", urlProof: compareUrlInventories(currentManifestRead.value, nextManifestRead.value) }));
  process.exit(0);
}
if (currentManifestRead.value.assetPolicySha256 === nextManifestRead.value.assetPolicySha256) {
  if (options.has("--receipt") || options.has("--receipt-sha256")) throw new Error("a transition receipt is forbidden when the asset policy is unchanged");
  console.log(JSON.stringify({ ok: true, mode: "verify", transitionMode: "unchanged-policy-forward-url-superset", urlProof: compareUrlInventories(currentManifestRead.value, nextManifestRead.value) }));
  process.exit(0);
}
void currentManifestWithoutPolicy;
void nextManifestWithoutPolicy;
const receiptRead = readRegularJson(options.get("--receipt"), "transition receipt");
const expectedReceiptSha256 = options.get("--receipt-sha256");
if (!HEX64.test(expectedReceiptSha256 || "") || sha256Buffer(receiptRead.bytes) !== expectedReceiptSha256) throw new Error("transition receipt SHA-256 mismatch");
const receipt = receiptRead.value;
exactKeys(receipt, ["schemaVersion", "projectId", "kind", "status", "transitionMode", "current", "next", "addedRequiredPaths", "urlProof", "generator", "verifiedAt"], "transition receipt");
if (receipt.schemaVersion !== 1 || receipt.projectId !== PROJECT_ID || receipt.kind !== KIND || receipt.status !== "VERIFIED" ||
    receipt.transitionMode !== "required-paths-additive-only" || !Number.isFinite(Date.parse(receipt.verifiedAt))) {
  throw new Error("transition receipt identity/status/mode/time is invalid");
}
exactKeys(receipt.generator, ["id", "protocolVersion", "scriptSha256"], "transition receipt generator");
if (receipt.generator.id !== GENERATOR_ID || receipt.generator.protocolVersion !== 1 || receipt.generator.scriptSha256 !== generatorScriptSha256) {
  throw new Error("transition receipt generator identity/SHA is unsupported");
}
for (const label of ["current", "next"]) {
  exactKeys(receipt[label], ["assetVersion", "assetDigest", "assetPolicySha256", "manifestSha256", "assetPolicy"], `${label} transition side`);
}
exactKeys(receipt.urlProof, ["preservedUrlCount", "addedUrlCount", "addedBytes"], "transition URL proof");
const currentPolicy = policyProjection(receipt.current.assetPolicy, "receipt current");
const nextPolicy = policyProjection(receipt.next.assetPolicy, "receipt next");
const currentManifest = validateManifest(currentManifestRead.bytes, currentManifestRead.value, currentPolicy.sha256, "current");
const nextManifest = validateManifest(nextManifestRead.bytes, nextManifestRead.value, nextPolicy.sha256, "next");
if (currentPolicy.sha256 === nextPolicy.sha256) throw new Error("transition receipt cannot be used for an unchanged policy");
const currentSide = receiptSide(currentManifestRead.value, currentManifest.manifestSha256, currentPolicy.projection);
const nextSide = receiptSide(nextManifestRead.value, nextManifest.manifestSha256, nextPolicy.projection);
if (stableJson(receipt.current) !== stableJson(currentSide) || stableJson(receipt.next) !== stableJson(nextSide)) throw new Error("transition receipt is not bound to the supplied manifests/policies");
const addedRequiredPaths = compareAssetPolicies(currentPolicy.projection, nextPolicy.projection, nextManifest.filesByPath);
if (stableJson(receipt.addedRequiredPaths) !== stableJson(addedRequiredPaths)) throw new Error("transition receipt addedRequiredPaths mismatch");
const urlProof = compareUrlInventories(currentManifestRead.value, nextManifestRead.value);
if (stableJson(receipt.urlProof) !== stableJson(urlProof)) throw new Error("transition receipt URL proof mismatch");
console.log(JSON.stringify({ ok: true, mode: "verify", receiptSha256: expectedReceiptSha256, transitionMode: receipt.transitionMode, addedRequiredPaths, urlProof }));
