#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const projectRoot = path.resolve(scriptDirectory, "..");
const schemaPath = path.join(scriptDirectory, "contracts", "production-preflight-receipt.v1.schema.json");
const referenceContractPath = path.join(scriptDirectory, "contracts", "production-preflight-reference.v1.json");
const databaseContractPath = path.join(projectRoot, "deploy", "policies", "database-contract.v1.json");

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40,64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/u;
const RECEIPT_ID = /^preflight-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{16}$/u;
const RECEIPT_TTL_SECONDS = 300;

class PreflightReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreflightReceiptError";
    this.code = code;
  }
}

function reject(code) {
  throw new PreflightReceiptError(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) reject(`${label}_NOT_OBJECT`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject(`${label}_KEYS_INVALID`);
  }
}

function requireString(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) reject(code);
}

function requireInteger(value, minimum, code) {
  if (!Number.isSafeInteger(value) || value < minimum) reject(code);
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

export function databaseFingerprintFromUrl(rawUrl) {
  let origin;
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
        || parsed.pathname !== "/") {
      reject("DATABASE_ENDPOINT_INVALID");
    }
    origin = parsed.origin.toLowerCase();
  } catch (error) {
    if (error instanceof PreflightReceiptError) throw error;
    reject("DATABASE_ENDPOINT_INVALID");
  }
  return sha256(stableJson({ kind: "postgrest-origin.v1", origin, profile: "public" }));
}

export function receiptPayload(receipt) {
  const payload = { ...receipt };
  delete payload.attestation;
  return payload;
}

export function signReceiptPayload(payload, key, keyId) {
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) reject("ATTESTATION_KEY_INVALID");
  requireString(keyId, SAFE_ID, "ATTESTATION_KEY_ID_INVALID");
  const canonical = stableJson(payload);
  return {
    ...payload,
    attestation: {
      algorithm: "hmac-sha256",
      keyId,
      payloadSha256: sha256(canonical),
      signature: crypto.createHmac("sha256", key).update(canonical).digest("hex"),
    },
  };
}

