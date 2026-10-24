import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "../运行日志/三视觉资产十秒闭环-20261019/benchmark-research-20261020");
const candidateDir = resolve(root, "prompt-candidates-v2");
const evidenceDir = resolve(root, "prompt-activation-v4");
const readbackPath = resolve(root, "ab-test-r1/prompt-runtime-readback.json");
const expected = {
  "agent-1786633444187-594spj": { revision: 35, mode: "narrative", file: "narrative-prompt-merged-v4.txt", sha256: "5ddbdcb50e90c3b982cc9161e41c4e39da20800b8244373543f7c0e4bd55d023" },
  "agent-1786843330392-emdjv2": { revision: 38, mode: "high_energy", file: "high-energy-prompt-merged-v4.txt", sha256: "f74f924b6c44da62b560dedf1cdfad04c398bed8a23e71b70ad7101c0ecf35b9" },
};
const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");
const readback = JSON.parse(await readFile(readbackPath, "utf8"));
assert.equal(readback.verdict?.twoAgentsPresent, true, "TWO_AGENTS_MISSING");
assert.equal(readback.verdict?.bothActive, true, "AGENTS_NOT_ACTIVE");
const rows = (readback.agents || []).filter((row) => expected[row.id]);
assert.equal(rows.length, 2, "V4_AGENT_READBACK_COUNT_MISMATCH");
for (const row of rows) {
  const target = expected[row.id];
  const prompt = await readFile(resolve(candidateDir, target.file), "utf8");
  assert.equal(sha256(prompt), target.sha256, `${row.id}:CANDIDATE_SHA_MISMATCH`);
  assert.equal(Number(row.configRevision), target.revision, `${row.id}:REVISION_MISMATCH`);
  assert.equal(row.promptSha256, target.sha256, `${row.id}:RUNTIME_PROMPT_SHA_MISMATCH`);
  assert.equal(row.directorMode, target.mode, `${row.id}:DIRECTOR_MODE_MISMATCH`);
  assert.equal(row.environmentAnchorPolicy, "deferred_until_scene_need", `${row.id}:ENVIRONMENT_POLICY_MISMATCH`);
  assert.equal(row.qualityGate, "qualityScore>=90 and qualityVerdict=pass before media; external_computed_checks_required", `${row.id}:QUALITY_GATE_MISMATCH`);
}
const report = { schemaVersion: "storyboard_prompt_activation_v4_readback.v1", generatedAt: new Date().toISOString(), source: "prompt-runtime-readback.json", runtime: readback.runtimeVersion?.body || null, providerCalls: 0, paidGenerationRequests: 0, agents: rows.map((row) => ({ id: row.id, name: row.name, configRevision: row.configRevision, promptSha256: row.promptSha256, promptLength: row.promptLength, model: row.model, modelId: row.modelId, directorMode: row.directorMode, environmentAnchorPolicy: row.environmentAnchorPolicy, onScreenTextPolicy: row.onScreenTextPolicy, visualAssetPolicy: row.visualAssetPolicy, qualityGate: row.qualityGate })), passed: true };
await mkdir(evidenceDir, { recursive: true });
await writeFile(resolve(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
