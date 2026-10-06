import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const reviewId = "high-energy-weight-corrected-segments-1-2-v351-image-gate-pro2k-20260816";
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const reportPath = path.resolve(".tmp-e2e", reviewId, "visual-evaluation.md");
const review = JSON.parse(await readFile(reviewPath, "utf8"));

review.status = "VISUAL_FAIL_VIDEO_LOCKED_NO_AUTOMATIC_RETRY";
review.visualEvaluation = {
  verdict: "FAIL",
  videoGate: "LOCKED",
  summary: "口播顺序和四格信息增益明显改善，但两处环境/道具越权会继续污染图生视频，暂不提交Omni。",
  cards: [
    {
      segmentNumber: 1,
      verdict: "CONDITIONAL_FAIL",
      strengths: [
        "Frame 1至4按设问、瘦点好、老来瘦、遛狗评价预兆推进",
        "角色服装、柯基毛色和四格镜头变化基本一致",
        "视频Prompt四镜均绑定单一Frame和逐字口播锚点",
      ],
      gaps: [
        "圆形体态测量环不是一秒可懂的日常道具，容易在视频中产生穿模和错误物理",
        "第一格玄关、后三格社区的跳转虽然可硬切，但原文没有要求先回家测量",
        "金色硬币加老人标牌表达俗语偏机械，低于对标的自然场景化包装",
      ],
    },
    {
      segmentNumber: 2,
      verdict: "FAIL",
      strengths: [
        "评价冲击、被误解为舍不得喂、胖宠审美、过胖不健康的因果顺序正确",
        "人物和狗表情受力明确，红箭头、粉色爱心和绿色健康色功能清楚",
        "视频Prompt没有从中段起播，也没有合并故事板面板",
      ],
      gaps: [
        "Frame 4擅自新增大型PET HEALTH ZONE和设备化宣传区，环境超出原文并产生巨型英文文字",
        "红色巨型食盆、绿色体态装置把生活叙事推成概念展台，偏离对标的自然场景化表演",
        "视频Prompt末尾把户外宣传区写成室内环境声，声音与画面地点冲突",
      ],
    },
  ],
  requiredPromptCorrections: [
    "默认沿用当前真实场景，不为抽象结论新建健康站、宣传区、检测舱或概念展台",
    "禁止发明测量环等非日常机械道具，优先俯视腰线、侧面腹线、手摸肋骨或普通体重秤",
    "场景文字默认零个，除非原文明确要求且文字是叙事必要资产",
    "声音环境必须逐镜复核并与镜头地点一致",
  ],
};
review.actualCost.videoSubmissions = 0;
review.actualCost.videoBusinessPriceCny = 0;
review.actualCost.paidRetries = 0;

await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
await writeFile(reportPath, `# 修正分段1-2图片门禁结论\n\n- 结论：FAIL，Omni 10秒视频继续锁定。\n- 图片：2张成功，2560x1440。\n- 图片业务价：¥0.40；视频提交：0；付费重试：0。\n- 主要问题：发明体态测量环、擅自新增PET HEALTH ZONE与巨型英文场景字、户外镜头误写室内环境声。\n- 通过项：逐句口播顺序、Frame 1起播、四镜唯一Frame绑定、角色/犬种/服装连续。\n`, "utf8");

console.log(JSON.stringify({ passed: true, reviewId, verdict: review.visualEvaluation.verdict, videoGate: review.visualEvaluation.videoGate }, null, 2));
