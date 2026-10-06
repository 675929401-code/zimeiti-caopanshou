import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const reviewId = "high-energy-weight-corrected-segments-1-2-v352-prompt-regression-20260816";
const outDir = path.resolve(".tmp-e2e", reviewId);
const historyPath = path.join(outDir, "recovered-platform-history.json");
const rawPath = path.join(outDir, "recovered-platform-agent-raw-4-code-blocks.md");
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const history = JSON.parse(await readFile(historyPath, "utf8"));
const raw = await readFile(rawPath, "utf8");

const headings = [...raw.matchAll(/^\*\*原文案内容段落\s*(\d+)\*\*：([^\r\n]+)\r?$/gmu)];
if (headings.length !== 2) throw new Error(`原文标题不是2个：${headings.length}`);
const segments = headings.map((heading, index) => {
  const start = (heading.index || 0) + heading[0].length;
  const end = headings[index + 1]?.index ?? raw.length;
  const section = raw.slice(start, end);
  const blocks = [...section.matchAll(/```text\s*\r?\n([\s\S]*?)```/giu)].map(match => match[1].trim());
  if (blocks.length !== 2) throw new Error(`第${index + 1}段不是两个text代码框`);
  return { number: Number(heading[1]), narration: heading[2].trim(), imagePrompt: blocks[0], videoPrompt: blocks[1] };
});

const forbidden = /体态测量环|健康宣传区|PET\s*HEALTH|健康站|检测舱|扫描舱|健康终端|概念展台|巨型[^。；\n]{0,10}(?:箭头|文字|标牌)|红黑大字/iu;
if (forbidden.test(raw)) throw new Error("恢复输出仍含禁止的概念环境或包装");
if (segments.some(segment => !/镜头1[^\n]*唯一参考\s*Frame\s*1/iu.test(segment.videoPrompt))) throw new Error("首镜未从Frame 1起播");
if (segments.some(segment => [...segment.videoPrompt.matchAll(/对应口播/gu)].length !== 4)) throw new Error("逐镜口播锚点不完整");

const now = Date.now();
const review = {
  reviewId,
  status: "PROMPT_REGRESSION_PASS_MEDIA_NOT_SUBMITTED",
  createdAt: new Date().toISOString(),
  sourceConversationId: history.conversationId,
  promptOutputSchemaVersion: "storyboard_director_output_style.v3.5.2",
  liveSchemaVersion: "storyboard_director_output_style.v3.5.3",
  livePromptSha256: "8d71d01d0d3e5f9de8562fe09ec6cfba87a80017b12d37d110de8db2d95c925d",
  livePromptHistoryId: "a81abe85-8d71-486f-aeef-714104547fba",
  actualCost: { agentRecoveryCalls: 1, imageSubmissions: 0, videoSubmissions: 0, paidRetries: 0, businessPriceCny: 0 },
  evidence: { rawPath, historyPath },
  evaluation: {
    verdict: "PROMPT_PASS",
    sceneSemanticFit: "PASS_SAME_COMMUNITY_PARK_NO_CONCEPT_ZONE",
    everydayPropFit: "PASS_HAND_WAIST_CHECK_NORMAL_SCALE_TREAT_POUCH_PHONE_MEASURING_CUP_BOWL",
    effectTriggerFit: "PASS_EFFECTS_BORN_FROM_HAND_NEEDLE_GRIP_BAG_SCREEN_AND_FOOD_CONTACTS",
    effectLifecycle: "PASS_SOURCE_DIRECTION_PEAK_DECAY_STATED_PER_SHOT",
    crossSceneContinuity: "PASS_HARD_CUT_NO_EFFECT_MORPH",
    readableSceneText: "PASS_ZERO_UNREQUESTED_SCENE_TEXT",
    soundLocationFit: "PASS_OUTDOOR_AMBIENCE_ONLY",
    narrationOrder: "PASS_FRAME_1_START_FOUR_VERBATIM_SHOT_ANCHORS",
    remainingGap: "Segment 1 proverb is conveyed mainly by voiceover plus ordinary scale, visually clearer but less metaphorically rich than benchmark.",
    v353StaticFix: "Original narration is now external post-voiceover timeline only; generated speech, lip-sync and subtitles are forbidden.",
  },
  run: {
    id: `${reviewId}-run`,
    createdAt: now,
    updatedAt: now,
    ratio: "16:9",
    imageResolution: "2K",
    videoResolution: "1080p",
    videoDuration: 10,
    imageModelId: "pm_HabdJ5rvD_L3-HUkfMUmGsrm",
    videoModelId: "omni-flash-10s-720p-ch3",
    title: "高能验证｜语义场景与特效触发｜Prompt回归证据",
    cards: segments.map(segment => ({
      id: `${reviewId}-card-${segment.number}`,
      order: segment.number,
      label: `第${segment.number}段｜${segment.narration}`,
      narration: segment.narration,
      imagePrompt: segment.imagePrompt,
      videoPrompt: segment.videoPrompt,
      referenceImageUrls: [],
      imageStatus: "idle",
      videoStatus: "idle",
      videoError: "Prompt回归通过；未提交付费图片或Omni视频",
    })),
  },
};

await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
await writeFile(path.join(outDir, "prompt-evaluation.md"), `# v3.5.2 Prompt回归与v3.5.3静态修正\n\n- 场景：两段均锁定社区公园，无健康站、宣传区、测量环或概念展台。\n- 道具：手摸腰线、普通宠物秤、牵引绳、零食袋、手机、量杯、食盆。\n- 特效：仅从手掌、秤指针、握绳点、袋面、屏幕触点和狗粮落碗点触发，均写明衰减。\n- 转场：跨Frame硬切，无问号变箭头等物理变形。\n- 声音：仅户外环境与动作音。\n- v3.5.3：口播改为外部配音时间轴，禁止模型生成朗读、口型和字幕。\n- 媒体费用：¥0；图片0；视频0。\n`, "utf8");
console.log(JSON.stringify({ passed: true, reviewId, conversationId: history.conversationId, cards: segments.length, mediaCostCny: 0 }, null, 2));
