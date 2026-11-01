import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION,
  parseStoryboardDirectorPackage,
  parseStoryboardDirectorAssetsPackage,
  validateStoryboardDirectorAssetsPackage,
  renderStoryboardDirectorPackage,
  validateStoryboardDirectorPackage,
  type StoryboardDirectorPackage,
} from "../src/lib/storyboard-director-protocol";
import { parseStoryboardDirectorIntake } from "../src/lib/storyboard-director-intake";
import { parseStoryboardCanvasImport } from "../src/lib/storyboard-canvas-bridge";
import { parseStructuredAgentOutput } from "../src/lib/structured-agent-output";

const card = `分段文案：1.【小狗向前跳，停在门口。】
2.【男主人轻轻蹲下，小狗回头。】
分段时长：10秒版：每段3-4个镜头
生成模型：自动通用（分镜工作台再选择模型）
视频比例：9:16
动画风格：黏土定格质感3D动画
主人性别：男主人
狗狗品种：金毛
特殊备注：蓝色衬衫、米白裤、白鞋。
项圈：红色；每段服装完全一致。
视觉资产模式：普通模式`;
const intake = parseStoryboardDirectorIntake(card);
assert.ok(intake);
assert.deepEqual(intake.missingFields, []);
assert.equal(intake.input.aspect_ratio, "9:16");
assert.equal(intake.input.dog_breed, "金毛");
assert.equal(intake.input.owner_gender, "男主人");
assert.equal(intake.input.special_notes, "蓝色衬衫、米白裤、白鞋。\n项圈：红色；每段服装完全一致。");
assert.equal(intake.input.visual_asset_mode, "普通模式");
assert.equal(intake.fieldSources.dog_breed, "submitted");
assert.equal(parseStoryboardDirectorIntake("继续"), null);
const stableCard = card.replace("分段文案：", "segmented_script:")
  .replace("分段时长：", "target_duration_seconds:").replace("生成模型：", "video_model_profile:")
  .replace("视频比例：", "aspect_ratio:").replace("动画风格：", "animation_style:")
  .replace("主人性别：", "owner_gender:").replace("狗狗品种：", "dog_breed:")
  .replace("特殊备注：", "special_notes:").replace("视觉资产模式：", "visual_asset_mode:");
assert.deepEqual(parseStoryboardDirectorIntake(stableCard)?.input, intake.input);
assert.ok(parseStoryboardDirectorIntake(`${card}\n狗狗品种：柯基`)?.missingFields.includes("duplicate:dog_breed"));

const person = "约28岁成年男主人，黑色短发，蓝色棉衬衫、米白长裤、白色运动鞋，无首饰。";
const pet = "成年蜂蜜金色金毛，棕色眼睛，红色项圈，垂耳、蓬松长尾。";
const fixture: StoryboardDirectorPackage = {
  schema_version: "storyboard_director_output.v1",
  artifact_type: "storyboard_director_package",
  production_contract_version: STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION,
  director_mode: "high_energy",
  input: intake.input,
  wardrobe_plan: {
    base_look: person,
    continuity_rule: "全片保持蓝色衬衫、米白长裤和白色运动鞋，仅改变表情与姿态。",
    change_events: [],
  },
  visual_asset_plan: { mode: "off", assets: [] },
  segments: ["小狗向前跳，停在门口。", "男主人轻轻蹲下，小狗回头。"].map((narration, index) => ({
    segment_id: `segment_00${index + 1}`, source_index: index + 1, narration,
    target_duration_seconds: 10, estimated_narration_duration: 2.8,
    panel_count: 4, layout: "two_by_two", pacing_mode: "fast", actual_shot_count: 3,
    shot_time_ranges: [
      { shot_id: "shot_01", start_seconds: 0, end_seconds: 3, action_beat: "金毛前爪迈出，主人蹲下" },
      { shot_id: "shot_02", start_seconds: 3, end_seconds: 7, action_beat: "金毛停在门槛，主人伸手" },
      { shot_id: "shot_03", start_seconds: 7, end_seconds: 10, action_beat: "金毛回头抬眼看主人，尾巴摆动后稳定" },
    ],
    panoramic_anchor_role: null,
    continuity_links: [
      { from_shot: "shot_01", to_shot: "shot_02", link_type: "action_bridge", description: "前爪落地声延续到门槛近景" },
      { from_shot: "shot_02", to_shot: "shot_03", link_type: "eyeline_match", description: "以抬眼方向衔接主人伸出的手" },
    ],
    character_assets: [person, pet],
    character_asset_ids: ["owner_main", "pet_main"],
    semantic_visualizations: [{ trigger: "安心", visual_form: "耳朵放松垂落", interaction: "看见主人后随呼吸恢复柔软" }],
    storyboard_image_prompt: `9:16黏土风格四格2x2故事板。${person}${pet}英文注释独立置于每格下方等高栏。`,
    image_to_video_prompt: "10秒，先跟拍金毛前爪迈出，随后门槛近景金毛停住，最后回头看男主人并稳定。无对白、无旁白，保留脚步声和衣料声。",
  })),
};
const detail = (pkg: unknown, withInput = true) => ({
  source: "stable_json", schema_version: "storyboard_director_output.v1", machine_payload: pkg,
  message_id: "contract-test-message", commit_key: "contract-test-commit",
  ...(withInput ? { expected_input: intake.input } : {}),
});
assert.deepEqual(validateStoryboardDirectorPackage(fixture, intake.input, { stage: "planning" }), []);
assert.ok(parseStoryboardCanvasImport(detail(fixture))?.intakeVerified);
assert.equal(parseStoryboardCanvasImport(detail(fixture, false)), null);
assert.equal(parseStoryboardCanvasImport(detail(fixture, false), { allowLegacyUnverified: true }), null,
  "新合同不能借历史兼容开关跳过接收卡核对");

