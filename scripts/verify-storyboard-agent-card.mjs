import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentName = "故事版导演｜4-5格连续故事板";
const originalCopy = "狗狗突然爱舔墙、啃土、钻花盆，可能不是嘴馋。主人刚想把它抱走，它却顶着满鼻子泥在客厅疯狂打转，吓得主人一路追。别只顾着笑，这些反常动作可能是在发出营养警报，先检查饮食和身体状况，千万不要盲目乱补。";
const submittedMessage = [
  `分段文案：1\\. 【${originalCopy}】`,
  "生图比例：16:9 横屏",
  "画面风格：高能皮克斯式3D动画喜剧",
  "角色设定：26岁中国女性，深棕高马尾，黄色连帽卫衣、蓝色牛仔裤、白色运动鞋；3岁三色短腿柯基，黑色背毛、暖橙脸颊与耳朵、白色口鼻和胸口、超大深棕眼睛，保持犬类四足身份。",
  "特殊要求：根据语义自行判断4格或5格；保留对标式白色英文视频执行条；人物和宠物不说话、不做说话式连续口型，但允许惊讶、恐慌和兴奋时张大嘴巴形成夸张静态表情。",
].join("\n");

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

const botsResponse = await fetch(`${baseUrl}/api/bots?storyboard_card_test=${Date.now()}`, {
  headers: { Authorization: `Bearer ${session.token}` },
});
const botsPayload = await botsResponse.json();
assert.ok(botsResponse.ok, botsPayload.error || "主站智能体列表读取失败");
const agent = botsPayload.bots?.find((item) => item.name === agentName);
assert.ok(agent, "主站没有找到故事版导演智能体卡片");
assert.equal(agent.preset_fields?.length, 5, "卡片接收模板不是5个字段");
assert.deepEqual(
  agent.preset_fields.map((field) => [field.label, field.type]),
  [
    ["分段文案", "textarea"],
    ["画面尺寸", "select"],
    ["动画风格", "select"],
    ["角色设定", "textarea"],
    ["特殊备注", "textarea"],
  ],
  "卡片输入控件与设计不一致",
);

