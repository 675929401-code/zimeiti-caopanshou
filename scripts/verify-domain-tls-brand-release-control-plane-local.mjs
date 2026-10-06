#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002210000";
const PREREQUISITE_VERSION = "20261002200000";
const MIGRATION_FILE = `${VERSION}_domain_tls_brand_release_control_plane.sql`;
const ROLLBACK_FILE = `${VERSION}_domain_tls_brand_release_control_plane.rollback.sql`;
const PREREQUISITE_FILE = `${PREREQUISITE_VERSION}_multitenant_brand_boundary.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_FIXTURE_EXECUTION_REQUIRED");
assert.ok(
  process.argv.includes("--confirm-local-domain-tls-brand-release-control-plane"),
  "LOCAL_DOMAIN_RELEASE_CONFIRMATION_REQUIRED",
);

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const [migrationSource, rollbackSource, prerequisiteSource] = await Promise.all([
  fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8"),
  fs.readFile(path.resolve("supabase/rollbacks", ROLLBACK_FILE), "utf8"),
  fs.readFile(path.resolve("supabase/migrations", PREREQUISITE_FILE), "utf8"),
]);

function transactionBody(source, label) {
  const withoutBegin = source.replace(/^\uFEFF?BEGIN;\s*/u, "");
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/u, "");
  assert.notEqual(withoutBegin, source, `${label}_BEGIN_REQUIRED`);
  assert.notEqual(withoutCommit, withoutBegin, `${label}_COMMIT_REQUIRED`);
  return withoutCommit;
}

const migrationBody = transactionBody(migrationSource, "MIGRATION");
const rollbackBody = transactionBody(rollbackSource, "ROLLBACK");
const prerequisiteBody = transactionBody(prerequisiteSource, "PREREQUISITE");
const migrationHash = crypto.createHash("sha256").update(migrationSource).digest("hex");
const rollbackHash = crypto.createHash("sha256").update(rollbackSource).digest("hex");
const suffix = crypto.randomUUID().replace(/-/gu, "").slice(0, 12);
const hostname = `verify-${suffix}.codex-boundary.dev`;
const tables = [
  "domain_claims",
  "domain_hostnames",
  "domain_verification_attempts",
  "domain_tls_probes",
  "domain_brand_release_bindings",
  "domain_release_audits",
];
const prerequisiteTables = [
  "tenants",
  "sites",
  "site_hostnames",
  "site_brand_releases",
  "tenant_resource_integrations",
  "tenant_isolation_receipts",
  "tenant_audits",
];

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-domain-tls-brand-release-verification",
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
});

async function assertLocalIdentity() {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );
}

async function relationCount(names) {
  return Number((await client.query(
    `SELECT count(*)::integer AS count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
    [names],
  )).rows[0]?.count || 0);
}

