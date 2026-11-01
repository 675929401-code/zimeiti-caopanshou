import assert from "node:assert/strict";
import {
  STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
  STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_MODES,
  STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  STORYBOARD_TARGET_DURATIONS,
  normalizeStoryboardDirectorInput,
  storyboardShotCountRule,
  type StoryboardDirectorMode,
  type StoryboardDirectorPackage,
} from "../src/lib/storyboard-director-protocol";
import { parseStoryboardCanvasImport } from "../src/lib/storyboard-canvas-bridge";
import { shouldUseStoryboardPanoramicAnchor } from "../src/lib/canvas-prompt-presets";

assert.deepEqual(STORYBOARD_DIRECTOR_MODES, ["high_energy", "cinematic", "lyrical"]);
assert.deepEqual(STORYBOARD_TARGET_DURATIONS, [8, 10, 15]);

const directorCardShotRules = {
  8: {
    high_energy: { min: 2, max: 3, defaultCount: 3 },
    cinematic: { min: 2, max: 3, defaultCount: 2 },
    lyrical: { min: 1, max: 2, defaultCount: 1 },
  },
  10: {
    high_energy: { min: 3, max: 4, defaultCount: 4 },
    cinematic: { min: 2, max: 3, defaultCount: 3 },
    lyrical: { min: 1, max: 2, defaultCount: 2 },
  },
  15: {
    high_energy: { min: 4, max: 5, defaultCount: 5 },
    cinematic: { min: 3, max: 4, defaultCount: 4 },
    lyrical: { min: 2, max: 3, defaultCount: 3 },
  },
} as const;

for (const mode of STORYBOARD_DIRECTOR_MODES) {
  for (const duration of STORYBOARD_TARGET_DURATIONS) {
    assert.deepEqual(storyboardShotCountRule(duration, mode), directorCardShotRules[duration][mode]);
  }
}

assert.equal(normalizeStoryboardDirectorInput({ 导演版本: "抒情情感" }).director_mode, "lyrical");
assert.equal(normalizeStoryboardDirectorInput({ target_duration_seconds: 8 }).target_duration_seconds, 8);
assert.equal(shouldUseStoryboardPanoramicAnchor("角色紧张后退，主人伸手安抚", "hybrid-packaging", 15), false);
assert.equal(shouldUseStoryboardPanoramicAnchor("底部全景承担关系落点，完整展示两人和解后的客厅全貌", "hybrid-packaging", 15), false);
assert.equal(shouldUseStoryboardPanoramicAnchor("bottomPanelRole=panorama；完整展示两人和解后的客厅全貌", "hybrid-packaging", 15, "auto"), true);
assert.equal(shouldUseStoryboardPanoramicAnchor("panelMode=fixed-5；结论锚点汇总风险与解决动作", "hybrid-packaging", 10, "auto"), true);

