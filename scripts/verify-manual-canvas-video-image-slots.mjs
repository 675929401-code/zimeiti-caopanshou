import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

assert.equal(process.version, "v24.19.0");
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function load(file, dependencies) {
  const module = { exports: {} };
  runInNewContext(compile(readFileSync(file, "utf8")), { module, exports: module.exports, URL,
    require: name => { assert.ok(name in dependencies, "UNEXPECTED_DEPENDENCY"); return dependencies[name]; } });
  return module.exports;
}
const refs = load("src/lib/generated-image-reference.ts", { zod: { z } });
const draft = load("src/lib/video-workflow-draft.ts", { "@/lib/generated-image-reference": refs, "@/lib/workbench-user-storage": {} });
const source = readFileSync("src/components/manual-canvas.tsx", "utf8");
const start = source.indexOf('      } else if (node.data.kind === "video") {') + '      } else if (node.data.kind === "video") {'.length;
const end = source.indexOf("            if (response.ok) {", start);
assert.ok(start > 100 && end > start, "ACTUAL_VIDEO_SUBMIT_BRANCH_NOT_FOUND");
const stableStart = source.indexOf("function stableCanvasMediaIdentity("), stableEnd = source.indexOf("function visibleKindLabel", stableStart);
assert.ok(stableStart > 0 && stableEnd > stableStart);
// Execute all actual pre-submit guards, mapping, fingerprint and fetch construction;
// stop immediately after the first HTTP submission (no poll, backend or paid work).
const actual = compile(source.slice(stableStart, stableEnd) + '\nmodule.exports=async function(){let runtime=initialRuntime,taskId="",publicModelName,estimatedCost;'
  + source.slice(start, end) + 'return {fingerprint:clientRequestFingerprint};}}}');
