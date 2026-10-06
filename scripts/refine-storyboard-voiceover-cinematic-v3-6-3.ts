import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜电影级口播",
  expectedSha: "3fd81d8f9553b6c18fb66e61666d6b19a4d9908548caa5b40fd83e73d467bd89",
  expectedSchema: "storyboard_director_output_style.v3.6.2",
};
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);

interface PromptVersion { id: string; prompt: string }
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

  const beforePayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const before = beforePayload.agents.find((item) => item.id === target.id);
  assert.ok(before, "未找到电影级口播智能体");
  assert.equal(before.name, target.name, "目标卡片名称异常，停止覆盖");
  assert.equal(sha256(before.system_prompt), target.expectedSha, "线上Prompt不是预期v3.6.2，停止覆盖");
  assert.equal(before.output_style?.schema_version, target.expectedSchema, "线上schema不是预期v3.6.2，停止覆盖");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = beforePayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }

  const nextPrompt = (await readFile("prompts/storyboard-voiceover-cinematic-v3.6.3.md", "utf8")).trim();
  assert.ok(nextPrompt.length >= 3_300 && nextPrompt.length <= 4_300, "v3.6.3提示词长度异常");
  assert.match(nextPrompt, /每个语义点在对应口播出现时都必须有一个观众能看见的证据/u);
  assert.match(nextPrompt, /口播锚点.*本身不算画面证据/u);
  assert.match(nextPrompt, /不得拿倒水、喂食、秤重、展示粮盒/u);
  assert.match(nextPrompt, /不要另编一段看似合理但答非所问的小剧情/u);
  assert.match(nextPrompt, /不依附镜子、玻璃、橱窗、手机或照片/u);
  assert.match(nextPrompt, /默认使用无文字符号/u);
  assert.match(nextPrompt, /外部口播中的引号、金句、问句和关键词都不算画面文字要求/u);
  assert.match(nextPrompt, /禁止嵌套画中画和倒影主体/u);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-voiceover-cinematic-v3-6-3-${stamp}`;
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
  assert.ok(rollbackVersion, "v3.6.2未进入平台回滚历史");

  const outputStyle = {
    ...(before.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.6.3",
    clause_visual_evidence_gate: "every_spoken_semantic_point_requires_a_matching_visible_change_not_only_a_narration_anchor",
    semantic_substitution_gate: "reject_generic_care_actions_that_replace_the_actual_aesthetic_risk_judgment_or_emotion_claim",
    abstract_semantic_fallback: "brief_editorial_overlay_or_bounded_cutaway_in_the_locked_real_scene",
    editorial_overlay_surface_gate: "screen_layer_only_no_mirror_glass_window_phone_photo_or_reflected_subject",
    editorial_text_policy: "symbol_by_default_voiceover_quotes_are_not_on_screen_text_only_explicit_special_notes_can_request_label",
    free_canvas_coupling: false,
  };
  await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
    method: "PUT",
    body: JSON.stringify({ agentId: before.id, system_prompt: nextPrompt, output_style: outputStyle }),
  });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: before.id, prompt: nextPrompt, max_versions: 30 }),
  });

  const afterPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const after = afterPayload.agents.find((item) => item.id === target.id);
  assert.ok(after && after.system_prompt === nextPrompt, "v3.6.3未生效");
  assert.equal(after.name, target.name);
  assert.equal(after.output_style?.schema_version, "storyboard_director_output_style.v3.6.3");
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
  assert.ok(liveVersion, "v3.6.3未进入平台历史");
  await writeFile(`${backupDir}/agents/${after.id}-after.json`, `${JSON.stringify(after, null, 2)}\n`, "utf8");
  const verification = {
    passed: true,
    agentId: after.id,
    agentName: after.name,
    schemaBefore: target.expectedSchema,
    schemaAfter: after.output_style?.schema_version,
    beforeSha256: target.expectedSha,
    afterSha256: liveSha,
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: before.system_prompt.length,
    promptCharsAfter: nextPrompt.length,
    failedRegressionFixed: [
      "spoken_fat_aesthetic_and_overweight_judgment_replaced_by_unrelated_water_and_food_actions",
      "editorial_overlay_attached_to_window_reflection_and_unnecessary_english_label",
      "voiceover_quotes_misread_as_required_on_screen_text",
    ],
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