function fixture(mode: StoryboardDirectorMode, duration: 8 | 10 | 15): StoryboardDirectorPackage {
  const actualShotCount = duration === 15 ? 4 : 3;
  const panelCount = duration === 15 ? 5 : 4;
  const shotTimeRanges = Array.from({ length: actualShotCount }, (_, index) => ({
    shot_id: `shot_${String(index + 1).padStart(2, "0")}`,
    start_seconds: Math.round(index * duration / actualShotCount * 10) / 10,
    end_seconds: Math.round((index + 1) * duration / actualShotCount * 10) / 10,
    action_beat: `当前文案动作节拍${index + 1}`,
  }));
  return {
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    segments: [{
      image_to_video_prompt: `${duration}秒，实际${actualShotCount}个镜头。${shotTimeRanges.map((range) => `${range.start_seconds}-${range.end_seconds}秒角色按当前文案完成动作`).join("；")}；镜头跟拍后稳定收束，无对白。`,
      storyboard_image_prompt: panelCount === 5
        ? "top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel。角色、道具与环境来自当前文案。"
        : "严格4格2x2故事板。角色、道具与环境来自当前文案。",
      semantic_visualizations: [{ trigger: "紧张", visual_form: "耳侧抖动线", interaction: "随角色后退而减弱" }],
      character_assets: ["成年蜂蜜金色金毛，棕色眼睛，红色项圈"],
      continuity_links: Array.from({ length: actualShotCount - 1 }, (_, index) => ({
        from_shot: `shot_${String(index + 1).padStart(2, "0")}`,
        to_shot: `shot_${String(index + 2).padStart(2, "0")}`,
        link_type: "action_bridge",
        description: "沿角色视线和动作方向连续衔接",
      })),
      panoramic_anchor_role: panelCount === 5 ? "底部全宽格承担和解后的空间全貌与结论落点" : null,
      shot_time_ranges: shotTimeRanges,
      actual_shot_count: actualShotCount,
      pacing_mode: mode === "high_energy" ? "fast" : mode === "lyrical" ? "slow" : "medium",
      layout: panelCount === 5 ? "four_plus_panorama" : "two_by_two",
      panel_count: panelCount,
      estimated_narration_duration: 2.8,
      target_duration_seconds: duration,
      narration: "狗狗听见钥匙声后退，主人伸手让它安心。",
      source_index: 1,
      segment_id: "segment_001",
    }],
    input: {
      special_notes: "红色项圈不得改变",
      target_duration_seconds: duration,
      aspect_ratio: "16:9",
      animation_style: "电影级高能3D动画喜剧",
      director_mode: mode,
      segmented_script: "1.【狗狗听见钥匙声后退，主人伸手让它安心。】",
      schema_version: STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
    },
    visual_asset_plan: {
      mode: "selected",
      assets: [{
        id: "character_main",
        role: "character",
        name: "主角女孩",
        identity_lock: "短黑发、米色针织衫、圆框眼镜，服装颜色和脸型保持一致。",
        allowed_changes: ["表情", "姿态"],
        reference_prompts: [{
          kind: "turnaround",
          purpose: "锁定人物身份和服装",
          prompt: "中性站姿、正面侧面背面角色参考板，短黑发、米色针织衫、圆框眼镜，浅色背景。",
        }],
      }],
    },
    director_mode: mode,
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  };
}

const pkg = fixture("cinematic", 15);
const detailWithArbitraryPropertyOrder = {
  machine_payload: pkg,
  segments: [],
  source: "stable_json",
  message_id: "message-without-markdown-headings",
  schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  commit_key: "commit-property-order-independent",
};
const importPlan = parseStoryboardCanvasImport(detailWithArbitraryPropertyOrder);
assert.ok(importPlan);
assert.equal(importPlan.settings.directorMode, "cinematic");
assert.equal(importPlan.settings.targetDurationSeconds, 15);
assert.equal(importPlan.segments[0].panelCount, 5);
assert.equal(importPlan.segments[0].actualShotCount, 4);
assert.equal(importPlan.segments[0].shotTimeRanges.length, 4);
assert.equal(importPlan.visualAssetPlan?.mode, "selected");
assert.equal(importPlan.visualAssetPlan?.assets[0]?.id, "character_main");
assert.equal(importPlan.visualAssetPlan?.assets[0]?.referencePrompts[0]?.kind, "turnaround");
assert.equal(parseStoryboardCanvasImport({ ...detailWithArbitraryPropertyOrder, source: "legacy_text_blocks" }), null);

const eightSecondPackage = fixture("cinematic", 8);
const eightSecondImport = parseStoryboardCanvasImport({
  machine_payload: eightSecondPackage,
  source: "stable_json",
  schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  commit_key: "eight-second-structured-import",
});
assert.ok(eightSecondImport);
assert.equal(eightSecondImport.settings.targetDurationSeconds, 8);
assert.equal(eightSecondImport.segments[0].shotTimeRanges.at(-1)?.end_seconds, 8);

console.log(JSON.stringify({
  ok: true,
  tests: 24,
  modes: STORYBOARD_DIRECTOR_MODES,
  durations: STORYBOARD_TARGET_DURATIONS,
  structuredMapping: "stable-json-only; property-order-independent",
  panelLayouts: ["2x2", "2x2+bottom-panorama"],
}, null, 2));
