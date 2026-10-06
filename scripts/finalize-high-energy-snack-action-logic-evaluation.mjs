import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const reviewId = "high-energy-snack-action-logic-2segments-pro2k-20260816";
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const statePath = path.join(outDir, "acceptance-state.json");
const reportPath = path.join(outDir, "visual-evaluation.md");

const review = JSON.parse(await readFile(reviewPath, "utf8"));
const state = JSON.parse(await readFile(statePath, "utf8"));

const evaluation = {
  evaluatedAt: new Date().toISOString(),
  method: "2K source-image inspection plus 20-frame-per-video contact sheets and selected 960x540 frame inspection",
  mediaFacts: {
    segment2Video: { durationSeconds: 10, width: 1920, height: 1080, fps: 24, audio: "AAC 48kHz stereo", bitrateKbps: 8816 },
    segment4Video: { durationSeconds: 10, width: 1920, height: 1080, fps: 24, audio: "AAC 48kHz stereo", bitrateKbps: 7097 },
  },
  verdicts: {
    platformPromptChain: "PASS",
    paidMediaRoute: "PASS",
    imageReferenceLogic: "PASS",
    imageHighEnergyBenchmark: "FAIL",
    videoActionLogic: "FAIL",
    videoHighEnergyBenchmark: "FAIL",
    overall: "FAIL",
  },
  cards: [
    {
      sourceSegmentNumber: 2,
      imageVerdict: "REFERENCE PASS / HIGH-ENERGY BENCHMARK FAIL",
      imageStrengths: [
        "One bone-shaped treat reads immediately; toss trail, dog sprint, owner exit, single door close and final eating state form a legible five-panel chain.",
        "Yellow hoodie, blue jeans, white sneakers, tricolor corgi, green collar, anatomy and English Frame captions remain consistent.",
        "Door, treat and dog are materially clear at true 2560x1440.",
      ],
      imageIssues: [
        "The action staging is much calmer than the benchmark: limited body compression, limited facial exaggeration and only a small trail/dust effect budget.",
        "The dog and owner stay visually close to the doorway in the middle panels, leaving the movement axis ambiguous for downstream image-to-video.",
      ],
      videoVerdict: "FAIL",
      videoIssues: [
        "At approximately 4.5-6.0 seconds the corgi follows the owner across the threshold into the corridor, reversing the required inward run.",
        "The video then hard-cuts the corgi back inside beside the treat, so the owner-outside/dog-inside state is not reached through continuous physical causality.",
        "The door closes once and limbs stay intact, but that cannot rescue the broken spatial transition.",
        "Effects remain limited to the toss trail and small decorative glints; there is no strong contact-driven brake/landing/door-latch lifecycle comparable to the benchmark.",
      ],
    },
    {
      sourceSegmentNumber: 4,
      imageVerdict: "REFERENCE PASS / HIGH-ENERGY BENCHMARK FAIL",
      imageStrengths: [
        "Sunny, rainy/umbrella, evening/shopping-bag and new-morning states make the three independent cycles plus later fear readable.",
        "The costume, corgi identity, closed-door result, wary body language and English Frame captions are coherent.",
        "Warm-to-cool functional color supports the association without obscuring the actors.",
      ],
      imageIssues: [
        "Packaging is predominantly lighting; it lacks contact-point effects, a strong foreground reveal or a memorable semantic device at benchmark intensity.",
        "Five panels contain four temporal states, which is suitable for a human storyboard but too dense to serve as one image-to-video start frame.",
      ],
      videoVerdict: "FAIL",
      videoIssues: [
        "Only one departure cycle is shown; the required second cloudy cycle and third evening cycle disappear, so the learned association is not demonstrated.",
        "The single door morphs into two symmetrical closing leaves around 2.5 seconds, contradicting the fixed-door asset and creating impossible geometry.",
        "The final hand holds two overlapping bone treats instead of one, introducing a duplicated main prop despite stable human and canine anatomy.",
        "The dog's worried reaction is readable, but the missing repetition makes it feel unmotivated; effects and time-transition packaging are too weak for the high-energy benchmark.",
      ],
    },
  ],
  rootCauses: [
    "The full multi-panel storyboard is being used as one image-to-video reference even though it contains several incompatible spatial and temporal states; the model interpolates between panels instead of treating them as an edit plan.",
    "Segment 2 keeps the dog too near the threshold across panels, so text says inward while pixel evidence can be read as following the owner outward.",
    "Segment 4 asks one 10-second generation to realize three independent day cycles plus a fourth-morning reaction; the temporal load exceeds a stable single-generation action budget.",
    "The current prompt intentionally reduced decoration density too far, preserving polish but losing the benchmark's contact-driven effects, strong foregrounds and exaggerated force response.",
    "Negative-prompt forwarding is now fixed and both submissions used it, so the remaining door/prop errors are not explained by the former adapter omission.",
  ],
  requiredDirection: [
    "Do not add another long list of quality adjectives. Split video production by actual shot: crop or regenerate a clean 16:9 action-start frame for each 3-5 second clip, then edit clips into the 10-second segment.",
    "For rigid doorway causality, keep one interior camera axis: snack at least 1.5 meters inward, dog oriented away from the door, owner already across the threshold, one visible hinge and an empty sweep zone before the close starts.",
    "For repetition, use separate short clips for day 1/day 2/day 3 and the new-morning hesitation, or reduce the visible cycles and use an explicit edited day-jump montage; do not ask one image-to-video interpolation to invent all four states.",
    "Keep a moderate effect budget of one primary contact effect plus one residue per shot: treat landing ring and dust, paw brake streak, latch pulse, and a warm-to-cool day-jump wipe. Effects must follow physical contact and never replace causality.",
    "Add a media gate that blocks final acceptance when a dog crosses the threshold, a single door becomes double, a unique prop duplicates, or required repetition disappears, even if the API task completed successfully.",
  ],
};

