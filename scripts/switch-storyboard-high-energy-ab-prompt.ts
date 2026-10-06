import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const action = process.env.AB_PROMPT_ACTION || "baseline";
const agentId = "agent-1786633444187-594spj";
const baselinePath = "backups/storyboard-directors-v6.3.2-2026-08-14T153730493Z/before.json";
const snapshotPath = ".tmp-e2e/storyboard-high-energy-ab-current-v634.json";

interface AgentRecord {
  id: string;
  name: string;
  system_prompt?: string;
  prompt?: string;
  updated_at?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

async function setPrompt(token: string, prompt: string): Promise<void> {
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, prompt, max_versions: 12 }),
  });
  await requestJson(`${baseUrl}/api/admin/agents`, token, {
    method: "PUT",
    body: JSON.stringify({ agentId, system_prompt: prompt }),
  });
}

async function main() {
  assert.ok(["baseline", "restore"].includes(action), `未知动作：${action}`);
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const agentsPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const current = agentsPayload.agents.find((item) => item.id === agentId);
  assert.ok(current?.system_prompt, "未找到高能导演当前提示词");

  let targetPrompt = "";
  if (action === "baseline") {
    assert.match(current.system_prompt, /【高能语义主包装 v6\.3\.4】/, "当前线上不是待对比的v6.3.4，拒绝覆盖");
    await writeFile(snapshotPath, JSON.stringify({
      id: current.id,
      name: current.name,
      prompt: current.system_prompt,
      prompt_sha256: sha256(current.system_prompt),
      updated_at: current.updated_at,
    }, null, 2), "utf8");
    const backup = JSON.parse(await readFile(baselinePath, "utf8")) as { agents?: AgentRecord[] };
    const baseline = backup.agents?.find((item) => item.id === agentId);
    targetPrompt = baseline?.prompt || "";
    assert.match(targetPrompt, /【高能空间分层校准 v6\.3\.1】/, "备份中没有v6.3.1高能提示词");
    assert.doesNotMatch(targetPrompt, /【时长与镜头映射校准 v6\.3\.2】/, "基线意外包含时长校准版本");
  } else {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as AgentRecord;
    targetPrompt = snapshot.prompt || "";
    assert.match(targetPrompt, /【高能语义主包装 v6\.3\.4】/, "恢复快照不是v6.3.4");
  }

  await setPrompt(session.token, targetPrompt);
  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === agentId);
  assert.equal(sha256(verified?.system_prompt || ""), sha256(targetPrompt), `${action}后提示词哈希不一致`);
  console.log(JSON.stringify({ action, passed: true, chars: targetPrompt.length, sha256: sha256(targetPrompt) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
