import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = "high-energy-weight-corrected-segments-1-2-v353-fullchain-pro2k-omni10-20260816";
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const reportPath = path.join(outDir, "full-chain-visual-evaluation.md");
const review = JSON.parse(await readFile(reviewPath, "utf8"));
const videoState = JSON.parse(await readFile(path.join(outDir, "video-gate-state.json"), "utf8"));

const evaluation = {
  finalStatus: "FAIL",
  chainVerdict: "PASS",
  promptVerdict: "PASS_WITH_RISKS",
  imageVerdict: "CONDITIONAL_PASS",
  videoVerdict: "FAIL",
  benchmarkAlignmentVerdict: "FAIL_NOT_YET_ALIGNED",
  scoreMethod: "Retrospective 100-point rubric; hard failures override averages.",
  improvement: {
    baselineVersion: "v3.5.1 plus prior Omni actual-media run",
    currentVersion: "v3.5.3",
    overallBaselineScore: 53,
    overallCurrentScore: 71,
    absolutePointGain: 18,
    relativeImprovementPercent: 34,
    dimensions: [
      { dimension: "Prompt semantic and scene logic", baseline: 55, current: 82, delta: 27 },
      { dimension: "Reference image quality", baseline: 50, current: 74, delta: 24 },
      { dimension: "Video semantic order", baseline: 42, current: 85, delta: 43 },
      { dimension: "Video entity and interface stability", baseline: 68, current: 57, delta: -11 },
      { dimension: "Benchmark excitement and packaging polish", baseline: 55, current: 68, delta: 13 },
    ],
  },
  narrationTiming: {
    segment1: { rawCharacters: 65, effectiveChineseCharacters: 56, secondsAtSixCharsPerSecond: 9.33, verdict: "FITS_10S_AT_FAST_NATURAL_RATE" },
    segment2: { rawCharacters: 79, effectiveChineseCharactersIncludingBridge: 69, bridgeCharacters: 11, uniqueEffectiveCharacters: 58, secondsAtSixCharsPerSecondUnique: 9.67, verdict: "FITS_ONLY_IF_BRIDGE_IS_CONTEXT_NOT_REPEATED_VOICE" },
    literalVoiceSync: "NOT_TESTED_NO_EXTERNAL_NARRATION_AUDIO_SUBMITTED",
    visualTimelineSync: "PASS_WITH_HARD_VISUAL_FAILURES",
  },
  prompts: [
    {
      segment: 1,
      score: 80,
      strengths: ["Four shots start from Frame 1 and follow question, answer, proverb, then walking tension.", "Effects have named sources, peaks, decay, and location-matched sound."],
      risks: ["The old family photo is a weak and duplication-prone carrier for the proverb.", "Over-shoulder framing conflicts with the one-person asset lock and can duplicate the protagonist."],
    },
    {
      segment: 2,
      score: 84,
      strengths: ["The story remains on one community path and advances through accusation, hurt, fat-pet taste, and waist check.", "No health station, scanner ring, concept stage, giant labels, or dog-to-pig morph."],
      risks: ["The final overweight-is-not-healthy conclusion is inferred through a waist check, not shown as a strong consequence or comparison.", "Bridge text is not marked as context-only, so exact voice timing remains ambiguous."],
    },
  ],
  images: [
    {
      segment: 1,
      score: 70,
      verdict: "CONDITIONAL_PASS",
      strengths: ["Clean 2K four-panel image, consistent owner clothing and corgi identity, no anatomy hard failure.", "Home observation to outdoor walk is a readable real-life chain; English Frame lines are accurate."],
      issues: ["The old-man photo weakens one-second comprehension of the proverb.", "Action peaks and body force are much lower than the benchmark; effects are small and restrained."],
    },
    {
      segment: 2,
      score: 78,
      verdict: "CONDITIONAL_PASS",
      strengths: ["Accusation, emotional recoil, phone taste signal, and waist check are visually ordered and coherent.", "Expression quality, lighting, material clarity, and camera variation are strong; no random environment or text clutter."],
      issues: ["The final panel does not make the harm of overweight explicit enough.", "The pink heart and green waist line are polished but less physically forceful than benchmark packaging."],
    },
  ],
  videos: [
    {
      segment: 1,
      taskId: "a1d064f0db354386b1be119f27130824",
      semanticScore: 82,
      technicalScore: 48,
      verdict: "FAIL",
      timeline: [
        "0.00-0.40s: full 2x2 storyboard grid and Frame strips leak into the video.",
        "0.85-4.69s: waist comparison and rib check occur in the correct early narration order.",
        "5.32-6.61s: proverb beat appears, but a second old photo and an unexplained hand duplicate the prop.",
        "7.25-10.00s: walking tension arrives at the correct final beat, but a second yellow-hoodie woman appears in the foreground at the cut.",
      ],
      hardFailures: ["storyboard_grid_leak", "duplicated_photo_and_hand", "duplicated_protagonist"],
    },
    {
      segment: 2,
      taskId: "60d1cdf44f4b497fb38f1aac90a99b97",
      semanticScore: 88,
      technicalScore: 66,
      verdict: "FAIL",
      timeline: [
        "0.22-2.21s: passerby accusation and owner freeze are on the correct opening beat, but a second yellow-hoodie shoulder appears in the foreground.",
        "0.88s: orange impact ring bursts around the owner's wrist instead of traveling from the pointing finger toward the chest.",
        "2.85-4.15s: owner folds inward while the corgi watches; emotional cause and reaction are clear.",
        "4.79-7.38s: bench and phone-heart sequence matches the fat-pet taste narration.",
        "8.02-10.00s: phone is placed down and the green waist trace appears, matching the final health judgment but understating overweight harm.",
      ],
      hardFailures: ["duplicated_protagonist_foreground"],
    },
  ],
  benchmarkComparison: {
    aligned: [
      "Commercial stylized 3D character design, bright material response, clean owner and corgi readability.",
      "Clear four-beat progression and varied overhead, low, close, and wide camera choices.",
      "Segment 2 reaches benchmark-like emotional readability without using giant explanatory text."],
    behind: [
      "Benchmark action peaks have stronger anticipation, force, recoil, dust, fur, and environment feedback.",
      "Benchmark videos maintain one protagonist through emotional continuity; both current videos briefly duplicate the yellow-hoodie owner.",
      "Current packaging relies on clean glow lines and rings, but has less physical contact and less visual climax.",
      "The direct multi-panel image-to-video interface remains unreliable because the complete storyboard can become the first video frame."],
    betterThanBenchmark: [
      "Less giant text, fewer concept signs, and cleaner scene realism.",
      "No dog inflation, pig morph, scanner cabin, or repeated health-zone template."],
  },
  rootCauses: [
    "A multi-panel storyboard is being sent as a single image-to-video source; prompt negatives cannot reliably prevent initial grid leakage.",
    "The phrase 'over-shoulder' requires a foreground shoulder while the asset lock allows only one woman, so the model clones the yellow-hoodie protagonist.",
    "The proverb carrier introduces a photo inside a frame and invites the model to duplicate the same item as a foreground prop.",
    "The effect ledger is structurally present, but spatial source ownership is still ambiguous when several hands and leash contact points share the frame.",
    "Removing generic packaging reduced clutter, but the replacement action choreography is not yet strong enough to match benchmark energy."],
  nextFixesWithoutPaidRetry: [
    "For one-human scenes, forbid over-shoulder framing; use a clean side angle, dog-height POV, or a non-human foreground object.",
    "Do not use nested photos or screens as a proverb carrier unless the inner asset is essential; continue the real waist-check action instead.",
    "Crop or extract the selected Frame before Omni submission, while retaining the full storyboard only as review evidence.",
    "Use one primary physical action peak per shot and one effect born at its exact contact point; raise energy through force and camera, not more floating graphics.",
    "Pass overlap-prefix metadata separately so bridge text guides continuity without being treated as repeated narration."],
  evidence: {
    segment1ContactSheet: path.join(outDir, "video-analysis", "segment-1-contact-sheet.png"),
    segment2ContactSheet: path.join(outDir, "video-analysis", "segment-2-contact-sheet.png"),
    platformRawPrompts: path.join(outDir, "platform-agent-raw-4-code-blocks.md"),
    platformHistory: path.join(outDir, "platform-history.json"),
    workbenchHistory: path.join(outDir, "workbench-history.json"),
    videoGateState: path.join(outDir, "video-gate-state.json"),
  },
};

