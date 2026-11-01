import assert from "node:assert/strict";
import { pollVideoTask, submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";
import { secureSkillKlingBody } from "../src/lib/video-secure-skill-kling";

const config: VideoModelConfig = {
  id: "fixture-kling", name: "Offline Kling", provider: "secure_skill_kling_video", protocol_type: "secure_skill_kling_video",
  api_endpoint: "https://fixture.invalid/v1", api_key: "offline-kling-only", model_name: "kling-video-v4", price_per_use: .4,
  duration_seconds: 10, supports_image_input: true,
  api_protocol_config: { min_duration: 3, max_duration: 30, max_reference_images: 10, max_reference_audios: 3 },
};
const savedFetch = globalThis.fetch;
let count = 0;
let reply: Record<string, unknown> = { id: "offline-task", status: "queued" };
let body: Record<string, unknown> = {};
let networkFailure = false;
let checks = 0;
async function main() {
  try {
    globalThis.fetch = async (input, init) => {
      assert.ok(String(input).startsWith("https://fixture.invalid/v1/videos"), "UNEXPECTED_NETWORK_BOUNDARY");
      count++;
      if (init?.body) body = JSON.parse(String(init.body));
      if (networkFailure) throw new TypeError("Offline connection lost");
      return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    for (const seconds of [3, 10, 30]) {
      count = 0;
      const submitted = await submitVideoTask(config, { prompt: "Offline movement", duration: seconds, imageUrls: ["https://fixture.invalid/ref.png"], resolutionTier: "1080p", aspectRatio: "9:16" });
      assert.equal(submitted.taskId, "offline-task"); assert.equal(count, 1);
      assert.equal(body.duration, seconds); assert.equal(body.resolution, "1080p"); assert.equal(body.ratio, "9:16");
      assert.deepEqual(body.media, [{ type: "reference_image", url: "https://fixture.invalid/ref.png" }]); checks++;
    }
    for (const seconds of [0, 2, 31, 4.5]) {
      count = 0; await assert.rejects(() => submitVideoTask(config, { prompt: "Offline", duration: seconds })); assert.equal(count, 0); checks++;
    }
    const channel2 = { ...config, api_protocol_config: { ...config.api_protocol_config, min_duration: 4 } };
    count = 0; await assert.rejects(() => submitVideoTask(channel2, { prompt: "Offline", duration: 3 })); assert.equal(count, 0); checks++;
    for (const args of [
      { resolutionTier: "4k" }, { imageUrls: Array.from({ length: 11 }, (_, i) => `https://fixture.invalid/${i}.png`) },
      { imageUrl: "data:image/png;base64,offline" }, { aspectRatio: "auto" },
    ]) { count = 0; await assert.rejects(() => submitVideoTask(config, { prompt: "Offline", ...args })); assert.equal(count, 0); checks++; }
    const mixed = secureSkillKlingBody(config, { prompt: "Offline", imageUrl: "https://fixture.invalid/a.png", referenceImageUrl: "https://fixture.invalid/a.png", sourceVideoUrl: "https://fixture.invalid/ref.mp4", audioUrl: "https://fixture.invalid/a.mp3", generateAudio: false });
    assert.equal((mixed.media as unknown[]).length, 3); assert.equal(mixed.enable_audio, false); checks++;
    reply = { id: "offline-task", status: "completed", output: [{ url: "https://fixture.invalid/result.mp4" }] };
    assert.equal((await pollVideoTask(config, "offline-task")).videoUrl, "https://fixture.invalid/result.mp4"); checks++;
    reply = { id: "offline-task", status: "completed" };
    assert.equal((await pollVideoTask(config, "offline-task")).status, "processing"); checks++;
    reply = { id: "different-task", status: "completed", url: "https://fixture.invalid/wrong.mp4" };
    assert.equal((await pollVideoTask(config, "offline-task")).error, "VIDEO_TASK_RECEIPT_ID_MISMATCH"); checks++;
    networkFailure = true; count = 0;
    const unknown = await submitVideoTask(config, { prompt: "Offline", duration: 5 });
    assert.equal(count, 1); assert.equal(unknown.taskId, ""); assert.equal(unknown.submissionOutcome, "unknown"); checks++;
  } finally { globalThis.fetch = savedFetch; }
  console.log(JSON.stringify({ passed: true, checks, realNetworkCalls: 0, databaseWrites: 0, scope: "Kling exact body and duration; reference limits; same-key polling; receipt mismatch; one POST on unknown" }));
}
main().catch(() => { console.error("SECURE_SKILL_KLING_ZERO_NETWORK_FAILED"); process.exitCode = 1; });
