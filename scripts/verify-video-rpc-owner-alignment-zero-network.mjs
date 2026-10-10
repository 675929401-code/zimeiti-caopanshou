#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("NETWORK_FORBIDDEN_IN_VIDEO_RPC_OWNER_ALIGNMENT_TEST");
};

const read = file => readFile(file, "utf8");
const digest = value => createHash("sha256").update(value).digest("hex");
const migrationPath = "supabase/migrations/20261010132000_video_snapshot_function_owner_alignment.sql";
const rollbackPath = "supabase/rollbacks/20261010132000_video_snapshot_function_owner_alignment.rollback.sql";
const [migration, rollback, applier, readiness, releaseGate, contractSource, policySource] = await Promise.all([
  read(migrationPath),
  read(rollbackPath),
  read("scripts/apply-video-rpc-owner-alignment-local.mjs"),
  read("scripts/verify-video-request-snapshot-readiness-local.mjs"),
  read("scripts/verify-release-database-gates.ts"),
  read("deploy/policies/database-contract.v1.json"),
  read("deploy/policies/release-policy.json"),
]);
const migrationHash = digest(migration);
const contract = JSON.parse(contractSource);
const policy = JSON.parse(policySource);
const signatures = [
  "public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text)",
  "public.reserve_video_generation_task_request_snapshot_v1_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)",
  "public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)",
];

assert.match(migration, /^begin;/u);
assert.match(migration, /commit;\s*$/u);
assert.match(migration, /'public\.video_tasks'::regclass/u);
assert.match(migration, /select relation\.relowner, pg_get_userbyid\(relation\.relowner\)/u);
assert.match(migration, /alter function %s owner to %I/u);
assert.match(migration, /alter function %s security definer/u);
assert.match(migration, /alter function %s set search_path = public, pg_temp/u);
assert.match(migration, /revoke all on function %s from public, anon, authenticated, service_role/u);
assert.match(migration, /grant execute on function %s to service_role/u);
assert.match(migration, /acl\.grantee not in \(procedure\.proowner, v_service_role\)/u);
assert.match(migration, /not role_entry\.rolsuper/u);
assert.match(migration, /has_function_privilege\(role_entry\.oid, to_regprocedure\(v_signature\), 'EXECUTE'\)/u);
assert.match(migration, /VIDEO_SNAPSHOT_UNEXPECTED_EFFECTIVE_EXECUTE/u);
for (const signature of signatures) assert.ok(migration.includes(signature), `migration missing ${signature}`);
assert.doesNotMatch(migration, /\b(?:insert|update|delete|truncate)\s+(?:into\s+|from\s+)?public\.video_tasks\b/iu);

assert.match(rollback, /^begin;/u);
assert.match(rollback, /commit;\s*$/u);
assert.match(rollback, /Forward-repair-only rollback guard/u);
assert.match(rollback, /VIDEO_SNAPSHOT_SECURITY_DEFINER_OWNER_ALIGNMENT_REQUIRED/u);
assert.match(rollback, /VIDEO_SNAPSHOT_EXECUTE_ACL_REQUIRED/u);
assert.match(rollback, /VIDEO_SNAPSHOT_UNEXPECTED_EFFECTIVE_EXECUTE/u);
assert.doesNotMatch(rollback, /delete\s+from\s+supabase_migrations\.schema_migrations/iu);
assert.doesNotMatch(rollback, /\b(?:alter|drop|create|grant|revoke|insert|update|delete|truncate)\b/iu);

assert.match(applier, /const VERSION = "20261010132000"/u);
assert.match(applier, /const TARGET = "127\.0\.0\.1:54322\/zimeiti_local"/u);
assert.match(applier, /--confirm-local-video-rpc-owner-alignment-only/u);
assert.match(applier, /MIGRATION_LEDGER_HASH_CONFLICT/u);
assert.match(applier, /pg_advisory_xact_lock\(hashtextextended\('video-rpc-owner-alignment:20261010132000',0\)\)/u);
assert.match(applier, /flag: "wx"/u);
assert.match(applier, /unexpectedEffectiveGrantees\.length === 0/u);
assert.match(applier, /providerCalls: 0/u);
assert.match(applier, /billingOperations: 0/u);
assert.equal(applier.includes("fetch("), false);

assert.match(readiness, /const BASE_VERSION = "20261010023000"/u);
assert.match(readiness, /const ALIGNMENT_VERSION = "20261010132000"/u);
assert.match(readiness, /ledgerHashMatches/u);
assert.match(readiness, /unexpectedEffectiveGrantees\.length === 0/u);
assert.match(readiness, /writes: 0/u);
assert.match(readiness, /providerCalls: 0/u);
assert.match(readiness, /billingOperations: 0/u);

assert.equal(contract.contractVersion, "20261010132000");
const required1320 = contract.liveCatalogChecks.migrationLedger.requiredMigrations
  .find(entry => entry.version === "20261010132000");
assert.equal(required1320?.file, migrationPath);
assert.equal(required1320?.sha256, migrationHash);
const videoGroup = contract.liveCatalogChecks.functionSecurityGroups
  .find(group => group.id === "video-generation-request-snapshot");
assert.equal(videoGroup?.ownerRelation, "public.video_tasks");
assert.deepEqual(videoGroup?.requiredNonOwnerExecuteGrantees, ["service_role"]);
assert.deepEqual(videoGroup?.allowedEffectiveExecutePrincipals, ["relation_owner", "service_role"]);
assert.deepEqual(videoGroup?.functions, signatures);
assert.equal(videoGroup?.superuserInherentPrivilegeExcluded, true);
assert.ok(contract.rollbackArtifacts.some(entry => entry.forwardMigration === migrationPath
  && entry.rollback === rollbackPath && entry.mode === "forward-repair-only"));

assert.ok(policy.database.criticalMigrationOrder.includes("20261010023000_video_generation_request_snapshot_v1.sql"));
assert.equal(policy.database.criticalMigrationOrder.at(-1), "20261010132000_video_snapshot_function_owner_alignment.sql");
assert.equal(policy.database.rollbackStrategies.videoSnapshotSecurity.mode, "forward-repair-only-after-activation");
assert.match(policy.database.liveCatalogVerification.requires.join("\n"), /three video request snapshot RPC owners/u);
assert.match(policy.database.liveCatalogVerification.requires.join("\n"), /no ordinary role other than owner\/service_role has effective EXECUTE/u);
assert.match(releaseGate, /FUNCTION_UNEXPECTED_EFFECTIVE_EXECUTE/u);
assert.match(releaseGate, /video-generation-request-snapshot/u);
assert.equal(networkCalls, 0);

console.log(JSON.stringify({
  passed: true,
  assertions: 58,
  migration: migrationPath,
  migrationSha256: migrationHash,
  authoritativeOwnerRelation: "public.video_tasks",
  functionCount: signatures.length,
  networkCalls,
  databaseCalls: 0,
  databaseWrites: 0,
  providerCalls: 0,
  billingOperations: 0,
  filesystemWrites: 0,
}, null, 2));
