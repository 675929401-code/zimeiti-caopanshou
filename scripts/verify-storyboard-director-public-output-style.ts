import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { publicStoryboardDirectorOutputStyle } from "../src/lib/storyboard-director-public-output-style";
import { resolveStoryboardHandoffContract } from "../src/lib/agent-workbench-handoff";
import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID } from "../src/lib/story-director-overtime-gate";

const id = STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID;
const good = { production_contract_version: "storyboard_director_contract.v2", production_contract_activated_at: "2020-01-01T00:00:00Z",
  performance_contract: "storyboard_performance.v1", performance_contract_activated_at: "2026-10-23T14:00:00Z" };
const messages = [{ id: "user", role: "user", timestamp: Date.parse("2026-10-23T15:00:00Z") }, { id: "assistant", role: "assistant" }];
let checks = 0;
const privateStyle = { ...good, system_prompt: "PRIVATE_SENTINEL", hidden_assets: ["PRIVATE_SENTINEL"], api_key: "PRIVATE_SENTINEL", director_mode: "high_energy" };
assert.deepEqual(publicStoryboardDirectorOutputStyle(id, privateStyle), good); checks++;
assert.equal(JSON.stringify(publicStoryboardDirectorOutputStyle(id, privateStyle)).includes("PRIVATE_SENTINEL"), false); checks++;
assert.equal(resolveStoryboardHandoffContract(messages, "assistant", publicStoryboardDirectorOutputStyle(id, privateStyle)).requirePerformancePlan, true); checks++;
for (const other of ["other-agent", undefined]) { assert.equal(publicStoryboardDirectorOutputStyle(other, privateStyle), undefined); checks++; }
assert.deepEqual(publicStoryboardDirectorOutputStyle("agent-1786633444187-594spj", privateStyle), good); checks++;
assert.equal(publicStoryboardDirectorOutputStyle("agent-1786633444187-594spj", { schema_version: "old-cinematic.v4.3.2" }), undefined); checks++;
for (const absent of [undefined, null]) { assert.equal(publicStoryboardDirectorOutputStyle(id, absent), undefined); checks++; }
assert.deepEqual(publicStoryboardDirectorOutputStyle(id, {}), {}); checks++;
for (const field of Object.keys(good)) {
  for (const invalid of ["PRIVATE_SENTINEL", "", 7, false, null, { secret: "PRIVATE_SENTINEL" }, ["PRIVATE_SENTINEL"]]) {
    const result = publicStoryboardDirectorOutputStyle(id, { ...good, [field]: invalid });
    assert.equal(result?.[field], "invalid");
    assert.ok(resolveStoryboardHandoffContract(messages, "assistant", result).error);
    assert.equal(JSON.stringify(result).includes("PRIVATE_SENTINEL"), false); checks++;
  }
}
for (const malformed of [false, "PRIVATE_SENTINEL", [], 3]) {
  const result = publicStoryboardDirectorOutputStyle(id, malformed); assert.equal(result?.performance_contract, "invalid");
  assert.ok(resolveStoryboardHandoffContract(messages, "assistant", result).error); checks++;
}
const missingActivation = { ...good } as Partial<typeof good>; delete missingActivation.performance_contract_activated_at;
assert.ok(resolveStoryboardHandoffContract(messages, "assistant", publicStoryboardDirectorOutputStyle(id, missingActivation)).error); checks++;
assert.deepEqual(privateStyle, { ...good, system_prompt: "PRIVATE_SENTINEL", hidden_assets: ["PRIVATE_SENTINEL"], api_key: "PRIVATE_SENTINEL", director_mode: "high_energy" }); checks++;
const report = { passed: true, checks, networkRequests: 0, databaseWrites: 0, scope: "official director public contract scalars only; legacy cinematic stays unchanged and malformed declarations remain fail-closed" };
const output = ".codex-evidence/director-refinement-20261023/energy-followup";
mkdirSync(output, { recursive: true }); writeFileSync(`${output}/public-output-style-result.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
