import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AI_VIDEO_PAGE_ASPECT_RATIOS,
  getAiVideoPageDefaultResolution,
  getAiVideoPageInputCapabilities,
  normalizeAiVideoWorkflowInputMode,
} from "../src/lib/ai-video-page-capabilities";
import {
  AUTODL_HOSTED_H3_WORKFLOWS,
  buildAutoDLHostedH3VideoRecord,
} from "../src/lib/autodl-hosted-h3-workflow-catalog";

function publicCapabilitySource(index: number) {
  const spec = AUTODL_HOSTED_H3_WORKFLOWS[index]!;
  const record = buildAutoDLHostedH3VideoRecord(spec);
  const config = record.api_protocol_config;
  return {
    id: record.id,
    supportsImageInput: record.supports_image_input,
    requiresImage: record.requires_image,
    resolutionOptions: config.resolution_options,
    defaultResolution: config.default_resolution,
    resolutionPrices: config.resolution_prices,
    workflowInputMode: config.workflow_input_mode,
    supportsPrompt: config.supports_prompt,
    requiresFirstFrame: config.requires_first_frame,
    requiresLastFrame: config.requires_last_frame,
    minReferenceImages: config.min_reference_images,
    maxReferenceImages: config.max_reference_images,
    minReferenceAudios: config.min_reference_audios,
    maxReferenceAudios: config.max_reference_audios,
    supportsAudioInput: config.supports_audio_input,
  };
}

assert.equal(AUTODL_HOSTED_H3_WORKFLOWS.length, 3);
assert.deepEqual(AI_VIDEO_PAGE_ASPECT_RATIOS.map((entry) => entry.value), ["16:9", "9:16", "1:1"]);