const startedAt = Date.now();
const llmResponse = await fetch(`${baseUrl}/api/llm`, {
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
const llmPayload = await llmResponse.json();
assert.ok(llmResponse.ok, llmPayload.error || `智能体请求失败（${llmResponse.status}）`);

const content = extractAssistantContent(llmPayload);
assert.ok(content, "模型没有返回文本内容");
const codeBlocks = extractTextCodeBlocks(content);
const imagePrompt = codeBlocks[0] || "";
const videoPrompt = codeBlocks[1] || "";
const frameNumbers = [...imagePrompt.matchAll(/Frame\s*([1-5])/gi)].map((match) => Number(match[1]));
const uniqueFrames = [...new Set(frameNumbers)].sort((a, b) => a - b);
const expectedFrameCount = uniqueFrames.at(-1) || 0;
const shotScaleVocabulary = [
  ["广角/全景", /(全景|大全景|广角|超广角)/],
  ["中景", /(中景|中远景)/],
  ["近景", /(近景|中近景)/],
  ["特写", /(特写|极近特写|极近景)/],
];
const detectedShotScales = shotScaleVocabulary
  .filter(([, expression]) => expression.test(imagePrompt))
  .map(([label]) => label);
const frameInstructionWordCounts = [...imagePrompt.matchAll(/Frame\s*[1-5]\s*:\s*([^\n”"]+)/gi)]
  .map((match) => (match[1].match(/[A-Za-z0-9'-]+/g) || []).length);
const distinctPerformanceStates = [
  /好奇|上头|兴奋/,
  /心虚|被发现|慌张/,
  /恐慌|惊讶|震惊/,
  /错愕|严肃|凝视/,
  /专注|坚定|稳定/,
].filter((expression) => expression.test(imagePrompt)).length;

const checks = {
  mainSiteCardVisible: true,
  presetFieldCount: agent.preset_fields.length,
  codeBlockCount: codeBlocks.length,
  separateImageAndVideoBlocks: codeBlocks.length === 2,
  originalCopyPreserved: content.includes(originalCopy),
  adaptivePanelCount: expectedFrameCount === 4 || expectedFrameCount === 5,
  panelSequenceComplete:
    expectedFrameCount >= 4
    && uniqueFrames.join(",") === Array.from({ length: expectedFrameCount }, (_, index) => index + 1).join(","),
  imagePromptHasConcreteAssets: /中国女性/.test(imagePrompt) && /柯基/.test(imagePrompt),
  imagePromptHasSemanticPackaging: /(营养|警报|警告|卡片|盾牌|知识|教学窗|放大镜|巨大|发光|揭示)/.test(imagePrompt),
  imagePromptHasReadablePackaging:
    /(占画面|画面.{0,8}%|前景|中景|角色|柯基|主人)/.test(imagePrompt)
    && /(金黄|红橙|亮色|发光|高对比|清晰|醒目|缩略图|巨大)/.test(imagePrompt),
  imagePromptHasBenchmarkWhiteStrip:
    /(白色).{0,16}(制作说明条|制作条|说明条)/.test(imagePrompt)
    && /Frame\s*[1-5]\s*:/i.test(imagePrompt),
  imagePromptHasPerFrameVideoInstructions:
    /(Rapid tracking shot|Fast lateral pan|Fast push-in|Explosive push-in|Whip pan|Smash zoom|Rapid tilt up)/i.test(imagePrompt)
    && /(motion|lines|dust|sparks|reveal|burst|panic|zoom|pan|tracking)/i.test(imagePrompt),
  imagePromptHasShotScaleGradient: detectedShotScales.length >= 3,
  imagePromptHasSpatialDepth: /(前景|中景主体|背景|纵深|遮挡|透视)/.test(imagePrompt),
  imagePromptHasAnimationPerformance:
    /(动画电影|动画喜剧|挤压|拉伸|弹性|夸张|动作轮廓|超大.{0,4}眼|放大.{0,4}眼)/.test(imagePrompt)
    && /(耳朵|尾巴|重心|四肢|瞳孔|张.{0,2}嘴|嘴形)/.test(imagePrompt),
  imagePromptHasExaggeratedMouthExpression:
    /(张大嘴巴|嘴巴大张|嘴巴.{0,8}大幅张开|大幅张嘴|O形嘴|无声惊叫|惊恐张口|兴奋张口|咧开嘴)/.test(imagePrompt)
    && !/(全程|始终).{0,8}(嘴巴闭合|闭嘴)/.test(imagePrompt),
  imagePromptHasEmotionColorProgression: /(冷暖|轮廓光|体积光|逆光|功能色|色彩|光色)/.test(imagePrompt),
  imagePromptHasPeakMoments: /(峰值|急停|蹬地|腾空|撞|抓地|压低|后仰|扑|绷紧|定格)/.test(imagePrompt),
  imagePromptRejectsLiveActionLook: /(非真人实拍|非照片写实|非实拍|动画电影式造型|动画电影角色)/.test(imagePrompt),
  imagePromptHasActionSpectacle: /(追|冲|旋风|爆炸|尘云|灰尘|碎屑|飞散|残影|速度线|火花|电流|放射光)/.test(imagePrompt),
  imagePromptHasGiantKnowledgeReveal:
    /(巨大|占画面|20%|25%|30%|35%)/.test(imagePrompt)
    && /(知识|营养|警报|警告|卡片|盾牌|标牌|揭示)/.test(imagePrompt),
  imagePromptHasInFrameKnowledgeText: /[“\"]异食警报[”\"]|[“\"]先检查[”\"]/.test(imagePrompt),
  imagePromptHasKnowledgeStageTransition:
    /(知识舞台|黑金|高对比放射|放射背景|抽象空间|现实空间.{0,16}(取代|退去|消失)|背景.{0,12}(黑金|金橙|蓝白))/.test(imagePrompt),
  imagePromptHasVariedPerformanceStates: distinctPerformanceStates >= 3,
  imagePromptHasConciseFrameInstructions:
    frameInstructionWordCounts.length === expectedFrameCount
    && frameInstructionWordCounts.every((count) => count >= 18 && count <= 26),
  imagePromptIsNotSingleSceneSurveillance: /(户外|抽象|知识空间|诊室|医院|厨房|玄关|花盆|阳台|客厅)/.test(imagePrompt)
    && /(特写|全景|近景|极近|低机位|广角|倾斜|强透视)/.test(imagePrompt),
  videoPromptHasActionDirection: /(收拾|抓起|提起|换鞋|穿鞋|起身|跟随|冲|跑|退|抬头|转头|推近|横移|跟拍|震动|跳动)/.test(videoPrompt),
  videoPromptIsFullScreen: /(全屏|正常全画幅|正常全屏)/.test(videoPrompt),
  noVagueAssetLabels: !/(同一只狗|同一个人|同一位主人)/.test(imagePrompt),
  noJsonOutput: !/^\s*[\[{]/.test(content),
};

const report = {
  passed: Object.values(checks).every(Boolean),
  testedAt: new Date().toISOString(),
  elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  agent: {
    id: agent.id,
    name: agent.name,
    model: agent.model,
    model_id: agent.model_id,
  },
  submittedMessage,
  checks,
  output: {
    content,
    imagePrompt,
    videoPrompt,
    detectedFrameCount: expectedFrameCount,
    detectedShotScales,
    frameInstructionWordCounts,
    distinctPerformanceStates,
  },
};

await mkdir(".tmp-e2e", { recursive: true });
await writeFile(
  ".tmp-e2e/storyboard-agent-card-live.json",
  JSON.stringify(report, null, 2),
  "utf8",
);

console.log(JSON.stringify({
  passed: report.passed,
  elapsedSeconds: report.elapsedSeconds,
  checks,
  detectedFrameCount: expectedFrameCount,
  detectedShotScales,
  frameInstructionWordCounts,
  distinctPerformanceStates,
  contentLength: content.length,
  content,
}, null, 2));

if (!report.passed) process.exitCode = 1;
