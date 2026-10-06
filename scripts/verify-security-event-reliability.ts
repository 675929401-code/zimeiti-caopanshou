import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeReliableSecurityPath,
  parseReliableSecurityEvent,
  parseReliableSecurityIdempotencyKey,
  redactReliableSecurityText,
  SecurityEventReliabilityValidationError,
} from "../src/lib/security-event-reliability-contracts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  migration: join(projectRoot, "supabase/migrations/20261002190000_security_event_reliability.sql"),
  rollback: join(projectRoot, "supabase/rollbacks/20261002190000_security_event_reliability.rollback.sql"),
  contract: join(projectRoot, "src/lib/security-event-reliability-contracts.ts"),
  domain: join(projectRoot, "src/lib/server/security-event-reliability.ts"),
  producer: join(projectRoot, "src/lib/server/security-event-producer.ts"),
  receiver: join(projectRoot, "src/app/api/admin/security-events/internal/route.ts"),
  status: join(projectRoot, "src/app/api/admin/security-events/reliability/route.ts"),
};

const files = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => [key, readFileSync(path, "utf8")]),
) as Record<keyof typeof paths, string>;

function includesAll(haystack: string, values: string[], label: string): void {
  for (const value of values) {
    assert.ok(haystack.includes(value), `${label} is missing ${value}`);
  }
}

const rawSecretText = [
  "password=NeverStoreMe",
  '"access_token":"opaque-token-value"',
  "Authorization: Basic hidden-value",
  "Cookie: sid=private; refresh=also-private",
  "Bearer abcdefghijklmnopqrstuvwxyz",
  "postgresql://admin:secret@db.example/app",
  "https://asset.example/file?X-Amz-Signature=abcdef123456&safe=1",
  "owner@example.com",
  "+8613812345678",
  "192.168.10.8",
  "0123456789abcdef0123456789abcdef",
].join("\n");
const redacted = redactReliableSecurityText(rawSecretText, 2_000);
for (const forbidden of [
  "NeverStoreMe",
  "opaque-token-value",
  "hidden-value",
  "private",
  "also-private",
  "abcdefghijklmnopqrstuvwxyz",
  "admin:secret",
  "abcdef123456",
  "owner@example.com",
  "13812345678",
  "192.168.10.8",
  "0123456789abcdef0123456789abcdef",
]) {
  assert.ok(!redacted.includes(forbidden), `redaction leaked ${forbidden}`);
}
includesAll(redacted, ["[REDACTED_SECRET]", "[REDACTED_CONNECTION]", "[REDACTED_QUERY]"], "redaction");

assert.equal(
  normalizeReliableSecurityPath("/api/users/123456/profile/123e4567-e89b-12d3-a456-426614174000?token=secret#fragment"),
  "/api/users/:id/profile/:uuid",
);
assert.equal(parseReliableSecurityIdempotencyKey(" event-key:12345678 "), "event-key:12345678");
assert.throws(
  () => parseReliableSecurityIdempotencyKey("short"),
  (error: unknown) => error instanceof SecurityEventReliabilityValidationError
    && error.code === "SECURITY_EVENT_IDEMPOTENCY_KEY_INVALID",
);
assert.throws(
  () => parseReliableSecurityEvent({ event_type: "api_abuse", unexpected_secret: "no" }),
  (error: unknown) => error instanceof SecurityEventReliabilityValidationError
    && error.code === "SECURITY_EVENT_FIELD_UNKNOWN",
);
const parsed = parseReliableSecurityEvent({
  event_type: "api_abuse",
  risk_level: "high",
  ip: "203.0.113.9",
  user_agent: "Verifier/1.0",
  path: "/api/private?signature=must-not-persist",
  method: "post",
  details: "password=must-not-persist; email=owner@example.com",
  blocked: true,
  source: "api_direct",
  user_id: "user-123",
});
assert.equal(parsed.path, "/api/private");
assert.equal(parsed.method, "POST");
assert.ok(!parsed.details.includes("must-not-persist"));
assert.equal(parsed.actorReference, "user-123");

