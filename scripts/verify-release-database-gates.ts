import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
  isReleaseVerifiedVideoChannelHealth,
} from "../src/lib/video-channel-health-release";
import {
  PRODUCTION_DATABASE_CONTRACT,
  validateProductionDatabaseOpenApi,
} from "../src/lib/production-database-readiness";

const read = (file: string) => readFileSync(file, "utf8");
const contract = JSON.parse(read("deploy/policies/database-contract.v1.json")) as {
  contractVersion: string;
  requiredProbeRole: string;
  tables: Array<{ name: string; columns: string[] }>;
  rpcs: Array<{ name: string; arguments: string[] }>;
};

const table = (name: string) => contract.tables.find((entry) => entry.name === name);
const rpc = (name: string) => contract.rpcs.find((entry) => entry.name === name);

assert.equal(contract.contractVersion, "20261001070000");
assert.equal(contract.requiredProbeRole, "service_role");
const referenceCheckIds = new Set(
  (JSON.parse(read("deploy/policies/database-contract.v1.json")) as {
    referenceDataChecks?: Array<{ id: string }>;
  }).referenceDataChecks?.map((entry) => entry.id) || [],
);
for (const name of [
  "service-role-runtime",
  "voice-active-price",
  "manju-production-active-release",
  "manju-native-storage-state",
  "active-video-model-current-protocol-health",
]) assert.ok(referenceCheckIds.has(name), `database contract missing reference check ${name}`);
for (const name of [
  "extraction_attempts",
  "extraction_attempt_reconciliation_audit",
  "image_generation_requests",
  "short_drama_script_requests",
  "digital_human_long_jobs",
  "llm_request_attempts",
  "llm_request_attempt_events",
  "text_chat_conversation_settings",
  "text_chat_memories",
  "voice_training_authorization_jobs",
  "video_models",
  "video_channel_health",
  "platform_settings",
  "manju_config_storage_state",
  "payment_refund_attempts",
  "user_login_identifiers",
  "revenue_records",
]) assert.ok(table(name), `database contract missing table ${name}`);

for (const column of [
  "id", "user_id", "model_id", "task_id", "cost_price", "selling_price", "profit",
  "is_admin", "record_type", "credits_charged", "cash_charged", "created_at",
]) assert.ok(table("revenue_records")?.columns.includes(column), `revenue audit contract missing ${column}`);

assert.ok(
  table("extraction_attempts")?.columns.includes("request_snapshot"),
  "extraction failure history contract missing request_snapshot",
);
for (const column of ["id", "user_id", "state", "billing_state", "history_hidden_at", "created_at"]) {
  assert.ok(table("digital_human_long_jobs")?.columns.includes(column), `digital-human long history contract missing ${column}`);
}
for (const column of [
  "id", "user_id", "client_request_id", "request_hash", "request_snapshot", "surface", "profile_id",
  "display_title", "episode_count", "state", "result_payload", "result_hash", "billing_snapshot",
  "error_code", "error_message", "submitted_at", "updated_at", "completed_at",
]) assert.ok(table("short_drama_script_requests")?.columns.includes(column), `general-script history contract missing ${column}`);

for (const column of [
  "request_snapshot",
  "failure_hidden_at",
]) assert.ok(table("image_generation_requests")?.columns.includes(column), `image failure history contract missing ${column}`);

for (const column of [
  "refund_attempt_id",
  "provider_refund_id",
  "provider_refund_amount",
  "provider_refund_status",
  "refunded_at",
]) assert.ok(table("payment_orders")?.columns.includes(column), `payment refund order contract missing ${column}`);

for (const column of [
  "attempt_id",
  "trade_order_id",
  "user_id",
  "admin_user_id",
  "idempotency_key",
  "request_fingerprint",
  "state",
  "wallet_operation_id",
  "lease_owner",
  "lease_token",
  "provider_call_started_at",
  "provider_refund_id",
  "provider_refund_amount",
  "provider_status",
]) assert.ok(table("payment_refund_attempts")?.columns.includes(column), `payment refund attempt contract missing ${column}`);