const ref = digit => ({ schema: "generated_image_ref.v1", recordId: digit.repeat(64) });
const a = ref("a"), b = ref("b"), c = ref("c");
const uri = refs.generatedImageReferenceUri;
const raw = "https://legacy.invalid/owned.png";
const image = (id, url, imageRef, extra = {}) => ({ id, data: { kind: "image", outputUrl: url, history: [], ...(imageRef ? { imageRef } : {}), ...extra } });
let checks = 0;
async function execute(images, imageUrls, options = {}) {
  const model = { id: "video-model", name: "Video", provider: "autodl_h3_selfhost", supportsImageInput: true,
    requiresImage: true, maxReferenceImages: 8, supportsAudioInput: true, ...options.model };
  const node = { id: "video-node", data: { kind: "video", title: "Video", history: [], modelId: model.id, videoMode: "multimodal",
    aspectRatio: "16:9", durationSeconds: 5, resolution: "720p", ...options.node } };
  const requests = [], counts = { slots: 0, cost: 0, attempt: 0 };
  const module = { exports: {} };
  runInNewContext(actual, { module, initialRuntime: [...images, node], edgesRef: { current: images.map(item => ({ source: item.id, target: node.id })) },
    nodeId: node.id, node, inputs: { imageUrls, audioUrls: options.audioUrls || [] }, prompt: "Animate metadata: value", token: "synthetic-only",
    videoModels: [model], resolveVideoDuration: () => ({ supported: true, maxDuration: 10, target: 5, ...options.timing }),
    isCanvasStoryboardVideoModelCompatible: () => true, getVideoAudioReferenceLimits: () => ({ min: 0, max: 2 }),
    resolveVideoCharge: () => { counts.cost++; return { publicPrice: 1 }; },
    coerceCanvasVideoResolution: (_model, resolution) => resolution,
    resolveAutodlH3ClientAttempt: input => { counts.attempt++; return { clientRequestId: "synthetic-request", fingerprint: input.fingerprint }; },
    replaceRuntimeNode: (nodes, id, patch) => nodes.map(item => item.id === id ? { ...item, data: { ...item.data, ...patch } } : item),
    waitForVideoSubmissionSlot: async () => { counts.slots++; }, VIDEO_SUBMIT_MAX_ATTEMPTS: 1,
    generatedImageReferenceUri: refs.generatedImageReferenceUri, parseGeneratedImageReferenceUri: refs.parseGeneratedImageReferenceUri,
    videoWorkflowImageRequestFields: draft.videoWorkflowImageRequestFields,
    fetch: async (url, options) => { requests.push({ url, method: options.method, body: JSON.parse(options.body) }); return {}; },
    Date, Set, Map, Object, JSON, crypto: { randomUUID: () => "fixture" } });
  try { return { ...(await module.exports()), requests, counts }; } catch (error) { return { error, requests, counts }; }
}
function checked(condition, message) { assert.ok(condition, message); checks++; }
function request(result) { checked(!result.error && result.requests.length === 1, result.error?.message || "ONE_ACTUAL_SUBMIT_REQUIRED"); return result.requests[0].body; }
function assertExclusive(body) {
  for (const [typed, legacy] of [["image_ref", "image_url"], ["last_frame_ref", "last_frame_url"], ["reference_image_ref", "reference_image_url"], ["reference_image_inputs", "reference_image_urls"]]) checked(!(typed in body && legacy in body), "ROLE_FIELDS_MUST_BE_EXCLUSIVE");
  refs.parseGeneratedVideoImageInputs(body); checks++;
}
const urls = ["/api/media-history/content?recordId=" + a.recordId, "/api/media-history/content?recordId=" + b.recordId, "/api/media-history/content?recordId=" + c.recordId];
// Runtime order intentionally differs from edge/input order: mapping must match each URL.
let result = await execute([image("c", urls[2], c), image("a", urls[0], a), image("b", urls[1], b)], urls);
let body = request(result); assertExclusive(body);
checked(body.image_ref.recordId === a.recordId && body.reference_image_ref.recordId === b.recordId && body.last_frame_ref.recordId === c.recordId, "TYPED_ROLE_ORDER");
checked(body.reference_image_inputs[0].recordId === b.recordId && body.reference_image_inputs[1].recordId === c.recordId, "TYPED_LIST_ORDER");
checked(JSON.stringify(JSON.parse(result.fingerprint).imageRefs) === JSON.stringify([uri(a), uri(b), uri(c)]), "STABLE_TYPED_FINGERPRINT");
checked(!result.fingerprint.includes("/api/media-history/content"), "PRIVATE_PREVIEW_NOT_FINGERPRINTED");
const refreshed = await execute([image("a", "blob:preview-a", a), image("b", "blob:preview-b", b), image("c", "blob:preview-c", c)], ["blob:preview-a", "blob:preview-b", "blob:preview-c"]);
request(refreshed); checked(refreshed.fingerprint === result.fingerprint, "TYPED_PREVIEW_REPLACEMENT_STABLE");
result = await execute([image("first", raw), image("middle", raw + "?middle"), image("last", raw + "?last")], [raw, raw + "?middle", raw + "?last"]);
body = request(result); assertExclusive(body);
checked(body.image_url === raw && body.reference_image_url === raw + "?middle" && body.last_frame_url === raw + "?last", "LEGACY_ROLE_UNCHANGED");
checked(JSON.stringify(body.reference_image_urls) === JSON.stringify([raw + "?middle", raw + "?last"]), "LEGACY_LIST_UNCHANGED");
result = await execute([image("a", urls[0], a), image("raw", raw), image("c", urls[2], c)], [urls[0], raw, urls[2]]);
body = request(result); assertExclusive(body);
checked(body.image_ref.recordId === a.recordId && body.last_frame_ref.recordId === c.recordId && body.reference_image_url === raw, "MIXED_ROLE_MAPPING");
checked(body.reference_image_inputs[0] === raw && body.reference_image_inputs[1].recordId === c.recordId, "MIXED_LIST_ORDER");
result = await execute([image("first", urls[0], a), image("last", urls[1], b)], [urls[0], urls[1]], { model: { maxReferenceImages: 1 } });
body = request(result); assertExclusive(body);
checked(body.last_frame_ref.recordId === b.recordId && !body.reference_image_ref && body.reference_image_urls.length === 0, "TWO_TYPED_KEYFRAMES_NO_BLANKET_REJECTION");
result = await execute([image("a", urls[0], a)], [urls[0]], { node: { videoMode: "reference" } });
body = request(result); assertExclusive(body); checked(body.image_ref.recordId === a.recordId && !("last_frame_url" in body) && !("last_frame_ref" in body), "SINGLE_TYPED_REFERENCE");
result = await execute([image("a", "", a, { imagePreviewUrl: "blob:current-preview" })], ["blob:current-preview"], { node: { videoMode: "reference" } });
body = request(result); checked(body.image_ref.recordId === a.recordId, "RUNTIME_PREVIEW_MATCHES_OWNED_REF");
result = await execute([image("unmatched", urls[0], a)], [raw], { node: { videoMode: "reference" } });
body = request(result); checked(body.image_url === raw && !("image_ref" in body), "UNMATCHED_URL_DOES_NOT_BORROW_OTHER_NODE_REF");
for (const options of [
  { images: [image("inline", "blob:inline", undefined, { imageDeliveryReceipt: { deliveryMode: "inline_ephemeral" } })], urls: ["blob:inline"], match: /临时图片/u, preCost: true },
  { images: [image("a", urls[0], a, { assetRole: "storyboard-keyframe", referenceValidationStatus: "pending" })], urls: [urls[0]], match: /参考图尚未确认/u },
  { images: [image("a", urls[0], a)], urls: [urls[0]], model: { supportsImageInput: false }, match: /不支持关键帧/u },
  { images: [image("a", urls[0], a)], urls: [urls[0]], match: /首尾帧模式/u },
  { images: [], urls: [], match: /需要前置关键帧/u },
  { images: [image("a", urls[0], a)], urls: [urls[0]], timing: { supported: false }, match: /最长支持/u },
  { images: [image("a", urls[0], a)], urls: [urls[0]], node: { aspectRatio: "1:1" }, match: /只支持/u },
  { images: [image("a", urls[0], a), image("b", urls[1], b)], urls: urls.slice(0, 2), audioUrls: [raw], model: { supportsAudioInput: false }, match: /不支持音频/u },
]) {
  const outcome = await execute(options.images, options.urls, options);
  checked(Boolean(outcome.error && options.match.test(outcome.error.message)), "ACTUAL_GUARD_REJECTS");
  checked(outcome.requests.length === 0 && outcome.counts.slots === 0 && outcome.counts.cost === 0 && outcome.counts.attempt === 0, "GUARD_BEFORE_SUBMIT_COST_OR_IDEMPOTENCY");
}
console.log(JSON.stringify({ passed: true, checks, actualManualCanvasSubmitBranch: true, actualFrozenImageMappingHelper: true, realNetworkCalls: 0, paidCalls: 0, databaseCalls: 0 }));
