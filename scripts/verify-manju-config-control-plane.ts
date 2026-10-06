import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const root = process.cwd();
const checks: Check[] = [];

function add(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function source(relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  add(`file:${relativePath}`, existsSync(absolutePath), existsSync(absolutePath) ? "present" : "missing");
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
}

function includesAll(name: string, text: string, tokens: string[]) {
  const missing = tokens.filter((token) => !text.includes(token));
  add(name, missing.length === 0, missing.length === 0 ? "all contract tokens present" : `missing: ${missing.join(", ")}`);
}

function excludesAll(name: string, text: string, tokens: string[]) {
  const present = tokens.filter((token) => text.includes(token));
  add(name, present.length === 0, present.length === 0 ? "retired contract tokens absent" : `present: ${present.join(", ")}`);
}

const migrationPath = "supabase/migrations/20260825123000_manju_config_control_plane.sql";
const rollbackPath = "supabase/rollbacks/20260825123000_manju_config_control_plane.rollback.sql";
const actorMigrationPath = "supabase/migrations/20260829220000_manju_config_actor_text.sql";
const actorRollbackPath = "supabase/rollbacks/20260829220000_manju_config_actor_text.rollback.sql";
const storageMigrationPath = "supabase/migrations/20260829223000_manju_config_storage_state.sql";
const storageRollbackPath = "supabase/rollbacks/20260829223000_manju_config_storage_state.rollback.sql";
const serverPath = "src/lib/server/manju-runtime-config.ts";
const compatStorePath = "src/lib/server/manju-platform-settings-store.ts";
const adminRoutePath = "src/app/api/admin/manju-config/route.ts";
const publicRoutePath = "src/app/api/youcai/runtime-config/route.ts";
const publishedPromptPath = "src/lib/server/manju-published-prompt.ts";
const llmRoutePath = "src/app/api/llm/route.ts";
const reservedSettingsPath = "src/lib/server/platform-settings-reserved.ts";
const settingsRoutePath = "src/app/api/settings/route.ts";
const syncImportPath = "src/app/api/admin/sync/import/route.ts";
const syncExportPath = "src/app/api/admin/sync/export/route.ts";
const centerPath = "src/components/admin/ManjuConfigCenter.tsx";
const tabPath = "src/components/admin/ManjuWorkbenchAdminTab.tsx";
const deploymentStandardPath = "docs/deployment/DEPLOYMENT-STANDARD-vNext.md";
const productionSeedPath = "scripts/seed-manju-production-config.ts";

const migration = source(migrationPath);
const rollback = source(rollbackPath);
const actorMigration = source(actorMigrationPath);
const actorRollback = source(actorRollbackPath);
const storageMigration = source(storageMigrationPath);
const storageRollback = source(storageRollbackPath);
const server = source(serverPath);
const compatStore = source(compatStorePath);
const adminRoute = source(adminRoutePath);
const publicRoute = source(publicRoutePath);
const publishedPrompt = source(publishedPromptPath);
const llmRoute = source(llmRoutePath);
const reservedSettings = source(reservedSettingsPath);
const settingsRoute = source(settingsRoutePath);
const syncImport = source(syncImportPath);
const syncExport = source(syncExportPath);
const center = source(centerPath);
const tab = source(tabPath);
const deploymentStandard = source(deploymentStandardPath);
const productionSeed = source(productionSeedPath);

const domains = ["prompt", "skill", "agent", "workflow", "content", "media", "feature_flags", "model_policy", "ui"];
const environments = ["production", "staging", "development"];

includesAll("migration:tables", migration, [
  "manju_config_revisions",
  "manju_config_releases",
  "manju_config_active",
  "manju_config_audit",
]);
includesAll("migration:domains", migration, domains);
includesAll("migration:environments", migration, environments);
includesAll("migration:rpc-and-security", migration, [
  "save_manju_config_draft",
  "publish_manju_config_revision",
  "rollback_manju_config_release",
  "SECURITY DEFINER",
  "ENABLE ROW LEVEL SECURITY",
  "service_role",
  "FOR UPDATE",
]);
includesAll("migration:persistent-storage-state", storageMigration, [
  "CREATE TABLE public.manju_config_storage_state",
  "state IN ('compat', 'migrating', 'native')",
  "generation bigint NOT NULL DEFAULT 1",
  "compat_setting_key = 'manju.config.v1.' || environment || '.' || domain",
  "MANJU_CONFIG_STORAGE_STATE_DOWNGRADE_FORBIDDEN",
  "MANJU_CONFIG_STORAGE_GENERATION_INVALID",
  "CREATE TRIGGER manju_config_storage_state_guard",
]);
includesAll("migration:orphan-native-scope-fails-closed", storageMigration, [
  "MANJU_CONFIG_STORAGE_NATIVE_SCOPE_WITHOUT_ACTIVE_REQUIRES_RECONCILIATION",
  "LOCK TABLE public.manju_config_revisions, public.manju_config_active",
  "IN SHARE ROW EXCLUSIVE MODE",
  "FROM public.manju_config_revisions AS revisions",
  "FROM public.manju_config_active AS active",
  "WHERE NOT EXISTS",
  "USING ERRCODE = '55000'",
]);
includesAll("migration:atomic-cutover-evidence", storageMigration, [
  "CREATE FUNCTION public.cutover_manju_config_storage",
  "PERFORM pg_advisory_xact_lock",
  "p_expected_generation",
  "p_expected_compat_storage_revision",
  "p_expected_compat_payload_hash",
  "p_expected_native_payload_hash",
  "compat_payload_hash = native_payload_hash",
  "generation = generation + 1",
  "'action', 'cutover'",
]);
includesAll("migration:compat-reconcile-verifies-both-stores", storageMigration, [
  "CREATE FUNCTION public.reconcile_manju_config_storage_to_compat",
  "p_expected_native_active_release_id uuid",
  "p_expected_native_active_revision_id uuid",
  "p_expected_native_payload_hash text",
  "p_allow_payload_divergence boolean",
  "v_native_active public.manju_config_active%ROWTYPE",
  "v_native_release public.manju_config_releases%ROWTYPE",
  "v_native_revision public.manju_config_revisions%ROWTYPE",
  "MANJU_CONFIG_STORAGE_RECONCILE_DIVERGENCE_REQUIRES_APPROVAL",
  "v_compat #>> '{active,pointer,environment}' IS DISTINCT FROM v_environment",
  "v_compat #>> '{active,release,environment}' IS DISTINCT FROM v_environment",
  "v_compat #>> '{active,revision,environment}' IS DISTINCT FROM v_environment",
  "v_compat #>> '{active,release,release_kind}'",
  "v_compat #>> '{active,revision,schema_version}' IS DISTINCT FROM '1.1.0'",
  "v_compat #>> '{history,0,release,id}' IS DISTINCT FROM v_compat_release_id::text",
  "'compat_payload_hash', v_compat_payload_hash",
  "'native_payload_hash', v_native_revision.payload_hash",
  "'payload_diverged', v_payload_diverged",
  "'payload_divergence_accepted', v_payload_diverged AND p_allow_payload_divergence",
]);
add(
  "migration:compat-reconcile-service-role-signature",
  /REVOKE ALL ON FUNCTION public\.reconcile_manju_config_storage_to_compat\(\s*text, text, bigint, timestamptz, uuid, uuid, text, uuid, uuid, text, boolean, text\s*\)/m.test(
    storageMigration,
  ) &&
    /GRANT EXECUTE ON FUNCTION public\.reconcile_manju_config_storage_to_compat\(\s*text, text, bigint, timestamptz, uuid, uuid, text, uuid, uuid, text, boolean, text\s*\)/m.test(
      storageMigration,
    ),
  "the service-role grant/revoke resolves the exact two-store reconciliation signature",
);
const cutoverFunction = storageMigration.slice(
  storageMigration.indexOf("CREATE FUNCTION public.cutover_manju_config_storage"),
  storageMigration.indexOf("ALTER TABLE public.manju_config_storage_state ENABLE ROW LEVEL SECURITY"),
);
add(
  "migration:cutover-audits-real-previous-storage",
  cutoverFunction.includes("'previous_storage', v_state.state") &&
    !cutoverFunction.includes("'previous_storage', 'compat'"),
  "cutover audit records the locked pre-transition state instead of a hard-coded value",
);
includesAll("migration:atomic-compat-mutation", storageMigration, [
  "CREATE FUNCTION public.commit_manju_config_compat_envelope",
  "p_expected_storage_revision",
  "MANJU_CONFIG_STORAGE_STATE_CONFLICT",
  "MANJU_CONFIG_COMPAT_STORAGE_CONFLICT",
  "PERFORM pg_advisory_xact_lock",
  "FOR UPDATE",
  "GRANT EXECUTE ON FUNCTION public.commit_manju_config_compat_envelope",
]);
add(
  "migration:actor-identifiers-are-text",
  ["created_by", "released_by", "updated_by", "actor_id"].every((column) =>
    actorMigration.includes(`ALTER COLUMN ${column} TYPE text`),
  ) && actorMigration.includes("p_actor_id text"),
  "a separate forward migration converts UUID actors to bounded text identifiers",
);
includesAll("migration:actor-rpc-signatures", actorMigration, [
  "text, text, jsonb, text, text, uuid, timestamptz, text",
  "publish_manju_config_revision(uuid, uuid, text)",
  "rollback_manju_config_release(text, text, uuid, uuid, text)",
]);
includesAll("migration:activation-requires-latest-schema", actorMigration, [
  "MANJU_CONFIG_ACTIVATION_SCHEMA_VERSION_UNSUPPORTED",
  "v_revision.domain IN ('prompt', 'content', 'media', 'feature_flags')",
  "v_revision.schema_version IS DISTINCT FROM '1.1.0'",
  "v_target_revision.domain IN ('prompt', 'content', 'media', 'feature_flags')",
  "v_target_revision.schema_version IS DISTINCT FROM '1.1.0'",
  "Use an upgrade-rollback",
]);
add(
  "migration:publish-and-rollback-both-gate-schema",
  (actorMigration.match(/MANJU_CONFIG_ACTIVATION_SCHEMA_VERSION_UNSUPPORTED/g) ?? []).length === 2,
  "both native publish and rollback fail closed before activating a pre-1.1 strict-domain revision",
);
includesAll("migration:native-storage-adoption-requires-latest-schema", storageMigration, [
  "v_domain IN ('prompt', 'content', 'media', 'feature_flags')",
  "v_native_revision.schema_version IS DISTINCT FROM '1.1.0'",
  "MANJU_CONFIG_ACTIVATION_SCHEMA_VERSION_UNSUPPORTED",
]);
add(
  "migration:both-native-storage-transitions-gate-schema",
  (storageMigration.match(/MANJU_CONFIG_ACTIVATION_SCHEMA_VERSION_UNSUPPORTED/g) ?? []).length === 2,
  "both native reconciliation and compat-to-native cutover require schema 1.1 for runtime domains",
);
const compatCommitFunction = storageMigration.slice(
  storageMigration.indexOf("CREATE FUNCTION public.commit_manju_config_compat_envelope"),
  storageMigration.indexOf("CREATE FUNCTION public.reconcile_manju_config_storage_to_compat"),
);
includesAll("migration:compat-write-generation-and-row-cas", compatCommitFunction, [
  "p_expected_generation bigint",
  "p_expected_storage_revision timestamptz",
  "pg_advisory_xact_lock",
  "FROM public.manju_config_storage_state",
  "FOR UPDATE",
  "v_state.generation <> p_expected_generation",
  "v_current_storage_revision IS DISTINCT FROM p_expected_storage_revision",
  "MANJU_CONFIG_COMPAT_STORAGE_CONFLICT",
]);
add(
  "migration:no-destructive-table-drop",
  !/DROP\s+TABLE/i.test(migration),
  /DROP\s+TABLE/i.test(migration) ? "forward migration contains DROP TABLE" : "forward migration is non-destructive",
);
includesAll("rollback:complete", rollback, [
  "save_manju_config_draft",
  "publish_manju_config_revision",
  "rollback_manju_config_release",
  "manju_config_active",
  "manju_config_releases",
  "manju_config_revisions",
  "manju_config_audit",
  "DROP",
]);
includesAll("storage-rollback:complete", storageRollback, [
  "commit_manju_config_compat_envelope",
  "cutover_manju_config_storage",
  "manju_config_storage_state_guard",
  "manju_config_storage_state",
  "MANJU_CONFIG_STORAGE_ROLLBACK_REQUIRES_MANUAL_RECOVERY",
  "DROP",
]);
add(
  "storage-rollback:exact-compat-reconcile-signature",
  /DROP FUNCTION IF EXISTS public\.reconcile_manju_config_storage_to_compat\(\s*text, text, bigint, timestamptz, uuid, uuid, text, uuid, uuid, text, boolean, text\s*\)/m.test(
    storageRollback,
  ),
  "storage rollback drops the exact two-store reconciliation overload",
);
includesAll("rollback:actor-rpc-signatures", actorRollback, [
  "MANJU_CONFIG_ACTOR_TEXT_ROLLBACK_UNSAFE",
  "MANJU_CONFIG_ACTOR_ROLLBACK_REQUIRES_STORAGE_ROLLBACK_FIRST",
  "to_regclass('public.manju_config_storage_state') IS NOT NULL",
  "functions.proname IN",
  "cutover_manju_config_storage",
  "p_schema_version text DEFAULT '1.0.0'",
  "text, text, jsonb, text, text, uuid, timestamptz, uuid",
  "publish_manju_config_revision(uuid, uuid, uuid)",
  "rollback_manju_config_release(text, text, uuid, uuid, uuid)",
]);
excludesAll("rollback:actor-restores-schema-1.0-activation-semantics", actorRollback, [
  "MANJU_CONFIG_ACTIVATION_SCHEMA_VERSION_UNSUPPORTED",
]);
const historicalMigrationHash = createHash("sha256")
  .update(readFileSync(path.join(root, migrationPath)))
  .digest("hex");
const historicalRollbackHash = createHash("sha256")
  .update(readFileSync(path.join(root, rollbackPath)))
  .digest("hex");
add(
  "historical-migration:immutable",
  historicalMigrationHash === "46e25899d128bbdc054a5c8d134b7a0510e039f9e2e039538f6c3e6a56d3b11f",
  `sha256=${historicalMigrationHash}`,
);
add(
  "historical-rollback:immutable",
  historicalRollbackHash === "1a63cc1f82905cbfb11416c8a0a336e8bd2c5488a2cf5f4e1573bc12f8f11b00",
  `sha256=${historicalRollbackHash}`,
);

const migrationDirectory = path.join(root, "supabase/migrations");
const misplacedRollbacks = existsSync(migrationDirectory)
  ? readdirSync(migrationDirectory).filter((name) => name.endsWith(".rollback.sql"))
  : [];
add(
  "migration-directory:no-rollback-files",
  misplacedRollbacks.length === 0,
  misplacedRollbacks.length === 0 ? "no *.rollback.sql in migrations" : `misplaced: ${misplacedRollbacks.join(", ")}`,
);

includesAll("server:contract", server, [
  "MANJU_CONFIG_DOMAINS",
  "MANJU_PUBLIC_CONFIG_DOMAINS",
  "MANJU_CONFIG_ENVIRONMENTS",
  "payload_hash",
  "isManjuMigrationNotReadyError",
  "sanitizeManjuPublicPayload",
  "validateManjuDomainContract",
  "MANGA_RUNTIME_PROMPT_REQUIRED",
]);
includesAll("server:latest-runtime-schema-domains", server, [
  "MANJU_RUNTIME_LATEST_SCHEMA_DOMAINS",
  '"prompt"',
  "...MANJU_PUBLIC_CONFIG_DOMAINS",
  'MANJU_CONFIG_LATEST_SCHEMA_VERSION = "1.1.0"',
]);
includesAll("server:storage-generation-actions", server, [
  "ExpectedStorageGenerationSchema",
  "expected_storage_generation: ExpectedStorageGenerationSchema",
]);
add(
  "server:no-client-storage-mode-selection",
  !server.includes("storage_mode"),
  server.includes("storage_mode")
    ? "action schema still accepts a client-selected storage backend"
    : "write actions carry only the expected server storage generation",
);
add(
  "server:sensitive-field-defense",
  /secret|token|password|api[_-]?key|private[_-]?key/i.test(server),
  "sensitive key filtering/validation is present",
);
includesAll("admin-route:auth-and-actions", adminRoute, [
  "getTokenFromHeaders",
  "verifyAdminToken",
  "save-draft",
  "validate",
  "publish",
  "rollback",
  "save_manju_config_draft",
  "getSupabaseAdminClient",
  "MIGRATION_NOT_READY",
  "Cache-Control",
  "validateManjuDomainContract",
]);
includesAll("compat-store:authoritative-storage-state", compatStore, [
  "loadManjuStorageStates",
  '.from("manju_config_storage_state")',
  '.select("environment,domain,state,generation")',
  "CONFIG_STORAGE_AMBIGUOUS",
  "CONFIG_STORAGE_MIGRATING",
  "CONFIG_STORAGE_MODE_CORRUPT",
  "CONFIG_STORAGE_STATE_MISSING",
  "assertLegacyCompatHasNoNativeControlPlane",
]);
includesAll("compat-store:atomic-generation-cas", compatStore, [
  'client.rpc("commit_manju_config_compat_envelope"',
  "p_expected_generation: expectedStorageGeneration",
  "p_expected_storage_revision: loaded.storageRevision",
  "expectedStorageGeneration: number",
  "persistEnvelope(client, loaded, envelope, input.expectedStorageGeneration)",
]);
includesAll("compat-store:exact-scope-operations", compatStore, [
  "publishManjuCompatRevision",
  "rollbackManjuCompatRelease",
  "input.environment",
  "input.domain",
  "loadEnvelope(client, input.environment, input.domain)",
]);
includesAll("compat-store:active-runtime-requires-latest-schema", compatStore, [
  "active.revision.schema_version !== MANJU_CONFIG_LATEST_SCHEMA_VERSION",
  'throw new Error("public schema upgrade required")',
]);
excludesAll("compat-store:no-inference-write-bridge", compatStore, [
  "guardCompatWriteAgainstNativeState",
  "nativeScopeIsEmpty",
  "findDraftById",
]);
includesAll("admin-route:server-storage-generation", adminRoute, [
  "loadManjuStorageStates",
  "expected_storage_generation",
  "CONFIG_STORAGE_GENERATION_REQUIRED",
  "CONFIG_STORAGE_MODE_CHANGED",
  "storage.generation !== action.expected_storage_generation",
  "storage_generation: storage.generation",
  'storage.mode === "compat"',
]);
includesAll("admin-route:native-fail-closed", adminRoute, [
  "CONFIG_STORE_CORRUPT",
  "revisionPayloadIsValid",
  "CONFIG_REVISION_SCOPE_MISMATCH",
  'databaseFailure(firstError, "load-native")',
  'databaseFailure(result.error, "save-draft")',
  'databaseFailure(result.error, "publish")',
  'databaseFailure(result.error, "rollback")',
]);
add(
  "admin-route:publish-and-rollback-latest-schema-gates",
  (adminRoute.match(/公开配置必须升级为 schema/g) ?? []).length >= 2 &&
    (adminRoute.match(/旧版本仅供审计/g) ?? []).length >= 2 &&
    adminRoute.includes("requiresLatestRuntimeSchema"),
  "compat and native publish/rollback paths reject activation of historical runtime schemas",
);
excludesAll("admin-route:no-retired-storage-inference", adminRoute, [
  "guardCompatWriteAgainstNativeState",
  "nativeScopeIsEmpty",
  "load-empty-native-compat",
  'action.storage_mode === "compat"',
]);
add(
  "admin-route:text-actor-compatible",
  adminRoute.includes("actorIdentifier") &&
    adminRoute.includes("actor.userId.trim()") &&
    !adminRoute.includes("actorUuid") &&
    !adminRoute.includes("isUuid"),
  "admin publishing accepts bounded text account identifiers without a UUID-only gate",
);
includesAll("admin-route:initial-native-domain-is-configurable", adminRoute, [
  "activePointer === null",
  "activeRelease === null && activeRevision === null && history.length === 0",
  "CONFIG_STORE_CORRUPT",
]);
includesAll("public-route:published-only-cache", publicRoute, [
  "production",
  "ETag",
  "if-none-match",
  "MIGRATION_NOT_READY",
  "missing_domains",
  "MANJU_PUBLIC_CONFIG_DOMAINS",
]);
includesAll("public-route:explicit-marker-partition", publicRoute, [
  "loadManjuStorageStates",
  "nativeDomains",
  "compatDomains",
  'storageStates[domain].mode === "native"',
  'storageStates[domain].mode === "compat"',
  "loadManjuCompatPublic(database, compatDomains)",
  "storage_generations: storageGenerations",
]);
includesAll("public-route:native-fail-closed", publicRoute, [
  "validateManjuConfigPayload(revision.payload)",
  "validateManjuDomainContract(domain, validated.payload, revision.schema_version)",
  "validated.payloadHash !== revision.payload_hash",
  "CONFIG_INCOMPLETE",
  "missing_domains: unresolvedDomains",
  "已拒绝使用未发布或伪造默认值",
  "FAIL_CLOSED_HEADERS",
]);
excludesAll("public-route:no-inferred-fallback", publicRoute, [
  "compatEligibleDomains",
  "invalidNativeDomains",
  "load-empty-native-compat",
]);
add(
  "public-route:private-prompt-domain-excluded",
  !publicRoute.includes("MANJU_CONFIG_DOMAINS") && !/for\s*\([^)]*\bprompt\b/u.test(publicRoute),
  "the unauthenticated runtime endpoint only iterates the explicit public-domain allowlist",
);
add(
  "public-route:no-draft-query-token",
  !/\.eq\(\s*["']status["']\s*,\s*["']draft["']\s*\)/i.test(publicRoute),
  /\.eq\(\s*["']status["']\s*,\s*["']draft["']\s*\)/i.test(publicRoute)
    ? "public route queries draft rows"
    : "public route does not query draft rows",
);
includesAll("prompt:native-fail-closed", publishedPrompt, [
  "ManjuPublishedPromptUnavailableError",
  "loadManjuStorageStates",
  'storage.mode === "compat"',
  "published-native",
  "revision.status === \"published\"",
  "validated.payloadHash !== revision.payload_hash",
  "原生漫剧提示词活动版本不一致",
  "原生漫剧提示词结构无效",
]);
includesAll("prompt:source-fallback-legacy-only", publishedPrompt, [
  "if (generation !== 0)",
  'const cacheKey = "compat:0:none"',
  'return loadCompatPrompt(database, storage.generation)',
  '"compat",',
  '"native",',
  "storage.generation",
  "readCachedPrompt(cacheKey)",
  "兼容配置已纳入权威存储，但尚未发布漫剧运行提示词",
  "if (error instanceof ManjuPublishedPromptUnavailableError) throw error",
]);
includesAll("llm:prompt-unavailable-503-before-provider", llmRoute, [
  "loadPublishedMangaPrompt",
  "ManjuPublishedPromptUnavailableError",
  "code: error.code",
  "status: 503",
  '"Cache-Control": "no-store"',
  "native 异常必须在模型调用和计费前失败",
]);
includesAll("reserved-settings:namespace", reservedSettings, [
  'MANJU_PLATFORM_SETTINGS_PREFIX = "manju.config.v1."',
  "isReservedPlatformSettingKey",
  "findReservedPlatformSettingKeys",
]);
includesAll("settings-route:reserved-read-write-defense", settingsRoute, [
  "isReservedPlatformSettingKey(key)",
  "Object.keys(rawSettings)",
  "VERSIONED_PLATFORM_SETTING_KEY",
]);
includesAll("sync-import:reserved-defense", syncImport, [
  "findReservedPlatformSettingKeys",
  "RESERVED_PLATFORM_SETTING_KEY",
  "if (reservedKeys.length > 0)",
  "SAFE_MERGE_ONLY",
]);
includesAll("sync-export:reserved-exclusion", syncExport, [
  "MANJU_PLATFORM_SETTINGS_PREFIX",
  "query.not('setting_key', 'like', `${MANJU_PLATFORM_SETTINGS_PREFIX}%`)",
  "excluded_namespaces: [MANJU_PLATFORM_SETTINGS_PREFIX]",
]);
includesAll("admin-ui:operations", center, [
  "校验",
  "保存草稿",
  "发布",
  "回滚",
  "JSON",
  "MIGRATION_NOT_READY",
  "storage_mode",
  "storage_generation",
  "expected_storage_generation",
  "存储链路",
]);
includesAll("admin-tab:mounted", tab, [
  "ManjuConfigCenter",
  "ManjuPromptInspector",
  "ManjuShowcaseCatalogManager",
  "token={token}",
]);
includesAll("deployment-standard:manju-migration-order", deploymentStandard, [
  "expand → migrate → contract",
  "20260825123000_manju_config_control_plane.sql",
  "20260829220000_manju_config_actor_text.sql",
  "20260829223000_manju_config_storage_state.sql",
  "20260829223000_manju_config_storage_state.rollback.sql",
  "20260829220000_manju_config_actor_text.rollback.sql",
  "20260825123000_manju_config_control_plane.rollback.sql",
  "storage-state rollback → actor-text rollback → base rollback",
  "受控 reconcile runner",
  "parseEnvelope",
  "MANJU_CONFIG_ACTOR_ROLLBACK_REQUIRES_STORAGE_ROLLBACK_FIRST",
  "MANJU_CONFIG_STORAGE_NATIVE_SCOPE_WITHOUT_ACTIVE_REQUIRES_RECONCILIATION",
]);
includesAll("seed:schema-version-participates-in-plan", productionSeed, [
  "schemaVersion: string",
  "existing.schemaVersion !== MANJU_CONFIG_LATEST_SCHEMA_VERSION",
  '"schema-upgrade-required"',
]);

const failed = checks.filter((check) => !check.passed);
const report = {
  verifier: "manju-config-control-plane",
  mode: "offline-static-only",
  passed: failed.length === 0,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks,
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
