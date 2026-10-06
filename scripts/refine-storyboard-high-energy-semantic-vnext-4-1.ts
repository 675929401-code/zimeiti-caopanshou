import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "0e9d7b4550efa5a80cb5d8b0f01624af484f40c62e18c3d833e02b452d0030ee",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);
const oldMarker = "【主次决策与视觉母题导演 vNext.4 2026-08-15】";
const marker = "【主次决策与视觉母题导演 vNext.4.1 2026-08-15】";
const oldPersonRule = "2. 用户未指定人物且文案没有年龄、性别、关系或职业事实要求时，默认选择一位明确成年亚洲女性；再从当前场景与动作需求推导具体年龄、发型、服装、鞋履、体态和身份并锁定。不得固定黄卫衣模板，也不得写成含混的“主人”“一个人”。文案或用户明确人物时严格服从。";
const personRule = "2. 用户未指定人物且文案没有年龄、性别、关系或职业事实要求时，默认选择一位明确成年亚洲女性；该人物必须进入本段完整资产锁，并至少在一格与宠物、道具或环境发生有意义的反应或关系行为，不得因为文案可以由宠物单独表演就省略。再从当前场景与动作需求推导具体年龄、发型、服装、鞋履、体态和身份并锁定。不得固定黄卫衣模板，也不得写成含混的“主人”“一个人”。文案或用户明确人物时严格服从。";

interface PromptVersion {
  id: string;
  prompt: string;
}

interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields?: unknown;
  output_style?: Record<string, unknown>;
  guide_message?: string;
  [key: string]: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function replaceOnce(prompt: string, from: string, to: string, label: string): string {
  assert.equal(prompt.split(from).length - 1, 1, `${label}待替换文本数量异常`);
  return prompt.replace(from, to);
}

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${url} 请求失败（${response.status}）`);
  return payload;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
  assert.ok(agent, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前Prompt不是预期vNext.4");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `后续卡片基线异常：${id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-1-change-${stamp}`;
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
  assert.ok(rollbackVersion, "vNext.4回滚版本未进入平台历史");

  let nextPrompt = replaceOnce(agent.system_prompt, oldMarker, marker, "版本标记");
  nextPrompt = replaceOnce(nextPrompt, oldPersonRule, personRule, "默认人物强制落地规则");
  assert.match(nextPrompt, /不得因为文案可以由宠物单独表演就省略/u);

  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.1",
    default_unspecified_person: "required_specific_adult_asian_woman_in_asset_lock_and_scene_interaction",
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
  assert.ok(verified && verified.system_prompt.includes(marker), "高能vNext.4.1未生效");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止提前修改的后续卡发生变化：${id}`);
  }

  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`,
    session.token,
  );
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === sha256(verified.system_prompt));
  assert.ok(liveVersion, "vNext.4.1当前版本未进入平台历史");
  await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
  const verification = {
    passed: true,
    agentId: agent.id,
    agentName: agent.name,
    beforeSha256: target.expectedSha,
    afterSha256: sha256(verified.system_prompt),
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: agent.system_prompt.length,
    promptCharsAfter: verified.system_prompt.length,
    outputStyle: verified.output_style,
    fix: "default adult Asian woman must enter the asset lock and have at least one meaningful interaction",
    siblingsUnchanged: [...siblingExpectedShas.entries()].map(([id, promptSha256]) => ({ id, promptSha256 })),
    backupDir,
  };
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
