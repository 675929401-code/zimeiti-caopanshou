import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildHomepageStoryboardDraftDetail, createAgentWorkbenchHandoff, verifyStoryboardHandoffReferenceAssets } from "../src/lib/agent-workbench-handoff";
import { collectStoryboardDirectorReferenceBindings } from "../src/lib/storyboard-director-reference-verification";
import { parseStructuredAgentOutput } from "../src/lib/structured-agent-output";
import type { StoryboardDirectorInput, StoryboardDirectorPackage } from "../src/lib/storyboard-director-protocol";

const input: StoryboardDirectorInput = {
  schema_version: "storyboard_director_input.v1", segmented_script: "1.【女孩抬手，小狗回头。】", director_mode: "high_energy",
  animation_style: "温暖家庭3D动画电影", aspect_ratio: "16:9", target_duration_seconds: 10,
  special_notes: "保持人物衣着与宠物身份一致。", visual_asset_mode: "参考图模式", owner_gender: "女主人", dog_breed: "金毛", video_model_profile: "自动通用",
};
const person = "28岁成年女孩，黑色齐肩直发、米色针织毛衣、蓝色牛仔裤、白色运动鞋，无首饰。";
const pet = "成年蜂蜜金色金毛，棕色眼睛，红色项圈，垂耳和蓬松长尾，完整四足。";
const assets = [
  { id: "owner_main", role: "character" as const, name: "女孩", identity_lock: person, allowed_changes: ["表情姿态"],
    reference_prompts: [{ kind: "turnaround" as const, purpose: "锁定人物正侧背视角", prompt: `单张人物正面、侧面、背面三视图，浅灰背景，全身完整等比例。${person}` }] },
  { id: "pet_main", role: "pet" as const, name: "金毛", identity_lock: pet, allowed_changes: ["表情姿态"],
    reference_prompts: [{ kind: "turnaround" as const, purpose: "锁定宠物正侧背视角", prompt: `单张宠物正面、侧面、背面三视图，浅灰背景，四肢尾巴完整等比例。${pet}` }] },
];
const pkg: StoryboardDirectorPackage = {
  schema_version: "storyboard_director_output.v1", artifact_type: "storyboard_director_package", production_contract_version: "storyboard_director_contract.v2",
  director_mode: "high_energy", input, phase: "storyboard", visual_asset_plan: { mode: "selected", assets,
    generation_policy: { max_initial_images: 2, initial_required_asset_ids: assets.map(asset => asset.id), initial_deferred_asset_ids: [], environment_anchor_policy: "none" } },
  wardrobe_plan: { base_look: person, continuity_rule: "全片保持米色毛衣、蓝色牛仔裤、白鞋，只有表情姿态改变。", change_events: [] },
  segments: [{ segment_id: "segment_001", source_index: 1, narration: "女孩抬手，小狗回头。", target_duration_seconds: 10, estimated_narration_duration: 2,
    panel_count: 4, layout: "two_by_two", pacing_mode: "fast", actual_shot_count: 3, panoramic_anchor_role: null,
    shot_time_ranges: [
      { shot_id: "shot_01", start_seconds: 0, end_seconds: 3, action_beat: "女孩抬手" },
      { shot_id: "shot_02", start_seconds: 3, end_seconds: 7, action_beat: "小狗回头" },
      { shot_id: "shot_03", start_seconds: 7, end_seconds: 10, action_beat: "视线交流后稳定" },
    ], continuity_links: [
      { from_shot: "shot_01", to_shot: "shot_02", link_type: "action_bridge", description: "抬手动作引导狗狗回头" },
      { from_shot: "shot_02", to_shot: "shot_03", link_type: "eyeline_match", description: "视线匹配衔接人物眼神" },
    ], character_assets: [person, pet], character_asset_ids: ["owner_main", "pet_main"],
    semantic_visualizations: [{ trigger: "安心", visual_form: "耳朵放松", interaction: "随着抬头动作放松" }],
    storyboard_image_prompt: `严格四格2x2故事板，每格底部等高英文注释栏。${person}${pet}女孩抬手，小狗回头。`,
    image_to_video_prompt: "10秒3镜头，0-3秒抬手，3-7秒回头，7-10秒目光交流后稳定。只留脚步和衣料声，无对白、无旁白。",
  }],
};
const projectId = "reference-project-owned-001";
const records = ["a".repeat(64), "b".repeat(64)];
const document = {
  id: projectId, directorIntake: { phase: "assets", input, confirmedAssets: assets.map((asset, i) => ({ planId: asset.id, sourceAssetId: `generated_${records[i]}`, historyRecordId: records[i], role: asset.role, confirmedAt: "2026-10-23T12:00:00.000Z" })) },
  visualAssetPlan: { mode: "selected", assets: assets.map((asset, i) => ({ id: asset.id, role: asset.role, identityLock: asset.identity_lock,
    referencePrompts: asset.reference_prompts, source: { kind: "generated-image-history", assetId: `generated_${records[i]}`, historyRecordId: records[i] } })) },
  visualAssetWorkspace: { candidates: assets.map((asset, i) => ({ planId: asset.id, assetId: `generated_${records[i]}`, historyRecordId: records[i], role: asset.role, prompt: asset.reference_prompts[0].prompt })) },
};
const checks: string[] = [];
const message = { id: "reference-output", role: "assistant" as const, content: JSON.stringify(pkg) };
const detail = () => buildHomepageStoryboardDraftDetail(message, input, "storyboard_director_contract.v2", { referenceProjectId: projectId, previewAssetVerification: true })!;
const owner = { userId: "user-A", token: "zero-network-fixture", assertCurrent: () => {} };

