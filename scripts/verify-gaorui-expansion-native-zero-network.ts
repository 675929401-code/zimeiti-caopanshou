import assert from "node:assert/strict";
import { pollVideoTask, submitVideoTask, type VideoGenerateParams, type VideoModelConfig } from "../src/lib/video-adapter";
import { gaoruiH3NativeBody, GAORUI_H3_NATIVE_RESOLUTION_BY_PLATFORM_TIER } from "../src/lib/gaorui-h3-native-contract";
import { isGaoruiSeedanceNativeModel } from "../src/lib/gaorui-seedance-native-contract";

const base: VideoModelConfig = {
  id: "fixture-expansion", name: "Offline native model", provider: "gaorui", protocol_type: "gaorui_video",
  api_endpoint: "https://fixture.invalid/v1", api_key: "offline-fixture-only", model_name: "minimax-h3",
  price_per_use: .5, duration_seconds: 5, supports_image_input: true,
};
const image = "https://fixture.invalid/reference.png", audio = "https://fixture.invalid/reference.wav", video = "https://fixture.invalid/reference.mp4";
const saved = { fetch: globalThis.fetch, log: console.log, warn: console.warn, timeout: AbortSignal.timeout };
const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [], timeouts: number[] = [];
const cases: string[] = [];
let reply: Record<string, unknown> = { id: "original-task", status: "queued" }, http = 200, connectionLost = false;
async function submit(params: VideoGenerateParams, config = base) {
  const before = calls.length, timeoutBefore = timeouts.length;
  const result = await submitVideoTask(config, params);
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)?.method, "POST");
  return { result, body: calls.at(-1)!.body!, timeout: timeouts[timeoutBefore] };
}
async function blocked(name: string, params: Partial<VideoGenerateParams>, config = base) {
  const before = calls.length;
  await assert.rejects(() => submitVideoTask(config, { prompt: "Offline shot", ...params }));
  assert.equal(calls.length, before); cases.push(name);
}
const grok = (model_name: string, extra: Partial<VideoModelConfig> = {}): VideoModelConfig => ({ ...base, model_name, duration_seconds: 10, ...extra });

