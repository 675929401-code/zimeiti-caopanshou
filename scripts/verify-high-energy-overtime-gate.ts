import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID,
  STORY_DIRECTOR_MOVIE_AGENT_ID,
  countNarrationEffectiveCharacters,
  evaluateStoryDirectorOvertimeGate,
} from "../src/lib/story-director-overtime-gate";
import { countEffectiveNarrationCharacters } from "../src/lib/storyboard-duration-contract";

async function main(): Promise<void> {
  let assertions = 0;
  const highEnergy = (input: string) => evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, input);
  const expectAccepted = (input: string, description: string) => {
    assert.equal(highEnergy(input), null, description);
    assertions += 1;
  };
  const expectOvertime = (input: string, number: number, effectiveCharacters: number, limit: number) => {
    const originalInput = input;
    const gate = highEnergy(input);
    assert.ok(gate, `第${number}段应触发容量门禁`);
    assert.equal(gate.code, "STORY_DIRECTOR_NARRATION_OVERTIME");
    assert.deepEqual(gate.segments, [{ number, effectiveCharacters, limit }]);
    assert.match(gate.message, /保持原文逐字不变.*重新分段/u);
    assert.match(gate.message, /不得删字、改写或截断/u);
    assert.match(gate.message, new RegExp(`返回效率工具选择${gate.durationSeconds}秒`, "u"));
    assert.doesNotMatch(gate.message, /压缩|```|生图\s*Prompt|视频\s*Prompt/u);
    assert.equal(input, originalInput, "门禁不得更改用户原文");
    assertions += 8;
    return gate;
  };

  for (const [duration, limit] of [[8, 48], [10, 60], [15, 90]] as const) {
    for (const field of [`分段时长：${duration}秒版（保留接收卡选项）`, `target_duration_seconds: ${duration}`]) {
      expectAccepted(`分段文案：\n1.【${"字".repeat(limit)}】\n${field}`, `${duration}秒精确上限${limit}字应通过`);
      const gate = expectOvertime(`分段文案：\n1.【${"字".repeat(limit + 1)}】\n${field}`, 1, limit + 1, limit);
      assert.equal(gate.durationSeconds, duration);
      assertions += 1;
    }
  }

  const mixed = "狗狗 A-1，向前2步。English & １２，!? 😸";
  assert.equal(countNarrationEffectiveCharacters(mixed), 9, "仅汉字与数字计入口播容量");
  assert.equal(countNarrationEffectiveCharacters(mixed), countEffectiveNarrationCharacters(mixed), "必须使用统一计数口径");
  assertions += 2;
  expectAccepted(`1. 【${"字".repeat(48 - 9)}${mixed}】\n分段时长：8秒版`, "英文、标点、空格和emoji不增加汉字容量");
  expectOvertime(`1. 【${"字".repeat(49 - 9)}${mixed}】\n分段时长：8秒版`, 1, 49, 48);

  for (const prefix of ["1.【", "1. 【", "1\\. 【", "1、【", "1.["]) {
    const closingBracket = prefix.endsWith("[") ? "]" : "】";
    expectOvertime(`${prefix}${"字".repeat(49)}${closingBracket}\n分段时长：8秒版`, 1, 49, 48);
  }
  expectOvertime(`7\\. ${"字".repeat(49)}\n分段时长：8秒版`, 7, 49, 48);
  expectOvertime(`2. ${"字".repeat(24)}\n${"字".repeat(25)}\n分段时长：8秒版`, 2, 49, 48);
  expectOvertime(`2. 【${"字".repeat(24)}\n${"字".repeat(25)}】\n分段时长：8秒版`, 2, 49, 48);

  const metadata = [
    "视频比例：16:9",
    "主人性别：女性",
    "狗狗品种：金毛",
    "动画风格：高能商业动画",
    "故事板形态：纯画面版",
    "特殊备注：",
    `2. ${"字".repeat(150)}`,
  ].join("\n");
  expectAccepted(`分段时长：8秒版\n分段文案：\n1. ${"字".repeat(48)}\n${metadata}`, "后续元数据及备注中的编号不是原文正文");
  expectAccepted(`target_duration_seconds: 8\nsegmented_script：\n1\\. ${"字".repeat(48)}\nspecial_notes:\n2. ${"字".repeat(150)}`, "机器字段与备注示例需保持边界");
  expectAccepted(`1.【${"字".repeat(48)}】\n无需追加这段说明文字\n分段时长：8秒版`, "括号已封闭的原文不吸收后续说明");

  const multiple = highEnergy(`分段时长：8秒版\n7. ${"字".repeat(50)}\n2\\. 【${"字".repeat(49)}】\n3. ${"字".repeat(48)}\n特殊备注：不允许修改任何原文`);
  assert.ok(multiple);
  assert.deepEqual(multiple.segments, [
    { number: 2, effectiveCharacters: 49, limit: 48 },
    { number: 7, effectiveCharacters: 50, limit: 48 },
  ], "只报告超长段，保留原编号并排序");
  assertions += 2;

  expectAccepted(`1.【${"字".repeat(150)}】`, "缺少时长时不擅自推断");
  expectAccepted(`分段时长：8秒版\n${"字".repeat(150)}`, "未编号输入维持既有交互边界");
  assert.equal(evaluateStoryDirectorOvertimeGate("another-agent", `1.【${"字".repeat(150)}】\n分段时长：8秒版`), null);
  assert.equal(evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, null), null);
  assertions += 2;

  const movie = evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_MOVIE_AGENT_ID, `1.【${"字".repeat(61)}】\n分段时长：10秒版`);
  assert.ok(movie);
  assert.deepEqual(movie.segments, [{ number: 1, effectiveCharacters: 61, limit: 60 }]);
  assert.equal(movie.message, "生成门禁：口播超时，请保持原文逐字不变后重新分段，不得删字、改写或截断\n- 第1段：61个有效字 / 上限60字 / 请返回效率工具选择10秒，保持原文逐字不变，重新分段至每段不超过60个有效字");
  assert.equal(evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_MOVIE_AGENT_ID, `1.【${"字".repeat(60)}】\n分段时长：10秒版`), null);
  assert.equal(evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_MOVIE_AGENT_ID, `1. ${"字".repeat(61)}\n分段时长：10秒版`), null, "电影版既有解析行为保持不变");
  assert.equal(evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_MOVIE_AGENT_ID, `1\\. 【${"字".repeat(61)}】\n分段时长：10秒版`), null, "扩展编号兼容仅作用于高能版");
  assertions += 6;

  const route = await readFile(resolve("src/app/api/llm/route.ts"), "utf8");
  const callIndex = route.indexOf("evaluateStoryDirectorOvertimeGate(agentId, lastGuardText)");
  const memberIndex = route.indexOf("// ── 读取智能体级配置 ──");
  const providerIndex = route.indexOf("llmProviderCallStarted = true");
  assert.ok(callIndex > 0 && callIndex < memberIndex && callIndex < providerIndex, "容量门禁必须位于供应商调用之前");
  assertions += 1;

  console.log(JSON.stringify({
    passed: true,
    assertions,
    highEnergyAgentId: STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID,
    limits: { 8: 48, 10: 60, 15: 90 },
    preservesOriginalNarration: true,
    legacyMovieParsingPreserved: true,
    bothDirectorsPreserveOriginalNarration: true,
    metadataExcluded: true,
    modelRequests: 0,
    billingWrites: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