for (const column of [
  "health_protocol_version",
  "verification_state",
  "verified_at",
  "verification_evidence",
]) assert.ok(table("video_channel_health")?.columns.includes(column), `video health contract missing ${column}`);

for (const column of [
  "provider_call_started_at",
  "provider_last_checked_at",
  "provider_last_status",
  "reconciliation_reason",
]) assert.ok(table("voice_training_authorization_jobs")?.columns.includes(column), `voice lifecycle contract missing ${column}`);

for (const name of [
  "claim_extraction_attempt_atomic",
  "finalize_extraction_attempt_atomic",
  "list_extraction_attempts_for_reconciliation",
  "reconcile_extraction_attempt_atomic",
  "checkpoint_extraction_request_atomic",
  "claim_image_generation_request_v2",
  "claim_short_drama_script_request_atomic",
  "finalize_short_drama_script_request_atomic",
  "hide_digital_human_long_history_item",
  "claim_llm_request_attempt_atomic",
  "mark_llm_request_provider_started_atomic",
  "finalize_llm_request_attempt_atomic",
  "reconcile_llm_request_attempt_atomic",
  "mark_voice_training_provider_attempt_atomic",
  "release_voice_training_terminal_atomic",
  "finalize_voice_training_ready_atomic",
  "commit_manju_config_compat_envelope",
  "reconcile_manju_config_storage_to_compat",
  "reconcile_manju_config_storage_to_native",
  "cutover_manju_config_storage",
  "claim_payment_refund_attempt_atomic",
  "mark_payment_refund_provider_started_atomic",
  "finalize_payment_refund_attempt_atomic",
  "autodl_h3_finalize_video",
]) assert.ok(rpc(name), `database contract missing RPC ${name}`);

assert.deepEqual(rpc("autodl_h3_finalize_video")?.arguments, [
  "p_job_id", "p_public_task_id", "p_video_task_internal_id", "p_user_id",
  "p_model_id", "p_upstream_task_id", "p_owner", "p_lease_token",
  "p_result_asset_url", "p_price_yuan", "p_cost_price", "p_response_ms",
]);

assert.deepEqual(rpc("claim_image_generation_request_v2")?.arguments, [
  "p_record_id", "p_user_id", "p_user_hash", "p_client_idempotency_key",
  "p_client_trace_id", "p_payload_fingerprint", "p_request_snapshot",
]);
assert.deepEqual(rpc("checkpoint_extraction_request_atomic")?.arguments, [
  "p_record_id", "p_user_id", "p_payload_fingerprint", "p_request_snapshot",
]);
assert.deepEqual(rpc("hide_digital_human_long_history_item")?.arguments, [
  "p_user_id", "p_parent_id",
]);
assert.deepEqual(rpc("claim_short_drama_script_request_atomic")?.arguments, [
  "p_user_id", "p_client_request_id", "p_request_hash", "p_request_snapshot",
  "p_surface", "p_profile_id", "p_display_title",
]);
assert.deepEqual(rpc("finalize_short_drama_script_request_atomic")?.arguments, [
  "p_user_id", "p_client_request_id", "p_request_hash", "p_state", "p_result_payload",
  "p_result_hash", "p_billing_snapshot", "p_display_title", "p_episode_count",
  "p_error_code", "p_error_message",
]);

assert.deepEqual(rpc("claim_payment_refund_attempt_atomic")?.arguments, [
  "p_attempt_id", "p_trade_order_id", "p_admin_user_id", "p_idempotency_key",
  "p_request_fingerprint", "p_reason", "p_lease_owner", "p_lease_seconds",
]);
assert.deepEqual(rpc("mark_payment_refund_provider_started_atomic")?.arguments, [
  "p_attempt_id", "p_request_fingerprint", "p_lease_owner", "p_lease_token",
]);
assert.deepEqual(rpc("finalize_payment_refund_attempt_atomic")?.arguments, [
  "p_attempt_id", "p_request_fingerprint", "p_lease_owner", "p_lease_token",
  "p_terminal_state", "p_provider_status", "p_provider_trade_order_id",
  "p_provider_refund_id", "p_provider_refund_amount", "p_provider_response",
]);

