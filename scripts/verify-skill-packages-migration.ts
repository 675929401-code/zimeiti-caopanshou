import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const root = process.cwd();
const checks: Check[] = [];

const migrationPath = "supabase/migrations/20260827093000_skill_packages_runtime.sql";
const rollbackPath = "supabase/rollbacks/20260827093000_skill_packages_runtime.rollback.sql";

const tables = [
  "skill_packages",
  "skill_versions",
  "skill_secret_bindings",
  "agent_skill_installations",
  "user_skill_installations",
  "skill_invocations",
  "skill_release_audit",
] as const;

const rpcSignatures = [
  "save_skill_package_draft(text,text,text,text,text,text,jsonb,text,text,text,jsonb,uuid,uuid,timestamptz,text)",
  "publish_skill_version(uuid,uuid,text)",
  "rollback_skill_package_version(uuid,uuid,uuid,text)",
  "replace_agent_skill_installations(text,jsonb,text)",
  "replace_user_skill_installations(text,jsonb,text)",
  "claim_skill_invocation(uuid,text,text,uuid,uuid,text,text,jsonb,text,text,text)",
  "complete_skill_invocation(uuid,text,jsonb,text,text,text,text,text[],numeric,numeric,jsonb)",
  "fail_skill_invocation(uuid,text,text,text,jsonb,text,text)",
] as const;

function add(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function read(relativePath: string) {
  const absolutePath = path.join(root, relativePath);
  const exists = existsSync(absolutePath);
  add(`file:${relativePath}`, exists, exists ? "present" : "missing");
  return exists ? readFileSync(absolutePath, "utf8") : "";
}

function includesAll(name: string, source: string, tokens: readonly string[]) {
  const missing = tokens.filter((token) => !source.includes(token));
  add(
    name,
    missing.length === 0,
    missing.length === 0 ? "all contract tokens present" : `missing: ${missing.join(", ")}`,
  );
}

function count(source: string, pattern: RegExp) {
  return [...source.matchAll(pattern)].length;
}

function compact(source: string) {
  return source.replace(/\s+/g, "").toLowerCase();
}

function createdRpcSignature(source: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`CREATE FUNCTION public\\.${escapedName}\\s*\\(([\\s\\S]*?)\\)\\s*RETURNS jsonb`, "i"),
  );
  if (!match) return null;

  const argumentTypes = match[1]
    .split(",")
    .map((argument) => argument.trim().replace(/^p_[a-z0-9_]+\s+/i, "").replace(/\s+/g, ""))
    .filter(Boolean)
    .join(",");
  return `${name}(${argumentTypes})`.toLowerCase();
}

function tableBody(source: string, table: string) {
  const match = source.match(new RegExp(`CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`, "i"));
  return match?.[1] ?? "";
}

const migration = read(migrationPath);
const rollback = read(rollbackPath);
const compactMigration = compact(migration);
const compactRollback = compact(rollback);

add(
  "migration:transaction-boundary",
  /^BEGIN;[\s\S]*COMMIT;\s*$/i.test(migration),
  "forward migration is enclosed by one explicit transaction",
);
add(
  "migration:forward-is-nondestructive",
  !/\b(?:DROP|TRUNCATE)\s+(?:TABLE|SCHEMA)\b/i.test(migration),
  "forward migration does not drop or truncate tables/schemas",
);
add(
  "migration:no-version-dependent-jsonb-object-length",
  !migration.includes("jsonb_object_length"),
  "secret validator uses jsonb_object_keys rather than a non-portable helper",
);

for (const table of tables) {
  add(
    `table:${table}:created-once`,
    count(migration, new RegExp(`CREATE TABLE public\\.${table}\\b`, "gi")) === 1,
    "exactly one forward table definition",
  );
  add(
    `table:${table}:rls-enabled`,
    migration.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`),
    "RLS enabled",
  );
  add(
    `table:${table}:direct-public-access-revoked`,
    migration.includes(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`),
    "PUBLIC, anon and authenticated have no direct table privileges",
  );
  add(`table:${table}:definition-readable`, tableBody(migration, table).length > 0, "table body parsed");
}

