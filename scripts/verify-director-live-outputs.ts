import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parseStructuredAgentOutput } from "../src/lib/structured-agent-output";
import { parseStoryboardDirectorIntake } from "../src/lib/storyboard-director-intake";
import { validateStoryboardDirectorPackage, validateStoryboardDirectorAssetsPackage, type StoryboardDirectorPackage, type StoryboardDirectorAssetsPackage } from "../src/lib/storyboard-director-protocol";
import { parseStoryboardCanvasImport } from "../src/lib/storyboard-canvas-bridge";

const directory = ".codex-evidence/director-refinement-20261023/browser";
const result = [];
for (const id of ["ordinary-continuity", "reference-assets-first"]) {
  const raw = readFileSync(`${directory}/${id}.output.txt`, "utf8");
  const original = readFileSync(`${directory}/${id}.input.txt`, "utf8");
  const intake = parseStoryboardDirectorIntake(original);
  const parsed = parseStructuredAgentOutput(raw, true);
  assert.ok(intake, "LIVE_CARD_MUST_PARSE");
  if (parsed.status !== "valid" || parsed.kind !== "storyboard_director") {
    result.push({ id, passed: false, reason: "LIVE_OUTPUT_PACKAGE_INVALID", status: parsed.status });
    continue;
  }
  const pkg = parsed.machine_payload as StoryboardDirectorPackage | StoryboardDirectorAssetsPackage;
  assert.ok(pkg, "LIVE_MACHINE_PACKAGE_REQUIRED");
  const assetsOnly = parsed.phase === "assets";
  const issues = assetsOnly ? validateStoryboardDirectorAssetsPackage(pkg as StoryboardDirectorAssetsPackage, intake.input)
    : validateStoryboardDirectorPackage(pkg as StoryboardDirectorPackage, intake.input);
  const plan = parseStoryboardCanvasImport({ source: "stable_json", message_id: id, commit_key: id, schema_version: pkg.schema_version, machine_payload: pkg, expected_input: intake.input, required_contract_version: "storyboard_director_contract.v2" });
  const passed = issues.length === 0 && Boolean(plan) && assetsOnly === (id === "reference-assets-first");
  writeFileSync(`${directory}/${id}.package.json`, JSON.stringify(pkg, null, 2));
  result.push({ id, passed, phase: parsed.phase, issues, importReady: Boolean(plan), characters: raw.length,
    segments: (pkg as StoryboardDirectorPackage).segments?.length || 0,
    visualAssets: pkg.visual_asset_plan?.assets.length || 0 });
}
writeFileSync(`${directory}/live-quality-contract.json`, JSON.stringify({ scope: "real_ui_llm_output_structure_not_generated_media_quality", result }, null, 2));
console.log(JSON.stringify(result, null, 2));
assert.ok(result.every(item => item.passed), "LIVE_OUTPUT_CONTRACT_FAILED");
