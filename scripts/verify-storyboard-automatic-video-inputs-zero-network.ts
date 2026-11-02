import assert from "node:assert/strict";
import { resolveStoryboardAutomaticVideoInputs, storyboardAutomaticVideoProductionFingerprint, storyboardAutomaticVideoProductionBlocker } from "../src/lib/storyboard-automatic-video-inputs";
import { resolveStoryboardVideoInputs, StoryboardVideoInputsSchema } from "../src/lib/storyboard-video-inputs";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";
import type { AiVideoPageCapabilitySource } from "../src/lib/ai-video-page-capabilities";
import type { GeneratedImageReference } from "../src/lib/generated-image-reference";
import { storyboardProductionImageFingerprint, storyboardProductionVideoFingerprint, storyboardProductionVideoInputMatch, storyboardProductionPlanFingerprint, type ProductionRun } from "../src/lib/storyboard-continuous-production";

globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
const current = "https://assets.example.invalid/current.png";
const hidden = "https://assets.example.invalid/hidden";
const imageModel: AiVideoPageCapabilitySource = { workflowInputMode: "flexible_image", supportsImageInput: true, minReferenceImages: 1, maxReferenceImages: 1 };
const textModel: AiVideoPageCapabilitySource = { workflowInputMode: "text", supportsImageInput: false };
const stored = { useStoryboardImage: false, firstFrameUrl: hidden + "/first.png", lastFrameUrl: hidden + "/last.png", referenceImageUrls: [hidden + "/reference.png"],
  audioUrl: hidden + "/speech.wav", referenceAudioUrls: [hidden + "/ref.wav"], sourceVideoUrl: hidden + "/source.mp4",
  uploadedAssets: [{ url: hidden + "/first.png", assetRef: "old-owned-reference", category: "image" as const }] };
