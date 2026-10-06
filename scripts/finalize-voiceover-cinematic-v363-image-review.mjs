import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const reviewId = "voiceover-cinematic-weight-two-segments-v363-prompt-gate-20260816";
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const outDir = path.resolve(".tmp-e2e", reviewId);
const review = JSON.parse(await readFile(reviewPath, "utf8"));

assert.equal(review.reviewId, reviewId);
assert.equal(review.run.cards.length, 2);
assert.ok(review.run.cards.every((card) => card.imageStatus === "done" && card.videoStatus === "idle"));

review.status = "IMAGE_GATE_CONDITIONAL_PASS_AWAITING_USER_APPROVAL_VIDEO_LOCKED";
review.manualImageReview = {
  reviewedAt: new Date().toISOString(),
  overallVerdict: "CONDITIONAL_PASS",
  newCinematicDirectionScore: 8.5,
  legacyHighEnergyBenchmarkScore: 7.4,
  comparison: "叙事、微表情、犬类自然表演和语义包装明显优于v3.5.3；爆发感低于旧高能对标，但符合用户要求的电影级口播新方向。",
  segment1: {
    score: 8.4,
    semanticCoverage: "设问与偏瘦判断 -> 轻快步态 -> 腰肋确认 -> 画外评价悬念，顺序完整。",
    strengths: ["Frame 1主道具与问答一秒可懂", "柯基眼神湿润且四足自然", "人物、服装、犬种和牵引绳连续", "英文Frame说明准确"],
    issues: ["Frame 1与Frame 3都以蹲下观察为主，动作任务略近", "整体电影感强，但动作峰值和景别冲击低于旧高能对标"],
  },
  segment2: {
    score: 8.6,
    semanticCoverage: "画外误解 -> 主人受伤与狗靠近 -> 圆胖审美爱心图标 -> 健康腰线与轻盈步态判断，口播对应清楚。",
    strengths: ["人物受伤微表情和狗抬爪/贴近关系自然", "圆胖轮廓是平面编辑层，没有实体化第二只宠物", "Frame 4回到真实健康运动，结论可读", "无文字贴纸、镜面、激光、扫描或能量环"],
    issues: ["Frame 3粉色轮廓描边略亮，接近霓虹感，应在视频中保持平面贴纸而非能量体", "过胖不健康通过对比表达，风险信息仍偏含蓄"],
  },
  sharedChecks: {
    narrationOrder: "PASS",
    primaryPropOneSecondReadable: "PASS",
    microexpressionAndBodyForce: "PASS",
    dogCutenessAndNaturalAnatomy: "PASS",
    shotAndCameraVariation: "CONDITIONAL_PASS",
    packagingSemanticFit: "PASS",
    noMagicEffects: "PASS_WITH_MINOR_LUMINOUS_OUTLINE_RISK",
    characterPetWardrobeConsistency: "PASS",
    englishFrameAccuracy: "PASS",
    benchmarkPolish: "CONDITIONAL_PASS",
  },
};
review.videoPromptReview = {
  verdict: "PROMPT_PASS_ACTUAL_VIDEO_NOT_GENERATED",
  shotCounts: [3, 3],
  checks: {
    verbatimChronologicalNarrationAnchors: "PASS",
    physicalActionContinuity: "PASS",
    microexpressionAndDogBehavior: "PASS",
    semanticPackagingTiming: "PASS",
    noGeneratedSpeechLipSyncSubtitlesOrMusic: "PASS",
    noMagicOrUnmotivatedEffects: "PASS",
    cleanFrameOneWorkbenchRouting: "PASS_CODE_AND_CROP_PREVIEW",
  },
  residualRisks: ["实际Omni视频仍可能把圆胖轮廓做得过亮", "第2段69个汉字/10秒，画面节奏可用但外部配音偏快"],
  releaseDecision: "AWAIT_USER_IMAGE_APPROVAL_BEFORE_VIDEO_SUBMISSION",
};
review.cropPreviewEvidence = [
  path.join(outDir, "segment-1-frame1-final-crop.png"),
  path.join(outDir, "segment-2-frame1-final-crop.png"),
];

await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  passed: true,
  status: review.status,
  reviewUrl: `http://127.0.0.1:5000/storyboard-workbench?review=${reviewId}`,
  imageVerdict: review.manualImageReview.overallVerdict,
  videoPromptVerdict: review.videoPromptReview.verdict,
  videoSubmissions: review.actualCost.videoSubmissions,
}, null, 2));