review.status = "evaluated-chain-pass-image-conditional-video-fail";
review.visualEvaluation = evaluation;
review.run.cards = review.run.cards.map((card, index) => ({
  ...card,
  videoStatusDetail: index === 0
    ? "FAIL｜叙事顺序正确，但泄露四格、复制照片/手和黄衣主人"
    : "FAIL｜叙事顺序正确，但开场复制黄衣主人且冲击环来源偏移",
}));
await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

const report = `# v3.5.3 双分段全链路验收

## 总结

- 综合提升：53 -> 71，约 +18 分（相对提升约34%）。
- 链路：PASS。
- Prompt：PASS WITH RISKS。
- 参考图：CONDITIONAL PASS。
- 视频：FAIL。
- 对标对齐：FAIL，尚未完全对齐。

语义顺序提升最明显：旧视频常跳过开场，当前两条都按四个语义节点向前演。技术稳定性反而退步：第1条泄露完整故事板并复制照片、手和主人；第2条开场也复制了黄衣主人。

## 分段1

图片70分。胖瘦疑问、摸肋骨、俗语、外出紧张顺序清楚，2K清晰度与材质很好；但旧照片不是“千金难买老来瘦”的强载体，动作峰值低于对标。

视频语义82分、技术48分。0.00-0.40秒泄露2x2故事板；5.32秒出现两张相同老人照片与多余手；7.25秒出现两个黄衣女人。硬失败覆盖语义平均分。

## 分段2

图片78分。路人质疑、主人受伤、手机胖宠审美、摸腰线完整且自然；结尾“太胖不等于养得好”仍偏含蓄。

视频语义88分、技术66分。四个语义节点和10秒顺序基本匹配；但0.22秒多出一个黄衣前景人物，0.88秒冲击环从主人手腕爆发而不是由指向动作传到胸口。

## 根因

1. 完整多格图直接作为图生视频输入，Omni有概率把网格当首帧。
2. “过肩”与“唯一女人”互相冲突，模型用复制主人补出前景肩膀。
3. 老照片形成画中画，增加道具和手部复制概率。
4. 特效账本写清了生命周期，但多只手同框时接触点归属仍不够唯一。
5. 去掉乱包装后，物理动作和相机爆发没有同步补足，精彩度仍低于对标。

## 费用与路由

- GPT-Image-2 · 渠道A pro，2K，2张，¥0.40。
- Omni Flash · 10秒 · 最高1080P · 渠道C，2条，¥1.10。
- 合计业务价：¥1.50；图片2次、视频2次；付费重试0次。
`;
await writeFile(reportPath, report, "utf8");

console.log(JSON.stringify({
  passed: true,
  finalStatus: evaluation.finalStatus,
  reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
  reportPath,
  improvement: evaluation.improvement,
}, null, 2));
