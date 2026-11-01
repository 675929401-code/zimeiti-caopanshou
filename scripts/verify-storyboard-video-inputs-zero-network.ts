import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { StoryboardVideoInputsSchema, normalizeStoryboardVideoInputs, resolveStoryboardVideoInputs, isStoryboardImageWorkflow, getStoryboardVideoInputRoles } from "../src/lib/storyboard-video-inputs";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { sanitizeStoryboardPersistenceValue, createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";
import { storyboardRecoveryContentFingerprint, writeStoryboardRecovery, readStoryboardRecovery, inspectStoryboardRecoveryEdits } from "../src/lib/storyboard-workspace-recovery";
import { storyboardProductionPlanFingerprint, storyboardProductionVideoFingerprint, storyboardProductionFingerprint, storyboardProductionImageFingerprint, type ProductionRun } from "../src/lib/storyboard-continuous-production";
import { generatedImageReferenceUri, type GeneratedImageReference } from "../src/lib/generated-image-reference";
import type { AiVideoPageCapabilitySource, AiVideoWorkflowInputMode } from "../src/lib/ai-video-page-capabilities";
import { getAiVideoPageInputCapabilities } from "../src/lib/ai-video-page-capabilities";

// Any accidental network access is a hard test failure; helpers are pure.
globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
const checks: string[] = [];
const check = (name: string, test: () => void) => { test(); checks.push(name); };
const image = "https://assets.example.invalid/storyboard.png", first = "https://assets.example.invalid/first.png", last = "https://assets.example.invalid/last.png";
const audio = "https://assets.example.invalid/voice.wav", source = "https://assets.example.invalid/source.mp4";
const ref: GeneratedImageReference = { schema: "generated_image_ref.v1", recordId: "a".repeat(64), transform: { kind: "crop", x: 4, y: 8, width: 320, height: 180 } };
function model(mode: AiVideoWorkflowInputMode, extra: AiVideoPageCapabilitySource = {}): AiVideoPageCapabilitySource {
  return { workflowInputMode: mode, supportsImageInput: mode !== "text", minReferenceImages: mode === "text" ? 0 : 1,
    maxReferenceImages: mode === "text" ? 0 : 3, ...extra };
}
const base = { videoPrompt: "人物抬头看向窗外", imageUrl: image };
check("six workflow modes use the shared capability and validation contracts", () => {
  for (const mode of ["text", "multi_image", "first_last_frame", "image_audio_lipsync", "multi_image_audio", "flexible_image"] as const) {
    const frames = mode === "first_last_frame", withAudio = mode === "image_audio_lipsync" || mode === "multi_image_audio";
    const result = resolveStoryboardVideoInputs(model(mode, { requiresFirstFrame: frames, requiresLastFrame: frames, minReferenceAudios: withAudio ? 1 : 0, maxReferenceAudios: withAudio ? 2 : 0 }),
      { ...base, videoInputs: { ...(frames ? { lastFrameUrl: last } : {}), ...(withAudio ? { audioUrl: audio } : {}) } });
    assert.equal(result.issue, "", `${mode}: ${result.issue}`);
    assert.equal(result.capabilities.mode, mode);
  }
});
check("source video requirement is enforced and stale unsupported source stays configured only", () => {
  const required = model("text", { requiresSourceVideo: true });
  assert.match(resolveStoryboardVideoInputs(required, base).issue, /源视频/u);
  const accepted = resolveStoryboardVideoInputs(required, { ...base, videoInputs: { sourceVideoUrl: source } });
  assert.equal(accepted.issue, ""); assert.equal(accepted.requestFields.source_video_url, source);
  const unsupported = resolveStoryboardVideoInputs(model("text"), { ...base, videoInputs: { sourceVideoUrl: source } });
  assert.equal(unsupported.issue, ""); assert.equal(unsupported.input.sourceVideoUrl, undefined);
  assert.equal(unsupported.identity.configured?.sourceVideoUrl, source);
});
check("required frames, image counts, audio counts and prompt block before dispatch", () => {
  assert.ok(resolveStoryboardVideoInputs(model("first_last_frame", { requiresFirstFrame: true, requiresLastFrame: true }), base).issue);
  assert.ok(resolveStoryboardVideoInputs(model("multi_image", { minReferenceImages: 2 }), base).issue);
  assert.ok(resolveStoryboardVideoInputs(model("multi_image", { maxReferenceImages: 1 }), { ...base, videoInputs: { referenceImageUrls: [first] } }).issue);
  assert.ok(resolveStoryboardVideoInputs(model("multi_image_audio", { minReferenceAudios: 1, maxReferenceAudios: 1 }), base).issue);
  assert.ok(resolveStoryboardVideoInputs(model("multi_image_audio", { maxReferenceAudios: 1 }), { ...base, videoInputs: { audioUrl: audio, referenceAudioUrls: [audio] } }).issue);
  assert.ok(resolveStoryboardVideoInputs(model("text"), { videoPrompt: "" }).issue);
});
check("optional audio stays optional and image workflow suitability does not invent charges", () => {
  const optional = model("flexible_image", { maxReferenceImages: 1, minReferenceAudios: 0, maxReferenceAudios: 1 });
  assert.equal(resolveStoryboardVideoInputs(optional, base).issue, ""); assert.equal(isStoryboardImageWorkflow(optional), true);
  assert.equal(isStoryboardImageWorkflow(model("text")), false);
  assert.equal(isStoryboardImageWorkflow(model("first_last_frame", { requiresLastFrame: true })), false);
  assert.equal(isStoryboardImageWorkflow(model("flexible_image", { minReferenceAudios: 1, maxReferenceAudios: 1 })), false);
});
check("text and zero-image capabilities omit images while preserving original card", () => {
  const card = { ...base, imageRef: ref, videoInputs: { firstFrameUrl: first, referenceImageUrls: [last] } };
  for (const m of [model("text"), model("flexible_image", { minReferenceImages: 0, maxReferenceImages: 0, supportsImageInput: false })]) {
    const result = resolveStoryboardVideoInputs(m, card);
    assert.equal(result.input.imageUrl, undefined); assert.equal(result.input.referenceImageUrls, undefined);
    assert.deepEqual(result.requestFields, {}); assert.equal(result.usesStoryboardImage, false); assert.equal(result.issue, "");
  }
  assert.equal(card.imageUrl, image); assert.equal(card.imageRef, ref);
});
check("typed storyboard image keeps record identity and full-asset submission over stale legacy URL", () => {
  const result = resolveStoryboardVideoInputs(model("flexible_image"), { ...base, imageUrl: "blob:expired", imageRef: ref, imageStorageKey: "old/key" });
  const fullRef: GeneratedImageReference = { schema: ref.schema, recordId: ref.recordId };
  assert.equal(result.issue, ""); assert.deepEqual(result.requestFields.image_ref, fullRef);
  assert.equal(result.requestFields.image_url, undefined); assert.equal(result.requestFields.image_storage_key, undefined);
  assert.equal(result.input.imageUrl, generatedImageReferenceUri(fullRef)); assert.equal(result.usesStoryboardImage, true);
  const legacy = resolveStoryboardVideoInputs(model("flexible_image"), { ...base, imageStorageKey: "owned/key" });
  assert.equal(legacy.requestFields.image_storage_key, "owned/key"); assert.equal(legacy.identity.storyboardImageStorageKey, "owned/key");
});
check("explicit frame roles and ordered references never reuse image-generation references", () => {
  const result = resolveStoryboardVideoInputs(model("first_last_frame", { maxReferenceImages: 5, maxReferenceAudios: 3, showReferenceImages: true }), {
    ...base, videoInputs: { firstFrameUrl: first, lastFrameUrl: last, referenceImageUrls: [last, first], audioUrl: audio, referenceAudioUrls: [audio, source] },
  });
  assert.equal(result.issue, ""); assert.equal(result.usesStoryboardImage, false);
  assert.equal(result.requestFields.image_url, first); assert.equal(result.requestFields.last_frame_url, last);
  assert.deepEqual(result.requestFields.reference_image_urls, [last, first]); assert.deepEqual(result.requestFields.reference_audio_urls, [audio, source]);
  const onlyImageReferences = { ...base, referenceImageUrls: [first, last], videoInputs: { useStoryboardImage: false } };
  assert.ok(resolveStoryboardVideoInputs(model("multi_image"), onlyImageReferences).issue);
});
check("illegal URLs, excessive arrays and unknown fields cannot be silently sanitized", () => {
  for (const value of ["data:image/png;base64,abc", "blob:temporary", "javascript:alert(1)", "//foreign.invalid/x", "x".repeat(4097), "generated-image://" + "a".repeat(64)]) {
    assert.equal(StoryboardVideoInputsSchema.safeParse({ firstFrameUrl: value }).success, false);
    assert.throws(() => normalizeStoryboardVideoInputs({ firstFrameUrl: value }));
    assert.ok(resolveStoryboardVideoInputs(model("flexible_image"), { ...base, videoInputs: { firstFrameUrl: value } }).issue);
  }
  assert.throws(() => normalizeStoryboardVideoInputs({ referenceImageUrls: Array(17).fill(image) }));
  assert.throws(() => normalizeStoryboardVideoInputs({ referenceAudioUrls: Array(9).fill(audio) }));
  assert.throws(() => normalizeStoryboardVideoInputs({ unexpected: true }));
});
check("uploaded asset ownership refs include only submitted matching-category URLs", () => {
  const uploadedAssets = [{ url: first, assetRef: "owned-first", category: "image" as const }, { url: audio, assetRef: "owned-audio", category: "audio" as const },
    { url: last, assetRef: "unused-image", category: "image" as const }, { url: first, assetRef: "wrong-category", category: "audio" as const }];
  const result = resolveStoryboardVideoInputs(model("flexible_image", { maxReferenceAudios: 1 }), { ...base, videoInputs: { firstFrameUrl: first, audioUrl: audio, uploadedAssets } });
  assert.equal(result.issue, "");
  assert.deepEqual(result.requestFields.reference_asset_refs, [{ url: first, asset_ref: "owned-first", category: "image" }, { url: audio, asset_ref: "owned-audio", category: "audio" }]);
  assert.deepEqual(result.identity.uploadedAssets, result.requestFields.reference_asset_refs);
  const text = resolveStoryboardVideoInputs(model("text"), { ...base, videoInputs: { firstFrameUrl: first, uploadedAssets } });
  assert.equal(text.requestFields.reference_asset_refs, undefined);
  assert.throws(() => normalizeStoryboardVideoInputs({ uploadedAssets: Array(25).fill(uploadedAssets[0]) }));
  assert.throws(() => normalizeStoryboardVideoInputs({ uploadedAssets: [{ ...uploadedAssets[0], assetRef: "x".repeat(1201) }] }));
});
check("switching capabilities preserves configured hidden materials without submitting hidden roles", () => {
  const videoInputs = { useStoryboardImage: false, firstFrameUrl: first, lastFrameUrl: last, referenceImageUrls: [last, first], audioUrl: audio,
    referenceAudioUrls: [audio, source], sourceVideoUrl: source, uploadedAssets: [{ url: last, assetRef: "old-last", category: "image" as const }, { url: audio, assetRef: "old-audio", category: "audio" as const }] };
  const text = resolveStoryboardVideoInputs(model("text"), { ...base, videoInputs });
  assert.equal(text.issue, ""); assert.deepEqual(text.requestFields, {}); assert.deepEqual(text.identity.configured, videoInputs);
  assert.deepEqual(text.identity.effective, [{ role: "prompt", values: [base.videoPrompt] }]);
  const flexible = resolveStoryboardVideoInputs(model("flexible_image", { maxReferenceImages: 1, showReferenceImages: false, maxReferenceAudios: 1, showAudioInputs: true }), { ...base, videoInputs });
  assert.equal(flexible.issue, ""); assert.equal(flexible.input.imageUrl, first);
  assert.equal(flexible.input.lastFrameUrl, undefined); assert.equal(flexible.input.referenceImageUrls, undefined);
  assert.equal(flexible.input.referenceAudioUrls, undefined); assert.equal(flexible.input.sourceVideoUrl, undefined);
  assert.deepEqual(flexible.requestFields.reference_asset_refs, [{ url: audio, asset_ref: "old-audio", category: "audio" }]);
  const activeOverage = resolveStoryboardVideoInputs(model("multi_image_audio", { maxReferenceImages: 1, maxReferenceAudios: 1 }), { ...base, videoInputs });
  assert.ok(activeOverage.issue); assert.deepEqual(activeOverage.input.referenceImageUrls, [last, first]); assert.deepEqual(activeOverage.input.referenceAudioUrls, [audio, source]);
});
check("ordinary submitted media reject private and relative URLs before charges; typed refs alone are exempt", () => {
  const m = model("flexible_image", { maxReferenceImages: 6, showLastFrame: true, maxReferenceAudios: 3, supportsSourceVideoInput: true });
  const credentialUrl = new URL("https://example.invalid/a");
  credentialUrl.username = "fixture-user";
  credentialUrl.password = "fixture-password";
  for (const invalid of ["/fixtures/legacy.png", "http://127.0.0.1/a", "http://10.1.2.3/a", "http://192.168.0.2/a", "http://172.16.1.2/a", "http://169.254.1.2/a",
    "http://[::1]/a", "http://[fc00::1]/a", "http://[fe80::1]/a", "http://[::ffff:127.0.0.1]/a", credentialUrl.href, "blob:old", "data:audio/wav;base64,abc"]) {
    for (const field of ["firstFrameUrl", "lastFrameUrl", "audioUrl", "sourceVideoUrl"] as const) {
      assert.ok(resolveStoryboardVideoInputs(m, { ...base, videoInputs: { [field]: invalid } }).issue, `${field}: ${invalid}`);
    }
    for (const field of ["referenceImageUrls", "referenceAudioUrls"] as const) assert.ok(resolveStoryboardVideoInputs(m, { ...base, videoInputs: { [field]: [invalid] } }).issue);
    assert.ok(resolveStoryboardVideoInputs(m, { ...base, imageUrl: invalid }).issue);
  }
  assert.equal(StoryboardVideoInputsSchema.safeParse({ firstFrameUrl: "/legacy/stored.png" }).success, true, "legacy storage may keep relative values");
  const typed = resolveStoryboardVideoInputs(m, { ...base, imageUrl: "/legacy/image", imageRef: ref });
  assert.equal(typed.issue, ""); assert.deepEqual(typed.requestFields.image_ref, { schema: ref.schema, recordId: ref.recordId });
});
check("default selected storyboard image remains required even for optional-image models", () => {
  const m = model("flexible_image", { minReferenceImages: 0, maxReferenceImages: 3 });
  for (const videoInputs of [undefined, {}, { useStoryboardImage: true }, { referenceImageUrls: [first] }]) {
    const result = resolveStoryboardVideoInputs(m, { videoPrompt: base.videoPrompt, videoInputs });
    assert.equal(result.requiresStoryboardImage, true); assert.equal(result.usesStoryboardImage, false); assert.match(result.issue, /本段分镜图/u);
  }
  const off = resolveStoryboardVideoInputs(m, { videoPrompt: base.videoPrompt, videoInputs: { useStoryboardImage: false } });
  assert.equal(off.requiresStoryboardImage, false); assert.equal(off.issue, "");
  const custom = resolveStoryboardVideoInputs(m, { videoPrompt: base.videoPrompt, videoInputs: { firstFrameUrl: first } });
  assert.equal(custom.requiresStoryboardImage, false); assert.equal(custom.issue, ""); assert.equal(custom.input.imageUrl, first);
});
check("custom primary images are submitted in every image-capable form mode", () => {
  for (const mode of ["multi_image", "image_audio_lipsync", "multi_image_audio"] as const) {
    const m = model(mode, { minReferenceImages: 1, maxReferenceImages: 3, minReferenceAudios: mode === "image_audio_lipsync" ? 1 : 0, maxReferenceAudios: 1 });
    const result = resolveStoryboardVideoInputs(m, { videoPrompt: base.videoPrompt, videoInputs: { useStoryboardImage: false, firstFrameUrl: first, audioUrl: audio } });
    assert.equal(result.issue, "", mode); assert.equal(result.input.imageUrl, first); assert.equal(result.requestFields.image_url, first);
    assert.equal(result.usesStoryboardImage, false); assert.equal(result.requiresStoryboardImage, false);
  }
});
check("shared roles ignore hidden tail occupancy and agree on custom primary selection", () => {
  const caps = getAiVideoPageInputCapabilities(model("multi_image", { maxReferenceImages: 3 }));
  const value = { firstFrameUrl: first, lastFrameUrl: last, referenceImageUrls: [image] };
  const roles = getStoryboardVideoInputRoles(caps, value);
  assert.equal(roles.firstFrameUrl, first); assert.equal(roles.useStoryboardImage, false); assert.equal(roles.lastFrameUrl, undefined); assert.equal(roles.remainingImageSlots, 2);
  const resolved = resolveStoryboardVideoInputs(model("multi_image", { maxReferenceImages: 3 }), { videoPrompt: base.videoPrompt, videoInputs: value });
  assert.equal(resolved.issue, ""); assert.equal(resolved.input.imageUrl, first); assert.equal(resolved.input.lastFrameUrl, undefined);
  const defaultRoles = getStoryboardVideoInputRoles(caps, { lastFrameUrl: last });
  assert.equal(defaultRoles.useStoryboardImage, true); assert.equal(defaultRoles.remainingImageSlots, 2);
  const textRoles = getStoryboardVideoInputRoles(getAiVideoPageInputCapabilities(model("text")), value);
  assert.equal(textRoles.useStoryboardImage, false); assert.equal(textRoles.firstFrameUrl, undefined); assert.equal(textRoles.remainingImageSlots, 0);
});
check("unsupported retained reference-audio lists have zero form capacity and remain unsubmitted", () => {
  for (const mode of ["image_audio_lipsync", "flexible_image"] as const) {
    const m = model(mode, { minReferenceAudios: 1, maxReferenceAudios: 1 });
    const value = { firstFrameUrl: first, referenceAudioUrls: [audio] };
    const roles = getStoryboardVideoInputRoles(getAiVideoPageInputCapabilities(m), value);
    assert.equal(roles.acceptsReferenceAudio, false); assert.equal(roles.remainingAudioSlots, 0); assert.equal(roles.referenceAudioUrls, undefined);
    const resolved = resolveStoryboardVideoInputs(m, { videoPrompt: base.videoPrompt, videoInputs: value });
    assert.match(resolved.issue, /音频/u); assert.equal(resolved.input.referenceAudioUrls, undefined);
    assert.deepEqual(resolved.identity.configured?.referenceAudioUrls, [audio]);
  }
});
const inputs = { useStoryboardImage: false, firstFrameUrl: first, lastFrameUrl: last, referenceImageUrls: [last, first], audioUrl: audio, referenceAudioUrls: [source, audio], sourceVideoUrl: source,
  uploadedAssets: [{ url: first, assetRef: "owned-first", category: "image" as const }, { url: audio, assetRef: "owned-audio", category: "audio" as const }] };
function runFixture() {
  return { id: "video-input-fixture-project", title: "视频素材合成回归", createdAt: 1, updatedAt: 2, ratio: "16:9", imageRatio: "16:9", imageResolution: "2K", videoResolution: "720p", videoDuration: 8,
    imageModelId: "fixture-image", videoModelId: "fixture-video", cards: [{ id: "fixture-card", order: 1, imagePrompt: "庭院人物分镜", videoPrompt: base.videoPrompt,
      referenceImageUrls: [], imageStatus: "idle", videoStatus: "idle", imageRef: ref, videoInputs: structuredClone(inputs) }] };
}
check("project schema, sanitize, snapshot, storage recovery and edit merge preserve roles/order", () => {
  const run = runFixture();
  assert.deepEqual(StoryboardProjectDocument.parse(run).cards[0].videoInputs, inputs);
  for (const snapshot of [sanitizeStoryboardPersistenceValue(run), createStoryboardPersistenceSnapshot(run)] as ReturnType<typeof runFixture>[]) {
    assert.deepEqual(snapshot.cards[0].videoInputs, inputs); assert.deepEqual(snapshot.cards[0].imageRef, ref);
  }
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeStoryboardRecovery(storage, "fixture", run); assert.deepEqual(readStoryboardRecovery(storage, "fixture")?.run.cards[0].videoInputs, inputs);
  const changed = structuredClone(run); changed.cards[0].videoInputs.referenceImageUrls.reverse();
  const recovered = inspectStoryboardRecoveryEdits(run, { run: changed, baseContentFingerprint: storyboardRecoveryContentFingerprint(run) });
  assert.equal(recovered.status, "applied"); assert.deepEqual(recovered.run.cards[0].videoInputs.referenceImageUrls, [first, last]);
  assert.notEqual(storyboardRecoveryContentFingerprint(changed), storyboardRecoveryContentFingerprint(run));
  const illegal = structuredClone(run); illegal.cards[0].videoInputs.audioUrl = "blob:expired";
  assert.equal(StoryboardProjectDocument.safeParse(illegal).success, false); assert.throws(() => sanitizeStoryboardPersistenceValue(illegal));
});
check("each video material role and array order invalidate continuous plan and video authorization", () => {
  const run = runFixture() as ProductionRun, card = run.cards[0];
  const plan = storyboardProductionPlanFingerprint(run), video = storyboardProductionVideoFingerprint(run, card);
  for (const field of Object.keys(inputs) as Array<keyof typeof inputs>) {
    const changed = structuredClone(run), config = changed.cards[0].videoInputs!;
    if (field === "useStoryboardImage") config.useStoryboardImage = true;
    else if (field === "referenceImageUrls" || field === "referenceAudioUrls") config[field] = [...config[field]!].reverse();
    else if (field === "uploadedAssets") config.uploadedAssets = [...config.uploadedAssets!].reverse();
    else config[field] = "https://assets.example.invalid/changed";
    assert.notEqual(storyboardProductionPlanFingerprint(changed), plan, field);
    assert.notEqual(storyboardProductionVideoFingerprint(changed, changed.cards[0]), video, field);
  }
  const cropped = structuredClone(run); cropped.cards[0].imageRef!.transform!.x += 1;
  assert.equal(storyboardProductionVideoFingerprint(cropped, cropped.cards[0]), video, "legacy preview crop is not submitted identity");
});
check("legacy missing videoInputs retain the exact original video and plan hash arrays", () => {
  const run = runFixture() as ProductionRun; delete run.cards[0].videoInputs; const card = run.cards[0];
  assert.equal(normalizeStoryboardVideoInputs(undefined), undefined);
  assert.equal(storyboardProductionVideoFingerprint(run, card), storyboardProductionFingerprint([storyboardProductionImageFingerprint(run, card),
    card.imageRecordId, card.imageAssetId, card.imageStorageKey, card.imageRecordId ? undefined : card.imageUrl, card.videoPrompt, card.directorExecution,
    run.videoModelId, run.videoResolution, run.videoDuration, run.ratio, run.videoContract]));
  assert.equal(storyboardProductionPlanFingerprint(run), storyboardProductionFingerprint([
    run.id, run.ratio, run.imageRatio, run.imageResolution, run.videoResolution, run.videoDuration, run.imageModelId, run.videoModelId, run.videoContract,
    undefined, undefined, undefined, undefined, undefined, undefined,
    [[card.id, card.imagePrompt, card.videoPrompt, card.narration, card.imageTextLayoutEnabled, card.imageExactText, card.visualAssetSelectionMode, undefined, []]],
  ]));
  const stored = createStoryboardPersistenceSnapshot(run); assert.equal("videoInputs" in stored.cards[0], false);
});
const directory = ".codex-evidence/storyboard-model-usability-20261031-784525be";
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/video-inputs-zero-network.json`, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), networkCalls: 0, checks }, null, 2) + "\n");
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: 0 }));
