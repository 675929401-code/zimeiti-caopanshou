#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  databaseFingerprintFromUrl,
  sha256,
  sha256File,
  signReceiptPayload,
  stableJson,
} from "./verify-production-preflight-receipt.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const projectRoot = path.resolve(scriptDirectory, "..");
const verifierPath = path.join(scriptDirectory, "verify-production-preflight-receipt.mjs");
const schemaPath = path.join(scriptDirectory, "contracts", "production-preflight-receipt.v1.schema.json");
const referenceContractPath = path.join(scriptDirectory, "contracts", "production-preflight-reference.v1.json");
const databaseContractPath = path.join(projectRoot, "deploy", "policies", "database-contract.v1.json");

const SAFE_NAME = /^[a-z_][a-z0-9_]*$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40,64}$/u;
const MAX_OPENAPI_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const RECEIPT_TTL_SECONDS = 300;

class ProductionPreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProductionPreflightError";
    this.code = code;
  }
}

function reject(code) {
  throw new ProductionPreflightError(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!isRecord(value)) reject(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject(code);
}

function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    reject(code);
  }
}

function optionValue(args, name) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1].trim() : "";
}

function requiredBinding(args, name, envName, pattern) {
  const value = optionValue(args, name) || String(process.env[envName] || "").trim();
  if (!pattern.test(value)) reject(`BINDING_${envName}_INVALID`);
  return value;
}

function controlledEnvironment() {
  const rawUrl = String(process.env.COZE_SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const hmacKey = String(process.env.PRODUCTION_PREFLIGHT_RECEIPT_HMAC_KEY || "");
  const keyId = String(process.env.PRODUCTION_PREFLIGHT_RECEIPT_KEY_ID || "").trim();
  if (!rawUrl) reject("CONTROLLED_DATABASE_URL_MISSING");
  if (Buffer.byteLength(serviceRoleKey, "utf8") < 20) reject("CONTROLLED_SERVICE_ROLE_KEY_INVALID");
  if (Buffer.byteLength(hmacKey, "utf8") < 32) reject("CONTROLLED_ATTESTATION_KEY_INVALID");
  if (!SAFE_ID.test(keyId)) reject("CONTROLLED_ATTESTATION_KEY_ID_INVALID");
  let base;
  try {
    base = new URL(rawUrl);
  } catch {
    reject("CONTROLLED_DATABASE_URL_INVALID");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash
      || base.pathname !== "/") {
    reject("CONTROLLED_DATABASE_URL_INVALID");
  }
  const normalized = base.toString().endsWith("/") ? base.toString() : `${base.toString()}/`;
  return {
    rawUrl,
    restBase: new URL("rest/v1/", normalized),
    serviceRoleKey,
    hmacKey,
    keyId,
  };
}

function validateReferenceContract(contract) {
  exactKeys(contract, [
    "schemaVersion", "contractId", "environment", "manjuDomains", "videoHealthProtocolVersion",
    "forbiddenSelectFields", "tables",
  ], "REFERENCE_CONTRACT_KEYS_INVALID");
  if (contract.schemaVersion !== 1 || contract.contractId !== "zimeiti-production-preflight-reference.v1"
      || contract.environment !== "production" || contract.videoHealthProtocolVersion !== "video-channel-health.v2") {
    reject("REFERENCE_CONTRACT_IDENTITY_INVALID");
  }
  const expectedTables = [
    "voice_nest_price_versions", "manju_config_active", "manju_config_releases",
    "manju_config_revisions", "manju_config_storage_state", "video_models", "video_channel_health",
  ];
  const expectedDomains = [
    "prompt", "skill", "agent", "workflow", "content", "media", "feature_flags", "model_policy", "ui",
  ];
  if (!Array.isArray(contract.manjuDomains) || contract.manjuDomains.length !== expectedDomains.length
      || contract.manjuDomains.some((domain, index) => domain !== expectedDomains[index])
      || !Array.isArray(contract.forbiddenSelectFields) || !Array.isArray(contract.tables)) {
    reject("REFERENCE_CONTRACT_STRUCTURE_INVALID");
  }
  const forbidden = new Set(contract.forbiddenSelectFields.map((field) => String(field).toLowerCase()));
  if (!forbidden.has("api_key")) reject("REFERENCE_CONTRACT_API_KEY_GUARD_MISSING");
  const names = [];
  for (const table of contract.tables) {
    exactKeys(table, ["name", "purpose", "select", "filters", "order", "limit"], "REFERENCE_TABLE_KEYS_INVALID");
    if (!SAFE_NAME.test(table.name) || typeof table.purpose !== "string" || !Array.isArray(table.select)
        || !Array.isArray(table.filters) || !Array.isArray(table.order)
        || !Number.isSafeInteger(table.limit) || table.limit < 1 || table.limit > 1000) {
      reject("REFERENCE_TABLE_INVALID");
    }
    names.push(table.name);
    for (const field of table.select) {
      if (!SAFE_NAME.test(field) || forbidden.has(field.toLowerCase())
          || /(?:api_?key|secret|password|token|private_?key)/iu.test(field)) {
        reject("REFERENCE_SELECT_FIELD_FORBIDDEN");
      }
    }
    if (new Set(table.select).size !== table.select.length) reject("REFERENCE_SELECT_FIELD_DUPLICATE");
    for (const filter of table.filters) {
      exactKeys(filter, ["column", "operator", "value"], "REFERENCE_FILTER_INVALID");
      if (!table.select.includes(filter.column) || !["eq", "lte"].includes(filter.operator)
          || typeof filter.value !== "string") reject("REFERENCE_FILTER_INVALID");
    }
    for (const order of table.order) {
      const match = /^([a-z_][a-z0-9_]*)\.(asc|desc)$/u.exec(order);
      if (!match || !table.select.includes(match[1])) reject("REFERENCE_ORDER_INVALID");
    }
  }
  if (names.length !== expectedTables.length || names.some((name, index) => name !== expectedTables[index])) {
    reject("REFERENCE_TABLE_SET_INVALID");
  }
  return new Map(contract.tables.map((table) => [table.name, table]));
}

function resolveJsonPointer(document, pointer) {
  if (!pointer.startsWith("#/")) return undefined;
  return pointer.slice(2).split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => isRecord(current) ? current[part] : undefined, document);
}

