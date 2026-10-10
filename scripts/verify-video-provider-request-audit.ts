import assert from "node:assert/strict";
import { videoProviderRequestReceipt, videoProviderFetch, withVideoProviderRequestAudit } from "../src/lib/video-provider-request-audit";
import { videoHealthAfterOutcome, videoHealthVerificationAfterOutcome } from "../src/lib/video-terminal-accounting";
import { boundVideoTaskModel, reconcileVideoModelSelection, videoModelInputHint } from "../src/lib/video-model-selection-state";
import { classifyVideoProviderError } from "../src/lib/video-error-policy";

async function main() {
const receipt = videoProviderRequestReceipt("https://provider.example/v1/videos?key=secret", {
  method: "POST", headers: { Authorization: "secret" },
  body: JSON.stringify({ model: "omni_flash", prompt: "private", image: "https://private/image?signature=secret" }),
});
assert.deepEqual(receipt, { endpointHost: "provider.example", submittedModel: "omni_flash", submittedWorkflow: null });
assert.equal(videoProviderRequestReceipt("https://provider.example/v1/h3/videos", { method: "POST", body: JSON.stringify({ model: "MiniMax-H3 2K" }) })?.submittedModel, "MiniMax-H3 2K");
assert.equal(classifyVideoProviderError("download video failed HTTP 403").category, "asset_input");
assert.equal(classifyVideoProviderError("所属专属分组不再允许当前用户使用 HTTP 403").category, "authentication");
assert.equal(classifyVideoProviderError("Grok Imagine 1.5 必须提供参考图片").code, "VIDEO_REFERENCE_REQUIRED");
assert.equal(videoProviderRequestReceipt("https://provider.example/result?id=private", { method: "GET" }), null);
assert.deepEqual(videoProviderRequestReceipt("https://provider.example/comfyui/comfyui_workflow/h3_v5", { method: "POST", body: "{}" }), {
  endpointHost: "provider.example", submittedModel: null, submittedWorkflow: "h3_v5",
});
assert.deepEqual(videoProviderRequestReceipt("https://provider.example/materials", { method: "POST", body: JSON.stringify({ url: "private" }) }), {
  endpointHost: "provider.example", submittedModel: null, submittedWorkflow: null,
}, "a provider POST without a model field is still a dispatch and must not be misclassified as local-only failure");
const originalFetch = globalThis.fetch;
const actualBodies: unknown[] = [];
try {
  globalThis.fetch = (async (input, init) => {
    actualBodies.push(input instanceof Request ? await input.clone().text() : init?.body);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const captured: Record<string, string[]> = { a: [], b: [] };
  await Promise.all(["a", "b"].map((model) => withVideoProviderRequestAudit(async (item) => { captured[model].push(item.submittedModel!); }, async () => {
    await Promise.resolve();
    const body = JSON.stringify({ model, prompt: "unchanged" });
    const result = await videoProviderFetch("https://provider.example/v1/videos", { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(result.status, 200); assert.ok(actualBodies.includes(body));
  })));
  assert.deepEqual(captured, { a: ["a"], b: ["b"] }, "concurrent tasks keep separate routing evidence");
} finally { globalThis.fetch = originalFetch; }

assert.equal(videoHealthAfterOutcome(null, "fail", "invalid api key"), false);
assert.equal(videoHealthAfterOutcome({ is_healthy: false, consecutive_failures: 0 }, "fail", "generation error"), false);
assert.equal(videoHealthAfterOutcome({ is_healthy: false, consecutive_failures: 4 }, "success"), true);
for (const error of ["invalid api key", "model_not_found", "service unavailable"]) {
  assert.equal(videoHealthAfterOutcome({ is_healthy: true, consecutive_failures: 0 }, "fail", error), false);
}
assert.equal(videoHealthAfterOutcome({ is_healthy: true, consecutive_failures: 0 }, "fail", "insufficient quota"), true);
assert.equal(videoHealthAfterOutcome({ is_healthy: true, consecutive_failures: 0 }, "fail", "requires reference image"), true);
assert.equal(videoHealthAfterOutcome({ is_healthy: true, consecutive_failures: 0 }, "fail", "content policy"), true);

const verifiedEvidence = { evidence_id: "asset:verified-video", task_id: "vt_verified_task" };
const successAt = "2026-09-05T03:45:00.000Z";
assert.deepEqual(videoHealthVerificationAfterOutcome({
  verification_state: "verified",
  verification_evidence: verifiedEvidence,
}, "success", true, successAt), {
  verified_at: successAt,
  verification_evidence: { ...verifiedEvidence, latest_success_at: successAt },
});
const revoked = videoHealthVerificationAfterOutcome({
  verification_state: "verified",
  verification_evidence: verifiedEvidence,
}, "fail", false, successAt, "invalid api key");
assert.equal(revoked.verification_state, "revoked");
assert.equal(revoked.verified_at, null);
assert.equal((revoked.verification_evidence as Record<string, unknown>).revocation_category, "authentication");
assert.deepEqual(videoHealthVerificationAfterOutcome({
  verification_state: "verified",
  verification_evidence: verifiedEvidence,
}, "fail", true, successAt, "requires reference image"), {});
assert.deepEqual(videoHealthVerificationAfterOutcome({
  verification_state: "verified",
  verification_evidence: verifiedEvidence,
}, "fail", false, successAt, "Arrearage: insufficient balance"), {});
assert.equal(reconcileVideoModelSelection("user-choice", [{ id: "new-first", available: true }]), "user-choice");
assert.equal(reconcileVideoModelSelection("", [{ id: "bad", available: false }, { id: "pending", available: true, generationReady: false }, { id: "good", available: true, generationReady: true }]), "good");
assert.deepEqual(boundVideoTaskModel({ modelId: "old-model", modelName: "Actual original model", supportsRemoteCancel: false }, [{ id: "other-model", available: true, supportsRemoteCancel: true }]), {
  id: "old-model", name: "Actual original model", supportsRemoteCancel: false,
});
assert.equal(videoModelInputHint({ id: "text" }), "支持文生视频");
assert.equal(videoModelInputHint({ id: "h3", minReferenceImages: 1 }), "需参考图");
assert.equal(videoModelInputHint({ id: "frames", requiresFirstFrame: true, requiresLastFrame: true }), "需首尾帧");
console.log("PASS actual request routing, concurrent receipt isolation, privacy, health recovery and immutable model choice");

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
