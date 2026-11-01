import fs from "node:fs/promises";
import path from "node:path";
import {
  parseStoryboardDirectorPackage,
  validateStoryboardDirectorPackage,
} from "../src/lib/storyboard-director-protocol";

// Validates every package produced by the v2.7.0 benchmark run with the real
// validator (stage: "planning"), i.e. the same gate the canvas push button uses.
async function main() {
  const dir = path.resolve(".codex-evidence/high-energy-v310-suite-20261022");
  const entries = await fs.readdir(dir);
  const files = entries.filter((name) => name.endsWith("-package.json")).sort();
  const results = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(dir, file), "utf8");
    const parsed = parseStoryboardDirectorPackage(raw);
    if (!parsed) {
      results.push({ file, parsed: false, issues: ["PARSE_NULL"] });
      continue;
    }
    const issues = validateStoryboardDirectorPackage(parsed, parsed.input, { stage: "planning" });
    results.push({
      file,
      parsed: true,
      issueCount: issues.length,
      issues,
      pushGateWouldPass: issues.length === 0,
      duration: parsed.input.target_duration_seconds,
      panelCount: parsed.segments[0]?.panel_count ?? null,
      shots: parsed.segments[0]?.actual_shot_count ?? null,
    });
  }
  const report = {
    schemaVersion: "high_energy_v310_validator_grade.v1",
    checkedAt: new Date().toISOString(),
    packageCount: results.length,
    allPass: results.every((r) => r.pushGateWouldPass === true),
    results,
  };
  await fs.writeFile(path.join(dir, "validator-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
