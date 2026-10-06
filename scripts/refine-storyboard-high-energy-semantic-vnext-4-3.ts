import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "f81b48aeed6f85abb74e5119a8c2976ecbc035b93957e9175056cc63326ff3dd",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);
const oldMarker = "【主次决策与视觉母题导演 vNext.4.2 2026-08-15】";
const marker = "【主次决策与视觉母题导演 vNext.4.3 2026-08-15】";
const heroineBlock = [
  "【高能版默认女主视觉资产锁】",
  "用户未指定人物且文案没有相反事实要求时，默认女主必须是28至32岁的成年亚洲女性、经典高端商业3D动画电影女主造型；绝不幼态、绝不儿童脸、绝不真人或半写实。脸型为柔和心形或椭圆形，三庭协调；深棕色杏仁形大眼但不过度巨大，清楚上眼睑与高光；自然直眉具有强表演弧度；鼻梁鼻翼小巧但结构可信；自然唇形、温暖微红脸颊。发型按场景在深棕色高马尾或整洁低马尾中选择一个并锁定，发束体块清楚，只有少量动态碎发。",
  "体态必须修长但健康，肩颈、手臂和腿部比例自然，姿势剪影清楚；服装从文案身份、场景与动作推导明亮主色和互补色，禁止固定黄卫衣。整张故事板严格锁定同一脸型、年龄、发型、肤色、体型与服装。表情采用经典商业3D动画的夸张可读性，但眼球、嘴、下颌不得畸形。",
  "手部硬规则再次优先于构图炫技：每只可见手必须为五指，并沿手腕→前臂→肘→上臂明确连接至唯一人物；禁止悬空手、重复手、额外前臂、从狗身后无来源伸出的手。双手扶狗时必须完整显示两条手臂的连接关系；若任一连接会被人物、狗或道具遮挡，就改为单手接触，或让双手不同时接触。",
].join("\n");

interface PromptVersion { id: string; prompt: string }
interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  output_style?: Record<string, unknown>;
  [key: string]: unknown;
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

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
  assert.ok(agent, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前Prompt不是预期vNext.4.2");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的后续卡片基线异常：${id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-3-change-${stamp}`;
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
  assert.ok(rollbackVersion, "vNext.4.2回滚版本未进入平台历史");

  assert.equal(agent.system_prompt.split(oldMarker).length - 1, 1, "版本标记数量异常");
  const nextPrompt = agent.system_prompt.replace(oldMarker, `${marker}\n${heroineBlock}`);
  for (const fragment of ["28至32岁", "杏仁形大眼但不过度巨大", "高马尾或整洁低马尾", "修长但健康", "每只可见手必须为五指", "从狗身后无来源伸出的手"]) {
    assert.ok(nextPrompt.includes(fragment), `默认女主门禁缺失：${fragment}`);
  }

  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.3",
    default_heroine_lock: "adult_asian_woman_28_32_classic_premium_commercial_3d_animation_no_child_face_no_semirealism",
    heroine_hand_gate: "five_fingers_each_visible_hand_unique_full_arm_chain_or_reduce_contact",
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
  assert.ok(verified && verified.system_prompt.includes(marker), "高能vNext.4.3未生效");
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
  assert.ok(liveVersion, "vNext.4.3当前版本未进入平台历史");
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
