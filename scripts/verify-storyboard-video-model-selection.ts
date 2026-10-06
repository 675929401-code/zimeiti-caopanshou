import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  coerceStoryboardVideoRatio,
  resolveStoryboardVideoResolution,
  resolveStoryboardVideoSelection,
  storyboardVideoModelSelectionIssue,
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
  assert.equal(storyboardVideoModelSelectionIssue(model(), target), "");
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ supportsImageInput: false }), target),
    "不支持故事板图片输入",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ requiresSourceVideo: true }), target),
    "需要源视频，不能用于故事板图片",
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
    "需要分别提供首帧和尾帧，当前工作台不支持",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ name: "Legacy first-last-frame video" }), target),
    "需要分别提供首帧和尾帧，当前工作台不支持",
  );
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ supportsAudioInput: true }), target),
    "需要音频输入，请在 AI 视频制作的对应模式使用",
  );
  assert.equal(storyboardVideoModelSelectionIssue(model({ requiresImage: true }), target), "");
  assert.equal(
    storyboardVideoModelSelectionIssue(model({ priceReady: false }), target),
    "当前未开放",
  );

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
  assert.match(workbench, /aria-disabled=\{Boolean\(selectionIssue\)\}/u, "unavailable models must remain clickable for a public status explanation");
  assert.match(workbench, /publicModelSelectionLabel\(selectionIssue\)/u, "unavailable models must expose a public status label");
  assert.match(workbench, /const MAX_REFERENCES = 9/u, "storyboard references must match the live image gateway limit");

  console.log("Storyboard video model selection gate passed (zero network, zero media submissions)." );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