const cases: string[] = [];
function rejected(name: string, mutate: (pkg: StoryboardDirectorPackage) => void) {
  const pkg = structuredClone(fixture);
  mutate(pkg);
  assert.equal(parseStoryboardCanvasImport(detail(pkg)), null, name);
  cases.push(name);
}
rejected("input-and-output-self-rewrite", pkg => {
  pkg.input.segmented_script = pkg.input.segmented_script.replace("小狗", "小猫");
  pkg.segments[0].narration = pkg.segments[0].narration.replace("小狗", "小猫");
});
rejected("segment-order", pkg => { pkg.segments.reverse(); });
for (const [field, wrong] of Object.entries({
  aspect_ratio: "16:9", animation_style: "皮克斯式高能3D宠物科普动画", special_notes: "",
  owner_gender: "女主人", dog_breed: "柯基", video_model_profile: "另一模型", visual_asset_mode: "参考图模式",
})) rejected(`wrong-${field}`, pkg => { (pkg.input as unknown as Record<string, unknown>)[field] = wrong; });
rejected("missing-timeline", pkg => { delete (pkg.segments[0] as unknown as Record<string, unknown>).shot_time_ranges; });
rejected("missing-continuity", pkg => { delete (pkg.segments[0] as unknown as Record<string, unknown>).continuity_links; });
rejected("legacy-fallback-smuggling", pkg => { pkg.segments[0].continuity_links[0].link_type = "legacy_continuity"; });
rejected("wrong-shot-link", pkg => { pkg.segments[0].continuity_links[0].to_shot = "shot_03"; });
rejected("wardrobe-not-repeated", pkg => { pkg.segments[1].storyboard_image_prompt = pkg.segments[1].storyboard_image_prompt.replace(person, "人物同上。"); });
rejected("wardrobe-drift-under-same-identity", pkg => {
  const changed = person.replace("蓝色棉衬衫", "红色夹克");
  pkg.segments[1].character_assets[0] = changed;
  pkg.segments[1].storyboard_image_prompt = pkg.segments[1].storyboard_image_prompt.replace(person, changed);
});
const petOnly = structuredClone(fixture);
petOnly.segments[1].character_assets = [pet];
petOnly.segments[1].character_asset_ids = ["pet_main"];
assert.deepEqual(validateStoryboardDirectorPackage(petOnly, intake.input), [], "只拍宠物的段落不应要求人物出镜");
const wardrobeChange = structuredClone(fixture);
wardrobeChange.segments[1].character_assets[0] = person.replace("蓝色棉衬衫", "红色夹克");
wardrobeChange.segments[1].storyboard_image_prompt = wardrobeChange.segments[1].storyboard_image_prompt.replace(person, wardrobeChange.segments[1].character_assets[0]);
wardrobeChange.wardrobe_plan!.change_events = [{ segment_id: "segment_002", from: "蓝色棉衬衫", to: "红色夹克", reason: "用户明确要求此段换上红色夹克" }];
assert.deepEqual(validateStoryboardDirectorPackage(wardrobeChange, intake.input), [], "明确换装事件应保留合法变化");
rejected("unrequested-five-panel-layout", pkg => {
  pkg.segments[1].panel_count = 5; pkg.segments[1].layout = "four_plus_panorama";
  pkg.segments[1].panoramic_anchor_role = "独立结论锚点";
});
const missingInput = structuredClone(fixture) as unknown as Record<string, unknown>;
delete missingInput.input;
assert.equal(parseStoryboardDirectorPackage(JSON.stringify(missingInput)), null);

