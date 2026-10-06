import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AUTODL_HOSTED_H3_WORKFLOWS,
  buildAutoDLHostedH3VideoRecord,
} from "../src/lib/autodl-hosted-h3-workflow-catalog";
import {
  resolveStoryboardVideoResolution,
  resolveStoryboardVideoSelection,
  storyboardVideoModelSelectionIssue,
  type StoryboardVideoSelectionModel,
} from "../src/lib/storyboard-video-model-selection";
import { getVideoTargetDurationOptions } from "../src/lib/video-model-capabilities";

function asSelectionModel(index: number): StoryboardVideoSelectionModel & {
  workspaceSurfaces: string[];
} {
  const record = buildAutoDLHostedH3VideoRecord(AUTODL_HOSTED_H3_WORKFLOWS[index], {
    createdAt: "2026-08-21T00:00:00.000Z",
  });
  const config = record.api_protocol_config;
  return {
    id: record.id,
    name: record.name,
    modelName: record.model_name,
    durationSeconds: record.duration_seconds,
    durationMode: "discrete",
    minDuration: Number(config.min_duration),
    maxDuration: Number(config.max_duration),
    nativeDurations: config.duration_options,
    durationStep: Number(config.duration_step),
    supportsImageInput: record.supports_image_input,
    requiresImage: record.requires_image,
    requiresSourceVideo: config.requires_source_video === true,
    supportsAudioInput: config.supports_audio_input === true,
    referenceInputMode: String(config.workflow_input_mode || ""),
    resolutionOptions: config.resolution_options,
    defaultResolution: config.default_resolution,
    resolutionPrices: config.resolution_prices,
    aspectRatios: config.aspect_ratios,
    workspaceSurfaces: config.workspace_surfaces,
  } as StoryboardVideoSelectionModel & { workspaceSurfaces: string[] };
}

async function main() {
  const models = AUTODL_HOSTED_H3_WORKFLOWS.map((_, index) => asSelectionModel(index));
  const issues = Object.fromEntries(models.map((model) => [
    model.modelName,
    storyboardVideoModelSelectionIssue(model, { ratio: "16:9", duration: 10 }),
  ]));

  assert.equal(issues.minimax_h3_lightx2v_v5, "");
  assert.equal(issues.minimax_h3_lightx2v_no_pic, "不支持故事板图片输入");
  assert.equal(issues.minimax_h3_lightx2v, "需要分别提供首帧和尾帧，当前工作台不支持");
  assert.equal(issues.minimax_h3_lightx2v_v5_15s, "");
  assert.equal(issues.minimax_h3_image_audio_to_video, "需要音频输入，请在 AI 视频制作的对应模式使用");
  assert.equal(issues.minimax_h3_image_audio_to_video_v2, "需要音频输入，请在 AI 视频制作的对应模式使用");
  assert.equal(issues.minimax_h3_image_audio_to_video_v2_15s, "需要音频输入，请在 AI 视频制作的对应模式使用");

  const storyboardModels = models.filter((model) => (
    model.workspaceSurfaces.includes("storyboard")
    && !storyboardVideoModelSelectionIssue(model, { ratio: "16:9", duration: 10 })
  ));
  assert.deepEqual(storyboardModels.map((model) => model.modelName), [
    "minimax_h3_lightx2v_v5",
    "minimax_h3_lightx2v_v5_15s",
  ]);

  const multiImage = models.find((model) => model.modelName === "minimax_h3_lightx2v_v5")!;
  assert.equal(resolveStoryboardVideoResolution(multiImage), "768p", "1080p costs more, keep declared 768p default");
  assert.equal(resolveStoryboardVideoResolution(multiImage, "480p"), "480p", "preserve valid explicit tier");
  assert.equal(resolveStoryboardVideoResolution(multiImage, "2K"), "768p", "correct unsupported tier");
  assert.deepEqual(getVideoTargetDurationOptions(multiImage), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(resolveStoryboardVideoSelection(multiImage, {
    ratio: "16:9",
    duration: 15,
    resolution: "2K",
  }), {
    ratio: "16:9",
    duration: 10,
    resolution: "768p",
  });

  const multiImage15 = models.find((model) => model.modelName === "minimax_h3_lightx2v_v5_15s")!;
  assert.equal(resolveStoryboardVideoResolution(multiImage15), "768p", "equal 480p/768p price defaults to highest");
  assert.deepEqual(getVideoTargetDurationOptions(multiImage15), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

  const workbench = await readFile(path.join(process.cwd(), "src/components/storyboard-workbench.tsx"), "utf8");
  assert.match(workbench, /surface=storyboard-workbench/u);
  assert.match(workbench, /activeVideoModel\.resolutionOptions\.map/u, "resolution dropdown must use selected model options only");
  assert.match(workbench, /activeVideoDurationOptions\.map/u, "duration dropdown must use selected model options only");
  assert.match(workbench, /supportedWorkbenchRatios\(activeImageModel, activeVideoModel\)/u);
  assert.match(workbench, /resolveStoryboardVideoSelection\(model/u);
  assert.match(workbench, /resolveStoryboardVideoResolution\(model, requested\)/u);

  console.log(JSON.stringify({
    status: "passed",
    workflowCount: models.length,
    storyboardEligible: storyboardModels.map((model) => model.modelName),
    multiImageDefaultResolution: resolveStoryboardVideoResolution(multiImage),
    multiImage15DefaultResolution: resolveStoryboardVideoResolution(multiImage15),
    paidCalls: 0,
    networkCalls: 0,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
