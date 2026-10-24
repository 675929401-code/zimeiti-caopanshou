#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routePath = path.join(root, "src", "app", "api", "admin", "llm-reconciliation", "route.ts");
const migrationPath = path.join(root, "supabase", "migrations", "20260901170000_llm_request_attempts_exactly_once.sql");
const contractPath = path.join(root, "src", "lib", "generated", "database-contract.ts");
const route = fs.readFileSync(routePath, "utf8");
const migration = fs.readFileSync(migrationPath, "utf8");
const generatedContract = fs.readFileSync(contractPath, "utf8");
const checks = [];

function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
}

check("admin capability is required", route.includes('authorizeAdminCapability(request, "models.manage"'));
check("step-up is required", route.includes("requireStepUp: true"));
check("actor comes from server authorization", route.includes("p_actor_user_id: authorization.actor.userId"));
check("record id and expected attempt are explicit", route.includes("p_record_id: input.recordId") && route.includes("p_expected_attempt_no: input.expectedAttemptNo"));
check("target state is explicit", route.includes("p_target_state: input.targetState"));
check("reason is explicit", route.includes("p_reason: input.reason"));
check("HTTP and evidence fields are forwarded", [
  "p_http_status: input.httpStatus",
  "p_response_headers: input.responseHeaders",
  "p_response_body: input.responseBody",
  "p_response_fingerprint: input.responseFingerprint",
  "p_result_reference: input.resultReference || null",
].every((value) => route.includes(value)));
check("atomic reconciliation RPC is called", route.includes('rpc("reconcile_llm_request_attempt_atomic"'));
check("success evidence is strict", route.includes("LLM_RECONCILIATION_SUCCESS_EVIDENCE_REQUIRED") && route.includes("httpStatus < 200"));
check("failure evidence is strict", route.includes("LLM_RECONCILIATION_FAILURE_EVIDENCE_INVALID") && route.includes("resultReference"));
check("SHA-256 fingerprint is strict", route.includes("^[a-f0-9]{64}$"));
check("fingerprint must match exact response body", route.includes("computedFingerprint !== responseFingerprint"));
check("response body has durable size bound", route.includes("MAX_RESPONSE_BODY_BYTES") && route.includes("8 * 1024 * 1024"));
check("response is redacted", route.includes("function redactedRecord") && route.includes("responseBodyBytes") && route.includes("resultReferenceHash"));
check("accounting response is read-only", route.includes("ledgerMutation: false") && route.includes("automaticRefund: false") && route.includes("automaticRetry: false"));
check("no upstream or retry/refund side effect is present", !/fetch\s*\(|axios|retry\s*\(|refund\s*\(/iu.test(route));
check("no credential environment access is present", !/process\.env|api[_-]?key|secret|password|token/iu.test(route.replace(/SENSITIVE_HEADER_PATTERN[\s\S]*?;/u, "")));
check("migration defines the RPC", migration.includes("CREATE OR REPLACE FUNCTION public.reconcile_llm_request_attempt_atomic"));
check("migration grants service role only", /REVOKE ALL ON FUNCTION public\.reconcile_llm_request_attempt_atomic[\s\S]+GRANT EXECUTE ON FUNCTION public\.reconcile_llm_request_attempt_atomic[\s\S]+TO service_role/u.test(migration));
check("generated contract contains the RPC signature", generatedContract.includes('"name": "reconcile_llm_request_attempt_atomic"') && generatedContract.includes('"p_result_reference"'));

console.log(JSON.stringify({
  kind: "admin-llm-reconciliation-contract-zero-network.v1",
  passed: true,
  checks,
  networkCalls: 0,
  providerCalls: 0,
  credentialReads: 0,
  databaseWrites: 0,
  scope: "static source and migration contract only; no route invocation or real reconciliation",
}, null, 2));
