import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "../运行日志/三视觉资产十秒闭环-20261019/benchmark-research-20261020");
const v2Dir = resolve(root, "prompt-candidates-v2");
const evidenceDir = resolve(root, "prompt-activation-v2");
const ids = ["agent-1786633444187-594spj", "agent-1786843330392-emdjv2"];
const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");
const runtime = JSON.parse(await readFile(resolve(root, "ab-test-r1/prompt-runtime-readback.json"), "utf8"));
const expected = {};
for (const [id, file] of [[ids[0], "narrative-prompt.txt"], [ids[1], "high-energy-prompt.txt"]]) expected[id] = { sha256: sha256(await readFile(resolve(v2Dir, file), "utf8")), length: (await readFile(resolve(v2Dir, file), "utf8")).length };
const rows = runtime.agents;
const report = {
  schemaVersion: "storyboard_prompt_activation_v2.v1",
  generatedAt: new Date().toISOString(),
  source: "prompt-runtime-readback.json",
  providerCalls: 0,
  paidGenerationRequests: 0,
  runtime: { sourceVersion: runtime.runtimeVersion.body.sourceVersion, buildId: runtime.runtimeVersion.body.buildId },
  agents: rows.map((row) => ({ id: row.id, name: row.name, configRevision: row.configRevision, model: row.model, modelId: row.modelId, promptSha256: row.promptSha256, promptLength: row.promptLength, expectedPromptSha256: expected[row.id]?.sha256, expectedPromptLength: expected[row.id]?.length, directorMode: row.directorMode, environmentAnchorPolicy: row.environmentAnchorPolicy, onScreenTextPolicy: row.onScreenTextPolicy, visualAssetPolicy: row.visualAssetPolicy, qualityGate: row.qualityGate })),
  passed: rows.length === 2 && rows.every((row) => row.promptSha256 === expected[row.id]?.sha256 && row.promptLength === expected[row.id]?.length && row.model === "gpt-6.1-sol" && row.active && row.environmentAnchorPolicy === "deferred_until_scene_need" && row.onScreenTextPolicy === "frame_caption_metadata_only_no_other_readable_text_video_zero_text_grid"),
};
await mkdir(evidenceDir, { recursive: true });
await writeFile(resolve(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 2;