function validateReceiptShape(receipt) {
  exactKeys(receipt, [
    "schemaVersion", "status", "receiptId", "issuedAtEpoch", "expiresAtEpoch", "ttlSeconds",
    "binding", "database", "probe", "counters", "attestation",
  ], "RECEIPT");
  if (receipt.schemaVersion !== "zimeiti-production-preflight-receipt.v1") reject("RECEIPT_SCHEMA_VERSION_INVALID");
  if (receipt.status !== "passed") reject("RECEIPT_STATUS_INVALID");
  requireString(receipt.receiptId, RECEIPT_ID, "RECEIPT_ID_INVALID");
  requireInteger(receipt.issuedAtEpoch, 1, "RECEIPT_ISSUED_AT_INVALID");
  requireInteger(receipt.expiresAtEpoch, 1, "RECEIPT_EXPIRES_AT_INVALID");
  if (receipt.ttlSeconds !== RECEIPT_TTL_SECONDS) reject("RECEIPT_TTL_INVALID");

  exactKeys(receipt.binding, [
    "releaseId", "artifactSha256", "commitSha", "sourceVersion", "buildId", "databaseFingerprint",
    "databaseContractSha256", "referenceContractSha256", "migrationManifestSha256",
    "receiptSchemaSha256", "verifierSha256",
  ], "BINDING");
  requireString(receipt.binding.releaseId, RELEASE_ID, "BINDING_RELEASE_ID_INVALID");
  requireString(receipt.binding.artifactSha256, SHA256, "BINDING_ARTIFACT_SHA256_INVALID");
  requireString(receipt.binding.commitSha, COMMIT_SHA, "BINDING_COMMIT_SHA_INVALID");
  requireString(receipt.binding.sourceVersion, SAFE_ID, "BINDING_SOURCE_VERSION_INVALID");
  requireString(receipt.binding.buildId, SAFE_ID, "BINDING_BUILD_ID_INVALID");
  for (const key of [
    "databaseFingerprint", "databaseContractSha256", "referenceContractSha256",
    "migrationManifestSha256", "receiptSchemaSha256", "verifierSha256",
  ]) requireString(receipt.binding[key], SHA256, `BINDING_${key.toUpperCase()}_INVALID`);

  exactKeys(receipt.database, [
    "contractId", "contractVersion", "requiredProbeRole", "openApiProfile", "openApiSha256",
    "tableCount", "rpcCount", "referenceContractId", "referenceCounts",
  ], "DATABASE");
  requireString(receipt.database.contractId, SAFE_ID, "DATABASE_CONTRACT_ID_INVALID");
  requireString(receipt.database.contractVersion, SAFE_ID, "DATABASE_CONTRACT_VERSION_INVALID");
  if (receipt.database.requiredProbeRole !== "service_role") reject("DATABASE_PROBE_ROLE_INVALID");
  if (receipt.database.openApiProfile !== "public") reject("DATABASE_OPENAPI_PROFILE_INVALID");
  requireString(receipt.database.openApiSha256, SHA256, "DATABASE_OPENAPI_SHA256_INVALID");
  requireInteger(receipt.database.tableCount, 0, "DATABASE_TABLE_COUNT_INVALID");
  requireInteger(receipt.database.rpcCount, 0, "DATABASE_RPC_COUNT_INVALID");
  if (receipt.database.referenceContractId !== "zimeiti-production-preflight-reference.v1") {
    reject("DATABASE_REFERENCE_CONTRACT_ID_INVALID");
  }
  exactKeys(receipt.database.referenceCounts, [
    "voiceActivePrice", "manjuActive", "manjuRelease", "manjuRevision", "manjuStorage",
    "activeVideoModel", "verifiedVideoHealth", "unverifiedVideoHealth",
  ], "REFERENCE_COUNTS");
  for (const value of Object.values(receipt.database.referenceCounts)) {
    requireInteger(value, 0, "REFERENCE_COUNT_INVALID");
  }
  if (receipt.database.referenceCounts.voiceActivePrice !== 1) reject("REFERENCE_VOICE_PRICE_NOT_READY");

  exactKeys(receipt.probe, [
    "mode", "methods", "httpGetRequests", "openApiValidated", "referenceDataValidated", "apiKeyFieldSelected",
  ], "PROBE");
  if (receipt.probe.mode !== "controller-get-only-postgrest.v1") reject("PROBE_MODE_INVALID");
  if (!Array.isArray(receipt.probe.methods) || receipt.probe.methods.length !== 1 || receipt.probe.methods[0] !== "GET") {
    reject("PROBE_METHOD_NOT_GET_ONLY");
  }
  requireInteger(receipt.probe.httpGetRequests, 2, "PROBE_GET_COUNT_INVALID");
  if (receipt.probe.openApiValidated !== true) reject("PROBE_OPENAPI_NOT_VALIDATED");
  if (receipt.probe.referenceDataValidated !== true) reject("PROBE_REFERENCE_NOT_VALIDATED");
  if (receipt.probe.apiKeyFieldSelected !== false) reject("PROBE_API_KEY_FIELD_SELECTED");

  exactKeys(receipt.counters, ["databaseWrites", "rpcRequests", "providerRequests", "paidRequests"], "COUNTERS");
  for (const [name, value] of Object.entries(receipt.counters)) {
    if (value !== 0) reject(`COUNTER_${name.toUpperCase()}_NONZERO`);
  }

  exactKeys(receipt.attestation, ["algorithm", "keyId", "payloadSha256", "signature"], "ATTESTATION");
  if (receipt.attestation.algorithm !== "hmac-sha256") reject("ATTESTATION_ALGORITHM_INVALID");
  requireString(receipt.attestation.keyId, SAFE_ID, "ATTESTATION_KEY_ID_INVALID");
  requireString(receipt.attestation.payloadSha256, SHA256, "ATTESTATION_PAYLOAD_SHA256_INVALID");
  requireString(receipt.attestation.signature, SHA256, "ATTESTATION_SIGNATURE_INVALID");
}

