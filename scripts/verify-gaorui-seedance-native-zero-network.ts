import assert from "node:assert/strict";
import { pollVideoTask, submitVideoTask, validateVideoParameterContract, type VideoGenerateParams, type VideoModelConfig } from "../src/lib/video-adapter";
import { resolveAiVideoInputAspectRatio } from "../src/lib/ai-video-page-capabilities";
import { gaoruiSeedanceNativeBody, isGaoruiSeedanceNativeModel, isGaoruiSeedanceNativePollModel } from "../src/lib/gaorui-seedance-native-contract";

const config: VideoModelConfig = {
  id: "fixture-native-seedance", name: "Offline Seedance", provider: "gaorui", protocol_type: "gaorui_video",
  model_name: "seedance-2.0-fast", api_endpoint: "https://fixture.invalid/v1", api_key: "offline-fixture-only",
  price_per_use: .5, duration_seconds: 4, supports_image_input: true,
  api_protocol_config: { image_field: "legacy_images", audio_field: "legacy_audios", source_video_field: "legacy_videos" },
};
const saved = { fetch: globalThis.fetch, log: console.log, warn: console.warn };
const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
const checks: string[] = [];
let reply: Record<string, unknown> = { id: "create-alias", task_id: "original-task", status: "queued", progress: 0 };
let httpStatus = 200;
let transportFailure = false;
const image = "https://fixture.invalid/ref.png";
const video = "https://fixture.invalid/ref.mp4";
const audio = "https://fixture.invalid/ref.wav";
const native = { prompt: "Offline movement", duration: 4, aspectRatio: "9:16", resolutionTier: "720p", generateAudio: false };

async function submit(params: VideoGenerateParams, model = config) {
  const count = calls.length;
  const result = await submitVideoTask(model, params);
  assert.equal(calls.length, count + 1);
  assert.equal(calls.at(-1)?.method, "POST");
  return { result, body: calls.at(-1)!.body! };
}

async function rejectsBeforeNetwork(name: string, params: Partial<VideoGenerateParams>, model = config) {
  const count = calls.length;
  await assert.rejects(() => submitVideoTask(model, { ...native, ...params }));
  assert.equal(calls.length, count, name);
  checks.push(name);
}

