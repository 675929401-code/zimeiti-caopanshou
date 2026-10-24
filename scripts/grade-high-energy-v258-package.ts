import fs from "node:fs/promises";
import {
  parseStoryboardDirectorPackage,
  validateStoryboardDirectorPackage,
  parseSegmentedScript,
  storyboardShotCountRule,
} from "../src/lib/storyboard-director-protocol";

// Grades the live agent's machine package with the real validator, exactly as the
// canvas push gate does (stage: "planning"), and repeats the §8 checks that are
// machine-decidable.
async function main() {
  const OUT_DIR = ".codex-evidence/high-energy-v258-one-segment-20261022";
  const raw = await fs.readFile(`${OUT_DIR}/machine-package.json`, "utf8");
  const parsed = parseStoryboardDirectorPackage(raw);
  if (!parsed) {
    const report = { passed: false, reason: "parseStoryboardDirectorPackage returned null" };
    await fs.writeFile(`${OUT_DIR}/validator-report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const issues = validateStoryboardDirectorPackage(parsed, parsed.input, { stage: "planning" });
  const segments = parsed.segments;
  const shotRule = storyboardShotCountRule(parsed.input.target_duration_seconds, parsed.director_mode);
  const expectedSegments = parseSegmentedScript(parsed.input.segmented_script);

  const perSegment = segments.map((segment, index) => {
    const both = `${segment.storyboard_image_prompt}\n${segment.image_to_video_prompt}`;
    const video = String(segment.image_to_video_prompt || "");
    return {
      segmentId: segment.segment_id,
      narrationMatchesSource: segment.narration === (expectedSegments[index]?.narration ?? ""),
      panelCount: segment.panel_count,
      layout: segment.layout,
      actualShotCount: segment.actual_shot_count,
      shotWithinRule: segment.actual_shot_count >= shotRule.min && segment.actual_shot_count <= shotRule.max,
      panoramicAnchorRole: segment.panoramic_anchor_role,
      bottomPanelRole: segment.bottom_panel_role,
      styleLockRepeated: Boolean(segment.style_lock) && both.includes(String(segment.style_lock)),
      sceneLockRepeated: Boolean(segment.scene_lock) && both.includes(String(segment.scene_lock)),
      panelWordsFound: both.match(/左上|右上|左下|右下|第几格|Frame\s*\d/gu) || [],
      // 首帧约束句允许等价措辞：首帧/第一帧 + 进入某个单一场景
      firstFrameClausePresent: /(?:首帧|第一帧)[^。；]{0,24}(?:进入|即为|就是|开始于)/u.test(video),
      storyboardNotShownClause: /不展示(?:故事板|分镜板)/u.test(video),
      audioBoundaryPresent: /无对白、无旁白、无配乐；仅保留与场景一致的环境声与动作声。/u.test(video),
    };
  });

  const report = {
    schemaVersion: "high_energy_v258_validator_grade.v1",
    checkedAt: new Date().toISOString(),
    directorMode: parsed.director_mode,
    targetDurationSeconds: parsed.input.target_duration_seconds,
    shotRule,
    segmentCount: segments.length,
    issues,
    issueCount: issues.length,
    pushGateWouldPass: issues.length === 0,
    wardrobePlan: parsed.wardrobe_plan
      ? {
          baseLookType: typeof parsed.wardrobe_plan.base_look,
          baseLookLength: String(parsed.wardrobe_plan.base_look).length,
          baseLookIsCorrupted: String(parsed.wardrobe_plan.base_look) === "[object Object]",
          continuityRuleLength: String(parsed.wardrobe_plan.continuity_rule).length,
          changeEventCount: parsed.wardrobe_plan.change_events.length,
        }
      : null,
    perSegment,
  };
  await fs.writeFile(`${OUT_DIR}/validator-report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
