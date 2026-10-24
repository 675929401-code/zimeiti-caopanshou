import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION,
  parseSegmentedScript,
  parseStoryboardDirectorPlanPackage,
  parseStoryboardDirectorAssetsPackage,
  renderStoryboardDirectorPlanVisibleOutput,
  renderStoryboardDirectorVisibleOutput,
  storyboardDirectorPlanAsStoryboardPackage,
  validateStoryboardDirectorPlanPackage,
  type StoryboardDirectorPlanPackage,
} from "../src/lib/storyboard-director-protocol";
import { parseStructuredAgentOutput, buildStructuredAgentOutputReadyDetail } from "../src/lib/structured-agent-output";
import { parseStoryboardCanvasImport } from "../src/lib/storyboard-canvas-bridge";
import { buildHomepageStoryboardDraftDetail, verifyStoryboardHandoffReferenceAssets } from "../src/lib/agent-workbench-handoff";
import { buildStoryboardDirectorExecution, StoryboardDirectorExecutionSchema } from "../src/lib/storyboard-director-execution";
import { buildStoryboardDirectorReferenceContext, type StoryboardDirectorReferenceDependencies } from "../src/lib/server/storyboard-director-reference-context";

// Authored fixtures exercise production parsers and host gates without media,
// database, provider requests, browser writes, generation or billing.
async function main() {
const directory = path.resolve(".codex-evidence/director-refinement-20261023/continuous-followup");
const raw = await readFile(path.join(directory, "prompt-complete-plan-example.json"), "utf8");
const fixture = JSON.parse(raw) as StoryboardDirectorPlanPackage;
const ordinary = JSON.parse(await readFile(".codex-evidence/director-refinement-20261023/energy-followup/prompt-ordinary-example.json", "utf8"));
const assets = JSON.parse(await readFile(".codex-evidence/director-refinement-20261023/energy-followup/prompt-assets-only-example.json", "utf8"));
const wire = (value: unknown) => `<!-- storyboard_director_plan:v1 ${JSON.stringify(value)} -->`;
const copy = () => structuredClone(fixture);
const checks: string[] = [];
function check(name: string, run: () => void) { run(); checks.push(name); }
function validPlan(value: unknown) {
  const parsed = parseStoryboardDirectorPlanPackage(wire(value));
  assert.ok(parsed);
  assert.deepEqual(validateStoryboardDirectorPlanPackage(parsed, fixture.input), []);
  return parsed;
}
function validPlanForOwnInput(value: unknown) {
  const parsed = parseStoryboardDirectorPlanPackage(wire(value));
  assert.ok(parsed);
  assert.deepEqual(validateStoryboardDirectorPlanPackage(parsed, parsed.input), []);
  return parsed;
}
function detailFor(value: unknown = fixture) {
  const detail = buildHomepageStoryboardDraftDetail({ id: "complete-plan-message", role: "assistant", content: wire(value) }, fixture.input,
    "storyboard_director_contract.v2", { requirePerformancePlan: true });
  assert.ok(detail);
  return detail;
}
function invalid(value: unknown) {
  const parsed = parseStoryboardDirectorPlanPackage(wire(value));
  assert.ok(!parsed || validateStoryboardDirectorPlanPackage(parsed, fixture.input).length > 0);
  assert.equal(parseStructuredAgentOutput(wire(value), true, { expectedInput: fixture.input, requirePerformancePlan: true }).status, "invalid");
}

check("complete_plan_reuses_all_typed_segments_and_performance_without_receipts", () => {
  const parsed = validPlan(fixture);
  assert.equal(parsed.phase, "planned");
  assert.equal(parsed.segments.length, ordinary.segments.length);
  assert.deepEqual(parsed.segments[0].performance_plan, ordinary.segments[0].performance_plan);
  assert.ok(parsed.visual_asset_plan.assets.every(asset => asset.source === undefined));
});
check("production_renderer_shows_each_exact_asset_image_and_video_prompt", () => {
  const visible = renderStoryboardDirectorPlanVisibleOutput(validPlan(fixture));
  for (const asset of fixture.visual_asset_plan.assets) assert.ok(visible.includes(asset.reference_prompts[0].prompt));
  for (const segment of fixture.segments) {
    assert.ok(visible.includes(segment.storyboard_image_prompt));
    assert.ok(visible.includes(segment.image_to_video_prompt));
    assert.ok(visible.includes(segment.performance_plan!.semantic_event));
  }
  assert.ok(visible.includes("尚未生成图片或视频"));
  assert.ok(visible.includes("无需返回智能体"));
});
check("structured_plan_has_real_segments_and_a_distinct_planned_delivery_type", () => {
  const parsed = parseStructuredAgentOutput(wire(fixture), true, { expectedInput: fixture.input });
  assert.equal(parsed.status, "valid");
  if (parsed.status !== "valid") throw new Error("PLAN_RESULT_REQUIRED");
  assert.equal(parsed.phase, "planned");
  assert.equal(parsed.schema_version, STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION);
  assert.equal(parsed.segments[0].image_prompt, fixture.segments[0].storyboard_image_prompt);
  assert.deepEqual(parsed.segments[0].performance_plan, fixture.segments[0].performance_plan);
  assert.equal(buildStructuredAgentOutputReadyDetail("message", parsed)?.phase, "planned");
});
check("plan_can_be_pushed_without_reference_project_or_generated_image_read", () => {
  const detail = detailFor();
  const plan = parseStoryboardCanvasImport(detail);
  assert.ok(plan);
  assert.equal(plan.phase, "planned");
  assert.equal(plan.pendingAssetVerification, undefined);
  assert.equal(plan.referenceProjectId, undefined);
  assert.equal(plan.intakeVerified, true);
  assert.ok(plan.visualAssetPlan?.assets.every(asset => asset.source === undefined));
  assert.deepEqual(plan.segments[0].visualAssetRefs?.map(ref => ref.assetId), fixture.segments[0].character_asset_ids);
});
check("model_sources_urls_history_and_confirmation_never_become_plan_evidence", () => {
  const forged = copy() as unknown as Record<string, unknown>;
  const assetPlan = forged.visual_asset_plan as { assets: Array<Record<string, unknown>> };
  assetPlan.assets[0].source = { kind: "generated-image-history", asset_id: "forged-image", history_record_id: "a".repeat(64) };
  assetPlan.assets[0].previewUrl = "https://example.invalid/forged-image.png";
  assetPlan.assets[0].history_record_id = "forged-history";
  assetPlan.assets[0].derived_from_asset_id = "forged-image";
  forged.confirmedAssets = [{ sourceAssetId: "forged-image" }];
  forged.verified_asset_bindings = [{ sourceAssetId: "forged-image" }];
  const parsed = validPlan(forged);
  assert.ok(!JSON.stringify(parsed).includes("forged-"));
  const detail = detailFor(forged);
  detail.reference_project_id = "forged-project";
  detail.verified_asset_bindings = [{ assetId: "owner_001", sourceAssetId: "forged-image", role: "character", referenceKind: "turnaround", historyRecordId: "a".repeat(64) }];
  const imported = parseStoryboardCanvasImport(detail);
  assert.ok(imported);
  assert.equal(imported.referenceProjectId, undefined);
  assert.ok(imported.visualAssetPlan?.assets.every(asset => asset.source === undefined));
});
check("malformed_model_source_is_discarded_before_legacy_source_normalization", () => {
  const forged = copy() as unknown as { visual_asset_plan: { assets: Array<Record<string, unknown>> } };
  forged.visual_asset_plan.assets[0].source = "not-a-receipt";
  validPlan(forged);
});
check("model_pass_on_visual_binding_is_reset_to_pending_runtime_verification", () => {
  const forged = copy();
  forged.segments[0].quality_checks = [{ check_id: "role_binding", status: "pass", detail: "模型声称已确认图片", verification: { kind: "visual_asset_binding", asset_ids: ["owner_001", "pet_001"] } }];
  const parsed = validPlan(forged);
  assert.equal(parsed.segments[0].quality_checks![0].status, "unknown");
  const plan = parseStoryboardCanvasImport(detailFor(forged));
  assert.equal(plan?.pendingRuntimePrerequisites?.[0].verification.kind, "visual_asset_binding");
});
check("input_receipt_mismatch_still_blocks_the_new_plan", () => {
  const changed = copy(); changed.input.dog_breed = "柯基";
  assert.equal(buildHomepageStoryboardDraftDetail({ id: "changed-input", role: "assistant", content: wire(changed) }, fixture.input), null);
});
check("streaming_and_error_messages_never_publish_a_plan", () => {
  assert.equal(buildHomepageStoryboardDraftDetail({ id: "streaming", role: "assistant", content: wire(fixture), isStreaming: true }, fixture.input), null);
  assert.equal(buildHomepageStoryboardDraftDetail({ id: "failed", role: "assistant", content: wire(fixture), error: "incomplete" }, fixture.input), null);
});
check("unclosed_plan_transport_stays_hidden_and_cannot_fall_back_to_text_blocks", () => {
  const text = wire(fixture).slice(0, -3);
  const streaming = parseStructuredAgentOutput(text, false);
  assert.equal(streaming.status, "incomplete");
  assert.ok(!streaming.visible_text.includes("machine_payload"));
  assert.ok(!streaming.visible_text.includes("character_asset_ids"));
  assert.equal(parseStructuredAgentOutput(text, true).status, "invalid");
});
check("new_plan_always_requires_performance_even_without_a_server_flag", () => {
  const value = copy(); delete value.segments[0].performance_plan; invalid(value);
});
check("foreign_reference_id_is_rejected", () => {
  const value = copy(); value.segments[0].visual_asset_refs![0].asset_id = "foreign_actor"; invalid(value);
});
check("wrong_reference_role_is_rejected", () => {
  const value = copy(); value.segments[0].visual_asset_refs![0].role = "pet"; invalid(value);
});
check("every_actor_requires_one_turnaround_reference_without_duplicates", () => {
  const missing = copy(); missing.segments[0].visual_asset_refs!.pop(); invalid(missing);
  const duplicate = copy(); duplicate.segments[0].visual_asset_refs!.push(structuredClone(duplicate.segments[0].visual_asset_refs![0])); invalid(duplicate);
  const wrongKind = copy(); wrongKind.segments[0].visual_asset_refs![0].reference_kinds = ["identity"]; invalid(wrongKind);
});
check("reference_mode_follows_actual_character_and_pet_roles_without_manufacturing_missing_roles", () => {
  const build = (assetIds: string[]) => {
    const value = copy();
    value.visual_asset_plan.assets = value.visual_asset_plan.assets.filter(asset => assetIds.includes(asset.id));
    value.visual_asset_plan.generation_policy!.initial_required_asset_ids = assetIds;
    value.segments[0].character_asset_ids = assetIds;
    value.segments[0].character_assets = value.visual_asset_plan.assets.map(asset => asset.identity_lock);
    value.segments[0].visual_asset_refs = value.visual_asset_plan.assets.map(asset => ({
      asset_id: asset.id, role: asset.role, reference_kinds: ["turnaround" as const],
    }));
    const expression = value.segments[0].performance_plan!.expressions[0];
    value.segments[0].performance_plan!.expressions = value.visual_asset_plan.assets.map(asset => ({
      ...expression, actor_asset_id: asset.id, actor_role: asset.role === "pet" ? "pet" : "character",
    }));
    value.segments[0].storyboard_image_prompt += value.visual_asset_plan.assets.map(asset => asset.identity_lock).join(" ");
    return value;
  };
  const petOnly = build(["pet_001"]);
  const personOnly = build(["owner_001"]);
  assert.ok(validPlanForOwnInput(petOnly));
  assert.ok(validPlanForOwnInput(personOnly));
  const visible = renderStoryboardDirectorVisibleOutput(storyboardDirectorPlanAsStoryboardPackage(validPlanForOwnInput(petOnly)));
  assert.ok(visible.includes("计划中所需的角色参考图"));
  assert.ok(!visible.includes("人物和宠物三视图"));

  const many = build(["owner_001", "pet_001"]);
  const character = many.visual_asset_plan.assets.find(asset => asset.id === "owner_001")!;
  const pet = many.visual_asset_plan.assets.find(asset => asset.id === "pet_001")!;
  const extraCharacter = { ...character, id: "owner_002", name: "第二人物",
    identity_lock: "第二人物的固定身份、发型、衣着与材质。",
    reference_prompts: character.reference_prompts.map(reference => ({ ...reference, prompt: `${reference.prompt} 第二人物。` })) };
  const extraPet = { ...pet, id: "pet_002", name: "第二宠物",
    identity_lock: "第二宠物的固定物种、毛区、项圈与身体比例。",
    reference_prompts: pet.reference_prompts.map(reference => ({ ...reference, prompt: `${reference.prompt} 第二宠物。` })) };
  many.visual_asset_plan.assets.push(extraCharacter, extraPet);
  const allIds = many.visual_asset_plan.assets.map(asset => asset.id);
  many.visual_asset_plan.generation_policy!.max_initial_images = allIds.length;
  many.visual_asset_plan.generation_policy!.initial_required_asset_ids = allIds;
  many.segments[0].character_asset_ids = allIds;
  many.segments[0].character_assets = many.visual_asset_plan.assets.map(asset => asset.identity_lock);
  many.segments[0].visual_asset_refs = many.visual_asset_plan.assets.map(asset => ({ asset_id: asset.id, role: asset.role, reference_kinds: ["turnaround" as const] }));
  const manyExpression = many.segments[0].performance_plan!.expressions[0];
  many.segments[0].performance_plan!.expressions = many.visual_asset_plan.assets.map(asset => ({ ...manyExpression, actor_asset_id: asset.id, actor_role: asset.role === "pet" ? "pet" : "character" }));
  many.segments[0].storyboard_image_prompt += many.visual_asset_plan.assets.map(asset => asset.identity_lock).join(" ");
  assert.ok(validPlanForOwnInput(many));
});
check("duplicate_project_asset_ids_are_rejected", () => {
  const value = copy(); value.visual_asset_plan.assets.push(structuredClone(value.visual_asset_plan.assets[0])); invalid(value);
});
check("unknown_performance_peak_shot_is_rejected", () => {
  const value = copy(); value.segments[0].performance_plan!.peak_shot_id = "foreign_shot"; invalid(value);
});
check("missing_actor_expression_is_rejected", () => {
  const value = copy(); value.segments[0].performance_plan!.expressions.pop(); invalid(value);
});
check("broken_prompt_literal_anchor_is_rejected", () => {
  const value = copy(); value.segments[0].storyboard_image_prompt = value.segments[0].storyboard_image_prompt.replace(value.segments[0].performance_plan!.image_excerpt, "缺失表演主峰"); invalid(value);
});
check("incomplete_source_segment_coverage_is_rejected", () => {
  const value = copy(); value.input.segmented_script += "\n2.【第二段原文必须保留。】"; invalid(value);
});
check("markdown_escaped_numbering_splits_at_line_start_without_rewriting_copy", () => {
  const input = String.raw`1\.第一段保留不一定与标点。
2\.第二段保留原词；正文中的3\.不另拆。`;
  assert.deepEqual(parseSegmentedScript(input).map(segment => [segment.source_index, segment.narration]), [
    [1, "第一段保留不一定与标点。"], [2, String.raw`第二段保留原词；正文中的3\.不另拆。`],
  ]);
  assert.equal(parseSegmentedScript("1.常规段落\n2、中文编号").length, 2);
});
check("escaped_source_numbering_does_not_weaken_original_input_equality", () => {
  const value = copy();
  value.input.segmented_script = `1\\.【${value.segments[0].narration}】`;
  const parsed = parseStoryboardDirectorPlanPackage(wire(value)); assert.ok(parsed);
  assert.deepEqual(validateStoryboardDirectorPlanPackage(parsed, value.input), []);
  assert.ok(validateStoryboardDirectorPlanPackage(parsed, fixture.input).includes("input_segmented_script_mismatch"));
  value.segments[0].narration = `1.${value.segments[0].narration}`;
  assert.ok(validateStoryboardDirectorPlanPackage(parseStoryboardDirectorPlanPackage(wire(value))!, value.input).includes("segment_001:source_not_preserved"));
});
check("ordinary_mode_does_not_silently_turn_into_a_reference_plan", () => {
  const value = copy(); value.input.visual_asset_mode = "普通模式"; invalid(value);
});
check("wrong_plan_phase_or_version_is_rejected", () => {
  assert.equal(parseStoryboardDirectorPlanPackage(wire({ ...fixture, phase: "storyboard" })), null);
  assert.equal(parseStoryboardDirectorPlanPackage(wire({ ...fixture, schema_version: "storyboard_director_plan.v99" })), null);
});
check("old_assets_package_remains_readable_and_has_no_segments", () => {
  assert.ok(parseStoryboardDirectorAssetsPackage(JSON.stringify(assets)));
  const parsed = parseStructuredAgentOutput(`<!-- storyboard_director_assets:v1 ${JSON.stringify(assets)} -->`);
  assert.equal(parsed.status, "valid");
  if (parsed.status !== "valid") throw new Error("ASSETS_RESULT_REQUIRED");
  assert.equal(parsed.phase, "assets"); assert.equal(parsed.segments.length, 0);
});
check("old_reference_storyboard_still_requires_real_host_bindings", () => {
  const old = storyboardDirectorPlanAsStoryboardPackage(fixture);
  const result = parseStructuredAgentOutput(JSON.stringify(old), true, { expectedInput: fixture.input });
  const detail = buildStructuredAgentOutputReadyDetail("old-reference", result);
  assert.ok(detail); detail.expected_input = fixture.input;
  assert.equal(parseStoryboardCanvasImport(detail), null);
  assert.equal(parseStoryboardCanvasImport(detail, { assetVerification: "preview" })?.pendingAssetVerification, true);
  assert.ok(!renderStoryboardDirectorVisibleOutput(old).includes(old.segments[0].storyboard_image_prompt));
});
check("ordinary_package_still_imports_without_role_image_receipts", () => {
  const detail = buildHomepageStoryboardDraftDetail({ id: "ordinary", role: "assistant", content: JSON.stringify(ordinary) }, ordinary.input);
  assert.ok(detail);
  assert.equal(parseStoryboardCanvasImport(detail)?.phase, "storyboard");
});
check("planned_performance_survives_execution_schema_and_json_restore", () => {
  const plan = parseStoryboardCanvasImport(detailFor()); assert.ok(plan);
  const execution = buildStoryboardDirectorExecution(plan, plan.segments[0]);
  assert.deepEqual(StoryboardDirectorExecutionSchema.parse(JSON.parse(JSON.stringify(execution))).performancePlan, fixture.segments[0].performance_plan);
});

let fetches = 0;
const verified = await verifyStoryboardHandoffReferenceAssets({ ...detailFor(), reference_project_id: "forged-project", verified_asset_bindings: [] }, {
  userId: "fixture-user", token: "fixture-token", fetcher: async () => { fetches++; throw new Error("NETWORK_FORBIDDEN"); },
});
assert.equal(fetches, 0); assert.equal(verified.reference_project_id, undefined); assert.equal(verified.verified_asset_bindings, undefined);
checks.push("plan_handoff_does_not_query_or_claim_generated_reference_images");

const calls = { project: 0, image: 0, readable: 0 };
const deps: StoryboardDirectorReferenceDependencies = {
  async loadOwnedProject() { calls.project++; throw new Error("DATABASE_FORBIDDEN"); },
  async loadOwnedImage() { calls.image++; throw new Error("DATABASE_FORBIDDEN"); },
  async verifyReadableImage() { calls.readable++; throw new Error("NETWORK_FORBIDDEN"); },
};
const agentId = "agent-1786843330392-emdjv2";
const content = Object.entries(fixture.input).filter(([key]) => key !== "schema_version").map(([key, value]) => `${key}: ${value}`).join("\n");
const request = { agentId, agentRow: { id: agentId, system_prompt: "storyboard_director_contract.v2 storyboard_director_plan.v1" }, verifiedUserId: "fixture-user", messages: [{ role: "user", content }] };
const context = await buildStoryboardDirectorReferenceContext(request, deps);
assert.ok(context.includes("[HOST_DIRECTOR_PLAN]"));
assert.ok(context.includes('"referenceImagesVerified":false'));
assert.ok(context.includes('"visual_asset_mode":"参考图模式"'));
assert.deepEqual(calls, { project: 0, image: 0, readable: 0 });
checks.push("actual_server_plan_prompt_enables_first_reference_plan_with_zero_media_reads");
const oldContext = await buildStoryboardDirectorReferenceContext({ ...request, agentRow: { id: agentId, system_prompt: "storyboard_director_contract.v2" } }, deps);
assert.ok(oldContext.includes("[HOST_ASSETS_PENDING]"));
assert.deepEqual(calls, { project: 0, image: 0, readable: 0 });
checks.push("legacy_server_prompt_preserves_assets_only_first_response");
const ordinaryContext = await buildStoryboardDirectorReferenceContext({ ...request, messages: [{ role: "user", content: content.replace("visual_asset_mode: 参考图模式", "visual_asset_mode: 普通模式") }] }, deps);
assert.ok(ordinaryContext.includes("[HOST_ASSETS_NOT_REQUIRED]"));
checks.push("ordinary_server_context_is_unchanged");
const otherContext = await buildStoryboardDirectorReferenceContext({ ...request, agentId: "other-agent" }, deps);
assert.equal(otherContext, ""); checks.push("other_agents_receive_no_new_plan_instruction");

await mkdir(directory, { recursive: true });
const report = { passed: true, checkedAt: new Date().toISOString(), scope: "zero_network_complete_plan_protocol_and_handoff", checks,
  fixtureSha256: createHash("sha256").update(raw).digest("hex"), networkCalls: fetches, databaseCalls: calls, llmCalls: 0, imageGenerations: 0, videoGenerations: 0,
  limitations: ["Authored plan fixtures do not establish generated-media quality.", "Workbench confirmation, orchestration and real browser delivery are separate integration checks."] };
await writeFile(path.join(directory, "plan-protocol-result.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
