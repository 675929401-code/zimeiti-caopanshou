import assert from "node:assert/strict";
import { pollVideoTask, submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";
import { resolveVideoDuration } from "../src/lib/video-model-capabilities";

const config: VideoModelConfig = {
  id: "minimax-h3-chA",
  name: "MiniMax H3",
  provider: "secure_skill_video",
  api_endpoint: "https://token.secure-skill.com/v1",
  api_key: "fixture-api-key-value",
  protocol_type: "secure_skill_video",
  price_per_use: 1.5,
  duration_seconds: 15,
  supports_image_input: true,
  model_name: "minimax-h3",
  api_protocol_config: {
    duration_options: Array.from({ length: 12 }, (_, index) => index + 4),
    min_submit_duration: 5,
  },
};

const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;

async function main() {
  const fourSecondTiming = resolveVideoDuration(config, 4);
  assert.equal(fourSecondTiming.target, 4);
  assert.equal(fourSecondTiming.submit, 5);
  assert.equal(fourSecondTiming.needsTrim, true);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    requests.push({ url, method: init?.method || "GET", body });

    if (init?.method === "POST") {
      return new Response(JSON.stringify({ task_id: "h3-task-001", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      task_id: "h3-task-001",
      status: "completed",
      video_url: "https://cdn.example.com/h3.mp4",
      progress: 1,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const missingImage = await submitVideoTask(config, {
      prompt: "A dog turns toward the camera.",
      duration: 4,
    });
    assert.equal(missingImage.status, "failed");
    assert.match(missingImage.error || "", /参考图/);
    assert.equal(requests.length, 0, "Missing-image validation must fail before any upstream request.");

    const submitted = await submitVideoTask(config, {
      prompt: "The golden retriever takes two cautious steps, then looks up with a relieved expression.",
      imageUrl: "https://cdn.example.com/reference.png",
      duration: 15,
      resolutionTier: "2K",
      aspectRatio: "21:9",
    });

    assert.deepEqual(submitted, {
      taskId: "h3-task-001",
      status: "queued",
      videoUrl: undefined,
      progress: null,
    });
    assert.equal(requests[0]?.url, "https://token.secure-skill.com/v1/videos");
    assert.equal(requests[0]?.method, "POST");
    assert.deepEqual(requests[0]?.body, {
      model: "minimax-h3",
      prompt: "The golden retriever takes two cautious steps, then looks up with a relieved expression.",
      duration: 15,
      resolution: "2k",
      aspect_ratio: "21:9",
      image_urls: ["https://cdn.example.com/reference.png"],
    });
    assert.equal("seconds" in (requests[0]?.body || {}), false);
    assert.equal("size" in (requests[0]?.body || {}), false);
    assert.equal("image" in (requests[0]?.body || {}), false);

    const submitted4K = await submitVideoTask(config, {
      prompt: "The golden retriever stays consistent while the camera slowly moves forward.",
      imageUrl: "https://cdn.example.com/reference.png",
      duration: 15,
      resolutionTier: "4K",
      aspectRatio: "16:9",
    });
    assert.equal(submitted4K.taskId, "h3-task-001");
    assert.equal(requests[1]?.body?.resolution, "4k");

    const polled = await pollVideoTask(config, submitted.taskId);
    assert.equal(requests[2]?.url, "https://token.secure-skill.com/v1/videos/h3-task-001");
    assert.deepEqual(polled, {
      taskId: "h3-task-001",
      status: "success",
      videoUrl: "https://cdn.example.com/h3.mp4",
      error: undefined,
      progress: 1,
    });

    console.log("MiniMax H3 Channel A protocol verification: PASS (no paid request)");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
