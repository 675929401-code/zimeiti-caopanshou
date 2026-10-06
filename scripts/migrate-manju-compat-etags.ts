import { createHash } from "node:crypto";
import { config as loadEnv } from "dotenv";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MANJU_CONFIG_DOMAINS,
  MANJU_CONFIG_ENVIRONMENTS,
  isUuid,
  validateManjuConfigPayload,
  validateManjuDomainContract,
  type ManjuConfigDomain,
  type ManjuConfigEnvironment,
} from "../src/lib/server/manju-runtime-config";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

loadEnv({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const CONFIRMED_TARGET_HOST = process.argv
  .find((argument) => argument.startsWith("--confirm-target-host="))
  ?.slice("--confirm-target-host=".length)
  .trim()
  .toLowerCase() ?? "";
const KEY_PREFIX = "manju.config.v1";
const FORMAT = "manju-platform-settings-v1";
const NEW_ETAG = /^[0-9a-f]{64}:[1-9][0-9]*$/u;
const LEGACY_ETAG = /^"manju-([0-9a-f]{64})"$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_HOST_SUFFIX = ".aidap-global.cn-beijing.volces.com";
const NATIVE_CONTROL_PLANE_TABLES = [
  "manju_config_revisions",
  "manju_config_releases",
  "manju_config_active",
  "manju_config_audit",
] as const;

type JsonObject = Record<string, unknown>;
type StorageBackend =
  | { kind: "state-table"; state: "compat"; generation: number }
  | { kind: "legacy" };
type PlanAction = "absent" | "current" | "migrate";

interface StorageStateRow {
  environment: ManjuConfigEnvironment;
  domain: ManjuConfigDomain;
  state: string;
  generation: number;
  compat_setting_key: string;
}

interface LoadedSetting {
  settingKey: string;
  storageRevision: string;
  envelope: JsonObject;
}

interface EnvelopeAnalysis {
  releaseCount: number;
  legacyEtagCount: number;
  activePayloadHash: string | null;
  preservationHash: string;
}

interface PreparedScope {
  environment: ManjuConfigEnvironment;
  domain: ManjuConfigDomain;
  settingKey: string;
  backend: StorageBackend;
  action: PlanAction;
  source: LoadedSetting | null;
  migratedEnvelope: JsonObject | null;
  analysis: EnvelopeAnalysis | null;
}

interface DatabaseErrorLike {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
}

function fail(code: string, scope?: string): never {
  throw new Error(scope ? `${code}:${scope}` : code);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, code: string, scope: string): JsonObject {
  if (!isObject(value)) fail(code, scope);
  return value;
}

function requireString(value: unknown, code: string, scope: string): string {
  if (typeof value !== "string" || value.length === 0) fail(code, scope);
  return value;
}

function requireNullableUuid(value: unknown, code: string, scope: string): string | null {
  if (value === null) return null;
  const parsed = requireString(value, code, scope);
  if (!isUuid(parsed)) fail(code, scope);
  return parsed;
}

function requireTimestamp(value: unknown, code: string, scope: string): string {
  const parsed = requireString(value, code, scope);
  if (Number.isNaN(Date.parse(parsed))) fail(code, scope);
  return parsed;
}

function requireNullableActor(value: unknown, code: string, scope: string): string | null {
  if (value === null) return null;
  const actor = requireString(value, code, scope);
  if (actor.trim() !== actor || actor.length > 128) fail(code, scope);
  return actor;
}

function settingKey(environment: ManjuConfigEnvironment, domain: ManjuConfigDomain): string {
  return `${KEY_PREFIX}.${environment}.${domain}`;
}

function scopeName(environment: ManjuConfigEnvironment, domain: ManjuConfigDomain): string {
  return `${environment}/${domain}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value as JsonObject)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function databaseErrorText(error: DatabaseErrorLike): string {
  return [error.code, error.message, error.details, error.hint]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
}

function isMissingRelation(error: DatabaseErrorLike | null, relation: string): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code.toUpperCase() : "";
  const text = databaseErrorText(error);
  return (
    (code === "42P01" || code === "PGRST205")
    && text.includes(relation.toLowerCase())
    && (text.includes("does not exist") || text.includes("schema cache") || text.includes("could not find"))
  );
}

function protectedTarget(): { host: string } {
  const rawUrl = process.env.COZE_SUPABASE_URL?.trim() ?? "";
  const serviceRoleKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!rawUrl || !serviceRoleKey) fail("MANJU_ETAG_MIGRATION_SERVICE_ROLE_NOT_CONFIGURED");

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    fail("MANJU_ETAG_MIGRATION_TARGET_URL_INVALID");
  }
  const host = target.hostname.toLowerCase();
  if (target.protocol !== "https:" || !host.endsWith(SAFE_HOST_SUFFIX)) {
    fail("MANJU_ETAG_MIGRATION_TARGET_HOST_REJECTED", host || "<empty>");
  }

  const segments = serviceRoleKey.split(".");
  if (segments.length !== 3) fail("MANJU_ETAG_MIGRATION_SERVICE_ROLE_TOKEN_INVALID");
  try {
    const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as JsonObject;
    if (claims.role !== "service_role") fail("MANJU_ETAG_MIGRATION_SERVICE_ROLE_REQUIRED");
  } catch (error) {
    if (error instanceof Error && error.message === "MANJU_ETAG_MIGRATION_SERVICE_ROLE_REQUIRED") throw error;
    fail("MANJU_ETAG_MIGRATION_SERVICE_ROLE_TOKEN_INVALID");
  }

  if (CONFIRMED_TARGET_HOST && CONFIRMED_TARGET_HOST !== host) {
    fail("MANJU_ETAG_MIGRATION_TARGET_CONFIRMATION_MISMATCH", host);
  }
  if (APPLY && CONFIRMED_TARGET_HOST !== host) {
    fail("MANJU_ETAG_MIGRATION_TARGET_CONFIRMATION_REQUIRED", `--confirm-target-host=${host}`);
  }
  return { host };
}

function validateArguments(): void {
  const allowed = process.argv.slice(2).every((argument) => (
    argument === "--apply" || argument.startsWith("--confirm-target-host=")
  ));
  if (!allowed) fail("MANJU_ETAG_MIGRATION_ARGUMENT_REJECTED");
}

function validateRevision(
  value: unknown,
  environment: ManjuConfigEnvironment,
  domain: ManjuConfigDomain,
  scope: string,
): JsonObject {
  const revision = asObject(value, "REVISION_OBJECT_REQUIRED", scope);
  const id = requireString(revision.id, "REVISION_ID_INVALID", scope);
  if (!isUuid(id)) fail("REVISION_ID_INVALID", scope);
  if (revision.environment !== environment || revision.domain !== domain) {
    fail("REVISION_SCOPE_MISMATCH", scope);
  }
  if (!Number.isSafeInteger(revision.version) || Number(revision.version) < 1) {
    fail("REVISION_VERSION_INVALID", scope);
  }
  if (!(["draft", "published", "superseded"] as unknown[]).includes(revision.status)) {
    fail("REVISION_STATUS_INVALID", scope);
  }
  const payloadHash = requireString(revision.payload_hash, "REVISION_PAYLOAD_HASH_INVALID", scope);
  if (!HEX_64.test(payloadHash)) fail("REVISION_PAYLOAD_HASH_INVALID", scope);
  const validated = validateManjuConfigPayload(revision.payload);
  validateManjuDomainContract(domain, validated.payload, String(revision.schema_version));
  if (validated.payloadHash !== payloadHash) fail("REVISION_PAYLOAD_HASH_MISMATCH", scope);
  const schemaVersion = requireString(revision.schema_version, "REVISION_SCHEMA_VERSION_INVALID", scope);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u.test(schemaVersion)) {
    fail("REVISION_SCHEMA_VERSION_INVALID", scope);
  }
  requireNullableUuid(revision.parent_revision_id, "REVISION_PARENT_ID_INVALID", scope);
  requireNullableActor(revision.created_by, "REVISION_ACTOR_INVALID", scope);
  requireTimestamp(revision.created_at, "REVISION_CREATED_AT_INVALID", scope);
  requireTimestamp(revision.updated_at, "REVISION_UPDATED_AT_INVALID", scope);
  if (revision.published_at !== null) {
    requireTimestamp(revision.published_at, "REVISION_PUBLISHED_AT_INVALID", scope);
  }
  return revision;
}

function validateRelease(
  value: unknown,
  revision: JsonObject,
  environment: ManjuConfigEnvironment,
  domain: ManjuConfigDomain,
  scope: string,
): { release: JsonObject; legacy: boolean; expectedEtag: string } {
  const release = asObject(value, "RELEASE_OBJECT_REQUIRED", scope);
  const id = requireString(release.id, "RELEASE_ID_INVALID", scope);
  if (!isUuid(id)) fail("RELEASE_ID_INVALID", scope);
  if (release.environment !== environment || release.domain !== domain) {
    fail("RELEASE_SCOPE_MISMATCH", scope);
  }
  if (!Number.isSafeInteger(release.release_number) || Number(release.release_number) < 1) {
    fail("RELEASE_NUMBER_INVALID", scope);
  }
  if (release.revision_id !== revision.id) fail("RELEASE_REVISION_MISMATCH", scope);
  requireNullableUuid(release.previous_release_id, "RELEASE_PREVIOUS_ID_INVALID", scope);
  if (release.release_kind !== "publish" && release.release_kind !== "rollback") {
    fail("RELEASE_KIND_INVALID", scope);
  }
  const rollbackId = requireNullableUuid(release.rollback_of_release_id, "RELEASE_ROLLBACK_ID_INVALID", scope);
  if ((release.release_kind === "publish" && rollbackId !== null)
      || (release.release_kind === "rollback" && rollbackId === null)) {
    fail("RELEASE_ROLLBACK_RELATION_INVALID", scope);
  }
  requireNullableActor(release.released_by, "RELEASE_ACTOR_INVALID", scope);
  requireTimestamp(release.created_at, "RELEASE_CREATED_AT_INVALID", scope);

  const payloadHash = requireString(revision.payload_hash, "REVISION_PAYLOAD_HASH_INVALID", scope);
  const expectedEtag = `${payloadHash}:${release.release_number}`;
  const etag = requireString(release.etag, "RELEASE_ETAG_INVALID", scope);
  if (NEW_ETAG.test(etag)) {
    if (etag !== expectedEtag) fail("RELEASE_ETAG_RELATION_INVALID", scope);
    return { release, legacy: false, expectedEtag };
  }
  const legacy = LEGACY_ETAG.exec(etag);
  if (!legacy || legacy[1] !== payloadHash) fail("RELEASE_ETAG_FORMAT_OR_HASH_INVALID", scope);
  return { release, legacy: true, expectedEtag };
}

function normalizeForPreservation(envelope: JsonObject): JsonObject {
  const normalized = cloneJson(envelope);
  normalized.updated_at = "<storage-revision>";
  if (isObject(normalized.active)) {
    if (isObject(normalized.active.pointer)) normalized.active.pointer.etag = "<release-etag>";
    if (isObject(normalized.active.release)) normalized.active.release.etag = "<release-etag>";
  }
  if (Array.isArray(normalized.history)) {
    for (const entry of normalized.history) {
      if (isObject(entry) && isObject(entry.release)) entry.release.etag = "<release-etag>";
    }
  }
  return normalized;
}

function analyzeEnvelope(
  envelope: JsonObject,
  environment: ManjuConfigEnvironment,
  domain: ManjuConfigDomain,
  mutateLegacyEtags: boolean,
): EnvelopeAnalysis {
  const scope = scopeName(environment, domain);
  if (envelope.format !== FORMAT || envelope.environment !== environment || envelope.domain !== domain) {
    fail("ENVELOPE_FORMAT_OR_SCOPE_INVALID", scope);
  }
  requireTimestamp(envelope.updated_at, "ENVELOPE_UPDATED_AT_INVALID", scope);
  if (!Array.isArray(envelope.drafts) || !Array.isArray(envelope.history)) {
    fail("ENVELOPE_COLLECTIONS_INVALID", scope);
  }

  const revisionIds = new Set<string>();
  const versions = new Set<number>();
  for (const [index, rawDraft] of envelope.drafts.entries()) {
    const draftScope = `${scope}/draft/${index}`;
    const draft = validateRevision(rawDraft, environment, domain, draftScope);
    if (draft.status !== "draft" || draft.published_at !== null) fail("DRAFT_STATE_INVALID", draftScope);
    if (revisionIds.has(String(draft.id)) || versions.has(Number(draft.version))) {
      fail("REVISION_ID_OR_VERSION_DUPLICATED", draftScope);
    }
    revisionIds.add(String(draft.id));
    versions.add(Number(draft.version));
  }

  let legacyEtagCount = 0;
  const historyValues = envelope.history;
  const releaseIds = new Set<string>();
  const releaseNumbers = new Set<number>();
  const history = historyValues.map((rawEntry, index) => {
    const entryScope = `${scope}/history/${index}`;
    const entry = asObject(rawEntry, "HISTORY_ENTRY_INVALID", entryScope);
    const revision = validateRevision(entry.revision, environment, domain, entryScope);
    if (revision.status === "draft" || revision.published_at === null) {
      fail("HISTORY_REVISION_STATE_INVALID", entryScope);
    }
    if (revisionIds.has(String(revision.id)) || versions.has(Number(revision.version))) {
      fail("REVISION_ID_OR_VERSION_DUPLICATED", entryScope);
    }
    revisionIds.add(String(revision.id));
    versions.add(Number(revision.version));
    const validatedRelease = validateRelease(entry.release, revision, environment, domain, entryScope);
    const releaseId = String(validatedRelease.release.id);
    const releaseNumber = Number(validatedRelease.release.release_number);
    if (releaseIds.has(releaseId) || releaseNumbers.has(releaseNumber)) {
      fail("RELEASE_ID_OR_NUMBER_DUPLICATED", entryScope);
    }
    releaseIds.add(releaseId);
    releaseNumbers.add(releaseNumber);
    if (index > 0) {
      const previous = asObject(historyValues[index - 1], "HISTORY_ENTRY_INVALID", entryScope);
      const previousRelease = asObject(previous.release, "RELEASE_OBJECT_REQUIRED", entryScope);
      if (previousRelease.previous_release_id !== validatedRelease.release.id) {
        fail("RELEASE_HISTORY_CHAIN_INVALID", entryScope);
      }
      if (Number(previousRelease.release_number) <= releaseNumber) {
        fail("RELEASE_HISTORY_ORDER_INVALID", entryScope);
      }
    }
    if (validatedRelease.legacy) {
      legacyEtagCount += 1;
      if (mutateLegacyEtags) validatedRelease.release.etag = validatedRelease.expectedEtag;
    }
    return { entry, revision, ...validatedRelease };
  });

  let activePayloadHash: string | null = null;
  if (envelope.active === null) {
    if (history.length > 0) fail("ACTIVE_MISSING_WITH_HISTORY", scope);
  } else {
    const active = asObject(envelope.active, "ACTIVE_OBJECT_REQUIRED", scope);
    const pointer = asObject(active.pointer, "ACTIVE_POINTER_INVALID", scope);
    const revision = validateRevision(active.revision, environment, domain, `${scope}/active`);
    if (revision.status !== "published" || revision.published_at === null) {
      fail("ACTIVE_REVISION_STATE_INVALID", scope);
    }
    const validatedRelease = validateRelease(active.release, revision, environment, domain, `${scope}/active`);
    if (pointer.environment !== environment || pointer.domain !== domain) fail("ACTIVE_POINTER_SCOPE_INVALID", scope);
    if (pointer.active_release_id !== validatedRelease.release.id
        || pointer.active_revision_id !== revision.id
        || pointer.etag !== validatedRelease.release.etag) {
      fail("ACTIVE_POINTER_RELATION_INVALID", scope);
    }
    requireNullableActor(pointer.updated_by, "ACTIVE_POINTER_ACTOR_INVALID", scope);
    requireTimestamp(pointer.updated_at, "ACTIVE_POINTER_UPDATED_AT_INVALID", scope);
    if (validatedRelease.legacy && mutateLegacyEtags) {
      validatedRelease.release.etag = validatedRelease.expectedEtag;
      pointer.etag = validatedRelease.expectedEtag;
    }
    if (history.length === 0
        || stableJson(history[0].release) !== stableJson(validatedRelease.release)
        || stableJson(history[0].revision) !== stableJson(revision)) {
      fail("ACTIVE_HISTORY_RELATION_INVALID", scope);
    }
    activePayloadHash = String(revision.payload_hash);
  }

  return {
    releaseCount: history.length,
    legacyEtagCount,
    activePayloadHash,
    preservationHash: sha256(normalizeForPreservation(envelope)),
  };
}

async function probeStateTable(database: SupabaseClient): Promise<"present" | "missing"> {
  const result = await database.from("manju_config_storage_state").select("environment").limit(1);
  if (!result.error) return "present";
  if (isMissingRelation(result.error, "manju_config_storage_state")) return "missing";
  fail("MANJU_ETAG_MIGRATION_STORAGE_STATE_PROBE_FAILED");
}

async function assertNativeControlPlaneAbsent(database: SupabaseClient): Promise<void> {
  for (const table of NATIVE_CONTROL_PLANE_TABLES) {
    const result = await database.from(table).select("*").limit(1);
    if (!result.error) fail("MANJU_ETAG_MIGRATION_LEGACY_DIRECT_BLOCKED_NATIVE_CONTROL_PLANE", table);
    if (!isMissingRelation(result.error, table)) {
      fail("MANJU_ETAG_MIGRATION_NATIVE_CONTROL_PLANE_PROBE_FAILED", table);
    }
  }
}

async function loadStorageState(
  database: SupabaseClient,
  environment: ManjuConfigEnvironment,
  domain: ManjuConfigDomain,
): Promise<StorageBackend> {
  const scope = scopeName(environment, domain);
  const key = settingKey(environment, domain);
  const result = await database
    .from("manju_config_storage_state")
    .select("environment,domain,state,generation,compat_setting_key")
    .eq("environment", environment)
    .eq("domain", domain)
    .maybeSingle();
  if (result.error) fail("MANJU_ETAG_MIGRATION_STORAGE_STATE_READ_FAILED", scope);
  if (!result.data) fail("MANJU_ETAG_MIGRATION_STORAGE_STATE_MISSING", scope);
  const row = result.data as StorageStateRow;
  if (row.environment !== environment || row.domain !== domain || row.compat_setting_key !== key) {
    fail("MANJU_ETAG_MIGRATION_STORAGE_STATE_SCOPE_INVALID", scope);
  }
  if (row.state !== "compat") fail("MANJU_ETAG_MIGRATION_STORAGE_STATE_NOT_COMPAT", scope);
  if (!Number.isSafeInteger(row.generation) || row.generation < 1) {
    fail("MANJU_ETAG_MIGRATION_STORAGE_GENERATION_INVALID", scope);
  }
  return { kind: "state-table", state: "compat", generation: row.generation };
}

async function loadSetting(
  database: SupabaseClient,
  environment: ManjuConfigEnvironment,
  domain: ManjuConfigDomain,
): Promise<LoadedSetting | null> {
  const key = settingKey(environment, domain);
  const scope = scopeName(environment, domain);
  const result = await database
    .from("platform_settings")
    .select("setting_key,setting_value,updated_at")
    .eq("setting_key", key)
    .maybeSingle();
  if (result.error) fail("MANJU_ETAG_MIGRATION_COMPAT_READ_FAILED", scope);
  if (!result.data) return null;
  if (result.data.setting_key !== key) fail("MANJU_ETAG_MIGRATION_COMPAT_SCOPE_INVALID", scope);
  const storageRevision = requireTimestamp(
    result.data.updated_at,
    "MANJU_ETAG_MIGRATION_STORAGE_REVISION_INVALID",
    scope,
  );
  if (typeof result.data.setting_value !== "string") {
    fail("MANJU_ETAG_MIGRATION_COMPAT_VALUE_INVALID", scope);
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.data.setting_value);
  } catch {
    fail("MANJU_ETAG_MIGRATION_COMPAT_JSON_INVALID", scope);
  }
  return { settingKey: key, storageRevision, envelope: asObject(envelope, "ENVELOPE_OBJECT_REQUIRED", scope) };
}

async function buildPlan(database: SupabaseClient): Promise<PreparedScope[]> {
  const stateTable = await probeStateTable(database);
  if (stateTable === "missing") await assertNativeControlPlaneAbsent(database);

  const prepared: PreparedScope[] = [];
  for (const environment of MANJU_CONFIG_ENVIRONMENTS) {
    for (const domain of MANJU_CONFIG_DOMAINS) {
      const backend: StorageBackend = stateTable === "present"
        ? await loadStorageState(database, environment, domain)
        : { kind: "legacy" };
      const source = await loadSetting(database, environment, domain);
      if (!source) {
        prepared.push({
          environment,
          domain,
          settingKey: settingKey(environment, domain),
          backend,
          action: "absent",
          source: null,
          migratedEnvelope: null,
          analysis: null,
        });
        continue;
      }

      const analysis = analyzeEnvelope(source.envelope, environment, domain, false);
      const migratedEnvelope = cloneJson(source.envelope);
      const migratedAnalysis = analyzeEnvelope(migratedEnvelope, environment, domain, true);
      if (analysis.preservationHash !== migratedAnalysis.preservationHash) {
        fail("MANJU_ETAG_MIGRATION_PRESERVATION_GUARD_FAILED", scopeName(environment, domain));
      }
      prepared.push({
        environment,
        domain,
        settingKey: source.settingKey,
        backend,
        action: analysis.legacyEtagCount > 0 ? "migrate" : "current",
        source,
        migratedEnvelope,
        analysis,
      });
    }
  }
  return prepared;
}

async function applyStateTableMigration(database: SupabaseClient, item: PreparedScope): Promise<string> {
  if (item.backend.kind !== "state-table" || !item.source || !item.migratedEnvelope) {
    fail("MANJU_ETAG_MIGRATION_INTERNAL_STATE_INVALID", scopeName(item.environment, item.domain));
  }
  if (!Number.isSafeInteger(item.backend.generation) || item.backend.generation < 1) {
    fail("MANJU_ETAG_MIGRATION_STORAGE_GENERATION_INVALID", scopeName(item.environment, item.domain));
  }
  const result = await database.rpc("commit_manju_config_compat_envelope", {
    p_environment: item.environment,
    p_domain: item.domain,
    p_expected_generation: item.backend.generation,
    p_expected_storage_revision: item.source.storageRevision,
    p_envelope: item.migratedEnvelope,
  });
  if (result.error) fail("MANJU_ETAG_MIGRATION_ATOMIC_COMMIT_FAILED", scopeName(item.environment, item.domain));
  const response = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!isObject(response)
      || response.ok !== true
      || response.environment !== item.environment
      || response.domain !== item.domain
      || response.storage_mode !== "compat"
      || response.storage_generation !== item.backend.generation) {
    fail("MANJU_ETAG_MIGRATION_ATOMIC_COMMIT_RESPONSE_INVALID", scopeName(item.environment, item.domain));
  }
  return requireTimestamp(
    response.storage_revision,
    "MANJU_ETAG_MIGRATION_ATOMIC_STORAGE_REVISION_INVALID",
    scopeName(item.environment, item.domain),
  );
}

async function verifyAppliedScope(database: SupabaseClient, item: PreparedScope): Promise<void> {
  if (!item.analysis) fail("MANJU_ETAG_MIGRATION_INTERNAL_ANALYSIS_MISSING");
  const reloaded = await loadSetting(database, item.environment, item.domain);
  if (!reloaded) fail("MANJU_ETAG_MIGRATION_POSTCOMMIT_ROW_MISSING", scopeName(item.environment, item.domain));
  const analysis = analyzeEnvelope(reloaded.envelope, item.environment, item.domain, false);
  if (analysis.legacyEtagCount !== 0
      || analysis.releaseCount !== item.analysis.releaseCount
      || analysis.activePayloadHash !== item.analysis.activePayloadHash
      || analysis.preservationHash !== item.analysis.preservationHash) {
    fail("MANJU_ETAG_MIGRATION_POSTCOMMIT_VERIFICATION_FAILED", scopeName(item.environment, item.domain));
  }
}

function publicPlan(item: PreparedScope): JsonObject {
  return {
    environment: item.environment,
    domain: item.domain,
    setting_key: item.settingKey,
    storage: item.backend.kind,
    storage_generation: item.backend.kind === "state-table" ? item.backend.generation : null,
    action: item.action,
    release_count: item.analysis?.releaseCount ?? 0,
    legacy_etags_to_migrate: item.analysis?.legacyEtagCount ?? 0,
    active_payload_hash: item.analysis?.activePayloadHash ?? null,
    preservation_hash: item.analysis?.preservationHash ?? null,
  };
}

async function main(): Promise<void> {
  validateArguments();
  const { host } = protectedTarget();
  const database = getSupabaseAdminClient() as SupabaseClient;
  const prepared = await buildPlan(database);
  const migrationCount = prepared.filter((item) => item.action === "migrate").length;

  console.log(JSON.stringify({
    ok: true,
    mode: APPLY ? "apply" : "plan",
    target_host: host,
    scope_count: prepared.length,
    migration_scope_count: migrationCount,
    apply_command_requires: `--apply --confirm-target-host=${host}`,
    plan: prepared.map(publicPlan),
  }, null, 2));
  if (!APPLY) return;
  if (prepared.some((item) => item.backend.kind === "legacy")) {
    fail(
      "MANJU_ETAG_MIGRATION_STORAGE_STATE_MIGRATION_REQUIRED",
      "apply supabase/migrations/20260829223000_manju_config_storage_state.sql before --apply",
    );
  }

  const applied: JsonObject[] = [];
  for (const item of prepared) {
    if (item.action !== "migrate") {
      applied.push({ environment: item.environment, domain: item.domain, result: item.action });
      continue;
    }
    const storageRevision = await applyStateTableMigration(database, item);
    await verifyAppliedScope(database, item);
    applied.push({
      environment: item.environment,
      domain: item.domain,
      result: "migrated",
      migrated_release_etags: item.analysis?.legacyEtagCount ?? 0,
      storage_revision: storageRevision,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    mode: "apply-result",
    target_host: host,
    migrated_scope_count: migrationCount,
    results: applied,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "MANJU_ETAG_MIGRATION_UNKNOWN_FAILURE");
  process.exitCode = 1;
});
