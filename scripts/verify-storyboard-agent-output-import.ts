import assert from "node:assert/strict";
import { parseStoryboardAgentOutput } from "../src/lib/storyboard-agent-output";

const narrationOne = "夜雨落在窗沿，女孩把最后一盏灯调暗，安静看着小狗追逐蓝色羽毛，房间只留下温暖呼吸与雨声。";
const narrationTwo = "镜头转向门口，女孩轻轻收起旅行箱，小狗叼着羽毛回头确认她还在，于是慢慢趴下，等待清晨一起出发。";
const fixtureLabel = "inline-release-safe-four-code-blocks";
const source = `
原文案内容段落 1：【${narrationOne}】
故事板分镜图文生图 Prompt（共5格）：
\`\`\`text
生成一张16:9完整五格单图故事板，夜雨室内，女孩与小狗保持统一造型，蓝色羽毛作为语义道具。
\`\`\`
图生视频 Prompt（10秒2至3镜）：
\`\`\`text
从完整五格单图故事板开始，保持整张16:9画面，0至4秒女孩调暗台灯，4至10秒小狗追逐羽毛；无字幕，无对白口型。
\`\`\`

原文案内容段落 2：【${narrationTwo}】
故事板分镜图文生图 Prompt（共5格）：
\`\`\`text
生成一张16:9完整五格单图故事板，门口旅行箱、女孩和小狗延续上一段外观与光线，蓝色羽毛仍清晰可见。
\`\`\`
图生视频 Prompt（10秒2至3镜）：
\`\`\`text
从完整五格单图故事板开始，保持整张16:9画面，0至5秒女孩收起旅行箱，5至10秒小狗叼羽毛回头后趴下；保持场景连续。
\`\`\`
`;
const result = parseStoryboardAgentOutput(source);

assert.equal(result.ok, true, "真实智能体输出没有通过解析");
if (!result.ok) throw new Error("真实智能体输出没有通过解析");
assert.equal(result.segments.length, 2, "没有从四个代码框中拆出两张镜头卡");
assert.equal(result.segments[0].sourceNumber, 1);
assert.equal(result.segments[1].sourceNumber, 2);
assert.equal(result.segments[0].narration, narrationOne, "第一段口播没有完整保留");
assert.equal(result.segments[1].narration, narrationTwo, "第二段口播没有完整保留");
assert.match(result.segments[0].imagePrompt, /^生成一张16:9/u);
assert.match(result.segments[0].videoPrompt, /^从完整五格单图故事板开始/u);
assert.match(result.segments[1].imagePrompt, /^生成一张16:9/u);
assert.match(result.segments[1].videoPrompt, /^从完整五格单图故事板开始/u);

const visualAssetPlan = {
  mode: "selected" as const,
  generationPolicy: {
    maxInitialImages: 1,
    initialRequiredAssetIds: ["character_main"],
    initialDeferredAssetIds: [],
    environmentAnchorPolicy: "per-scene-when-required" as const,
  },
  assets: [{
    id: "character_main",
    role: "character" as const,
    name: "主角女孩",
    identityLock: "短黑发、米色针织衫、圆框眼镜，脸型和服装颜色保持一致。",
    allowedChanges: ["表情"],
    referencePrompts: [{
      kind: "identity" as const,
      purpose: "锁定角色身份",
      prompt: "中性站姿的卡通女孩身份参考图，短黑发、米色针织衫、圆框眼镜，干净浅色背景。",
    }],
  }],
};
const formatterRoundtrip = parseStoryboardAgentOutput(`
## 原文案内容段落 1: ${narrationOne}
视觉资产引用：[{"assetId":"character_main","role":"character","referenceKinds":["identity"]}]
### 图片提示词：
\`\`\`text
完整五格单图故事板，女孩与小狗在雨夜房间保持统一身份。
\`\`\`
### 视频提示词：
\`\`\`text
从完整五格单图故事板开始，女孩调暗台灯，小狗追逐蓝色羽毛并稳定落幅。
\`\`\`

\`\`\`storyboard-assets
${JSON.stringify(visualAssetPlan)}
\`\`\`
`);
assert.equal(formatterRoundtrip.ok, true, "canonical formatter 输出没有通过回灌");
assert.deepEqual(formatterRoundtrip.visualAssetPlan, visualAssetPlan);
assert.deepEqual(formatterRoundtrip.segments[0].visualAssetRefs, [{
  assetId: "character_main",
  role: "character",
  referenceKinds: ["identity"],
}]);

