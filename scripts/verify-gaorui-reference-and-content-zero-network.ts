import assert from "node:assert/strict";
import { submitVideoTask, pollVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";
import { getGaoruiVeoComponentsReferenceLimit, getVideoInputContract, validateVideoInputContract } from "../src/lib/video-input-contract";

const config: VideoModelConfig = {
  id: "fixture-components", name: "Fixture Veo components", provider: "gaorui_video",
  protocol_type: "gaorui_video", model_name: "veo_3_1-components",
  api_endpoint: "https://fixture.invalid/v1", api_key: "offline-fixture-key",
  price_per_use: .7, duration_seconds: 8, supports_image_input: true,
  api_protocol_config: { workflow_input_mode: "multi_image", max_reference_images: 9 },
};
const refs = Array.from({ length: 4 }, (_, i) => `https://fixture.invalid/reference-${i}.png`);
const originalTaskId = "fixture/original task";
const saved = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error };
const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
let pollBody: Record<string, unknown> = {};
let checks = 0;
async function main() {
  try {
    console.log = console.warn = console.error = () => {};
    globalThis.fetch = async (input, init) => {
      const url = String(input), method = init?.method || "GET";
      assert.ok(url === "https://fixture.invalid/v1/videos" || url === "https://fixture.invalid/v1/videos/" + encodeURIComponent(originalTaskId), "UNEXPECTED_NETWORK_BOUNDARY");
      assert.ok(method === "GET" || method === "POST");
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(method === "POST" ? { id: "fixture-submitted", status: "queued" } : pollBody), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    for (const count of [1, 3]) {
      calls.length = 0;
      const result = await submitVideoTask(config, { prompt: "Offline fixture", imageUrls: refs.slice(0, count) });
      assert.equal(result.taskId, "fixture-submitted");
      assert.equal(calls.length, 1); assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body?.images, refs.slice(0, count)); checks++;
    }
    calls.length = 0;
    const overflow = await submitVideoTask(config, { prompt: "Offline fixture", imageUrl: refs[0], lastFrameUrl: refs[1], referenceImageUrl: refs[2], imageUrls: [refs[3]] });
    assert.equal(overflow.status, "failed"); assert.equal(overflow.taskId, ""); assert.match(overflow.error || "", /3/u); assert.equal(calls.length, 0); checks++;
    for (const declared of [undefined, 9, 3, 2, 1]) {
      const model = { ...config, api_protocol_config: { ...config.api_protocol_config, max_reference_images: declared } };
      const maximum = declared === 1 || declared === 2 ? declared : 3;
      assert.equal(getGaoruiVeoComponentsReferenceLimit(model), maximum);
      const contract = getVideoInputContract(model);
      assert.equal(contract.maxReferenceImages, maximum);
      assert.equal(validateVideoInputContract(contract, { prompt: "Offline fixture", referenceImageUrls: refs })?.code, "VIDEO_REFERENCE_LIMIT_EXCEEDED"); checks++;
    }
    const lower = { ...config, api_protocol_config: { ...config.api_protocol_config, max_reference_images: 2 } };
    calls.length = 0; assert.equal((await submitVideoTask(lower, { prompt: "Offline fixture", imageUrls: refs.slice(0, 3) })).status, "failed"); assert.equal(calls.length, 0); checks++;
    for (const model of [{ ...config, model_name: "veo_3_1-fl" }, { ...config, model_name: "omni_flash_10s" }, { ...config, protocol_type: "openapi_video" }]) {
      assert.equal(getGaoruiVeoComponentsReferenceLimit(model), null);
      assert.equal(getVideoInputContract(model).maxReferenceImages, 9); checks++;
    }
    const video = "https://fixture.invalid/result.mp4", metadata = "https://fixture.invalid/metadata.mp4";
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ content: { video_url: video } }, video],
      [{ video_url: video, content: { video_url: metadata } }, video],
      [{ url: video, content: { video_url: metadata } }, video],
      [{ content: { video_url: video }, metadata: { video_url: metadata } }, video],
      [{ metadata: { video_url: video } }, video],
      [{ metadata: { url: video } }, video],
      [{ output: { url: video } }, video],
      [{ content: [video], metadata: { url: metadata } }, metadata],
    ];
    for (const [fields, expected] of cases) {
      calls.length = 0; pollBody = { id: "provider-different-id-must-not-replace-original", status: "completed", ...fields };
      const result = await pollVideoTask(config, originalTaskId);
      assert.equal(result.status, "success"); assert.equal(result.taskId, originalTaskId); assert.equal(result.videoUrl, expected);
      assert.equal(calls.length, 1); assert.equal(calls[0].method, "GET"); checks++;
    }
  } finally {
    globalThis.fetch = saved.fetch; console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
  }
  console.log(JSON.stringify({ passed: true, checks, realNetworkCalls: 0, providerCalls: 0, databaseWrites: 0, scope: "actual adapter one/three image POST; four blocked; exact public/server gate; content URL precedence; original task ID" }));
}
main().catch(() => { console.error("GAORUI_REFERENCE_CONTENT_ZERO_NETWORK_FAILED"); process.exitCode = 1; });
