import assert from "node:assert/strict";
import { submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";

async function main() {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "adapter-smoke-task", status: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const previewConfig: VideoModelConfig = {
    id: "grok-imagine-video-1-5-preview-chA",
    name: "Grok Imagine Video 1.5 Preview",
    provider: "secure_skill_A",
    api_endpoint: "https://token.secure-skill.com/v1",
    api_key: "test-key",
    protocol_type: "secure_skill_grok_video",
    price_per_use: 1.2,
    duration_seconds: 15,
    supports_image_input: true,
    model_name: "grok-imagine-video-1.5-preview",
  };

  try {
    const result = await submitVideoTask(previewConfig, {
      prompt: "The dog looks up and takes one quiet step forward.",
      imageUrl: "https://example.com/shot-01.png",
      duration: 3,
      aspectRatio: "16:9",
      resolutionTier: "1080p",
    });

    assert.equal(result.taskId, "adapter-smoke-task");
    assert.match(requestUrl, /\/openai\/v1\/videos$/u);
    assert.deepEqual(requestBody.input_reference, { image_url: "https://example.com/shot-01.png" });
    assert.equal(requestBody.reference_images, undefined, "首帧不能误发成参考图引导模式");
    assert.equal(requestBody.image, undefined, "单图不能误发旧版 image 字段");
    assert.equal(requestBody.resolution, "1080p");
    assert.equal(requestBody.seconds, 3);

    const fastConfig: VideoModelConfig = {
      ...previewConfig,
      id: "grok-imagine-video-1-5-fast-chA",
      name: "Grok Imagine Video 1.5 Fast",
      model_name: "grok-imagine-video-1.5-fast",
    };
    const fastResult = await submitVideoTask(fastConfig, {
      prompt: "The dog quickly steps back and freezes.",
      imageUrl: "https://example.com/shot-02.png",
      duration: 4,
      aspectRatio: "16:9",
      resolutionTier: "1080p",
    });
    assert.equal(fastResult.taskId, "adapter-smoke-task");
    assert.equal(requestBody.resolution, "720p", "Fast 型号收到旧卡片的 1080p 时必须自动收敛到上游支持的 720p");

    const h3Config: VideoModelConfig = {
      ...previewConfig,
      id: "minimax-h3-chA",
      name: "MiniMax H3",
      model_name: "minimax-h3",
      protocol_type: "secure_skill_video",
      duration_seconds: 15,
    };
    const h3Result = await submitVideoTask(h3Config, {
      prompt: "Keep the referenced subject consistent and move the camera slowly forward.",
      imageUrl: "https://example.com/h3-reference.png",
      duration: 15,
      aspectRatio: "16:9",
      resolutionTier: "2K",
    });
    assert.equal(h3Result.taskId, "adapter-smoke-task");
    assert.match(requestUrl, /\/v1\/videos$/u);
    assert.equal(requestBody.model, "minimax-h3");
    assert.equal(requestBody.resolution, "2k", "H3 的 UI 2K 必须按供应商契约提交为小写 2k");
    assert.deepEqual(requestBody.image_urls, ["https://example.com/h3-reference.png"]);
    assert.equal(requestBody.duration, 15);

    const ecommerceH3Config: VideoModelConfig = {
      ...h3Config,
      id: "minimax-h3-ecommerce-chA",
      name: "MiniMax H3 · 电商漫剧优化版",
      api_protocol_config: {
        required_reference_images: 0,
        max_reference_images: 9,
        max_reference_audios: 3,
        min_submit_duration: 4,
      },
    };
    const ecommerceTextResult = await submitVideoTask(ecommerceH3Config, {
      prompt: "A clean product showcase with a slow camera push.",
      duration: 4,
      aspectRatio: "9:16",
      resolutionTier: "720p",
    });
    assert.equal(ecommerceTextResult.taskId, "adapter-smoke-task");
    assert.equal(requestBody.duration, 4, "优化版 H3 的独立协议允许 4 秒文生视频");
    assert.equal(requestBody.ratio, "9:16");
    assert.equal(requestBody.image_urls, undefined, "文生模式不能伪造参考图字段");

    await submitVideoTask(ecommerceH3Config, {
      prompt: "Use all supplied visual and audio references.",
      imageUrl: "https://example.com/h3-a.png",
      imageUrls: ["https://example.com/h3-b.png", "https://example.com/h3-a.png"],
      audioUrl: "https://example.com/h3-a.mp3",
      audioUrls: ["https://example.com/h3-b.mp3"],
      duration: 6,
      aspectRatio: "16:9",
      resolutionTier: "720p",
    });
    assert.deepEqual(requestBody.image_urls, ["https://example.com/h3-a.png", "https://example.com/h3-b.png"]);
    assert.deepEqual(requestBody.audio_urls, ["https://example.com/h3-a.mp3", "https://example.com/h3-b.mp3"]);

    await submitVideoTask(h3Config, {
      prompt: "Legacy-card resolution compatibility check.",
      imageUrl: "https://example.com/h3-reference.png",
      duration: 15,
      aspectRatio: "16:9",
      resolutionTier: "1080p",
    });
    assert.equal(requestBody.resolution, "2k", "H3 历史卡片的无效 1080p 必须收敛到默认 2k");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("Secure Skill video adapter verification passed: Grok resolution rules and MiniMax H3 720p/2k/4k contract are enforced.");
}

void main();
