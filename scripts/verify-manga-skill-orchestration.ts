import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  MANJU_SKILL_OUTPUT_ARTIFACT_TYPE,
  MANJU_SKILL_OUTPUT_SCHEMA_VERSION,
  parseManjuSkillOutput,
} from "../src/lib/manju-skill-output-protocol";
import {
  findYoucaiSkillRuntime,
  resolveYoucaiSkillRuntimeInvocation,
  YOUCAI_SKILL_RUNTIME,
} from "../src/lib/youcai-skill-runtime";

async function main() {
const root = process.cwd();
const orchestrator = await readFile(
  resolve(root, "src/lib/server/manga-skill-orchestrator.ts"),
  "utf8",
);
const route = await readFile(resolve(root, "src/app/api/llm/route.ts"), "utf8");
const prompt = await readFile(resolve(root, "src/lib/manga-creative-agent-prompt.ts"), "utf8");
const instructions = await readFile(resolve(root, "src/lib/youcai-skill-instructions.ts"), "utf8");

assert.equal(YOUCAI_SKILL_RUNTIME.length, 36, "runtime must cover all 36 public Skill entries");
assert.equal(resolveYoucaiSkillRuntimeInvocation("/script-brief 宠物无对白短剧").state, "resolved");
assert.equal(resolveYoucaiSkillRuntimeInvocation("/definitely-unknown test").state, "unknown_explicit_command");
assert.equal(resolveYoucaiSkillRuntimeInvocation("请把这个故事改成视频提示词").state, "resolved");
assert.equal(resolveYoucaiSkillRuntimeInvocation("你好").state, "no_match");
assert.ok(findYoucaiSkillRuntime("skill-assistant"), "fallback Skill must exist");

assert.match(orchestrator, /selected_skill_hint is[\s\S]*ignored|selected_skill_hint[\s\S]*ignored/iu);
assert.match(orchestrator, /resolveYoucaiSkillRuntimeInvocation\(request\)/u);
assert.match(orchestrator, /buildYoucaiSkillServerInstructionBlock/u);
assert.match(orchestrator, /MANJU_SKILL_OUTPUT_JSON_SCHEMA/u);
assert.match(orchestrator, /UNKNOWN_SKILL_COMMAND/u);
assert.match(orchestrator, /主站模型目录、价格预览、幂等任务、计费、资产归档链路/u);
assert.match(orchestrator, /用户显式确认/u);
assert.doesNotMatch(orchestrator, /executeSkillFunction|fetch\(\s*['"]https?:\/\//u);

assert.match(route, /resolveMangaSkillOrchestration\(messages as ChatMessage\[\]\)/u);
assert.match(route, /mangaSkillOrchestration\?\.systemPrompt/u);
assert.match(route, /agentId === MANGA_WORKBENCH_AGENT_ID/u);
assert.match(route, /UNKNOWN_SKILL_COMMAND|resolution\.code/u);
assert.match(route, /isVirtualAgent \? undefined : \(agentId \|\| undefined\)/u);

assert.match(prompt, /authority="client_hint_only"/u);
assert.match(prompt, /authoritative="false"/u);
assert.match(prompt, /服务端必须重新解析/u);
assert.match(instructions, /buildYoucaiSkillServerInstructionBlock/u);
assert.match(instructions, /YOUCAI_SKILL_INSTRUCTIONS/u);

const valid = parseManjuSkillOutput({
  schema_version: MANJU_SKILL_OUTPUT_SCHEMA_VERSION,
  artifact_type: MANJU_SKILL_OUTPUT_ARTIFACT_TYPE,
  skill: {
    id: "official:script-brief",
    command: "/script-brief",
    version: "1.0.0",
    selection: "explicit",
    provenance: "oss_public_source",
  },
  status: "tool_proposed",
  result: { kind: "structured_json", payload: { brief: "example", genreDetected: "pet", tips: [] } },
  tool_proposals: [{
    type: "generate_video",
    reason: "用户下一步可选择生成",
    input: { prompt: "example" },
    requires_authorization: true,
  }],
  quality: { passed: true, score: 95, hard_constraints_satisfied: ["无对白"], issues: [] },
});
assert.ok(valid, "valid structured Skill output must parse");
assert.equal(parseManjuSkillOutput({
  ...valid,
  tool_proposals: [{
    type: "generate_video",
    reason: "unsafe direct execution",
    input: {},
    requires_authorization: false,
  }],
}), null, "paid media proposal without authorization must be rejected");

console.log(JSON.stringify({
  ok: true,
  checks: 28,
  runtimeCount: YOUCAI_SKILL_RUNTIME.length,
  directPaidExecution: false,
  serverAuthoritativeRouting: true,
  structuredOutputProtocol: MANJU_SKILL_OUTPUT_SCHEMA_VERSION,
}, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
