/* eslint-disable @typescript-eslint/no-explicit-any -- Actual server helpers execute with explicit isolated I/O fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import sharp from "sharp";
import { validateUploadBuffer } from "../src/lib/file-upload-security";
import { isPublicVideoAssetUrl } from "../src/lib/video-public-url";

const files = ["src/lib/server/generated-image-video-bridge.ts", "src/lib/server/generated-image-reference.ts", "src/app/api/video/generate/route.ts", "src/lib/file-upload-security.ts", "src/storage/object/manager.ts", "scripts/verify-generated-image-hosted-bridge.ts"];
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const before = Object.fromEntries(files.map(file => [file, hash(file)]));
const checks: string[] = [];
const output = `.codex-evidence/storyboard-delivery-audit-20261023/repair/hosted-generated-bridge/verification-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
let realNetworkCalls = 0;
globalThis.fetch = (async () => { realNetworkCalls++; throw new Error("REAL_NETWORK_FORBIDDEN"); }) as typeof fetch;
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function load(file: string, deps: Record<string, any>, globals: Record<string, any> = {}) {
  const loaded = { exports: {} as any };
  vm.runInNewContext(compile(readFileSync(file, "utf8")), { module: loaded, exports: loaded.exports, Buffer, URL, Error, Promise, Date, Set, setTimeout, clearTimeout,
    require(name: string) { assert.ok(name in deps, `Unmocked dependency ${name}`); return deps[name]; }, ...globals });
  return loaded.exports;
}
const refs = load("src/lib/generated-image-reference.ts", { zod: { z } });
const reference = { schema: "generated_image_ref.v1", recordId: "a".repeat(64) };
const owner = "generated-bridge-fixture-owner";
function fixtureUrl(base: string, options: { signature?: boolean; credentials?: boolean } = {}) {
  const url = new URL(base);
  if (options.signature) url.searchParams.set("signature", "synthetic-fixture");
  if (options.credentials) { url.username = "fixture-user"; url.password = "fixture-password"; }
  return url.toString();
}
let imageBytes: Buffer;
type Scenario = { user?: string; state?: string; delivered?: string; expired?: boolean; dbError?: boolean; mime?: string; bytes?: Buffer; uploadError?: boolean; hangUpload?: boolean; result?: Record<string, unknown> };
function fixture(options: Scenario = {}, timerOverride = false) {
  const calls = { reads: 0, uploads: [] as any[], raw: [] as any[] };
  const server = load("src/lib/server/generated-image-reference.ts", {
    "@/lib/generated-image-reference": refs, "@/lib/video-public-url": { isPublicVideoAssetUrl }, "@/lib/safe-fetch": { SafeFetchError: class extends Error {} },
    "@/storage/database/supabase-client": { getSupabaseAdminClient: () => ({ from(table: string) {
      assert.equal(table, "image_generation_requests"); let actualUser = "", actualRecord = "";
      const query = { select() { return query; }, eq(key: string, value: string) { if (key === "user_id") actualUser = value; if (key === "record_id") actualRecord = value; return query; }, async maybeSingle() {
        if (options.dbError) return { data: null, error: { message: "synthetic lookup failed" } };
        return { data: actualUser === (options.user || owner) && actualRecord === reference.recordId ? { state: options.state || "completed", delivery_state: options.delivered || "delivered",
          response: { deliveryMode: "provider_url", providerUrl: fixtureUrl("https://owned-provider.invalid/image", { signature: true }), sourceExpiredAt: options.expired ? "2026-10-23T00:00:00Z" : undefined } } : null };
      } }; return query;
    } }) },
    "@/lib/image-provider-delivery": { async readProviderImage() { calls.reads++; return { buffer: options.bytes || imageBytes, contentType: options.mime || "image/png" }; } },
    sharp: { default: sharp },
  });
  const deps = { readMaterial: server.readGeneratedImageMaterial, async upload(bytes: Buffer, name: string, mime: string, settings: any) {
    calls.uploads.push({ digest: createHash("sha256").update(bytes).digest("hex"), name, mime, settings });
    if (options.uploadError) throw new Error("synthetic upload failed");
    if (options.hangUpload) return new Promise<any>(() => undefined);
    const key = `${settings.prefix}${new Date().toISOString().slice(0, 10).replace(/-/gu, "/")}/${name}`;
    return { key, url: `https://fixture-123.cos.ap-guangzhou.myqcloud.com/${key}`, isPublic: true, provider: "tencent_cos", size: bytes.length, contentType: mime, category: "image", ...options.result };
  } };
  const loaded = load(files[0], { "server-only": {}, "node:crypto": { createHash }, "@/lib/file-upload-security": { validateUploadBuffer }, "@/lib/video-public-url": { isPublicVideoAssetUrl }, "@/lib/server/generated-image-reference": server },
    timerOverride ? { setTimeout: (cb: () => void, ms: number) => { assert.equal(ms, 60_000); return setTimeout(cb, 5); } } : {});
  return { calls, server, bridge: (ref = reference, userId = owner) => loaded.bridgeGeneratedImageForVideoProvider({ userId, reference: ref }, deps), module: loaded, deps };
}
async function check(name: string, test: () => void | Promise<void>) { await test(); checks.push(name); }
const route = readFileSync(files[2], "utf8");
const gate = route.slice(route.indexOf("    let effectiveImageUrl = image_url;"), route.indexOf("    // 新版 AutoDL ComfyUI workflow"));
async function execute(body: Record<string, unknown>, options: Scenario & { protocol?: string; multipart?: boolean; failRaw?: boolean } = {}) {
  const f = fixture(options, options.hangUpload); const generatedInputs = refs.parseGeneratedVideoImageInputs(body); const loaded = { exports: {} as any };
  const counter = { reserves: 0, posts: 0 };
  vm.runInNewContext(compile(`module.exports=async()=>{${gate}; reserve();submit();return {imageUrl:effectiveImageUrl,lastFrameUrl:effectiveLastFrameUrl,referenceImageUrl:effectiveReferenceImageUrl,imageUrls:effectiveReferenceImageUrls};};`), {
    module: loaded, Set, Date, userId: owner, generatedInputs, image_url: generatedInputs.imageUrl, last_frame_url: generatedInputs.lastFrameUrl,
    reference_image_url: generatedInputs.referenceImageUrl, referenceImageUrls: generatedInputs.referenceImageUrls || [], image_storage_key: body.image_storage_key || "",
    audio_url: body.audio_url || "", referenceAudioUrls: body.reference_audio_urls || [], source_video_url: "", useAutodlH3Lifecycle: false,
    selectedModel: { protocol_type: options.protocol || "hosted", supports_image_input: true }, selectedProtocolConfig: { request_format: options.multipart ? "multipart" : "json" },
    isAutodlComfyuiHostedProtocol: (protocol: string) => protocol === "hosted", generatedImageReferenceUri: refs.generatedImageReferenceUri,
    GeneratedImageReferenceError: f.server.GeneratedImageReferenceError,
    bridgeGeneratedImageForVideoProvider: (input: any) => f.module.bridgeGeneratedImageForVideoProvider(input, f.deps),
    resolveGeneratedImageReference: async (input: any) => { assert.equal(input.userId, owner); return fixtureUrl("https://provider.invalid/fresh", { signature: true }); },
    readGeneratedImageMaterial: f.server.readGeneratedImageMaterial,
    hasAnyVideoReference: (input: any) => Object.values(input).some(value => Array.isArray(value) ? value.length : Boolean(value)),
    isTencentCosAssetUrl: (url: string) => url.includes(".myqcloud.com/"),
    bridgeVideoProviderAsset: async (...args: any[]) => { f.calls.raw.push(args); if (options.failRaw) throw new Error("raw ownership denied"); return `https://raw-fixture.invalid/${f.calls.raw.length}`; },
    NextResponse: { json: (body: any, init: any) => ({ body, status: init.status }) }, writeVideoTrace: async () => undefined,
    traceId: "fixture", traceModelId: "fixture", traceTaskLabel: "fixture", tracePromptHash: "fixture", submitStart: Date.now(),
    reserve: () => counter.reserves++, submit: () => counter.posts++,
  });
  return { result: await loaded.exports(), counter, ...f, generatedInputs };
}
async function main() {
  imageBytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
  await check("actual owned delivered material becomes a strict public content-addressed copy without user_files options", async () => {
    const f = fixture(); const url = await f.bridge(); assert.equal(f.calls.reads, 1); assert.equal(f.calls.uploads.length, 1);
    const upload = f.calls.uploads[0]; assert.equal(upload.settings.userId, undefined); assert.equal(upload.settings.requireOwnershipRecord, undefined);
    assert.equal(upload.settings.providerType, "tencent_cos"); assert.equal(upload.settings.strictProvider, true); assert.equal(upload.settings.publicRead, true);
    assert.ok(url.includes(createHash("sha256").update(owner).digest("hex").slice(0, 16))); assert.equal(new URL(url).search, ""); assert.equal(url.includes("signature"), false);
  });
  for (const [name, options] of Object.entries({ otherOwner: { user: "another-owner" }, notCompleted: { state: "processing" }, refundShape: { state: "failed_unknown", delivered: "held" }, notDelivered: { delivered: "pending" }, expired: { expired: true }, lookupError: { dbError: true } })) {
    await check(`${name} refuses before reading or uploading`, async () => { const f = fixture(options); await assert.rejects(f.bridge()); assert.equal(f.calls.reads, 0); assert.equal(f.calls.uploads.length, 0); });
  }
  await check("empty owner refuses before material access", async () => { const f = fixture(); await assert.rejects(f.bridge(reference, " ")); assert.equal(f.calls.reads, 0); });
  await check("same owner and content on same UTC day reuse key; different owner and crop change key", async () => {
    const f = fixture(); const a = await f.bridge(), b = await f.bridge(); assert.equal(a, b);
    const another = fixture({ user: "another-owner" }); assert.notEqual(await another.bridge(reference, "another-owner"), a);
    const cropped = await f.bridge({ ...reference, transform: { kind: "crop", x: 2, y: 3, width: 4, height: 5 } } as any); assert.notEqual(cropped, a);
    assert.equal(f.calls.uploads[2].mime, "image/png");
  });
  await check("invalid crop and malformed typed reference refuse before upload", async () => {
    const f = fixture(); await assert.rejects(f.bridge({ ...reference, transform: { kind: "crop", x: 15, y: 0, width: 4, height: 5 } } as any));
    await assert.rejects(f.bridge({ ...reference, url: "https://unowned.invalid/x" } as any)); assert.equal(f.calls.uploads.length, 0);
  });
  for (const [name, options] of Object.entries({ empty: { bytes: Buffer.alloc(0) }, oversize: { bytes: Buffer.alloc(16 * 1024 * 1024 + 1) }, html: { bytes: Buffer.from("<html>active</html>"), mime: "text/html" }, mismatch: { mime: "image/jpeg" }, gif: { bytes: Buffer.from("GIF89a synthetic"), mime: "image/gif" } })) {
    await check(`${name} image bytes refuse before upload`, async () => { const f = fixture(options); await assert.rejects(f.bridge()); assert.equal(f.calls.uploads.length, 0); });
  }
  for (const [name, result] of Object.entries({ wrongProvider: { provider: "local" }, private: { isPublic: false }, wrongKey: { key: "other/key" }, wrongSize: { size: 1 }, wrongMime: { contentType: "image/jpeg" }, signed: { url: fixtureUrl("https://fixture.cos.ap-guangzhou.myqcloud.com/x", { signature: true }) }, fragment: { url: "https://fixture.cos.ap-guangzhou.myqcloud.com/x#bad" }, credentials: { url: fixtureUrl("https://fixture.cos.ap-guangzhou.myqcloud.com/x", { credentials: true }) }, internal: { url: "https://fixture.cos-internal.ap-guangzhou.myqcloud.com/x" }, wrongPath: { url: "https://fixture.cos.ap-guangzhou.myqcloud.com/other" }, insecure: { url: "http://fixture.cos.ap-guangzhou.myqcloud.com/x" }, unrelatedHost: { url: "https://evil.invalid/x" }, wrongPort: { url: "https://fixture.cos.ap-guangzhou.myqcloud.com:8443/x" } })) {
    await check(`${name} upload receipt fails closed`, async () => { await assert.rejects(fixture({ result }).bridge()); });
  }
  await check("hung upload has a real 60-second bound and cannot dispatch or reserve", async () => {
    const started = Date.now(); const f = await execute({ image_ref: reference }, { hangUpload: true }); assert.ok(Date.now() - started < 1000);
    assert.equal(f.result.status, 503); assert.equal(f.result.body.error_code, "GENERATED_IMAGE_BRIDGE_TIMEOUT"); assert.equal(f.result.body.task_submitted, false); assert.deepEqual(f.counter, { reserves: 0, posts: 0 });
  });
  for (const field of ["image_ref", "last_frame_ref", "reference_image_ref", "reference_image_inputs"]) {
    await check(`actual route hosted ${field} bridges once and skips only verified generated slot`, async () => {
      const f = await execute({ [field]: field.endsWith("inputs") ? [reference] : reference }); assert.equal(f.calls.uploads.length, 1); assert.equal(f.calls.raw.length, 0); assert.deepEqual(f.counter, { reserves: 1, posts: 1 });
    });
  }
  await check("mixed typed/raw positions and audio retain exact raw bridge and order", async () => {
    const raw = "https://owned.cos.ap-guangzhou.myqcloud.com/manual.png";
    const f = await execute({ image_ref: reference, last_frame_url: raw, reference_image_ref: reference, reference_image_inputs: [raw, reference, raw], audio_url: "https://audio.invalid/a.wav" });
    assert.equal(f.calls.uploads.length, 3); assert.equal(f.calls.raw.length, 4); assert.equal(f.calls.raw[0][0], raw); assert.equal(f.calls.raw[3][2], "audio");
    assert.equal(f.result.imageUrls[0], "https://raw-fixture.invalid/2"); assert.equal(f.result.imageUrls[2], "https://raw-fixture.invalid/3"); assert.ok(f.result.imageUrls[1].includes("video-inputs/generated-provider-bridge/"));
  });
  await check("raw ownership rejection still blocks mixed request before reservation", async () => {
    const f = await execute({ image_ref: reference, last_frame_url: "https://other.cos.ap-test.myqcloud.com/x.png" }, { failRaw: true }); assert.equal(f.result.status, 502); assert.equal(f.result.body.task_submitted, false); assert.deepEqual(f.counter, { reserves: 0, posts: 0 });
  });
  for (const options of [{ protocol: "secure_skill_video" }, { protocol: "newapi_video", multipart: true }]) {
    await check(`non-hosted ${options.protocol} keeps prior path without a copy`, async () => { const f = await execute({ image_ref: reference }, options); assert.equal(f.calls.uploads.length, 0); assert.equal(f.calls.raw.length, 0); assert.equal(f.counter.posts, 1); });
  }
  await check("typed identity and request snapshot remain canonical rather than temporary bridge URLs", async () => {
    const f = await execute({ image_ref: reference }); const canonical = refs.generatedImageReferenceUri(reference);
    const start = route.indexOf("    const adapterParams:");
    const code = route.slice(route.indexOf("    const requestFingerprint = buildVideoRequestFingerprint(", start), route.indexOf("    const dispatch =", start))
      + route.slice(route.indexOf("    const requestSnapshot = buildVideoGenerationRequestSnapshot(", start), route.indexOf("    const reservation = await reserveVideoGenerationTask(", start));
    const executeSnapshot = (url: string) => {
      const loaded = { exports: {} as any };
      vm.runInNewContext(compile(`${code};module.exports={requestFingerprint,requestSnapshot};`), {
        module: loaded, generatedInputs: f.generatedInputs, generatedImageUri: canonical, image_url: canonical, last_frame_url: undefined, reference_image_url: undefined, referenceImageUrls: [],
        effectiveImageUrl: url, effectiveLastFrameUrl: undefined, effectiveReferenceImageUrl: undefined, effectiveReferenceImageUrls: [],
        channelConfig: { id: "fixture", protocol_type: "hosted" }, billing: {}, executionPrompt: "fixture", prompt: "fixture", promptNormalizations: [], negative_prompt: "", effectiveAudioUrl: "", effectiveReferenceAudioUrls: [], effectiveSourceVideoUrl: "", body: {},
        generateAudio: undefined, videoTiming: { target: 5, submit: 5 }, aspect_ratio: "16:9", selectedResolution: "720p", dispatch: undefined, adapterParams: { imageUrl: url }, image_storage_key: "", audio_url: "", referenceAudioUrls: [], source_video_url: "", ownedPageAssetRefs: new Map(),
        snapshotFps: null, snapshotSeed: null, snapshotGenerateAudio: null, publicRequestedModelId: "fixture", routingSnapshot: { configVersion: "a".repeat(64) },
        buildVideoRequestFingerprint: (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex"), buildVideoGenerationRequestSnapshot: (value: unknown) => value, buildVideoRequestAssetRefs: (value: unknown) => value,
      }); return loaded.exports;
    };
    const a = executeSnapshot(f.result.imageUrl), b = executeSnapshot("https://fixture.cos.ap-test.myqcloud.com/next-day-copy"); assert.equal(a.requestFingerprint, b.requestFingerprint);
    assert.equal(a.requestSnapshot.providerPayload.imageUrl, canonical); assert.equal(JSON.stringify(a).includes("generated-provider-bridge"), false);
  });
  assert.equal(realNetworkCalls, 0); const after = Object.fromEntries(files.map(file => [file, hash(file)])); assert.deepEqual(after, before);
  mkdirSync(output, { recursive: true }); writeFileSync(`${output}/tests.json`, JSON.stringify({ passed: true, checkCount: checks.length, checks, sourceHashesBefore: before, sourceHashesAfter: after,
    sourceUnchanged: true, realNetworkCalls, realDatabaseWrites: 0, realStorageWrites: 0, realGenerationCalls: 0,
    scope: "Actual helper and owned reader, real sharp crop/signature checks, actual route gate and snapshot statements; explicit RAM I/O fixtures. No live provider/storage/database acceptance.",
    limitations: ["The video-inputs/generated-provider-bridge prefix follows the managed source retention policy; deployed bucket lifecycle needs separate verification.", "Timed-out COS writes may finish under their content-addressed key; provider video dispatch stays blocked."] }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, output, realNetworkCalls }));
}
main().catch(error => { mkdirSync(output, { recursive: true }); writeFileSync(`${output}/failure.json`, JSON.stringify({ passed: false, checks, error: error instanceof Error ? error.stack : String(error) }, null, 2)); console.error(error); process.exitCode = 1; });
