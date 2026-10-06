import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "aaf24953274421c5335dc487e0f9a057d019975fba92e3e4dde63db65ff767c4",
  expectedSchema: "storyboard_director_output_style.v3.4.3.4.6.3",
};
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);

interface PromptVersion { id: string; prompt: string; created_at?: string }
interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  output_style?: Record<string, unknown>;
}

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

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
  assert.ok(agent, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "线上高能版不是预期v3.4.3.4.6.3，停止覆盖");
  assert.equal(agent.output_style?.schema_version, target.expectedSchema, "线上高能版schema不符，停止覆盖");
  assert.equal(agent.output_style?.free_canvas_coupling, false, "高能版意外耦合自由画布");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }

  const nextPrompt = (await readFile("prompts/storyboard-high-energy-v3.5.0.md", "utf8")).trim();
  assert.ok(nextPrompt.length >= 3_500 && nextPrompt.length <= 8_000, "v3.5.0提示词长度异常");
  assert.match(nextPrompt, /每个镜头只绑定一个参考格/u);
  assert.match(nextPrompt, /禁止门复制、单门变双门/u);
  assert.match(nextPrompt, /相邻两格至少有两项不同/u);
  assert.match(nextPrompt, /禁止“参考格1至2合并”/u);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-benchmark-logic-v3-5-0-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");

  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }),
  });
  const beforeHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`,
    session.token,
  );
  const rollbackVersion = beforeHistory.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "v3.4.3.4.6.3未保存到平台历史");

  const outputStyle = {
    schema_version: "storyboard_director_output_style.v3.5.0",
    director_mode: "high_energy",
    human_format: "markdown_two_text_blocks_per_segment",
    output_contract: "one_storyboard_sheet_and_one_video_prompt_per_segment",
    storyboard_role: "multi_shot_edit_reference_sheet_not_one_shared_spatial_scene",
    panel_layout: "four_default_five_only_new_semantic_information",
    panel_information_gain_gate: "adjacent_signatures_differ_in_at_least_two_of_time_environment_action_camera_emotion",
    panel_duplicate_gate: "reject_same_environment_same_action_same_camera_micro_variations",
    action_ownership_gate: "each_completed_action_owned_by_one_segment_and_performed_once",
    causal_replay_gate: "later_cognition_and_emotion_use_aftermath_or_conditioned_response_not_restage_prior_cause",
    video_reference_policy: "one_exact_frame_per_shot_never_merge_frames",
    video_transition_policy: "hard_cut_across_time_or_environment_never_morph_or_interpolate",
    video_continuity_policy: "continuous_actions_only_move_forward_prepare_force_contact_reaction_residue",
    rigid_boundary_gate: "one_door_locked_topology_one_close_event_no_duplicate_or_double_door",
    entity_ledger_gate: "one_character_one_pet_one_primary_prop_instance_per_panel_unless_copy_explicit",
    target_durations: [10, 15],
    shot_pacing: "10s_two_to_three_shots_15s_three_to_five",
    prompt_budget: {
      image_prompt_chinese_chars: "900-1500",
      video_prompt_chinese_chars: "350-650",
      empty_quality_adjectives: 0,
    },
    benchmark_style_lock: "bright_saturated_stylized_commercial_3d_no_live_action_no_semirealism",
    default_heroine_lock: "adult_asian_woman_23_30_animation_ratio_1_to_5_5_large_clear_eyes_elastic_brows_mouth_dark_high_ponytail_yellow_hoodie_blue_jeans_white_sneakers",
    default_unspecified_pet: "stylized_tricolor_longhaired_corgi_large_clear_eyes_natural_quadruped_teal_collar",
    performance_gate: "one_emotion_verb_plus_one_body_force_verb_face_spine_limbs_weight_aligned",
    packaging_density: "one_primary_contact_effect_plus_one_residue_per_panel",
    packaging_source_gate: "effect_must_start_at_hand_paw_impact_surface_door_gap_or_gaze_trigger",
    semantic_candidate_router: "literal_prop_then_familiar_one_second_symbol_then_scene_packaging",
    exemplar_library: "retrieval_only_never_dump_full_50_cases",
    narration_trigger_alignment: "global_story_nodes_per_segment_no_replay",
    caption_word_budget: "8-14_common_english_words",
    caption_asset_policy: "exact_visible_action_camera_and_one_effect_only",
    anatomy_integrity_gate: "hard_fail_extra_or_ambiguous_limbs_unique_owner",
    cross_segment_state_gate: "person_pet_boundary_prop_emotion_time_light_motif_before_after",
    in_scene_text_budget: "max_one_optional_short_label",
    sci_fi_gate: "forbidden_unless_copy_explicitly_technology_or_mechanical",
    no_early_resolution: "forbid_return_hug_reassurance_solution_reversal_until_copy_explicit",
    free_canvas_coupling: false,
  };

  await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
    method: "PUT",
    body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt, output_style: outputStyle }),
  });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }),
  });

  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === target.id);
  assert.ok(verified && verified.system_prompt === nextPrompt, "高能v3.5.0未生效");
  assert.equal(verified.output_style?.schema_version, "storyboard_director_output_style.v3.5.0");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片发生变化：${id}`);
  }

  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`,
    session.token,
  );
  const liveSha = sha256(nextPrompt);
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === liveSha);
  assert.ok(liveVersion, "v3.5.0未保存到平台历史");
  await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");

  const verification = {
    passed: true,
    agentId: agent.id,
    schemaVersion: verified.output_style?.schema_version,
    beforeSha256: target.expectedSha,
    afterSha256: liveSha,
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: agent.system_prompt.length,
    promptCharsAfter: nextPrompt.length,
    removedConflicts: [
      "reference_panels_are_mergeable_anchors",
      "same_action_microstates_used_to_fill_panel_quota",
      "replay_prior_cause_in_later_emotion_segments",
      "morph_or_interpolate_different_panel_environments",
      "generic_quality_adjective_stacking",
    ],
    benchmarkEvidence: {
      productUrl: "https://sss.chatai8.com/#/shop/5",
      localDir: ".tmp-e2e/benchmark-site-evidence-20260816",
      imageExamples: 3,
      videoExamples: 2,
    },
    siblingsUnchanged: true,
    freeCanvasCoupling: false,
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