const legacyFormatterHeading = parseStoryboardAgentOutput(`
## 片段 1 · 10秒+口播：${narrationOne}
多维拆解：这行分析不能被误认成口播
故事板分镜图文生图 Prompt（共5格）：
\`\`\`text
完整五格单图故事板，女孩与小狗保持统一造型。
\`\`\`
图生视频提示词（10秒2至3镜）：
\`\`\`text
从完整五格单图开始，女孩调灯，小狗追逐羽毛并落幅。
\`\`\`
`);
assert.equal(legacyFormatterHeading.ok, true, "片段 · 10秒+口播标题没有兼容");
assert.equal(legacyFormatterHeading.segments[0].narration, narrationOne);

const expectImportFailure = (input: string, pattern: RegExp) => {
  const failed = parseStoryboardAgentOutput(input);
  assert.equal(failed.ok, false, `预期导入失败：${pattern}`);
  if (failed.ok) throw new Error("unexpected successful import");
  assert.match(failed.error, pattern);
};
const validPromptPair = `
原文案内容段落 1：测试口播
图片提示词：
\`\`\`text
完整四格单图故事板，角色和环境保持连续。
\`\`\`
视频提示词：
\`\`\`text
从完整四格单图开始，主体完成连续动作并稳定落幅。
\`\`\`
`;
const reversedPromptPair = validPromptPair.replace(
  "图片提示词：\n```text\n完整四格单图故事板，角色和环境保持连续。\n```\n视频提示词：\n```text\n从完整四格单图开始，主体完成连续动作并稳定落幅。\n```",
  "视频提示词：\n```text\n从完整四格单图开始，主体完成连续动作并稳定落幅。\n```\n图片提示词：\n```text\n完整四格单图故事板，角色和环境保持连续。\n```",
);
expectImportFailure(reversedPromptPair, /必须先出现图片 Prompt/u);
expectImportFailure(validPromptPair.replace("视频提示词：\n", ""), /必须包含/u);
expectImportFailure(validPromptPair.replace("完整四格单图故事板，角色和环境保持连续。", ""), /空 Prompt/u);

const duplicateAssetPackage = JSON.stringify({
  ...visualAssetPlan,
  assets: [visualAssetPlan.assets[0], visualAssetPlan.assets[0]],
});
expectImportFailure(`${validPromptPair}\n\`\`\`storyboard-assets\n${duplicateAssetPackage}\n\`\`\``, /(?:asset id 重复|视觉资产语义标识不能重复)/u);
expectImportFailure(`${validPromptPair.replace("测试口播", "测试口播\n视觉资产引用：[{\"assetId\":\"unknown_asset\",\"role\":\"character\",\"referenceKinds\":[\"identity\"]}]")}\n\`\`\`storyboard-assets\n${JSON.stringify(visualAssetPlan)}\n\`\`\``, /未知视觉资产/u);

const legacy = parseStoryboardAgentOutput(`
原文案内容段落 1：【第一段完整口播】
故事板分镜图文生图 Prompt（共5格）：
\`\`\`text
第一段生图原文
\`\`\`
图生视频 Prompt（10秒2至3镜）：
\`\`\`text
第一段视频原文
\`\`\`
`);
assert.deepEqual(legacy, {
  ok: true,
  segments: [{
    sourceNumber: 1,
    narration: "第一段完整口播",
    imagePrompt: "第一段生图原文",
    videoPrompt: "第一段视频原文",
  }],
});

const incomplete = parseStoryboardAgentOutput(`
**原文案内容段落 1**：缺少视频框
**故事板分镜图文生图 Prompt（共4格）**：
\`\`\`text
只有生图
\`\`\`
`);
assert.equal(incomplete.ok, false, "缺框输出不应通过解析");
assert.match(incomplete.ok ? "" : incomplete.error, /必须包含/u);

console.log(JSON.stringify({
  passed: true,
  fixture: fixtureLabel,
  segments: result.segments.map((segment) => ({
    sourceNumber: segment.sourceNumber,
    narrationCharacters: segment.narration.length,
    imagePromptCharacters: segment.imagePrompt.length,
    videoPromptCharacters: segment.videoPrompt.length,
  })),
}, null, 2));