const card = { videoPrompt: "当前分镜人物抬头", imageUrl: current, imageStorageKey: "storyboards/current.png", videoInputs: stored };
const checks: string[] = [];
const check = (name: string, test: () => void) => { test(); checks.push(name); };
check("automatic projection never submits retained custom images, audio, source video or ownership refs", () => {
  const result = resolveStoryboardAutomaticVideoInputs(imageModel, card);
  assert.equal(result.issue, "");
  assert.equal(result.input.imageUrl, current);
  assert.deepEqual(result.requestFields, { image_url: current, image_storage_key: card.imageStorageKey });
  assert.equal(result.usesStoryboardImage, true);
  assert.equal(result.requiresStoryboardImage, true);
  assert.equal(result.identity.configured, undefined);
  assert.equal(result.identity.uploadedAssets, undefined);
  assert.doesNotMatch(JSON.stringify(result), /hidden|old-owned-reference/u);
  assert.equal(resolveStoryboardVideoInputs(imageModel, card).input.imageUrl, stored.firstFrameUrl, "generic custom-input consumers retain their contract");
});
check("undefined, empty, explicitly disabled and malformed retained inputs cannot alter current-image requests", () => {
  const baseline = resolveStoryboardAutomaticVideoInputs(imageModel, { videoPrompt: card.videoPrompt, imageUrl: current, imageStorageKey: card.imageStorageKey });
  for (const videoInputs of [undefined, {}, stored, { useStoryboardImage: true }, { firstFrameUrl: "blob:expired", unexpected: true }]) {
    assert.deepEqual(resolveStoryboardAutomaticVideoInputs(imageModel, { ...card, videoInputs } as typeof card), baseline);
  }
  const missing = resolveStoryboardAutomaticVideoInputs({ ...imageModel, minReferenceImages: 0 }, { videoPrompt: card.videoPrompt, videoInputs: stored });
  assert.equal(missing.requiresStoryboardImage, true);
  assert.match(missing.issue, /本段分镜图/u);
  assert.doesNotMatch(missing.issue, /关闭/u);
});
check("typed current-image refs win over URLs and storage keys, preserve the full asset and fail closed", () => {
  const imageRef: GeneratedImageReference = { schema: "generated_image_ref.v1", recordId: "a".repeat(64), transform: { kind: "crop", x: 0, y: 0, width: 20, height: 20 } };
  const result = resolveStoryboardAutomaticVideoInputs(imageModel, { ...card, imageRef });
  assert.equal(result.issue, "");
  assert.deepEqual(result.requestFields, { image_ref: { schema: imageRef.schema, recordId: imageRef.recordId } });
  assert.equal(result.identity.storyboardImageStorageKey, undefined);
  const invalid = resolveStoryboardAutomaticVideoInputs(imageModel, { ...card, imageRef: { ...imageRef, recordId: "invalid" } });
  assert.match(invalid.issue, /引用无效/u);
  assert.deepEqual(invalid.requestFields, {}, "invalid ref must not fall back to current URL or hidden first frame");
  assert.equal(invalid.usesStoryboardImage, false);
});
check("public current URLs and storage keys keep their validation; key-only inputs are never guessed", () => {
  for (const imageUrl of ["blob:old", "/private/image", "http://127.0.0.1/image", "http://10.0.0.1/image"]) assert.ok(resolveStoryboardAutomaticVideoInputs(imageModel, { ...card, imageUrl }).issue);
  assert.match(resolveStoryboardAutomaticVideoInputs(imageModel, { ...card, imageStorageKey: "" }).issue, /存储标识/u);
  assert.match(resolveStoryboardAutomaticVideoInputs(imageModel, { videoPrompt: card.videoPrompt, imageStorageKey: card.imageStorageKey }).issue, /本段分镜图/u);
});
check("pure text models submit only the current prompt even when current images and old materials exist", () => {
  const result = resolveStoryboardAutomaticVideoInputs(textModel, card);
  assert.equal(result.issue, "");
  assert.deepEqual(result.input, { prompt: card.videoPrompt });
  assert.deepEqual(result.requestFields, {});
  assert.deepEqual(result.identity, { effective: [{ role: "prompt", values: [card.videoPrompt] }] });
  assert.equal(result.requiresStoryboardImage, false);
  assert.equal(result.usesStoryboardImage, false);
});
check("required tail, multiple images, audio and source video remain blocked regardless of old materials", () => {
  for (const [model, reason] of [
    [{ ...imageModel, workflowInputMode: "first_last_frame", requiresLastFrame: true, maxReferenceImages: 2 }, /尾帧/u],
    [{ ...imageModel, workflowInputMode: "multi_image", minReferenceImages: 2, maxReferenceImages: 3 }, /至少需要2张/u],
    [{ ...imageModel, workflowInputMode: "image_audio_lipsync", minReferenceAudios: 1, maxReferenceAudios: 1 }, /音频/u],
    [{ ...imageModel, workflowInputMode: "multi_image_audio", minReferenceAudios: 1, maxReferenceAudios: 3 }, /音频/u],
    [{ ...textModel, requiresSourceVideo: true }, /源视频/u],
  ] as Array<[AiVideoPageCapabilitySource, RegExp]>) {
    const result = resolveStoryboardAutomaticVideoInputs(model, card);
    assert.match(result.issue, reason);
    assert.equal(result.isStoryboardImageWorkflow, false);
    assert.doesNotMatch(JSON.stringify(result.requestFields), /hidden/u);
    assert.equal(result.requestFields.last_frame_url, undefined);
    assert.equal(result.requestFields.reference_image_urls, undefined, "never duplicate a current image to fill required slots");
    assert.equal(result.requestFields.audio_url, undefined);
    assert.equal(result.requestFields.source_video_url, undefined);
  }
});
check("single current image remains usable in optional multi-image/audio-capable modes", () => {
  for (const workflowInputMode of ["flexible_image", "multi_image", "multi_image_audio", "image_audio_lipsync", "first_last_frame"]) {
    const result = resolveStoryboardAutomaticVideoInputs({ ...imageModel, workflowInputMode, maxReferenceImages: 3, maxReferenceAudios: 3, minReferenceAudios: 0 }, card);
    assert.equal(result.issue, "", workflowInputMode);
    assert.deepEqual(result.requestFields, { image_url: current, image_storage_key: card.imageStorageKey });
  }
});
check("automatic resolution never edits old configuration, persistence schemas or saved projects", () => {
  const project = { id: "automatic-video-fixture", title: "自动输入回归", createdAt: 1, updatedAt: 2, ratio: "16:9", imageResolution: "2K", videoResolution: "720p", videoDuration: 8,
    imageModelId: "image", videoModelId: "video", cards: [{ ...card, id: "card", order: 1, imagePrompt: "庭院", referenceImageUrls: [], imageStatus: "done", videoStatus: "idle" }] };
  const before = JSON.stringify(project);
  const freeze = (value: unknown) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(project);
  resolveStoryboardAutomaticVideoInputs(imageModel, project.cards[0]);
  assert.equal(JSON.stringify(project), before);
  assert.deepEqual(StoryboardVideoInputsSchema.parse(stored), stored);
  assert.deepEqual(StoryboardProjectDocument.parse(project).cards[0].videoInputs, stored);
  assert.deepEqual((createStoryboardPersistenceSnapshot(project) as typeof project).cards[0].videoInputs, stored);
});
function productionFixture(): ProductionRun {
  const run: ProductionRun = { id: "production-fixture", ratio: "16:9", imageRatio: "16:9", imageResolution: "2K", videoResolution: "720p", videoDuration: 8,
    imageModelId: "image", videoModelId: "video", cards: [{ ...card, id: "card", imagePrompt: "庭院", referenceImageUrls: [], imageStatus: "done", videoStatus: "done", videoUrl: "https://assets.example.invalid/old-video.mp4" }] };
  run.cards[0].continuousImageInputFingerprint = storyboardProductionImageFingerprint(run, run.cards[0]);
  return run;
}
check("old custom completed videos never count as completed current-image automatic requests", () => {
  const run = productionFixture(), card = run.cards[0];
  card.continuousVideoInputFingerprint = storyboardProductionVideoFingerprint(run, card);
  assert.equal(storyboardProductionVideoInputMatch(run, card).matches, true, "prove the legacy custom capture used to match the raw configuration");
  const original = JSON.stringify(run), plan = storyboardProductionPlanFingerprint(run);
  assert.match(storyboardAutomaticVideoProductionBlocker(run), /已有视频/u);
  assert.notEqual(storyboardAutomaticVideoProductionFingerprint(run, card), card.continuousVideoInputFingerprint);
  assert.equal(JSON.stringify(run), original, "blocked old video, receipt and custom configuration remain untouched");
  assert.equal(storyboardProductionPlanFingerprint(run), plan, "conservative raw plan authorization remains unchanged");
});
check("new automatic captures and admission use the same projection, including frozen image snapshots", () => {
  const run = productionFixture(), card = run.cards[0];
  card.continuousVideoInputFingerprint = storyboardAutomaticVideoProductionFingerprint(run, card);
  assert.equal(storyboardAutomaticVideoProductionBlocker(run), "");
  assert.notEqual(storyboardProductionVideoFingerprint(run, card), card.continuousVideoInputFingerprint, "retained hidden inputs are excluded from the new capture");
  const snapshot = { runId: run.id, cardId: card.id, prompt: card.imagePrompt, modelId: "accepted-old-image-model", resolution: "2K", aspectRatio: "16:9", referenceImageUrls: [] };
  card.imageRequestSnapshot = snapshot;
  card.continuousImageInputFingerprint = storyboardProductionImageFingerprint(run, card, snapshot);
  card.continuousVideoInputFingerprint = storyboardAutomaticVideoProductionFingerprint(run, card, snapshot);
  assert.equal(storyboardAutomaticVideoProductionBlocker(run), "", "frozen actual image settings remain valid without rebinding video inputs");
});
check("undefined-input legacy ordinary captures retain their exact existing hash and admission", () => {
  const run = productionFixture(), card = run.cards[0]; delete card.videoInputs;
  const legacy = storyboardProductionVideoFingerprint(run, card), plan = storyboardProductionPlanFingerprint(run);
  assert.equal(storyboardAutomaticVideoProductionFingerprint(run, card), legacy);
  card.continuousVideoInputFingerprint = legacy;
  assert.equal(storyboardAutomaticVideoProductionBlocker(run), "");
  assert.equal(storyboardProductionPlanFingerprint(run), plan);
});
check("defined typed-ref-only inputs bind the full image record independently of URL and preview crop", () => {
  const run = productionFixture(), card = run.cards[0];
  card.imageRef = { schema: "generated_image_ref.v1", recordId: "a".repeat(64), transform: { kind: "crop", x: 0, y: 0, width: 20, height: 20 } };
  delete card.imageRecordId;
  const first = storyboardAutomaticVideoProductionFingerprint(run, card);
  card.continuousVideoInputFingerprint = first;
  assert.equal(storyboardAutomaticVideoProductionBlocker(run), "");
  card.imageRef = { ...card.imageRef, transform: { ...card.imageRef.transform!, x: 1 } };
  assert.equal(storyboardAutomaticVideoProductionFingerprint(run, card), first, "preview crop never alters the complete submitted image");
  card.imageRef = { ...card.imageRef, recordId: "b".repeat(64) };
  assert.notEqual(storyboardAutomaticVideoProductionFingerprint(run, card), first, "new record must change identity even when URL and storage key are unchanged");
  assert.match(storyboardAutomaticVideoProductionBlocker(run), /已有视频/u, "old done video cannot stand in for a changed typed image");
  const alreadyAutomatic = productionFixture(); alreadyAutomatic.cards[0].videoInputs = { useStoryboardImage: true };
  alreadyAutomatic.cards[0].continuousVideoInputFingerprint = storyboardProductionVideoFingerprint(alreadyAutomatic, alreadyAutomatic.cards[0]);
  assert.equal(storyboardAutomaticVideoProductionBlocker(alreadyAutomatic), "", "old explicit current-image-only evidence remains compatible");
});
check("automatic admission still blocks queued, running, failed and unknown original attempts", () => {
  for (const patch of [{ videoStatus: "queued" }, { videoStatus: "running" }, { videoStatus: "failed" }, { videoStatus: "idle", videoClientRequestId: "unresolved-original-request" }, { imageRetryBlocked: true }]) {
    const run = productionFixture(); run.cards[0].continuousVideoInputFingerprint = storyboardAutomaticVideoProductionFingerprint(run, run.cards[0]);
    Object.assign(run.cards[0], patch);
    assert.ok(storyboardAutomaticVideoProductionBlocker(run), JSON.stringify(patch));
  }
});
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: 0, scope: "automatic workbench inputs; generic resolver and storage untouched" }));
