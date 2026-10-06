import assert from "node:assert/strict";
import { parseStoryboardAgentOutput } from "../src/lib/storyboard-agent-output";

const narrationOne = "夜雨落在窗沿，女孩把最后一盏灯调暗，安静看着小狗追逐蓝色羽毛，房间只留下温暖呼吸与雨声。";
const narrationTwo = "镜头转向门口，女孩轻轻收起旅行箱，小狗叼着羽毛回头确认她还在，于是慢慢趴下，等待清晨一起出发。";
const fixtureLabel = "inline-release-safe-four-code-blocks";
const source = `
原文案内容段落 1：【${narrationOne}】
故事板分镜图文生图 Prompt（共5格）：
\`\`\`text
生成一张16:9电影感故事板，夜雨室内，女孩与小狗保持统一造型，蓝色羽毛作为语义道具。
\`\`\`
图生视频 Prompt（10秒2至3镜）：
\`\`\`text
从故事板第一格裁出的16:9画面开始，0至4秒女孩调暗台灯，4至10秒小狗追逐羽毛；无字幕，无对白口型。
\`\`\`

原文案内容段落 2：【${narrationTwo}】
故事板分镜图文生图 Prompt（共5格）：
\`\`\`text
生成一张16:9连续故事板，门口旅行箱、女孩和小狗延续上一段外观与光线，蓝色羽毛仍清晰可见。
\`\`\`
图生视频 Prompt（10秒2至3镜）：
\`\`\`text
从第一格16:9画面开始，0至5秒女孩收起旅行箱，5至10秒小狗叼羽毛回头后趴下；保持场景连续。
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
assert.match(result.segments[0].videoPrompt, /^从故事板第一格裁出的16:9/u);
assert.match(result.segments[1].imagePrompt, /^生成一张16:9/u);
assert.match(result.segments[1].videoPrompt, /^从第一格16:9/u);

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