async function main() {
  assert.ok(detail(), "reference package must pass preview only");
  assert.equal(createAgentWorkbenchHandoff(detail(), "storyboard-workbench"), null, "unverified references cannot persist a handoff");
  assert.ok(!parseStructuredAgentOutput(message.content, true).visible_text.includes(pkg.segments[0].storyboard_image_prompt));
  checks.push("unverified reference output stays hidden and cannot be sent");
  const calls: string[] = [];
  const fetcher: typeof fetch = async url => {
    calls.push(String(url));
    if (String(url).startsWith("/api/storyboard/projects?")) return Response.json({ project: { id: projectId, document } });
    const recordId = new URL(String(url), "http://unit.invalid").searchParams.get("recordId");
    assert.ok(records.includes(recordId!));
    return Response.json({ reference: { recordId, previewUrl: `/owned/${recordId}.png` } });
  };
  const verified = await verifyStoryboardHandoffReferenceAssets(detail(), { ...owner, fetcher });
  assert.equal(verified.verified_asset_bindings?.length, 2);
  assert.ok(createAgentWorkbenchHandoff(verified, "storyboard-workbench"));
  assert.ok(parseStructuredAgentOutput(message.content, true, { hostVerifiedReferenceAssets: true }).visible_text.includes(pkg.segments[0].storyboard_image_prompt));
  assert.equal(calls.length, 3); assert.ok(calls.every(url => url.startsWith("/api/storyboard/")));
  checks.push("owned project and both real generation records unlock the exact machine prompts");
  for (const mutation of [
    (doc: typeof document) => { doc.directorIntake.confirmedAssets = []; },
    (doc: typeof document) => { doc.directorIntake.confirmedAssets.pop(); },
    (doc: typeof document) => { doc.directorIntake.confirmedAssets[0].role = "pet"; },
    (doc: typeof document) => { doc.visualAssetWorkspace.candidates[0].role = "pet"; },
    (doc: typeof document) => { doc.directorIntake.input.aspect_ratio = "9:16"; },
    (doc: typeof document) => { doc.visualAssetPlan.assets.pop(); },
    (doc: typeof document) => { doc.visualAssetPlan.assets[1].source.kind = "uploaded-image"; },
    (doc: typeof document) => { doc.visualAssetWorkspace.candidates.pop(); },
    (doc: typeof document) => { doc.visualAssetPlan.assets[1].source.historyRecordId = "fake"; },
  ]) {
    const changed = structuredClone(document); mutation(changed);
    assert.throws(() => collectStoryboardDirectorReferenceBindings(changed, input));
  }
  checks.push("changed card, missing pet, upload substitution, missing candidate and fake history fail closed");
  await assert.rejects(verifyStoryboardHandoffReferenceAssets(detail(), { ...owner, fetcher: async () => Response.json({ error: "not owned" }, { status: 404 }) }));
  await assert.rejects(verifyStoryboardHandoffReferenceAssets(detail(), { ...owner, fetcher: async url => String(url).startsWith("/api/storyboard/projects?")
    ? Response.json({ project: { id: projectId, document } }) : Response.json({ error: "record not owned" }, { status: 403 }) }));
  let ownerChecks = 0;
  await assert.rejects(verifyStoryboardHandoffReferenceAssets(detail(), { ...owner, fetcher, assertCurrent: () => { if (++ownerChecks > 1) throw Error("account changed"); } }));
  checks.push("foreign projects, unavailable history and an account switch during readback do not unlock prompts");
  const assetsOnly = { schema_version: "storyboard_director_assets.v1", artifact_type: "storyboard_director_assets", phase: "assets",
    production_contract_version: "storyboard_director_contract.v2", director_mode: "high_energy", input,
    wardrobe_plan: pkg.wardrobe_plan, visual_asset_plan: pkg.visual_asset_plan };
  const assetsDetail = buildHomepageStoryboardDraftDetail({ ...message, content: JSON.stringify(assetsOnly) }, input, "storyboard_director_contract.v2");
  assert.ok(assetsDetail); assert.equal(assetsDetail.phase, "assets");
  assert.ok(createAgentWorkbenchHandoff(assetsDetail, "storyboard-workbench"));
  assert.ok(!parseStructuredAgentOutput(JSON.stringify(assetsOnly), true).visible_text.includes("图生视频 Prompt"));
  checks.push("assets-only output can reach the workbench without releasing storyboard prompts");
  const result = { ok: true, checks, paidRequests: 0, networkRequests: 0, mockedOwnedReads: calls.length };
  mkdirSync(".codex-evidence/director-refinement-20261023/mode-followup", { recursive: true });
  writeFileSync(".codex-evidence/director-refinement-20261023/mode-followup/reference-handoff-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
