import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  SecurityCaseValidationError,
  parseSecurityCaseActionRequest,
  parseSecurityCaseIngestRequest,
  parseSecurityCaseMutationRequest,
  redactSecurityCaseText,
} from "../src/lib/security-case-contracts";

async function main(): Promise<void> {
const VERSION = "20261002160000";
const files = {
  migration: path.resolve("supabase/migrations", `${VERSION}_security_case_control_plane.sql`),
  rollback: path.resolve("supabase/rollbacks", `${VERSION}_security_case_control_plane.rollback.sql`),
  contracts: path.resolve("src/lib/security-case-contracts.ts"),
  domain: path.resolve("src/lib/server/security-case-control-plane.ts"),
  listRoute: path.resolve("src/app/api/admin/security-events/cases/route.ts"),
  detailRoute: path.resolve("src/app/api/admin/security-events/cases/[id]/route.ts"),
  actionRoute: path.resolve("src/app/api/admin/security-events/cases/[id]/actions/route.ts"),
  localProbe: path.resolve("scripts/test-security-case-control-plane-local.mjs"),
};

const sources = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await fs.readFile(file, "utf8")] as const)),
) as Record<keyof typeof files, string>;

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length;
}

function expectValidationFailure(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof SecurityCaseValidationError && error.code === code);
}

for (const [key, source] of Object.entries(sources)) {
  assert.equal(source.includes("<<<<<<<"), false, `${key}:MERGE_MARKER_FORBIDDEN`);
  assert.equal(source.includes(">>>>>>>"), false, `${key}:MERGE_MARKER_FORBIDDEN`);
  assert.equal(source.split(/\r?\n/u).some((line) => /[ \t]+$/u.test(line)), false, `${key}:TRAILING_WHITESPACE_FORBIDDEN`);
}

assert.match(sources.migration, /^BEGIN;\s*/u);
assert.match(sources.migration, /\sCOMMIT;\s*$/u);
assert.match(sources.rollback, /^BEGIN;\s*/u);
assert.match(sources.rollback, /\sCOMMIT;\s*$/u);

for (const table of [
  "security_cases",
  "security_case_events",
  "security_case_links",
  "security_case_actions",
  "security_case_audit",
]) {
  assert.match(sources.migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, "u"));
  assert.match(sources.migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "u"));
  assert.match(sources.migration, new RegExp(`REVOKE ALL ON public\\.${table} FROM PUBLIC, anon, authenticated, service_role`, "u"));
  assert.match(sources.migration, new RegExp(`GRANT SELECT ON public\\.${table} TO service_role`, "u"));
  assert.match(sources.rollback, new RegExp(`DROP TABLE IF EXISTS public\\.${table}`, "u"));
}