const deceptive = `可见正文：横屏皮克斯，女主人和柯基穿红裙。\n\n${renderStoryboardDirectorPackage(fixture)}`;
const parsed = parseStructuredAgentOutput(deceptive, true);
assert.equal(parsed.status, "valid");
assert.ok(parsed.visible_text.includes(fixture.segments[0].storyboard_image_prompt));
assert.ok(!parsed.visible_text.includes("女主人和柯基穿红裙"));
assert.ok(!parsed.visible_text.includes('"schema_version"'));
assert.ok(!parsed.visible_text.includes("机器 JSON 包"));

const legacy = structuredClone(fixture);
delete legacy.production_contract_version;
for (const key of ["owner_gender", "dog_breed", "video_model_profile", "visual_asset_mode"] as const) delete legacy.input[key];
assert.equal(parseStoryboardCanvasImport(detail(legacy, false)), null);
const legacyPlan = parseStoryboardCanvasImport(detail(legacy, false), { allowLegacyUnverified: true });
assert.ok(legacyPlan);
assert.equal(legacyPlan.intakeVerified, false);
assert.equal(parseStoryboardCanvasImport({ ...detail(legacy, false), required_contract_version: STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION },
  { allowLegacyUnverified: true }), null, "宿主要求新合同后，漏写marker不能降级伪装历史包");

const referenceInput = { ...intake.input, visual_asset_mode: "参考图模式" };
const assets = [
  { id: "owner_main", role: "character" as const, name: "男主人", identity_lock: person, allowed_changes: ["表情姿态"],
    reference_prompts: [{ kind: "turnaround" as const, purpose: "正面侧面背面统一人物衣着", prompt: `单张人物正面、侧面、背面三视图，浅灰背景，完整头脚，三视角等比例。${person}` }] },
  { id: "pet_main", role: "pet" as const, name: "金毛犬", identity_lock: pet, allowed_changes: ["表情姿态"],
    reference_prompts: [{ kind: "turnaround" as const, purpose: "正面侧面背面统一宠物身份", prompt: `单张宠物正面、侧面、背面三视图，浅灰背景，完整四肢尾巴，三视角等比例。${pet}` }] },
];
const assetsRaw = {
  schema_version: "storyboard_director_assets.v1", artifact_type: "storyboard_director_assets",
  production_contract_version: STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION,
  phase: "assets", director_mode: "high_energy", input: referenceInput,
  wardrobe_plan: fixture.wardrobe_plan, visual_asset_plan: { mode: "selected", assets,
    generation_policy: { max_initial_images: assets.length, initial_required_asset_ids: assets.map(asset => asset.id), initial_deferred_asset_ids: [], environment_anchor_policy: "none" } },
};
const assetsPackage = parseStoryboardDirectorAssetsPackage(JSON.stringify(assetsRaw));
assert.ok(assetsPackage);
assert.deepEqual(validateStoryboardDirectorAssetsPackage(assetsPackage, referenceInput), []);
assert.equal(parseStoryboardDirectorAssetsPackage(JSON.stringify({ ...assetsRaw, segments: [] })), null);
const assetsDetail = { ...detail(assetsRaw), schema_version: assetsRaw.schema_version, expected_input: referenceInput };
const assetsPlan = parseStoryboardCanvasImport(assetsDetail);
assert.equal(assetsPlan?.phase, "assets");
assert.deepEqual(assetsPlan?.segments, []);
assert.deepEqual(assetsPlan?.originalInput, referenceInput);
const assetsDisplay = parseStructuredAgentOutput(`不得保留的提前分镜正文。\n<!-- storyboard_director_assets:v1 ${JSON.stringify(assetsRaw)} -->`, true);
assert.equal(assetsDisplay.status, "valid");
assert.ok(assetsDisplay.visible_text.includes("三视图生图 Prompt"));
assert.ok(!assetsDisplay.visible_text.includes("图生视频 Prompt"));
assert.ok(!assetsDisplay.visible_text.includes("不得保留的提前分镜正文"));
const noTurnaround = structuredClone(assetsRaw);
noTurnaround.visual_asset_plan.assets[0].reference_prompts[0].kind = "identity" as "turnaround";
assert.ok(validateStoryboardDirectorAssetsPackage(parseStoryboardDirectorAssetsPackage(JSON.stringify(noTurnaround))!).length > 0);

