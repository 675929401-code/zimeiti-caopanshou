import assert from "node:assert/strict";

import {
  pollVideoTask,
  submitVideoTask,
  type VideoModelConfig,
} from "../src/lib/video-adapter";
import { doubaoSeedanceTaskBody } from "../src/lib/video-doubao-seedance-relay";

function config(modelName = "doubao-seedance-2-5-260628"): VideoModelConfig {
  return {
    id: `test-${modelName}`,
    name: modelName,
    provider: "secure_skill_doubao_seedance",
    api_endpoint: "https://token.secure-skill.com",
    api_key: "fixture-only-key",
    protocol_type: "secure_skill_doubao_seedance",
    price_per_use: 0,
    duration_seconds: 6,
    supports_image_input: true,
    model_name: modelName,
    api_protocol_config: { default_resolution: "720p" },
  };
}

async function main() {
  const base = config();
  const mixed = doubaoSeedanceTaskBody(base, {
    prompt: "Use the supplied references to make a cinematic scene.",
    imageUrl: "https://example.com/first.png",
    referenceImageUrl: "https://example.com/reference.png",
    sourceVideoUrl: "https://example.com/reference.mp4",
    audioUrl: "https://example.com/reference.mp3",
    duration: 6,
    resolutionTier: "720p",
    aspectRatio: "21:9",
  });
  assert.equal(mixed.model, "doubao-seedance-2-5-260628");
  assert.equal(mixed.duration, 6);
  assert.equal(mixed.resolution, "720p");
  assert.equal(mixed.ratio, "21:9");
  assert.deepEqual((mixed.content as Array<Record<string, unknown>>).map((item) => item.role || item.type), [
    "text", "reference_image", "reference_image", "reference_video", "reference_audio",
  ]);

  const frames = doubaoSeedanceTaskBody(base, {
    prompt: "Move smoothly from the first frame to the last frame.",
    imageUrl: "https://example.com/first.png",
    lastFrameUrl: "https://example.com/last.png",
    duration: 8,
    resolutionTier: "720p",
    aspectRatio: "16:9",
  });
  assert.deepEqual((frames.content as Array<Record<string, unknown>>).map((item) => item.role || item.type), [
    "text", "first_frame", "last_frame",
  ]);
  assert.throws(() => doubaoSeedanceTaskBody(base, {
    prompt: "Invalid mixed constraints",
    imageUrl: "https://example.com/first.png",
    lastFrameUrl: "https://example.com/last.png",
    sourceVideoUrl: "https://example.com/reference.mp4",
    duration: 6,
    resolutionTier: "720p",
  }), /不能同时传入参考视频/u);
  assert.throws(() => doubaoSeedanceTaskBody(config("doubao-seedance-2-0-fast-260128"), {
    prompt: "Unsupported resolution",
    duration: 6,
    resolutionTier: "1080p",
  }), /当前仅开放 720p/u);

  const originalFetch = globalThis.fetch;
  let responseUsage: Record<string, unknown> | undefined = { total_tokens: 1234, completion_tokens: 1234 };
  let responseId = "seedance-fixture-task";
  const requests: Array<{ url: string; method: string; body?: Json }> = [];
  type Json = Record<string, unknown>;
  globalThis.fetch = async (input, init) => {
    const method = String(init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Json : undefined;
    requests.push({ url: String(input), method, body });
    if (method === "POST") {
      return new Response(JSON.stringify({ id: "seedance-fixture-task", status: "queued", progress: 0, usage: responseUsage }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      id: responseId,
      status: "succeeded",
      progress: 100,
      content: { video_url: "https://example.com/result.mp4" },
      usage: responseUsage,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const submitted = await submitVideoTask(base, {
      prompt: "A smooth product turntable shot.",
      duration: 6,
      resolutionTier: "720p",
      aspectRatio: "9:16",
    });
    assert.equal(submitted.taskId, "seedance-fixture-task");
    assert.equal(submitted.status, "queued");
    assert.deepEqual(submitted.usage, { totalTokens: 1234, completionTokens: 1234 });
    assert.equal(requests[0].url, "https://token.secure-skill.com/api/v3/contents/generations/tasks");
    assert.equal(requests[0].body?.model, "doubao-seedance-2-5-260628");

    const polled = await pollVideoTask(base, submitted.taskId);
    assert.equal(polled.status, "success");
    assert.equal(polled.videoUrl, "https://example.com/result.mp4");
    assert.deepEqual(polled.usage, { totalTokens: 1234, completionTokens: 1234 });
    assert.equal(requests[1].url, "https://token.secure-skill.com/api/v3/contents/generations/tasks/seedance-fixture-task");
    responseUsage = undefined;
    const withoutUsage = await pollVideoTask(base, submitted.taskId);
    assert.equal(withoutUsage.status, "success", "result persistence must proceed while billing waits for usage");
    assert.equal(withoutUsage.usage, undefined);
    responseUsage = { total_tokens: 1234, completion_tokens: 1200 };
    const conflictingUsage = await pollVideoTask(base, submitted.taskId);
    assert.equal(conflictingUsage.status, "success");
    assert.equal(conflictingUsage.usage, undefined, "conflicting counters must never become a zero bill");
    responseId = "different-task";
    const mismatched = await pollVideoTask(base, submitted.taskId);
    assert.notEqual(mismatched.status, "success");
    assert.equal(mismatched.videoUrl, undefined);
    assert.equal(mismatched.usage, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("Secure Skill Doubao Seedance adapter verification passed: channel 37 body, endpoint, polling and result parsing are correct.");
}

void main();