let began = false;
await client.connect();
try {
  await assertLocalIdentity();
  const ledgerBefore = await client.query(
    "SELECT version::text AS version FROM supabase_migrations.schema_migrations WHERE version::text=ANY($1::text[])",
    [[PREREQUISITE_VERSION, VERSION]],
  );
  const appliedVersions = new Set(ledgerBefore.rows.map((row) => row.version));
  assert.equal(appliedVersions.has(VERSION), false, "DOMAIN_RELEASE_MIGRATION_ALREADY_APPLIED");
  assert.equal(await relationCount(tables), 0, "DOMAIN_RELEASE_SCHEMA_ALREADY_PRESENT");
  const prerequisiteRelationCount = await relationCount(prerequisiteTables);
  const prerequisitePersisted = appliedVersions.has(PREREQUISITE_VERSION);
  if (prerequisitePersisted) {
    assert.equal(prerequisiteRelationCount, prerequisiteTables.length, "MULTITENANT_PREREQUISITE_SCHEMA_INCOMPLETE");
  } else {
    assert.equal(prerequisiteRelationCount, 0, "UNLEDGERED_MULTITENANT_PREREQUISITE_SCHEMA_PRESENT");
  }

  await client.query("BEGIN");
  began = true;
  if (!prerequisitePersisted) await client.query(prerequisiteBody);
  await client.query(migrationBody);

  const rls = await client.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])
      ORDER BY c.relname`,
    [tables],
  );
  assert.equal(rls.rowCount, tables.length);
  for (const row of rls.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname}_RLS_REQUIRED`);
    assert.equal(row.relforcerowsecurity, false, `${row.relname}_OWNER_RPC_ACCESS_REQUIRED`);
  }
  const grants = (await client.query(
    `SELECT
       bool_or(has_table_privilege('anon', format('public.%I', c.relname), 'SELECT,INSERT,UPDATE,DELETE')) AS anon_access,
       bool_or(has_table_privilege('authenticated', format('public.%I', c.relname), 'SELECT,INSERT,UPDATE,DELETE')) AS authenticated_access,
       bool_or(has_table_privilege('service_role', format('public.%I', c.relname), 'SELECT,INSERT,UPDATE,DELETE')) AS service_access
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
    [tables],
  )).rows[0];
  assert.equal(grants.anon_access, false);
  assert.equal(grants.authenticated_access, false);
  assert.equal(grants.service_access, false);
  const functionGrants = (await client.query(
    `SELECT
       has_function_privilege('service_role', 'public.get_domain_tls_brand_release_status()', 'EXECUTE') AS status_execute,
       has_function_privilege('service_role', 'public.is_valid_domain_ascii_hostname(text)', 'EXECUTE') AS helper_execute,
       has_function_privilege('anon', 'public.get_domain_tls_brand_release_status()', 'EXECUTE') AS anon_execute`,
  )).rows[0];
  assert.equal(functionGrants.status_execute, true);
  assert.equal(functionGrants.helper_execute, false);
  assert.equal(functionGrants.anon_execute, false);

  const validator = (await client.query(
    `SELECT
       public.is_valid_domain_ascii_hostname($1) AS valid,
       public.is_reserved_domain_ascii_hostname($1) AS reserved,
       public.is_reserved_domain_ascii_hostname('child.example.com') AS example_reserved,
       public.is_valid_domain_ascii_hostname('bad_name.example.dev') AS underscore_valid`,
    [hostname],
  )).rows[0];
  assert.equal(validator.valid, true);
  assert.equal(validator.reserved, false);
  assert.equal(validator.example_reserved, true);
  assert.equal(validator.underscore_valid, false);

  const legacyConflictHostname = `legacy-${suffix}.codex-boundary.dev`;
  await client.query(
    `INSERT INTO public.tenants (
       tenant_key, display_name, lifecycle_status, operating_mode, boundary_status,
       status_reason, session_claim_status, business_read_scope_status,
       business_write_scope_status, cross_tenant_test_status
     ) VALUES (
       $1,'Local conflict tenant','foundation_only','single_tenant','unavailable',
       'CROSS_TENANT_ISOLATION_NOT_IMPLEMENTED','unavailable','unavailable',
       'unavailable','not_run'
     )`,
    [`verify-tenant-${suffix}`],
  );
  await client.query(
    `INSERT INTO public.sites (
       site_key, tenant_key, display_name, lifecycle_status, routing_status,
       brand_scope_status, status_reason
     ) VALUES ($1,$2,'Local conflict site','foundation_only','unavailable',
       'unavailable','STATIC_SINGLE_SITE_ONLY')`,
    [`verify-site-${suffix}`, `verify-tenant-${suffix}`],
  );
  await client.query(
    `INSERT INTO public.site_hostnames (
       hostname, site_key, tenant_key, hostname_kind
     ) VALUES ($1,$2,$3,'custom')`,
    [legacyConflictHostname, `verify-site-${suffix}`, `verify-tenant-${suffix}`],
  );
  await client.query("SAVEPOINT expected_existing_scope_conflict");
  try {
    await client.query(
      `INSERT INTO public.domain_claims (
         tenant_key, site_key, requested_hostname, ascii_hostname, unicode_hostname,
         claim_kind, verification_token_hash, verification_token_hint,
         expected_txt_name, created_by
       ) VALUES ('default','default',$1,$1,$1,'custom',$2,'conflict',
         '_zimeiti-domain-verification.' || $1,'codex-local-probe')`,
      [legacyConflictHostname, "d".repeat(64)],
    );
    assert.fail("CROSS_SOURCE_DOMAIN_SCOPE_CONFLICT_MUST_FAIL");
  } catch (error) {
    assert.match(String(error.message || ""), /DOMAIN_HOSTNAME_EXISTING_SCOPE_CONFLICT/u);
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_existing_scope_conflict");

  const claimId = (await client.query(
    `INSERT INTO public.domain_claims (
       tenant_key, site_key, requested_hostname, ascii_hostname, unicode_hostname,
       claim_kind, verification_token_hash, verification_token_hint,
       expected_txt_name, created_by
     ) VALUES (
       'default','default',$1,$1,$1,'custom',$2,$3,
       '_zimeiti-domain-verification.' || $1,'codex-local-probe'
     ) RETURNING claim_id`,
    [hostname, crypto.createHash("sha256").update(`token:${suffix}`).digest("hex"), suffix.slice(-8)],
  )).rows[0].claim_id;

  await client.query("SAVEPOINT expected_duplicate_hostname");
  try {
    await client.query(
      `INSERT INTO public.domain_claims (
         tenant_key, site_key, requested_hostname, ascii_hostname, unicode_hostname,
         claim_kind, verification_token_hash, verification_token_hint,
         expected_txt_name, created_by
       ) VALUES ('default','default',$1,$1,$1,'custom',$2,$3,
         '_zimeiti-domain-verification.' || $1,'codex-local-probe')`,
      [hostname, "b".repeat(64), "duplicate"],
    );
    assert.fail("DUPLICATE_DOMAIN_MUST_FAIL");
  } catch (error) {
    assert.equal(error.code, "23505");
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_duplicate_hostname");

  await client.query("SAVEPOINT expected_reserved_domain");
  try {
    await client.query(
      `INSERT INTO public.domain_claims (
         tenant_key, site_key, requested_hostname, ascii_hostname, unicode_hostname,
         claim_kind, verification_token_hash, verification_token_hint,
         expected_txt_name, created_by
       ) VALUES ('default','default','child.example.com','child.example.com','child.example.com',
         'custom',$1,'reserved','_zimeiti-domain-verification.child.example.com','codex-local-probe')`,
      ["c".repeat(64)],
    );
    assert.fail("RESERVED_DOMAIN_MUST_FAIL");
  } catch (error) {
    assert.equal(error.code, "23514");
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_reserved_domain");

  const hostnameId = (await client.query(
    `INSERT INTO public.domain_hostnames (
       claim_id, tenant_key, site_key, ascii_hostname, hostname_kind
     ) VALUES ($1,'default','default',$2,'custom') RETURNING hostname_id`,
    [claimId, hostname],
  )).rows[0].hostname_id;
  await client.query(
    `INSERT INTO public.domain_verification_attempts (
       claim_id, hostname_id, idempotency_key, attempt_kind,
       expected_record_name, expected_value_hash
     ) VALUES ($1,$2,$3,'txt_ownership',$4,$5)`,
    [
      claimId,
      hostnameId,
      `verify-dns-${suffix}`,
      `_zimeiti-domain-verification.${hostname}`,
      crypto.createHash("sha256").update(`expected:${suffix}`).digest("hex"),
    ],
  );
  await client.query(
    `INSERT INTO public.domain_tls_probes (
       hostname_id, idempotency_key, probe_kind
     ) VALUES ($1,$2,'tls_handshake')`,
    [hostnameId, `verify-tls-${suffix}`],
  );
  const releaseId = (await client.query(
    `INSERT INTO public.site_brand_releases (
       tenant_key, site_key, release_status, metadata
     ) VALUES ('default','default','draft','{"verificationOnly":true}'::jsonb)
     RETURNING release_id`,
  )).rows[0].release_id;
  const bindingId = (await client.query(
    `INSERT INTO public.domain_brand_release_bindings (
       hostname_id, brand_release_id, tenant_key, site_key, binding_status, created_by
     ) VALUES ($1,$2,'default','default','blocked','codex-local-probe')
     RETURNING binding_id`,
    [hostnameId, releaseId],
  )).rows[0].binding_id;
  await client.query(
    `INSERT INTO public.domain_release_audits (
       idempotency_key, claim_id, hostname_id, binding_id,
       actor_id, action, result, reason_code
     ) VALUES ($1,$2,$3,$4,'codex-local-probe','foundation_recorded','recorded','DOMAIN_RUNTIME_NOT_CONNECTED')`,
    [`verify-audit-${suffix}`, claimId, hostnameId, bindingId],
  );

  await client.query("SAVEPOINT expected_runtime_activation_block");
  try {
    await client.query(
      "UPDATE public.domain_hostnames SET lifecycle_status='preview_ready' WHERE hostname_id=$1",
      [hostnameId],
    );
    assert.fail("HOST_RUNTIME_ACTIVATION_MUST_FAIL");
  } catch (error) {
    assert.equal(error.code, "23514");
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_runtime_activation_block");

  await client.query("SAVEPOINT expected_brand_activation_block");
  try {
    await client.query(
      "UPDATE public.domain_brand_release_bindings SET binding_status='published' WHERE binding_id=$1",
      [bindingId],
    );
    assert.fail("BRAND_RUNTIME_ACTIVATION_MUST_FAIL");
  } catch (error) {
    assert.equal(error.code, "23514");
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_brand_activation_block");

  await client.query("SAVEPOINT expected_immutable_evidence");
  try {
    await client.query(
      "UPDATE public.domain_verification_attempts SET details='{\"mutated\":true}'::jsonb WHERE claim_id=$1",
      [claimId],
    );
    assert.fail("DOMAIN_EVIDENCE_UPDATE_MUST_FAIL");
  } catch (error) {
    assert.match(String(error.message || ""), /DOMAIN_RELEASE_EVIDENCE_IMMUTABLE/u);
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_immutable_evidence");

  const status = (await client.query(
    "SELECT public.get_domain_tls_brand_release_status() AS status",
  )).rows[0].status;
  assert.equal(status.migration, VERSION);
  assert.equal(Number(status.tableCounts.claims), 1);
  assert.equal(Number(status.tableCounts.hostnames), 1);
  assert.equal(Number(status.tableCounts.verificationAttempts), 1);
  assert.equal(Number(status.tableCounts.tlsProbes), 1);
  assert.equal(Number(status.tableCounts.brandReleaseBindings), 1);
  assert.equal(Number(status.tableCounts.audits), 1);
  assert.equal(status.hostnames[0].ownershipStatus, "unavailable");
  assert.equal(status.hostnames[0].certificateNotAfter, null);
  assert.equal(status.runtimeBoundary.trustedHostResolutionConnected, false);
  assert.equal(status.runtimeBoundary.unknownHostHardRejectActive, false);
  assert.equal(status.runtimeBoundary.unknownHostObservedStatus, null);
  assert.equal(status.runtimeBoundary.unknownHostRequiredStatus, 421);
  assert.equal(status.runtimeBoundary.externalCallsEnabled, false);

  await client.query("SAVEPOINT expected_rollback_guard");
  try {
    await client.query(rollbackBody);
    assert.fail("ROLLBACK_EVIDENCE_GUARD_REQUIRED");
  } catch (error) {
    assert.match(String(error.message || ""), /ROLLBACK_BLOCKED_DOMAIN_RELEASE_EVIDENCE_EXISTS/u);
  }
  await client.query("ROLLBACK TO SAVEPOINT expected_rollback_guard");

  await client.query("TRUNCATE TABLE public.domain_claims CASCADE");
  await client.query(rollbackBody);
  assert.equal(await relationCount(tables), 0);

  await client.query("ROLLBACK");
  began = false;
  assert.equal(await relationCount(tables), 0, "OUTER_ROLLBACK_MUST_LEAVE_NO_DOMAIN_SCHEMA");
  const ledgerAfter = await client.query(
    "SELECT version::text FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  assert.equal(ledgerAfter.rowCount, 0);

  console.log(JSON.stringify({
    passed: true,
    mode: "local-outer-transaction-no-network",
    migration: VERSION,
    prerequisite: {
      version: PREREQUISITE_VERSION,
      persistedBeforeProbe: prerequisitePersisted,
      appliedInsideOuterTransaction: !prerequisitePersisted,
    },
    migrationSha256: migrationHash,
    rollbackSha256: rollbackHash,
    checks: {
      tables: tables.length,
      rlsEnabled: true,
      directTableAccessRevoked: true,
      serviceRoleStatusRpcOnly: true,
      asciiHostnameConstraint: true,
      reservedDomainRejected: true,
      duplicateDomainRejected: true,
      crossSourceScopeConflictRejected: true,
      unavailableEvidenceIsNull: true,
      runtimeActivationBlocked: true,
      brandActivationBlocked: true,
      immutableEvidence: true,
      unknownHostBoundaryHonest: true,
      rollbackEvidenceGuard: true,
      rollbackSql: true,
      outerRollback: true,
    },
    persisted: false,
    persistentFixtures: 0,
    migrationLedgerWrites: 0,
    externalCalls: 0,
    dnsWrites: 0,
    tlsWrites: 0,
    gatewayWrites: 0,
    formalDomainChanges: 0,
    productionWrites: 0,
  }, null, 2));
} finally {
  if (began) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
