import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const sourceReviewId = "high-energy-weight-2segments-v350-image-gate-pro2k-20260816";
const reviewId = "high-energy-weight-2segments-actual-media-sync-review-20260816";
const sourceReviewPath = path.resolve("public", "storyboard-reviews", `${sourceReviewId}.json`);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const mediaDir = path.resolve(".tmp-e2e", sourceReviewId, "user-generated-videos");
const reportPath = path.resolve(".tmp-e2e", sourceReviewId, "actual-media-sync-evaluation.md");
await mkdir(path.dirname(reviewPath), { recursive: true });

const source = JSON.parse(await readFile(sourceReviewPath, "utf8"));
const sourceCards = source.run.cards;
const media = [
  {
    id: "segment-1-omni",
    sourceCard: sourceCards[0],
    label: "第1段｜Omni Flash 10秒｜实际成片",
    localName: "segment-1-omni-10s-1080p.mp4",
    publicName: `${reviewId}-segment-1-omni-10s.mp4`,
    modelId: "omni-flash-10s-720p-ch3",
    modelName: "Omni Flash · 10秒 · 最高1080P · 渠道C",
    taskId: "vt_1786859003918_1gs5nk",
    taskExternalId: "705ecbcc0a424f7392653f353792907e",
    duration: 10,
    cuts: [3.208, 7.0],
    verdict: "PARTIAL_PASS_VISUAL_LOGIC_FAIL_NARRATION_SYNC",
  },
  {
    id: "segment-2-omni",
    sourceCard: sourceCards[1],
    label: "第2段｜Omni Flash 10秒｜实际成片",
    localName: "segment-2-omni-10s-1080p.mp4",
    publicName: `${reviewId}-segment-2-omni-10s.mp4`,
    modelId: "omni-flash-10s-720p-ch3",
    modelName: "Omni Flash · 10秒 · 最高1080P · 渠道C",
    taskId: "vt_1786859004477_z3xyso",
    taskExternalId: "563f1e5ad3b7487187ecf5005f4ab6c4",
    duration: 10,
    cuts: [3.5, 7.083],
    verdict: "PARTIAL_PASS_VISUAL_LOGIC_FAIL_NARRATION_SYNC",
  },
  {
    id: "segment-1-veo",
    sourceCard: sourceCards[0],
    label: "第1段｜Veo 3.1 Fast 8秒｜实际成片",
    localName: "segment-1-veo-fast-8s-1080p.mp4",
    publicName: `${reviewId}-segment-1-veo-fast-8s.mp4`,
    modelId: "veo-3-1-fast-chC",
    modelName: "Veo 3.1 Fast · 8秒 · 图生视频 · 渠道C",
    taskId: "vt_1786859655982_ldps95",
    taskExternalId: "task_yRxGdloFZL7k6NYEMIfcd2guZ1DCXSZu",
    duration: 8,
    cuts: [2.667, 4.792],
    verdict: "FAIL_GRID_LEAK_PANEL_MERGE_TEXT_ERROR_AND_NARRATION_SYNC",
  },
];

for (const item of media) {
  await copyFile(path.join(mediaDir, item.localName), path.resolve("public", "storyboard-reviews", item.publicName));
}

const visualEvaluation = {
  overallVerdict: "FAIL",
  imageToNarration: "PASS_WITH_MINOR_GAPS",
  videoSpatialContinuity: "PASS_FOR_OMNI_FAIL_FOR_VEO",
  videoToNarration: "FAIL",
  actualNarrationDelivery: "NOT_SUBMITTED_TO_VIDEO_MODEL",
  images: [
    {
      segment: 1,
      verdict: "CONDITIONAL_PASS",
      findings: [
        "体重秤、遛狗、太瘦质疑和健康状态按口播顺序排列，四格无近重复",
        "千金难买老来瘦没有独立可见载体，但核心判断与社会误解仍可读",
        "Frame 4动作峰值和包装冲击低于对标",
      ],
    },
    {
      segment: 2,
      verdict: "PASS",
      findings: [
        "手机胖宠审美、过量食盆与猪形秤、俯视腰线、侧面体态按口播顺序递进",
        "猪只作为平面图标，没有狗猪变形",
        "Frame 2手臂遮挡和跨景别体型厚度存在轻微风险",
      ],
    },
  ],
  videos: [
    {
      taskId: media[0].taskId,
      verdict: media[0].verdict,
      findings: [
        "0.00-3.21秒连续遛狗，3.21-7.00秒太瘦质疑，7.00-10.00秒健康柯基近景；没有网格、重复角色或场景融合",
        "开场省略体重秤与胖瘦判断，画面无法承接口播前半的胖瘦问答和老来瘦",
        "结尾画面强调健康，但口播尾句在说舍不得喂和虐待，语义落点不一致",
      ],
    },
    {
      taskId: media[1].taskId,
      verdict: media[1].verdict,
      findings: [
        "0.00-3.50秒过量食盆与猪形秤，3.50-7.08秒俯视腰线，7.08-10.00秒侧面健康体态；硬切清楚且无面板融合",
        "手机胖宠审美Frame 1完全缺席，画面从口播中段的养猪和按斤开始，领先语音约3至4秒",
        "第一镜没有柯基，过量喂养与宠物对象的关系被削弱",
      ],
    },
    {
      taskId: media[2].taskId,
      verdict: media[2].verdict,
      findings: [
        "0秒直接显示整张四格故事板，违反不显示网格和说明条",
        "前2.67秒在多个面板间混合过渡，未执行唯一参考Frame的干净单镜逻辑",
        "太瘦气泡生成错误字符，8秒时长也与原10秒Prompt冲突",
      ],
    },
  ],
  rootCauses: [
    "高能导演把最接近关键转化的Frame 2设为视频起点，而不是按最早口播语义从Frame 1开始",
    "分镜工作台提交时再次追加‘把所有面板当作视觉素材、不按面板数强制切镜’，与唯一Frame和硬切规则冲突",
    "工作台请求体只发送视频Prompt和图片，没有发送分段原文或逐秒口播锚点，因此模型无法真实对齐语音",
    "第1段96字、第2段84字放入10秒分别需要约9.6和8.4字/秒，超过自然口播常用速度",
  ],
};