includesAll("schema:package-columns", tableBody(migration, "skill_packages"), [
  "id uuid PRIMARY KEY",
  "slug text NOT NULL",
  "active_version_id uuid",
  "latest_version_number bigint",
  "metadata jsonb",
  "created_by text",
  "updated_by text",
]);
includesAll("schema:version-columns", tableBody(migration, "skill_versions"), [
  "package_id uuid",
  "version_number bigint",
  "semver text",
  "status text",
  "payload jsonb",
  "payload_hash text",
  "schema_version text",
  "parent_version_id uuid",
  "published_at timestamptz",
]);
includesAll("schema:secret-binding-columns", tableBody(migration, "skill_secret_bindings"), [
  "environment text",
  "secret_name text",
  "secret_ref text",
  "binding_status text",
]);
includesAll("schema:installation-columns", migration, [
  "CREATE TABLE public.agent_skill_installations",
  "agent_id text NOT NULL",
  "CREATE TABLE public.user_skill_installations",
  "user_id text NOT NULL",
  "install_config jsonb",
  "installed_by text",
]);
includesAll("schema:invocation-columns", tableBody(migration, "skill_invocations"), [
  "client_idempotency_key text",
  "payload_fingerprint text",
  "state text",
  "billing_operation_id text",
  "provider_task_id text",
  "asset_ids text[]",
  "charged_credits numeric(20,6)",
  "charged_cash numeric(20,6)",
  "cost_snapshot jsonb",
]);
includesAll("schema:audit-columns", tableBody(migration, "skill_release_audit"), [
  "id bigint GENERATED ALWAYS AS IDENTITY",
  "sequence bigint",
  "action text",
  "actor_id text NOT NULL",
  "detail jsonb",
]);

includesAll("enums:package", migration, [
  "origin IN ('builtin', 'open_source', 'community', 'custom')",
  "visibility IN ('private', 'tenant', 'public')",
  "runtime_kind IN ('prompt', 'tool', 'workflow', 'hybrid')",
  "lifecycle IN ('draft', 'published', 'archived')",
]);
includesAll("enums:runtime", migration, [
  "status IN ('draft', 'released')",
  "environment IN ('production', 'staging', 'development')",
  "binding_status IN ('active', 'disabled')",
  "state IN ('claimed', 'completed', 'failed', 'failed_unknown')",
  "action IN ('create_draft', 'update_draft', 'publish', 'rollback')",
]);

add(
  "identity:text-compatible",
  ["created_by", "updated_by", "installed_by", "user_id", "agent_id", "actor_id"].every((column) =>
    new RegExp(`\\b${column}\\s+text\\b`, "i").test(migration),
  ) && !/\b(?:created_by|updated_by|installed_by|user_id|agent_id|actor_id|p_actor_id)\s+uuid\b/i.test(migration),
  "main-site string and phone-like account identifiers are accepted; no actor UUID gate",
);
includesAll("identity:bounded-and-audited", migration, [
  "char_length(p_actor_id) BETWEEN 1 AND 128",
  "char_length(p_subject_id) BETWEEN 1 AND 128",
  "p_actor_id IS NULL OR NOT public.skill_runtime_actor_valid(p_actor_id)",
]);

includesAll("security:secret-references-only", migration, [
  "skill_runtime_secret_ref_valid",
  "skill_runtime_json_secret_safe",
  "'secret', 'secret_value', 'token', 'access_token', 'refresh_token'",
  "'password', 'passphrase', 'api_key', 'private_key', 'client_secret'",
  "'credential', 'credentials', 'authorization'",
  "'secret', 'secretvalue', 'secretref', 'token', 'accesstoken'",
  "v_compact_key ~ '(token|password|passphrase|apikey|privatekey|clientsecret|credential|credentials|authorization)$'",
  "^(secret|vault|env|supabase-vault)://",
  "SKILL_PACKAGE_PAYLOAD_INVALID_OR_UNSAFE",
  "SKILL_AGENT_INSTALLATION_CONFIG_UNSAFE",
  "SKILL_USER_INSTALLATION_CONFIG_UNSAFE",
]);
includesAll("security:payload-runtime-contract", migration, [
  "p_payload -> 'routing'",
  "p_payload -> 'orchestration'",
  "p_payload -> 'instructions'",
  "p_payload -> 'input_schema'",
  "p_payload -> 'output_schema'",
  "p_payload -> 'tools'",
  "p_payload -> 'resources'",
]);
add(
  "security:no-client-table-policy",
  !/\bCREATE\s+POLICY\b/i.test(migration),
  "RLS defaults deny because no anon/authenticated policy is created",
);

for (const signature of rpcSignatures) {
  const name = signature.slice(0, signature.indexOf("("));
  add(
    `rpc:${name}:signature-and-service-grant`,
    createdRpcSignature(migration, name) === signature &&
      compactMigration.includes(`grantexecuteonfunctionpublic.${signature}toservice_role;`) &&
      compactMigration.includes(`revokeallonfunctionpublic.${signature}frompublic,anon,authenticated;`),
    "exact signature is created, client roles revoked and service_role granted",
  );
}