const referencePackage = { ...structuredClone(fixture), input: referenceInput, visual_asset_plan: assetsPackage.visual_asset_plan };
const referenceDetail = { ...detail(referencePackage), expected_input: referenceInput, reference_project_id: "owned-project-123" };
const referenceOutput = `模型越过三视图阶段的分镜正文。\n\`\`\`json\n${JSON.stringify(referencePackage)}\n\`\`\``;
const unverifiedDisplay = parseStructuredAgentOutput(referenceOutput, true);
assert.ok(!unverifiedDisplay.visible_text.includes(referencePackage.segments[0].storyboard_image_prompt));
assert.ok(!unverifiedDisplay.visible_text.includes("模型越过三视图阶段"));
assert.ok(parseStructuredAgentOutput(referenceOutput, true, { hostVerifiedReferenceAssets: true })
  .visible_text.includes(referencePackage.segments[0].storyboard_image_prompt));
assert.equal(parseStoryboardCanvasImport(referenceDetail), null, "仅模型资产声明不能证明人物宠物三视图已完成");
assert.equal(parseStoryboardCanvasImport(referenceDetail, { assetVerification: "preview" })?.pendingAssetVerification, true);
const hostBindings = assets.map((asset, index) => ({ assetId: asset.id, sourceAssetId: `generated_history-${index}`,
  role: asset.role, referenceKind: "turnaround" as const, historyRecordId: `history-${index}` }));
const verifiedReference = parseStoryboardCanvasImport({ ...referenceDetail, verified_asset_bindings: hostBindings });
assert.ok(verifiedReference);
assert.equal(verifiedReference.visualAssetPlan?.assets[0].source?.assetId, "generated_history-0");
assert.equal(parseStoryboardCanvasImport({ ...referenceDetail, verified_asset_bindings: hostBindings.slice(0, 1) }), null);
const continuation = parseStoryboardDirectorIntake(`\`\`\`director_assets_receipt\n{"projectId":"owned-project-123"}\n\`\`\`\n${stableCard}`);
assert.equal(continuation?.referenceProjectId, "owned-project-123");
assert.deepEqual(continuation?.input, intake.input);

// Read existing, versioned evidence only; never claim this static import is a
// new live model run. Tests remain runnable when local evidence is not shipped.
const historical: Array<{ path: string; segments: number; passed: boolean }> = [];
for (const path of [
  ".codex-evidence/storyboard-production-flow/V14_ENERGY_FULL_R1227_20261021_TRY1/chat/package.json",
  ".codex-evidence/storyboard-production-flow/V14_NARRATIVE_FULL_R1229_20261021_STEPUP_V3_TRY1/chat/package.json",
]) {
  if (!existsSync(path)) continue;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const plan = parseStoryboardCanvasImport(detail(pkg, false), { allowLegacyUnverified: true });
  assert.ok(plan, `历史包应保留显式兼容读取：${path}`);
  assert.equal(plan.intakeVerified, false);
  historical.push({ path, segments: plan.segments.length, passed: true });
}
const result = { passed: true, kind: "zero-network-contract-regression", rejectedCases: cases, inputFields: 9,
  sameSourceVisibleAndPushedPrompts: true, assetsOnlyStage: true, requiresIndependentTurnaroundEvidence: true,
  historical, paidRequests: 0 };
const evidence = ".codex-evidence/director-refinement-20261023";
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, "intake-contract-result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
