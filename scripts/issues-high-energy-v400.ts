import fs from "node:fs/promises";
import path from "node:path";
import { parseStoryboardDirectorPackage, validateStoryboardDirectorPackage } from "../src/lib/storyboard-director-protocol";
async function main() {
  const dir = path.resolve(".codex-evidence/high-energy-v400-verify-20261022");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith("-package.json")).sort();
  for (const f of files) {
    const pkg = parseStoryboardDirectorPackage(await fs.readFile(path.join(dir, f), "utf8"));
    if (!pkg) { console.log(f, "PARSE_NULL"); continue; }
    const issues = validateStoryboardDirectorPackage(pkg, pkg.input, { stage: "planning" });
    console.log(f, "->", JSON.stringify(issues));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