function secureEqualHex(left, right) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function verifyProductionPreflightReceipt(receipt, options) {
  validateReceiptShape(receipt);
  const nowEpoch = options.nowEpoch ?? Math.floor(Date.now() / 1000);
  requireInteger(nowEpoch, 1, "VERIFY_TIME_INVALID");
  if (receipt.expiresAtEpoch - receipt.issuedAtEpoch !== RECEIPT_TTL_SECONDS) reject("RECEIPT_WINDOW_INVALID");
  if (receipt.issuedAtEpoch > nowEpoch + 30) reject("RECEIPT_FROM_FUTURE");
  if (receipt.expiresAtEpoch <= nowEpoch) reject("RECEIPT_EXPIRED");

  const referenceDomainCount = options.referenceDomainCount;
  requireInteger(referenceDomainCount, 1, "REFERENCE_DOMAIN_COUNT_INVALID");
  for (const key of ["manjuActive", "manjuRelease", "manjuRevision", "manjuStorage"]) {
    if (receipt.database.referenceCounts[key] !== referenceDomainCount) reject(`REFERENCE_${key.toUpperCase()}_NOT_READY`);
  }
  const { activeVideoModel, verifiedVideoHealth, unverifiedVideoHealth } = receipt.database.referenceCounts;
  if (activeVideoModel < 1) reject("REFERENCE_VIDEO_MODEL_NOT_READY");
  if (verifiedVideoHealth > activeVideoModel || unverifiedVideoHealth > activeVideoModel
      || verifiedVideoHealth + unverifiedVideoHealth !== activeVideoModel) reject("REFERENCE_VIDEO_HEALTH_COUNT_INVALID");

  if (typeof options.key !== "string" || Buffer.byteLength(options.key, "utf8") < 32) reject("ATTESTATION_KEY_INVALID");
  requireString(options.keyId, SAFE_ID, "EXPECTED_KEY_ID_INVALID");
  if (receipt.attestation.keyId !== options.keyId) reject("ATTESTATION_KEY_ID_MISMATCH");
  const canonical = stableJson(receiptPayload(receipt));
  const payloadSha256 = sha256(canonical);
  if (!secureEqualHex(receipt.attestation.payloadSha256, payloadSha256)) reject("ATTESTATION_PAYLOAD_TAMPERED");
  const signature = crypto.createHmac("sha256", options.key).update(canonical).digest("hex");
  if (!secureEqualHex(receipt.attestation.signature, signature)) reject("ATTESTATION_SIGNATURE_INVALID");

  exactKeys(options.expectedBinding, Object.keys(receipt.binding), "EXPECTED_BINDING");
  for (const [name, value] of Object.entries(options.expectedBinding)) {
    if (receipt.binding[name] !== value) reject(`BINDING_${name.toUpperCase()}_MISMATCH`);
  }
  exactKeys(options.expectedDatabase, [
    "contractId", "contractVersion", "tableCount", "rpcCount", "referenceContractId",
  ], "EXPECTED_DATABASE");
  for (const [name, value] of Object.entries(options.expectedDatabase)) {
    if (receipt.database[name] !== value) reject(`DATABASE_${name.toUpperCase()}_MISMATCH`);
  }
  return {
    ok: true,
    receiptId: receipt.receiptId,
    releaseId: receipt.binding.releaseId,
    expiresAtEpoch: receipt.expiresAtEpoch,
    databaseFingerprint: receipt.binding.databaseFingerprint,
    counters: receipt.counters,
  };
}

function optionValue(args, name) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1].trim() : "";
}

function requiredOption(args, name, envName) {
  const value = optionValue(args, name) || String(process.env[envName] || "").trim();
  if (!value) reject(`REQUIRED_${envName}_MISSING`);
  return value;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "");
  if (!value) reject(`REQUIRED_${name}_MISSING`);
  return value;
}

function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    reject(code);
  }
}

function localContracts() {
  const schema = readJson(schemaPath, "RECEIPT_SCHEMA_INVALID");
  const reference = readJson(referenceContractPath, "REFERENCE_CONTRACT_INVALID");
  const database = readJson(databaseContractPath, "DATABASE_CONTRACT_INVALID");
  if (schema.additionalProperties !== false || schema.properties?.binding?.additionalProperties !== false) {
    reject("RECEIPT_SCHEMA_NOT_STRICT");
  }
  if (reference.contractId !== "zimeiti-production-preflight-reference.v1"
      || !Array.isArray(reference.manjuDomains) || !Array.isArray(reference.tables)
      || reference.releaseReadinessPolicy?.videoHealth !== "metadata-diagnostic-only") {
    reject("REFERENCE_CONTRACT_INVALID");
  }
  if (!Array.isArray(database.tables) || !Array.isArray(database.rpcs)) reject("DATABASE_CONTRACT_INVALID");
  return { schema, reference, database };
}