async function main() {
  try {
    console.log = console.warn = () => {};
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      assert.ok(["https://fixture.invalid", "https://gaorui.cc"].includes(new URL(request.url).origin) && ["/v1/videos", "/v1/videos/original-task"].includes(new URL(request.url).pathname), "REAL_NETWORK_FORBIDDEN");
      assert.ok(request.method === "GET" || request.method === "POST");
      calls.push({ url: request.url, method: request.method, body: request.method === "POST" ? JSON.parse(await request.text()) : undefined });
      if (transportFailure) throw new TypeError("Offline acknowledgement lost");
      return new Response(JSON.stringify(reply), { status: httpStatus, headers: { "Content-Type": "application/json" } });
    };

    const originalConfig = JSON.stringify(config);
    for (const model_name of ["seedance-2.0", "seedance-2.5"]) {
      assert.equal(isGaoruiSeedanceNativeModel(model_name), true); assert.equal(isGaoruiSeedanceNativePollModel(model_name), true);
      const plain = { ...config, model_name, api_endpoint: "https://gaorui.cc/v1", api_protocol_config: { protocol_family: "seedance_native_content" as const } };
      const accepted = model_name === "seedance-2.0" ? ["480p", "720p", "1080p", "4k", "4K"] : ["480p", "720p", "1080p"];
      for (const resolutionTier of accepted) {
        const body = gaoruiSeedanceNativeBody(plain, { ...native, resolutionTier });
        assert.equal(body.resolution, resolutionTier === "4K" ? "4k" : resolutionTier);
        const withImage = gaoruiSeedanceNativeBody(plain, { ...native, resolutionTier, imageUrl: image, aspectRatio: model_name === "seedance-2.5" ? "adaptive" : "9:16" });
        assert.equal(withImage.content[1].type, "image_url");
        assert.deepEqual((await submit({ ...native, resolutionTier, imageUrl: image, aspectRatio: model_name === "seedance-2.5" ? "adaptive" : "9:16" }, plain)).body, withImage);
      }
      for (const extra of [{ lastFrameUrl: image }, { imageUrls: [image] }, { sourceVideoUrl: video }, { audioUrl: audio }]) {
        assert.throws(() => gaoruiSeedanceNativeBody(plain, { ...native, ...extra }), /PLAIN_INPUT_UNSUPPORTED/u);
        assert.equal(validateVideoParameterContract(plain, { ...native, ...extra })?.parameter, "mediaInputs", "unsupported roles must fail before bridge/reservation");
      }
      if (model_name === "seedance-2.5") {
        assert.throws(() => gaoruiSeedanceNativeBody(plain, { ...native, imageUrl: image }), /FIRST_FRAME_RATIO_REQUIRED/u);
        assert.throws(() => gaoruiSeedanceNativeBody(plain, { ...native, resolutionTier: "4k" }), /RESOLUTION_INVALID/u);
        assert.equal(resolveAiVideoInputAspectRatio({ firstFrameRatioPolicy: "adaptive" }, "16:9", { imageUrl: image }), "adaptive");
        assert.equal(resolveAiVideoInputAspectRatio({ firstFrameRatioPolicy: "adaptive" }, "16:9", {}), "16:9");
        assert.equal(validateVideoParameterContract(plain, { ...native, imageUrl: image })?.parameter, "aspectRatio");
        assert.equal(validateVideoParameterContract(plain, { ...native, imageUrl: image, aspectRatio: "adaptive" }), null);
        assert.equal(validateVideoParameterContract(plain, { ...native, resolutionTier: "4k" })?.parameter, "resolution");
      }
      assert.throws(() => gaoruiSeedanceNativeBody(plain, { ...native, aspectRatio: "adaptive" }), /TEXT_RATIO_REQUIRED/u);
      checks.push(`${model_name}:plain-native-versioned-resolution-single-frame`);
    }
    for (const model_name of ["seedance-2.0-fast", "seedance-2.0-mini"]) {
      assert.equal(isGaoruiSeedanceNativeModel(model_name), true);
      assert.equal(isGaoruiSeedanceNativePollModel(model_name), true);
      const { result, body } = await submit(native, { ...config, model_name });
      assert.equal(result.taskId, "original-task");
      assert.equal(result.status, "queued");
      assert.deepEqual(body, { model: model_name, content: [{ type: "text", text: native.prompt }], duration: 4, ratio: "9:16", resolution: "720p", generate_audio: false });
      checks.push(`${model_name}:native-text-and-create-task-id`);
    }
    const first = await submit({ ...native, imageUrl: image });
    assert.deepEqual(first.body.content, [{ type: "text", text: native.prompt }, { type: "image_url", image_url: { url: image }, role: "first_frame" }]);
    checks.push("first-frame-role");
    const frames = await submit({ ...native, imageUrl: image, lastFrameUrl: image });
    assert.deepEqual(frames.body.content, [
      { type: "text", text: native.prompt },
      { type: "image_url", image_url: { url: image }, role: "first_frame" },
      { type: "image_url", image_url: { url: image }, role: "last_frame" },
    ]);
    checks.push("same-url-first-last-roles-preserved");
    const multimodal = await submit({ ...native, referenceImageUrl: image, imageUrls: [image, "https://fixture.invalid/ref2.png"], sourceVideoUrl: video, audioUrl: audio, audioUrls: [audio] });
    assert.deepEqual(multimodal.body.content, [
      { type: "text", text: native.prompt },
      { type: "image_url", image_url: { url: image }, role: "reference_image" },
      { type: "image_url", image_url: { url: image }, role: "reference_image" },
      { type: "image_url", image_url: { url: "https://fixture.invalid/ref2.png" }, role: "reference_image" },
      { type: "video_url", video_url: { url: video }, role: "reference_video" },
      { type: "audio_url", audio_url: { url: audio }, role: "reference_audio" },
      { type: "audio_url", audio_url: { url: audio }, role: "reference_audio" },
    ]);
    checks.push("all-native-reference-types-ordered-without-reference-promotion");
    const full = await submit({ ...native, imageUrls: Array.from({ length: 9 }, () => image), audioUrls: [audio, audio, audio] });
    assert.equal((full.body.content as unknown[]).length, 13);
    checks.push("nine-images-three-audios-no-truncation");
    const silent = await submit({ ...native, prompt: "", imageUrls: [image] });
    assert.deepEqual(silent.body.content, [{ type: "image_url", image_url: { url: image }, role: "reference_image" }]);
    checks.push("optional-text-with-visual");
    const defaulted = await submit({ prompt: "15秒 timeline is prose" });
    assert.equal(defaulted.body.duration, 4); assert.equal(defaulted.body.generate_audio, true);
    checks.push("configured-duration-no-prose-inference-and-default-audio");
    const configured = await submit({ prompt: native.prompt }, { ...config, api_protocol_config: { resolution: "480p", generate_audio: false } });
    assert.equal(configured.body.resolution, "480p"); assert.equal(configured.body.generate_audio, false);
    checks.push("configured-resolution-audio-defaults");
    for (const duration of [4, 5, 14, 15]) {
      assert.equal((await submit({ ...native, duration })).body.duration, duration);
      checks.push(`exact-duration-${duration}`);
    }
    for (const duration of [-1, 0, 3, 16, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejectsBeforeNetwork(`invalid-duration-${duration}`, { duration });
    }
    for (const ratio of ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]) {
      assert.equal((await submit({ ...native, aspectRatio: ratio })).body.ratio, ratio);
      checks.push(`native-ratio-${ratio}`);
    }
    await rejectsBeforeNetwork("unsupported-ratio", { aspectRatio: "auto" });
    await rejectsBeforeNetwork("unsupported-resolution-no-paid-downgrade", { resolutionTier: "1080p" });
    await rejectsBeforeNetwork("conflicting-resolution", { resolutionTier: "720p", resolution: "480p" });
    await rejectsBeforeNetwork("unmapped-negative-prompt", { negativePrompt: "Do not silently discard this" });
    await rejectsBeforeNetwork("no-content", { prompt: " " });
    await rejectsBeforeNetwork("last-frame-without-first", { lastFrameUrl: image });
    await rejectsBeforeNetwork("frames-and-references-conflict", { imageUrl: image, referenceImageUrl: image });
    await rejectsBeforeNetwork("frames-and-video-conflict", { imageUrl: image, sourceVideoUrl: video });
    await rejectsBeforeNetwork("frames-and-audio-conflict", { imageUrl: image, audioUrl: audio });
    await rejectsBeforeNetwork("audio-without-visual", { audioUrl: audio });
    await rejectsBeforeNetwork("ten-images-over-limit", { imageUrls: Array.from({ length: 10 }, () => image) });
    await rejectsBeforeNetwork("four-audios-over-limit", { sourceVideoUrl: video, audioUrls: Array.from({ length: 4 }, () => audio) });
    await rejectsBeforeNetwork("lower-configured-reference-limit", { imageUrls: [image, image, image] }, { ...config, api_protocol_config: { max_reference_images: 2 } });
    await rejectsBeforeNetwork("configured-image-limit-cannot-raise-provider-nine", { imageUrls: Array.from({ length: 10 }, () => image) }, { ...config, api_protocol_config: { max_reference_images: 100 } });
    await rejectsBeforeNetwork("configured-audio-limit-cannot-raise-provider-three", { sourceVideoUrl: video, audioUrls: Array.from({ length: 4 }, () => audio) }, { ...config, api_protocol_config: { max_reference_audios: 100 } });
    for (const limit of [-1, .5, Number.NaN]) {
      await rejectsBeforeNetwork(`invalid-configured-reference-limit-${limit}`, {}, { ...config, api_protocol_config: { max_reference_images: limit } });
    }
    const credentialMediaUrl = new URL("https://example.com/ref.png");
    credentialMediaUrl.username = "fixture-user";
    credentialMediaUrl.password = "fixture-password";
    for (const url of ["asset://untrusted-client", "data:image/png;base64,fixture", "http://example.com/ref.png", "https://127.0.0.1/ref.png", "https://10.0.0.1/ref.png", "https://localhost/ref.png", credentialMediaUrl.href, "https://[::1]/ref.png", ""]) {
      await rejectsBeforeNetwork(`public-https-only-${checks.length}`, { imageUrls: [url] });
    }
    await rejectsBeforeNetwork("over-64MiB-request", { prompt: "x".repeat(64 * 1024 * 1024) });

    const pollCases: Array<[Record<string, unknown>, string, string | undefined]> = [
      [{ status: "queued", progress: 0 }, "queued", undefined],
      [{ status: "running", progress: 35 }, "processing", undefined],
      [{ status: "expired" }, "failed", undefined],
      [{ status: "cancelled" }, "failed", "cancelled"],
      [{ status: "canceled" }, "failed", "cancelled"],
      [{ status: "failed", error: { code: "INVALID_MEDIA", message: "Offline media rejected" } }, "failed", undefined],
    ];
    for (const model_name of ["seedance-2.0", "seedance-2.5", "seedance-2.0-fast", "seedance-2.0-mini"]) {
      for (const [fields, status, terminalState] of pollCases) {
        reply = { id: "provider-cgt-alias", task_id: "another-alias", ...fields };
        const result = await pollVideoTask({ ...config, model_name }, "original-task");
        assert.equal(result.taskId, "original-task"); assert.equal(result.status, status); assert.equal(result.terminalState, terminalState);
        if (status === "failed") assert.ok(result.error);
        checks.push(`${model_name}:native-query-${String(fields.status)}-original-id`);
      }
    }
    for (const usage of [{ total_tokens: 281700, completion_tokens: 281700 }, undefined, { total_tokens: 10, completion_tokens: 11 }, { total_tokens: "10", completion_tokens: "10" }]) {
      reply = { id: "provider-cgt-alias", status: "succeeded", content: { video_url: video }, usage };
      for (const model_name of ["seedance-2.0", "seedance-2.5", "seedance-2.0-fast", "seedance-2.0-mini"]) {
        const result = await pollVideoTask({ ...config, model_name }, "original-task");
        assert.equal(result.taskId, "original-task"); assert.equal(result.status, "success"); assert.equal(result.videoUrl, video);
        assert.deepEqual(result.usage, usage?.total_tokens === 281700 ? { totalTokens: 281700, completionTokens: 281700 } : undefined);
        checks.push(`${model_name}:native-success-content-and-provider-usage-${checks.length}`);
      }
    }
    httpStatus = 404; reply = {};
    assert.equal((await pollVideoTask(config, "original-task")).status, "failed");
    checks.push("query-404-terminal");
    httpStatus = 503; reply = { message: "Offline unavailable" };
    assert.equal((await pollVideoTask(config, "original-task")).status, "processing");
    checks.push("query-503-remains-processing");
    httpStatus = 401; reply = { error: { message: "Unauthorized" } };
    await assert.rejects(() => pollVideoTask(config, "original-task"), error => error instanceof Error && /401/u.test(error.message));
    checks.push("query-auth-http-status-retained");
    httpStatus = 400; reply = { error: { code: "invalid_parameter", message: "Offline invalid parameter" } };
    const refused = await submit(native);
    assert.equal(refused.result.status, "failed"); assert.equal(refused.result.taskId, "");
    checks.push("explicit-submit-rejection-one-post");
    httpStatus = 503; reply = { message: "Temporary unavailable" };
    assert.equal((await submit(native)).result.submissionOutcome, "unknown");
    checks.push("submit-503-unknown-one-post");
    httpStatus = 200; transportFailure = true;
    assert.equal((await submit(native)).result.submissionOutcome, "unknown");
    checks.push("submit-transport-unknown-one-post");
    transportFailure = false;

    reply = { id: "offline-other-task", status: "queued" };
    const otherParams = { prompt: "Offline other model", duration: 10, aspectRatio: "9:16", resolutionTier: "720p", referenceImageUrl: image };
    for (const model of ["omni_flash_10s", "grok-imagine-1.0-video", "veo_3_1-components"]) {
      const { body } = await submit(otherParams, { ...config, model_name: model });
      assert.equal(body.prompt, otherParams.prompt); assert.equal(body.aspect_ratio, model.startsWith("grok") ? undefined : "9:16"); assert.equal(body.content, undefined);
      if (model.startsWith("omni")) { assert.equal(body.seconds, 10); assert.deepEqual(body.input_reference, [image]); }
      else if (model.startsWith("grok")) { assert.equal(body.seconds, 10); assert.equal(body.size, "720x1280"); assert.deepEqual(body.image_urls, [image]); }
      else { assert.equal(body.seconds, undefined); assert.deepEqual(body.images, [image]); }
      checks.push(`unchanged-gaorui-${model}`);
    }
    const secure = await submit(otherParams, { ...config, protocol_type: "secure_skill_seedance_video", model_name: "seedance-2.5" });
    assert.deepEqual(secure.body, { model: "seedance-2.5", prompt: otherParams.prompt, seconds: 10, resolution: "720p", aspect_ratio: "9:16", images: [image] });
    checks.push("unchanged-secure-skill-seedance-relay");
    assert.equal(JSON.stringify(config), originalConfig);
    checks.push("model-config-and-price-untouched");
  } finally {
    globalThis.fetch = saved.fetch; console.log = saved.log; console.warn = saved.warn;
  }
  console.log(JSON.stringify({ passed: true, checks: checks.length, cases: checks, simulatedPostCalls: calls.filter(call => call.method === "POST").length, simulatedGetCalls: calls.filter(call => call.method === "GET").length, realNetworkCalls: 0, providerGenerationCalls: 0, databaseWrites: 0, billingWrites: 0 }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
