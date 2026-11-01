import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { STORYBOARD_PERFORMANCE_CONTRACT_VERSION, STORYBOARD_PERFORMANCE_MODES, StoryboardPerformancePlanSchema, validateStoryboardPerformancePlan, type StoryboardPerformancePlan } from "../src/lib/storyboard-director-performance";
import { parseStoryboardDirectorPackage, parseStoryboardDirectorAssetsPackage, renderStoryboardDirectorVisibleOutput, validateStoryboardDirectorPackage } from "../src/lib/storyboard-director-protocol";
import { parseStructuredAgentOutput, buildStructuredAgentOutputReadyDetail } from "../src/lib/structured-agent-output";
import { parseStoryboardCanvasImport } from "../src/lib/storyboard-canvas-bridge";
import { buildStoryboardDirectorExecution, StoryboardDirectorExecutionSchema, compileStoryboardDirectorVideoPrompt } from "../src/lib/storyboard-director-execution";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { sanitizeStoryboardPersistenceValue } from "../src/lib/storyboard-local-persistence";
import { buildHomepageStoryboardDraftDetail, resolveStoryboardHandoffContract } from "../src/lib/agent-workbench-handoff";

const owner = "男主人阿林：年轻成年亚洲男性，黑棕短发、墨绿棉卫衣、卡其长裤、白色运动鞋、左腕黑表，全片身份固定。";
const pet = "金毛豆豆：金色长毛、浅金胸毛、下垂耳、黑鼻头、羽状尾、深蓝项圈，四足比例与毛色全片固定。";
const narration = "金毛绕开高举的玩具，把肩膀轻贴主人裤腿，它想要的是靠近。";
const input = { schema_version: "storyboard_director_input.v1" as const, segmented_script: `1.【${narration}】`, director_mode: "high_energy" as const,
  animation_style: "黏土定格质感3D动画", aspect_ratio: "9:16" as const, target_duration_seconds: 10 as const, special_notes: "男主人穿墨绿卫衣和卡其长裤。",
  owner_gender: "男主人", dog_breed: "金毛", video_model_profile: "自动通用", visual_asset_mode: "普通模式" };
