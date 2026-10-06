import assert from "node:assert/strict";
import { pollVideoTask, submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";

const config: VideoModelConfig = {
  id: "omni-video-edit-chA",
  name: "Omni Video Edit · 渠道A",
  provider: "secure_skill_flow_jobs",
  api_endpoint: "https://token.secure-skill.com/v1",
  api_key: "fixture-api-key-value",
  protocol_type: "secure_skill_flow_jobs",
  price_per_use: 0.73,
  duration_seconds: 30,
  supports_image_input: true,
  model_name: "omni_video_edit",
  api_protocol_config: { requires_source_video: true },
};

const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;

async function main() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    requests.push({ url, method: init?.method || "GET", body });

    if (init?.method === "POST") {
      return new Response(JSON.stringify({ id: "job_omni_edit_001", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      id: "job_omni_edit_001",
      status: "completed",
      video_url: "https://cdn.example.com/omni-edit.mp4",
      progress: 100,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const missingSource = await submitVideoTask(config, {
      prompt: "Keep the original camera motion and enhance the animated texture.",
      imageUrl: "https://cdn.example.com/character.png",
    });
    assert.equal(missingSource.status, "failed");
    assert.match(missingSource.error || "", /源视频/);
    assert.equal(requests.length, 0, "Missing source video must fail before upstream request.");

    const submitted = await submitVideoTask(config, {
      prompt: "Keep the source video's camera motion. Match the character outfit to image 1 and warm animated lighting to image 2.",
      sourceVideoUrl: "https://cdn.example.com/source.mp4",
      imageUrl: "https://cdn.example.com/character.png",
      referenceImageUrl: "https://cdn.example.com/style.png",
      lastFrameUrl: "https://cdn.example.com/end.png",
      duration: 15,
      aspectRatio: "16:9",
      resolutionTier: "1080p",
    });

    assert.equal(submitted.taskId, "job_omni_edit_001");
    assert.equal(submitted.status, "queued");
    assert.equal(requests[0]?.url, "https://token.secure-skill.com/v1/jobs");
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.body?.model, "omni_video_edit");
    assert.equal(requests[0]?.body?.video_url, "https://cdn.example.com/source.mp4");
    assert.equal("duration" in (requests[0]?.body || {}), false, "omni_video_edit must not send duration.");
    assert.equal(requests[0]?.body?.stream, false);

    const messages = requests[0]?.body?.messages as Array<Record<string, unknown>>;
    assert.equal(messages?.[0]?.role, "user");
    const content = messages?.[0]?.content as Array<Record<string, unknown>>;
    assert.equal(content?.[0]?.type, "text");
    assert.equal(content?.filter((item) => item.type === "image_url").length, 3);

    const polled = await pollVideoTask(config, submitted.taskId);
    assert.equal(requests[1]?.url, "https://token.secure-skill.com/v1/jobs/job_omni_edit_001");
    assert.deepEqual(polled, {
      taskId: "job_omni_edit_001",
      status: "success",
      videoUrl: "https://cdn.example.com/omni-edit.mp4",
      error: undefined,
      progress: 100,
    });

    const textConfig: VideoModelConfig = {
      ...config,
      id: "flow-veo-t2v-fast",
      name: "Flow VEO 3.1 文生视频 Fast",
      model_name: "veo_3_1_t2v_fast",
      duration_seconds: 8,
      api_protocol_config: { max_reference_images: 0 },
    };
    const textRequestIndex = requests.length;
    const textSubmitted = await submitVideoTask(textConfig, {
      prompt: "A sunrise over a calm lake.",
      imageUrl: "https://cdn.example.com/ignored.png",
      duration: 15,
      resolutionTier: "1080p",
    });
    assert.equal(textSubmitted.status, "queued");
    const textBody = requests[textRequestIndex]?.body || {};
    assert.equal(textBody.model, "veo_3_1_t2v_fast");
    assert.equal(textBody.resolution, "720p");
    assert.deepEqual(textBody.generationConfig, { videoConfig: { aspectRatio: "16:9" } }, "VEO needs the ratio but must not receive duration.");
    const textMessages = textBody.messages as Array<Record<string, unknown>>;
    assert.equal(textMessages[0]?.content, "A sunrise over a calm lake.", "VEO text mode must not silently attach stale images.");

    const imageConfig: VideoModelConfig = {
      ...config,
      id: "flow-veo-i2v-fast",
      name: "Flow VEO 3.1 图生视频 Fast",
      model_name: "veo_3_1_i2v_s_fast_fl",
      api_protocol_config: { required_reference_images: 1, max_reference_images: 1 },
    };
    const beforeMissingImage = requests.length;
    const missingImage = await submitVideoTask(imageConfig, { prompt: "Rotate the product slowly." });
    assert.equal(missingImage.status, "failed");
    assert.match(missingImage.error || "", /至少需要一张参考图/);
    assert.equal(requests.length, beforeMissingImage, "Invalid image-to-video input must fail before dispatch.");

    const referenceConfig: VideoModelConfig = {
      ...config,
      id: "flow-veo-r2v-fast",
      name: "Flow VEO 3.1 多参考图 Fast",
      model_name: "veo_3_1_r2v_fast",
      api_protocol_config: { required_reference_images: 1, max_reference_images: 5 },
    };
    const referenceRequestIndex = requests.length;
    await submitVideoTask(referenceConfig, {
      prompt: "Keep every reference consistent.",
      imageUrl: "https://cdn.example.com/ref-1.png",
      referenceImageUrl: "https://cdn.example.com/ref-2.png",
      lastFrameUrl: "https://cdn.example.com/ref-3.png",
      imageUrls: [
        "https://cdn.example.com/ref-4.png",
        "https://cdn.example.com/ref-5.png",
        "https://cdn.example.com/ref-5.png",
        "https://cdn.example.com/ref-6-ignored.png",
      ],
    });
    const referenceMessages = requests[referenceRequestIndex]?.body?.messages as Array<Record<string, unknown>>;
    const referenceContent = referenceMessages[0]?.content as Array<Record<string, unknown>>;
    assert.equal(referenceContent.filter((item) => item.type === "image_url").length, 5);

    const interpolationConfig: VideoModelConfig = {
      ...config,
      id: "flow-veo-interpolation-lite",
      name: "Flow VEO 3.1 首尾帧 Lite",
      model_name: "veo_3_1_interpolation_lite",
      api_protocol_config: { required_reference_images: 2, max_reference_images: 2 },
    };
    const beforeMissingLastFrame = requests.length;
    const missingLastFrame = await submitVideoTask(interpolationConfig, {
      prompt: "Transition between frames.",
      imageUrl: "https://cdn.example.com/first.png",
    });
    assert.equal(missingLastFrame.status, "failed");
    assert.match(missingLastFrame.error || "", /首帧和尾帧/);
    assert.equal(requests.length, beforeMissingLastFrame);

    const sameFrameIndex = requests.length;
    const sameFrame = await submitVideoTask(interpolationConfig, {
      prompt: "Return smoothly to the starting pose.",
      imageUrl: "https://cdn.example.com/loop.png",
      lastFrameUrl: "https://cdn.example.com/loop.png",
      referenceImageUrl: "https://cdn.example.com/unrelated.png",
      aspectRatio: "9:16",
      duration: 15,
    });
    assert.equal(sameFrame.status, "queued");
    assert.deepEqual(requests[sameFrameIndex].body?.generationConfig, { videoConfig: { aspectRatio: "9:16" } });
    const sameMessages = requests[sameFrameIndex].body?.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    assert.deepEqual(sameMessages[0].content.filter(item => item.type === 'image_url').map(item => item.image_url?.url),
      ['https://cdn.example.com/loop.png', 'https://cdn.example.com/loop.png']);
    const beforeUnrelatedFrame = requests.length;
    const unrelatedFrame = await submitVideoTask(interpolationConfig, {
      prompt: "Transition between frames.",
      imageUrl: "https://cdn.example.com/first.png",
      referenceImageUrl: "https://cdn.example.com/reference.png",
    });
    assert.equal(unrelatedFrame.status, "failed");
    assert.equal(requests.length, beforeUnrelatedFrame, 'An unrelated reference cannot replace the last-frame slot.');

    console.log("Secure Skill Flow Jobs adapter verification: PASS (model-specific inputs, no paid request)");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
