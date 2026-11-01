import assert from "node:assert/strict";
import { videoWorkflowImageRequestFields } from "../src/lib/video-workflow-draft";
import { parseGeneratedVideoImageInputs } from "../src/lib/generated-image-reference";
import { gaoruiH3NativeBody } from "../src/lib/gaorui-h3-native-contract";
import { gaoruiGrokNativeBody } from "../src/lib/gaorui-grok-native-contract";
import { gaoruiSeedanceNativeBody } from "../src/lib/gaorui-seedance-native-contract";
import { submitVideoTask, type VideoGenerateParams, type VideoModelConfig } from "../src/lib/video-adapter";

const image = "https://fixture.invalid/ref.png?slot=original%20value";
const secondImage = "https://fixture.invalid/second.png";
const audio = "https://fixture.invalid/ref.wav";
const video = "https://fixture.invalid/ref.mp4";
type NativeFixtureConfig = VideoModelConfig & { model_name: string };
const base: NativeFixtureConfig = {
  id: "fixture-workbench-native", name: "Offline native wire", provider: "gaorui", protocol_type: "gaorui_video",
  api_endpoint: "https://fixture.invalid/v1", api_key: "offline-fixture-only", model_name: "minimax-h3",
  price_per_use: .5, duration_seconds: 5, supports_image_input: true,
};
const models: NativeFixtureConfig[] = [
  { ...base, api_protocol_config: { workflow_input_mode: "multi_image_audio" } },
  ...["grok-imagine-1.0-video", "grok-imagine-video-1.5", "grok-imagine-video-1.5-preview"].map(model_name => ({ ...base, model_name, duration_seconds: 10 })),
  ...["seedance-2.0-fast", "seedance-2.0-mini"].map(model_name => ({ ...base, model_name, duration_seconds: 4 })),
];
type ImageInputs = Parameters<typeof videoWorkflowImageRequestFields>[0];
type MediaKey = "imageUrl" | "lastFrameUrl" | "referenceImageUrl" | "sourceVideoUrl" | "audioUrl" | "imageUrls" | "audioUrls";
const singleKeys: MediaKey[] = ["imageUrl", "lastFrameUrl", "referenceImageUrl", "sourceVideoUrl", "audioUrl"];
const calls: Array<Record<string, unknown>> = [];
const checks: string[] = [], failures: Array<{ name: string; error: string }> = [];
let forbiddenRequests = 0;
const saved = { fetch: globalThis.fetch, log: console.log, warn: console.warn };

function native(config: NativeFixtureConfig, params: VideoGenerateParams): Record<string, unknown> {
  if (config.model_name === "minimax-h3") return gaoruiH3NativeBody(config, params);
  if (config.model_name.startsWith("grok-")) return gaoruiGrokNativeBody(config, params);
  return gaoruiSeedanceNativeBody(config, params);
}

// Match /video's JSON fields and /api/video/generate's image parsing/adapter mapping.
// No route, database, credential resolver, upload or external transport is invoked.
function wireParams(config: NativeFixtureConfig, images: ImageInputs = {}, extra: Record<string, unknown> = {}) {
  const wire = { prompt: "Offline workbench movement", duration: config.duration_seconds,
    ...videoWorkflowImageRequestFields(images), reference_audio_urls: [], audio_url: "", source_video_url: "", ...extra };
  const parsed = parseGeneratedVideoImageInputs(wire);
  const params: VideoGenerateParams = {
    prompt: wire.prompt, duration: wire.duration, imageUrl: parsed.imageUrl,
    lastFrameUrl: parsed.lastFrameUrl, referenceImageUrl: parsed.referenceImageUrl, imageUrls: parsed.referenceImageUrls,
    audioUrl: wire.audio_url as string, audioUrls: wire.reference_audio_urls as string[], sourceVideoUrl: wire.source_video_url as string,
  };
  return { wire, params };
}

async function check(name: string, action: () => void | Promise<void>) {
  try { await action(); checks.push(name); }
  catch (error) { failures.push({ name, error: error instanceof Error ? error.message : String(error) }); }
}

async function sameWireBody(config: NativeFixtureConfig, images: ImageInputs = {}, extra: Record<string, unknown> = {}) {
  const { wire, params } = wireParams(config, images, extra);
  const original = JSON.stringify({ wire, params, config });
  const expected = native(config, { prompt: params.prompt, duration: params.duration,
    imageUrl: images.imageUrl, lastFrameUrl: images.lastFrameUrl, referenceImageUrl: images.referenceImageUrl,
    imageUrls: images.referenceImageUrls, ...(extra.audio_url ? { audioUrl: extra.audio_url as string } : {}),
    ...(extra.source_video_url ? { sourceVideoUrl: extra.source_video_url as string } : {}),
    ...(Array.isArray(extra.reference_audio_urls) && extra.reference_audio_urls.length ? { audioUrls: extra.reference_audio_urls } : {}) });
  assert.deepEqual(native(config, params), expected);
  const count = calls.length;
  const result = await submitVideoTask(config, params);
  assert.equal(result.taskId, "fixture-task");
  assert.equal(calls.length, count + 1);
  assert.deepEqual(calls.at(-1), expected);
  assert.equal(JSON.stringify({ wire, params, config }), original, "wire, parsed params and config must remain unchanged");
  return expected;
}

async function rejectedBeforePost(config: NativeFixtureConfig, params: VideoGenerateParams) {
  const before = calls.length;
  assert.throws(() => native(config, params));
  await assert.rejects(() => submitVideoTask(config, params));
  assert.equal(calls.length, before);
}

