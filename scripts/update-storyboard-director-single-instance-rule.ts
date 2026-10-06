import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const marker = "【单主体实例硬规则（生图与视频共用）】";
const targetIds = [
  "agent-1786633444187-594spj",
  "agent-1786642714227-e1zid1",
  "agent-1786642714448-m6iaou",
];

const rule = `${marker}
资产设定为一人一宠时，每格故事板和每个真实视频镜头必须恰好出现该1名人物与该1只宠物，不得克隆、镜像或增加同类主体。禁止使用“从宠物耳侧/肩后看向宠物自身”等会把同一宠物同时画成前景和主体的构图；需要过肩关系镜头时，只能从人物肩后看向唯一宠物，或改为侧面双主体镜头。
每条生图 Prompt 末尾必须把已锁定的具体资产名称写进英文计数约束：exactly one [具体人物资产] and exactly one [具体宠物资产] in every panel; never duplicate, clone, mirror, or add either subject. 输出时必须替换方括号内容，不得保留占位符。提交前逐格计数；发现任一主体重复时先在内部重写，不得把错误 Prompt 输出给用户。`;

interface AdminAgent {
  id: string;
  name: string;
  system_prompt: string;
  model?: string;
  model_id?: string | null;
  preset_fields?: unknown;
  output_style?: unknown;
  response_format?: unknown;
  updated_at?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function jsonRequest<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
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

  const initial = await jsonRequest<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const targets = targetIds.map((id) => initial.agents.find((agent) => agent.id === id));
  assert.ok(targets.every(Boolean), "三张故事版导演卡片未全部找到");

  const safeTargets = targets as AdminAgent[];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
  const backupDir = `backups/storyboard-directors-single-instance-preflight-${timestamp}`;
  await mkdir(backupDir, { recursive: true });
  await writeFile(`${backupDir}/agents.json`, JSON.stringify({
    created_at: new Date().toISOString(),
    reason: "Add a reusable one-human/one-pet instance guard before lyrical image retry.",
    agents: safeTargets.map((agent) => ({
      id: agent.id,
      name: agent.name,
      system_prompt: agent.system_prompt,
      system_prompt_sha256: sha256(agent.system_prompt),
      model: agent.model,
      model_id: agent.model_id,
      preset_fields: agent.preset_fields,
      output_style: agent.output_style,
      response_format: agent.response_format,
      updated_at: agent.updated_at,
    })),
  }, null, 2), "utf8");

  for (const agent of safeTargets) {
    await jsonRequest(`${baseUrl}/api/admin/prompt-versions`, session.token, {
      method: "POST",
      body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 10 }),
    });

    const nextPrompt = agent.system_prompt.includes(marker)
      ? agent.system_prompt
      : `${agent.system_prompt.trim()}\n\n${rule}`;
    await jsonRequest(`${baseUrl}/api/admin/agents`, session.token, {
      method: "PUT",
      body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt }),
    });
  }

  const verified = await jsonRequest<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const summary = [];
  for (const id of targetIds) {
    const agent = verified.agents.find((item) => item.id === id);
    assert.ok(agent, `${id}未找到，无法校验单主体规则`);
    assert.ok(agent.system_prompt.includes(marker), `${id}未写入单主体规则`);
    const history = await jsonRequest<{ versions: Array<{ prompt: string }> }>(
      `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(id)}`,
      session.token,
    );
    assert.ok(history.versions.length >= 2, `${agent.name}云端提示词历史不足2条`);
    const original = safeTargets.find((item) => item.id === id)!;
    assert.ok(history.versions.some((version) => sha256(version.prompt) === sha256(original.system_prompt)), `${agent.name}云端历史缺少旧提示词`);
    assert.ok(history.versions.some((version) => version.prompt.includes(marker)), `${agent.name}云端历史缺少新提示词`);
    summary.push({
      id,
      name: agent.name,
      oldLength: original.system_prompt.length,
      newLength: agent.system_prompt.length,
      promptVersions: history.versions.length,
    });
  }

  console.log(JSON.stringify({ passed: true, backupDir, agents: summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
