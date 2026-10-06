import assert from "node:assert/strict";

import {
  AUTODL_HOSTED_H3_WORKFLOWS,
  RETIRED_AUTODL_HOSTED_H3_WORKFLOWS,
  buildAutoDLHostedH3VideoRecord,
} from "../src/lib/autodl-hosted-h3-workflow-catalog";
import {
  generateAutodlComfyuiWorkflow,
  pollAutodlComfyuiWorkflow,
  validateAutodlComfyuiWorkflowInput,
} from "../src/lib/video-autodl-comfyui-workflow";
import type { VideoGenerateParams, VideoModelConfig } from "../src/lib/video-adapter";

type Json = Record<string, unknown>;

const originalFetch = globalThis.fetch;
const image = (index: number) => `https://assets.example.test/image-${index}.png`;
const audio = (index: number) => `https://assets.example.test/audio-${index}.wav`;

function configFor(workflowId: string): VideoModelConfig {
  // Adapter fixtures cover both current and historical task shapes. Retired
  // workflow evidence must never be looked up through the active catalog.
  const spec = [...AUTODL_HOSTED_H3_WORKFLOWS, ...RETIRED_AUTODL_HOSTED_H3_WORKFLOWS]
    .find((entry) => entry.workflowId === workflowId);
  assert.ok(spec, `missing catalog spec ${workflowId}`);
  const row = buildAutoDLHostedH3VideoRecord(spec, { createdAt: new Date().toISOString() });
  return { ...row, api_key: "fixture-comfyui-token" };
}

