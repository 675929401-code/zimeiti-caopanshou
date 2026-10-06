import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1785658026345-k6yy99",
  name: "2D文案影像架构师 (升级)",
  expectedSha: "7779daaf752c495baddf94248530fd3b265f11e15eb874305d5627bb55bc743a",
  nextSchema: "text_to_video_2d_output_style.v2.0.0",
  description: "把分段文案转成语义精准、趣味鲜明、适配后期配音的电影级2D动画视频提示词。",
};

type AgentRecord = {
  id: string;
  name: string;
  description?: string;
  system_prompt: string;
  output_style?: Record<string, unknown> | null;
  preset_fields?: Array<Record<string, unknown>>;
  sort_order?: number;
  guide_message?: string;
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
  assert.ok(before, "未找到2D文案影像架构师");
  assert.equal(before.name, target.name, "目标智能体名称异常，停止覆盖");
  assert.equal(sha256(before.system_prompt), target.expectedSha, "线上Prompt不是预期V1.3，停止覆盖");
  assert.equal(before.output_style?.schema_version ?? null, null, "线上已存在未知schema，停止覆盖");

  const nextPrompt = (await readFile("prompts/2d-copy-video-architect-v2.0.0.md", "utf8")).trim();
  assert.ok(nextPrompt.length >= 4_000 && nextPrompt.length <= 6_500, "V2.0提示词长度异常");
  assert.match(nextPrompt, /分段文案、单段视频时长、视频比例、视频风格、特殊备注/u);
  assert.match(nextPrompt, /不要假装卡片还有宠物、人物、目标模型、语言或声音输入框/u);
  assert.match(nextPrompt, /语义高度匹配/u);
  assert.match(nextPrompt, /趣味性强/u);
  assert.match(nextPrompt, /配合优质后期配音/u);
  assert.match(nextPrompt, /原文子句 → 可见证据/u);
  assert.match(nextPrompt, /每秒5至6个有效汉字/u);
  assert.match(nextPrompt, /结尾预留0\.4至0\.8秒稳定停留/u);
  assert.match(nextPrompt, /每段最多选一种趣味机关/u);
  assert.match(nextPrompt, /8秒 \| 2至3镜/u);
  assert.match(nextPrompt, /10秒 \| 3至4镜/u);
  assert.match(nextPrompt, /15至16秒 \| 4至5镜/u);
  assert.match(nextPrompt, /声音设计/u);
  assert.match(nextPrompt, /后期配音是主声道/u);
  assert.match(nextPrompt, /## 接收信息/u);
  assert.match(nextPrompt, /## 全局视觉资产锁定/u);
  assert.match(nextPrompt, /## 内容产出/u);
  assert.match(nextPrompt, /文生视频提示词：/u);
  assert.equal((nextPrompt.match(/```text/gu) || []).length, 1, "固定模板必须只有一个text代码框");
  assert.doesNotMatch(nextPrompt, /S01–S43|风格库 S01/u);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/2d-copy-video-architect-v2-0-0-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${before.id}-before.json`, `${JSON.stringify(before, null, 2)}\n`, "utf8");

  await requestJson(`${baseUrl}/api/admin/prompt-versions`, token, {
    method: "POST",
    body: JSON.stringify({ agent_id: before.id, prompt: before.system_prompt, max_versions: 30 }),
  });
  const historyBefore = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(before.id)}`,
    token,
  );
  assert.ok(historyBefore.versions.some((version) => sha256(version.prompt) === target.expectedSha), "V1.3未进入回滚历史");

  const outputStyle = {
    schema_version: target.nextSchema,
    output_contract: "unchanged_receive_assets_content_sections_one_text_code_block_per_segment",
    interaction_contract: "existing_five_card_fields_only_no_new_questions_or_fields",
    semantic_policy: "every_meaning_changing_clause_maps_to_unique_visible_evidence_in_original_order",
    entertainment_policy: "one_copy_derived_fun_device_per_segment_hook_reveal_or_reaction_without_distorting_facts",
    voiceover_policy: "external_narration_primary_timeline_aligned_no_generated_dialogue_or_lipsync",
    duration_policy: "eight_seconds_two_to_three_ten_or_twelve_three_to_four_fifteen_or_sixteen_four_to_five_twenty_five_to_six_shots",
    style_policy: "selected_card_style_compiled_to_six_observable_2d_dimensions_no_protected_character_copy",
    aspect_policy: "default_sixteen_by_nine_selected_nine_by_sixteen_recomposes_subject_path_and_safe_area",
    prompt_language: "chinese_only",
    per_segment_code_blocks: 1,
  };

  await requestJson(`${baseUrl}/api/admin/agents`, token, {
    method: "PUT",
    body: JSON.stringify({
      agentId: before.id,
      name: before.name,
      description: target.description,
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
  assert.ok(after && after.system_prompt === nextPrompt, "V2.0未生效");
  assert.equal(after.name, before.name, "名称被意外改动");
  assert.equal(after.description, target.description, "一句话介绍未生效");
  assert.deepEqual(after.preset_fields, before.preset_fields, "接收卡片交互被意外改动");
  assert.equal(after.guide_message, before.guide_message, "引导语被意外改动");
  assert.equal(after.output_style?.schema_version, target.nextSchema);

  const historyAfter = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(before.id)}`,
    token,
  );
  assert.ok(historyAfter.versions.some((version) => sha256(version.prompt) === nextSha), "V2.0未进入平台历史");
  await writeFile(`${backupDir}/agents/${after.id}-after.json`, `${JSON.stringify(after, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    updated: true,
    agentId: after.id,
    name: after.name,
    description: after.description,
    schema: after.output_style?.schema_version,
    promptSha256: nextSha,
    promptLength: nextPrompt.length,
    previousPromptLength: before.system_prompt.length,
    presetFieldsUnchanged: true,
    guideMessageUnchanged: true,
    backupDir,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
