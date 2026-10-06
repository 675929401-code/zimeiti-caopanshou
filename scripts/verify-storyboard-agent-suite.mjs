import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const allAgentNames = [
  "故事版导演｜高能夸张",
  "故事版导演｜电影叙事",
  "故事版导演｜抒情情感",
];
const filter = process.env.AGENT_FILTER?.trim();
const suiteVersion = process.env.SUITE_VERSION?.trim() || "v53";
const agentNames = filter ? allAgentNames.filter((name) => name.includes(filter)) : allAgentNames;
assert.ok(agentNames.length, `没有匹配AGENT_FILTER=${filter}的故事版智能体`);
const originalCopy = "主人刚拿起钥匙，金毛就从地毯上弹起来，耳朵紧贴脑后，前爪不停换步，眼睛死死盯着门。门刚关上，它便叼着拖鞋冲到门缝前，趴在那里等到窗外天色变暗。直到钥匙再次转动，它才猛地跃起，尾巴甩成一团金色旋风。";
const submittedMessage = [
  `分段文案：1.【${originalCopy}】`,
  "生图比例：16:9 横屏",
  "画面风格：高能商业3D动画喜剧（皮克斯式）",
  "角色设定：27岁中国女性，深棕高马尾，芥末黄连帽卫衣、蓝色牛仔裤、白色运动鞋；成年金毛犬，蜂蜜金长毛、深棕圆眼、黑鼻、红色项圈，保持自然四足身份，不穿衣服。",
  "特殊要求：角色不说话，不生成口播字幕；一张图中使用4至5格连续故事板。",
].join("\n");

function uniqueFrameNumbers(prompt) {
  return new Set([...prompt.matchAll(/Frame\s*([1-5])/giu)].map((match) => Number(match[1])));
}

function semanticCoverage(prompt) {
  return {
    anxiety: /(紧张|焦虑|不安|心跳|震颤|抖动|压迫线|警觉|耳朵.*后|前爪.*换步)/u.test(prompt),
    waiting: /(等待|时间流逝|天色变暗|暮色|时钟|钟表|光线.*变化|影子.*拉长|门缝)/u.test(prompt),
    reunion: /(重逢|归来|钥匙.*转动|金色旋风|尾巴.*旋|爆发|跃起|扑向)/u.test(prompt),
  };
}

function extractVideoFrames(prompt) {
  return [...prompt.matchAll(/Frame\s*([1-5])（[^\n]*）：([\s\S]*?)(?=\n\s*Frame\s*[1-5]（|\n\s*声音与口型：|$)/giu)]
    .map((match) => ({ order: Number(match[1]), content: match[2].trim() }));
}

function extractAssistantContent(payload) {
  return payload?.choices?.[0]?.message?.content
    || payload?.choices?.[0]?.text
    || payload?.content
    || payload?.message?.content
    || "";
}

function extractTextCodeBlocks(content) {
  return [...content.matchAll(/```text\s*\n([\s\S]*?)\n```/g)].map((match) => match[1].trim());
}

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

const botsResponse = await fetch(`${baseUrl}/api/bots?storyboard_suite_test=${Date.now()}`, {
  headers: { Authorization: `Bearer ${session.token}` },
});
const botsPayload = await botsResponse.json();
assert.ok(botsResponse.ok, botsPayload.error || "主站智能体列表读取失败");