async function main() {
  try {
    console.log = console.warn = () => {};
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method !== "POST" || request.url !== "https://fixture.invalid/v1/videos") {
        forbiddenRequests++;
        throw new Error("REAL_NETWORK_FORBIDDEN: only the exact local fixture POST is allowed");
      }
      calls.push(JSON.parse(await request.text()));
      return new Response(JSON.stringify({ id: "fixture-task", status: "queued" }), { headers: { "Content-Type": "application/json" } });
    };
    for (const model of models) {
      const prefix = model.model_name;
      await check(`${prefix}:real-workbench-text-wire`, async () => { await sameWireBody(model); });
      await check(`${prefix}:real-workbench-reference-wire`, async () => {
        const body = await sameWireBody(model, { referenceImageUrl: image });
        if (prefix === "minimax-h3") { assert.deepEqual(body.images, [image]); assert.equal(body.metadata, undefined); }
        else if (prefix.startsWith("grok-")) assert.deepEqual(body.image_urls, [image]);
        else assert.deepEqual((body.content as unknown[])[1], { type: "image_url", image_url: { url: image }, role: "reference_image" });
      });
      await check(`${prefix}:all-whitespace-single-slots-omitted`, async () => {
        const params: VideoGenerateParams = { prompt: "Offline whitespace", duration: model.duration_seconds,
          imageUrl: " \t", lastFrameUrl: "\r\n", referenceImageUrl: " ", audioUrl: "\t", sourceVideoUrl: "\n", imageUrls: [], audioUrls: [] };
        const expected = native(model, { prompt: params.prompt, duration: params.duration });
        assert.deepEqual(native(model, params), expected);
        const before = calls.length;
        await submitVideoTask(model, params);
        assert.equal(calls.length, before + 1); assert.deepEqual(calls.at(-1), expected);
      });
      await check(`${prefix}:nonblank-single-url-original-string-preserved`, async () => {
        await sameWireBody(model, { referenceImageUrl: ` \t${image}\n ` });
      });
      for (const key of singleKeys) {
        for (const value of [null, 42, false, {}]) await check(`${prefix}:${key}-invalid-${String(value)}`, async () => {
          await rejectedBeforePost(model, { prompt: "Offline invalid singleton", duration: model.duration_seconds, [key]: value } as VideoGenerateParams);
        });
      }
      for (const key of ["imageUrls", "audioUrls"] as const) {
        for (const value of [[""], [" \t"], null, "", 42, {}]) await check(`${prefix}:${key}-invalid-${JSON.stringify(value)}`, async () => {
          await rejectedBeforePost(model, { prompt: "Offline invalid list", duration: model.duration_seconds, [key]: value } as VideoGenerateParams);
        });
      }
      await check(`${prefix}:zero-reference-limits-allow-absent`, async () => {
        await sameWireBody({ ...model, api_protocol_config: { ...model.api_protocol_config, max_reference_images: 0, max_reference_audios: 0 } });
      });
      await check(`${prefix}:zero-image-limit-rejects-actual-reference`, async () => {
        await rejectedBeforePost({ ...model, api_protocol_config: { max_reference_images: 0 } }, { prompt: "Offline disabled images", duration: model.duration_seconds, referenceImageUrl: image });
      });
      if (!prefix.endsWith("preview")) await check(`${prefix}:ordered-reference-slots-no-dedup-or-promotion`, async () => {
        const body = await sameWireBody(model, { referenceImageUrl: image, referenceImageUrls: [image, secondImage] });
        if (prefix === "minimax-h3") assert.deepEqual(body.images, [image, image, secondImage]);
        else if (prefix.startsWith("grok-")) assert.deepEqual(body.image_urls, [image, image, secondImage]);
        else assert.deepEqual((body.content as Array<{ role?: string; image_url?: { url: string } }>).slice(1).map(item => [item.role, item.image_url?.url]),
          [["reference_image", image], ["reference_image", image], ["reference_image", secondImage]]);
      });
      if (prefix.startsWith("grok-")) {
        for (const params of [{ sourceVideoUrl: video }, { audioUrl: audio }, { audioUrls: [audio] }]) await check(`${prefix}:unsupported-nonempty-${Object.keys(params)[0]}`, async () => {
          await rejectedBeforePost(model, { prompt: "Offline unsupported kind", duration: model.duration_seconds, ...params });
        });
      } else {
        await check(`${prefix}:same-url-first-last-frame-roles-preserved`, async () => {
          const body = await sameWireBody(model, { imageUrl: image, lastFrameUrl: image });
          if (prefix === "minimax-h3") { assert.deepEqual(body.metadata, { first_frame: image, last_frame: image }); assert.equal(body.images, undefined); }
          else assert.deepEqual((body.content as Array<{ role?: string }>).slice(1).map(item => item.role), ["first_frame", "last_frame"]);
        });
        await check(`${prefix}:nonempty-audio-video-and-reference-values-preserved`, async () => {
          await sameWireBody(model, { referenceImageUrl: image }, { audio_url: audio, source_video_url: video, reference_audio_urls: [audio] });
        });
        await check(`${prefix}:zero-audio-limit-rejects-actual-reference`, async () => {
          await rejectedBeforePost({ ...model, api_protocol_config: { max_reference_audios: 0 } }, { prompt: "Offline disabled audio", duration: model.duration_seconds, referenceImageUrl: image, audioUrl: audio });
        });
      }
    }
    assert.equal(forbiddenRequests, 0);
  } finally {
    globalThis.fetch = saved.fetch; console.log = saved.log; console.warn = saved.warn;
  }
  console.log(JSON.stringify({ passed: !failures.length, checks: checks.length, cases: checks, failures, simulatedPostCalls: calls.length,
    forbiddenRequests, realNetworkCalls: 0, providerGenerationCalls: 0, databaseWrites: 0, billingWrites: 0 }));
  assert.equal(failures.length, 0, "Native workbench wire contract failures");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