review.status = "chain-pass-image-reference-pass-video-visual-fail";
review.visualEvaluation = evaluation;
review.run.cards = review.run.cards.map((card) => {
  const cardEvaluation = evaluation.cards.find((item) => item.sourceSegmentNumber === (card.order === 1 ? 2 : 4));
  return {
    ...card,
    videoStatusDetail: `真实生成完成；视觉验收 ${cardEvaluation?.videoVerdict || "FAIL"}。详见本存档 visualEvaluation。`,
  };
});
await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

const report = `# 高能验收A｜动作逻辑两段真实媒体复测

## 总结

- 链路：PASS。沿用平台会话 \`${review.conversationId}\` 的原始第2、4段双 Prompt；两张图和两条视频均真实完成。
- 图片参考逻辑：PASS。两张图都能讲清各自核心事件，服装、犬种、材质和 Frame 文本基本稳定。
- 图片高能对标：FAIL。包装、动作受力、强前景和接触点特效明显弱于三张对标图。
- 视频动作逻辑：FAIL。第2段狗跨门后被硬切回屋内；第4段缺失三次循环、单门变双门、唯一零食复制。
- 总结论：FAIL。不能把接口成功或参考图可用等同于成片达标。

## 第2段

图片可用：零食一秒可懂，五格顺序清楚，角色和犬种一致；但动作夸张和接触点特效偏弱。

视频失败：约4.5-6.0秒，狗跟随主人跨到走廊，随后硬切回室内吃零食。门最终虽只关闭一次，但关键空间因果已经断裂。

## 第4段

图片可用：晴天、雨伞、购物袋和新清晨形成换日证据，冷暖色表达关联建立；但高能包装不足。

视频失败：只演了一次离开，没有第二/第三日循环；门在约2.5秒变为对开的双门；末段手中出现两块重叠零食。狗的恐惧反应可读，但动机链不成立。

## 根因

当前工作台把一张含多个时空状态的一图多格直接作为单个图生视频参考。模型把各格当作可插值画面，而不是剪辑计划。第4段还把四个时间状态压进10秒单次生成，动作容量超载。继续堆质量词不能解决。

## 校正方向

1. 一图多格用于导演审阅；视频阶段按真实镜头裁切/重生单张16:9动作前势图，每条3-5秒，再装配为10秒。
2. 关门镜头固定室内机位、单门单铰链、零食离门至少1.5米、狗朝屋内、主人先跨过门槛、扫掠区清空后才关门。
3. 重复关联拆为独立日次素材或明确跳切，不让一个生成请求承担三次离开加一次新晨反应。
4. 每镜保留“一个主接触特效+一个余波”：零食落点尘环、犬爪刹车线、门锁冷色脉冲、换日冷暖擦变。特效服务动作，不覆盖逻辑。

## 费用与提交

- 图片：2次成功，¥0.40。
- 视频：2次成功，¥1.10。
- 总业务价：¥1.50。
- 付费重试：0次。
- 管理员测试账户现金扣款：¥0.00。
`;

await writeFile(reportPath, report, "utf8");
state.visualEvaluation = evaluation;
state.finalVerdict = evaluation.verdicts;
state.reportPath = reportPath;
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ reviewPath, reportPath, verdicts: evaluation.verdicts }, null, 2));
