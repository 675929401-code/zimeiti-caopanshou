import assert from "node:assert/strict";
import {
  VIDEO_MODEL_SUBMISSION_PAUSED,
  VIDEO_CAPABILITIES_UNVERIFIED,
  videoOperatorSubmissionAdmission,
} from "../src/lib/video-model-availability";

const ready = { ready: true, code: "", message: "" };
const savedFetch = globalThis.fetch;
let networkCalls = 0;
let checks = 0;

async function main() {
  globalThis.fetch = async () => { networkCalls++; throw new Error("ZERO_NETWORK_REQUIRED"); };
  try {
    for (const config of [undefined, null, "true", true, 1, [], {}, { generation_paused: false }, { generation_paused: "true" }, { generation_paused: 1 }, { generation_paused: null }]) {
      assert.deepEqual(videoOperatorSubmissionAdmission(config), ready); checks++;
    }
    for (const config of [
      { provider_billing_unit: "token", billing_unit: "token", public_billing_pending: true },
      { protocol_type: "gaorui_video", model_name: "seedance-2.0-fast", min_duration: 4, max_duration: 15 },
      { balance: 0, healthRecorded: true, is_healthy: false, circuit_state: "open", last_error: "GROUP_DELETED" },
      { generation_paused: false, balance: 0, circuit_state: "funding_required" },
    ]) {
      assert.deepEqual(videoOperatorSubmissionAdmission(Object.freeze(config)), ready); checks++;
    }
    for (const config of [
      { generation_paused: true },
      { generation_paused: true, provider_billing_unit: "token", billing_unit: "token" },
      { generation_paused: true, protocol_type: "secure_skill_kling_video", pause_reason: "fixture-internal-provider-detail" },
    ]) {
      const before = JSON.stringify(config);
      const decision = videoOperatorSubmissionAdmission(Object.freeze(config));
      assert.equal(decision.ready, false); assert.equal(decision.code, VIDEO_MODEL_SUBMISSION_PAUSED);
      assert.equal(decision.message, "该模型已暂停提交，请选择其他模型");
      assert.ok(!decision.message.includes("fixture-internal-provider-detail"));
      assert.equal(JSON.stringify(config), before); checks++;
    }
    assert.deepEqual(videoOperatorSubmissionAdmission(Object.create({ generation_paused: true })), ready); checks++;
    const malformedArray = Object.assign([], { generation_paused: true });
    assert.deepEqual(videoOperatorSubmissionAdmission(malformedArray), ready); checks++;
    const accessor = Object.defineProperty({}, "generation_paused", { get() { throw new Error("CONFIG_ACCESSOR_MUST_NOT_EXECUTE"); } });
    assert.deepEqual(videoOperatorSubmissionAdmission(accessor), ready); checks++;
    const explicit = Object.assign(Object.create(null), { generation_paused: true });
    assert.equal(videoOperatorSubmissionAdmission(explicit).code, VIDEO_MODEL_SUBMISSION_PAUSED); checks++;
    for (const config of [
      { capability_contract_verified: false },
      { capability_contract_verified: false, generation_paused: false },
      { capability_contract_verified: false, generation_paused: true, configuration_pending_reason: "private fixture diagnostic" },
    ]) {
      const decision = videoOperatorSubmissionAdmission(Object.freeze(config));
      assert.equal(decision.ready, false); assert.equal(decision.code, VIDEO_CAPABILITIES_UNVERIFIED);
      assert.equal(decision.message, "模型能力待核验，暂不可提交"); checks++;
    }
    for (const config of [
      { capability_contract_verified: true }, { capability_contract_verified: "false" },
      Object.create({ capability_contract_verified: false }),
      Object.defineProperty({}, "capability_contract_verified", { get() { throw new Error("CONFIG_ACCESSOR_MUST_NOT_EXECUTE"); } }),
    ]) { assert.deepEqual(videoOperatorSubmissionAdmission(config), ready); checks++; }
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = savedFetch; }
  console.log(JSON.stringify({ passed: true, checks, networkCalls, providerCalls: 0, databaseWrites: 0, scope: "explicit own boolean operator switch only; malformed/false/inherited/getter/unrelated health/token/native remain independent" }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
