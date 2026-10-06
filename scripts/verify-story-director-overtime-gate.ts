import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  STORY_DIRECTOR_MOVIE_AGENT_ID,
  countNarrationEffectiveCharacters,
  evaluateStoryDirectorOvertimeGate,
} from "../src/lib/story-director-overtime-gate";

type HistoricalAudit = {
  agents: Array<{
    mode: "movie" | "high_energy";
    latestConversation: { messages: Array<{ role: string; content: string }> };
  }>;
};

async function main(): Promise<void> {
  const audit = JSON.parse(await readFile(
    resolve(".codex-evidence/story-director-intake-template-20260928/latest-output-quality-audit.json"),
    "utf8",
  )) as HistoricalAudit;
  const movie = audit.agents.find((agent) => agent.mode === "movie");
  const input = movie?.latestConversation.messages.findLast((message) => message.role === "user")?.content;
  assert.ok(input, "电影版真实历史输入缺失");
  assert.equal(
    evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_MOVIE_AGENT_ID, input),
    null,
    "真实历史输入按汉字和数字计数并未超时，不得把标点误算为有效字",
  );
  const overtimeInput = input.split(/\r?\n/u).map((line) =>
    /^\s*\d{1,3}\s*[.、].*】\s*$/u.test(line)
      ? line.replace(/】\s*$/u, "这段补充文字用于验证确定性口播超时门禁必须在调用模型之前立即停止】")
      : line,
  ).join("\n");
  const gate = evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_MOVIE_AGENT_ID, overtimeInput);
  assert.ok(gate, "真实超时输入没有触发确定性门禁");
  assert.equal(gate.segments.length, 8, "真实超时输入没有列全8段");
  assert.equal(gate.message.split(/\r?\n/u)[0], "生成门禁：口播超时，请先压缩或重新分段");
  assert.doesNotMatch(gate.message, /```|故事板|生图\s*Prompt|视频\s*Prompt|导演草案/iu);
  for (let number = 1; number <= 8; number += 1) assert.match(gate.message, new RegExp(`第${number}段`, "u"));

  const valid = [
    "segmented_script：",
    "1.【狗狗抬头看向主人。】",
    "2.【主人侧身让出通道。】",
    "target_duration_seconds：10",
  ].join("\n");
  assert.equal(evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_MOVIE_AGENT_ID, valid), null);
  assert.equal(evaluateStoryDirectorOvertimeGate("another-agent", input), null);
  assert.equal(evaluateStoryDirectorOvertimeGate(STORY_DIRECTOR_MOVIE_AGENT_ID, "1.【超时但没有时长字段。】"), null);
  assert.equal(countNarrationEffectiveCharacters("狗狗 A-1，向前2步。"), 7);

  const route = await readFile(resolve("src/app/api/llm/route.ts"), "utf8");
  const callIndex = route.indexOf("evaluateStoryDirectorOvertimeGate(agentId, lastGuardText)");
  const memberIndex = route.indexOf("// ── 读取智能体级配置 ──");
  const providerIndex = route.indexOf("llmProviderCallStarted = true");
  assert.ok(callIndex > 0, "LLM路由没有调用确定性门禁");
  assert.ok(callIndex < memberIndex && callIndex < providerIndex, "门禁必须发生在模型配置和供应商请求之前");

  console.log(JSON.stringify({
    passed: true,
    agentId: STORY_DIRECTOR_MOVIE_AGENT_ID,
    historicalOvertimeSegments: gate.segments.length,
    historicalInputCorrectlyAccepted: true,
    responseFirstLine: gate.message.split(/\r?\n/u)[0],
    modelRequests: 0,
    billingWrites: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
