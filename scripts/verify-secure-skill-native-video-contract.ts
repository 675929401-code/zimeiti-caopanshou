import assert from "node:assert/strict";
import { pollVideoTask, submitVideoTask, type VideoGenerateParams, type VideoModelConfig } from "../src/lib/video-adapter";
import { secureSkillNativeVideoBody } from "../src/lib/video-secure-skill-native";

const base: VideoModelConfig = {
  id: "offline-native", name: "Offline native", provider: "secure_skill_video",
  protocol_type: "secure_skill_video", api_endpoint: "https://fixture.invalid/v1", api_key: "offline-fixture-key",
  model_name: "muse-video", price_per_use: 1, duration_seconds: 5, supports_image_input: true,
  api_protocol_config: { min_duration: 1, min_submit_duration: 1, max_duration: 10, duration_options: Array.from({ length: 10 }, (_, i) => i + 1) },
};
const muse: VideoModelConfig = { ...base, api_protocol_config: { ...base.api_protocol_config, provider_resolution_policy: "omit-model-default", public_default_resolution_alias: "720p", native_resolution: "default" } };
const sd: VideoModelConfig = { ...base, model_name: "seedance2.0" };
const wan: VideoModelConfig = { ...base, protocol_type: "secure_skill_wan3_video", model_name: "wan3.0-video", api_protocol_config: { min_duration: 2, max_duration: 30, max_reference_images: 1, max_reference_audios: 0, supports_audio_input: false, supports_source_video: false } };
const saved = globalThis.fetch;
const requests: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
let checks = 0, mode: "normal" | "lost" | "no-id" | "wrong-id" | "no-url" | "temporary" = "normal";
async function submitted(config: VideoModelConfig, params: VideoGenerateParams) {
  const before = requests.length;
  const result = await submitVideoTask(config, params);
  assert.equal(requests.length, before + 1); assert.equal(requests.at(-1)!.method, "POST"); checks += 2;
  return { result, request: requests.at(-1)! };
}
async function blocked(config: VideoModelConfig, params: Partial<VideoGenerateParams>) {
  const before = requests.length;
  await assert.rejects(() => submitVideoTask(config, { prompt: "Offline shot", duration: 5, ...params }));
  assert.equal(requests.length, before); checks++;
}
async function main() {
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).origin, "https://fixture.invalid", "REAL_PROVIDER_FORBIDDEN");
    requests.push({ method: request.method, url: request.url, body: request.method === "POST" ? JSON.parse(await request.text()) : undefined });
    if (mode === "lost") throw new TypeError("Offline timeout after dispatch");
    if (mode === "temporary") return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    if (request.method === "POST") return Response.json(mode === "no-id" ? { status: "queued" } : { id: "original-task", status: "queued" });
    return Response.json({ id: mode === "wrong-id" ? "different-task" : "original-task", status: "completed", ...(mode === "no-url" ? {} : { output: [{ url: "https://media.fixture.invalid/original.mp4" }] }) });
  };
  try {
    let result = await submitted(muse, { prompt: "Offline Muse", duration: 1, aspectRatio: "16:9", resolutionTier: "720p" });
    assert.equal(result.request.url, "https://fixture.invalid/v1/videos");
    assert.deepEqual(result.request.body, { model: "muse-video", prompt: "Offline Muse", duration: 1, aspect_ratio: "16:9" }); checks += 2;
    const credentialUrl = new URL('https://images.fixture.invalid/a.png'); credentialUrl.username = 'fixture-user'; credentialUrl.password = 'fixture-password';
    const images = Array.from({ length: 10 }, (_, i) => `https://images.fixture.invalid/${i}.png`);
    result = await submitted(muse, { prompt: "Ten images", duration: 10, imageUrl: images[0], referenceImageUrl: images[0], imageUrls: images, aspectRatio: "9:16" });
    assert.deepEqual(result.request.body!.reference_images, images); assert.equal(result.request.body!.resolution, undefined); checks += 2;
    assert.equal(secureSkillNativeVideoBody(base, { prompt: "No quality override", duration: 5 }).resolution, undefined); checks++;
    for (const params of [{ duration: 0 }, { duration: 11 }, { duration: 2.5 }, { aspectRatio: "1:1" }, { resolutionTier: "1080p" }, { resolutionTier: "4k" }, { imageUrls: [...images, "https://images.fixture.invalid/extra.png"] }, { lastFrameUrl: images[0] }, { sourceVideoUrl: "https://media.fixture.invalid/source.mp4" }, { audioUrl: "https://media.fixture.invalid/a.mp3" }, { imageUrl: "http://images.fixture.invalid/a.png" }, { imageUrl: credentialUrl.href }, { imageUrl: 'https://127.0.0.1/a.png' }, { imageUrl: 'https://localhost/a.png' }]) await blocked(muse, params);
    await blocked(base, { resolutionTier: "720p" });
    await blocked({ ...muse, api_protocol_config: { ...muse.api_protocol_config, native_resolution: "720p" } }, { resolutionTier: "720p" });
    result = await submitted(sd, { prompt: "SS 2.0", duration: 1, resolutionTier: "720p" });
    assert.deepEqual(result.request.body, { model: "seedance2.0", prompt: "SS 2.0", duration: 1, aspect_ratio: "16:9", resolution: "720p" }); checks++;
    result = await submitted(sd, { prompt: "One image", duration: 10, imageUrl: images[0], referenceImageUrl: images[0] });
    assert.equal(result.request.body!.image_url, images[0]); assert.equal(result.request.body!.images, undefined); checks += 2;
    for (const params of [{ imageUrls: images.slice(0, 2) }, { audioUrls: ["https://media.fixture.invalid/a.mp3"] }, { sourceVideoUrl: "https://media.fixture.invalid/a.mp4" }, { lastFrameUrl: images[0] }, { generateAudio: false }, { resolutionTier: "480p" }, { resolutionTier: "720p", resolution: "1080p" }]) await blocked(sd, params);
    let before = requests.length; const polled = await pollVideoTask(sd, "original-task"); assert.equal(polled.status, "success"); assert.equal(requests.length, before + 1); assert.equal(requests.at(-1)!.url, "https://fixture.invalid/v1/videos/original-task"); checks += 3;
    mode = "wrong-id"; assert.equal((await pollVideoTask(sd, "original-task")).error, "VIDEO_TASK_RECEIPT_ID_MISMATCH"); checks++;
    mode = "no-url"; assert.equal((await pollVideoTask(muse, "original-task")).status, "processing"); checks++;
    mode = "temporary"; before = requests.length; assert.equal((await pollVideoTask(muse, "original-task")).status, "processing"); assert.equal(requests.length, before + 1); checks += 2;
    for (const unknown of ["lost", "no-id"] as const) { mode = unknown; const value = await submitted(sd, { prompt: "Original only", duration: 5 }); assert.equal(value.result.submissionOutcome, "unknown"); checks++; }
    mode = "normal";
    for (const resolution of ["480p", "720p", "1080p"]) { result = await submitted(wan, { prompt: "Wan text", duration: 2, resolutionTier: resolution }); assert.equal(result.request.body!.resolution, resolution.toUpperCase()); checks++; }
    result = await submitted(wan, { prompt: "Wan single", duration: 30, imageUrl: images[0], imageUrls: [images[0]], resolutionTier: "1080p" }); assert.deepEqual(result.request.body!.media, [{ type: "first_frame", url: images[0] }]); checks++;
    for (const params of [{ duration: 1 }, { duration: 31 }, { resolutionTier: "4k" }, { resolutionTier: "720p", resolution: "480p" }, { lastFrameUrl: images[0] }, { imageUrl: "http://images.fixture.invalid/a.png" }, { imageUrls: images.slice(0, 2) }, { sourceVideoUrl: "http://media.fixture.invalid/source.mp4" }, { sourceVideoUrl: "https://media.fixture.invalid/source.mp4" }, { audioUrl: "https://media.fixture.invalid/a.mp3" }]) await blocked(wan, params);
    const source = { ...wan, api_protocol_config: { ...wan.api_protocol_config, supports_source_video: true } };
    result = await submitted(source, { prompt: "Preserve source", duration: 5, sourceVideoUrl: "https://media.fixture.invalid/source.mp4" }); assert.deepEqual(result.request.body!.media, [{ type: "reference_video", url: "https://media.fixture.invalid/source.mp4" }]); checks++;
    const grok = { ...base, protocol_type: "secure_skill_grok_video", model_name: "grok-imagine-video-1.5", api_protocol_config: { min_duration: 3, max_duration: 15 } };
    result = await submitted(grok, { prompt: "Unchanged Grok", duration: 3, imageUrl: images[0], resolutionTier: "1080p" }); assert.equal(result.request.url, "https://fixture.invalid/openai/v1/videos"); assert.equal(result.request.body!.seconds, 3); checks += 2;
    const ss25 = { ...base, protocol_type: "secure_skill_seedance_video", model_name: "seedance-2.5", api_protocol_config: { min_duration: 4, max_duration: 30 } };
    result = await submitted(ss25, { prompt: "Unchanged SS25", duration: 8, imageUrl: images[0], resolutionTier: "720p" }); assert.equal(result.request.body!.seconds, 8); assert.equal(result.request.body!.duration, undefined); checks += 2;
    await blocked({ ...ss25, model_name: "seedance2.0" }, { duration: 8 });
    console.log(JSON.stringify({ passed: true, checks, mockedRequests: requests.length, providerCalls: 0, realNetworkRequests: 0, automaticSubmissionRetries: 0, officialDocs: "https://token.secure-skill.com/docs#muse-video" }));
  } finally { globalThis.fetch = saved; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
