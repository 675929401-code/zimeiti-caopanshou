import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_ENGINEER_STATE_VERSION,
  AGENT_PROMPT_PACKAGE_VERSION,
  applyRequirementLedgerUpdate,
  emptyRequirementLedger,
  parseAgentEngineerState,
  parseAgentPromptPackage,
  type RequirementLedger,
} from "../src/lib/agent-engineer-protocol";
import {
  AGENT_PRESET_SCHEMA_VERSION,
  normalizeAgentPresetFields,
  toAgentPresetEnvelope,
} from "../src/lib/agent-preset-schema";

function item(id: string, text: string) {
  return { id, text, status: "active" as const };
}

const legacyFields = [
  { title: "目标用户", type: "input", placeholder: "例如新手创作者" },
  { label: "任务说明", type: "textarea", required: true },
];
const normalizedLegacy = normalizeAgentPresetFields(legacyFields);
assert.equal(normalizedLegacy.length, 2);
assert.ok(normalizedLegacy.every((field) => field.id.startsWith("field_")));

const reorderedLegacy = normalizeAgentPresetFields([...legacyFields].reverse());
assert.equal(
  normalizedLegacy.find((field) => field.label === "目标用户")?.id,
  reorderedLegacy.find((field) => field.label === "目标用户")?.id,
  "legacy IDs must not depend on display order",
);

const explicitId = normalizeAgentPresetFields([
  { id: "task_brief", label: "原标签", type: "textarea" },
])[0];
const renamedField = normalizeAgentPresetFields([
  { id: explicitId.id, label: "修改后的显示标签", type: "textarea" },
])[0];
assert.equal(renamedField.id, "task_brief", "editing a label must not regenerate the field ID");

const envelope = toAgentPresetEnvelope(normalizedLegacy);
assert.equal(envelope.schema_version, AGENT_PRESET_SCHEMA_VERSION);
assert.deepEqual(
  normalizeAgentPresetFields(envelope).map((field) => field.id),
  normalizedLegacy.map((field) => field.id),
);

let ledger: RequirementLedger = emptyRequirementLedger();
ledger = applyRequirementLedgerUpdate(ledger, {
  stable_requirements: [item("REQ-001", "支持自然聊天")],
  no_regression: [item("REG-001", "已确认要求不得丢失")],
});
for (let turn = 2; turn <= 12; turn += 1) {
  ledger = applyRequirementLedgerUpdate(ledger, {
    current_changes: [item(`CHG-${String(turn).padStart(3, "0")}`, `第 ${turn} 轮增量修改`)],
    resolved: turn % 3 === 0 ? [item(`DONE-${turn}`, `第 ${turn} 轮问题已解决`)] : [],
    pending: turn === 5 ? [item("PENDING-001", "等待用户确认名称")]: [],
    conflicts: turn === 8 ? [item("CONFLICT-001", "完整输出与仅增量输出冲突")]: [],
  });
}
assert.ok(ledger.stable_requirements.some((entry) => entry.id === "REQ-001"));
assert.ok(ledger.no_regression.some((entry) => entry.id === "REG-001"));
assert.equal(ledger.current_changes.length, 11, "turn deltas must accumulate without deleting earlier changes");

const markerResponse = `本轮只调整输入兼容规则。\n\n<!--agent_engineer_state:v1\n${JSON.stringify({
  schema_version: AGENT_ENGINEER_STATE_VERSION,
  mode: "delta",
  ledger,
  final_package: null,
})}\n-->`;
const parsedState = parseAgentEngineerState(markerResponse);
assert.equal(parsedState?.schema_version, AGENT_ENGINEER_STATE_VERSION);
assert.ok(parsedState?.ledger.stable_requirements.some((entry) => entry.id === "REQ-001"));

const finalPackageText = `\n\`\`\`json\n${JSON.stringify({
  schema_version: AGENT_PROMPT_PACKAGE_VERSION,
  artifact_type: "agent_prompt_package",
  agent: { id: "demo-agent", name: "演示智能体", version: "1.0.0" },
  change_summary: ["支持自然语言"],
  system_prompt: "你是演示智能体。",
  preset_fields: envelope,
  output_contract: { schema_version: "demo_output.v1", fields: [] },
  regression_cases: [{ id: "CASE-001" }],
  platform: { security_wrapper_required: true },
}, null, 2)}\n\`\`\``;
const parsedPackage = parseAgentPromptPackage(finalPackageText);
assert.equal(parsedPackage?.schema_version, AGENT_PROMPT_PACKAGE_VERSION);
assert.equal(parsedPackage?.preset_fields.length, 2);
assert.equal(parsedPackage?.platform.security_wrapper_required, true);

const promptPath = resolve(process.cwd(), "docs", "智能体工程师5.1-系统提示词.md");
const prompt = readFileSync(promptPath, "utf8");
assert.equal((prompt.match(/<module id="M\d{2}"/g) ?? []).length, 6, "5.1 must contain exactly six modules");
assert.ok(prompt.length < 10_000, "5.1 prompt must remain compact");
assert.ok(prompt.includes("agent_engineer_state:v1"));
assert.ok(!/^\s*:::text\s*$/m.test(prompt), "5.1 must not emit :::text blocks");

const migrationPath = resolve(process.cwd(), "scripts", "migrations", "20260814_agent_engineer_5_1.sql");
const migration = readFileSync(migrationPath, "utf8");
assert.ok(migration.includes("agent-1781690935600-gkt1xg"));
assert.ok(migration.includes("智能体工程师 5.1"));
assert.ok(migration.includes("agent_config_migration_backups"));

console.log(JSON.stringify({
  ok: true,
  checks: 18,
  simulated_turns: 12,
  prompt_characters: prompt.length,
  preset_schema_version: AGENT_PRESET_SCHEMA_VERSION,
  state_schema_version: AGENT_ENGINEER_STATE_VERSION,
  package_schema_version: AGENT_PROMPT_PACKAGE_VERSION,
}, null, 2));
