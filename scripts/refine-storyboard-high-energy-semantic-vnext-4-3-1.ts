import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "79fa02604ddfe9b1e8b37a3185e8e29bde60c59b97bc2891ca94a3a079e18237",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);
const oldMarker = "【主次决策与视觉母题导演 vNext.4.3 2026-08-15】";
const marker = "【主次决策与视觉母题导演 vNext.4.3.1 2026-08-15】";
const foregroundSafety = "强透视不得牺牲归属：同一画格内，同一只手和同一件手持道具只能出现一次。禁止把前景特写手/钥匙/量杯等与中景人物手中的同物再画一份；手持物冲向镜头时，必须在同一连续透视链上完整看见手掌—手腕—前臂—肘—上臂—肩。若无法保证，就把前景冲击改为无人手接触的滚动物、飞散物、家具、织物或环境形变，并让人物双手在中景完整可辨。输出前逐格排除任何画面边缘伸入却无完整归属的手、前臂和重复道具。";

interface PromptVersion { id: string; prompt: string }
interface AgentRecord { id: string; name: string; system_prompt: string; output_style?: Record<string, unknown>; [key: string]: unknown }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${url} 请求失败（${response.status}）`);
  return payload;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" } });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");
  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
  assert.ok(agent, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前Prompt不是预期vNext.4.3");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的后续卡片基线异常：${id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-3-1-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, { method: "POST", body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }) });
  const beforeHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const rollbackVersion = beforeHistory.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "vNext.4.3回滚版本未进入平台历史");

  assert.equal(agent.system_prompt.split(oldMarker).length - 1, 1, "版本标记数量异常");
  const nextPrompt = agent.system_prompt.replace(oldMarker, `${marker}\n【强透视手部与道具去重】\n${foregroundSafety}`);
  for (const fragment of ["同一只手和同一件手持道具只能出现一次", "手掌—手腕—前臂—肘—上臂—肩", "画面边缘伸入却无完整归属"]) assert.ok(nextPrompt.includes(fragment));
  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.3.1",
    foreground_handheld_gate: "single_instance_full_arm_chain_or_use_non_body_foreground",
    free_canvas_coupling: false,
  };
  await requestJson(`${baseUrl}/api/admin/agents`, session.token, { method: "PUT", body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt, output_style: outputStyle }) });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, { method: "POST", body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }) });

  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === target.id);
  assert.ok(verified && verified.system_prompt.includes(marker), "高能vNext.4.3.1未生效");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止提前修改的后续卡发生变化：${id}`);
  }
  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === sha256(verified.system_prompt));
  assert.ok(liveVersion, "vNext.4.3.1当前版本未进入平台历史");
  await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
  const verification = {
    passed: true,
    agentId: agent.id,
    beforeSha256: target.expectedSha,
    afterSha256: sha256(verified.system_prompt),
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: agent.system_prompt.length,
    promptCharsAfter: verified.system_prompt.length,
    siblingsUnchanged: [...siblingExpectedShas.entries()].map(([id, promptSha256]) => ({ id, promptSha256 })),
    freeCanvasCoupling: false,
    backupDir,
  };
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