function cliExpected(args, contracts) {
  const databaseUrl = requiredEnvironment("COZE_SUPABASE_URL").trim();
  const expectedBinding = {
    releaseId: requiredOption(args, "--release-id", "RELEASE_ID"),
    artifactSha256: requiredOption(args, "--artifact-sha256", "ARTIFACT_SHA256").toLowerCase(),
    commitSha: requiredOption(args, "--commit", "DEPLOY_COMMIT_SHA").toLowerCase(),
    sourceVersion: requiredOption(args, "--source-version", "EXPECTED_SOURCE_VERSION"),
    buildId: requiredOption(args, "--build-id", "EXPECTED_BUILD_ID"),
    databaseFingerprint: databaseFingerprintFromUrl(databaseUrl),
    databaseContractSha256: sha256File(databaseContractPath),
    referenceContractSha256: sha256File(referenceContractPath),
    migrationManifestSha256: requiredOption(args, "--migration-manifest-sha256", "MIGRATION_MANIFEST_SHA256").toLowerCase(),
    receiptSchemaSha256: sha256File(schemaPath),
    verifierSha256: sha256File(scriptPath),
  };
  return {
    expectedBinding,
    expectedDatabase: {
      contractId: contracts.database.contractId,
      contractVersion: contracts.database.contractVersion,
      tableCount: contracts.database.tables.length,
      rpcCount: contracts.database.rpcs.length,
      referenceContractId: contracts.reference.contractId,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectReject(label, action, expectedCode) {
  assert.throws(action, (error) => error instanceof PreflightReceiptError && error.code === expectedCode, label);
}

async function runDynamicIdSelfTest(referenceContract) {
  const originalEnvironment = process.env;
  const originalFetch = globalThis.fetch;
  const originalWriteFileSync = fs.writeFileSync;
  const originalExitCode = process.exitCode;
  const protectedVariables = new Set([
    "COZE_SUPABASE_URL", "COZE_SUPABASE_SERVICE_ROLE_KEY",
    "PRODUCTION_PREFLIGHT_RECEIPT_HMAC_KEY", "PRODUCTION_PREFLIGHT_RECEIPT_KEY_ID",
    "RELEASE_ID", "ARTIFACT_SHA256", "DEPLOY_COMMIT_SHA", "EXPECTED_SOURCE_VERSION",
    "EXPECTED_BUILD_ID", "MIGRATION_MANIFEST_SHA256",
  ]);
  const counters = { protectedEnvironmentReads: 0, networkRequests: 0, receiptWrites: 0 };
  process.env = new Proxy(originalEnvironment, {
    get(target, name) {
      if (protectedVariables.has(name)) {
        counters.protectedEnvironmentReads += 1;
        throw new Error("SELF_TEST_PROTECTED_ENV_READ_FORBIDDEN");
      }
      return Reflect.get(target, name);
    },
  });
  globalThis.fetch = () => {
    counters.networkRequests += 1;
    throw new Error("SELF_TEST_NETWORK_FORBIDDEN");
  };
  fs.writeFileSync = () => {
    counters.receiptWrites += 1;
    throw new Error("SELF_TEST_RECEIPT_WRITE_FORBIDDEN");
  };
  try {
    // Import only after this verifier has evaluated; the creator imports its signing helpers.
    const { safeDynamicIds, tableUrl } = await import("./create-production-preflight-receipt.mjs");
    assert.equal(process.exitCode, originalExitCode, "import must not invoke the creator CLI");
    const ids = ["fixture-model-2.0", "fixture-model-legacy"];
    assert.deepEqual(safeDynamicIds(ids), ids, "dot and hyphen IDs must be preserved");
    const table = referenceContract.tables.find((entry) => entry.name === "video_channel_health");
    assert.ok(table, "actual video health reference table must exist");
    const restBase = new URL("https://preflight-fixture.invalid/rest/v1/");
    const serialized = tableUrl(restBase, table, { column: "channel_id", values: safeDynamicIds(ids) }, "2099-01-01T00:00:00.000Z").href;
    const reparsed = new URL(serialized);
    assert.equal(reparsed.origin, restBase.origin);
    assert.equal(reparsed.pathname, "/rest/v1/video_channel_health");
    assert.equal(reparsed.searchParams.get("channel_id"), `in.(${ids.join(",")})`);
    assert.equal(reparsed.searchParams.get("select"), table.select.join(","));
    assert.equal(reparsed.searchParams.get("order"), table.order.join(","));
    assert.equal(reparsed.searchParams.get("limit"), String(table.limit));
    assert.deepEqual([...reparsed.searchParams.keys()].sort(), ["channel_id", "limit", "order", "select"]);
    assert.equal(reparsed.hash, "");

    const syntheticIds = [
      ...Array.from({ length: 5 }, (_, index) => `fixture-dot-${index}.0`),
      ...Array.from({ length: 33 }, (_, index) => `fixture-legacy-${index}`),
    ];
    assert.deepEqual(safeDynamicIds(syntheticIds), syntheticIds, "38 unique synthetic IDs must survive unchanged");
    assert.deepEqual(safeDynamicIds([" fixture-model-2.0 ", ids[0], "", "  ", null, undefined, ids[1]]), ids, "trim/dedup/empty filtering must be preserved");
    assert.deepEqual(safeDynamicIds(["a".repeat(128)]), ["a".repeat(128)]);
    const rejects = [
      ["129 characters", ["a".repeat(129)]], ["empty-only", ["", "  ", null, undefined]],
      ["comma", ["fixture,other"]], ["open parenthesis", ["fixture(other"]],
      ["close parenthesis", ["fixture)other"]], ["double quote", ['fixture"other']],
      ["single quote", ["fixture'other"]], ["backslash", ["fixture\\other"]],
      ["percent", ["fixture%2Cother"]], ["ampersand", ["fixture&other"]],
      ["equals", ["fixture=other"]], ["embedded space", ["fixture other"]],
      ["embedded tab", ["fixture\tother"]], ["embedded newline", ["fixture\nother"]],
      ["slash", ["fixture/other"]], ["underscore", ["fixture_other"]],
      ["colon", ["fixture:other"]], ["non-ASCII", ["fixture模型"]],
    ];
    for (const [label, values] of rejects) {
      assert.throws(() => safeDynamicIds(values), (error) => error?.code === "REFERENCE_DYNAMIC_ID_INVALID", label);
    }
    assert.deepEqual(counters, { protectedEnvironmentReads: 0, networkRequests: 0, receiptWrites: 0 });
    return { syntheticIds: 38, dotSyntheticIds: 5, urlRoundTrip: true, normalizationPreserved: true, max128Accepted: true, rejectedInputs: rejects.length, ...counters };
  } finally {
    process.env = originalEnvironment;
    globalThis.fetch = originalFetch;
    fs.writeFileSync = originalWriteFileSync;
  }
}

async function runSelfTest() {
  const contracts = localContracts();
  const creatorSource = fs.readFileSync(path.join(scriptDirectory, "create-production-preflight-receipt.mjs"), "utf8");
  assert.match(creatorSource, /method:\s*"GET"/u);
  assert.doesNotMatch(creatorSource, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/u);
  const selectedReferenceFields = contracts.reference.tables.flatMap((table) => table.select);
  assert.equal(selectedReferenceFields.includes("api_key"), false, "reference probes must not select api_key");
  const dynamicIds = await runDynamicIdSelfTest(contracts.reference);
  const key = "offline-fixture-key-only-not-a-production-secret-0123456789";
  const keyId = "offline-fixture-v1";
  const nowEpoch = 1_800_000_000;
  const expectedBinding = {
    releaseId: "web-direct-offline-fixture",
    artifactSha256: "a".repeat(64),
    commitSha: "b".repeat(40),
    sourceVersion: "R999999-20990101-deadbeef",
    buildId: "offline-build-id",
    databaseFingerprint: "c".repeat(64),
    databaseContractSha256: sha256File(databaseContractPath),
    referenceContractSha256: sha256File(referenceContractPath),
    migrationManifestSha256: "d".repeat(64),
    receiptSchemaSha256: sha256File(schemaPath),
    verifierSha256: sha256File(scriptPath),
  };
  const expectedDatabase = {
    contractId: contracts.database.contractId,
    contractVersion: contracts.database.contractVersion,
    tableCount: contracts.database.tables.length,
    rpcCount: contracts.database.rpcs.length,
    referenceContractId: contracts.reference.contractId,
  };
  const domains = contracts.reference.manjuDomains.length;
  const payload = {
    schemaVersion: "zimeiti-production-preflight-receipt.v1",
    status: "passed",
    receiptId: "preflight-20990101T000000Z-0123456789abcdef",
    issuedAtEpoch: nowEpoch - 30,
    expiresAtEpoch: nowEpoch - 30 + RECEIPT_TTL_SECONDS,
    ttlSeconds: RECEIPT_TTL_SECONDS,
    binding: expectedBinding,
    database: {
      ...expectedDatabase,
      requiredProbeRole: "service_role",
      openApiProfile: "public",
      openApiSha256: "e".repeat(64),
      referenceCounts: {
        voiceActivePrice: 1,
        manjuActive: domains,
        manjuRelease: domains,
        manjuRevision: domains,
        manjuStorage: domains,
        activeVideoModel: 2,
        verifiedVideoHealth: 2,
        unverifiedVideoHealth: 0,
      },
    },
    probe: {
      mode: "controller-get-only-postgrest.v1",
      methods: ["GET"],
      httpGetRequests: 8,
      openApiValidated: true,
      referenceDataValidated: true,
      apiKeyFieldSelected: false,
    },
    counters: { databaseWrites: 0, rpcRequests: 0, providerRequests: 0, paidRequests: 0 },
  };
  const options = { key, keyId, nowEpoch, expectedBinding, expectedDatabase, referenceDomainCount: domains };
  const valid = signReceiptPayload(payload, key, keyId);
  assert.equal(verifyProductionPreflightReceipt(valid, options).ok, true);

  const tampered = clone(valid);
  tampered.database.openApiSha256 = "f".repeat(64);
  expectReject("tampered payload", () => verifyProductionPreflightReceipt(tampered, options), "ATTESTATION_PAYLOAD_TAMPERED");

  const expiredPayload = { ...clone(payload), issuedAtEpoch: nowEpoch - 600, expiresAtEpoch: nowEpoch - 300 };
  const expired = signReceiptPayload(expiredPayload, key, keyId);
  expectReject("expired receipt", () => verifyProductionPreflightReceipt(expired, options), "RECEIPT_EXPIRED");

  const wrongBinding = { ...options, expectedBinding: { ...expectedBinding, releaseId: "different-release" } };
  expectReject("wrong release binding", () => verifyProductionPreflightReceipt(valid, wrongBinding), "BINDING_RELEASEID_MISMATCH");

  const counterCases = [
    ["databaseWrites", "COUNTER_DATABASEWRITES_NONZERO"],
    ["rpcRequests", "COUNTER_RPCREQUESTS_NONZERO"],
    ["providerRequests", "COUNTER_PROVIDERREQUESTS_NONZERO"],
    ["paidRequests", "COUNTER_PAIDREQUESTS_NONZERO"],
  ];
  for (const [counter, code] of counterCases) {
    const nonzeroPayload = clone(payload);
    nonzeroPayload.counters[counter] = 1;
    const nonzero = signReceiptPayload(nonzeroPayload, key, keyId);
    expectReject(`${counter} nonzero`, () => verifyProductionPreflightReceipt(nonzero, options), code);
  }

  const postPayload = clone(payload);
  postPayload.probe.methods = ["POST"];
  const post = signReceiptPayload(postPayload, key, keyId);
  expectReject("POST method", () => verifyProductionPreflightReceipt(post, options), "PROBE_METHOD_NOT_GET_ONLY");

  const extraPayload = clone(payload);
  extraPayload.untrusted = true;
  const extra = signReceiptPayload(extraPayload, key, keyId);
  expectReject("unknown property", () => verifyProductionPreflightReceipt(extra, options), "RECEIPT_KEYS_INVALID");

  console.log(JSON.stringify({
    ok: true,
    verifier: "production-preflight-receipt",
    cases: 9,
    rejected: ["tamper", "expiry", "wrong-binding", "database-write", "rpc", "provider", "paid", "post", "unknown-field"],
    dynamicIds,
    networkRequests: 0,
    databaseWrites: 0,
    providerRequests: 0,
    paidRequests: 0,
  }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    await runSelfTest();
    return;
  }
  const contracts = localContracts();
  const receiptPath = requiredOption(args, "--receipt", "PRODUCTION_PREFLIGHT_RECEIPT_PATH");
  const receipt = readJson(path.resolve(receiptPath), "RECEIPT_JSON_INVALID");
  const expected = cliExpected(args, contracts);
  const result = verifyProductionPreflightReceipt(receipt, {
    ...expected,
    key: requiredEnvironment("PRODUCTION_PREFLIGHT_RECEIPT_HMAC_KEY"),
    keyId: requiredEnvironment("PRODUCTION_PREFLIGHT_RECEIPT_KEY_ID").trim(),
    referenceDomainCount: contracts.reference.manjuDomains.length,
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    const code = error instanceof PreflightReceiptError ? error.code : "PRODUCTION_PREFLIGHT_RECEIPT_VERIFY_FAILED";
    console.error(JSON.stringify({ ok: false, code, credentialsPrinted: false }));
    process.exitCode = 1;
  });
}