async function verifySubmission(
  workflowId: string,
  params: VideoGenerateParams,
  checkBody: (body: Json) => void,
) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: Json }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Json : undefined;
    calls.push({ url, method, headers, body });
    if (method === "POST") {
      return Response.json({
        code: "Success",
        data: { task_id: `task-${workflowId}`, status: "QUEUED" },
      });
    }
    return Response.json({
      code: "Success",
      data: {
        task_id: `task-${workflowId}`,
        status: "SUCCESS",
        results: [{ type: "video", file_type: "mp4", url: "https://results.example.test/final.mp4" }],
      },
    });
  };

  const config = configFor(workflowId);
  const submitted = await generateAutodlComfyuiWorkflow(config, params);
  assert.equal(submitted.status, "queued");
  assert.equal(submitted.taskId, `task-${workflowId}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, new RegExp(`/comfyui/comfyui_workflow/${workflowId}$`, "u"));
  assert.equal(calls[0].headers.get("Authorization"), "fixture-comfyui-token");
  assert.equal(calls[0].headers.get("Authorization")?.startsWith("Bearer "), false);
  assert.ok(calls[0].body);
  checkBody(calls[0].body!);

  const polled = await pollAutodlComfyuiWorkflow(config, submitted.taskId);
  assert.equal(polled.status, "success");
  assert.equal(polled.videoUrl, "https://results.example.test/final.mp4");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "GET");
  assert.match(calls[1].url, /\/comfyui\/comfyui_workflow\/result\/task-/u);
}

async function main() {
  await verifySubmission("minimax_h3_lightx2v_v5", {
    prompt: "A dog turns toward the camera",
    duration: 10,
    resolutionTier: "480p",
    aspectRatio: "1:1",
    imageUrl: image(0),
    imageUrls: Array.from({ length: 8 }, (_, index) => image(index + 1)),
  }, (body) => {
    assert.equal(body.prompt, "A dog turns toward the camera");
    assert.equal(body.duration, 10);
    assert.equal(body.resolution, "480p(1:1)");
    for (let index = 0; index < 9; index += 1) assert.equal(body[`ref_image_${index}`], image(index));
    assert.equal("ref_image_9" in body, false);
    assert.equal(Object.keys(body).some((key) => key.startsWith("ref_audio_")), false);
  });

  await verifySubmission("minimax_h3_lightx2v_no_pic", {
    prompt: "A dog calmly walks away",
    duration: 15,
    resolutionTier: "480p",
    aspectRatio: "16:9",
  }, (body) => {
    assert.deepEqual(body, { prompt: "A dog calmly walks away", duration: 15, resolution: "480p横" });
  });

  await verifySubmission("minimax_h3_lightx2v", {
    prompt: "The dog moves between the two keyframes",
    duration: 15,
    resolutionTier: "768p",
    aspectRatio: "9:16",
    imageUrl: image(0),
    lastFrameUrl: image(1),
  }, (body) => {
    assert.deepEqual(body, {
      prompt: "The dog moves between the two keyframes",
      duration: 15,
      resolution: "768p竖",
      first_frame: image(0),
      last_frame: image(1),
    });
  });

  await verifySubmission("minimax_h3_lightx2v_v5_15s", {
    prompt: "A dog circles around its owner",
    duration: 15,
    resolutionTier: "768p",
    aspectRatio: "1:1",
    imageUrl: image(0),
  }, (body) => {
    assert.equal(body.duration, 15);
    assert.equal(body.resolution, "768p(1:1)");
    assert.equal(body.ref_image_0, image(0));
  });

  await verifySubmission("minimax_h3_image_audio_to_video", {
    prompt: "This prompt must not be sent by the lip-sync workflow",
    duration: 15,
    resolutionTier: "1080p",
    aspectRatio: "16:9",
    imageUrl: image(0),
    audioUrl: audio(0),
  }, (body) => {
    assert.equal("prompt" in body, false);
    assert.equal("duration" in body, false);
    assert.equal(body.audio_duration, 15);
    assert.equal(body.resolution, "1080p横");
    assert.equal(body.ref_image_0, image(0));
    assert.equal(body.ref_audio_0, audio(0));
  });

  await verifySubmission("minimax_h3_image_audio_to_video_v2", {
    prompt: "A dog reacts to a sound cue",
    duration: 10,
    resolutionTier: "1080p",
    aspectRatio: "9:16",
    imageUrl: image(0),
    imageUrls: [image(1)],
    audioUrl: audio(0),
    audioUrls: [audio(1), audio(2)],
  }, (body) => {
    assert.equal(body.duration, 10);
    assert.equal(body.resolution, "1080p竖");
    assert.equal(body.ref_image_0, image(0));
    assert.equal(body.ref_image_1, image(1));
    assert.equal(body.ref_audio_0, audio(0));
    assert.equal(body.ref_audio_2, audio(2));
  });

  await verifySubmission("minimax_h3_image_audio_to_video_v2_15s", {
    prompt: "A dog pauses and looks back",
    duration: 15,
    resolutionTier: "480p",
    aspectRatio: "16:9",
  }, (body) => {
    assert.deepEqual(body, { prompt: "A dog pauses and looks back", duration: 15, resolution: "480p横" });
  });

  let forbiddenFetches = 0;
  globalThis.fetch = async () => {
    forbiddenFetches += 1;
    throw new Error("validation must run before fetch");
  };
  const textConfig = configFor("minimax_h3_lightx2v_no_pic");
  assert.deepEqual(validateAutodlComfyuiWorkflowInput(textConfig, {
    prompt: "invalid 1080 test",
    duration: 5,
    resolutionTier: "1080p",
    aspectRatio: "16:9",
  }), {
    ok: false,
    code: "AUTODL_COMFYUI_RESOLUTION_UNSUPPORTED",
    error: "当前工作流不支持 1080p",
  });
  const invalid = await generateAutodlComfyuiWorkflow(textConfig, {
    prompt: "invalid image test",
    duration: 5,
    resolutionTier: "480p",
    aspectRatio: "16:9",
    imageUrl: image(0),
  });
  assert.equal(invalid.status, "failed");
  assert.equal(forbiddenFetches, 0);

  console.log(JSON.stringify({
    status: "PASS",
    workflows: AUTODL_HOSTED_H3_WORKFLOWS.length,
    submit_method: "POST",
    poll_method: "GET",
    network_calls: 0,
    paid_generation_calls: 0,
  }));
}

main()
  .finally(() => { globalThis.fetch = originalFetch; })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
