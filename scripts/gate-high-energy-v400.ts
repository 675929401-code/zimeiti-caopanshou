import fs from "node:fs/promises";
import path from "node:path";
import { parseStoryboardDirectorPackage, validateStoryboardDirectorPackage } from "../src/lib/storyboard-director-protocol";

// Final gate for v4.0: real validator + vocabulary reuse + colour discipline.
async function main() {
  const dir = path.resolve(".codex-evidence/high-energy-v371-verify-20261022");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith("-package.json")).sort();
  const perCase: Array<Record<string, unknown>> = [];
  const eAll: Record<string, number> = {};
  const sAll: Record<string, number> = {};
  let blue = 0, total = 0;

  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    const pkg = parseStoryboardDirectorPackage(raw);
    if (!pkg) { perCase.push({ file: f, parsed: false }); continue; }
    const issues = validateStoryboardDirectorPackage(pkg, pkg.input, { stage: "planning" });
    const seg = pkg.segments[0] || {};
    const both = `${seg.storyboard_image_prompt || ""}\n${seg.image_to_video_prompt || ""}`;
    const e = [...new Set((both.match(/E\d{1,2}/gu) || []))];
    const s = [...new Set((seg.image_to_video_prompt || "").match(/S\d/gu) || [])];
    for (const c of e) eAll[c] = (eAll[c] || 0) + 1;
    for (const c of s) sAll[c] = (sAll[c] || 0) + 1;
    const isBlue = /冷蓝|检查蓝/u.test(both) && !/红橙|暖金|绿/u.test(both);
    total += 1; if (isBlue) blue += 1;
    perCase.push({
      file: f, parsed: true, issues: issues.length, pushGate: issues.length === 0,
      shots: seg.actual_shot_count, duration: seg.target_duration_seconds,
      eCodes: e, sCodes: s, blueOnly: isBlue,
    });
  }

  const reuse = (o: Record<string, number>, n: number) => Object.entries(o).filter(([, c]: [string, number]) => c >= Math.max(2, Math.ceil(n * 0.6))).length;
  const report = {
    schemaVersion: "high_energy_v371_final_gate.v1",
    checkedAt: new Date().toISOString(),
    caseCount: perCase.length,
    allParsed: perCase.every((c) => c.parsed),
    allZeroIssues: perCase.every((c) => (c.issues ?? 1) === 0),
    pushGateAllPass: perCase.every((c) => c.pushGate === true),
    eDistribution: eAll,
    sDistribution: sAll,
    eReusedCodes: reuse(eAll, perCase.length),
    sReusedCodes: reuse(sAll, perCase.length),
    blueOnlyRatio: total ? +(blue / total).toFixed(2) : null,
    perCase,
  };
  await fs.writeFile(path.join(dir, "final-gate.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