function schemaForTable(document, table) {
  if (isRecord(document.definitions) && table in document.definitions) return document.definitions[table];
  const components = isRecord(document.components) ? document.components : null;
  const schemas = components && isRecord(components.schemas) ? components.schemas : null;
  return schemas?.[table];
}

function collectSchemaNames(document, value, names, seenRefs = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSchemaNames(document, item, names, seenRefs));
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.name === "string") names.add(value.name);
  if (isRecord(value.properties)) Object.keys(value.properties).forEach((name) => names.add(name));
  if (typeof value.$ref === "string" && !seenRefs.has(value.$ref)) {
    seenRefs.add(value.$ref);
    collectSchemaNames(document, resolveJsonPointer(document, value.$ref), names, seenRefs);
  }
  Object.values(value).forEach((child) => collectSchemaNames(document, child, names, seenRefs));
}

function validateOpenApi(document, contract, referenceTables) {
  if (!isRecord(document) || !isRecord(document.paths)) reject("OPENAPI_DOCUMENT_INVALID");
  if (contract.requiredProbeRole !== "service_role" || contract.openApiProfile !== "public"
      || !Array.isArray(contract.tables) || !Array.isArray(contract.rpcs) || !Array.isArray(contract.forbiddenRpcs)) {
    reject("DATABASE_CONTRACT_INVALID");
  }
  for (const table of contract.tables) {
    const tablePath = document.paths[`/${table.name}`];
    if (!isRecord(tablePath) || !isRecord(tablePath.get)) reject("OPENAPI_REQUIRED_TABLE_MISSING");
    const schema = schemaForTable(document, table.name);
    if (!isRecord(schema) || !isRecord(schema.properties)) reject("OPENAPI_TABLE_SCHEMA_MISSING");
    for (const column of table.columns) {
      if (!(column in schema.properties)) reject("OPENAPI_REQUIRED_COLUMN_MISSING");
    }
  }
  for (const rpc of contract.rpcs) {
    const rpcPath = document.paths[`/rpc/${rpc.name}`];
    if (!isRecord(rpcPath) || !isRecord(rpcPath.post)) reject("OPENAPI_REQUIRED_RPC_MISSING");
    const names = new Set();
    collectSchemaNames(document, rpcPath.post, names);
    for (const argument of rpc.arguments) {
      if (!names.has(argument)) reject("OPENAPI_REQUIRED_RPC_ARGUMENT_MISSING");
    }
  }
  for (const rpc of contract.forbiddenRpcs) {
    const rpcPath = document.paths[`/rpc/${rpc.name}`];
    if (isRecord(rpcPath) && (isRecord(rpcPath.post) || isRecord(rpcPath.get))) reject("OPENAPI_FORBIDDEN_RPC_PRESENT");
  }
  for (const [tableName, reference] of referenceTables) {
    const schema = schemaForTable(document, tableName);
    if (!isRecord(schema) || !isRecord(schema.properties)) reject("OPENAPI_REFERENCE_TABLE_SCHEMA_MISSING");
    for (const field of reference.select) {
      if (!(field in schema.properties)) reject("OPENAPI_REFERENCE_FIELD_MISSING");
    }
  }
}