const openApiFixture = {
  paths: Object.fromEntries([
    ...PRODUCTION_DATABASE_CONTRACT.tables.map((entry) => [`/${entry.name}`, { get: {} }]),
    ...PRODUCTION_DATABASE_CONTRACT.rpcs.map((entry) => [
      `/rpc/${entry.name}`,
      { post: { requestBody: { schema: { properties: Object.fromEntries(entry.arguments.map((argument) => [argument, {}])) } } } },
    ]),
  ]),
  definitions: Object.fromEntries(PRODUCTION_DATABASE_CONTRACT.tables.map((entry) => [
    entry.name,
    { properties: Object.fromEntries(entry.columns.map((column) => [column, {}])) },
  ])),
};
assert.equal(validateProductionDatabaseOpenApi(openApiFixture).ok, true);
for (const name of ["short_drama_script_requests", "digital_human_long_jobs"]) {
  const missing = structuredClone(openApiFixture);
  delete missing.paths[`/${name}`];
  assert.ok(
    validateProductionDatabaseOpenApi(missing).missingTables.includes(name),
    `missing non-Commerce table must block readiness: ${name}`,
  );
}
for (const [tableName, column] of [
  ["extraction_attempts", "request_snapshot"],
  ["digital_human_long_jobs", "history_hidden_at"],
  ["revenue_records", "profit"],
] as const) {
  const missing = structuredClone(openApiFixture);
  delete missing.definitions[tableName].properties[column];
  assert.ok(
    validateProductionDatabaseOpenApi(missing).missingColumns.includes(`${tableName}.${column}`),
    `missing non-Commerce column must block readiness: ${tableName}.${column}`,
  );
}
for (const name of [
  "checkpoint_extraction_request_atomic",
  "hide_digital_human_long_history_item",
  "claim_short_drama_script_request_atomic",
  "finalize_short_drama_script_request_atomic",
  "autodl_h3_finalize_video",
]) {
  const missing = structuredClone(openApiFixture);
  delete missing.paths[`/rpc/${name}`];
  assert.ok(
    validateProductionDatabaseOpenApi(missing).missingRpcs.includes(name),
    `missing non-Commerce RPC must block readiness: ${name}`,
  );
}
const withoutH3CostPrice = structuredClone(openApiFixture);
delete withoutH3CostPrice.paths["/rpc/autodl_h3_finalize_video"]
  .post.requestBody.schema.properties.p_cost_price;
assert.ok(
  validateProductionDatabaseOpenApi(withoutH3CostPrice).missingRpcArguments
    .includes("autodl_h3_finalize_video.p_cost_price"),
  "missing H3 cost argument must block readiness",
);
const withoutGeneralScriptFinalizeState = structuredClone(openApiFixture);
delete withoutGeneralScriptFinalizeState.paths["/rpc/finalize_short_drama_script_request_atomic"]
  .post.requestBody.schema.properties.p_state;
