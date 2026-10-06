import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "f888706e5754545949c4ed7aadce377dd8c8e55ca17f27198ba1af4d8e5c23c3",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);
const oldMarker = "【主次决策与视觉母题导演 vNext.4.3.2 2026-08-15】";
const marker = "【主次决策与视觉母题导演 vNext.4.3.3 2026-08-15】";
const oldHeroWording = "可选择条件反射回路、因果机关、折返轨道、场景尺度变化等开放语法";
const newHeroWording = "可选择生活道具尺度化、家具门窗重组、纸片/绳结/气球/跷跷板/弹簧等现实物理舞台、自然元素变化、圆形对比窗或漫画动作框等开放语法";
const directionBlock = [
  "【非科幻商业动画包装与表演升级门禁】",
  "1. 高能炫酷的默认语法是高端商业3D动画电影、漫画动作物理与场景内实体语义包装，不是赛博朋克、机械工厂或科技HUD。除非文案明确科技、机器人、工业或机械主题，禁止金属传送带、工业机械臂、赛博控制台、全息HUD、电路板、实验室舱门和无来源霓虹轨道；不得把英雄揭示自动做成黑色机械舞台。",
  "2. 先提炼观众必须一眼看懂的唯一概念，再寻找与该概念结构同构的现实载体并放大、重组或舞台化。候选来自当前场景的生活道具、空间结构、自然元素、宠物用品、门窗家具、绳结、跷跷板、弹簧、气球、纸片、脚印、时钟、放大镜、温度计、刻度、警示牌、聚光灯、漫画爆炸框、圆形对比窗、动作线，以及真实尘土/碎屑/毛发/水滴。盾牌、天平、发光牌、爱心和问号只是语义匹配时的候选，绝不是固定答案。",
  "3. 每格只保留一个主包装和最多两个辅助效果。主包装必须与人物或宠物发生碰撞、推拉、躲闪、追逐、遮挡、弹开、拉紧、碎裂或转化；若只是悬浮说明、堆满杂乱图标、脱离场景或换到无关文案仍成立，立即淘汰。",
  "4. 色彩采用高饱和但干净的语义配色，可从暖金、青蓝、红橙、绿色及当前场景固有色中组织层级；前后格必须有明确亮度、综合色和强调色变化。禁止统一棕黄、脏灰、四格同色，也禁止把蓝色科技光设为默认答案。",
  "5. 每格分别写出人物和宠物的情绪动词与动作峰值。人物用不对称眉形、明确视线、嘴部开合、下颌方向、身体压缩/拉伸、重心偏移和四肢发力形成夸张但漂亮的剪影；禁止普通微笑、普通蹲姿和无表情站立。宠物的喜悦、惊讶、焦虑、警惕、委屈或得意必须由眼睛、耳朵、嘴、脊背、四肢和尾巴共同变化，不得只换眼神。",
  "6. 4格至少3格、5格至少4格有明确动作峰值；全板至少一格为近距离面部表演、一格为全身强姿态、一格为非人体物件形成的强前景冲击、一格为语义道具高潮。女主仍须保持28至32岁成年亚洲女性的经典商业3D美型，所有手臂归属与五指规则继续为硬门禁。",
].join("\n");

interface PromptVersion { id: string; prompt: string }
interface AgentRecord { id: string; name: string; system_prompt: string; output_style?: Record<string, unknown>; [key: string]: unknown }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
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
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前Prompt不是预期vNext.4.3.2");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的后续卡片基线异常：${id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-3-3-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, { method: "POST", body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }) });
  const beforeHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const rollbackVersion = beforeHistory.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "vNext.4.3.2回滚版本未进入平台历史");

  assert.equal(agent.system_prompt.split(oldMarker).length - 1, 1, "版本标记数量异常");
  assert.equal(agent.system_prompt.split(oldHeroWording).length - 1, 1, "旧英雄语法文本数量异常");
  let nextPrompt = agent.system_prompt.replace(oldMarker, `${marker}\n${directionBlock}`);
  nextPrompt = nextPrompt.replace(oldHeroWording, newHeroWording);
  for (const fragment of ["不是赛博朋克、机械工厂或科技HUD", "禁止金属传送带", "每格只保留一个主包装和最多两个辅助效果", "不得只换眼神", "近距离面部表演"]) assert.ok(nextPrompt.includes(fragment));
  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.3.3",
    spectacle_default: "premium_commercial_3d_plus_comic_physics_plus_scene_native_semantic_packaging",
    sci_fi_gate: "forbidden_unless_copy_explicitly_technology_or_mechanical",
    packaging_density: "one_primary_plus_at_most_two_supporting_effects_per_panel",
    performance_gate: "coordinated_face_ears_mouth_spine_tail_weight_shift;closeup_fullbody_foreground_semantic_climax",
    semantic_priority: "user_and_copy_explicit_facts_then_defaults_when_unspecified",
    free_canvas_coupling: false,
  };
  await requestJson(`${baseUrl}/api/admin/agents`, session.token, { method: "PUT", body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt, output_style: outputStyle }) });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, { method: "POST", body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }) });
  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === target.id);
  assert.ok(verified && verified.system_prompt.includes(marker), "高能vNext.4.3.3未生效");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止提前修改的后续卡发生变化：${id}`);
  }
  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === sha256(verified.system_prompt));
  assert.ok(liveVersion, "vNext.4.3.3当前版本未进入平台历史");
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
