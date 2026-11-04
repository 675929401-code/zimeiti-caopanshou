import assert from "node:assert/strict";
import test from "node:test";
import { assertFreshLlmModelValidationEvidence, LLM_MODEL_VALIDATION_MAX_AGE_MS, llmModelValidationConfigurationHash } from "../src/lib/llm-model-validation-gate";
import { assertReviewedHistoryRequest, readReviewedTextHistory, REVIEWED_HISTORY_REQUEST_KEY, REVIEWED_TEXT_HISTORY } from "../src/lib/server/text-model-reviewed-history";

const target = REVIEWED_TEXT_HISTORY;
const now = Date.parse(target.checkedAt) + 24 * 60 * 60 * 1000;
const body = { id: target.modelId, model_type: "text", reviewedHistory: {
  evidenceSha256: target.evidenceSha256, requestKey: REVIEWED_HISTORY_REQUEST_KEY,
} };
const audit = {
  id: "00000000-0000-4000-8000-000000000001", actor_id: "00000000-0000-4000-8000-000000000002",
  actor_level: "super_admin", permission_key: "models.manage", action: "accept_reviewed_text_history",
  result: "success", reason_code: "THREE_LOCAL_SETTLED_TEXT_REQUESTS", resource: target.modelId,
  request_key: REVIEWED_HISTORY_REQUEST_KEY, request_path: "/api/admin/models/activate", request_method: "POST",
  created_at: "2026-11-03T16:00:00.123456Z", metadata: { ...target },
};

function database(data: unknown, error: unknown = null) {
  let reads = 0;
  return {
    from(table: string) {
      reads++;
      assert.equal(table, "admin_governance_audit");
      return { select: () => ({ eq: (key: string, value: string) => {
        assert.equal(key, "request_key");
        assert.equal(value, REVIEWED_HISTORY_REQUEST_KEY);
        return { maybeSingle: async () => ({ data, error }) };
      } }) };
    },
    reads: () => reads,
  };
}

test("only the frozen request, digest and observation window authorize adoption", () => {
  assert.doesNotThrow(() => assertReviewedHistoryRequest(body, now));
  for (const patch of [
    { id: "another-model" }, { model_type: "video" }, { fallback: true },
    { reviewedHistory: { ...body.reviewedHistory, evidenceSha256: "a".repeat(64) } },
    { reviewedHistory: { ...body.reviewedHistory, requestKey: "a-different-key" } },
    { reviewedHistory: { ...body.reviewedHistory, checkedAt: new Date(now).toISOString() } },
  ]) assert.throws(() => assertReviewedHistoryRequest({ ...body, ...patch }, now), { code: "REVIEWED_HISTORY_REQUEST_INVALID" });
  assert.throws(() => assertReviewedHistoryRequest(body, Date.parse(target.checkedAt) + LLM_MODEL_VALIDATION_MAX_AGE_MS + 1),
    { code: "REVIEWED_HISTORY_EXPIRED" });
});

test("wrong model, current fingerprint, agent or timestamp never reads a historical receipt", async () => {
  const db = database(audit);
  for (const [model, hash, agent, time] of [
    ["other", target.configurationHash, target.agentId, now],
    [target.modelId, "a".repeat(64), target.agentId, now],
    [target.modelId, target.configurationHash, "other", now],
    [target.modelId, target.configurationHash, target.agentId, Date.parse(target.checkedAt) + LLM_MODEL_VALIDATION_MAX_AGE_MS + 1],
  ] as const) assert.equal(await readReviewedTextHistory(db, model, hash, agent, time), null);
  assert.equal(db.reads(), 0);
});

test("accepted proof carries the original event and precise adoption timestamp", async () => {
  const db = database(audit);
  const proof = await readReviewedTextHistory(db, target.modelId, target.configurationHash, target.agentId, now);
  assert.deepEqual(proof, { source: target.source, auditId: audit.id, auditCreatedAt: audit.created_at, checkedAt: target.checkedAt });
  assert.deepEqual(await readReviewedTextHistory(db, target.modelId, target.configurationHash, target.agentId, now), proof);
  assert.equal(await readReviewedTextHistory(database(null), target.modelId, target.configurationHash, target.agentId, now), null);
});

test("tampered provenance, extra metadata, future adoption or ambiguous receipts fail closed", async () => {
  for (const patch of [
    { actor_level: "admin" }, { action: "models_activate" }, { result: "allowed" }, { permission_key: "agents.manage" },
    { metadata: { ...target, settledCount: 2 } }, { metadata: { ...target, evidenceSha256: "0".repeat(64) } },
    { metadata: { ...target, extra: true } }, { created_at: "2099-01-01T00:00:00Z" },
  ]) {
    await assert.rejects(readReviewedTextHistory(database({ ...audit, ...patch }), target.modelId, target.configurationHash, target.agentId, now),
      { code: "REVIEWED_HISTORY_AUDIT_MISMATCH" });
  }
  await assert.rejects(readReviewedTextHistory(database(null, { code: "MULTIPLE_ROWS" }), target.modelId, target.configurationHash, target.agentId, now),
    { code: "REVIEWED_HISTORY_READ_FAILED" });
});

test("ordinary saved-probe acceptance retains its distinct format", () => {
  const binding = { id: "synthetic-model", model_name: "synthetic-text", api_endpoint: "https://fixture.invalid" };
  const hash = llmModelValidationConfigurationHash(binding, "fixture-key");
  assert.equal(assertFreshLlmModelValidationEvidence(binding, "fixture-key",
    { model_id: binding.id, checked_at: target.checkedAt, configuration_hash: hash }, now).checkedAt, target.checkedAt);
  // A governance audit row cannot be consumed as an instruction-test record.
  assert.throws(() => assertFreshLlmModelValidationEvidence(binding, "fixture-key", { checked_at: audit.created_at }, now),
    { code: "TEXT_MODEL_VALIDATION_EVIDENCE_REQUIRED" });
});
