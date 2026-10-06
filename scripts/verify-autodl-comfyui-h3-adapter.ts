import assert from "node:assert/strict";
import {
  pollVideoTask,
  submitVideoTask,
  type VideoModelConfig,
} from "../src/lib/video-adapter";

async function main() {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    method: string;
    authorization: string;
    body: Record<string, unknown>;
  }> = [];
  const responses = [
    { code: "Success", data: { task_id: "autodl-task-1", status: "QUEUED" } },
    { code: "Success", data: { task_id: "autodl-task-1", status: "RUNNING" } },
    {
      code: "Success",
      data: {
        task_id: "autodl-task-1",
        status: "SUCCESS",
        results: [{ type: "video", url: "https://cdn.example.com/h3-result.mp4" }],
      },
    },
  ];

  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method: String(init?.method || "GET"),
      authorization: headers.get("authorization") || "",
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
    });
    const payload = responses.shift();
    assert.ok(payload, "unexpected extra fetch");
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const config: VideoModelConfig = {
    id: "minimax-h3-autodl-hosted",
    name: "MiniMax H3 · AutoDL 托管加速",
    provider: "autodl_comfyui_h3",
    api_endpoint: "https://www.autodl.art/api/v1",
    api_key: "test-comfyui-token",
    protocol_type: "autodl_comfyui_h3",
    price_per_use: 0.07,
    duration_seconds: 5,
    supports_image_input: true,
    model_name: "minimax_h3_image_audio_to_video_v2",
    api_protocol_config: {
      workflow_id: "minimax_h3_image_audio_to_video_v2",
      max_reference_images: 9,
      max_reference_audios: 3,
    },
  };

  try {
    const submitted = await submitVideoTask(config, {
      prompt: "Keep the referenced subject and synchronize motion with the audio.",
      imageUrl: "https://example.com/main.png",
      lastFrameUrl: "https://example.com/last.png",
      referenceImageUrl: "https://example.com/reference.png",
      imageUrls: Array.from({ length: 9 }, (_, index) => `https://example.com/extra-${index}.png`),
      audioUrls: [
        "https://example.com/audio-0.wav",
        "https://example.com/audio-1.mp3",
        "https://example.com/audio-2.flac",
      ],
      duration: 10,
      aspectRatio: "9:16",
      resolutionTier: "768p",
    });

    assert.equal(submitted.taskId, "autodl-task-1");
    assert.equal(submitted.status, "queued");
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].authorization, "test-comfyui-token");
    assert.ok(!requests[0].authorization.startsWith("Bearer "));
    assert.equal(
      requests[0].url,
      "https://www.autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_image_audio_to_video_v2",
    );
    assert.equal(requests[0].body.duration, 10);
    assert.equal(requests[0].body.resolution, "768p竖");
    assert.equal(requests[0].body.ref_image_0, "https://example.com/main.png");
    assert.equal(requests[0].body.ref_image_1, "https://example.com/last.png");
    assert.equal(requests[0].body.ref_image_2, "https://example.com/reference.png");
    assert.equal(requests[0].body.ref_image_8, "https://example.com/extra-5.png");
    assert.equal(requests[0].body.ref_image_9, undefined, "AutoDL H3 must cap image references at nine");
    assert.equal(requests[0].body.ref_audio_2, "https://example.com/audio-2.flac");

    const running = await pollVideoTask(config, submitted.taskId);
    assert.equal(running.status, "processing");
    assert.equal(requests[1].authorization, "test-comfyui-token");
    assert.equal(
      requests[1].url,
      "https://www.autodl.art/api/v1/comfyui/comfyui_workflow/result/autodl-task-1",
    );

    const completed = await pollVideoTask(config, submitted.taskId);
    assert.equal(completed.status, "success");
    assert.equal(completed.videoUrl, "https://cdn.example.com/h3-result.mp4");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("AutoDL hosted H3 adapter verification passed (mock only; no paid request was sent).\n");
}

void main();
