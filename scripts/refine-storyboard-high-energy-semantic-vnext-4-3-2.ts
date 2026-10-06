import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "c028fea1fbed5da74d29f3f09a73a1b67034affc7e1222387e6ba53050c00905",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);
const oldMarker = "【主次决策与视觉母题导演 vNext.4.3.1 2026-08-15】";
const marker = "【主次决策与视觉母题导演 vNext.4.3.2 2026-08-15】";
const spectacleBlock = [
  "【高能叙事节拍、英雄机制舞台与跨格色彩门禁】",
  "1. 4格必须严格承担四个不同节拍：异常动作钩子→误解升级→英雄级语义机制揭示→行为反转高潮。5格必须严格承担：钩子→升级→冲突→英雄揭示→高潮收束。不得把同一暖色生活场景只换角度重复四至五次；每格必须是新的视觉事件、动作阶段和画面职责。",
  "2. 英雄揭示格必须把当前文案的因果机制空间化为本段独有的装置、机关或舞台，占该格约25%至40%视觉面积，并成为缩略图唯一钩子。该格须与相邻生活格形成明确冷暖、明暗或材质反差；即使空间连续，也要通过局部舞台化灯光、空间结构、道具尺度和材质切换形成一眼可辨的机制世界，禁止只在原客厅地板叠一条普通发光线。",
  "3. 人物和宠物必须对英雄装置做出可见动作互动，例如触发、踩压、躲避、拉断、承接、穿越或改道；装置随互动发生受力、位移、形变、连锁或消退，不能悬浮展示。装置只能由当前语义核推导，可选择条件反射回路、因果机关、折返轨道、场景尺度变化等开放语法，但不得预设固定盾牌、天平、金色警报牌或把同一装置套给无关文案。",
  "4. 色彩脚本必须逐格写清并真正拉开曝光和综合色差：生活钩子采用场景自然基础色加冲突强调色；误解升级转向冷色或压暗；英雄揭示使用与前格明显对抗的冷暖、明暗或材质高反差；高潮回归明亮自然光并只保留一处强调色。禁止全板同色温、同亮度、统一暖棕或全片冷蓝。",
  "5. 全张故事板画内短标签最多一个且可完全不用；英雄机制必须在无文字状态下仍可读。输出前硬检：若没有占25%至40%的英雄机制、角色未与之互动、四格同色同亮度、仍像普通监控构图或高潮只是安静海报，立即重选方案，不得输出。女主美型、唯一手臂归属、五指、前景非人体物件优先等vNext.4.3.1门禁继续完整执行。",
].join("\n");

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
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前Prompt不是预期vNext.4.3.1");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的后续卡片基线异常：${id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-3-2-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, { method: "POST", body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }) });
  const beforeHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const rollbackVersion = beforeHistory.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "vNext.4.3.1回滚版本未进入平台历史");

  assert.equal(agent.system_prompt.split(oldMarker).length - 1, 1, "版本标记数量异常");
  const nextPrompt = agent.system_prompt.replace(oldMarker, `${marker}\n${spectacleBlock}`);
  for (const fragment of ["异常动作钩子→误解升级→英雄级语义机制揭示→行为反转高潮", "占该格约25%至40%视觉面积", "禁止只在原客厅地板叠一条普通发光线", "全张故事板画内短标签最多一个"]) assert.ok(nextPrompt.includes(fragment));
  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.3.2",
    high_energy_story_beats: "4=hook_escalation_hero_mechanism_reversal;5=hook_escalation_conflict_hero_mechanism_climax",
    hero_mechanism_gate: "semantic_unique_25_40_percent_character_interaction_high_contrast",
    cross_panel_color_gate: "distinct_temperature_exposure_or_material;no_uniform_room_palette",
    in_scene_text_budget: "max_one_optional_short_label",
    free_canvas_coupling: false,
  };
  await requestJson(`${baseUrl}/api/admin/agents`, session.token, { method: "PUT", body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt, output_style: outputStyle }) });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, { method: "POST", body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }) });

  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === target.id);
  assert.ok(verified && verified.system_prompt.includes(marker), "高能vNext.4.3.2未生效");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止提前修改的后续卡发生变化：${id}`);
  }
  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === sha256(verified.system_prompt));
  assert.ok(liveVersion, "vNext.4.3.2当前版本未进入平台历史");
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