function performance(mode: StoryboardPerformancePlan["mode"] = "action_peak"): StoryboardPerformancePlan {
  const action_chain = { setup: "主人右手把蓝球举至胸前。", drive: "金毛向主人左裤腿迈出两步。", contact: "金毛肩侧轻贴卡其裤料。", feedback: "裤料被肩毛压出一条浅褶。", settle: "主人放下蓝球并低头停留。" };
  const expressions: StoryboardPerformancePlan["expressions"] = [
    { actor_asset_id: "owner_001", actor_role: "character", trigger: "主人发现狗绕开蓝色玩具。", before: "主人眉头微抬且视线看球。", peak: "主人瞳孔下移且嘴角刚松开。", release: "主人眉眼放松并保持闭口。" },
    { actor_asset_id: "pet_001", actor_role: "pet", trigger: "金毛看见主人抬高了玩具。", before: "金毛耳根微前送且视线向上。", peak: "金毛视线落向裤腿且耳根放松。", release: "金毛尾巴轻摆一次后呼吸放缓。" },
  ];
  const end_state = "蓝球回到地面，金毛仍贴着裤腿。";
  return { schema_version: STORYBOARD_PERFORMANCE_CONTRACT_VERSION, mode, peak_shot_id: "shot_002", semantic_event: "金毛绕过玩具而贴近裤腿，让陪伴意图成为可见事件。", action_chain, expressions,
    image_excerpt: ["肩侧接触裤腿的峰值瞬间：", ...expressions.map(value => value.peak)].join("\n"),
    video_excerpt: [...Object.values(action_chain), ...expressions.flatMap(value => [value.trigger, value.before, value.peak, value.release]), end_state].join("\n"), end_state };
}
function fixture(withPerformance = true) {
  const plan = performance();
  return { schema_version: "storyboard_director_output.v1", artifact_type: "storyboard_director_package", production_contract_version: "storyboard_director_contract.v2", phase: "storyboard", director_mode: "high_energy",
    input: structuredClone(input), visual_asset_plan: { mode: "off", assets: [] }, segments: [{ segment_id: "segment_001", source_index: 1, narration,
      target_duration_seconds: 10, estimated_narration_duration: 5, panel_count: 4, layout: "two_by_two", pacing_mode: "medium", actual_shot_count: 3,
      shot_time_ranges: [{ shot_id: "shot_001", start_seconds: 0, end_seconds: 3, action_beat: "主人抬球，金毛观察主人手势。" },
        { shot_id: "shot_002", start_seconds: 3, end_seconds: 7, action_beat: "金毛绕球贴腿，主人视线随之下移。" },
        { shot_id: "shot_003", start_seconds: 7, end_seconds: 10, action_beat: "主人放下蓝球，金毛稳定靠近。" }],
      panoramic_anchor_role: null, bottom_panel_role: "none", character_asset_ids: ["owner_001", "pet_001"], character_assets: [owner, pet], visual_asset_refs: [],
      continuity_links: [{ from_shot: "shot_001", to_shot: "shot_002", link_type: "action_match", description: "举球方向承接金毛绕球的视线与运动。" },
        { from_shot: "shot_002", to_shot: "shot_003", link_type: "contact_match", description: "肩膀与裤腿接触保持到最后的稳定状态。" }],
      semantic_visualizations: [{ trigger: "想要靠近", visual_form: "蓝球和裤腿成为两个具体目标", interaction: "绕开蓝球而轻贴裤腿" }],
      storyboard_image_prompt: `9:16竖幅2×2四格故事板。\n${owner}\n${pet}\n${plan.image_excerpt}`,
      image_to_video_prompt: `10秒连续动画，先观察再靠近。第1镜0-3秒，第2镜3-7秒，第3镜7-10秒。\n${plan.video_excerpt}\n无对白、无旁白、无配乐；仅保留与场景一致的环境声与动作声。`,
      ...(withPerformance ? { performance_plan: plan } : {}) }] };
}
const wire = (value: unknown) => `<!-- storyboard_director_output:v1 ${JSON.stringify(value)} -->`;
const checks: string[] = [];
function check(name: string, run: () => void) { run(); checks.push(name); }
const originalFetch = globalThis.fetch;
let networkRequests = 0;
globalThis.fetch = (() => { networkRequests++; throw new Error("FORBIDDEN_NETWORK"); }) as typeof fetch;
try {
  for (const mode of STORYBOARD_PERFORMANCE_MODES) check(`strict structural plan accepts ${mode} without claiming artistic quality`, () => {
    assert.equal(StoryboardPerformancePlanSchema.parse(performance(mode)).mode, mode);
  });
  const context = { shotIds: ["shot_001", "shot_002", "shot_003"], actorIds: ["owner_001", "pet_001"], imagePrompt: performance().image_excerpt, videoPrompt: performance().video_excerpt };
  check("all authored action and expression evidence is anchored to the real prompts", () => assert.deepEqual(validateStoryboardPerformancePlan(performance(), context), []));
  for (const [name, mutate] of [
    ["unknown schema key", (plan: Record<string, unknown>) => { plan.score = 99; }],
    ["unknown version", (plan: Record<string, unknown>) => { plan.schema_version = "storyboard_performance.v9"; }],
    ["blank setup", (plan: Record<string, unknown>) => { (plan.action_chain as Record<string, unknown>).setup = "    "; }],
    ["field label placeholder", (plan: Record<string, unknown>) => { (plan.action_chain as Record<string, unknown>).setup = "setup"; }],
    ["repeated chain placeholder", (plan: Record<string, unknown>) => { plan.action_chain = Object.fromEntries(["setup", "drive", "contact", "feedback", "settle"].map(key => [key, "角色保持同一姿态。"])); }],
    ["duplicate actor", (plan: Record<string, unknown>) => { (plan.expressions as unknown[]).push((plan.expressions as unknown[])[0]); }],
  ] as const) check(`strict schema rejects ${name}`, () => { const value = structuredClone(performance()) as unknown as Record<string, unknown>; mutate(value); assert.equal(StoryboardPerformancePlanSchema.safeParse(value).success, false); });
  for (const field of ["setup", "drive", "contact", "feedback", "settle"] as const) check(`video evidence rejects missing ${field}`, () => {
    const value = performance(); value.video_excerpt = value.video_excerpt.replace(value.action_chain[field], ""); assert.equal(StoryboardPerformancePlanSchema.safeParse(value).success, false);
  });
  for (const field of ["trigger", "before", "peak", "release"] as const) check(`video evidence rejects missing expression ${field}`, () => {
    const value = performance(); value.video_excerpt = value.video_excerpt.replace(value.expressions[0][field], ""); assert.equal(StoryboardPerformancePlanSchema.safeParse(value).success, false);
  });
  check("image evidence requires every actor peak and video requires the end state", () => {
    const missingPeak = performance(); missingPeak.image_excerpt = "只有金毛肩侧与裤料接触的瞬间，没有人物或宠物表情。"; assert.equal(StoryboardPerformancePlanSchema.safeParse(missingPeak).success, false);
    const missingEnd = performance(); missingEnd.video_excerpt = missingEnd.video_excerpt.replace(missingEnd.end_state, ""); assert.equal(StoryboardPerformancePlanSchema.safeParse(missingEnd).success, false);
  });
  check("foreign shot and missing or foreign actors cannot satisfy coverage", () => {
    const foreignShot = performance(); foreignShot.peak_shot_id = "shot_foreign"; assert.ok(validateStoryboardPerformancePlan(foreignShot, context).includes("performance_peak_shot_unknown"));
    assert.ok(validateStoryboardPerformancePlan(performance(), { ...context, actorIds: ["owner_001"] }).includes("performance_expression_actor_coverage_mismatch"));
    assert.ok(validateStoryboardPerformancePlan(performance(), { ...context, actorIds: ["owner_001", "stranger_001"] }).includes("performance_expression_actor_coverage_mismatch"));
  });
  check("reference roles can be checked while ordinary roles are not inferred from prose", () => {
    assert.deepEqual(validateStoryboardPerformancePlan(performance(), { ...context, referenceRoles: new Map([["owner_001", "character"], ["pet_001", "pet"]]) }), []);
    assert.ok(validateStoryboardPerformancePlan(performance(), { ...context, referenceRoles: new Map([["owner_001", "pet"], ["pet_001", "character"]]) }).includes("performance_expression_role_mismatch"));
  });
  check("real prompt mismatch is rejected even when the metadata is complete", () => {
    assert.ok(validateStoryboardPerformancePlan(performance(), { ...context, imagePrompt: "另外一张图" }).includes("performance_image_excerpt_missing"));
    assert.ok(validateStoryboardPerformancePlan(performance(), { ...context, videoPrompt: "另一段视频" }).includes("performance_video_excerpt_missing"));
  });
  check("optional historical v2 stays readable but a new requirement rejects omitted plans and self tags", () => {
    const legacy = fixture(false); const parsed = parseStoryboardDirectorPackage(wire(legacy)); assert.ok(parsed);
    assert.deepEqual(validateStoryboardDirectorPackage(parsed, input), []);
    assert.equal(parseStructuredAgentOutput(wire(legacy), true, { requirePerformancePlan: false }).status, "valid");
    assert.equal(parseStructuredAgentOutput(wire({ ...legacy, performance_contract: STORYBOARD_PERFORMANCE_CONTRACT_VERSION, pass: true }), true, { requirePerformancePlan: true }).status, "invalid");
    assert.equal(parseStoryboardCanvasImport({ source: "stable_json", schema_version: legacy.schema_version, machine_payload: legacy, expected_input: input, require_performance_plan: true }), null);
    assert.equal(buildHomepageStoryboardDraftDetail({ id: "message", role: "assistant", content: wire(legacy) }, input, undefined, { requirePerformancePlan: true }), null);
    assert.ok(buildHomepageStoryboardDraftDetail({ id: "message", role: "assistant", content: wire(legacy) }, input, undefined, { requirePerformancePlan: false }));
  });
  check("ordinary and reference asset preparation does not require a shot performance", () => {
    const assets = fixture(false); const { segments: _segments, ...rest } = assets;
    const assetPackage = { ...rest, schema_version: "storyboard_director_assets.v1", artifact_type: "storyboard_director_assets", phase: "assets",
      input: { ...input, visual_asset_mode: "参考图模式" }, visual_asset_plan: { mode: "selected", generation_policy: { max_initial_images: 2, initial_required_asset_ids: ["owner_001", "pet_001"], initial_deferred_asset_ids: [], environment_anchor_policy: "none" },
        assets: [owner, pet].map((lock, index) => ({ id: index ? "pet_001" : "owner_001", role: index ? "pet" : "character", name: index ? "金毛豆豆" : "男主人阿林", identity_lock: lock,
          allowed_changes: ["姿态", "表情"], reference_prompts: [{ kind: "turnaround", purpose: "中性三视图定妆", prompt: `${lock}正面侧面背面完整三视图，中性表情，中性姿态，统一浅灰背景。` }] })) } };
    assert.ok(parseStoryboardDirectorAssetsPackage(JSON.stringify(assetPackage)));
    assert.equal(parseStructuredAgentOutput(JSON.stringify(assetPackage), true, { requirePerformancePlan: true }).status, "valid");
  });
  check("current server configuration applies after its own activation without rewriting old messages", () => {
    const style = { production_contract_version: "storyboard_director_contract.v2", production_contract_activated_at: "2020-01-01T00:00:00Z", performance_contract: STORYBOARD_PERFORMANCE_CONTRACT_VERSION, performance_contract_activated_at: "2026-10-23T14:00:00Z" };
    const messages = (timestamp: number) => [{ id: "user", role: "user", timestamp }, { id: "assistant", role: "assistant", timestamp: timestamp + 1 }];
    assert.equal(resolveStoryboardHandoffContract(messages(Date.parse("2026-10-23T13:00:00Z")), "assistant", style).requirePerformancePlan, false);
    assert.equal(resolveStoryboardHandoffContract(messages(Date.parse("2026-10-23T15:00:00Z")), "assistant", style).requirePerformancePlan, true);
    for (const override of [{ performance_contract_activated_at: undefined }, { performance_contract_activated_at: "2026-10-23" }, { performance_contract: "model_claimed_pass" }]) assert.ok(resolveStoryboardHandoffContract(messages(Date.now()), "assistant", { ...style, ...override }).error);
    assert.equal(resolveStoryboardHandoffContract(messages(Date.now()), "assistant", {}).requirePerformancePlan, undefined);
  });
  check("normalized package, visible copy, push, execution and durable restore keep the same plan and strings", () => {
    const pkg = fixture(); const parsed = parseStoryboardDirectorPackage(wire(pkg)); assert.ok(parsed); assert.deepEqual(validateStoryboardDirectorPackage(parsed, input, { requirePerformancePlan: true }), []);
    const structured = parseStructuredAgentOutput(wire(pkg), true, { expectedInput: input, requirePerformancePlan: true }); assert.equal(structured.status, "valid");
    const detail = buildStructuredAgentOutputReadyDetail("message", structured); assert.ok(detail); detail.expected_input = input; detail.require_performance_plan = true;
    const plan = parseStoryboardCanvasImport(detail); assert.ok(plan); const segment = plan.segments[0];
    const execution = buildStoryboardDirectorExecution(plan, segment); assert.deepEqual(execution.performancePlan, parsed.segments[0].performance_plan);
    const document = { id: "performance_project", title: "动作表情合同恢复", createdAt: 1, updatedAt: 1, ratio: "9:16", imageResolution: "2K", videoResolution: "720p", videoDuration: 10, imageModelId: "image-fixture", videoModelId: "video-fixture",
      cards: [{ id: "card", order: 1, imagePrompt: segment.imagePrompt, videoPrompt: segment.videoPrompt, referenceImageUrls: [], imageStatus: "idle", videoStatus: "idle", directorExecution: execution }] };
    const restored = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(sanitizeStoryboardPersistenceValue(document))));
    assert.deepEqual(restored.cards[0].directorExecution, execution); assert.equal(restored.cards[0].imagePrompt, parsed.segments[0].storyboard_image_prompt); assert.equal(restored.cards[0].videoPrompt, parsed.segments[0].image_to_video_prompt);
    assert.equal(compileStoryboardDirectorVideoPrompt(segment.videoPrompt, execution), segment.videoPrompt); assert.equal(compileStoryboardDirectorVideoPrompt("用户手动修改动作", execution), "用户手动修改动作");
    const visible = renderStoryboardDirectorVisibleOutput(parsed); assert.ok(visible.includes(parsed.segments[0].performance_plan!.semantic_event)); assert.ok(visible.includes("**主峰**：动作峰值"));
    assert.ok(visible.includes(parsed.segments[0].performance_plan!.end_state)); assert.ok(visible.includes(segment.imagePrompt)); assert.ok(visible.includes(segment.videoPrompt));
    assert.equal(visible.includes("performance_plan"), false);
    const brokenExecution = structuredClone(execution); brokenExecution.performancePlan!.peak_shot_id = "foreign_shot"; assert.equal(StoryboardDirectorExecutionSchema.safeParse(brokenExecution).success, false);
  });
  assert.equal(networkRequests, 0);
  const report = { passed: true, checks, networkRequests, databaseWrites: 0, modelCalls: 0, artisticQuality: "not_evaluated", scope: "strict performance structure, original-input activation, visible/push/execution/persistence identity; authored fixtures only" };
  const evidence = ".codex-evidence/director-refinement-20261023/mode-followup"; mkdirSync(evidence, { recursive: true }); writeFileSync(`${evidence}/performance-contract-result.json`, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
} finally { globalThis.fetch = originalFetch; }