async function main() {
  try {
    console.log = console.warn = () => {};
    AbortSignal.timeout = milliseconds => { timeouts.push(milliseconds); return saved.timeout(milliseconds); };
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      assert.ok(request.url === "https://fixture.invalid/v1/videos" || request.url === "https://fixture.invalid/v1/videos/original-task", "REAL_NETWORK_FORBIDDEN");
      calls.push({ method: request.method, url: request.url, body: request.method === "POST" ? JSON.parse(await request.text()) : undefined });
      if (connectionLost) throw new TypeError("Offline acknowledgement lost");
      return new Response(JSON.stringify(reply), { status: http, headers: { "Content-Type": "application/json" } });
    };
    const untouched = JSON.stringify(base);
    const text = await submit({ prompt: "Offline text", duration: 5 });
    assert.deepEqual(text.body, { model: "minimax-h3", prompt: "Offline text", duration: 5, resolution: "768p", aspect_ratio: "16:9" });
    assert.equal(text.timeout, 150_000); assert.equal(text.result.taskId, "original-task"); cases.push("h3:native-text-duration-resolution-timeout");
    for (const seconds of [1, 4, 5, 10, 15]) {
      assert.equal((await submit({ prompt: "Offline", duration: seconds })).body.duration, seconds); cases.push(`h3:exact-duration-${seconds}`);
    }
    assert.deepEqual(GAORUI_H3_NATIVE_RESOLUTION_BY_PLATFORM_TIER, { "720p": "768p", "768p": "768p" });
    for (const surface of ["video-page", "storyboard-workbench"]) {
      for (const reference of [{ imageUrl: image }, { referenceImageUrl: image }]) {
        const { body } = await submit({ prompt: `Offline ${surface}`, ...reference, duration: 5, resolutionTier: "720p", resolution: "720p", aspectRatio: "9:16" }, { ...base, api_protocol_config: { workflow_input_mode: "multi_image_audio" } });
        assert.equal(body.resolution, "768p"); assert.deepEqual(body.images, [image]); assert.equal(body.metadata, undefined);
        cases.push(`h3:single-reference-${surface}-${Object.keys(reference)[0]}-no-frame-promotion`);
      }
    }
    const workbenchH3 = { ...base, api_protocol_config: { workflow_input_mode: "multi_image_audio" as const } };
    const workbenchReferences = await submit({ prompt: "Offline workbench primary and extra refs", imageUrl: image, referenceImageUrl: "https://fixture.invalid/extra.png", imageUrls: [image], audioUrl: audio }, workbenchH3);
    assert.deepEqual(workbenchReferences.body.images, [image, "https://fixture.invalid/extra.png", image]);
    assert.deepEqual(workbenchReferences.body.metadata, { audios: [audio] }); cases.push("h3:configured-multimodal-primary-and-extra-images-all-preserved");
    const explicitFrames = await submit({ prompt: "Offline explicit frames", imageUrl: image, lastFrameUrl: image }, workbenchH3);
    assert.deepEqual(explicitFrames.body.metadata, { first_frame: image, last_frame: image }); assert.equal(explicitFrames.body.images, undefined); cases.push("h3:last-frame-explicitly-selects-frame-mode");
    const configuredFrames = await submit({ prompt: "Offline configured first frame", imageUrl: image }, { ...base, api_protocol_config: { workflow_input_mode: "first_last_frame" } });
    assert.deepEqual(configuredFrames.body.metadata, { first_frame: image }); cases.push("h3:configured-frame-workflow-retains-native-first-frame");
    await blocked("h3:explicit-frames-cannot-mix-extra-references", { imageUrl: image, lastFrameUrl: image, imageUrls: [image] }, workbenchH3);
    for (const frames of [{ imageUrl: image }, { lastFrameUrl: image }, { imageUrl: image, lastFrameUrl: image }]) {
      const { body } = await submit({ prompt: "Offline frames", ...frames });
      assert.deepEqual(body.metadata, { ...(frames.imageUrl ? { first_frame: image } : {}), ...(frames.lastFrameUrl ? { last_frame: image } : {}) });
      assert.equal(body.images, undefined); assert.equal(body.aspect_ratio, "adaptive"); cases.push(`h3:frames-${cases.length}`);
    }
    const { body: mixed } = await submit({ prompt: "Offline multimodal", imageUrls: [image, image], sourceVideoUrl: video, audioUrl: audio, audioUrls: [audio] });
    assert.deepEqual(mixed.images, [image, image]); assert.deepEqual(mixed.metadata, { videos: [video], audios: [audio, audio] }); cases.push("h3:ordered-reference-image-video-audio-no-dedup");
    assert.equal(((await submit({ prompt: "Offline max", imageUrls: Array.from({ length: 9 }, () => image), audioUrls: [audio, audio, audio] })).body.images as string[]).length, 9); cases.push("h3:twelve-total-references-preserved");
    for (const params of [
      { duration: 0 }, { duration: 16 }, { duration: 4.5 }, { duration: Number.NaN },
      { prompt: " " }, { prompt: "字".repeat(7001) }, { negativePrompt: "unsupported" }, { generateAudio: false },
      { resolutionTier: "1080p" }, { resolutionTier: "480p" }, { aspectRatio: "adaptive" }, { aspectRatio: "auto" },
      { imageUrl: image, imageUrls: [image] }, { lastFrameUrl: image, audioUrl: audio }, { imageUrl: image, sourceVideoUrl: video },
      { imageUrls: Array.from({ length: 10 }, () => image) }, { audioUrls: [audio, audio, audio, audio] },
      { imageUrls: Array.from({ length: 9 }, () => image), audioUrls: [audio, audio, audio], sourceVideoUrl: video },
    ]) await blocked(`h3:preflight-rejection-${cases.length}`, params);
    const authenticatedFixtureUrl = new URL("https://fixture.invalid/ref.png");
    authenticatedFixtureUrl.username = "offline-user";
    authenticatedFixtureUrl.password = "offline-password";
    for (const url of ["asset://client", "data:image/png;base64,fixture", "http://example.com/ref.png", "https://127.0.0.1/ref.png", authenticatedFixtureUrl.href, ""]) {
      await blocked(`h3:public-https-${cases.length}`, { imageUrls: [url] });
    }
    await blocked("h3:lower-configured-reference-limit", { imageUrls: [image, image] }, { ...base, api_protocol_config: { max_reference_images: 1 } });
    assert.throws(() => gaoruiH3NativeBody({ ...base, model_name: "other-h3" }, { prompt: "Offline" })); cases.push("h3:exact-model-only");

    for (const [model, durations] of [["grok-imagine-1.0-video", [6, 10, 15]], ["grok-imagine-video-1.5", [6, 8, 10, 12, 15]], ["grok-imagine-video-1.5-preview", [6, 8, 10, 12, 15]]] as const) {
      for (const duration of durations) {
        const { body } = await submit({ prompt: "Offline Grok", duration, aspectRatio: "9:16" }, grok(model));
        assert.deepEqual(body, { model, prompt: "Offline Grok", seconds: duration, size: model === "grok-imagine-1.0-video" ? "720x1280" : "9:16", ...(model !== "grok-imagine-1.0-video" ? { resolution: "480p" } : {}) });
        cases.push(`${model}:native-text-${duration}`);
      }
      for (const duration of [0, 5, 20, 8.5]) await blocked(`${model}:invalid-duration-${duration}`, { duration }, grok(model));
      const { body } = await submit({ prompt: "Offline image", duration: 10, referenceImageUrl: image, resolutionTier: "720p" }, grok(model));
      assert.deepEqual(body.image_urls, [image]); assert.equal(body.image_url, undefined); cases.push(`${model}:reference-image-list`);
    }
    for (const model of ["grok-imagine-1.0-video", "grok-imagine-video-1.5"]) {
      const refs = Array.from({ length: 6 }, (_, index) => `https://fixture.invalid/ref-${index}.png`);
      assert.deepEqual((await submit({ prompt: "Offline five", duration: 10, imageUrls: refs.slice(0, 5) }, grok(model))).body.image_urls, refs.slice(0, 5));
      await blocked(`${model}:six-refs-no-truncation`, { duration: 10, imageUrls: refs }, grok(model)); cases.push(`${model}:five-references-kept`);
    }
    await blocked("grok10:multi-ref-over-ten-seconds", { duration: 15, imageUrls: [image, "https://fixture.invalid/second.png"] }, grok("grok-imagine-1.0-video"));
    const repeated = await submit({ prompt: "Offline indexed refs", duration: 10, imageUrl: image, referenceImageUrl: image }, grok("grok-imagine-video-1.5"));
    assert.deepEqual(repeated.body.image_urls, [image, image]); cases.push("grok15:explicit-reference-indices-not-deduplicated");
    await blocked("grok-preview:conservative-one-ref-limit", { duration: 10, imageUrls: [image, "https://fixture.invalid/second.png"] }, grok("grok-imagine-video-1.5-preview"));
    for (const params of [{ sourceVideoUrl: video }, { audioUrl: audio }, { negativePrompt: "unsupported" }, { resolutionTier: "1080p" }, { imageUrls: ["https://localhost/ref.png"] }]) {
      await blocked(`grok:preflight-${cases.length}`, { duration: 10, ...params }, grok("grok-imagine-video-1.5"));
    }
    const mini = { ...base, model_name: "seedance-2.0-mini", duration_seconds: 4 };
    assert.equal(isGaoruiSeedanceNativeModel(mini.model_name), true);
    assert.deepEqual((await submit({ prompt: "Offline Mini", duration: 4, imageUrl: image }, mini)).body, { model: "seedance-2.0-mini", content: [{ type: "text", text: "Offline Mini" }, { type: "image_url", image_url: { url: image }, role: "first_frame" }], duration: 4, ratio: "16:9", resolution: "720p", generate_audio: true }); cases.push("seedance-mini:official-content-body");
    const miniRef = await submit({ prompt: "Offline Mini reference", referenceImageUrl: image, duration: 4 }, mini);
    assert.deepEqual((miniRef.body.content as unknown[])[1], { type: "image_url", image_url: { url: image }, role: "reference_image" }); cases.push("seedance-mini:reference-not-promoted");
    await blocked("gaorui-seedance25:unverified-contract-never-posted", { duration: 4 }, { ...mini, model_name: "seedance-2.5" });
    await blocked("gaorui-seedance20:unverified-contract-never-posted", { duration: 4 }, { ...mini, model_name: "seedance-2.0" });
    for (const model of [base, mini]) {
      for (const [status, expected] of [["IN_PROGRESS", "processing"], ["SUCCESS", "success"], ["FAILURE", "failed"]] as const) {
        reply = { id: "provider-cgt-alias", status, video_url: "https://fixture.invalid/result.mp4", error: { message: "Offline provider failure" } };
        const result = await pollVideoTask(model, "original-task");
        assert.equal(result.taskId, "original-task"); assert.equal(result.status, expected);
        if (expected === "success") assert.equal(result.videoUrl, "https://fixture.invalid/result.mp4");
        cases.push(`${model.model_name}:query-${status}`);
      }
    }
    reply = { status: "expired" }; assert.equal((await pollVideoTask(mini, "original-task")).status, "failed"); cases.push("seedance-mini:expired-terminal");
    for (const model of [base, grok("grok-imagine-video-1.5"), mini]) {
      http = 503; reply = { message: "Temporary offline failure" };
      assert.equal((await submit({ prompt: "Offline once", duration: model.duration_seconds }, model)).result.submissionOutcome, "unknown");
      connectionLost = true; http = 200;
      assert.equal((await submit({ prompt: "Offline once", duration: model.duration_seconds }, model)).result.submissionOutcome, "unknown");
      connectionLost = false; cases.push(`${model.model_name}:unknown-ack-no-retry`);
    }
    reply = { id: "original-task", status: "queued" }; http = 200;
    const omni = await submit({ prompt: "Offline Omni", duration: 10, imageUrl: image, negativePrompt: "existing Omni field" }, { ...base, model_name: "omni_flash_10s" });
    assert.equal(omni.body.seconds, 10); assert.equal(omni.body.negative_prompt, "existing Omni field"); assert.deepEqual(omni.body.input_reference, [image]); cases.push("omni:existing-wire-unchanged");
    const secure = await submit({ prompt: "Offline SS", duration: 10, referenceImageUrl: image }, { ...base, protocol_type: "secure_skill_seedance_video", model_name: "seedance-2.5" });
    assert.deepEqual(secure.body, { model: "seedance-2.5", prompt: "Offline SS", seconds: 10, resolution: "720p", aspect_ratio: "9:16", images: [image] }); cases.push("secure-skill25:existing-wire-unchanged");
    await blocked("secure-skill-seedance20:no-unverified-model-alias", { duration: 10 }, { ...base, protocol_type: "secure_skill_seedance_video", model_name: "seedance2.0" });
    assert.equal(JSON.stringify(base), untouched); cases.push("source-config-prices-not-mutated");
  } finally { globalThis.fetch = saved.fetch; console.log = saved.log; console.warn = saved.warn; AbortSignal.timeout = saved.timeout; }
  console.log(JSON.stringify({ passed: true, checks: cases.length, cases, simulatedPostCalls: calls.filter(call => call.method === "POST").length, simulatedGetCalls: calls.filter(call => call.method === "GET").length, realNetworkCalls: 0, providerGenerationCalls: 0, databaseWrites: 0, billingWrites: 0 }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
