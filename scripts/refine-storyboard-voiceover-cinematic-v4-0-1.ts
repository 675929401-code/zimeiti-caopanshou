import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  expectedName: "口播分镜导演",
  nextName: "口播分镜导演",
  expectedSha: "db4e046e82fc2aecc2e3ce25d6ab25d55075ddbe39cf23b038d9a666ed6f80d4",
  expectedSchema: "storyboard_director_output_style.v4.0.0",
  nextSchema: "storyboard_director_output_style.v4.0.1",
};
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);

interface PromptVersion { id: string; prompt: string }
interface AgentRecord {
  id: string;
  name: string;
  description?: string;
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

  const beforePayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const before = beforePayload.agents.find((item) => item.id === target.id);
  assert.ok(before, "未找到目标口播分镜智能体");
  assert.equal(before.name, target.expectedName, "目标卡片名称异常，停止覆盖");
  assert.equal(sha256(before.system_prompt), target.expectedSha, "线上Prompt不是预期v3.6.3，停止覆盖");
  assert.equal(before.output_style?.schema_version, target.expectedSchema, "线上schema不是预期v3.6.3，停止覆盖");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = beforePayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }

  const nextPrompt = (await readFile("prompts/storyboard-voiceover-cinematic-v4.0.1.md", "utf8")).trim();
  assert.ok(nextPrompt.length >= 3_700 && nextPrompt.length <= 5_400, "v4.0.1提示词长度异常");
  assert.match(nextPrompt, /不得默认黄色连帽卫衣/u);
  assert.match(nextPrompt, /暖色柔和的电影基调/u);
  assert.match(nextPrompt, /画面内不出现中文、英文、数字、字母、Frame编号、说明条/u);
  assert.match(nextPrompt, /人物从头顶到鞋底完整入框/u);
  assert.match(nextPrompt, /至少四个通道/u);
  assert.match(nextPrompt, /工作台将完整四格或五格故事板作为一张参考图提交/u);
  assert.match(nextPrompt, /每个镜头只允许一个主要动作和一个回应动作/u);
  assert.match(nextPrompt, /禁止借弧面反射、镜像、屏幕画面、照片或画中画制造胖瘦/u);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-voiceover-cinematic-v4-0-1-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${before.id}-before.json`, `${JSON.stringify(before, null, 2)}\n`, "utf8");

  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: before.id, prompt: before.system_prompt, max_versions: 30 }),
  });
  const historyBefore = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(before.id)}`,
    session.token,
  );
  const rollbackVersion = historyBefore.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "v4.0.0未进入平台回滚历史");

  const outputStyle = {
    schema_version: target.nextSchema,
    director_mode: "voiceover_cinematic",
    output_contract: "one_clean_four_panel_storyboard_and_one_self_contained_video_prompt_per_segment",
    human_format: "markdown_two_text_blocks_per_segment",
    storyboard_layout: "strict_2x2_four_panels_clean_separators_zero_rendered_text",
    frame_one_policy: "clean_full_body_t0_state_workbench_crops_as_only_video_reference",
    wardrobe_policy: "scene_appropriate_modern_capsule_outfit_locked_no_default_yellow_hoodie",
    visual_style: "warm_soft_feature_film_stylized_3d_neutral_white_balance_material_specific_no_plastic_toy",
    framing_gate: "human_head_to_shoes_and_dog_ears_to_paws_tail_inside_eight_percent_safe_margin",
    narrative_sentence: "setup_trigger_reaction_visible_evidence_payoff",
    shot_action_budget: "one_primary_action_plus_one_response_per_shot",
    dog_performance: "eyes_eyelids_asymmetric_ears_muzzle_breath_weight_paw_tail_with_relationship_delay",
    packaging_policy: "semantic_gap_first_zero_to_one_motif_with_cause_peak_decay_and_transition_residue_no_reflective_carriers",
    comparison_policy: "real_distinct_secondary_subject_or_single_textless_editorial_overlay_never_mirror_screen_photo_or_duplicate_main_pet",
    on_screen_text_policy: "zero_chinese_english_numbers_frame_labels_caption_strips_brand_or_watermark",
    video_reference_policy: "clean_frame_one_crop_only_never_submit_full_storyboard_sheet",
    voiceover_policy: "external_narration_timeline_no_generated_speech_lipsync_subtitles_music",
    prompt_budget: {
      image_prompt_chinese_chars: "800-1300",
      video_prompt_chinese_chars: "450-750",
    },
    magic_effects_forbidden: "laser_beam_scan_ring_energy_ring_hologram_summon_spell_unmotivated_particles",
    free_canvas_coupling: false,
  };

  await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
    method: "PUT",
    body: JSON.stringify({
      agentId: before.id,
      name: target.nextName,
      description: "商业级3D口播分镜：先理解语义与因果，再用电影化人宠表演、纯净无字参考图和连续视频动作完成演示。",
      system_prompt: nextPrompt,
      output_style: outputStyle,
    }),
  });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: before.id, prompt: nextPrompt, max_versions: 30 }),
  });

  const afterPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const after = afterPayload.agents.find((item) => item.id === target.id);
  assert.ok(after && after.system_prompt === nextPrompt, "v4.0.1未生效");
  assert.equal(after.name, target.nextName);
  assert.equal(after.output_style?.schema_version, target.nextSchema);
  assert.equal(after.output_style?.free_canvas_coupling, false);
  assert.equal(after.output_style?.on_screen_text_policy, outputStyle.on_screen_text_policy);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = afterPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片发生变化：${id}`);
  }

  const historyAfter = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(before.id)}`,
    session.token,
  );
  const liveSha = sha256(nextPrompt);
  const liveVersion = historyAfter.versions.find((version) => sha256(version.prompt) === liveSha);
  assert.ok(liveVersion, "v4.0.1未进入平台历史");
  await writeFile(`${backupDir}/agents/${after.id}-after.json`, `${JSON.stringify(after, null, 2)}\n`, "utf8");
  const verification = {
    passed: true,
    agentId: after.id,
    agentNameBefore: before.name,
    agentNameAfter: after.name,
    schemaBefore: target.expectedSchema,
    schemaAfter: after.output_style?.schema_version,
    beforeSha256: target.expectedSha,
    afterSha256: liveSha,
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: before.system_prompt.length,
    promptCharsAfter: nextPrompt.length,
    fixedRootCauses: ["mirror_reflection_screen_photo_or_picture_in_picture_used_as_semantic_comparison"],
    siblingsUnchanged: true,
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
