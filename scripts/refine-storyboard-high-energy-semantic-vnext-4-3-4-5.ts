import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张", expectedSha: "904b931a2d76ad449c30ebe0bfabeab235716d9756fa1e6afb26d04e7bb229f8" } as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);
interface PromptVersion { id: string; prompt: string }
interface AgentRecord { id: string; name: string; system_prompt: string; output_style?: Record<string, unknown>; [key: string]: unknown }
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}), ...init.headers } });
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
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前 Prompt 不是预期 vNext.4.3.4.4");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }
  const oldCaptionRule = "说明条的唯一文字资产是一条12至24词的英文动作句，使用清晰黑色无衬线体逐字完整排印。";
  const newCaptionRule = "说明条的唯一文字资产是一条8至14词、只用常用词的英文动作句，使用清晰黑色无衬线体逐字完整排印。";
  const oldTemplate = "4. 每格紧随准确英文说明条，格式：Frame N: camera move as subject action, secondary reaction, physical or semantic effect, and outcome.";
  const newTemplate = "4. 每格紧随准确英文说明条，控制8至14词，格式：Frame N: subject acts as camera moves and one effect lands.";
  assert.ok(agent.system_prompt.includes(oldCaptionRule) && agent.system_prompt.includes(oldTemplate), "未找到英文说明条压缩锚点");
  const nextPrompt = agent.system_prompt.replace(oldCaptionRule, newCaptionRule).replace(oldTemplate, newTemplate);
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-3-4-5-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, { method: "POST", body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }) });
  const beforeHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const rollbackVersion = beforeHistory.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "vNext.4.3.4.4 回滚版本未进入平台历史");
  const outputStyle = { ...(agent.output_style || {}), schema_version: "storyboard_director_output_style.v3.4.3.4.5", caption_word_budget: "8-14_common_english_words" };
  await requestJson(`${baseUrl}/api/admin/agents`, session.token, { method: "PUT", body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt, output_style: outputStyle }) });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, { method: "POST", body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }) });
  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === target.id);
  assert.ok(verified && verified.system_prompt === nextPrompt, "高能 vNext.4.3.4.5 未生效");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片发生变化：${id}`);
  }
  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === sha256(nextPrompt));
  assert.ok(liveVersion, "vNext.4.3.4.5 当前版本未进入平台历史");
  await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
  const verification = { passed: true, agentId: agent.id, beforeSha256: target.expectedSha, afterSha256: sha256(nextPrompt), beforePromptHistoryId: rollbackVersion.id, afterPromptHistoryId: liveVersion.id, promptCharsBefore: agent.system_prompt.length, promptCharsAfter: nextPrompt.length, change: "英文动作说明条压缩为8至14个常用词", siblingsUnchanged: [...siblingExpectedShas.entries()].map(([id, promptSha256]) => ({ id, promptSha256 })), freeCanvasCoupling: false, backupDir };
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
