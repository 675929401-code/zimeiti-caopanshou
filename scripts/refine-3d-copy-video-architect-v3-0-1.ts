import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1785688061259-4xww99",
  name: "3D文案影像架构师 (升级)",
  expectedSha: "3091eeeb0faddb1d03abbfd27b5890697ae5ea0af64481dedb7e00dd7be58456",
  description: "把分段文案变成语义精准、剧情生动、适配后期配音的电影级3D动画提示词。",
  guideMessage: "粘贴分段文案，生成可直接复制的电影级3D动画视频提示词。",
  model: "gpt-5.6-sol",
  modelId: "ca7d18b2-198c-4b78-8a95-0228a722436e",
  schema: "text_to_video_3d_output_style.v3.0.1",
};

type AgentRecord = {
  id: string;
  name: string;
  description?: string;
  guide_message?: string;
  model?: string;
  model_id?: string;
  system_prompt: string;
  output_style?: Record<string, unknown> | null;
  preset_fields?: Array<Record<string, unknown>>;
  sort_order?: number;
};
type PromptVersion = { prompt: string };

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
  assert.ok(before, "未找到3D文案影像架构师");
  assert.equal(before.name, target.name, "目标智能体名称异常，停止覆盖");
  assert.equal(sha256(before.system_prompt), target.expectedSha, "线上提示词不是预期V3.0.0，停止覆盖");

  const nextPrompt = (await readFile("prompts/3d-copy-video-architect-v3.0.1.md", "utf8")).trim();
  assert.ok(nextPrompt.length >= 3_700 && nextPrompt.length <= 6_200, "V3.0.1提示词长度异常");
  for (const required of [
    "最高优先级交付门禁", "接收卡片合同", "命题极性", "趣味机关", "风格编译器",
    "默认16:9", "提示词输出选项", "后期旁白", "Characters must not speak.", "# 全局资产设定",
  ]) assert.ok(nextPrompt.includes(required), `V3.0缺少关键指令：${required}`);
  assert.ok(nextPrompt.includes("不可翻译的固有标签"), "V3.0.1缺少英文输出风格名冻结");
  assert.equal((nextPrompt.match(/```text/gu) || []).length, 2, "固定格式示例必须是两个段落代码框");

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/3d-copy-video-architect-v3-0-1-${stamp}`;
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
  assert.ok(historyBefore.versions.some((version) => sha256(version.prompt) === target.expectedSha), "V3.0.0未进入回滚历史");

  const outputStyle = {
    ...(before.output_style || {}),
    schema_version: target.schema,
    output_contract: "unchanged_global_assets_then_one_original_copy_and_one_text_code_block_per_segment",
    interaction_contract: "existing_six_card_fields_only",
    semantic_policy: "clause_to_visible_or_audible_evidence_with_proposition_polarity_lock",
    entertainment_policy: "one_copy_derived_fun_device_per_segment_without_fact_distortion",
    voiceover_policy: "post_narration_primary_timeline_aligned_with_optional_post_added_audio_evidence",
    aspect_policy: "default_sixteen_by_nine_selected_nine_by_sixteen_recomposes_action_and_safe_area",
    language_policy: "outer_schema_chinese_code_prompt_uses_selected_chinese_or_english",
    style_policy: "selected_style_name_exactly_preserved_and_compiled_to_six_observable_3d_dimensions",
  };

  await requestJson(`${baseUrl}/api/admin/agents`, token, {
    method: "PUT",
    body: JSON.stringify({
      agentId: before.id,
      name: before.name,
      description: target.description,
      guide_message: target.guideMessage,
      model: target.model,
      model_id: target.modelId,
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
  assert.ok(after && after.system_prompt === nextPrompt, "V3.0.1未生效");
  assert.equal(after.name, before.name, "名称被意外修改");
  assert.equal(after.description, target.description, "简介未生效");
  assert.equal(after.guide_message, target.guideMessage, "简化引导语未生效");
  assert.equal(after.model, target.model, "高遵循模型未生效");
  assert.equal(after.model_id, target.modelId, "模型预设未生效");
  assert.deepEqual(after.preset_fields, before.preset_fields, "接收卡片被意外修改");
  assert.equal(after.output_style?.schema_version, target.schema);

  const nextSha = sha256(nextPrompt);
  const historyAfter = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(before.id)}`,
    token,
  );
  assert.ok(historyAfter.versions.some((version) => sha256(version.prompt) === nextSha), "V3.0.1未进入平台历史");
  await writeFile(`${backupDir}/agents/${after.id}-after.json`, `${JSON.stringify(after, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    updated: true,
    agentId: after.id,
    name: after.name,
    description: after.description,
    guideMessage: after.guide_message,
    model: after.model,
    schema: after.output_style?.schema_version,
    promptSha256: nextSha,
    promptLength: nextPrompt.length,
    previousPromptLength: before.system_prompt.length,
    presetFieldsUnchanged: true,
    backupDir,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
