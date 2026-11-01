import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "../运行日志/三视觉资产十秒闭环-20261019/benchmark-research-20261020");
const candidateDir = resolve(root, "prompt-candidates-v2");
const evidenceDir = resolve(root, "prompt-activation-v3");
const readbackPath = resolve(root, "ab-test-r1/prompt-runtime-readback.json");
const expected = {
  "agent-1786633444187-594spj": { revision: 34, mode: "narrative", file: "narrative-prompt-merged-v3.txt", sha256: "0d970d8a50a8395437ffdb69bd278bc8ac05be34b5355b28355e55e1e060bf78" },
  "agent-1786843330392-emdjv2": { revision: 37, mode: "high_energy", file: "high-energy-prompt-merged-v3.txt", sha256: "6a68cce13a9dc398f39604d62a6d1134e956a96f0e700f8844b973688bb695a2" },
};
const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");
const readback = JSON.parse(await readFile(readbackPath, "utf8"));
assert.equal(readback.verdict?.twoAgentsPresent, true, "TWO_AGENTS_MISSING");
assert.equal(readback.verdict?.bothActive, true, "AGENTS_NOT_ACTIVE");
for (const row of readback.agents || []) {
  const target = expected[row.id];
  if (!target) continue;
  const prompt = await readFile(resolve(candidateDir, target.file), "utf8");
  assert.equal(sha256(prompt), target.sha256, `${row.id}:CANDIDATE_SHA_MISMATCH`);
  assert.equal(Number(row.configRevision), target.revision, `${row.id}:REVISION_MISMATCH`);
  assert.equal(row.promptSha256, target.sha256, `${row.id}:RUNTIME_PROMPT_SHA_MISMATCH`);
  assert.equal(row.directorMode, target.mode, `${row.id}:DIRECTOR_MODE_MISMATCH`);
  assert.equal(row.environmentAnchorPolicy, "deferred_until_scene_need", `${row.id}:ENVIRONMENT_POLICY_MISMATCH`);
  assert.equal(row.qualityGate, "qualityScore>=90 and qualityVerdict=pass before media", `${row.id}:QUALITY_GATE_MISMATCH`);
}
assert.equal((readback.agents || []).filter((row) => expected[row.id]).length, 2, "V3_AGENT_READBACK_COUNT_MISMATCH");
const report = {
  schemaVersion: "storyboard_prompt_activation_v3_readback.v1",
  generatedAt: new Date().toISOString(),
  source: "prompt-runtime-readback.json",
  runtime: readback.runtimeVersion?.body || null,
  providerCalls: 0,
  paidGenerationRequests: 0,
  agents: (readback.agents || []).filter((row) => expected[row.id]).map((row) => ({
    id: row.id,
    name: row.name,
    configRevision: row.configRevision,
    promptSha256: row.promptSha256,
    promptLength: row.promptLength,
    model: row.model,
    modelId: row.modelId,
    directorMode: row.directorMode,
    environmentAnchorPolicy: row.environmentAnchorPolicy,
    onScreenTextPolicy: row.onScreenTextPolicy,
    visualAssetPolicy: row.visualAssetPolicy,
    qualityGate: row.qualityGate,
  })),
  passed: true,
};
await writeFile(resolve(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
