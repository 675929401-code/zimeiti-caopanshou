import assert from "node:assert/strict";

import { submitVideoTask, pollVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";
import { autoDetectVideoProtocol } from "../src/lib/video-protocol-detector";

const base: VideoModelConfig = {
  id: "secure-skill-video-2-0-fast-g16",
  name: "Video 2.0 Fast enterprise",
  model_name: "video-2.0-fast",
  provider: "secure_skill_enterprise_video",
  protocol_type: "secure_skill_enterprise_video",
  api_endpoint: "https://token.secure-skill.com",
  api_key: "test-key",
  price_per_use: 0.605,
  duration_seconds: 8,
  supports_image_input: true,
  api_protocol_config: {
    min_submit_duration: 5,
    max_duration: 15,
    max_reference_images: 9,
    max_reference_audios: 3,
  },
};

async function main() {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url: String(input), method: String(init?.method || "GET"), body });
    if (String(init?.method || "GET") === "GET") {
      return new Response(JSON.stringify({ status: "completed", video_url: "https://media.example/video.mp4" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ task_id: "enterprise-task-1", status: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const submitted = await submitVideoTask(base, {
      prompt: "Product close-up with a slow camera push.",
      imageUrl: "https://example.com/main.jpg",
      imageUrls: ["https://example.com/ref.jpg", "https://example.com/main.jpg"],
      audioUrl: "https://example.com/music.mp3",
      duration: 8,
      aspectRatio: "9:16",
    });
    assert.equal(submitted.taskId, "enterprise-task-1");
    assert.equal(calls[0].url, "https://token.secure-skill.com/v1/videos");
    assert.equal(calls[0].body?.model, "video-2.0-fast");
    assert.equal(calls[0].body?.duration, 8);
    assert.equal(calls[0].body?.aspect_ratio, "9:16");
    assert.equal(calls[0].body?.image_url, "https://example.com/main.jpg");
    assert.deepEqual(calls[0].body?.extra_images, ["https://example.com/ref.jpg"]);
    assert.deepEqual(calls[0].body?.extra_audios, ["https://example.com/music.mp3"]);
    assert.equal(calls[0].body?.seconds, undefined);

    const rejected = await submitVideoTask(base, {
      prompt: "Unsupported reference video.",
      sourceVideoUrl: "https://example.com/reference.mp4",
      duration: 8,
    });
    assert.equal(rejected.status, "failed");
    assert.match(String(rejected.error), /不支持参考视频/u);
    assert.equal(calls.length, 1, "unsupported source video must fail before dispatch");

    const seedance = await submitVideoTask({
      ...base,
      id: "secure-skill-seedance-2-5-enterprise-g16",
      model_name: "seedance-2.5",
      api_protocol_config: { ...base.api_protocol_config, max_duration: 30 },
    }, {
      prompt: "A character turns toward the camera.",
      imageUrls: ["https://example.com/character.jpg"],
      audioUrls: ["https://example.com/voice.mp3"],
      duration: 30,
      aspectRatio: "16:9",
    });
    assert.equal(seedance.taskId, "enterprise-task-1");
    assert.equal(calls[1].body?.seconds, 30);
    assert.equal(calls[1].body?.duration, undefined);
    assert.equal(calls[1].body?.resolution, "720p");
    assert.deepEqual(calls[1].body?.images, ["https://example.com/character.jpg"]);
    assert.deepEqual(calls[1].body?.audios, ["https://example.com/voice.mp3"]);

    const polled = await pollVideoTask(base, "enterprise-task-1");
    assert.equal(calls[2].url, "https://token.secure-skill.com/v1/videos/enterprise-task-1");
    assert.equal(polled.status, "success");
    assert.equal(polled.videoUrl, "https://media.example/video.mp4");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const detected = await autoDetectVideoProtocol({
    apiEndpoint: "https://token.secure-skill.com",
    apiKey: "test-key",
    modelName: "seedance-2.5",
  }, async () => ({ data: [
    { id: "seedance-2.5" },
    { id: "video-2.0-fast" },
    { id: "video-2.0-pro" },
  ] }));
  assert.equal(detected.success, true);
  assert.equal(detected.protocolType, "secure_skill_enterprise_video");
  assert.equal(detected.keyValid, true);
  assert.equal(detected.modelExists, true);

  console.log("Secure Skill enterprise video adapter verification passed: group 16 payloads, polling, source-video rejection and directory-aware detection are correct.");
}

void main();
