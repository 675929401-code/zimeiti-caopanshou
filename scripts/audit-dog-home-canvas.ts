import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DOG_HOME_SCRIPT } from "../src/lib/canvas-demo-scripts";

const BASE_URL = process.env.CANVAS_BASE_URL || "http://127.0.0.1:5000";
const STYLE = "电影级3D卡通半写实动画，欧美家庭动画电影质感；人物与动物保持清晰统一的三维卡通角色设计，动物具有真实蓬松毛发和可信材质，人物采用自然且适度卡通化的比例；眼神、面部表情和身体动作生动并具有剧情性；使用温暖明亮且协调的色彩、柔和体积光、轮廓光、浅景深和轻微辉光，场景道具丰富并具有前中后景层次，兼顾精致可爱、电影构图与商业动画渲染质感；不生成字幕，不做说话口型。";

type Segment = {
  order: number;
  narration: string;
  durationSeconds: number;
  visualShotCount: number;
};

type Shot = {
  order: number;
  semanticOrder: number;
  visualOrder: number;
  durationSeconds: number;
  visualBeat: string;
  imagePrompt: string;
  videoPrompt: string;
  soundPrompt: string;
  referenceMode: string;
};

type CompileResult = {
  compiler: "ai" | "deterministic-fallback";
  preset: { name: string; version: number };
  semanticSegments: Segment[];
  shots: Shot[];
};

function compact(text: string) {
  return text.replace(/\s+/g, "");
}

function effectiveChars(text: string) {
  return text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").length;
}

function pass(label: string, ok: boolean, detail: string) {
  return { label, ok, detail };
}

async function main() {
const response = await fetch(`${BASE_URL}/api/canvas/compile-script`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    script: DOG_HOME_SCRIPT,
    presetId: "anime_story",
    style: STYLE,
    ratio: "16:9",
    referenceMode: "single",
    keyframeStrategy: "visual-anchor",
    effectsLevel: "light",
    productionMode: "anime-story",
    assistantInstruction: "",
  }),
});

if (!response.ok) {
  throw new Error(`Canvas compile failed: ${response.status} ${await response.text()}`);
}

const result = await response.json() as CompileResult;
const segments = result.semanticSegments;
const shots = result.shots;
const narration = segments.map((segment) => segment.narration).join("");
const totalSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
const expectedSeconds = effectiveChars(DOG_HOME_SCRIPT) / 6;
const shotDurationBySegment = new Map<number, number>();
for (const shot of shots) {
  shotDurationBySegment.set(shot.semanticOrder, (shotDurationBySegment.get(shot.semanticOrder) || 0) + shot.durationSeconds);
}

const checks = [
  pass("原文连续覆盖", compact(narration) === compact(DOG_HOME_SCRIPT), `原文${DOG_HOME_SCRIPT.length}字，回填${narration.length}字`),
  pass("每秒6字时长", Math.abs(totalSeconds - expectedSeconds) <= Math.max(3, segments.length * 0.5), `有效字${effectiveChars(DOG_HOME_SCRIPT)}，理论${expectedSeconds.toFixed(1)}秒，实际${totalSeconds}秒`),
  pass("语义段时长范围", segments.every((segment) => segment.durationSeconds >= 2 && segment.durationSeconds <= 8), `${segments.length}个口播段`),
  pass("视觉时长闭合", segments.every((segment) => Math.abs((shotDurationBySegment.get(segment.order) || 0) - segment.durationSeconds) <= 0.5), "每段视觉镜头时长之和应等于对应旁白时长"),
  pass("单镜时长范围", shots.every((shot) => shot.durationSeconds >= 1 && shot.durationSeconds <= 4), `${shots.length}个视觉镜头`),
  pass("一镜一图一视频", shots.every((shot) => Boolean(shot.imagePrompt && shot.videoPrompt)), "每个视觉镜头均有独立生图与视频提示词"),
  pass("镜头编号唯一", new Set(shots.map((shot) => shot.order)).size === shots.length, "镜头序号无重复"),
  pass("风格贯穿提示词", shots.every((shot) => shot.imagePrompt.includes("电影级3D卡通半写实动画") && shot.videoPrompt.includes("电影级3D卡通半写实动画")), "生图和视频提示词均携带所选动画风格"),
  pass("参考图绑定", shots.every((shot) => shot.videoPrompt.includes("@参考图1") && shot.referenceMode === "single"), "视频从同镜头上游单张参考图开演"),
  pass("旁白与口型分离", shots.every((shot) => shot.videoPrompt.includes("不生成字幕") && shot.videoPrompt.includes("说话口型")), "旁白后期统一添加，主体不说话"),
  pass("声音标记完整", shots.every((shot) => shot.soundPrompt.trim().length >= 10), "每镜保留环境声与动作音效标记"),
];

