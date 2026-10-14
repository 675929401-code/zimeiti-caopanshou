import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const manifestPath = "prompts/storyboard-director-ab-manifest.json";
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
assert.equal(manifest.status, "candidate_only");
assert.equal(manifest.runtimeBinding, null);
assert.equal(manifest.candidates.length, 2);
assert.ok(manifest.evaluation.goldenSetRequired >= 5);
await fs.access(".codex-backups/storyboard-visual-assets-20261015/original-runtime/SHA256MANIFEST.json");

const goldenCases = [
  {
    id: "short_8s_pet_health",
    duration: 8,
    narrationCharacters: 44,
    required: ["8秒", "3镜", "每秒5至6", "宠物", "不说话", "无字幕", "无音乐", "不裁切", "不拆格"],
  },
  {
    id: "time_jump_10s",
    duration: 10,
    narrationCharacters: 56,
    required: ["10秒", "时间", "硬切", "段后状态", "原文顺序"],
  },
  {
    id: "two_breeds_10s",
    duration: 10,
    narrationCharacters: 54,
    required: ["10秒", "犬种", "多只", "独立", "外观指纹", "不合并"],
  },
  {
    id: "wardrobe_lock_10s",
    duration: 10,
    narrationCharacters: 52,
    required: ["10秒", "服装", "严格锁定", "换装", "明确要求", "连续"],
  },
  {
    id: "overlong_negative_gate",
    duration: 15,
    narrationCharacters: 96,
    required: ["15秒", "超时", "重新分段", "不得截断", "不得改写", "生成门禁"],
  },
];

function evaluateCandidate(source) {
  const outputSection = source.slice(Math.max(0, source.lastIndexOf("输出格式")));
  const imageHeading = outputSection.indexOf("故事板分镜图文生图 Prompt");
  const videoHeading = outputSection.indexOf("图生视频 Prompt");
  const commonChecks = [
    ["image_before_video", imageHeading >= 0 && videoHeading > imageHeading],
    ["original_text_preserved", (source.includes("原字保留") || source.includes("逐字保留")) && source.includes("原文案内容段落")],
    ["asset_plan_before_storyboard", outputSection.indexOf("全局视觉资产计划") < imageHeading],
    ["full_board_single_image", source.includes("一张完整四宫格或五宫格故事板") || source.includes("完整四宫格或五宫格故事板单图")],
    ["no_crop_or_split", source.includes("不裁切") && source.includes("不拆格")],
    ["single_image_video_input", source.includes("唯一图片参考") || source.includes("唯一图片输入")],
    ["pet_nonverbal", source.includes("不说话") && source.includes("不做口型")],
    ["visual_assets_image_only", source.includes("只用于先生成视觉资产") || source.includes("只用于先生成分镜参考图")],
  ];
  const caseResults = goldenCases.map((testCase) => {
    const missing = testCase.required.filter((token) => !source.includes(token));
    const withinBudget = testCase.id === "overlong_negative_gate"
      ? testCase.narrationCharacters > testCase.duration * 6
      : testCase.narrationCharacters <= testCase.duration * 6;
    return {
      id: testCase.id,
      duration: testCase.duration,
      narrationCharacters: testCase.narrationCharacters,
      withinDeclaredBudget: withinBudget,
      missing,
      passed: missing.length === 0 && withinBudget,
    };
  });
  const passedChecks = commonChecks.filter(([, ok]) => ok).length + caseResults.filter((item) => item.passed).length;
  const totalChecks = commonChecks.length + caseResults.length;
  return {
    commonChecks: Object.fromEntries(commonChecks),
    cases: caseResults,
    passedChecks,
    totalChecks,
    score: Number((passedChecks / totalChecks).toFixed(3)),
    staticGatePassed: passedChecks === totalChecks,
  };
}

const candidates = [];
for (const candidate of manifest.candidates) {
  const source = await fs.readFile(candidate.path, "utf8");
  const evaluation = evaluateCandidate(source);
  candidates.push({
    id: candidate.id,
    path: candidate.path,
    parent: candidate.parent,
    runtimeEligible: candidate.runtimeEligible,
    ...evaluation,
  });
}

assert.ok(candidates.every((candidate) => candidate.staticGatePassed), JSON.stringify(candidates, null, 2));
assert.ok(candidates.every((candidate) => candidate.runtimeEligible === false));

const outputDir = path.resolve(".codex-evidence/storyboard-ab-golden-set");
await fs.mkdir(outputDir, { recursive: true });
const report = {
  schemaVersion: "storyboard_prompt_ab_golden_set.v1",
  status: "candidate_only",
  runtimeBinding: null,
  evaluatedAt: new Date().toISOString(),
  source: "static prompt contracts only; no model call, no provider request, no billing",
  goldenCases,
  candidates,
};
const reportPath = path.join(outputDir, "report.json");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  passed: true,
  status: report.status,
  goldenCases: goldenCases.length,
  candidates: candidates.map(({ id, score, passedChecks, totalChecks, runtimeEligible }) => ({ id, score, passedChecks, totalChecks, runtimeEligible })),
  report: reportPath,
}, null, 2));
