#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import realFs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { validateOpenApi, validateReferenceContract, validateReferenceRows } from "./create-production-preflight-receipt.mjs";
import {
  sha256File,
  signReceiptPayload,
  verifyProductionPreflightReceipt,
} from "./verify-production-preflight-receipt.mjs";

const routePath = path.join(process.cwd(), "src/app/api/release-readiness/route.ts");
const routeSource = realFs.readFileSync(routePath, "utf8");

assert.doesNotMatch(routeSource, /assertCandidateReadOnlyCredential|zimeiti_candidate_readonly/u);
assert.doesNotMatch(routeSource, /COZE_SUPABASE_SERVICE_ROLE_KEY[^\n]*(?:split|base64url)/u);
assert.match(routeSource, /candidate-runtime-v1/u);
assert.match(routeSource, /production-full-v1/u);
assert.match(routeSource, /external-attestation-required/u);
assert.ok(
  routeSource.indexOf("if (readinessProfile === CANDIDATE_READINESS_PROFILE)")
    < routeSource.indexOf("await probeProductionDatabaseReadiness()"),
  "candidate profile must branch before the production database probe",
);

const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: routePath,
}).outputText;

const DATA_ROOT = "/data/web/shared/data";
const RUNTIME_ROOT = "/data/web/shared/runtime";
const IDEMPOTENCY_ROOT = `${RUNTIME_ROOT}/llm-request-idempotency`;
const BACKUP_ROOT = "/data/web/shared/backups";
const UPLOAD_ROOT = "/data/web/shared/uploads";
const REFERENCE_AUDIO_ROOT = "/data/web/shared/voice/reference-audio";
const PUBLIC_ASSET_ROOT = "/data/web/shared/assets/current/public";
const VOICE_DATABASE_PATH = "/data/web/shared/voice/voice.db";
const RELEASE_CWD = "/data/web/releases/release-fixture/web";
const ASSET_DIGEST = "a".repeat(64);
const REQUIRED_DATA_FILES = [
  "engine-configs.json",
  "custom-voices.json",
  "service-cards.json",
  "studio-config.json",
  "voices.json",
  "voice-studio/service-cards.json",
  "voice-studio/voices.json",
];