assert.ok(
  validateProductionDatabaseOpenApi(withoutGeneralScriptFinalizeState).missingRpcArguments
    .includes("finalize_short_drama_script_request_atomic.p_state"),
  "missing general-script RPC argument must block readiness",
);
const withoutExtractionRpc = structuredClone(openApiFixture);
delete withoutExtractionRpc.paths["/rpc/claim_extraction_attempt_atomic"];
assert.deepEqual(
  validateProductionDatabaseOpenApi(withoutExtractionRpc).missingRpcs,
  ["claim_extraction_attempt_atomic"],
);
const withoutLlmLeaseColumn = structuredClone(openApiFixture);
delete withoutLlmLeaseColumn.definitions.llm_request_attempts.properties.lease_token;
assert.ok(
  validateProductionDatabaseOpenApi(withoutLlmLeaseColumn).missingColumns
    .includes("llm_request_attempts.lease_token"),
);
const withoutLlmClaimRpc = structuredClone(openApiFixture);
delete withoutLlmClaimRpc.paths["/rpc/claim_llm_request_attempt_atomic"];
assert.ok(
  validateProductionDatabaseOpenApi(withoutLlmClaimRpc).missingRpcs
    .includes("claim_llm_request_attempt_atomic"),
);
const withoutVideoProtocolColumn = structuredClone(openApiFixture);
delete withoutVideoProtocolColumn.definitions.video_channel_health.properties.health_protocol_version;
assert.ok(
  validateProductionDatabaseOpenApi(withoutVideoProtocolColumn).missingColumns
    .includes("video_channel_health.health_protocol_version"),
);
const withoutRefundTable = structuredClone(openApiFixture);
delete withoutRefundTable.paths["/payment_refund_attempts"];
assert.ok(
  validateProductionDatabaseOpenApi(withoutRefundTable).missingTables
    .includes("payment_refund_attempts"),
);
const withoutRefundColumn = structuredClone(openApiFixture);
delete withoutRefundColumn.definitions.payment_orders.properties.provider_refund_id;
assert.ok(
  validateProductionDatabaseOpenApi(withoutRefundColumn).missingColumns
    .includes("payment_orders.provider_refund_id"),
);
const withoutRefundRpc = structuredClone(openApiFixture);
delete withoutRefundRpc.paths["/rpc/claim_payment_refund_attempt_atomic"];
assert.ok(
  validateProductionDatabaseOpenApi(withoutRefundRpc).missingRpcs
    .includes("claim_payment_refund_attempt_atomic"),
);
const withoutRefundRpcArgument = structuredClone(openApiFixture);
delete withoutRefundRpcArgument.paths["/rpc/finalize_payment_refund_attempt_atomic"]
  .post.requestBody.schema.properties.p_provider_refund_amount;
assert.ok(
  validateProductionDatabaseOpenApi(withoutRefundRpcArgument).missingRpcArguments
    .includes("finalize_payment_refund_attempt_atomic.p_provider_refund_amount"),
);

const verified = {
  channel_id: "video-model-1",
  is_healthy: true,
  last_success_at: "2026-09-01T12:00:00.000Z",
  health_protocol_version: VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
  verification_state: "verified",
  verified_at: "2026-09-01T12:00:01.000Z",
  verification_evidence: { evidence_id: "evidence-123", task_id: "task-123456" },
};
assert.equal(isReleaseVerifiedVideoChannelHealth(verified), true);
assert.equal(isReleaseVerifiedVideoChannelHealth(null), false);
assert.equal(isReleaseVerifiedVideoChannelHealth({ ...verified, verification_state: "unverified" }), false);
assert.equal(isReleaseVerifiedVideoChannelHealth({ ...verified, health_protocol_version: "legacy" }), false);
assert.equal(isReleaseVerifiedVideoChannelHealth({ ...verified, verification_evidence: {} }), false);
assert.equal(isReleaseVerifiedVideoChannelHealth({ ...verified, verified_at: "2026-09-01T11:59:59.000Z" }), false);

