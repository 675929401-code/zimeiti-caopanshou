import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  expectedName: "3D故事导演｜电影叙事",
  nextName: "3D故事导演｜电影叙事",
  expectedSchema: "storyboard_director_output_style.v4.1.4",
  expectedSha: "a64a6b1e0feb240687e14263cf23fc6ed7129b409db896b4fdde210d2546c31c",
  nextSchema: "storyboard_director_output_style.v4.1.5",
};
const siblingIds = ["agent-1786642714227-e1zid1", "agent-1786642714448-m6iaou"] as const;

type AgentRecord = {
  id: string;
  name: string;
  description?: string;
  system_prompt: string;
  output_style?: Record<string, unknown>;
};
type PromptVersion = { id: string; prompt: string };

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${init.method || "GET"} ${url} failed (${response.status})`);
  return payload;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");
  const token = session.token;

  const beforePayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, token);
  const before = beforePayload.agents.find((agent) => agent.id === target.id);
  assert.ok(before, "未找到口播分镜导演");
  assert.equal(before.name, target.expectedName, "目标智能体名称异常，停止覆盖");
  assert.equal(before.output_style?.schema_version, target.expectedSchema, "线上schema不是预期v4.1.4，停止覆盖");
  assert.equal(sha256(before.system_prompt), target.expectedSha, "线上Prompt不是预期v4.1.4，停止覆盖");
  const siblingBeforeShas = new Map(siblingIds.map((id) => {
    const sibling = beforePayload.agents.find((agent) => agent.id === id);
    return [id, sibling ? sha256(sibling.system_prompt) : null] as const;
  }));

  const nextPrompt = (await readFile("prompts/storyboard-voiceover-cinematic-v4.1.5.md", "utf8")).trim();
  assert.ok(nextPrompt.length >= 3_000 && nextPrompt.length <= 12_500, "v4.1.5提示词长度异常");
  assert.match(nextPrompt, /禁止把整段原文或原句引号复制进视频 Prompt/u);
  assert.match(nextPrompt, /每秒5至6个有效字/u);
  assert.match(nextPrompt, /10秒根据语义使用2至3个连续镜头/u);
  assert.match(nextPrompt, /视频模型不会看到/u);
  assert.match(nextPrompt, /相邻段不得重复同一种抽象轮廓或贴纸/u);
  assert.match(nextPrompt, /语义拍点标签只是内部索引，不算画面证据/u);
  assert.match(nextPrompt, /预期A与结论B必须按原文顺序各有独立可见证据/u);
  assert.match(nextPrompt, /原文没有时间或地点变化时不得擅自/u);
  assert.match(nextPrompt, /导致B的行为冒充观众对A的正向感受/u);
  assert.match(nextPrompt, /两者不得合并成一个倒粮动作/u);
  assert.match(nextPrompt, /禁止新增无身份的画外手/u);
  assert.match(nextPrompt, /同一事件续接/u);
  assert.match(nextPrompt, /新主题重置/u);
  assert.match(nextPrompt, /静默生成3个现实场景候选/u);
  assert.match(nextPrompt, /禁止把公园、户外步道、客厅或宠物医院设为无条件默认场景/u);
  assert.match(nextPrompt, /谁 -> 对什么 -> 做一个主动作/u);
  assert.match(nextPrompt, /不得生成真人广告摄影/u);
  assert.match(nextPrompt, /只换镜头焦段、手指位置或微表情不算新格/u);
  assert.match(nextPrompt, /每格严格保持实体守恒/u);
  assert.match(nextPrompt, /道具复制/u);
  assert.match(nextPrompt, /第四格开始前该动作必须已经结束/u);
  assert.match(nextPrompt, /仍贴着但开始松手/u);
  assert.match(nextPrompt, /每个生图 Prompt 的统一资产段必须逐字明确下发两项/u);
  assert.match(nextPrompt, /不得再画起点道具、终点道具/u);
  assert.match(nextPrompt, /封闭物必须遵守真实遮挡/u);
  assert.match(nextPrompt, /不受“双主角每格完整入框”约束/u);
  assert.match(nextPrompt, /前腿后方、脊背下方/u);
  assert.match(nextPrompt, /家中固定喂食区/u);
  assert.match(nextPrompt, /卧室床边或安静睡眠角/u);
  assert.match(nextPrompt, /犬体旁空白区内的独立无字平面科普插图/u);
  assert.match(nextPrompt, /现实犬体的毛皮、皮肤和身体轮廓必须完整/u);
  assert.match(nextPrompt, /禁止在犬身上开洞、剖开、透视、掀皮/u);
  assert.match(nextPrompt, /跨媒介语义对账/u);
  assert.match(nextPrompt, /不得只把包装画在后三格/u);
  assert.match(nextPrompt, /首帧没有出现、但后续时间段必须入场/u);
  assert.match(nextPrompt, /后入场角色的外观不得交给视频模型自由猜测/u);
  assert.match(nextPrompt, /动作峰值并稳定收尾/u);
  assert.match(nextPrompt, /判定为必要包装/u);
  assert.match(nextPrompt, /生图和视频必须共享同一种犬体外无字科普插图/u);
  assert.match(nextPrompt, /不从嘴里发射光束/u);
  assert.match(nextPrompt, /房间族去重/u);
  assert.match(nextPrompt, /禁止仅改“阅读区”“沙发区”“起居区”等名字冒充换场/u);
  assert.match(nextPrompt, /误读纠正不能只写在时间标题里/u);
  assert.match(nextPrompt, /实体状态账/u);
  assert.match(nextPrompt, /手或工具何时完全释放/u);
  assert.match(nextPrompt, /宽度约占画幅12%至16%/u);
  assert.match(nextPrompt, /总面积不超过画面8%/u);
  assert.match(nextPrompt, /绝不能穿过狗、人物或接触动作/u);
  assert.match(nextPrompt, /无黑色描边、无手绘笔触、无二维赛璐璐线稿/u);
  assert.match(nextPrompt, /包装必须先由反应触发并达到一次清楚峰值/u);
  assert.match(nextPrompt, /禁止先完成处理再补播原因/u);
  assert.match(nextPrompt, /每个生图 Prompt 的统一资产段必须逐字明确下发两项/u);
  assert.match(nextPrompt, /任一段都不能省略第二项/u);
  assert.match(nextPrompt, /视频 Prompt 对应秒段必须逐字写明/u);
  assert.match(nextPrompt, /不覆盖、不遮挡、不穿过现实犬体或人物动作/u);
  assert.match(nextPrompt, /不能用“位于安全空白区”“犬体完整”代替/u);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-voiceover-cinematic-v4-1-5-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${before.id}-before.json`, `${JSON.stringify(before, null, 2)}\n`, "utf8");

  await requestJson(`${baseUrl}/api/admin/prompt-versions`, token, {
    method: "POST",
    body: JSON.stringify({ agent_id: before.id, prompt: before.system_prompt, max_versions: 30 }),
  });
  const beforeHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(before.id)}`,
    token,
  );
  const rollbackVersion = beforeHistory.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "v4.1.4未进入平台回滚历史");

  const outputStyle = {
    schema_version: target.nextSchema,
    director_mode: "voiceover_cinematic",
    output_contract: "one_clean_four_panel_storyboard_and_one_executable_video_prompt_per_segment",
    human_format: "markdown_two_text_blocks_per_segment",
    storyboard_layout: "strict_2x2_four_panels_clean_separators_zero_rendered_text",
    narration_storage_policy: "verbatim_in_segment_metadata_only_never_in_video_model_prompt",
    semantic_timeline_policy: "compile_narration_to_short_semantic_labels_and_timed_actions",
    speech_load_policy: "five_to_six_han_or_numeric_characters_per_second_hard_gate_above_six",
    shot_count_policy: "ten_seconds_two_to_three_shots_fifteen_seconds_three_to_four_shots",
    video_reference_policy: "clean_frame_one_crop_only_video_model_never_sees_other_panels",
    wardrobe_policy: "scene_appropriate_modern_capsule_outfit_locked_no_default_yellow_hoodie",
    visual_style: "warm_soft_feature_film_stylized_3d_neutral_white_balance_material_specific_no_plastic_toy",
    character_stylization: "feature_animation_faces_and_dog_expression_not_photoreal_advertising",
    framing_gate: "human_head_to_shoes_and_dog_ears_to_paws_tail_inside_eight_percent_safe_margin",
    dog_performance: "eyes_eyelids_asymmetric_ears_muzzle_breath_weight_paw_tail_with_relationship_delay",
    packaging_policy: "semantic_gap_first_zero_to_one_nonrepeating_motif_with_cause_peak_decay_no_magic",
    semantic_evidence_policy: "clause_to_visible_evidence_ledger_reversal_requires_separate_expectation_then_correction",
    location_continuity_policy: "same_real_location_only_for_same_event_continuation",
    scene_routing_policy: "classify_event_continuation_vs_topic_reset_then_choose_best_of_three_real_locations",
    independent_segment_diversity: "do_not_repeat_location_layout_main_prop_packaging_motif_or_camera_sequence",
    room_family_uniqueness: "independent_topics_cannot_reuse_the_same_functional_room_family_reroute_weaker_dependency",
    prop_policy: "copy_derived_everyday_scale_no_anonymous_hand_giant_device_or_institution",
    storyboard_difference_gate: "adjacent_panels_change_three_major_dimensions_touch_or_hold_occupies_one_panel_only",
    result_panel_gate: "prior_contact_fully_ended_before_frame_four_new_pose_and_new_information_required",
    entity_conservation: "each_unique_actor_dog_door_and_prop_appears_once_per_panel_moving_prop_has_one_frozen_position",
    occlusion_policy: "closed_barrier_uses_one_camera_side_offscreen_actor_may_be_absent",
    anatomical_contact_policy: "contact_zone_locked_by_visible_body_landmarks_nonbloody_aligned_mechanism_only",
    body_mechanism_policy: "separate_flat_editorial_inset_outside_intact_dog_body_never_cutaway_or_transparency",
    cross_media_semantic_policy: "every_core_beat_and_required_packaging_appears_in_image_and_timed_video_prompt",
    late_entrant_identity_policy: "compact_identity_anchor_required_when_character_absent_from_frame_one",
    action_peak_policy: "final_core_behavior_must_complete_once_with_readable_body_mechanics_and_stable_end",
    reversal_evidence_policy: "misread_then_correction_requires_visible_a_to_b_performance_not_title_only",
    entity_state_ledger: "start_attempt_failure_helper_entry_force_release_final_acquisition_in_shared_image_video_order",
    required_mechanism_packaging_policy: "explicit_invisible_body_mechanism_uses_same_external_flat_inset_in_image_and_video_with_lifecycle",
    packaging_screen_space_policy: "editorial_inset_width_twelve_to_sixteen_percent_area_below_eight_percent_never_occludes_subjects",
    reality_render_policy: "consistent_line_free_feature_film_cgi_across_all_segments_flat_drawing_only_inside_editorial_inset",
    explanation_before_intervention_policy: "stimulus_reaction_mechanism_peak_then_owner_intervention_then_recovery",
    per_segment_render_contract: "every_image_prompt_repeats_line_free_feature_film_cgi_reality_layer",
    video_packaging_non_occlusion_contract: "every_required_inset_repeats_screen_size_safe_corner_two_percent_gap_and_no_occlusion",
    on_screen_text_policy: "zero_chinese_english_numbers_frame_labels_caption_strips_brand_or_watermark",
    voiceover_policy: "external_postproduction_audio_no_generated_speech_lipsync_subtitles_or_music",
    free_canvas_coupling: false,
  };

  await requestJson(`${baseUrl}/api/admin/agents`, token, {
    method: "PUT",
    body: JSON.stringify({
      agentId: before.id,
      name: target.nextName,
      description: "商业级3D口播分镜：把原文编译成语义拍点和秒级表演，纯净首帧驱动连续电影化视频。",
      system_prompt: nextPrompt,
      output_style: outputStyle,
    }),
  });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, token, {
    method: "POST",
    body: JSON.stringify({ agent_id: before.id, prompt: nextPrompt, max_versions: 30 }),
  });

  const afterPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, token);
  const after = afterPayload.agents.find((agent) => agent.id === target.id);
  const nextSha = sha256(nextPrompt);
  assert.ok(after && after.system_prompt === nextPrompt, "v4.1.5未生效");
  assert.equal(after.name, target.nextName, "新名称未生效");
  assert.equal(after.output_style?.schema_version, target.nextSchema);
  for (const [id, expectedSha] of siblingBeforeShas) {
    const sibling = afterPayload.agents.find((agent) => agent.id === id);
    assert.equal(sibling ? sha256(sibling.system_prompt) : null, expectedSha, `禁止修改的卡片发生变化：${id}`);
  }

  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(before.id)}`,
    token,
  );
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === nextSha);
  assert.ok(liveVersion, "v4.1.5未进入平台历史");
  await writeFile(`${backupDir}/agents/${after.id}-after.json`, `${JSON.stringify(after, null, 2)}\n`, "utf8");

  const verification = {
    passed: true,
    agentId: after.id,
    nameBefore: target.expectedName,
    nameAfter: after.name,
    schemaBefore: target.expectedSchema,
    schemaAfter: after.output_style?.schema_version,
    beforeSha256: target.expectedSha,
    afterSha256: nextSha,
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: before.system_prompt.length,
    promptCharsAfter: nextPrompt.length,
    siblingsUnchanged: true,
    siblingSnapshot: Object.fromEntries(siblingBeforeShas),
    paidMediaSubmitted: false,
    backupDir,
  };
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
