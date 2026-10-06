import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const reviewId = "high-energy-weight-2segments-v350-image-gate-pro2k-20260816";
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const reportPath = path.resolve(".tmp-e2e", reviewId, "visual-evaluation.md");
const review = JSON.parse(await readFile(reviewPath, "utf8"));

const visualEvaluation = {
  verdict: "CONDITIONAL_PASS_AWAITING_USER_APPROVAL",
  videoGate: "LOCKED_NO_SUBMISSION",
  summary: "两张参考图的叙事选帧、环境连续、角色一致和关键语义达到进入视频前的图片门槛；高能包装与动作爆发仍略低于对标。",
  dimensions: {
    narrationTriggerAlignment: "PASS",
    mainPropOneSecondReadable: "PASS",
    characterAndCorgiConsistency: "PASS_WITH_MINOR_VARIATION",
    expressionAndBodyForce: "PASS",
    actionPeak: "PASS_WITH_GAP_TO_BENCHMARK",
    foregroundShotCameraVariation: "PASS",
    contactDrivenEffects: "PASS",
    functionColorAndMaterials: "PASS",
    panelSelection: "PASS_NO_DUPLICATE_MICROSTATES",
    englishFrameAccuracy: "PASS",
    anatomyIntegrity: "PASS_WITH_MINOR_RISK",
    benchmarkExcitement: "BELOW_BENCHMARK",
    packagingPolish: "PASS_WITH_GAP_TO_BENCHMARK",
  },
  cards: [
    {
      segmentNumber: 1,
      verdict: "CONDITIONAL_PASS",
      strengths: [
        "体重秤、动态遛狗、太瘦质疑、健康状态四格信息任务清楚且互不重复",
        "俯视、低机位、过肩和近景变化明确，人物服装与柯基毛色项圈一致",
        "太瘦气泡一秒可懂，英文Frame说明与画面一致",
      ],
      gaps: [
        "Frame 4偏静态证明镜头，动作峰值和对标的爆发力度不足",
        "特效以绿色轮廓和小型速度弧为主，毛发、尘浪和冲击反馈弱于对标",
        "不同格的人物脸部精细度有轻微变化，但未构成角色漂移",
      ],
    },
    {
      segmentNumber: 2,
      verdict: "PASS",
      strengths: [
        "手机胖审美、过量食盆与猪形秤、俯视腰线、侧面体态形成清楚递进",
        "没有把柯基变形成猪，隐喻保留为秤面平面图标，语义准确",
        "Frame 2动作和表情受力强，Frame 3俯视体态证据一秒可读",
      ],
      gaps: [
        "Frame 1和Frame 4整体能量低于对标高峰，包装更偏清楚而非炸裂",
        "Frame 2人物左臂与柯基接触区域遮挡较多，进入视频时应避免肢体穿插",
        "柯基在不同景别中的躯干厚度略有变化，视频应以Frame 3或4的健康腰线为体型基准",
      ],
    },
  ],
};

review.status = "images-conditionally-passed-awaiting-user-approval-video-locked";
review.visualEvaluation = visualEvaluation;
review.actualCost.videoSubmissions = 0;
review.actualCost.videoBusinessPriceCny = 0;
review.run.cards = review.run.cards.map((card) => ({
  ...card,
  videoStatus: "idle",
  videoError: "等待用户确认两张参考图后再进入视频阶段；当前视频提交次数为0",
}));
await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

const report = `# 高能验证｜狗胖瘦两段｜图片审核

- 结论：CONDITIONAL PASS，等待用户确认后再生成视频。
- 图片：2/2成功，均为2560×1440。
- 视频：0次提交，仍锁定。
- 费用：¥0.40，无付费重试。

## 第1段

四格分别承担体重秤、动态遛狗、太瘦质疑、健康状态，没有近重复镜头。角色、服装、柯基毛色和项圈一致，气泡和英文Frame准确。主要差距是第4格偏静态，动作峰值、毛发尘浪和冲击强度低于对标。

## 第2段

手机胖审美、过量食盆与猪形秤、俯视腰线、侧面体态递进清楚；猪只作为平面图标，没有把狗错误变形成猪。Frame 2和Frame 3最接近对标。风险是Frame 2手臂遮挡区域较复杂，视频阶段必须防穿插；不同景别的狗躯干厚度略有变化，应以Frame 3或4为体型基准。
`;
await writeFile(reportPath, report, "utf8");
console.log(JSON.stringify({ passed: true, reviewPath, reportPath, visualEvaluation }, null, 2));