const manifest = {
  schemaVersion: 1,
  projectId: "zimeiti-caopanshou",
  kind: "public-assets",
  contentAddressing: "sha256-files-and-asset-policy",
  assetPolicySha256: "b".repeat(64),
  digest: ASSET_DIGEST,
  assetVersion: `sha256-${ASSET_DIGEST}`,
  mutableUploadsIncluded: false,
  fileCount: 0,
  totalBytes: 0,
  files: [],
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
const receipt = {
  schemaVersion: 1,
  projectId: "zimeiti-caopanshou",
  kind: "public-assets-readiness-receipt",
  status: "READY",
  assetDigest: ASSET_DIGEST,
  assetVersion: `sha256-${ASSET_DIGEST}`,
  fileCount: 0,
  totalBytes: 0,
  mutableUploadsIncluded: false,
  verificationMode: "full-sha256",
  storageBackend: "disk",
  location: PUBLIC_ASSET_ROOT,
  verifiedAt: "2026-10-10T00:00:00.000Z",
  manifestSha256,
};

function createVirtualFs() {
  const files = new Map();
  for (const relativePath of REQUIRED_DATA_FILES) {
    files.set(path.posix.join(DATA_ROOT, relativePath), Buffer.from("[]"));
  }
  files.set(VOICE_DATABASE_PATH, Buffer.from("sqlite-fixture"));
  files.set("/data/web/shared/assets/current/.release/public-assets.v1.json", manifestBytes);
  files.set(
    "/data/web/shared/assets/current/.release/public-assets.ready.v1.json",
    Buffer.from(JSON.stringify(receipt)),
  );

  let nextDescriptor = 100;
  const descriptors = new Map();
  const normalize = (value) => path.posix.normalize(String(value).replaceAll("\\", "/"));
  const fileStats = (bytes) => ({
    dev: 2,
    size: bytes.length,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const directoryStats = (value) => ({
    dev: normalize(value) === "/" ? 1 : 2,
    size: 0,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  });

  return {
    constants: realFs.constants,
    accessSync() {},
    closeSync(descriptor) {
      descriptors.delete(descriptor);
    },
    lstatSync(value) {
      const normalized = normalize(value);
      return files.has(normalized) ? fileStats(files.get(normalized)) : directoryStats(normalized);
    },
    openSync(value) {
      const normalized = normalize(value);
      const bytes = files.get(normalized);
      if (!bytes) throw new Error(`virtual fixture file missing: ${normalized}`);
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, { bytes, offset: 0 });
      return descriptor;
    },
    readFileSync(value, encoding) {
      const normalized = normalize(value);
      const bytes = files.get(normalized);
      if (!bytes) throw new Error(`virtual fixture file missing: ${normalized}`);
      return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
    },
    readSync(descriptor, target, targetOffset, length) {
      const openFile = descriptors.get(descriptor);
      if (!openFile) throw new Error(`virtual fixture descriptor missing: ${descriptor}`);
      const bytesRead = Math.min(length, openFile.bytes.length - openFile.offset);
      if (bytesRead <= 0) return 0;
      openFile.bytes.copy(target, targetOffset, openFile.offset, openFile.offset + bytesRead);
      openFile.offset += bytesRead;
      return bytesRead;
    },
    realpathSync(value) {
      return normalize(value);
    },
    statSync(value) {
      const normalized = normalize(value);
      return files.has(normalized) ? fileStats(files.get(normalized)) : directoryStats(normalized);
    },
  };
}

function readyDatabaseProbeResult() {
  return {
    ok: true,
    state: "ready",
    contractId: "fixture-contract",
    contractVersion: "20261010000000",
    tableCount: 1,
    rpcCount: 1,
    missingTables: [],
    missingColumns: [],
    missingRpcs: [],
    missingRpcArguments: [],
    forbiddenRpcsPresent: [],
  };
}

function readyReferenceProbeResult() {
  return {
    ok: true,
    state: "ready",
    code: "REFERENCE_DATA_READY",
    voiceActivePriceCount: 1,
    serviceRoleConfigured: true,
    manjuRequiredDomainCount: 1,
    manjuReadyDomainCount: 1,
    missingManjuDomains: [],
    manjuStorageReadyDomainCount: 1,
    missingManjuStorageDomains: [],
    videoHealthProtocolVersion: "fixture-v1",
    activeVideoModelCount: 1,
    verifiedVideoModelCount: 1,
    videoModelVerificationReady: true,
    unverifiedVideoModelIds: [],
  };
}

async function runRoute(readinessProfile) {
  const counters = { database: 0, referenceData: 0 };
  const environment = {
    NODE_ENV: "production",
    COZE_PROJECT_ENV: "PROD",
    RELEASE_ID: "release-fixture-0001",
    DEPLOY_COMMIT_SHA: "c".repeat(40),
    EXPECTED_BUILD_ID: "build-fixture-0001",
    RELEASE_BUILD_OUTPUT_DIGEST: "d".repeat(64),
    RELEASE_SOURCE_VERSION: "R000000-fixture",
    ASSET_DIGEST,
    ASSET_MANIFEST_SHA256: manifestSha256,
    APP_DATA_DIR: DATA_ROOT,
    APP_RUNTIME_DIR: RUNTIME_ROOT,
    IDEMPOTENCY_DIR: IDEMPOTENCY_ROOT,
    BACKUP_DIR: BACKUP_ROOT,
    STORAGE_LOCAL_BASE_PATH: UPLOAD_ROOT,
    VOICE_REFERENCE_AUDIO_DIR: REFERENCE_AUDIO_ROOT,
    PUBLIC_ASSET_ROOT,
    VOICE_SQLITE_PATH: VOICE_DATABASE_PATH,
  };
  if (readinessProfile !== undefined) environment.RELEASE_READINESS_PROFILE = readinessProfile;

  assert.equal(environment.COZE_SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(environment.PAYMENT_PROVIDER_SECRET, undefined);
  assert.equal(environment.VIDEO_PROVIDER_API_KEY, undefined);

  class FixtureDatabase {
    close() {}
    pragma() {
      return "ok";
    }
    prepare() {
      return { get: () => ({ count: 2 }) };
    }
  }

  const moduleRecord = { exports: {} };
  const fixtureProcess = {
    cwd: () => RELEASE_CWD,
    env: environment,
    platform: "linux",
  };
  const requireFixture = (specifier) => {
    if (specifier === "node:crypto") return crypto;
    if (specifier === "node:fs") return createVirtualFs();
    if (specifier === "node:path") return path.posix;
    if (specifier === "better-sqlite3") return FixtureDatabase;
    if (specifier === "next/server") {
      return {
        NextResponse: {
          json: (body, init = {}) => ({
            body,
            headers: init.headers || {},
            status: init.status || 200,
          }),
        },
      };
    }
    if (specifier === "@/lib/runtime-paths") {
      return {
        resolveAppDataDir: () => DATA_ROOT,
        resolveAppRuntimeDir: () => RUNTIME_ROOT,
        resolveBackupDir: () => BACKUP_ROOT,
        resolveIdempotencyDir: () => IDEMPOTENCY_ROOT,
      };
    }
    if (specifier === "@/lib/production-database-readiness") {
      return {
        probeProductionDatabaseReadiness: async () => {
          counters.database += 1;
          return readyDatabaseProbeResult();
        },
      };
    }
    if (specifier === "@/lib/production-reference-data-readiness") {
      return {
        probeProductionReferenceDataReadiness: async () => {
          counters.referenceData += 1;
          return readyReferenceProbeResult();
        },
      };
    }
    if (specifier === "@/lib/voice-studio/database-path") {
      return { resolveVoiceSqlitePath: () => VOICE_DATABASE_PATH };
    }
    throw new Error(`unexpected route dependency: ${specifier}`);
  };

  const wrapper = vm.runInNewContext(
    `(function (exports, require, module, __filename, __dirname) { ${compiledRoute}\n })`,
    { Buffer, console, process: fixtureProcess },
    { filename: routePath },
  );
  wrapper(moduleRecord.exports, requireFixture, moduleRecord, routePath, path.dirname(routePath));
  const response = await moduleRecord.exports.GET();
  return { counters, response };
}

const candidate = await runRoute("candidate-runtime-v1");
assert.equal(candidate.response.status, 200, JSON.stringify(candidate.response.body));
assert.equal(candidate.response.body.ready, true);
assert.equal(candidate.response.body.activationReady, false);
assert.equal(candidate.response.body.readinessProfile, "candidate-runtime-v1");
assert.deepEqual(candidate.counters, { database: 0, referenceData: 0 });
assert.equal(candidate.response.body.checks.database.state, "external-attestation-required");
assert.equal(candidate.response.body.checks.database.ready, false);
assert.equal(candidate.response.body.checks.database.probeExecuted, false);
assert.equal(candidate.response.body.checks.referenceData.state, "external-attestation-required");
assert.equal(candidate.response.body.checks.referenceData.ready, false);
assert.equal(candidate.response.body.checks.referenceData.probeExecuted, false);
assert.ok(candidate.response.body.checks.data.files["engine-configs.json"]);
assert.equal(candidate.response.body.checks.voiceDatabase.quickCheck, "ok");
assert.equal(candidate.response.body.checks.storage.dataMount.isolatedFromSystemDisk, true);

const production = await runRoute("production-full-v1");
assert.equal(production.response.status, 200, JSON.stringify(production.response.body));
assert.equal(production.response.body.ready, true);
assert.equal(production.response.body.activationReady, true);
assert.equal(production.response.body.readinessProfile, "production-full-v1");
assert.deepEqual(production.counters, { database: 1, referenceData: 1 });
assert.equal(production.response.body.checks.database.state, "ready");
assert.equal(production.response.body.checks.referenceData.state, "ready");

const productionDefault = await runRoute(undefined);
assert.equal(productionDefault.response.status, 200, JSON.stringify(productionDefault.response.body));
assert.equal(productionDefault.response.body.readinessProfile, "production-full-v1");
assert.deepEqual(productionDefault.counters, { database: 1, referenceData: 1 });

const invalid = await runRoute("candidate-typo");
assert.equal(invalid.response.status, 503);
assert.equal(invalid.response.body.ready, false);
assert.equal(invalid.response.body.activationReady, false);
assert.deepEqual(invalid.counters, { database: 0, referenceData: 0 });
assert.match(invalid.response.body.error, /RELEASE_READINESS_PROFILE is invalid/u);

async function verifyReferenceHealthBoundary() {
  const referencePath = path.join(process.cwd(), "scripts/contracts/production-preflight-reference.v1.json");
  const databasePath = path.join(process.cwd(), "deploy/policies/database-contract.v1.json");
  const schemaPath = path.join(process.cwd(), "scripts/contracts/production-preflight-receipt.v1.schema.json");
  const reference = JSON.parse(realFs.readFileSync(referencePath, "utf8"));
  const database = JSON.parse(realFs.readFileSync(databasePath, "utf8"));
  const schema = JSON.parse(realFs.readFileSync(schemaPath, "utf8"));
  const tables = validateReferenceContract(reference);
  const nowIso = "2099-01-01T00:00:00.000Z";
  const fixtures = () => {
    const rows = Object.fromEntries(reference.tables.map((table) => [table.name, []]));
    rows.voice_nest_price_versions = [{ id: "voice-fixture", version: "v1", status: "active", effective_at: nowIso }];
    for (const domain of reference.manjuDomains) {
      const release = `release-${domain.replaceAll("_", "-")}`;
      const revision = `revision-${domain.replaceAll("_", "-")}`;
      rows.manju_config_active.push({ environment: "production", domain, active_release_id: release, active_revision_id: revision, etag: domain });
      rows.manju_config_releases.push({ id: release, environment: "production", domain, revision_id: revision, release_kind: "publish", etag: domain });
      rows.manju_config_revisions.push({ id: revision, environment: "production", domain, status: "published", published_at: nowIso });
      rows.manju_config_storage_state.push({ environment: "production", domain, state: "native", generation: 1, native_active_release_id: release, native_active_revision_id: revision, last_verified_at: nowIso });
    }
    for (let index = 0; index < 38; index += 1) {
      const id = `fixture-model-${index}.0`;
      rows.video_models.push({ id, model_name: id, provider: "fixture", protocol_type: "fixture", is_active: true });
      rows.video_channel_health.push({
        channel_id: id,
        is_healthy: index < 17 || index >= 34,
        last_success_at: nowIso,
        health_protocol_version: reference.videoHealthProtocolVersion,
        verification_state: index < 17 ? "verified" : "unverified",
        verified_at: index < 17 ? nowIso : null,
      });
    }
    return rows;
  };
  const openApi = { paths: {}, definitions: {} };
  for (const table of database.tables) {
    openApi.paths[`/${table.name}`] = { get: {} };
    openApi.definitions[table.name] = { properties: Object.fromEntries(table.columns.map((column) => [column, {}])) };
  }
  for (const table of reference.tables) {
    openApi.definitions[table.name] ||= { properties: {} };
    Object.assign(openApi.definitions[table.name].properties, Object.fromEntries(table.select.map((field) => [field, {}])));
  }
  for (const rpc of database.rpcs) openApi.paths[`/rpc/${rpc.name}`] = { post: { parameters: rpc.arguments.map((name) => ({ name })) } };
  validateOpenApi(openApi, database, tables);
  const noRequiredTable = structuredClone(openApi);
  delete noRequiredTable.paths[`/${database.tables[0].name}`];
  assert.throws(() => validateOpenApi(noRequiredTable, database, tables), (error) => error?.code === "OPENAPI_REQUIRED_TABLE_MISSING");
  const invalidPolicy = structuredClone(reference);
  invalidPolicy.releaseReadinessPolicy.videoHealth = "required";
  assert.throws(() => validateReferenceContract(invalidPolicy), (error) => error?.code === "REFERENCE_READINESS_POLICY_INVALID");

  let interceptedGetRequests = 0;
  const originalFetch = globalThis.fetch;
  async function probeCreator(rows) {
    const counters = { httpGetRequests: 0 };
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, "https://preflight-fixture.invalid");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["Accept-Profile"], "public");
      const name = url.pathname.slice("/rest/v1/".length);
      assert.equal(url.pathname, `/rest/v1/${name}`);
      assert.ok(tables.has(name), "only the actual reference GET allowlist can be queried");
      const table = tables.get(name);
      assert.equal(url.searchParams.get("select"), table.select.join(","));
      assert.equal(url.searchParams.get("limit"), String(table.limit));
      assert.equal(table.select.some((field) => /api_?key|secret|password|token/iu.test(field)), false);
      interceptedGetRequests += 1;
      return new Response(JSON.stringify(rows[name]), { headers: { "content-type": "application/json" } });
    };
    try {
      const counts = await validateReferenceRows(reference, tables, {
        env: { restBase: new URL("https://preflight-fixture.invalid/rest/v1/"), serviceRoleKey: "offline-fixture-only" },
        counters, nowIso, forbidden: new Set(reference.forbiddenSelectFields),
      });
      assert.equal(counters.httpGetRequests, 7);
      return counts;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // Execute the actual Web readiness and its actual health / binding inspectors.
  // All database reads use synthetic rows; credential resolution is forbidden.
  const loadedModules = new Map();
  function loadTypeScript(relativePath, dependencies) {
    if (loadedModules.has(relativePath)) return loadedModules.get(relativePath);
    const sourcePath = path.join(process.cwd(), relativePath);
    const compiled = ts.transpileModule(realFs.readFileSync(sourcePath, "utf8"), {
      compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: sourcePath,
    }).outputText;
    const moduleRecord = { exports: {} };
    const wrapper = vm.runInNewContext(`(function (exports, require, module) { ${compiled}\n })`, {
      process: { env: { COZE_SUPABASE_SERVICE_ROLE_KEY: "offline-fixture-configured" } },
      console, Buffer,
    }, { filename: sourcePath });
    wrapper(moduleRecord.exports, (specifier) => {
      assert.ok(Object.hasOwn(dependencies, specifier), `unexpected reference dependency: ${specifier}`);
      return dependencies[specifier];
    }, moduleRecord);
    loadedModules.set(relativePath, moduleRecord.exports);
    return moduleRecord.exports;
  }
  const healthModule = loadTypeScript("src/lib/video-channel-health-release.ts", {});
  const activationModule = loadTypeScript("src/lib/model-activation-gate.ts", {
    "node:crypto": crypto,
    "@/lib/provider-secret": { resolveProviderSecret: () => assert.fail("provider credential resolution is forbidden") },
  });
  let webRows;
  let webQueries = 0;
  const webModule = loadTypeScript("src/lib/production-reference-data-readiness.ts", {
    "@/lib/server/manju-runtime-config": { MANJU_CONFIG_DOMAINS: reference.manjuDomains, MANJU_PUBLIC_ENVIRONMENT: reference.environment },
    "@/lib/video-channel-health-release": healthModule,
    "@/lib/model-activation-gate": activationModule,
    "@/storage/database/supabase-client": { getSupabaseAdminClient: () => ({
      from: (name) => {
        assert.ok(tables.has(name));
        const query = {
          select() { return query; }, eq() { return query; }, lte() { return query; },
          order() { return query; }, limit() { return query; }, in() { return query; },
          then(resolve) {
            webQueries += 1;
            return Promise.resolve({ data: webRows[name], error: null }).then(resolve);
          },
        };
        return query;
      },
    }) },
  });
  async function probeWeb(rows) {
    webRows = structuredClone(rows);
    // The Web diagnostic includes evidence; the controller deliberately reads
    // only six metadata fields. These fixtures satisfy evidence for the same 17.
    for (const row of webRows.video_channel_health) {
      row.verification_evidence = { evidence_id: "fixture-evidence", task_id: "fixture-task" };
    }
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => assert.fail("Web reference readiness cannot make a real network or provider request");
    try {
      return await webModule.probeProductionReferenceDataReadiness();
    } finally {
      globalThis.fetch = previousFetch;
    }
  }

  const partialRows = fixtures();
  const partial = await probeCreator(partialRows);
  assert.deepEqual([partial.activeVideoModel, partial.verifiedVideoHealth, partial.unverifiedVideoHealth], [38, 17, 21]);
  assert.equal(partialRows.video_channel_health.filter((row) => !row.is_healthy).length, 17);
  assert.equal(partialRows.video_channel_health.filter((row) => row.is_healthy && row.verification_state !== "verified").length, 4);
  const webPartial = await probeWeb(partialRows);
  assert.equal(webPartial.ok, true);
  assert.equal(webPartial.videoModelVerificationReady, false);
  assert.deepEqual([webPartial.activeVideoModelCount, webPartial.verifiedVideoModelCount, webPartial.unverifiedVideoModelIds.length], [38, 17, 21]);
  const zeroRows = fixtures();
  zeroRows.video_channel_health.forEach((row) => { row.is_healthy = false; });
  const zero = await probeCreator(zeroRows);
  assert.deepEqual([zero.activeVideoModel, zero.verifiedVideoHealth, zero.unverifiedVideoHealth], [38, 0, 38]);
  const webZero = await probeWeb(zeroRows);
  assert.equal(webZero.ok, true);
  assert.equal(webZero.verifiedVideoModelCount, 0);
  const missingHealthRows = fixtures();
  missingHealthRows.video_channel_health = [];
  const missingHealth = await probeCreator(missingHealthRows);
  assert.deepEqual([missingHealth.verifiedVideoHealth, missingHealth.unverifiedVideoHealth], [0, 38]);

  const baseFailures = [
    ["voice missing", (rows) => { rows.voice_nest_price_versions = []; }, "REFERENCE_VOICE_PRICE_NOT_READY"],
    ["manju pointer missing", (rows) => { rows.manju_config_active.pop(); }, "REFERENCE_MANJU_ACTIVE_NOT_READY"],
    ["manju binding wrong", (rows) => { rows.manju_config_releases[0].etag = "wrong"; }, "REFERENCE_MANJU_BINDING_NOT_READY"],
    ["manju native storage missing", (rows) => { rows.manju_config_storage_state.pop(); }, "REFERENCE_MANJU_BINDING_NOT_READY"],
    ["empty active catalog", (rows) => { rows.video_models = []; }, "REFERENCE_VIDEO_MODEL_NOT_READY"],
  ];
  for (const [label, mutate, code] of baseFailures) {
    const rows = fixtures(); mutate(rows);
    await assert.rejects(() => probeCreator(rows), (error) => error?.code === code, label);
    assert.equal((await probeWeb(rows)).ok, false, `Web must retain the same required boundary: ${label}`);
  }
  const integrityFailures = [
    ["duplicate active identity", (rows) => { rows.video_models.push(rows.video_models[0]); }, "REFERENCE_VIDEO_MODEL_COUNT_NOT_READY"],
    ["duplicate health identity", (rows) => { rows.video_channel_health.push(rows.video_channel_health[0]); }, "REFERENCE_VIDEO_HEALTH_COUNT_NOT_READY"],
    ["unselected response field", (rows) => { rows.video_models[0].extra = true; }, "REFERENCE_RESPONSE_UNSELECTED_FIELD_PRESENT"],
    ["nested secret response field", (rows) => { rows.video_models[0].model_name = { token: "fixture-only" }; }, "REFERENCE_RESPONSE_SECRET_FIELD_PRESENT"],
    ["reference result limit", (rows) => { rows.video_models = Array.from({ length: tables.get("video_models").limit }, () => rows.video_models[0]); }, "REFERENCE_RESULT_LIMIT_REACHED"],
  ];
  for (const [label, mutate, code] of integrityFailures) {
    const rows = fixtures(); mutate(rows);
    await assert.rejects(() => probeCreator(rows), (error) => error?.code === code, label);
  }

  const nowEpoch = Date.parse(nowIso) / 1000;
  const binding = {
    releaseId: "web-reference-offline-fixture", artifactSha256: "a".repeat(64), commitSha: "b".repeat(40),
    sourceVersion: "R999999-offline-fixture", buildId: "offline-build", databaseFingerprint: "c".repeat(64),
    databaseContractSha256: sha256File(databasePath), referenceContractSha256: sha256File(referencePath),
    migrationManifestSha256: "d".repeat(64), receiptSchemaSha256: sha256File(schemaPath),
    verifierSha256: sha256File(path.join(process.cwd(), "scripts/verify-production-preflight-receipt.mjs")),
  };
  const expectedDatabase = {
    contractId: database.contractId, contractVersion: database.contractVersion, tableCount: database.tables.length,
    rpcCount: database.rpcs.length, referenceContractId: reference.contractId,
  };
  const payload = {
    schemaVersion: "zimeiti-production-preflight-receipt.v1", status: "passed",
    receiptId: "preflight-20990101T000000Z-0123456789abcdef", issuedAtEpoch: nowEpoch, expiresAtEpoch: nowEpoch + 300, ttlSeconds: 300,
    binding, database: { ...expectedDatabase, requiredProbeRole: "service_role", openApiProfile: "public", openApiSha256: "e".repeat(64), referenceCounts: partial },
    probe: { mode: "controller-get-only-postgrest.v1", methods: ["GET"], httpGetRequests: 8, openApiValidated: true, referenceDataValidated: true, apiKeyFieldSelected: false },
    counters: { databaseWrites: 0, rpcRequests: 0, providerRequests: 0, paidRequests: 0 },
  };
  const options = { key: "offline-reference-fixture-key-only-0123456789", keyId: "offline-reference-fixture", nowEpoch, expectedBinding: binding, expectedDatabase, referenceDomainCount: reference.manjuDomains.length };
  const sign = (value) => signReceiptPayload(value, options.key, options.keyId);
  for (const counts of [partial, zero, missingHealth]) {
    const value = structuredClone(payload); value.database.referenceCounts = counts;
    assert.equal(verifyProductionPreflightReceipt(sign(value), options).ok, true);
  }
  const countFailures = [
    ["negative verified", { verifiedVideoHealth: -1, unverifiedVideoHealth: 39 }, "REFERENCE_COUNT_INVALID"],
    ["negative unverified", { unverifiedVideoHealth: -1 }, "REFERENCE_COUNT_INVALID"],
    ["fractional count", { verifiedVideoHealth: 17.5 }, "REFERENCE_COUNT_INVALID"],
    ["verified above catalog", { verifiedVideoHealth: 39, unverifiedVideoHealth: 0 }, "REFERENCE_VIDEO_HEALTH_COUNT_INVALID"],
    ["unverified above catalog", { verifiedVideoHealth: 0, unverifiedVideoHealth: 39 }, "REFERENCE_VIDEO_HEALTH_COUNT_INVALID"],
    ["count sum mismatch", { unverifiedVideoHealth: 20 }, "REFERENCE_VIDEO_HEALTH_COUNT_INVALID"],
    ["empty catalog", { activeVideoModel: 0, verifiedVideoHealth: 0, unverifiedVideoHealth: 0 }, "REFERENCE_VIDEO_MODEL_NOT_READY"],
    ["missing voice", { voiceActivePrice: 0 }, "REFERENCE_VOICE_PRICE_NOT_READY"],
    ["missing manju", { manjuActive: 0 }, "REFERENCE_MANJUACTIVE_NOT_READY"],
  ];
  for (const [label, counts, code] of countFailures) {
    const value = structuredClone(payload); Object.assign(value.database.referenceCounts, counts);
    assert.throws(() => verifyProductionPreflightReceipt(sign(value), options), (error) => error?.code === code, label);
  }
  for (const name of Object.keys(binding)) {
    const expectedBinding = { ...binding, [name]: `${binding[name]}-mismatch` };
    assert.throws(() => verifyProductionPreflightReceipt(sign(payload), { ...options, expectedBinding }), (error) => error?.code === `BINDING_${name.toUpperCase()}_MISMATCH`, name);
  }
  for (const name of Object.keys(expectedDatabase)) {
    const wrongDatabase = { ...expectedDatabase, [name]: `${expectedDatabase[name]}-mismatch` };
    assert.throws(() => verifyProductionPreflightReceipt(sign(payload), { ...options, expectedDatabase: wrongDatabase }), (error) => error?.code === `DATABASE_${name.toUpperCase()}_MISMATCH`, name);
  }
  const wrongSignature = sign(payload);
  wrongSignature.attestation.signature = "f".repeat(64);
  assert.throws(() => verifyProductionPreflightReceipt(wrongSignature, options), (error) => error?.code === "ATTESTATION_SIGNATURE_INVALID");
  const countsSchema = schema.properties.database.properties.referenceCounts;
  assert.equal(countsSchema.additionalProperties, false);
  assert.deepEqual([...countsSchema.required].sort(), Object.keys(partial).sort());
  assert.equal(countsSchema.properties.verifiedVideoHealth.minimum, 0);
  assert.equal(countsSchema.properties.unverifiedVideoHealth.minimum, 0);
  return {
    partial: { active: 38, verifiedMetadata: 17, unverifiedMetadata: 21 },
    zeroVerifiedAllowed: true, missingHealthDiagnostic: true,
    baseFailureCases: baseFailures.length, integrityFailureCases: integrityFailures.length,
    signedCountFailureCases: countFailures.length, identityBindingCases: Object.keys(binding).length,
    databaseIdentityCases: Object.keys(expectedDatabase).length, signatureTamperRejected: true,
    actualWebReadinessCalls: baseFailures.length + 2, webQueries, interceptedGetRequests,
    realNetworkRequests: 0, providerRequests: 0, receiptWrites: 0,
    creatorSha256: sha256File(path.join(process.cwd(), "scripts/create-production-preflight-receipt.mjs")),
    referenceContractSha256: binding.referenceContractSha256, receiptSchemaSha256: binding.receiptSchemaSha256,
  };
}

const referenceHealthBoundary = await verifyReferenceHealthBoundary();

console.log(JSON.stringify({
  verifier: "release-readiness-profile-offline",
  passed: true,
  networkCalls: 0,
  productionWrites: 0,
  referenceHealthBoundary,
  candidate: {
    ready: candidate.response.body.ready,
    activationReady: candidate.response.body.activationReady,
    databaseProbeCalls: candidate.counters.database,
    referenceProbeCalls: candidate.counters.referenceData,
    databaseState: candidate.response.body.checks.database.state,
    referenceDataState: candidate.response.body.checks.referenceData.state,
  },
  production: {
    ready: production.response.body.ready,
    activationReady: production.response.body.activationReady,
    databaseProbeCalls: production.counters.database,
    referenceProbeCalls: production.counters.referenceData,
  },
}, null, 2));
