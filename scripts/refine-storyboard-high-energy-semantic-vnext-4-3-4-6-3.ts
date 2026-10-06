import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  expectedSha: "923b1f4e63a4b7ca93fa009dd487c794ce140cac6cc64ea22db522ee300444a2",
  expectedSchema: "storyboard_director_output_style.v3.4.3.4.6.2",
};
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);

interface PromptVersion { id: string; prompt: string }
interface AgentRecord {
  id: string;
  system_prompt: string;
  output_style?: Record<string, unknown>;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json() as T & { error?: string };
  assert.ok(response.ok, payload.error || `${init.method || "GET"} ${url} failed (${response.status})`);
  return payload;
}

async function main() {
  const session = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  }).then((response) => response.json()) as { token?: string; error?: string };
  assert.ok(session.token, session.error || "本地测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id);
  assert.ok(agent, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前 Prompt 不是预期 v3.4.3.4.6.2");
  assert.equal(agent.output_style?.schema_version, target.expectedSchema, "高能版当前 schema 不是预期 v3.4.3.4.6.2");
  assert.equal(agent.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }

  const oldContinuity = "为连续故事静默维护状态表：段前与段后的人物位置、宠物位置、门窗开合、主道具位置、视线、情绪强度、时间先后、光线与视觉母题。第N+1段必须从第N段的段后状态开始；同一动作不得无故重演，同一扇门不得无故反复关闭和重开，角色不得瞬移或跨越空间边界。";
  const newContinuity = "为连续故事静默维护状态表：段前与段后的人物位置、宠物位置、门窗开合、主道具位置、视线、情绪强度、时间先后、光线与视觉母题。第N+1段必须从第N段的段后状态开始；同一动作不得无故重演，同一扇门不得在同一时空无故反复关闭和重开，角色不得瞬移或跨越空间边界。若原文明示‘久而久之、每次、反复、下次、后来’等时间跳跃，可用2至3次换日蒙太奇压缩同一因果循环：每次循环都重新建立零食出现、角色动作、离开发生和宠物反应，使用清楚的日光、天气或日历物理变化分隔，不能把多日经历画成宠物在同一次离开后连续独处多天。日常回家可作为镜头外省略，不表现成安慰、拥抱、和解或问题解决。";
  assert.equal(agent.system_prompt.split(oldContinuity).length - 1, 1, "跨段状态修复锚点异常");
  const nextPrompt = agent.system_prompt.replace(oldContinuity, newContinuity);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-3-4-6-3-change-${stamp}`;
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
  assert.ok(rollbackVersion, "v3.4.3.4.6.2 回滚版本未进入平台历史");

  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.3.4.6.3",
    baseline_policy: "benchmark_attire_packaging_continuity_and_explicit_repetition_time_jump",
    explicit_repetition_time_jump_gate: "only_when_copy_says_repeated_later_next_time;show_2_3_distinct_cycles_with_day_markers;never_one_unbroken_multi_day_abandonment",
    omitted_return_policy: "ordinary_return_may_be_offscreen_between_cycles_never_reconciliation_or_resolution",
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
  assert.ok(verified && verified.system_prompt === nextPrompt, "高能 v3.4.3.4.6.3 未生效");
  assert.equal(verified.output_style?.schema_version, "storyboard_director_output_style.v3.4.3.4.6.3");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片发生变化：${id}`);
  }

  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`,
    session.token,
  );
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === sha256(nextPrompt));
  assert.ok(liveVersion, "v3.4.3.4.6.3 当前版本未进入平台历史");
  await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");

  const verification = {
    passed: true,
    agentId: agent.id,
    schemaVersion: verified.output_style?.schema_version,
    beforeSha256: target.expectedSha,
    afterSha256: sha256(nextPrompt),
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: agent.system_prompt.length,
    promptCharsAfter: nextPrompt.length,
    change: "修复久而久之被误画成同一次离开后跨日独处；仅在原文明示时允许分日重复因果蒙太奇",
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
