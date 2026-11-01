import assert from "node:assert/strict";
import { submitVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";

const model: VideoModelConfig = {
  id: "omni-flash-10s-720p-ch3",
  name: "Omni Flash · 10秒 · 最高1080P · 渠道C",
  provider: "gaorui",
  api_endpoint: "https://video.example.test/v1",
  api_key: "test-key",
  protocol_type: "gaorui_video",
  price_per_use: 0.55,
  duration_seconds: 10,
  supports_image_input: true,
  model_name: "omni_flash_10s",
};

async function main() {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];

  try {
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "omni-contract-task", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await submitVideoTask(model, {
      prompt: "The owner crosses outside before the door closes once.",
      imageUrl: "https://example.com/storyboard.png",
      negativePrompt: "duplicated subjects, extra limbs, storyboard grid",
      duration: 10,
      aspectRatio: "16:9",
      resolutionTier: "1080p",
    });

    assert.equal(result.taskId, "omni-contract-task");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.negative_prompt, "duplicated subjects, extra limbs, storyboard grid");
    assert.deepEqual(bodies[0]?.input_reference, ["https://example.com/storyboard.png"]);
    assert.equal(bodies[0]?.resolution, "1080p");
    assert.equal(bodies[0]?.seconds, 10);

    for (const modelName of ["veo_3_1", "veo_3_1-fl", "veo_3_1-components"]) {
      bodies.length = 0;
      await submitVideoTask({ ...model, model_name: modelName }, {
        prompt: "A quiet landscape", imageUrl: "https://example.com/first.png",
        lastFrameUrl: "https://example.com/last.png", imageUrls: ["https://example.com/third.png"], resolutionTier: "1080p", aspectRatio: "9:16",
      });
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].resolution, "1080p");
      assert.equal(bodies[0].aspect_ratio, "9:16");
      assert.equal(bodies[0].seconds, undefined);
      assert.equal(bodies[0].size, undefined);
      assert.equal(bodies[0].image_urls, undefined);
      assert.deepEqual(bodies[0].images, modelName === "veo_3_1" ? undefined : modelName.endsWith("-fl") ? ["https://example.com/first.png", "https://example.com/last.png"] : ["https://example.com/first.png", "https://example.com/last.png", "https://example.com/third.png"]);
    }
    bodies.length = 0;
    await submitVideoTask({ ...model, model_name: 'seedance-2.0-fast', api_protocol_config: { image_field: 'image_urls', audio_field: 'reference_audios' } }, { prompt: 'Lip sync', imageUrls: ['https://example.com/portrait.png'], audioUrls: ['https://example.com/voice.wav'], duration: 4 });
    assert.deepEqual(bodies[0].content, [
      { type: 'text', text: 'Lip sync' },
      { type: 'image_url', image_url: { url: 'https://example.com/portrait.png' }, role: 'reference_image' },
      { type: 'audio_url', audio_url: { url: 'https://example.com/voice.wav' }, role: 'reference_audio' },
    ]);
    assert.equal(bodies[0].duration, 4);
    assert.equal(bodies[0].ratio, '16:9');
    assert.equal(bodies[0].prompt, undefined);
    assert.equal(bodies[0].seconds, undefined);
    assert.equal(bodies[0].image_urls, undefined);
    assert.equal(bodies[0].reference_audios, undefined);
    bodies.length = 0;
    const missingImages = await submitVideoTask({ ...model, model_name: "veo_3_1-fl" }, { prompt: "A landscape" });
    assert.equal(missingImages.status, "failed");
    assert.equal(bodies.length, 0);
    bodies.length = 0;
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: "temporary upstream failure" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    };

    const unknown = await submitVideoTask(model, {
      prompt: "Single paid submission contract.",
      duration: 10,
      aspectRatio: "16:9",
    });
    assert.equal(unknown.status, "processing");
    assert.equal(unknown.submissionOutcome, "unknown");
    assert.equal(bodies.length, 1, "5xx must not trigger a second paid POST");

    console.log("Gaorui video submit contract: PASS (negative prompt forwarded; one POST only). ");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
