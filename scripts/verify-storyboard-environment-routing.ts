import assert from "node:assert/strict";
import { parseStoryboardDirectorPackage, renderStoryboardDirectorPackage, type StoryboardDirectorPackage } from "@/lib/storyboard-director-protocol";
import { parseStoryboardCanvasImport } from "@/lib/storyboard-canvas-bridge";

const pkg: StoryboardDirectorPackage = {
  schema_version: "storyboard_director_output.v1",
  artifact_type: "storyboard_director_package",
  director_mode: "cinematic",
  input: {
    schema_version: "storyboard_director_input.v1",
    segmented_script: "1.幼犬在客厅观察主人。",
    director_mode: "cinematic",
    animation_style: "温暖家庭3D动画电影",
    aspect_ratio: "16:9",
    target_duration_seconds: 10,
    special_notes: "全程无对白，只保留环境声。",
  },
  visual_asset_plan: {
    mode: "selected",
    assets: [
      { id: "character_main", role: "character", name: "女主人", identity_lock: "固定脸型、发型、服装与体型", allowed_changes: ["姿态", "表情"], reference_prompts: [{ kind: "identity", purpose: "锁定身份", prompt: "保持女主人脸型、发型、服装、配饰与发色完全一致。" }] },
      { id: "env_home_wide", role: "environment", name: "客厅宽幅锚点", identity_lock: "固定客厅布局、窗户和沙发位置", allowed_changes: ["机位", "临时状态"], reference_prompts: [{ kind: "environment-wide", purpose: "锁定空间", prompt: "单画面宽幅客厅建立图，固定窗户、沙发和喂食区。" }], scene_id: "home_main", scene_zone: "living_room", camera_coverage: "wide", fixed_anchors: ["window_left", "sofa_right"] },
      { id: "env_home_side", role: "environment", name: "客厅侧面角度", identity_lock: "固定客厅侧向门窗与沙发关系", allowed_changes: ["机位"], reference_prompts: [{ kind: "environment-angle", purpose: "锁定侧向机位", prompt: "基于客厅宽幅锚点生成独立侧向机位图，保持固定窗户与沙发位置。" }], scene_id: "home_main", scene_zone: "living_room", camera_coverage: "side", derived_from_asset_id: "env_home_wide" },
    ],
  },
  environment_groups: [{ scene_id: "home_main", name: "家庭客厅", fixed_anchors: ["window_left", "sofa_right"], zones: ["living_room"], available_angles: ["wide", "side"], allowed_segment_kinds: ["home_observation"], scene_type: "interior", environment_mode: "prompt", anchor_required: false, scene_zone: "living_room", confidence: "confirmed" }],
  segments: [{
    segment_id: "segment_001", source_index: 1, narration: "幼犬在客厅观察主人。", target_duration_seconds: 10, estimated_narration_duration: 2,
    panel_count: 4, layout: "two_by_two", pacing_mode: "medium", actual_shot_count: 3,
    shot_time_ranges: [{ shot_id: "shot_01", start_seconds: 0, end_seconds: 3, action_beat: "幼犬抬头" }, { shot_id: "shot_02", start_seconds: 3, end_seconds: 7, action_beat: "主人转身" }, { shot_id: "shot_03", start_seconds: 7, end_seconds: 10, action_beat: "幼犬停下" }],
    panoramic_anchor_role: null, bottom_panel_role: "none", continuity_links: [{ from_shot: "shot_01", to_shot: "shot_02", link_type: "gaze", description: "视线连续" }, { from_shot: "shot_02", to_shot: "shot_03", link_type: "motion", description: "动作收束" }],
    character_assets: ["character_main"], scene_id: "home_main", scene_zone: "living_room", camera: "side_medium", dynamic_state: ["puppy_alert"], capability_gaps: [],
    quality_checks: [{ check_id: "scene_binding", status: "pass", detail: "场景类型、区域与文案一致" }], wardrobe_change_events: [{ segment_id: "segment_001", from: "基础造型", to: "居家针织造型", reason: "文案明确为室内观察场景" }],
    visual_asset_refs: [
      { asset_id: "character_main", role: "character", reference_kinds: ["identity"] },
      { asset_id: "env_home_side", role: "environment", reference_kinds: ["environment-angle"], scene_id: "home_main", scene_zone: "living_room", camera_coverage: "side" },
    ],
    semantic_visualizations: [{ trigger: "观察", visual_form: "幼犬抬头", interaction: "与主人视线连接" }],
    storyboard_image_prompt: "四格故事板，客厅侧向机位，女主人和幼犬保持固定身份，展示观察动作。",
    image_to_video_prompt: "先抬头，随后主人转身，幼犬停下并保持安静；环境声，无对白。",
  }],
};

const rendered = renderStoryboardDirectorPackage(pkg);
const parsed = parseStoryboardDirectorPackage(rendered);
assert.ok(parsed);
assert.equal(parsed.environment_groups?.[0].scene_id, "home_main");
assert.equal(parsed.visual_asset_plan?.assets.find((asset) => asset.id === "env_home_side")?.camera_coverage, "side");
assert.equal(parsed.segments[0].scene_id, "home_main");
assert.equal(parsed.segments[0].bottom_panel_role, "none");
assert.equal(parsed.segments[0].quality_checks?.[0].status, "pass");
assert.equal(parsed.segments[0].wardrobe_change_events?.[0].to, "居家针织造型");
assert.equal(parsed.segments[0].visual_asset_refs?.[1].camera_coverage, "side");

const canvas = parseStoryboardCanvasImport({ source: "stable_json", schema_version: "storyboard_director_output.v1", commit_key: "commit-env-routing", message_id: "message-env-routing", machine_payload: pkg });
assert.ok(canvas);
assert.equal(canvas.environmentGroups?.[0].sceneId, "home_main");
assert.equal(canvas.environmentGroups?.[0].sceneType, "interior");
assert.equal(canvas.segments[0].visualAssetRefs?.[1].sceneZone, "living_room");
assert.equal(canvas.segments[0].bottomPanelRole, "none");
assert.equal(canvas.segments[0].qualityChecks?.[0].checkId, "scene_binding");
assert.equal(canvas.segments[0].wardrobeChangeEvents?.[0].segmentId, "segment_001");
console.log(JSON.stringify({ passed: true, checks: ["stable package roundtrip", "environment group preservation", "segment scene route preservation", "canvas bridge preservation"], providerCalls: 0 }));