const sourceIssues = [
  "“人说”疑似漏字，建议核对是否为“有人说”。",
  "“半块发酸的圣饼”疑似识别错误，建议核对是否为“剩饼”。",
  "“早就把眼。封存的防御机制”存在断句或漏词，必须在生成前人工修订。",
  "文案中“他/它/他们”指代混用，建议统一宠物指代，避免模型误判角色数量。",
];

const outputDir = resolve(".tmp-e2e");
await mkdir(outputDir, { recursive: true });
const jsonPath = resolve(outputDir, "dog-home-canvas-audit-20260809.json");
const markdownPath = resolve(outputDir, "dog-home-canvas-audit-20260809.md");
const payload = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  compiler: result.compiler,
  preset: `${result.preset.name} v${result.preset.version}`,
  source: {
    characters: DOG_HOME_SCRIPT.length,
    effectiveCharacters: effectiveChars(DOG_HOME_SCRIPT),
    expectedSecondsAtSixCharsPerSecond: Number(expectedSeconds.toFixed(1)),
  },
  result: { semanticSegments: segments.length, visualShots: shots.length, totalSeconds },
  checks,
  sourceIssues,
  segments: segments.map((segment) => ({
    ...segment,
    visualDurationSeconds: shotDurationBySegment.get(segment.order) || 0,
    shots: shots.filter((shot) => shot.semanticOrder === segment.order).map((shot) => ({
      order: shot.order,
      visualOrder: shot.visualOrder,
      durationSeconds: shot.durationSeconds,
      visualBeat: shot.visualBeat,
      imagePrompt: shot.imagePrompt,
      videoPrompt: shot.videoPrompt,
      soundPrompt: shot.soundPrompt,
    })),
  })),
};

await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await writeFile(markdownPath, [
  "# 楼房养狗观点分镜演示质检记录",
  "",
  `- 编排器：${result.compiler}`,
  `- 提示词方案：${result.preset.name} v${result.preset.version}`,
  `- 原文：${effectiveChars(DOG_HOME_SCRIPT)}个有效字，按每秒6字约${expectedSeconds.toFixed(1)}秒`,
  `- 结果：${segments.length}个口播段，${shots.length}个视觉镜头，时间线${totalSeconds}秒`,
  "- 费用边界：本次质检只调用分镜编排接口，没有调用图片或视频生成接口",
  "",
  "## 自动检查",
  "",
  ...checks.map((check) => `- ${check.ok ? "通过" : "失败"}｜${check.label}：${check.detail}`),
  "",
  "## 原文纠错记录",
  "",
  ...sourceIssues.map((issue) => `- ${issue}`),
  "",
  "## 分段与镜头",
  "",
  ...payload.segments.flatMap((segment) => [
    `### 口播段${segment.order}（${segment.durationSeconds}秒 / ${segment.visualShotCount}镜）`,
    "",
    segment.narration,
    "",
    ...segment.shots.flatMap((shot) => [
      `- 镜头${String(shot.order).padStart(2, "0")}｜视觉${shot.visualOrder}｜${shot.durationSeconds}秒｜${shot.visualBeat}`,
      `  - 生图：${shot.imagePrompt}`,
      `  - 视频：${shot.videoPrompt}`,
      `  - 声音：${shot.soundPrompt}`,
    ]),
    "",
  ]),
].join("\n"), "utf8");

console.log(JSON.stringify({
  compiler: result.compiler,
  semanticSegments: segments.length,
  visualShots: shots.length,
  totalSeconds,
  expectedSeconds: Number(expectedSeconds.toFixed(1)),
  passed: checks.filter((check) => check.ok).length,
  failed: checks.filter((check) => !check.ok).map((check) => check.label),
  jsonPath,
  markdownPath,
}, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
