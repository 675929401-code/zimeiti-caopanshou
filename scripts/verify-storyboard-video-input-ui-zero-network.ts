import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { resolveStoryboardVideoInputs, normalizeStoryboardVideoInputs, isStoryboardImageWorkflow, getStoryboardVideoInputRoles } from "../src/lib/storyboard-video-inputs";
import { resolveStoryboardAutomaticVideoInputs } from "../src/lib/storyboard-automatic-video-inputs";
import { resolveStoryboardVideoSameKeyRetryAttempt } from "../src/lib/storyboard-video-retry";
import { getAiVideoPageInputCapabilities, resolveAiVideoInputAspectRatio } from "../src/lib/ai-video-page-capabilities";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveStoryboardExecutionMode } from "../src/lib/storyboard-chain-contract";
import { imageDimensionsMatchAspectRatio } from "../src/lib/image-output-contract";
import { isUnavailableCompletedStoryboardImage } from "../src/lib/storyboard-image-result-state";

globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
const source = readFileSync(new URL("../src/components/storyboard-workbench.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("workbench.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["hasValidatedImage", "isImageValidationPending", "isCompletedInlineImageReceipt", "imageAttemptNeedsResolution", "effectiveImageRatio", "allowsIndependentReferenceRatio", "storyboardImageRatioIssue", "storyboardCardVideoInputIssue", "batchSettings", "batchCardInput", "assertBatchSnapshotCurrent"];
const declarations = names.map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `real component function missing: ${name}`); return node.getText();
}).join("\n");
const harnessModule = { exports: {} as Record<string, (...args: any[]) => any> };
runInNewContext(ts.transpileModule(`${declarations}\nmodule.exports = {${names.join(",")}};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module: harnessModule, resolveAiVideoInputAspectRatio, resolveStoryboardAutomaticVideoInputs, resolveStoryboardVideoInputs, normalizeStoryboardVideoInputs, isStoryboardImageWorkflow, resolveStoryboardExecutionMode, imageDimensionsMatchAspectRatio, isUnavailableCompletedStoryboardImage,
});
const gate = harnessModule.exports.storyboardCardVideoInputIssue;
const run = { id: "fixture-project", executionMode: "ordinary", ratio: "16:9", imageRatio: "16:9", videoModelId: "model", videoDuration: 8, videoResolution: "720p", cards: [] as any[] };
const card = { id: "card", videoPrompt: "人物抬头", imagePrompt: "庭院", imageStatus: "idle", videoStatus: "idle", referenceImageUrls: [] };
const image = "https://assets.example.invalid/board.png", audio = "https://assets.example.invalid/speech.wav", video = "https://assets.example.invalid/source.mp4";
const textModel = { workflowInputMode: "text", supportsImageInput: false };
assert.equal(gate(textModel, card, run), "", "text video must not require a storyboard image");
const sourceModel = { ...textModel, requiresSourceVideo: true };
assert.match(gate(sourceModel, card, run), /源视频/u);
assert.match(gate(sourceModel, { ...card, videoInputs: { sourceVideoUrl: video } }, run), /源视频/u, "hidden old source cannot enable the automatic workbench");
const imageModel = { workflowInputMode: "flexible_image", supportsImageInput: true, requiresImage: true, maxReferenceImages: 1 };
assert.match(gate(imageModel, card, run), /分镜图/u);
assert.match(gate(imageModel, { ...card, videoInputs: { useStoryboardImage: false, firstFrameUrl: image } }, run), /本段分镜图/u, "hidden custom first frame cannot substitute the current image");
const valid = { ...card, imageStatus: "done", imageUrl: image, imageValidatedAt: Date.now(), imageWidth: 1600, imageHeight: 900 };
assert.equal(gate(imageModel, valid, run), "");
const portrait = { ...valid, imageWidth: 900, imageHeight: 1600, imageRequestSnapshot: { aspectRatio: "9:16" } };
assert.match(gate(imageModel, portrait, run), /同(?:比例|画幅)|同/u, "ordinary same-ratio input must remain protected");
assert.equal(gate({ ...imageModel, firstFrameRatioPolicy: "adaptive" }, portrait, run), "", "adaptive output follows the valid portrait first frame rather than the landscape toolbar");
assert.match(gate({ ...imageModel, firstFrameRatioPolicy: "adaptive" }, { ...portrait, imageWidth: 1600 }, run), /实际图片/u, "adaptive must not waive actual image dimension validation");
assert.match(gate(imageModel, { ...valid, imageReferenceState: "stale" }, run), /参考已更换/u);
assert.equal(gate(textModel, { ...valid, imageReferenceState: "stale" }, run), "", "unused stale image must not block text video");
assert.match(gate(textModel, card, { ...run, executionMode: "chained" }), /切换普通模式/u);
assert.match(gate(imageModel, { ...card, videoInputs: { useStoryboardImage: false, firstFrameUrl: image } }, { ...run, executionMode: "chained" }), /本段分镜图/u);
assert.match(gate(textModel, card, { ...run, executionMode: "reference" }), /切换普通模式/u);
const frameModel = { ...imageModel, workflowInputMode: "first_last_frame", requiresFirstFrame: true, requiresLastFrame: true, maxReferenceImages: 2 };
assert.match(gate(frameModel, valid, run), /尾帧/u);
assert.match(gate(frameModel, { ...valid, videoInputs: { lastFrameUrl: image } }, run), /尾帧/u, "retained tails do not satisfy the simplified workbench");
const lipModel = { ...imageModel, workflowInputMode: "image_audio_lipsync", supportsAudioInput: true, minReferenceAudios: 1, maxReferenceAudios: 1 };
assert.match(gate(lipModel, valid, run), /音频/u);
assert.match(gate(lipModel, { ...valid, videoInputs: { audioUrl: audio } }, run), /音频/u);
for (const executionMode of ["ordinary", "reference", "chained"]) {
  for (const [special, reason] of [[frameModel, /尾帧/u], [lipModel, /音频/u], [sourceModel, /源视频/u], [{ ...imageModel, minReferenceImages: 2, maxReferenceImages: 3 }, /至少需要2张/u]] as Array<[Record<string, unknown>, RegExp]>) {
    assert.match(gate(special, { ...valid, videoInputs: { firstFrameUrl: image, lastFrameUrl: image, audioUrl: audio, sourceVideoUrl: video } }, { ...run, executionMode }), reason, `${executionMode} reports its actual unsupported required input before generic mode guidance`);
  }
}
assert.equal(harnessModule.exports.batchCardInput(card, "images"), harnessModule.exports.batchCardInput({ ...card, videoInputs: { sourceVideoUrl: video } }, "images"), "video inputs must not become image-generation references");
for (const videoInputs of [{ firstFrameUrl: image }, { lastFrameUrl: image }, { audioUrl: audio }, { referenceImageUrls: [image] }, { referenceAudioUrls: [audio] }, { sourceVideoUrl: video }, { useStoryboardImage: false }]) {
  const before = { ...run, cards: [card] };
  const authorization = { runId: run.id, settings: harnessModule.exports.batchSettings(before, "videos"), inputs: new Map([[card.id, harnessModule.exports.batchCardInput(card, "videos")]]) };
  harnessModule.exports.assertBatchSnapshotCurrent(before, card.id, "videos", authorization);
  assert.throws(() => harnessModule.exports.assertBatchSnapshotCurrent({ ...before, cards: [{ ...card, videoInputs }] }, card.id, "videos", authorization), /参数或参考图片已改变/u);
}
let fingerprintObject: ts.ObjectLiteralExpression | undefined;
const findFingerprint = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "buildClientRequestFingerprint" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])
    && node.arguments[0].properties.some(prop => prop.name?.getText(ast) === "sourceImageAspectRatio")) fingerprintObject = node.arguments[0];
  ts.forEachChild(node, findFingerprint);
};
findFingerprint(ast); assert.ok(fingerprintObject, "real video request fingerprint object missing");
const evaluateFingerprint = (inputCard: Record<string, unknown>, policy: { firstFrameRatioPolicy?: string } = {}) => {
  const holder = { exports: undefined as unknown };
  const resolved = resolveStoryboardAutomaticVideoInputs({ ...imageModel, ...policy }, inputCard);
  runInNewContext(ts.transpileModule(`module.exports = (${fingerprintObject!.getText(ast)});`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module: holder, current: run, card: { ...inputCard, order: 1 }, model: { ...imageModel, id: "model" }, executionPrompt: "编译后提示词", duration: 8, resolution: "720p", tokenBilling: undefined,
      submissionVideoInputs: resolved, submissionAspectRatio: resolveAiVideoInputAspectRatio(policy, run.ratio, resolved.input), effectiveImageRatio: harnessModule.exports.effectiveImageRatio, allowsIndependentReferenceRatio: harnessModule.exports.allowsIndependentReferenceRatio,
      generatedImageReferenceUri: () => "unused-typed-reference" });
  return JSON.parse(JSON.stringify(holder.exports));
};
assert.deepEqual(evaluateFingerprint(valid), { runId: run.id, cardId: card.id, cardOrder: 1, modelId: "model", prompt: "编译后提示词", duration: 8, aspectRatio: "16:9", sourceImageAspectRatio: "16:9", sourceImageDimensions: [1600, 900], referenceAspectRatioPolicy: "same", resolution: "720p", sourceImage: image }, "untouched legacy cards must preserve the exact original fingerprint fields for same-key retries");
assert.ok(evaluateFingerprint({ ...valid, videoInputs: { useStoryboardImage: true } }).videoInputs, "explicit video inputs must bind helper identity");
assert.equal(evaluateFingerprint({ ...valid, videoInputs: { firstFrameUrl: image } }, { firstFrameRatioPolicy: "adaptive" }).aspectRatio, "adaptive", "actual video fingerprint must bind the current storyboard image ratio policy");
assert.match(source, /videoInputs: submissionVideoInputs\.identity/u);
assert.match(source, /\.\.\.submissionVideoInputs\.requestFields/u);
assert.match(source, /JSON\.stringify\(resolveStoryboardAutomaticVideoInputs\(model, \{ \.\.\.item, videoPrompt: executionPrompt \}\)\.identity\) !== submissionVideoInputIdentity/u);
assert.ok(source.indexOf("const projectSaved = await saveStoryboardProject") < source.indexOf('const submitted = await fetchStoryboardJson("/api/video/generate"'), "save/readback must precede provider submission");
assert.match(source, /videoStatus === "failed" && card\.videoRetryable !== true/u);
assert.match(source, /resolveStoryboardVideoSameKeyRetryAttempt/u);
assert.doesNotMatch(source, /source_video_url:\s*card\.referenceImageUrls/u);
// Render the actual editor function with inert hooks; verify capability switches
// present the same effective roles the resolver will submit.
const editorSource = readFileSync(new URL("../src/components/storyboard-video-input-editor.tsx", import.meta.url), "utf8");
const editorAst = ts.createSourceFile("editor.tsx", editorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const editor = editorAst.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "StoryboardVideoInputEditor");
assert.ok(editor);
const inputNodes: Record<string, ts.Node> = {};
const collectInputPositions = (node: ts.Node) => {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "textarea") {
    const text = node.getText(ast);
    if (text.includes("生图提示词")) inputNodes.imagePrompt = node;
    if (text.includes("视频提示词")) inputNodes.videoPrompt = node;
  }
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "StoryboardVideoInputEditor") inputNodes.materials = node;
  ts.forEachChild(node, collectInputPositions);
};
collectInputPositions(ast);
assert.ok(inputNodes.imagePrompt && inputNodes.videoPrompt);
assert.equal(inputNodes.materials, undefined, "workbench no longer renders the manual materials editor");
assert.ok(inputNodes.imagePrompt.getStart(ast) < inputNodes.videoPrompt.getStart(ast));
assert.doesNotMatch(source, /StoryboardVideoInputEditor|updateCardVideoInputs|uploadCardVideoInput|videoInputUploadLocksRef|videoInputUploadingIds/u, "remove all unused editor state, upload callbacks and locks");
const editorModule = { exports: {} as { render?: (props: Record<string, unknown>) => React.ReactNode } };
runInNewContext(ts.transpileModule(`${editor.getText()}\nmodule.exports = { render: StoryboardVideoInputEditor };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { module: editorModule, exports: editorModule.exports, require: (id: string) => { assert.equal(id, "react/jsx-runtime"); return jsxRuntime; },
  useState: (value: unknown) => [value, () => undefined], getStoryboardVideoInputRoles, styles: {} });
const multiCaps = getAiVideoPageInputCapabilities({ workflowInputMode: "multi_image", supportsImageInput: true, minReferenceImages: 1, maxReferenceImages: 3 });
const editorHtml = renderToStaticMarkup(editorModule.exports.render!({ cardOrder: 1, capabilities: multiCaps,
  value: { firstFrameUrl: image, lastFrameUrl: image }, disabled: false, onChange: () => undefined, onUpload: async () => undefined }));
assert.match(editorHtml, /视频参考图（0\/2）/u, "hidden unsupported tail must not occupy a current reference slot");
assert.doesNotMatch(editorHtml, /checked=""/u, "custom primary image must uncheck storyboard-image selection");
const singleAudioHtml = renderToStaticMarkup(editorModule.exports.render!({ cardOrder: 1,
  capabilities: getAiVideoPageInputCapabilities({ workflowInputMode: "image_audio_lipsync", supportsImageInput: true, minReferenceAudios: 1, maxReferenceAudios: 1 }),
  value: { referenceAudioUrls: [audio] }, disabled: false, onChange: () => undefined, onUpload: async () => undefined }));
assert.match(singleAudioHtml, /参考音频（1\/0）/u, "unsupported retained list must show zero current capacity");
assert.doesNotMatch(singleAudioHtml, /aria-label="分段1参考音频链接"/u, "unsupported retained audio list must not offer an add input");
assert.match(singleAudioHtml, /移除分段1参考音频1/u, "retained audio still permits explicit removal");
for (const test of [
  { model: imageModel, value: {}, issue: "请先填写视频提示词", open: false },
  { model: imageModel, value: {}, issue: "请先生成分镜图", open: false },
  { model: textModel, value: {}, issue: "当前模型需要填写视频提示词", open: false },
  { model: sourceModel, value: {}, issue: "缺少源视频", open: true },
  { model: sourceModel, value: { sourceVideoUrl: video }, issue: "缺少提示词", open: false },
  { model: frameModel, value: {}, issue: "缺少尾帧", open: true },
  { model: frameModel, value: { lastFrameUrl: image }, issue: "缺少提示词", open: false },
  { model: lipModel, value: {}, issue: "缺少音频", open: true },
  { model: lipModel, value: { audioUrl: audio }, issue: "缺少提示词", open: false },
]) {
  const html = renderToStaticMarkup(editorModule.exports.render!({ cardOrder: 1, capabilities: getAiVideoPageInputCapabilities(test.model),
    value: test.value, disabled: false, issue: test.issue, onChange: () => undefined, onUpload: async () => undefined }));
  assert.equal(/^<details\b[^>]*\bopen=""/u.test(html), test.open, JSON.stringify(test));
}
for (const mode of ["multi_image", "image_audio_lipsync", "multi_image_audio"] as const) {
  const model = { workflowInputMode: mode, supportsImageInput: true, minReferenceImages: 1, maxReferenceImages: 3 };
  assert.match(gate(model, { ...card, videoInputs: { useStoryboardImage: false, firstFrameUrl: image } }, run), /本段分镜图/u, `${mode} cannot use hidden old custom images`);
  assert.equal(gate(model, { ...valid, videoInputs: { useStoryboardImage: false, firstFrameUrl: image } }, run), "", `${mode} automatically uses the validated current image`);
}
// Every dispatch, preparation and visible gate resolves the same automatic projection.
assert.doesNotMatch(source, /resolveStoryboardVideoInputs\(/u);
assert.match(source, /continuousVideoInputFingerprint: storyboardAutomaticVideoProductionFingerprint\(current, card/u);
assert.match(source, /storyboardAutomaticVideoProductionBlocker\(current\)/u);
assert.doesNotMatch(source, /storyboardProductionVideoFingerprint\(current, card|storyboardProductionBlocker\(current\)/u, "automatic capture and admission must never compare raw retained custom inputs");
assert.ok((source.match(/resolveStoryboardAutomaticVideoInputs\(/gu) || []).length >= 10);
const continuousStart = source.slice(source.indexOf("const startContinuousProduction ="), source.indexOf("const session = continuousAuthorizationRef.current;", source.indexOf("const startContinuousProduction =")));
assert.doesNotMatch(continuousStart, /card\.videoInputs|input\?\.useStoryboardImage/u, "retained hidden configuration cannot block continuous admission");
assert.match(source, /使用当前分镜图和本段视频提示词/u);
assert.match(source, /仅使用当前视频提示词，不使用图片或其他素材/u);
assert.doesNotMatch(source, /或改用自定义视频素材|或关闭使用本段分镜图/u);
assert.match(source, /showVideoStartIssue && !videoViewOnly/u, "display blocker text after removing its editor");
const oldCustom = { ...valid, videoInputs: { useStoryboardImage: false, firstFrameUrl: "https://assets.example.invalid/old.png" } };
const oldCustomFingerprint = JSON.stringify({ ...evaluateFingerprint(oldCustom), videoInputs: resolveStoryboardVideoInputs(imageModel, oldCustom).identity });
const automaticFingerprint = JSON.stringify(evaluateFingerprint(oldCustom));
assert.notEqual(oldCustomFingerprint, automaticFingerprint);
assert.throws(() => resolveStoryboardVideoSameKeyRetryAttempt({ currentFingerprint: automaticFingerprint, previousRequestId: "old-request", previousFingerprint: oldCustomFingerprint, sameRequestKeyRequired: true }), /VIDEO_RETRY_FINGERPRINT_MISMATCH_NOT_DISPATCHED/u, "same-key old custom requests refuse a changed automatic request rather than minting a key");
const legacyFingerprint = JSON.stringify(evaluateFingerprint(valid));
assert.equal(resolveStoryboardVideoSameKeyRetryAttempt({ currentFingerprint: legacyFingerprint, previousRequestId: "legacy-request", previousFingerprint: legacyFingerprint, sameRequestKeyRequired: true })?.clientRequestId, "legacy-request", "untouched legacy image retry preserves its original key");
console.log("Storyboard automatic video UI gates PASS: current-image-only dispatch, all entry points, reference/chained protection, batch/save/ratio/unknown guards, legacy same-key stability and changed-input rejection. Generic editor contracts remain tested. Zero network.");
