import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  expectedName: "3D故事导演｜电影叙事",
  nextName: "3D故事导演｜电影叙事",
  expectedSchema: "storyboard_director_output_style.v4.0.5",
  expectedSha: "7463ecee08cbf71b49bedfaf232fd809abb7657e8b7e4bb68ed2957009bfec15",
  nextSchema: "storyboard_director_output_style.v4.0.6",
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
  assert.equal(before.output_style?.schema_version, target.expectedSchema, "线上schema不是预期v4.0.5，停止覆盖");
  assert.equal(sha256(before.system_prompt), target.expectedSha, "线上Prompt不是预期v4.0.5，停止覆盖");
  const siblingBeforeShas = new Map(siblingIds.map((id) => {
    const sibling = beforePayload.agents.find((agent) => agent.id === id);
    return [id, sibling ? sha256(sibling.system_prompt) : null] as const;
  }));

  const nextPrompt = (await readFile("prompts/storyboard-voiceover-cinematic-v4.0.6.md", "utf8")).trim();
  assert.ok(nextPrompt.length >= 3_000 && nextPrompt.length <= 6_800, "v4.0.6提示词长度异常");
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

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-voiceover-cinematic-v4-0-6-${stamp}`;
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
  assert.ok(rollbackVersion, "v4.0.5未进入平台回滚历史");

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
    prop_policy: "copy_derived_everyday_scale_no_anonymous_hand_giant_device_or_institution",
    storyboard_difference_gate: "adjacent_panels_change_three_major_dimensions_touch_or_hold_occupies_one_panel_only",
    entity_conservation: "each_unique_actor_dog_door_and_prop_appears_once_per_panel_motion_uses_arc_or_blur",
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
  assert.ok(after && after.system_prompt === nextPrompt, "v4.0.6未生效");
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
  assert.ok(liveVersion, "v4.0.6未进入平台历史");
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
