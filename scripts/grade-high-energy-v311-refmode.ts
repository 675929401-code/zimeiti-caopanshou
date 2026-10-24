import fs from "node:fs/promises";
import { parseStoryboardDirectorPackage, validateStoryboardDirectorPackage } from "../src/lib/storyboard-director-protocol";
async function main() {
  const raw = await fs.readFile(".codex-evidence/high-energy-v311-refmode-20261022/package.json", "utf8");
  const parsed = parseStoryboardDirectorPackage(raw);
  if (!parsed) { console.log(JSON.stringify({ parsed: false, issues: ["PARSE_NULL"] }, null, 2)); return; }
  const issues = validateStoryboardDirectorPackage(parsed, parsed.input, { stage: "planning" });
  console.log(JSON.stringify({ parsed: true, issueCount: issues.length, issues, pushGateWouldPass: issues.length === 0, mode: parsed.visual_asset_plan?.mode, assets: parsed.visual_asset_plan?.assets.length, shots: parsed.segments[0]?.actual_shot_count }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