includesAll("rpc:draft-cas-and-audit", migration, [
  "pg_advisory_xact_lock(hashtextextended('skill-package:'",
  "SKILL_VERSION_EXPECTED_UPDATED_AT_REQUIRED",
  "SKILL_VERSION_DRAFT_CONFLICT",
  "FOR UPDATE",
  "'create_draft'",
  "'update_draft'",
]);
includesAll("rpc:publish-rollback-cas", migration, [
  "SKILL_ACTIVE_VERSION_CONFLICT",
  "SKILL_RELEASED_VERSION_IMMUTABLE",
  "SKILL_ROLLBACK_TARGET_NOT_RELEASED",
  "'publish'",
  "'rollback'",
]);
includesAll("rpc:replace-installs-atomic", migration, [
  "skill-agent-installs:",
  "skill-user-installs:",
  "jsonb_typeof(v_item->'enabled') <> 'boolean'",
  "ON CONFLICT (agent_id, package_id) DO UPDATE",
  "ON CONFLICT (user_id, package_id) DO UPDATE",
  "SKILL_INSTALLATION_VERSION_NOT_RELEASED",
  "SKILL_INSTALLATION_IDENTITY_IMMUTABLE",
]);
includesAll("rpc:claim-exactly-once", migration, [
  "UNIQUE (user_id, client_idempotency_key)",
  "ON CONFLICT (user_id, client_idempotency_key) DO NOTHING",
  "SKILL_INVOCATION_IDEMPOTENCY_CONFLICT",
  "SKILL_INVOCATION_NOT_INSTALLED",
  "payload_fingerprint",
]);
includesAll("rpc:terminal-idempotency", migration, [
  "SKILL_INVOCATION_TERMINAL_IMMUTABLE",
  "SKILL_INVOCATION_RESULT_CONFLICT",
  "SKILL_INVOCATION_FAILURE_CONFLICT",
  "SKILL_INVOCATION_CLAIM_METADATA_CONFLICT",
  "v_model_id := coalesce(v_model_id, v_row.model_id)",
  "v_billing_operation_id := coalesce(v_billing_operation_id, v_row.billing_operation_id)",
  "failed_unknown",
]);
includesAll("billing:finite-and-nonnegative", migration, [
  "charged_credits >= 0",
  "charged_cash >= 0",
  "charged_credits::text NOT IN ('NaN', 'Infinity', '-Infinity')",
  "v_credits::text IN ('NaN', 'Infinity', '-Infinity')",
  "cost_snapshot",
]);
includesAll("assets:bounded-normalized-unique", migration, [
  "skill_runtime_asset_ids_valid",
  "count(DISTINCT asset_id.value)",
  "char_length(asset_id.value) NOT BETWEEN 1 AND 512",
]);

includesAll("immutability:triggers", migration, [
  "SKILL_PACKAGE_IDENTITY_IMMUTABLE",
  "SKILL_RELEASED_VERSION_IMMUTABLE",
  "SKILL_INVOCATION_TERMINAL_IMMUTABLE",
  "SKILL_RELEASE_AUDIT_IMMUTABLE",
]);
add(
  "indexes:operational-coverage",
  count(migration, /CREATE INDEX /g) >= 10 && migration.includes("skill_invocations_task_idx"),
  "catalog, runtime, history and task lookup indexes are present",
);
add(
  "postgrest:schema-reload",
  migration.includes("NOTIFY pgrst, 'reload schema';"),
  "PostgREST schema reload notification is included",
);

add(
  "rollback:transaction-boundary",
  /^BEGIN;[\s\S]*COMMIT;\s*$/i.test(rollback),
  "rollback is enclosed by an explicit transaction",
);
add(
  "rollback:no-cascade",
  !/\bCASCADE\b/i.test(rollback.replace(/--[^\n]*/g, "")),
  "rollback stops on unexpected dependencies instead of cascading",
);
for (const table of [...tables].reverse()) {
  add(
    `rollback:${table}`,
    compactRollback.includes(`droptableifexistspublic.${table};`),
    "table explicitly removed",
  );
}
for (const signature of rpcSignatures) {
  add(
    `rollback:${signature.slice(0, signature.indexOf("("))}`,
    compactRollback.includes(`dropfunctionifexistspublic.${signature};`),
    "exact RPC overload explicitly removed",
  );
}
includesAll("rollback:helpers", rollback, [
  "skill_runtime_actor_valid",
  "skill_runtime_subject_valid",
  "skill_runtime_secret_ref_valid",
  "skill_runtime_asset_ids_valid",
  "skill_runtime_json_secret_safe",
  "skill_runtime_package_payload_valid",
]);

const migrationDirectory = path.join(root, "supabase/migrations");
const misplacedRollbacks = existsSync(migrationDirectory)
  ? readdirSync(migrationDirectory).filter((name) => name.endsWith(".rollback.sql"))
  : [];
add(
  "migration-directory:no-rollback-files",
  misplacedRollbacks.length === 0,
  misplacedRollbacks.length === 0 ? "no *.rollback.sql in migrations" : `misplaced: ${misplacedRollbacks.join(", ")}`,
);

const failed = checks.filter((check) => !check.passed);
const report = {
  verifier: "skill-packages-runtime-migration",
  mode: "offline-static-only",
  deploymentPerformed: false,
  buildOrRestartPerformed: false,
  passed: failed.length === 0,
  summary: {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  },
  checks,
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
