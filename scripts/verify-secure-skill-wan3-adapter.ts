import assert from "node:assert/strict";
import { pollVideoTask, submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";

const config: VideoModelConfig = {
  id: "secure-skill-wan3-video",
  name: "Wan3.0 Video · 渠道A",
  provider: "secure_skill_wan3_video",
  api_endpoint: "https://token.secure-skill.com/v1",
  api_key: "fixture-api-key-value",
  protocol_type: "secure_skill_wan3_video",
  price_per_use: 0.19,
  duration_seconds: 5,
  supports_image_input: true,
  model_name: "wan3.0-video",
  api_protocol_config: { max_reference_images: 10, max_reference_audios: 5 },
};

const requests: Array<{ url: string; method: string; headers?: Headers; body?: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;

async function main() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ url, method: init?.method || "GET", headers: new Headers(init?.headers), body });
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ task_id: "wan3_task_001", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      task_id: "wan3_task_001",
      status: "succeeded",
      download_url: "https://cdn.example.com/wan3.mp4",
      progress: 100,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const submitted = await submitVideoTask(config, {
      prompt: "Keep the subject consistent and follow the audio rhythm.",
      imageUrl: "https://cdn.example.com/first.png",
      referenceImageUrl: "https://cdn.example.com/style.png",
      imageUrls: ["https://cdn.example.com/extra.png", "https://cdn.example.com/style.png"],
      sourceVideoUrl: "https://cdn.example.com/camera.mp4",
      audioUrl: "https://cdn.example.com/rhythm.mp3",
      duration: 45,
      aspectRatio: "9:16",
      resolutionTier: "1080p",
      idempotencyKey: "wan3-idempotency-001",
    });

    assert.equal(submitted.taskId, "wan3_task_001");
    assert.equal(submitted.status, "queued");
    assert.equal(requests[0]?.url, "https://token.secure-skill.com/v1/videos/generations");
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.headers?.get("Idempotency-Key"), "wan3-idempotency-001");
    assert.deepEqual(requests[0]?.body, {
      model: "wan3.0-video",
      prompt: "Keep the subject consistent and follow the audio rhythm.",
      resolution: "1080P",
      ratio: "9:16",
      duration: 30,
      prompt_extend: false,
      media: [
        { type: "first_frame", url: "https://cdn.example.com/first.png" },
        { type: "reference_image", url: "https://cdn.example.com/style.png" },
        { type: "reference_image", url: "https://cdn.example.com/extra.png" },
        { type: "reference_video", url: "https://cdn.example.com/camera.mp4" },
        { type: "audio", url: "https://cdn.example.com/rhythm.mp3" },
      ],
    });

    const polled = await pollVideoTask(config, submitted.taskId);
    assert.equal(requests[1]?.url, "https://token.secure-skill.com/v1/videos/tasks/wan3_task_001");
    assert.deepEqual(polled, {
      taskId: "wan3_task_001",
      status: "success",
      videoUrl: "https://cdn.example.com/wan3.mp4",
      error: undefined,
      progress: 100,
    });
    console.log("Secure Skill Wan3 adapter verification: PASS (no paid request)");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