const results = [];
for (const agentName of agentNames) {
  const agent = botsPayload.bots?.find((item) => item.name === agentName);
  assert.ok(agent, `主站没有找到智能体：${agentName}`);
  assert.equal(agent.preset_fields?.length, 5, `${agentName}接收模板不是5个字段`);
  const styleField = agent.preset_fields.find((field) => field.id === "storyboard_visual_style");
  assert.equal(styleField?.options?.length, 10, `${agentName}没有10种3D风格`);
  assert.ok(styleField.options.every((option) => option.includes("3D")), `${agentName}混入非3D风格`);

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/llm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: submittedMessage }],
      model: agent.model,
      stream: false,
      userId: session.user.id,
      agentName: agent.name,
      agentId: agent.id,
      maxContextRounds: 1,
      maxContextTokens: 0,
      maxReplyTokens: 32768,
      timeout: 120,
      enableWebSearch: false,
      responseFormat: "markdown",
    }),
    signal: AbortSignal.timeout(150_000),
  });
  const payload = await response.json();
  assert.ok(response.ok, payload.error || `${agentName}请求失败（${response.status}）`);
  const content = extractAssistantContent(payload);
  const blocks = extractTextCodeBlocks(content);
  assert.equal(blocks.length, 2, `${agentName}必须且只能输出两个text代码框`);
  const [imagePrompt, videoPrompt] = blocks;
  assert.ok(content.includes(originalCopy), `${agentName}没有逐字保留原文`);
  const imageFrames = uniqueFrameNumbers(imagePrompt);
  const videoFrames = uniqueFrameNumbers(videoPrompt);
  assert.ok(imageFrames.size >= 4 && imageFrames.size <= 5, `${agentName}生图Prompt不是4至5格完整故事板`);
  assert.equal(videoFrames.size, imageFrames.size, `${agentName}视频Prompt没有逐格承接生图故事板`);
  assert.ok(/中国女性/.test(imagePrompt) && /金毛/.test(imagePrompt), `${agentName}没有具体锁定人物和犬种`);
  assert.ok(/芥末黄|黄色/.test(imagePrompt) && /红色项圈/.test(imagePrompt), `${agentName}遗漏可核验的角色资产特征`);
  assert.ok(!/(同一个人|同一位主人|同一只狗)/.test(imagePrompt), `${agentName}仍使用模糊资产标签`);
  const coverage = semanticCoverage(imagePrompt);
  assert.ok(Object.values(coverage).every(Boolean), `${agentName}没有完整视觉化焦虑、等待与重逢三段语义：${JSON.stringify(coverage)}`);
  assert.ok(videoPrompt.length <= 3500, `${agentName}视频Prompt超过3500字`);
  assert.ok(videoPrompt.includes("人物身份：画面中的人物均为明确成年角色"), `${agentName}视频Prompt缺少成年身份读取协议`);
  const videoFrameBlocks = extractVideoFrames(videoPrompt);
  assert.equal(videoFrameBlocks.length, imageFrames.size, `${agentName}视频Prompt逐格结构无法稳定识别`);
  const framesWithPeople = videoFrameBlocks.filter((frame) => /(女性|人物|主人)/u.test(frame.content));
  assert.ok(framesWithPeople.length > 0, `${agentName}视频Prompt遗漏人物表演`);
  assert.ok(framesWithPeople.every((frame) => /明确成年的27岁中国女性/u.test(frame.content)), `${agentName}有人物出现的镜头没有逐格保留具体成年年龄`);
  assert.ok(/非写实电影级3D动画/u.test(videoPrompt) && /不得转成真人实拍/u.test(videoPrompt), `${agentName}视频Prompt缺少3D风格防漂移锁定`);
  assert.ok(/全屏/.test(videoPrompt), `${agentName}视频Prompt没有要求正常全屏`);
  assert.ok(/不显示|不得显示/.test(videoPrompt), `${agentName}视频Prompt没有排除故事板网格`);
  assert.ok(videoPrompt.includes("声音与口型：角色不说话，不做说话式连续口型；只保留自然动作声和环境声；无对白、旁白、歌词、口播字幕和背景音乐。"), `${agentName}视频Prompt缺少固定声音与口型边界`);

  results.push({
    id: agent.id,
    name: agent.name,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    styleOptionCount: styleField.options.length,
    imagePromptLength: imagePrompt.length,
    videoPromptLength: videoPrompt.length,
    semanticCoverage: coverage,
    frameCount: imageFrames.size,
    content,
    imagePrompt,
    videoPrompt,
  });
  await mkdir(".tmp-e2e", { recursive: true });
  await writeFile(`.tmp-e2e/storyboard-agent-suite-${suiteVersion}-partial.json`, JSON.stringify({ submittedMessage, agents: results }, null, 2), "utf8");
}

const normalizedPrompts = results.map((item) => item.imagePrompt.replace(/\s+/g, " "));
if (!filter) assert.equal(new Set(normalizedPrompts).size, 3, "三张导演卡输出完全相同，没有形成导演策略差异");

const report = {
  passed: true,
  testedAt: new Date().toISOString(),
  submittedMessage,
  agents: results,
};
await mkdir(".tmp-e2e", { recursive: true });
await writeFile(`.tmp-e2e/storyboard-agent-suite-${suiteVersion}.json`, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  passed: true,
  agents: results.map(({ id, name, elapsedSeconds, styleOptionCount, imagePromptLength, videoPromptLength }) => ({
    id,
    name,
    elapsedSeconds,
    styleOptionCount,
    imagePromptLength,
    videoPromptLength,
  })),
}, null, 2));