const textChatMigration = read("supabase/migrations/20260825062000_text_chat_controls.sql");
assert.match(textChatMigration, /CREATE TABLE IF NOT EXISTS text_chat_conversation_settings/u);
assert.match(textChatMigration, /CREATE TABLE IF NOT EXISTS text_chat_memories/u);
const extractionMigration = read("supabase/migrations/20260901093000_extraction_attempts_exactly_once.sql");
for (const name of [
  "extraction_attempts",
  "extraction_attempt_reconciliation_audit",
  "claim_extraction_attempt_atomic",
  "finalize_extraction_attempt_atomic",
  "list_extraction_attempts_for_reconciliation",
  "reconcile_extraction_attempt_atomic",
]) assert.ok(extractionMigration.includes(name), `extraction migration missing ${name}`);
const nonCommerceRepairMigrations = [
  ["supabase/migrations/20260915231500_image_generation_failure_history.sql", [
    "request_snapshot", "failure_hidden_at", "claim_image_generation_request_v2",
  ]],
  ["supabase/migrations/20260915233000_digital_human_long_history_visibility.sql", [
    "history_hidden_at", "hide_digital_human_long_history_item",
  ]],
  ["supabase/migrations/20260915233500_extraction_request_snapshot.sql", [
    "request_snapshot", "checkpoint_extraction_request_atomic",
  ]],
  ["supabase/migrations/20260915234500_short_drama_script_history.sql", [
    "short_drama_script_requests", "claim_short_drama_script_request_atomic",
    "finalize_short_drama_script_request_atomic",
  ]],
  ["supabase/migrations/20260915235500_autodl_h3_revenue_profit.sql", [
    "autodl_h3_finalize_video", "profit", "matched_h3_revenue",
  ]],
] as const;
for (const [file, markers] of nonCommerceRepairMigrations) {
  const sql = read(file);
  assert.doesNotMatch(sql, /commerce|shopping|affiliate|带货/iu, `${file} must remain non-Commerce`);
  for (const marker of markers) assert.ok(sql.includes(marker), `${file} missing ${marker}`);
}
const llmMigration = read("supabase/migrations/20260901170000_llm_request_attempts_exactly_once.sql");
for (const name of [
  "llm_request_attempts",
  "llm_request_attempt_events",
  "claim_llm_request_attempt_atomic",
  "mark_llm_request_provider_started_atomic",
  "finalize_llm_request_attempt_atomic",
  "reconcile_llm_request_attempt_atomic",
  "provider_call_started_at",
  "lease_token",
  "reconciliation_required",
]) assert.ok(llmMigration.includes(name), `LLM exactly-once migration missing ${name}`);
const voiceMigration = read("supabase/migrations/20260901153000_voice_training_provider_lifecycle.sql");
for (const name of [
  "provider_call_started_at",
  "provider_last_checked_at",
  "provider_last_status",
  "reconciliation_reason",
  "mark_voice_training_provider_attempt_atomic",
  "release_voice_training_terminal_atomic",
  "finalize_voice_training_ready_atomic",
]) assert.ok(voiceMigration.includes(name), `voice lifecycle migration missing ${name}`);
const manjuStorageMigration = read("supabase/migrations/20260829223000_manju_config_storage_state.sql");
for (const name of [
  "manju_config_storage_state",
  "commit_manju_config_compat_envelope",
  "reconcile_manju_config_storage_to_compat",
  "reconcile_manju_config_storage_to_native",
  "cutover_manju_config_storage",
]) assert.ok(manjuStorageMigration.includes(name), `Manju storage migration missing ${name}`);

const refundMigration = read("supabase/migrations/20260904193000_payment_refund_exactly_once.sql");
for (const name of [
  "payment_refund_attempts",
  "claim_payment_refund_attempt_atomic",
  "mark_payment_refund_provider_started_atomic",
  "finalize_payment_refund_attempt_atomic",
  "payment_refund_one_active_per_order",
  "reconciliation_required",
]) assert.ok(refundMigration.includes(name), `payment refund migration missing ${name}`);
const refundRollback = read("supabase/rollbacks/20260904193000_payment_refund_exactly_once.rollback.sql");
assert.ok(refundRollback.includes("ROLLBACK_BLOCKED_PAYMENT_REFUND_EVIDENCE_EXISTS"));

const migration = read("supabase/migrations/20260901160000_video_channel_health_release_protocol.sql");
assert.match(migration, /verification_state = 'unverified'/u);
assert.match(migration, /'active_model_backfill_requires_canary'/u);
assert.match(migration, /false,\s*'video-channel-health\.v2',\s*'unverified'/u);
assert.doesNotMatch(migration, /SET\s+is_healthy\s*=\s*true/iu);
assert.doesNotMatch(migration, /verification_state\s*=\s*'verified'/iu);
assert.match(migration, /VIDEO_CHANNEL_HEALTH_DUPLICATE_CHANNEL_ID/u);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS video_channel_health_channel_unique/u);