function assertNoForbiddenResponseFields(value, forbidden) {
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoForbiddenResponseFields(item, forbidden));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase()) || /(?:api_?key|secret|password|token|private_?key)/iu.test(key)) {
      reject("REFERENCE_RESPONSE_SECRET_FIELD_PRESENT");
    }
    assertNoForbiddenResponseFields(child, forbidden);
  }
}

function assertSelectedRows(rows, selectedFields, forbidden) {
  if (!Array.isArray(rows)) reject("REFERENCE_RESPONSE_NOT_ARRAY");
  for (const row of rows) {
    if (!isRecord(row)) reject("REFERENCE_ROW_INVALID");
    if (Object.keys(row).some((key) => !selectedFields.includes(key))) reject("REFERENCE_RESPONSE_UNSELECTED_FIELD_PRESENT");
    assertNoForbiddenResponseFields(row, forbidden);
  }
}

export function safeDynamicIds(values) {
  const ids = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  if (ids.length === 0 || ids.some((id) => !/^[A-Za-z0-9.-]{1,128}$/u.test(id))) reject("REFERENCE_DYNAMIC_ID_INVALID");
  return ids;
}

export function tableUrl(restBase, table, dynamicFilter, nowIso) {
  const url = new URL(table.name, restBase);
  url.searchParams.set("select", table.select.join(","));
  for (const filter of table.filters) {
    url.searchParams.set(filter.column, `${filter.operator}.${filter.value}`);
  }
  if (table.name === "voice_nest_price_versions") url.searchParams.set("effective_at", `lte.${nowIso}`);
  if (dynamicFilter) url.searchParams.set(dynamicFilter.column, `in.(${dynamicFilter.values.join(",")})`);
  if (table.order.length) url.searchParams.set("order", table.order.join(","));
  url.searchParams.set("limit", String(table.limit));
  return url;
}