assert.match(sources.migration, /CREATE UNIQUE INDEX IF NOT EXISTS security_cases_active_fingerprint_unique[\s\S]*WHERE status NOT IN \('resolved', 'false_positive'\)/u);
assert.match(sources.migration, /UNIQUE \(source_kind, source_event_id\)/u);
assert.match(sources.migration, /pg_advisory_xact_lock\(hashtextextended\('security-source:'/u);
assert.match(sources.migration, /pg_advisory_xact_lock\(hashtextextended\('security-case:'/u);
assert.match(sources.migration, /v_case\.revision <> p_expected_revision/u);
assert.match(sources.migration, /v_case\.status <> 'triaged' OR v_case\.assigned_to IS NOT NULL/u);
assert.match(sources.migration, /status text NOT NULL DEFAULT 'pending_executor'/u);
assert.match(sources.migration, /execution_supported boolean NOT NULL DEFAULT false CHECK \(execution_supported = false\)/u);
assert.match(sources.migration, /p_impact_preview->>'actionType' IS DISTINCT FROM p_action_type/u);
assert.match(sources.migration, /p_impact_preview->>'targetRef' IS DISTINCT FROM p_target_ref/u);
assert.match(sources.migration, /v_action\.case_id <> p_case_id/u);
assert.match(sources.migration, /SECURITY_CASE_AUDIT_IMMUTABLE/u);
assert.match(sources.migration, /SECURITY_CASE_EVIDENCE_IMMUTABLE/u);
assert.equal(count(sources.migration, /PERFORM set_config\('app\.security_case_write', coalesce\(v_prior_write, ''\), true\)/gu), 6);

for (const rpc of [
  "ingest_security_case_event_atomic",
  "transition_security_case_atomic",
  "claim_security_case_atomic",
  "link_security_case_entity_atomic",
  "request_security_case_action_atomic",
  "cancel_security_case_action_atomic",
]) {
  assert.match(sources.migration, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${rpc}\\(`, "u"));
  assert.match(sources.migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\(`, "u"));
  assert.match(sources.migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`, "u"));
  assert.match(sources.rollback, new RegExp(`DROP FUNCTION IF EXISTS public\\.${rpc}\\(`, "u"));
}

assert.match(sources.rollback, /SECURITY_CASE_ROLLBACK_REQUIRES_EMPTY_CASES/u);
assert.match(sources.rollback, /SECURITY_CASE_ROLLBACK_REQUIRES_EMPTY_AUDIT/u);

for (const route of [sources.listRoute, sources.detailRoute, sources.actionRoute]) {
  assert.match(route, /authorizeAdminCapability/u);
  assert.match(route, /Cache-Control": "private, no-store/u);
  assert.match(route, /appendAdminGovernanceAudit/u);
}
assert.match(sources.listRoute, /"security\.view"/u);
assert.match(sources.listRoute, /"security\.manage"[\s\S]*requireStepUp: true/u);
assert.match(sources.detailRoute, /"security\.view"/u);
assert.match(sources.detailRoute, /"security\.manage"[\s\S]*requireStepUp: true/u);
assert.match(sources.actionRoute, /"security\.manage"[\s\S]*requireStepUp: true/u);
assert.match(sources.actionRoute, /status: "pending_executor"/u);
assert.match(sources.actionRoute, /executed: false/u);
assert.match(sources.actionRoute, /caseId,[\s\n]+actionId: action\.actionId/u);

assert.match(sources.domain, /select\("id,event_type,risk_level,ip_hash,user_id,path,method,blocked,source,created_at"\)/u);
assert.match(sources.domain, /select\("id,user_id,agent_name,agent_source,risk_level,reason,blocked_at"\)/u);
assert.match(sources.domain, /select\("id,user_id,status,fail_reason,login_method,created_at"\)/u);
assert.match(sources.domain, /select\("id,trace_id,user_id,source,domain,operation,phase,outcome,route,error_code,error_fingerprint,occurred_at"\)/u);
assert.match(sources.domain, /executorAvailable: false/u);
assert.match(sources.domain, /destructiveExecutionEnabled: false/u);
assert.match(sources.domain, /p_case_id: params\.caseId/u);

const implementation = `${sources.migration}\n${sources.domain}\n${sources.listRoute}\n${sources.detailRoute}\n${sources.actionRoute}`;
assert.doesNotMatch(implementation, /revoke_user_auth_session\s*\(/iu, "SESSION_EXECUTOR_CALL_FORBIDDEN");
assert.doesNotMatch(implementation, /UPDATE\s+public\.user_auth_sessions\b/iu, "SESSION_MUTATION_FORBIDDEN");
assert.doesNotMatch(implementation, /UPDATE\s+public\.users\b/iu, "USER_MUTATION_FORBIDDEN");
assert.doesNotMatch(implementation, /\.from\(["']users["']\)\s*\.update\s*\(/iu, "USER_UPDATE_CLIENT_FORBIDDEN");
assert.doesNotMatch(implementation, /\.from\(["']user_auth_sessions["']\)\s*\.update\s*\(/iu, "SESSION_UPDATE_CLIENT_FORBIDDEN");

assert.deepEqual(parseSecurityCaseIngestRequest({ sourceKind: "security_event", sourceEventId: "event-123" }), {
  sourceKind: "security_event",
  sourceEventId: "event-123",
});
expectValidationFailure(
  () => parseSecurityCaseIngestRequest({ sourceKind: "security_event", sourceEventId: "event-123", rawData: "secret" }),
  "SECURITY_CASE_FIELD_UNKNOWN",
);
assert.equal(parseSecurityCaseMutationRequest({
  operation: "claim",
  expectedRevision: 2,
  reason: "领取案件进行复核",
}).operation, "claim");
expectValidationFailure(
  () => parseSecurityCaseMutationRequest({ operation: "transition", expectedRevision: 2, targetStatus: "assigned", reason: "跳过认领" }),
  "SECURITY_CASE_OPERATION_INVALID",
);
expectValidationFailure(
  () => parseSecurityCaseActionRequest({
    operation: "request",
    expectedRevision: 3,
    actionType: "delete_user",
    targetRef: "user-123",
    reason: "危险动作",
  }),
  "SECURITY_CASE_ACTION_NOT_ALLOWED",
);
assert.equal(parseSecurityCaseActionRequest({
  operation: "preview",
  expectedRevision: 3,
  actionType: "revoke_session",
  targetRef: "session-123",
  reason: "检查单条会话影响",
}).operation, "preview");

const redacted = redactSecurityCaseText(
  "password=hunter2 Authorization: Bearer abcdefghijklmnop postgresql://owner:secret@127.0.0.1/db?token=xyz",
);
assert.doesNotMatch(redacted, /hunter2|abcdefghijklmnop|owner:secret|token=xyz/u);

console.log(JSON.stringify({
  passed: true,
  migration: VERSION,
  checks: {
    tables: 5,
    rlsTables: 5,
    rpcCount: 6,
    fingerprintDedupe: true,
    casClaim: true,
    immutableEvidenceAndAudit: true,
    allowlistedRequestOnly: true,
    destructiveExecutors: 0,
    strictContractExamples: 6,
  },
}, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