const now = Date.now();
const review = {
  reviewId,
  status: "actual-media-evaluated-overall-fail",
  createdAt: new Date().toISOString(),
  source: "real-user-generated-workbench-images-and-three-videos",
  conversationId: source.conversationId,
  agentId: source.agentId,
  schemaVersion: source.schemaVersion,
  promptSha256: source.promptSha256,
  visualEvaluation,
  actualMedia: {
    images: 2,
    videos: 3,
    models: [
      { id: "omni-flash-10s-720p-ch3", count: 2, businessPriceEachCny: 0.55 },
      { id: "veo-3-1-fast-chC", count: 1, businessPriceEachCny: 0.3 },
    ],
    totalVideoBusinessPriceCny: 1.4,
    taskPriceChargedCny: 0,
  },
  localArtifacts: media.map((item) => ({
    taskId: item.taskId,
    video: path.join(mediaDir, item.localName),
  })),
  run: {
    id: `${reviewId}-run`,
    createdAt: now,
    updatedAt: now,
    ratio: "16:9",
    imageResolution: "2K",
    videoResolution: "1080p",
    videoDuration: 10,
    imageModelId: source.run.imageModelId,
    videoModelId: "",
    title: "高能验证｜狗胖瘦两段｜实际图片与视频语义同步质检",
    cards: media.map((item, index) => ({
      id: `${reviewId}-card-${index + 1}`,
      order: index + 1,
      label: item.label,
      imagePrompt: item.sourceCard.imagePrompt,
      videoPrompt: item.sourceCard.videoPrompt,
      referenceImageUrls: [],
      imageStatus: "done",
      imageUrl: item.sourceCard.imageUrl,
      imageValidatedAt: now,
      imageModelIdUsed: source.run.imageModelId,
      imageModelNameUsed: item.sourceCard.imageModelNameUsed,
      videoStatus: "done",
      videoUrl: `/storyboard-reviews/${item.publicName}`,
      videoTaskId: item.taskId,
      videoTaskModelId: item.modelId,
      videoProgress: 100,
      videoLastCheckedAt: now,
      videoStatusDetail: `${item.modelName}｜${item.verdict}`,
    })),
  },
};
await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

const report = `# 高能验证｜实际图片与视频语义同步质检

## 总结

- 图片对分段语义：PASS WITH MINOR GAPS
- Omni空间与动作连续：PASS
- Veo空间与动作连续：FAIL
- 三条视频对分段口播：FAIL
- 实际口播输入：未发送到视频模型

## 第1段 Omni 10秒

0.00-3.21秒遛狗，3.21-7.00秒“太瘦？”质疑，7.00-10.00秒健康柯基。镜头逻辑清楚，但遗漏开头胖瘦判断与“老来瘦”，结尾健康画面和“舍不得喂、虐待”不在同一语义落点。

## 第2段 Omni 10秒

0.00-3.50秒过量食盆与猪形秤，3.50-7.08秒俯视腰线，7.08-10.00秒侧面体态。视频跳过手机胖宠审美，直接从中段开始；第一镜还没有柯基。

## 第1段 Veo 8秒

开头泄露四格网格，多个面板发生混合过渡，气泡文字错误；时长也从原Prompt的10秒变成8秒。FAIL。

## 根因

1. 导演选择关键转化格而非最早口播格作为视频起点。
2. 工作台在提交时追加与唯一Frame规则冲突的旧适配文案。
3. 请求体没有发送分段原文或逐秒口播锚点。
4. 96字和84字放入10秒，口播速度本身过快。
`;
await writeFile(reportPath, report, "utf8");
console.log(JSON.stringify({
  passed: true,
  reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
  reviewPath,
  reportPath,
  overallVerdict: visualEvaluation.overallVerdict,
}, null, 2));