const videoPageSource = readFileSync(new URL("../src/app/video/page.tsx", import.meta.url), "utf8");
const videoModelsRouteSource = readFileSync(new URL("../src/app/api/video/models/route.ts", import.meta.url), "utf8");
const videoInputContractSource = readFileSync(new URL("../src/lib/video-input-contract.ts", import.meta.url), "utf8");
assert.match(
  videoPageSource,
  /getAiVideoPageInputCapabilities\(selectedModel\)/u,
  "模型目录尚未加载时必须走能力函数的纯文本安全默认值",
);
assert.doesNotMatch(
  videoPageSource,
  /selectedModel\s*\?\?\s*\{[\s\S]*?requiresImage:\s*true/u,
  "视频页不得把未选择模型硬编码成必须参考图",
);
assert.match(
  videoInputContractSource,
  /config\.workflow_input_mode\s*\?\?\s*config\.reference_input_mode/u,
  "共享视频输入协议必须兼容旧 reference_input_mode",
);
assert.match(videoModelsRouteSource, /getVideoInputContract\(m\)/u, "公共视频 DTO 必须复用服务端输入协议");

assert.equal(normalizeAiVideoWorkflowInputMode("none"), "text");
assert.equal(normalizeAiVideoWorkflowInputMode("t2v"), "text");
assert.equal(normalizeAiVideoWorkflowInputMode("single"), "flexible_image");
assert.equal(normalizeAiVideoWorkflowInputMode("i2v"), "flexible_image");
assert.equal(normalizeAiVideoWorkflowInputMode("multi"), "multi_image");

const noSelectedModel = getAiVideoPageInputCapabilities();
assert.equal(noSelectedModel.mode, "text");
assert.equal(noSelectedModel.showReferenceImages, false);
assert.equal(noSelectedModel.minReferenceImages, 0);
assert.equal(noSelectedModel.maxReferenceImages, 0);

const pureTextModel = getAiVideoPageInputCapabilities({
  supportsImageInput: true,
  requiresImage: false,
  workflowInputMode: "none",
  minReferenceImages: 1,
  maxReferenceImages: 9,
});
assert.equal(pureTextModel.mode, "text", "显式 T2V 必须覆盖旧的可选图片/数量残留");
assert.equal(pureTextModel.showReferenceImages, false);
assert.equal(pureTextModel.minReferenceImages, 0);
assert.equal(pureTextModel.maxReferenceImages, 0);

const optionalImageModel = getAiVideoPageInputCapabilities({
  supportsImageInput: true,
  requiresImage: false,
  workflowInputMode: "single",
});
assert.equal(optionalImageModel.mode, "flexible_image");
assert.equal(optionalImageModel.showReferenceImages, true);
assert.equal(optionalImageModel.minReferenceImages, 0, "支持图片不等于必须图片");
assert.equal(optionalImageModel.maxReferenceImages, 1);

const inferredOptionalImageModel = getAiVideoPageInputCapabilities({
  requiresImage: false,
  maxReferenceImages: 4,
});
assert.equal(
  inferredOptionalImageModel.mode,
  "flexible_image",
  "旧模型未声明 workflowInputMode 时，正数 maxReferenceImages 仍应显示可选参考图入口",
);
assert.equal(inferredOptionalImageModel.showReferenceImages, true);
assert.equal(inferredOptionalImageModel.minReferenceImages, 0);
assert.equal(inferredOptionalImageModel.maxReferenceImages, 4);

const requiredImageModel = getAiVideoPageInputCapabilities({
  supportsImageInput: true,
  requiresImage: true,
  workflowInputMode: "text",
  maxReferenceImages: 0,
});
assert.equal(requiredImageModel.mode, "flexible_image", "真正 I2V 不得被冲突的 text 模式隐藏");
assert.equal(requiredImageModel.showReferenceImages, true);
assert.equal(requiredImageModel.minReferenceImages, 1);
assert.equal(requiredImageModel.maxReferenceImages, 1);

assert.equal(getAiVideoPageDefaultResolution({
  resolutionOptions: ["480p", "1080p", "768p"],
  defaultResolution: "480p",
  resolutionPrices: { "480p": 0.01, "768p": 0.01, "1080p": 0.01 },
}), "1080p", "same price must default to the highest resolution");

assert.equal(getAiVideoPageDefaultResolution({
  resolutionOptions: ["480p", "768p", "1080p"],
  defaultResolution: "768p",
  resolutionPrices: { "480p": 0.01, "768p": 0.01, "1080p": 0.10 },
}), "768p", "a configured default must be preserved when prices differ");

assert.equal(getAiVideoPageDefaultResolution({
  resolutionOptions: ["480p", "768p", "1080p"],
  resolutionPrices: { "480p": 0.01, "768p": 0.01, "1080p": 0.10 },
}), "768p", "without a configured default, remain in the cheapest tier and choose its best quality");

const expected = [
  { mode: "multi_image", prompt: true, first: false, last: false, images: true, minImages: 1, maxImages: 9, audio: false, minAudio: 0, maxAudio: 0 },
  { mode: "text", prompt: true, first: false, last: false, images: false, minImages: 0, maxImages: 0, audio: false, minAudio: 0, maxAudio: 0 },
  { mode: "first_last_frame", prompt: true, first: true, last: true, images: false, minImages: 2, maxImages: 2, audio: false, minAudio: 0, maxAudio: 0 },
  { mode: "multi_image", prompt: true, first: false, last: false, images: true, minImages: 1, maxImages: 9, audio: false, minAudio: 0, maxAudio: 0 },
  { mode: "image_audio_lipsync", prompt: false, first: false, last: false, images: true, minImages: 1, maxImages: 1, audio: true, minAudio: 1, maxAudio: 1 },
  { mode: "multi_image_audio", prompt: true, first: false, last: false, images: true, minImages: 0, maxImages: 9, audio: true, minAudio: 0, maxAudio: 3 },
  { mode: "multi_image_audio", prompt: true, first: false, last: false, images: true, minImages: 0, maxImages: 9, audio: true, minAudio: 0, maxAudio: 3 },
] as const;

for (const [index, expectation] of expected.entries()) {
  const source = publicCapabilitySource(index);
  const controls = getAiVideoPageInputCapabilities(source);
  assert.equal(controls.mode, expectation.mode, `${source.id}: mode`);
  assert.equal(controls.supportsPrompt, expectation.prompt, `${source.id}: prompt`);
  assert.equal(controls.showFirstFrame, expectation.first, `${source.id}: first frame`);
  assert.equal(controls.showLastFrame, expectation.last, `${source.id}: last frame`);
  assert.equal(controls.showReferenceImages, expectation.images, `${source.id}: references`);
  assert.equal(controls.minReferenceImages, expectation.minImages, `${source.id}: min images`);
  assert.equal(controls.maxReferenceImages, expectation.maxImages, `${source.id}: max images`);
  assert.equal(controls.showAudioInputs, expectation.audio, `${source.id}: audio controls`);
  assert.equal(controls.minReferenceAudios, expectation.minAudio, `${source.id}: min audio`);
  assert.equal(controls.maxReferenceAudios, expectation.maxAudio, `${source.id}: max audio`);

  const defaultResolution = getAiVideoPageDefaultResolution(source);
  assert.ok((source.resolutionOptions as string[]).includes(defaultResolution), `${source.id}: default resolution is selectable`);
}

console.log(JSON.stringify({
  ok: true,
  network_requests: 0,
  paid_requests: 0,
  capability_contracts_checked: 5,
  workflows_checked: expected.length,
  defaults: AUTODL_HOSTED_H3_WORKFLOWS.map((spec, index) => ({
    workflow: spec.workflowId,
    resolution: getAiVideoPageDefaultResolution(publicCapabilitySource(index)),
    inputMode: getAiVideoPageInputCapabilities(publicCapabilitySource(index)).mode,
  })),
}, null, 2));
