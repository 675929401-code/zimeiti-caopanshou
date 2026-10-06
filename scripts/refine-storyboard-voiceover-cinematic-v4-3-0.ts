import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "3D故事导演｜电影叙事",
  expectedSchema: "storyboard_director_output_style.v4.2.1",
  expectedSha: "91cca04d2586950e840d80ae5070a98af5e047ac4d5ac3b5045f8bddfc0e086f",
  nextSchema: "storyboard_director_output_style.v4.3.0",
};
const siblingIds = ["agent-1786642714227-e1zid1", "agent-1786642714448-m6iaou"] as const;

type AgentRecord = {
  id: string;
  name: string;
  description?: string;
  system_prompt: string;
  output_style?: Record<string, unknown>;
  preset_fields?: Array<Record<string, unknown>>;
  sort_order?: number;
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
  assert.ok(before, "未找到目标3D故事导演");
  assert.equal(before.name, target.name, "目标智能体名称异常，停止覆盖");
  assert.equal(before.output_style?.schema_version, target.expectedSchema, "线上schema不是预期v4.2.1，停止覆盖");
  assert.equal(sha256(before.system_prompt), target.expectedSha, "线上Prompt不是预期v4.2.1，停止覆盖");
  const siblingBeforeShas = new Map(siblingIds.map((id) => {
    const sibling = beforePayload.agents.find((agent) => agent.id === id);
    return [id, sibling ? sha256(sibling.system_prompt) : null] as const;
  }));

  const nextPrompt = (await readFile("prompts/storyboard-voiceover-cinematic-v4.3.0.md", "utf8")).trim();
  assert.ok(nextPrompt.length >= 7_000 && nextPrompt.length <= 12_000, "v4.3.0提示词长度异常");
  assert.match(nextPrompt, /10秒使用3至4个实际镜头/u);
  assert.match(nextPrompt, /15秒使用4至5个实际镜头/u);
  assert.match(nextPrompt, /10秒默认用4格/u);
  assert.match(nextPrompt, /15秒根据完整语义选4格或5格/u);
  assert.match(nextPrompt, /上方2×2四格加底部全宽第5格/u);
  assert.match(nextPrompt, /未选时为16:9/u);
  assert.match(nextPrompt, /用户选择9:16时/u);
  assert.match(nextPrompt, /比例必须与用户选择的视频比例一致/u);
  assert.ok(nextPrompt.includes("**Omni**"));
  assert.ok(nextPrompt.includes("**xAI**"));
  assert.ok(nextPrompt.includes("**MiniMax H3**"));
  assert.match(nextPrompt, /高饱和萌宠3D动画喜剧/u);
  assert.match(nextPrompt, /东方国潮3D动画电影/u);
  assert.match(nextPrompt, /未来科技霓虹3D动画/u);
  assert.match(nextPrompt, /各写一次，禁止在每格重复整套资产圣经/u);
  assert.match(nextPrompt, /标题中的X必须替换/u);
  assert.doesNotMatch(nextPrompt, /10秒根据语义使用2至3个/u);
  assert.doesNotMatch(nextPrompt, /15秒使用3至4个/u);
  assert.doesNotMatch(nextPrompt, /故事板分镜图文生图 Prompt（共4格）/u);
  assert.doesNotMatch(nextPrompt, /每段生成一张16:9、2×2四格/u);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-voiceover-cinematic-v4-3-0-${stamp}`;
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
  assert.ok(beforeHistory.versions.some((version) => sha256(version.prompt) === target.expectedSha), "v4.2.1未进入回滚历史");

  const outputStyle = {
    ...(before.output_style || {}),
    schema_version: target.nextSchema,
    output_contract: "one_clean_four_or_five_panel_storyboard_and_one_executable_video_prompt_per_segment",
    human_format: "unchanged_markdown_two_text_blocks_per_segment",
    storyboard_layout: "semantic_four_or_five_panels_four_is_2x2_five_is_2x2_plus_full_width_bottom",
    panel_count_policy: "ten_seconds_default_four_five_only_for_distinct_climax_reveal_reversal_or_conclusion_fifteen_seconds_four_or_five",
    shot_count_policy: "ten_seconds_three_to_four_shots_fifteen_seconds_four_to_five_shots",
    panel_shot_decoupling: "semantic_beats_panels_and_actual_shots_are_independent",
    aspect_ratio_policy: "default_sixteen_by_nine_user_selection_overrides_all_storyboard_first_frame_and_camera_composition",
    video_model_routing: "omni_xai_minimax_h3_or_common_compatibility_selected_from_special_notes",
    style_routing_policy: "ten_complete_mutually_exclusive_fingerprints_cover_proportion_face_material_light_camera_and_no_mix_rules",
    image_prompt_budget: "six_hundred_fifty_to_one_thousand_chinese_characters_style_assets_once",
    video_prompt_budget: "ten_seconds_four_hundred_fifty_to_seven_hundred_fifteen_seconds_six_hundred_to_nine_hundred_chinese_characters",
  };

  await requestJson(`${baseUrl}/api/admin/agents`, token, {
    method: "PUT",
    body: JSON.stringify({
      agentId: before.id,
      name: before.name,
      description: before.description,
      system_prompt: nextPrompt,
      output_style: outputStyle,
      preset_fields: before.preset_fields,
      sort_order: before.sort_order,
    }),
  });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, token, {
    method: "POST",
    body: JSON.stringify({ agent_id: before.id, prompt: nextPrompt, max_versions: 30 }),
  });

  const afterPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, token);
  const after = afterPayload.agents.find((agent) => agent.id === target.id);
  const nextSha = sha256(nextPrompt);
  assert.ok(after && after.system_prompt === nextPrompt, "v4.3.0未生效");
  assert.equal(after.name, before.name, "名称被意外改动");
  assert.equal(after.description, before.description, "描述被意外改动");
  assert.deepEqual(after.preset_fields, before.preset_fields, "接收卡片交互被意外改动");
  assert.equal(after.output_style?.schema_version, target.nextSchema);
  for (const [id, expectedSha] of siblingBeforeShas) {
    const sibling = afterPayload.agents.find((agent) => agent.id === id);
    assert.equal(sibling ? sha256(sibling.system_prompt) : null, expectedSha, `禁止修改的卡片发生变化：${id}`);
  }

  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(before.id)}`,
    token,
  );
  assert.ok(afterHistory.versions.some((version) => sha256(version.prompt) === nextSha), "v4.3.0未进入平台历史");
  await writeFile(`${backupDir}/agents/${after.id}-after.json`, `${JSON.stringify(after, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    updated: true,
    agentId: after.id,
    name: after.name,
    schema: after.output_style?.schema_version,
    promptSha256: nextSha,
    promptLength: nextPrompt.length,
    presetFieldsUnchanged: true,
    rollbackSchema: target.expectedSchema,
    backupDir,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