const referenceGate = read("src/lib/production-reference-data-readiness.ts");
for (const marker of [
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
  ".from(\"video_models\")",
  ".from(\"video_channel_health\")",
  ".from(\"manju_config_storage_state\")",
  "isReleaseVerifiedVideoChannelHealth",
  "videoModelVerificationReady",
  "unverifiedVideoModelIds",
]) assert.ok(referenceGate.includes(marker), `reference-data gate missing ${marker}`);
assert.doesNotMatch(referenceGate, /const ok =[\s\S]{0,320}unverifiedVideoModelIds\.length === 0/u,
  "per-model paid acceptance must not block an unrelated whole-site release");
assert.doesNotMatch(referenceGate, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/u);
const schemaGate = read("src/lib/production-database-readiness.ts");
assert.match(schemaGate, /requiredProbeRole !== "service_role"/u);
assert.match(schemaGate, /COZE_SUPABASE_SERVICE_ROLE_KEY/u);

const releaseGate = read("src/app/api/release-readiness/route.ts");
for (const marker of [
  "serviceRoleConfigured",
  "missingManjuStorageDomainCount",
  "videoHealthProtocolVersion",
  "videoModelVerificationReady",
  "unverifiedVideoModelCount",
]) assert.ok(releaseGate.includes(marker), `release readiness output missing ${marker}`);

const runner = read("scripts/db-migration-release.mjs");
for (const marker of [
  "APPLIED_MIGRATION_HASH_DRIFT",
  "appliedMigrationHashDrifts",
  "ONLY_SELECTOR_NOT_FOUND",
  "dependencyClosureAdded",
  "already-applied-hash-verified",
]) assert.ok(runner.includes(marker), `migration runner gate missing ${marker}`);
const policy = JSON.parse(read("deploy/policies/release-policy.json")) as {
  database?: {
    excludedForwardMigrations?: string[];
    criticalMigrationOrder?: string[];
    rollbackStrategies?: Record<string, { mode?: string }>;
    nonCommerceRepairPack?: {
      planTool?: string;
      verification?: string;
      executionMode?: string;
      legacyOnlySelectorAllowed?: boolean;
      migrationCount?: number;
      objectCount?: number;
      migrations?: string[];
    };
  };
};
assert.ok(policy.database?.excludedForwardMigrations?.includes("20260822032000_aid_integration_bridge.sql"));
assert.deepEqual(policy.database?.criticalMigrationOrder?.slice(-5), [
  "20260915231500_image_generation_failure_history.sql",
  "20260915233000_digital_human_long_history_visibility.sql",
  "20260915233500_extraction_request_snapshot.sql",
  "20260915234500_short_drama_script_history.sql",
  "20260915235500_autodl_h3_revenue_profit.sql",
]);
for (const feature of ["image", "extraction", "digitalHuman", "generalScript", "h3Revenue"]) {
  assert.equal(policy.database?.rollbackStrategies?.[feature]?.mode, "forward-repair-only-after-activation");
}
assert.deepEqual(policy.database?.nonCommerceRepairPack, {
  planTool: "scripts/prepare-noncommerce-migration-pack.mjs",
  verification: "scripts/verify-noncommerce-migration-pack.ts",
  executionMode: "isolated-migration-root-with-existing-runner",
  legacyOnlySelectorAllowed: false,
  migrationCount: 5,
  objectCount: 11,
  migrations: policy.database?.criticalMigrationOrder?.slice(-5),
  requires: [
    "exact target host",
    "runner plan manifest SHA-256",
    "recoverable pre-migration backup receipt",
    "explicit apply authorization",
  ],
});

console.log(JSON.stringify({
  ok: true,
  contractVersion: contract.contractVersion,
  requiredTablesChecked: 17,
  requiredRpcsChecked: 24,
  nonCommerceRepairObjectsChecked: 11,
  nonCommerceMissingObjectBlockingCases: 12,
  videoHealthProtocolVersion: VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
  networkRequests: 0,
  databaseWrites: 0,
  paidModelCalls: 0,
}, null, 2));
