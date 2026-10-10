#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import realFs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

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
assert.equal(candidate.response.status, 200);
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
assert.equal(production.response.status, 200);
assert.equal(production.response.body.ready, true);
assert.equal(production.response.body.activationReady, true);
assert.equal(production.response.body.readinessProfile, "production-full-v1");
assert.deepEqual(production.counters, { database: 1, referenceData: 1 });
assert.equal(production.response.body.checks.database.state, "ready");
assert.equal(production.response.body.checks.referenceData.state, "ready");

const productionDefault = await runRoute(undefined);
assert.equal(productionDefault.response.status, 200);
assert.equal(productionDefault.response.body.readinessProfile, "production-full-v1");
assert.deepEqual(productionDefault.counters, { database: 1, referenceData: 1 });

const invalid = await runRoute("candidate-typo");
assert.equal(invalid.response.status, 503);
assert.equal(invalid.response.body.ready, false);
assert.equal(invalid.response.body.activationReady, false);
assert.deepEqual(invalid.counters, { database: 0, referenceData: 0 });
assert.match(invalid.response.body.error, /RELEASE_READINESS_PROFILE is invalid/u);

console.log(JSON.stringify({
  verifier: "release-readiness-profile-offline",
  passed: true,
  networkCalls: 0,
  productionWrites: 0,
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
