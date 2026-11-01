import assert from "node:assert/strict";
import { resolveStoryboardVideoInputs } from "../src/lib/storyboard-video-inputs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import {
  coerceStoryboardVideoRatio,
  resolveStoryboardVideoResolution,
  resolveStoryboardVideoSelection,
  storyboardVideoModelSelectionIssue,
  resolveStoryboardInitialVideoModelId,
  type StoryboardVideoSelectionModel,
} from "../src/lib/storyboard-video-model-selection";

function model(
  overrides: Partial<StoryboardVideoSelectionModel> = {},
): StoryboardVideoSelectionModel {
  return {
    id: "compatible-10s",
    name: "Compatible 10s",
    durationSeconds: 10,
    durationMode: "fixed",
    minDuration: 10,
    maxDuration: 10,
    nativeDurations: [10],
    supportsImageInput: true,
    requiresSourceVideo: false,
    aspectRatios: ["16:9", "9:16"],
    ...overrides,
  };
}

async function main() {
  const target = { ratio: "16:9", duration: 10 };
  const sourceEdit = model({ id: "source-edit", name: "Omni Flash · ≤10秒 · 视频编辑", supportsImageInput: false, requiresSourceVideo: true, workflowInputMode: "text", maxReferenceImages: 0 });
  const directBoard = model({ id: "direct-board", name: "普通图生视频", maxReferenceImages: 1, requiresImage: true });
  const normalFlash = model({ ...directBoard, id: "normal-flash", name: "Omni Flash · 10秒 · 图生视频" });
  const requiredAudio = model({ id: "requires-audio", name: "Omni Flash 10", minReferenceAudios: 1, maxReferenceAudios: 1 });
  const requiredTail = model({ id: "requires-tail", name: "Omni Flash 10", requiresLastFrame: true, requiresFirstFrame: true, maxReferenceImages: 2 });
  const pureText = model({ id: "text-fallback", supportsImageInput: false, workflowInputMode: "text", maxReferenceImages: 0 });
  assert.equal(resolveStoryboardInitialVideoModelId(undefined, [sourceEdit, directBoard]), directBoard.id);
  assert.equal(resolveStoryboardInitialVideoModelId(undefined, [sourceEdit, requiredAudio, requiredTail, normalFlash, directBoard]), normalFlash.id);
  assert.equal(resolveStoryboardInitialVideoModelId(undefined, [pureText, directBoard]), directBoard.id, "fresh workspaces prefer the ordinary storyboard-image workflow");
  assert.equal(resolveStoryboardInitialVideoModelId(undefined, [sourceEdit, pureText]), pureText.id);
  assert.equal(resolveStoryboardInitialVideoModelId(undefined, [sourceEdit, requiredAudio, requiredTail]), "", "do not auto-select a workflow that requires external media");
  assert.equal(resolveStoryboardInitialVideoModelId(String(sourceEdit.id), [sourceEdit, directBoard]), sourceEdit.id, "explicit source-edit selection stays exact");
  assert.equal(resolveStoryboardInitialVideoModelId("saved-missing-model", [directBoard]), "saved-missing-model", "saved selections never silently switch");
  assert.equal(storyboardVideoModelSelectionIssue(model({ generationReady: true, readinessMessage: "未验收 pending", verificationNotice: "未完成真实付费生成" }), target), "");
  assert.ok(storyboardVideoModelSelectionIssue(model({ generationReady: false }), target));
  assert.equal(storyboardVideoModelSelectionIssue(model(), target), "");
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ supportsImageInput: false }), target),
    "",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ requiresSourceVideo: true }), target),
    "",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ aspectRatios: ["9:16"] }), target),
    "",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({
      durationSeconds: 8,
      durationMode: "fixed",
      minDuration: 8,
      maxDuration: 8,
      nativeDurations: [8],
    }), target),
    "",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({
      durationSeconds: 5,
      durationMode: "discrete",
      minDuration: 5,
      maxDuration: 15,
      nativeDurations: [5, 10, 15],
    }), target),
    "",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ name: "H3首尾帧生成视频" }), target),
    "",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ name: "Legacy first-last-frame video" }), target),
    "",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ supportsAudioInput: true }), target),
    "",
  );
  assert.equal(storyboardVideoModelSelectionIssue(model({ requiresImage: true }), target), "");
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ priceReady: false }), target),
    "当前未开放",
  );

  const textModel = model({ supportsImageInput: false, workflowInputMode: "text", maxReferenceImages: 0 });
  assert.equal(resolveStoryboardVideoInputs(textModel, { videoPrompt: "仅文字生成" }).issue, "");
  assert.equal(resolveStoryboardVideoInputs(textModel, { videoPrompt: "仅文字生成" }).usesStoryboardImage, false);
  const sourceModel = model({ supportsImageInput: false, requiresSourceVideo: true, workflowInputMode: "text", maxReferenceImages: 0 });
  assert.match(resolveStoryboardVideoInputs(sourceModel, { videoPrompt: "编辑视频" }).issue, /源视频/u);
  assert.equal(resolveStoryboardVideoInputs(sourceModel, { videoPrompt: "编辑视频", videoInputs: { sourceVideoUrl: "https://assets.example.invalid/source.mp4" } }).issue, "");
  const frameModel = model({ workflowInputMode: "first_last_frame", requiresFirstFrame: true, requiresLastFrame: true });
  assert.equal(storyboardVideoModelSelectionIssue(frameModel, target), "");
  assert.match(resolveStoryboardVideoInputs(frameModel, { videoPrompt: "连续动作", imageUrl: "https://assets.example.invalid/board.png" }).issue, /尾帧/u);
  assert.equal(resolveStoryboardVideoInputs(frameModel, { videoPrompt: "连续动作", imageUrl: "https://assets.example.invalid/board.png", videoInputs: { lastFrameUrl: "https://assets.example.invalid/last.png" } }).issue, "");
  const audioModel = model({ workflowInputMode: "image_audio_lipsync", supportsAudioInput: true, minReferenceAudios: 1, maxReferenceAudios: 1 });
  assert.equal(storyboardVideoModelSelectionIssue(audioModel, target), "");
  assert.match(resolveStoryboardVideoInputs(audioModel, { videoPrompt: "对口型", imageUrl: "https://assets.example.invalid/board.png" }).issue, /音频/u);
  assert.ok(storyboardVideoModelSelectionIssue(model({ generationReady: false }), target));
  assert.ok(storyboardVideoModelSelectionIssue(model({ available: false }), target));

  const equalPriceModel = model({
    resolutionOptions: ["480p", "768p", "1080p"],
    defaultResolution: "480p",
    resolutionPrices: { "480p": 0.01, "768p": 0.01, "1080p": 0.01 },
  });
  assert.equal(resolveStoryboardVideoResolution(equalPriceModel), "1080p", "same-price tiers default to highest");
  assert.equal(resolveStoryboardVideoResolution(equalPriceModel, "480p"), "480p", "valid user choice is preserved");
  const differentPriceModel = model({
    resolutionOptions: ["480p", "768p", "1080p"],
    defaultResolution: "768p",
    resolutionPrices: { "480p": 0.01, "768p": 0.01, "1080p": 0.1 },
  });
  assert.equal(resolveStoryboardVideoResolution(differentPriceModel), "768p", "different prices keep explicit default");
  assert.equal(resolveStoryboardVideoResolution(differentPriceModel, "2K"), "768p", "invalid tier is corrected");
  assert.equal(coerceStoryboardVideoRatio(model({ aspectRatios: ["9:16"] }), "16:9"), "9:16");
  assert.deepEqual(resolveStoryboardVideoSelection(model({
    durationSeconds: 15,
    durationMode: "fixed",
    minDuration: 15,
    maxDuration: 15,
    nativeDurations: [15],
    aspectRatios: ["9:16"],
    resolutionOptions: ["768p"],
    defaultResolution: "768p",
  }), { ratio: "16:9", duration: 10, resolution: "2K" }), {
    ratio: "9:16",
    duration: 15,
    resolution: "768p",
  });

  const root = process.cwd();
  const review = JSON.parse(await readFile(path.join(
    root,
    "public/storyboard-reviews/dog-rejection-signals-14shot-20260821.json",
  ), "utf8")) as {
  run: {
    videoModelId: string;
    videoResolution: string;
    videoDuration: number;
    ratio: string;
    videoContract: { modelId: string; resolution: string; duration: number; ratio: string };
  };
  };
  assert.equal(review.run.videoModelId, "pm_tabUjazl2a7DJ2POEriC-Ogo");
  assert.deepEqual(review.run.videoContract, {
    modelId: "pm_tabUjazl2a7DJ2POEriC-Ogo",
    resolution: "2K",
    duration: 10,
    ratio: "16:9",
  });
  assert.equal(review.run.videoResolution, "2K");
  assert.equal(review.run.videoDuration, 10);
  assert.equal(review.run.ratio, "16:9");

  const workbench = await readFile(path.join(root, "src/components/storyboard-workbench.tsx"), "utf8");
  assert.doesNotMatch(workbench, /lockedToAnotherModel/u, "review contract must not disable every alternative model");
  assert.doesNotMatch(workbench, /disabled=\{Boolean\(run\.videoContract\)\}/u, "contract presence alone must not lock controls");
  assert.match(workbench, /model\.id === contract\.modelId/u, "contract enforcement must apply only to its recommended model");
  assert.match(workbench, /resolveStoryboardVideoSelection\(model/u, "model switch must coerce all capabilities together");
  assert.match(workbench, /preferredContract\?\.resolution \|\| run\.videoResolution/u, "self-host selection must restore the review's 2K contract");
  assert.doesNotMatch(workbench, /验收推荐模型；可手动选择其他兼容模型/u, "internal acceptance labels are not product UI");
  assert.match(workbench, /resolveStoryboardInitialVideoModelId\(requestedVideoModelId, nextVideos\)/u, "missing saved selections must not silently pick another channel");
  assert.match(workbench, /aria-disabled=\{Boolean\(selectionIssue\)\}/u, "unavailable models must remain visible with a public status explanation");
  assert.match(workbench, /const batchVideoBlockedReason = activeVideoSelectionIssue\s*\? publicModelSelectionNotice\(activeVideoSelectionIssue, "视频模型"\)/u, "generation guidance must use the public notice boundary");
  assert.doesNotMatch(workbench, /publicVideoModelCompatibilityMessage\(/u, "internal compatibility diagnostics must not bypass the public notice boundary");
  assert.match(workbench, /videoModels\.map\(\(model\) =>/u, "unavailable models must remain in the visible catalog");
  assert.match(workbench, /disabled=\{Boolean\(selectionIssue\)\}/u, "unpublished or unavailable visible models must not change the selection");
  assert.match(workbench, /const MAX_REFERENCES = 9/u, "storyboard references must match the live image gateway limit");

  // Run the real product formatter, including its label dependency, rather
  // than replacing the removed internal compatibility text with another fixture.
  const workbenchAst = ts.createSourceFile("storyboard-workbench.tsx", workbench, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const publicNoticeSource = ["publicModelSelectionLabel", "publicModelSelectionNotice"].map(name => {
    const declaration = workbenchAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, `public notice function missing: ${name}`);
    return declaration.getText();
  }).join("\n");
  const noticeModule = { exports: undefined as unknown as (issue: string, subject?: string) => string };
  runInNewContext(ts.transpileModule(`${publicNoticeSource}\nmodule.exports = publicModelSelectionNotice;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: noticeModule });
  const publicNotice = noticeModule.exports;
  assert.equal(publicNotice(""), "");
  for (const diagnostic of ["上游配额不足", "通道待核验", "接口 https://private.invalid/v1/videos 返回异常", "usage.quota 不可用"]) {
    assert.equal(publicNotice(diagnostic, "视频模型"), "当前无法生成，请选择其他模型或稍后重试");
  }
  for (const guidance of [
    "不支持故事板图片输入", "需要源视频，不能用于故事板图片", "需要分别提供首帧和尾帧，当前工作台不支持",
    "需要音频输入，请在 AI 视频制作的对应模式使用", "至少需要 2 张参考图；分镜每张卡片仅提交一张故事板，请在视频制作页使用",
    "当前模型不接收故事板图片", "当前清晰度不可用，请选择其他清晰度", "当前画面比例不受支持",
  ]) assert.equal(publicNotice(guidance, "视频模型"), guidance, "actionable input guidance must be preserved");
  assert.equal(publicNotice("视频模型尚未加载"), "视频模型尚未加载，请稍后重试");
  assert.equal(publicNotice("当前未开放", "视频模型"), "视频模型当前无法生成，请选择其他模型或稍后重试");

  console.log("Storyboard video model selection gate passed (zero network, zero media submissions)." );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