async function fetchGet(url, accept, maxBytes, env, counters) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  counters.httpGetRequests += 1;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: accept,
        "Accept-Profile": "public",
        Authorization: `Bearer ${env.serviceRoleKey}`,
        apikey: env.serviceRoleKey,
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) reject(`READ_ONLY_GET_HTTP_${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) reject("READ_ONLY_GET_RESPONSE_TOO_LARGE");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) reject("READ_ONLY_GET_RESPONSE_TOO_LARGE");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      reject("READ_ONLY_GET_JSON_INVALID");
    }
    return { data, text };
  } catch (error) {
    if (error instanceof ProductionPreflightError) throw error;
    reject("READ_ONLY_GET_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}

async function queryReference(table, dynamicFilter, context) {
  const url = tableUrl(context.env.restBase, table, dynamicFilter, context.nowIso);
  const response = await fetchGet(url, "application/json", MAX_REFERENCE_BYTES, context.env, context.counters);
  assertSelectedRows(response.data, table.select, context.forbidden);
  if (table.limit > 1 && response.data.length >= table.limit) reject("REFERENCE_RESULT_LIMIT_REACHED");
  return response.data;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function validateReferenceRows(reference, tables, context) {
  const voice = await queryReference(tables.get("voice_nest_price_versions"), null, context);
  if (voice.length !== 1 || voice[0].status !== "active" || !validDate(voice[0].effective_at)
      || Date.parse(voice[0].effective_at) > Date.parse(context.nowIso)) reject("REFERENCE_VOICE_PRICE_NOT_READY");

  const active = await queryReference(tables.get("manju_config_active"), null, context);
  const activeByDomain = new Map(active.map((row) => [row.domain, row]));
  if (active.length !== reference.manjuDomains.length || activeByDomain.size !== reference.manjuDomains.length
      || reference.manjuDomains.some((domain) => !activeByDomain.has(domain))) reject("REFERENCE_MANJU_ACTIVE_NOT_READY");
  const releaseIds = safeDynamicIds(active.map((row) => row.active_release_id));
  const revisionIds = safeDynamicIds(active.map((row) => row.active_revision_id));
  const releases = await queryReference(tables.get("manju_config_releases"), { column: "id", values: releaseIds }, context);
  const revisions = await queryReference(tables.get("manju_config_revisions"), { column: "id", values: revisionIds }, context);
  const storage = await queryReference(tables.get("manju_config_storage_state"), null, context);
  const releaseById = new Map(releases.map((row) => [row.id, row]));
  const revisionById = new Map(revisions.map((row) => [row.id, row]));
  const storageByDomain = new Map(storage.map((row) => [row.domain, row]));
  for (const domain of reference.manjuDomains) {
    const pointer = activeByDomain.get(domain);
    const release = releaseById.get(pointer?.active_release_id);
    const revision = revisionById.get(pointer?.active_revision_id);
    const state = storageByDomain.get(domain);
    if (!pointer || pointer.environment !== "production" || !release || !revision || !state
        || release.environment !== "production" || release.domain !== domain
        || release.revision_id !== pointer.active_revision_id || !["publish", "rollback"].includes(release.release_kind)
        || release.etag !== pointer.etag || revision.environment !== "production" || revision.domain !== domain
        || revision.status !== "published" || !validDate(revision.published_at)
        || state.environment !== "production" || state.domain !== domain || state.state !== "native"
        || !Number.isSafeInteger(Number(state.generation)) || Number(state.generation) < 1
        || state.native_active_release_id !== pointer.active_release_id
        || state.native_active_revision_id !== pointer.active_revision_id || !validDate(state.last_verified_at)) {
      reject("REFERENCE_MANJU_BINDING_NOT_READY");
    }
  }
  if (releases.length !== reference.manjuDomains.length || revisions.length !== reference.manjuDomains.length
      || storage.length !== reference.manjuDomains.length) reject("REFERENCE_MANJU_COUNT_NOT_READY");

  const videoModels = await queryReference(tables.get("video_models"), null, context);
  if (videoModels.length < 1 || videoModels.some((row) => row.is_active !== true)) reject("REFERENCE_VIDEO_MODEL_NOT_READY");
  const videoIds = safeDynamicIds(videoModels.map((row) => row.id));
  const health = await queryReference(tables.get("video_channel_health"), { column: "channel_id", values: videoIds }, context);
  const healthById = new Map(health.map((row) => [String(row.channel_id || ""), row]));
  for (const id of videoIds) {
    const row = healthById.get(id);
    if (!row || row.is_healthy !== true || row.health_protocol_version !== reference.videoHealthProtocolVersion
        || row.verification_state !== "verified" || !validDate(row.last_success_at) || !validDate(row.verified_at)
        || Date.parse(row.verified_at) < Date.parse(row.last_success_at)) reject("REFERENCE_VIDEO_HEALTH_NOT_READY");
  }
  if (health.length !== videoIds.length || healthById.size !== videoIds.length) reject("REFERENCE_VIDEO_HEALTH_COUNT_NOT_READY");

  return {
    voiceActivePrice: voice.length,
    manjuActive: active.length,
    manjuRelease: releases.length,
    manjuRevision: revisions.length,
    manjuStorage: storage.length,
    activeVideoModel: videoModels.length,
    verifiedVideoHealth: health.length,
  };
}

function writeExclusive(filePath, body) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(path.dirname(resolved))) reject("RECEIPT_OUTPUT_PARENT_MISSING");
  try {
    fs.writeFileSync(resolved, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.chmodSync(resolved, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") reject("RECEIPT_OUTPUT_EXISTS");
    reject("RECEIPT_OUTPUT_WRITE_FAILED");
  }
  return resolved;
}

async function main() {
  const args = process.argv.slice(2);
  const output = optionValue(args, "--output");
  if (!output) reject("RECEIPT_OUTPUT_REQUIRED");
  const binding = {
    releaseId: requiredBinding(args, "--release-id", "RELEASE_ID", RELEASE_ID),
    artifactSha256: requiredBinding(args, "--artifact-sha256", "ARTIFACT_SHA256", SHA256).toLowerCase(),
    commitSha: requiredBinding(args, "--commit", "DEPLOY_COMMIT_SHA", COMMIT_SHA).toLowerCase(),
    sourceVersion: requiredBinding(args, "--source-version", "EXPECTED_SOURCE_VERSION", SAFE_ID),
    buildId: requiredBinding(args, "--build-id", "EXPECTED_BUILD_ID", SAFE_ID),
    migrationManifestSha256: requiredBinding(args, "--migration-manifest-sha256", "MIGRATION_MANIFEST_SHA256", SHA256).toLowerCase(),
  };
  const env = controlledEnvironment();
  const databaseContract = readJson(databaseContractPath, "DATABASE_CONTRACT_INVALID");
  const referenceContract = readJson(referenceContractPath, "REFERENCE_CONTRACT_INVALID");
  const referenceTables = validateReferenceContract(referenceContract);
  const receiptSchema = readJson(schemaPath, "RECEIPT_SCHEMA_INVALID");
  if (receiptSchema.additionalProperties !== false || receiptSchema.properties?.binding?.additionalProperties !== false) {
    reject("RECEIPT_SCHEMA_NOT_STRICT");
  }

  const counters = { httpGetRequests: 0 };
  const openApi = await fetchGet(env.restBase, "application/openapi+json", MAX_OPENAPI_BYTES, env, counters);
  validateOpenApi(openApi.data, databaseContract, referenceTables);
  const now = new Date();
  const nowIso = now.toISOString();
  const referenceCounts = await validateReferenceRows(referenceContract, referenceTables, {
    env,
    counters,
    nowIso,
    forbidden: new Set(referenceContract.forbiddenSelectFields.map((field) => field.toLowerCase())),
  });

  const issuedAtEpoch = Math.floor(now.getTime() / 1000);
  const compactTime = nowIso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const payload = {
    schemaVersion: "zimeiti-production-preflight-receipt.v1",
    status: "passed",
    receiptId: `preflight-${compactTime}-${crypto.randomBytes(8).toString("hex")}`,
    issuedAtEpoch,
    expiresAtEpoch: issuedAtEpoch + RECEIPT_TTL_SECONDS,
    ttlSeconds: RECEIPT_TTL_SECONDS,
    binding: {
      releaseId: binding.releaseId,
      artifactSha256: binding.artifactSha256,
      commitSha: binding.commitSha,
      sourceVersion: binding.sourceVersion,
      buildId: binding.buildId,
      databaseFingerprint: databaseFingerprintFromUrl(env.rawUrl),
      databaseContractSha256: sha256File(databaseContractPath),
      referenceContractSha256: sha256File(referenceContractPath),
      migrationManifestSha256: binding.migrationManifestSha256,
      receiptSchemaSha256: sha256File(schemaPath),
      verifierSha256: sha256File(verifierPath),
    },
    database: {
      contractId: databaseContract.contractId,
      contractVersion: databaseContract.contractVersion,
      requiredProbeRole: databaseContract.requiredProbeRole,
      openApiProfile: databaseContract.openApiProfile,
      openApiSha256: sha256(openApi.text),
      tableCount: databaseContract.tables.length,
      rpcCount: databaseContract.rpcs.length,
      referenceContractId: referenceContract.contractId,
      referenceCounts,
    },
    probe: {
      mode: "controller-get-only-postgrest.v1",
      methods: ["GET"],
      httpGetRequests: counters.httpGetRequests,
      openApiValidated: true,
      referenceDataValidated: true,
      apiKeyFieldSelected: false,
    },
    counters: { databaseWrites: 0, rpcRequests: 0, providerRequests: 0, paidRequests: 0 },
  };
  const receipt = signReceiptPayload(payload, env.hmacKey, env.keyId);
  const resolvedOutput = writeExclusive(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    receiptId: receipt.receiptId,
    receiptPath: resolvedOutput,
    receiptSha256: sha256(stableJson(receipt)),
    releaseId: receipt.binding.releaseId,
    expiresAtEpoch: receipt.expiresAtEpoch,
    databaseFingerprint: receipt.binding.databaseFingerprint,
    httpGetRequests: receipt.probe.httpGetRequests,
    databaseWrites: 0,
    rpcRequests: 0,
    providerRequests: 0,
    paidRequests: 0,
    credentialsPrinted: false,
  }, null, 2));
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    const code = error instanceof ProductionPreflightError ? error.code : "PRODUCTION_PREFLIGHT_FAILED";
    console.error(JSON.stringify({ ok: false, code, credentialsPrinted: false }));
    process.exitCode = 1;
  });
}
