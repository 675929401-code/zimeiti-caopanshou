import assert from "node:assert/strict";

import {
  buildPriorityVideoModelPlan,
  EXISTING_PRICE_IDS,
  NEW_MODEL_IDS,
  VEO_COMPONENTS_ID,
  type VideoModelRecord,
} from "./configure-priority-video-models-local";
import { getVideoInputContract, validateVideoInputContract } from "../src/lib/video-input-contract";
import { submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";

async function main() {
const gate = (id: string) => ({
  schema: "media_model_activation_gate.v1",
  state: "evidence_ready",
  binding_sha256: `fixture-${id}`,
  evidence: { evidence_id: `fixture-evidence-${id}` },
});

const existing = (id: string, extra: Record<string, unknown> = {}): VideoModelRecord => ({
  id,
  name: id,
  model_name: id,
  provider: "fixture",
  protocol_type: "fixture",
  api_endpoint: "https://fixture.invalid/v1",
  api_key: `secret://fixture-${id}`,
  price_per_use: 0.2,
  cost_price: 0.2,
  currency: "CNY",
  duration_seconds: 10,
  max_duration: 15,
  supports_image_input: true,
  requires_image: false,
  is_active: true,
  is_hidden: false,
  sort_order: 100,
  admin_notes: "fixture",
  api_protocol_config: { __model_activation_gate: gate(id) },
  ...extra,
});

const unrelated = existing("unrelated-model");
const rows = [
  unrelated,
  ...EXISTING_PRICE_IDS.map((id) => existing(id)),
  existing(VEO_COMPONENTS_ID, {
    cost_price: 0.65,
    price_per_use: 0.715,
    api_protocol_config: {
      resolution_options: ["720p", "1080p"],
      resolution_cost_prices: { "720p": 0.55, "1080p": 0.65 },
      resolution_prices: { "720p": 0.605, "1080p": 0.715 },
      __model_activation_gate: gate(VEO_COMPONENTS_ID),
    },
  }),
];

const plan = buildPriorityVideoModelPlan(rows);
assert.deepEqual(plan.missingExistingIds, []);
assert.deepEqual(plan.changedIds.sort(), [...NEW_MODEL_IDS, ...EXISTING_PRICE_IDS, VEO_COMPONENTS_ID].sort());
const planned = new Map(plan.after.map((row) => [row.id, row]));
assert.deepEqual(planned.get("unrelated-model"), unrelated);

for (const id of NEW_MODEL_IDS) {
  const row = planned.get(id)!;
  assert.equal(row.is_active, false);
  assert.equal(row.is_hidden, true);
  assert.equal((row.api_protocol_config.__model_activation_gate as Record<string, unknown>).state, "pending");
  assert.match(row.api_key, /^secret:\/\/(?:gaorui|secure-skill)-/u);
}
assert.notEqual(planned.get(NEW_MODEL_IDS[0])!.api_key, planned.get(NEW_MODEL_IDS[1])!.api_key);
assert.notEqual(planned.get(NEW_MODEL_IDS[1])!.api_key, planned.get(NEW_MODEL_IDS[2])!.api_key);

for (const id of EXISTING_PRICE_IDS) {
  const before = rows.find((row) => row.id === id)!;
  const after = planned.get(id)!;
  assert.equal(after.cost_price, 0.48);
  assert.equal(after.price_per_use, 0.6);
  assert.deepEqual(after.api_protocol_config.__model_activation_gate, before.api_protocol_config.__model_activation_gate);
}

const veoBefore = rows.find((row) => row.id === VEO_COMPONENTS_ID)!;
const veoAfter = planned.get(VEO_COMPONENTS_ID)!;
assert.deepEqual(veoAfter.api_protocol_config.resolution_options, ["lite", "720p", "1080p"]);
assert.deepEqual(veoAfter.api_protocol_config.resolution_cost_prices, { lite: 0.3, "720p": 0.55, "1080p": 0.65 });
assert.deepEqual(veoAfter.api_protocol_config.resolution_prices, { lite: 0.4, "720p": 0.7, "1080p": 0.8 });
assert.deepEqual(veoAfter.api_protocol_config.__model_activation_gate, veoBefore.api_protocol_config.__model_activation_gate);
assert.equal(veoAfter.is_active, false);
assert.equal(veoAfter.is_hidden, true);

const secondPlan = buildPriorityVideoModelPlan(plan.after);
assert.deepEqual(secondPlan.changedIds, [], "The onboarding plan must be idempotent");

const requests: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
  return Response.json({ id: `fixture-task-${requests.length}`, status: "queued" });
};

function gaorui(modelName: string, config: Record<string, unknown>): VideoModelConfig {
  return {
    id: `fixture-${modelName}`,
    name: modelName,
    provider: "gaorui_video",
    api_endpoint: "https://fixture.invalid/v1",
    api_key: "fixture-provider-key",
    protocol_type: "gaorui_video",
    price_per_use: 1.1,
    duration_seconds: 10,
    supports_image_input: true,
    model_name: modelName,
    api_protocol_config: config,
  };
}

try {
  const formal15 = gaorui("grok-imagine-video-1.5", {
    duration_options: [6, 8, 10, 12, 15],
    resolution_options: ["480p", "720p"],
    max_reference_images: 5,
    workflow_input_mode: "multi_image",
  });
  const contract15 = getVideoInputContract({ ...formal15, requires_image: false });
  assert.equal(contract15.requiresFirstFrame, false);
  assert.equal(validateVideoInputContract(contract15, { prompt: "text-only" }), null);
  const textResult = await submitVideoTask(formal15, { prompt: "text-only", duration: 12, resolutionTier: "720p" });
  assert.equal(textResult.taskId, "fixture-task-1");
  assert.equal(requests[0].resolution, "720p");
  assert.equal("image_url" in requests[0], false);
  assert.equal("image_urls" in requests[0], false);

  const imageUrls = Array.from({ length: 6 }, (_, index) => `https://fixture.invalid/${index}.png`);
  const tooMany = validateVideoInputContract(contract15, { prompt: "multi", referenceImageUrls: imageUrls });
  assert.equal(tooMany?.code, "VIDEO_REFERENCE_LIMIT_EXCEEDED");
  const multiResult = await submitVideoTask(formal15, {
    prompt: "multi",
    duration: 15,
    resolutionTier: "480p",
    imageUrl: imageUrls[0],
    imageUrls: imageUrls.slice(1),
  });
  assert.equal(multiResult.taskId, "fixture-task-2");
  assert.deepEqual(requests[1].image_urls, imageUrls.slice(0, 5));
  assert.equal(requests[1].resolution, "480p");
  assert.equal("image_url" in requests[1], false);

  const preview = gaorui("grok-imagine-video-1.5-preview", { max_reference_images: 1, requires_image_v15: true });
  const previewContract = getVideoInputContract({ ...preview, requires_image: true });
  assert.equal(validateVideoInputContract(previewContract, { prompt: "preview" })?.code, "VIDEO_FIRST_FRAME_REQUIRED");
  const previewResult = await submitVideoTask(preview, { prompt: "preview", imageUrl: imageUrls[0] });
  assert.equal(previewResult.taskId, "fixture-task-3");
  assert.deepEqual(requests[2].image_urls, [imageUrls[0]]);

  const formal10 = gaorui("grok-imagine-1.0-video", { max_reference_images: 9 });
  const result10 = await submitVideoTask(formal10, {
    prompt: "text or images",
    imageUrls: imageUrls.slice(0, 3),
    aspectRatio: "16:9",
    resolution: "720p",
    resolutionTier: "720p",
  });
  assert.equal(result10.taskId, "fixture-task-4");
  assert.deepEqual(requests[3].image_urls, imageUrls.slice(0, 3));
  assert.equal(requests[3].size, "1280x720");

  const portrait10 = await submitVideoTask(formal10, {
    prompt: "portrait tier mapping",
    aspectRatio: "9:16",
    resolution: "720p",
    resolutionTier: "720p",
  });
  assert.equal(portrait10.taskId, "fixture-task-5");
  assert.equal(requests[4].size, "720x1280");
  assert.notEqual(requests[4].size, "720p");
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({
  passed: true,
  plannedModels: NEW_MODEL_IDS.length,
  priceUpdates: EXISTING_PRICE_IDS.length,
  providerRequests: 0,
  mockedAdapterRequests: requests.length,
  databaseWrites: 0,
  paidGenerationCalls: 0,
}));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