const migrationTables = [
  "security_event_retention_policies",
  "security_event_outbox",
  "security_event_delivery_attempts",
  "security_event_dead_letters",
  "security_rate_limit_windows",
  "security_ip_risk_state",
];
for (const table of migrationTables) {
  includesAll(files.migration, [
    `CREATE TABLE IF NOT EXISTS public.${table}`,
    `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
    `REVOKE ALL ON public.${table} FROM PUBLIC,anon,authenticated,service_role`,
    `GRANT SELECT ON public.${table} TO service_role`,
  ], table);
  assert.ok(files.rollback.includes(`DROP TABLE IF EXISTS public.${table}`), `rollback does not drop ${table}`);
}

includesAll(files.migration, [
  "UNIQUE(event_fingerprint,dedupe_bucket_start)",
  "event_key character varying(64) NOT NULL UNIQUE",
  "status text NOT NULL DEFAULT 'pending'",
  "status IN ('pending','processing','retry','materialized','dead_letter')",
  "FOR UPDATE SKIP LOCKED",
  "SECURITY_EVENT_IDEMPOTENCY_CONFLICT",
  "security_event_delivery_attempts",
  "security_event_dead_letters",
  "p_success boolean",
  "p_retry_delay_seconds",
  "locked_until<=clock_timestamp()",
  "'producerDeliveryDurable',false",
  "'preReceiverLossObservable',false",
  "'retryWorkerScheduled',false",
  "'retentionPolicyConfigured',true",
  "'retentionPurgeExecutorAvailable',false",
  "'scope','receiver_after_authentication'",
  "privacy_version = 'masked-v1'",
  "retention_until",
  "security_reliability_text_is_safe",
  "GRANT EXECUTE ON FUNCTION public.enqueue_security_event_atomic",
  "GRANT EXECUTE ON FUNCTION public.consume_security_rate_limit_atomic",
], "migration");

const outboxDefinition = files.migration.match(
  /CREATE TABLE IF NOT EXISTS public\.security_event_outbox \(([\s\S]*?)\n\);/u,
)?.[1];
assert.ok(outboxDefinition, "outbox definition not found");
includesAll(outboxDefinition, ["ip_hash", "actor_ref_hash", "user_agent_hash"], "masked outbox");
for (const forbiddenColumn of ["ip_address", "username", "display_name", "phone", "raw_data", "password", "cookie", "token"]) {
  assert.ok(!new RegExp(`^\\s*${forbiddenColumn}\\s`, "imu").test(outboxDefinition), `outbox exposes ${forbiddenColumn}`);
}

includesAll(files.rollback, [
  "SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_OUTBOX",
  "SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_ATTEMPTS",
  "SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_DEAD_LETTERS",
  "SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_RATE_STATE",
  "SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_EMPTY_IP_STATE",
  "SECURITY_EVENT_RELIABILITY_ROLLBACK_REQUIRES_NO_MATERIALIZED_EVENTS",
  "DROP FUNCTION IF EXISTS public.enqueue_security_event_atomic",
  "DROP COLUMN IF EXISTS reliable_ingest_id",
], "rollback");

includesAll(files.domain, [
  "createHmac",
  "enqueue_security_event_atomic",
  "claim_security_event_outbox_batch",
  "settle_security_event_outbox_attempt",
  "p_success: false",
  'p_error_summary: "Materialization unavailable"',
  "proxy_producer_bounded_retry_has_no_durable_pre_receiver_spool",
  "legacy_server_logSecurityEvent_still_writes_directly",
  "locked_proxy_still_uses_process_local_rate_and_ip_state",
  "legacy_security_events_may_contain_unmasked_pii",
  "outbox_retry_worker_not_scheduled",
  "retention_purge_executor_not_connected",
], "server domain");

includesAll(files.domain, [
  "getSecurityEventProducerConfigurationStatus",
  "producerConfiguration",
], "producer configuration status");

includesAll(files.producer, [
  'import "server-only"',
  'getServerSecret("SECURITY_INTERNAL_KEY")',
  "SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS = 3",
  '"Idempotency-Key"',
  "lifecycle.waitUntil(completion)",
  "SECURITY_EVENT_LIFECYCLE_MISSING",
  "SECURITY_EVENT_DELIVERY_NETWORK_ERROR",
  "SECURITY_EVENT_DELIVERY_TIMEOUT",
], "producer delivery");
assert.ok(!files.producer.includes("JWT_SECRET"), "producer must not reuse JWT_SECRET");
assert.ok(!files.producer.includes("agent-hub-secret-key-2024"), "producer must not contain a development fallback secret");

includesAll(files.receiver, [
  "parseReliableSecurityEvent",
  "parseReliableSecurityIdempotencyKey",
  "acceptReliableSecurityEvent",
  "accepted: true",
  "durable: true",
  "materialized: true",
  "retryPending: true",
  "deadLettered: true",
  "accepted: false",
  "durable: false",
  "coverageScope: \"receiver_after_authentication\"",
], "receiver route");
assert.ok(!files.receiver.includes('.from("security_events")'), "receiver still writes security_events directly");
assert.ok(!files.receiver.includes("success: true"), "receiver uses ambiguous legacy success response");

includesAll(files.status, [
  'authorizeAdminCapability(request, "security.view"',
  'operation: "security_event_reliability_status_read"',
  "auditAllowed: true",
  'phase: "receiver_reliability_v1"',
  "complete: false",
], "status route");

for (const [key, contents] of Object.entries(files)) {
  assert.ok(!/^(?:<{7}|={7}|>{7})/mu.test(contents), `${key} contains merge markers`);
  assert.ok(!/[ \t]+$/mu.test(contents), `${key} contains trailing whitespace`);
}

console.log(JSON.stringify({
  ok: true,
  schema: "security-event-reliability-verification/v1",
  checkedFiles: Object.keys(paths).length,
  redaction: true,
  idempotency: true,
  rlsAndPrivileges: true,
  receiverTruthfulness: true,
  explicitIntegrationGaps: true,
}));
