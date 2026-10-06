import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  expectedName: "故事版导演｜高能夸张",
  nextName: "故事版导演｜电影级口播",
  expectedSha: "8d71d01d0d3e5f9de8562fe09ec6cfba87a80017b12d37d110de8db2d95c925d",
  expectedSchema: "storyboard_director_output_style.v3.5.3",
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
  assert.ok(before, "未找到目标故事版导演");
  assert.equal(before.name, target.expectedName, "目标卡片名称不是预期高能版，停止覆盖");
  assert.equal(sha256(before.system_prompt), target.expectedSha, "线上Prompt不是预期v3.5.3，停止覆盖");
  assert.equal(before.output_style?.schema_version, target.expectedSchema, "线上schema不是预期v3.5.3，停止覆盖");
  assert.equal(before.output_style?.free_canvas_coupling, false, "目标卡片意外耦合自由画布");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = beforePayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }

  const nextPrompt = (await readFile("prompts/storyboard-voiceover-cinematic-v3.6.0.md", "utf8")).trim();
  assert.ok(nextPrompt.length >= 2_500 && nextPrompt.length <= 4_500, "v3.6.0提示词长度异常");
  assert.ok(nextPrompt.length < before.system_prompt.length * 0.7, "v3.6.0没有充分精简旧逻辑层");
  assert.match(nextPrompt, /先理解这一段真正发生的事情/u);
  assert.match(nextPrompt, /现实表演.*先/u);
  assert.match(nextPrompt, /包装是解释层，不是剧情发动机/u);
  assert.match(nextPrompt, /编辑贴纸或信息层/u);
  assert.match(nextPrompt, /真实动作反馈/u);
  assert.match(nextPrompt, /有边界的主观或科普画面/u);
  assert.match(nextPrompt, /无条件禁止：激光、光束/u);
  assert.match(nextPrompt, /工作台会把Frame 1裁成一张干净全屏首帧/u);
  assert.match(nextPrompt, /只有一个人物时禁止过肩镜头/u);
  assert.match(nextPrompt, /10秒使用2至3镜/u);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-voiceover-cinematic-v3-6-0-${stamp}`;
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
  assert.ok(rollbackVersion, "v3.5.3未进入平台回滚历史");

  const outputStyle = {
    schema_version: "storyboard_director_output_style.v3.6.0",
    director_mode: "voiceover_cinematic",
    human_format: "markdown_two_text_blocks_per_segment",
    output_contract: "one_storyboard_sheet_and_one_video_prompt_per_segment",
    semantic_first_decision: "fact_then_physical_performance_then_optional_packaging",
    packaging_taxonomy: [
      "editorial_sticker_or_information_layer",
      "physical_motion_feedback",
      "bounded_subjective_or_non_bloody_knowledge_overlay",
    ],
    effect_optional_policy: "default_none_remove_when_performance_is_clear",
    magic_effects_forbidden: "laser_beam_touch_scan_energy_ring_shockwave_hologram_summon_transformation",
    performance_priority: "microexpression_eye_line_body_weight_and_natural_dog_behavior",
    action_continuity: "prepare_force_contact_follow_through_reaction_settle_once",
    storyboard_layout: "four_panels_default_five_only_for_independent_conclusion",
    video_start_policy: "clean_frame_1_crop_never_full_storyboard_sheet",
    shot_pacing: "10s_two_to_three_15s_three_to_four",
    voiceover_policy: "external_narration_timeline_no_generated_speech_lipsync_or_subtitles",
    single_human_camera_gate: "no_over_shoulder_use_side_dog_height_or_foreground_prop",
    nested_frame_gate: "no_photo_phone_or_screen_unless_narration_explicit",
    default_visual_style: "cinematic_bright_stylized_commercial_3d_cute_expressive_not_live_action",
    prompt_budget: {
      image_prompt_chinese_chars: "700-1200",
      video_prompt_chinese_chars: "350-650",
    },
    free_canvas_coupling: false,
  };

  await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
    method: "PUT",
    body: JSON.stringify({
      agentId: before.id,
      name: target.nextName,
      description: "电影级3D口播故事版：先理解语义和真实动作，再按需加入贴纸、物理反馈或非血腥科普/梦境层。",
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
  assert.ok(after && after.system_prompt === nextPrompt, "v3.6.0未生效");
  assert.equal(after.name, target.nextName, "目标卡片未切换到电影级口播方向");
  assert.equal(after.output_style?.schema_version, "storyboard_director_output_style.v3.6.0");
  assert.equal(after.output_style?.free_canvas_coupling, false);
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
  assert.ok(liveVersion, "v3.6.0未进入平台历史");
  await writeFile(`${backupDir}/agents/${after.id}-after.json`, `${JSON.stringify(after, null, 2)}\n`, "utf8");

  const verification = {
    passed: true,
    agentId: before.id,
    nameBefore: before.name,
    nameAfter: after.name,
    schemaBefore: target.expectedSchema,
    schemaAfter: after.output_style?.schema_version,
    beforeSha256: target.expectedSha,
    afterSha256: liveSha,
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: before.system_prompt.length,
    promptCharsAfter: nextPrompt.length,
    reductionPercent: Number(((1 - nextPrompt.length / before.system_prompt.length) * 100).toFixed(1)),
    workbenchVideoSourcePolicy: "clean_frame_1_crop_or_abort_before_video_submission",
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
