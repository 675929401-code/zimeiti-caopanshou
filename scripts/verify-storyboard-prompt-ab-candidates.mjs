import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("prompts/storyboard-director-ab-manifest.json", "utf8"));
assert.equal(manifest.status, "candidate_only");
assert.equal(manifest.runtimeBinding, null);
assert.deepEqual(manifest.outputContract.chatOrder, ["storyboardImagePrompt", "videoPrompt"]);
assert.equal(manifest.outputContract.videoImageInput, "one_complete_storyboard_image");
assert.ok(manifest.comparisonBaseline, "A/B 缺少明确比较基线");
for (const candidate of manifest.candidates) {
  assert.equal(candidate.parent, manifest.comparisonBaseline, `${candidate.id} 必须继承同一个 A/B 父版本基线`);
}

const checks = [
  ["原文案内容段落", "段落标题"],
  ["故事板分镜图文生图 Prompt", "生图输出标题"],
  ["图生视频 Prompt", "视频输出标题"],
  ["完整四宫格或五宫格故事板图", "完整故事板单图视频边界"],
  ["不裁切", "禁止裁切"],
  ["不拆格", "禁止拆格"],
  ["只用于先生成", "资产只进入生图阶段"],
  ["严格", "角色或服装连续"],
];

const results = [];
for (const candidate of manifest.candidates) {
  const source = await readFile(candidate.path, "utf8");
  const outputSection = source.slice(Math.max(0, source.lastIndexOf("输出格式")));
  const imageHeading = outputSection.search(/故事板分镜图文生图 Prompt/iu);
  const videoHeading = outputSection.search(/图生视频 Prompt/iu);
  assert.ok(imageHeading >= 0, `${candidate.id} 缺少生图输出标题`);
  assert.ok(videoHeading > imageHeading, `${candidate.id} 输出顺序必须先生图后视频`);
  for (const [token, label] of checks) assert.ok(source.includes(token), `${candidate.id} 缺少${label}：${token}`);
  assert.ok(/8秒|10秒|15秒/u.test(source), `${candidate.id} 缺少 8/10/15 秒时长规则`);
  assert.ok(/每秒(?:约)?5至6|每秒(?:约)?6|每秒5至6/u.test(source), `${candidate.id} 缺少字数/秒规则`);
  assert.ok(!/工作台只提交故事板第一格裁出的|第一格裁出的单画面/u.test(source), `${candidate.id} 仍含旧第一格裁切协议`);
  results.push({ id: candidate.id, path: candidate.path, characters: source.length, runtimeEligible: candidate.runtimeEligible });
}

console.log(JSON.stringify({ passed: true, status: manifest.status, candidates: results, goldenSetRequired: manifest.evaluation.goldenSetRequired }, null, 2));
