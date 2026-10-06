import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getImageModelCapabilities } from "../src/lib/image-model-capabilities";
import { buildSecureSkillImagePayload } from "../src/lib/secure-skill-image-adapter";

const model = {
  id: "gpt-image-2-chA-1",
  name: "GPT-Image-2 · 渠道A pro",
  model_name: "gpt-image-2",
  provider: "openai_compat",
  supports_image_input: true,
};
const capabilities = getImageModelCapabilities(model);
assert.deepEqual(capabilities.resolutionOptions, ["1K", "2K", "4K"]);
assert.equal(capabilities.defaultResolution, "2K");
assert.equal(capabilities.supportsReferenceInput, true);
assert.equal(capabilities.referenceInputMode, "multi");

for (const resolution of capabilities.resolutionOptions) {
  const payload = buildSecureSkillImagePayload({
    modelName: model.model_name,
    prompt: "contract-only payload verification",
    resolution,
    aspectRatio: "16:9",
    referenceImageUrls: ["https://example.com/reference-a.png", "https://example.com/reference-b.png"],
  });
  assert.equal(payload.model, "gpt-image-2", `${resolution} must use the gateway's public model contract`);
  assert.notEqual(payload.model, "adobe-image2-high", "key-group label must never be sent as payload model");
  assert.equal(payload.image_size, resolution);
  assert.equal(payload.aspect_ratio, "16:9");
  assert.equal("size" in payload, false, "A-channel image tiers use image_size and aspect_ratio, not OpenAI pixel presets");
  assert.deepEqual(payload.image, ["https://example.com/reference-a.png", "https://example.com/reference-b.png"]);
}

const routeSource = readFileSync("src/app/api/image/generate/route.ts", "utf8");
const workbenchSource = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
assert.match(routeSource, /import \{ executeCashDeduction \} from "@\/lib\/billing-executor"/u);
assert.match(routeSource, /const billingReferenceId = `image:\$\{h3OperationId\}`/u);
assert.match(routeSource, /executeCashDeduction\(\{[\s\S]*?amount: sellingPrice,[\s\S]*?idempotencyKey: billingReferenceId/u);
assert.match(routeSource, /recordRevenue\(\{[\s\S]*?taskId: billingReferenceId,[\s\S]*?cashCharged: sellingPrice/u);
assert.match(routeSource, /cashCharged: sellingPrice/u);
assert.match(routeSource, /select\("cash_balance"\).*?eq\("id", userId\)\.single\(\)/su);
assert.doesNotMatch(routeSource, /billingExemptionReason: isAdmin/u);
assert.match(workbenchSource, /clientTraceId = requestSnapshot\.strictSingleSubmit \? `imgtrace_\$\{exactDigest\}` : imageClientAttempt!\.clientRequestId;/u);
assert.match(workbenchSource, /clientIdempotencyKey = requestSnapshot\.strictSingleSubmit \? `imgkey_\$\{exactDigest\}` : imageClientAttempt!\.clientRequestId;/u);
assert.match(workbenchSource, /const generationAttempts = requestSnapshot\.strictSingleSubmit \? 1 : IMAGE_GENERATION_ATTEMPTS;[\s\S]*?for \(let attempt = 1/u);
assert.ok(
  workbenchSource.indexOf("clientIdempotencyKey = requestSnapshot.strictSingleSubmit")
    < workbenchSource.indexOf("for (let attempt = 1"),
  "image retry loop must reuse one client idempotency key",
);
assert.match(workbenchSource, /patchCard\(cardId, \{\s*imageStatus: "failed"/u);
assert.match(workbenchSource, /window\.setTimeout\(\(\) => \{ void saveStoryboardProject\(createStoryboardPersistenceSnapshot\(run\)\); \}, 1200\)/u);
assert.match(workbenchSource, /createStoryboardPersistenceSnapshot/u);
assert.doesNotMatch(workbenchSource, /localStorage\.setItem\(CURRENT_KEY,\s*JSON\.stringify\(run\)\)/u);

console.log(JSON.stringify({
  result: "PASS",
  billed_generation_requests: 0,
  payload_model: "gpt-image-2",
  key_group_route: "adobe-image2-high",
  resolutions: capabilities.resolutionOptions,
  default_resolution: capabilities.defaultResolution,
  reference_transport: "JSON image[] URL array",
  stable_client_trace_id: true,
  billing_reference_idempotence: true,
  failed_history_persistence: true,
  lightweight_debounced_draft_persistence: true,
}, null, 2));
