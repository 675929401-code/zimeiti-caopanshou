import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const marker = "【皮克斯3D跨图视频风格锁 v6.7】";
const defaultStyle = "高能商业3D动画喜剧（皮克斯式）";
const agentIds = [
  "agent-1786633444187-594spj",
  "agent-1786642714227-e1zid1",
  "agent-1786642714448-m6iaou",
] as const;

interface PresetField {
  id: string;
  options?: string[];
  defaultValue?: string;
  [key: string]: unknown;
}

interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields: PresetField[];
  updated_at?: string;
  [key: string]: unknown;
}

const v66StyleLine = "1. `高能商业3D动画喜剧（皮克斯式）`（默认）：高端商业级风格化3D动画电影造型。人物使用圆润动画头骨与面部拓扑、略放大的高光眼睛、简化但清晰的鼻唇和眉眼、成熟但明确非真人的身体比例；宠物保留可读犬种、自然四足和动画化表情。皮肤为平滑无可见毛孔的半写实PBR动画材质，毛发、布料、木材可以细腻可信，但“材质真实”绝不等于真人化。使用暖金轮廓高光、青蓝干净暗部、综合色彩、强姿态剪影、弹性压缩拉伸和电影级浅景深。禁止真人照片脸、实拍皮肤纹理、真实毛孔、真人解剖五官比例、蜡像脸、照片级宠物摄影，禁止把动画参考图重绘成真人。";

const v67StyleLine = "1. `高能商业3D动画喜剧（皮克斯式）`（默认）：高端商业级皮克斯式3D动画电影造型，非真人实拍、非照片写实。人物必须是动画角色骨相：头部比真人略大，成人头身比约1:5.5至1:6.5，眼睛放大约20%并有清晰高光，鼻子、嘴唇、下颌和法令纹明显简化，眉眼可做大幅动画表演；皮肤是丝滑哑光、无毛孔、无真实皮肤噪点的动画表面，只保留柔和次表面散射；头发归纳成清晰大块发束，不逐根模拟真人头发。宠物保持自然四足和明确犬种，但头颅、眼睛和表情适度动画化，口鼻更短宽，毛发归纳为蓬松清晰毛束，不使用照片级犬类解剖。使用暖金轮廓高光、青蓝干净暗部、明亮通透的综合色彩、强姿态剪影、压缩拉伸、强透视和电影级浅景深。材质可以精细可信，角色解剖必须明显动画化；禁止真人照片脸、真人鼻梁下颌比例、真实毛孔与法令纹、蜡像脸、写实宠物摄影、普通监控机位和统一棕黄滤镜。";

const styleLockBlock = `

# 皮克斯3D跨图视频风格锁
${marker}
- 当 animation_style 缺失、为空或用户未主动选择时，固定使用“${defaultStyle}”；其余9种3D动画风格继续保留，只在用户明确选择时覆盖默认值。
- 默认皮克斯式生图Prompt的第一段必须原样表达以下视觉内核：高端商业级皮克斯式3D动画电影造型，非真人实拍、非照片写实；人物为略大头身比、放大高光眼睛、简化鼻唇下颌、丝滑无毛孔动画皮肤和大块发束；宠物为自然四足、明确犬种、适度放大的头颅眼睛与归纳化蓬松毛束。不得用“成熟写实人物”“半写实真人皮肤”“照片级宠物”替代。
- 图生视频Prompt第一段必须重新完整写出同一视觉内核，并声明只让故事板中的动画角色动起来，不重新设计五官、头身比、皮肤、毛束、服装或犬种。参考图中的动画角色骨相和综合色彩是最高真值。
- 精细材质只用于毛束、布料、木材、陶土和环境，不得把角色改成真人摄影。若输出出现真人鼻梁下颌、真实毛孔法令纹、逐根真人发丝、写实犬类头骨、统一棕黄滤镜或监控式平视构图，判定失败并重写。
- 每个画格必须冻结不同的动作峰值，至少变化景别、机位、动作阶段中的两项；语义包装由当前句意触发，融入角色动作和环境反馈。禁止把包装固定为金线、盾牌、文字牌，也禁止连续多格只换视角不换事件。
- 视频只读取故事板的角色、构图、动作峰值与语义特效，不显示网格和说明条；实际镜头数按目标时长规划，不得因为参考图有4或5格就机械逐格强切。
- 输出前逐项检查生图与视频的人物头身比、眼睛比例、皮肤表面、宠物毛束、服装、道具、综合色彩和语义特效；任一项漂移先重写再输出。
`;

function sha(value: string): string {
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

function updatePrompt(prompt: string): string {
  assert.ok(prompt.includes(v66StyleLine), "当前Prompt不是可识别的v6.6版本");
  const sectionStart = prompt.indexOf("\n# 皮克斯3D跨图视频风格锁\n");
  const sectionEnd = prompt.indexOf("\n# 图生视频Prompt写法", sectionStart);
  assert.ok(sectionStart > 0 && sectionEnd > sectionStart, "当前风格锁边界异常");
  const withoutOldBlock = `${prompt.slice(0, sectionStart)}${prompt.slice(sectionEnd)}`;
  const next = withoutOldBlock
    .replace(v66StyleLine, v67StyleLine)
    .replace("\n# 图生视频Prompt写法", `${styleLockBlock}\n# 图生视频Prompt写法`);
  assert.equal(next.split(marker).length - 1, 1, "v6.7风格锁重复");
  assert.ok(!next.includes("半写实PBR动画皮肤"), "旧的半写实皮肤诱导词仍存在");
  assert.match(next, /略大头身比/u);
  assert.match(next, /不重新设计五官/u);
  return next;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agents = agentIds.map((id) => {
    const agent = payload.agents.find((item) => item.id === id);
    assert.ok(agent, `未找到故事版导演：${id}`);
    return agent;
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-directors-pixar-style-lock-v6.7-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });

  for (const agent of agents) {
    await writeFile(`${backupDir}/agents/${agent.id}-before.json`, JSON.stringify(agent, null, 2), "utf8");
    const nextPrompt = updatePrompt(agent.system_prompt);
    const nextFields = agent.preset_fields.map((field) => field.id === "animation_style"
      ? { ...field, defaultValue: defaultStyle }
      : field);
    const styleField = nextFields.find((field) => field.id === "animation_style");
    assert.equal(styleField?.options?.length, 10, `${agent.name} 未保留10种风格`);

    await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
      method: "POST",
      body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }),
    });
    await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
      method: "PUT",
      body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt, preset_fields: nextFields }),
    });
    await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
      method: "POST",
      body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }),
    });
  }

  const verified = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const result = agentIds.map((id) => {
    const agent = verified.agents.find((item) => item.id === id);
    assert.ok(agent, `更新后未找到：${id}`);
    assert.equal(agent.system_prompt.split(marker).length - 1, 1, `${agent.name} v6.7标记异常`);
    assert.match(agent.system_prompt, /高端商业级皮克斯式3D动画电影造型/u);
    assert.equal(agent.preset_fields.find((field) => field.id === "animation_style")?.defaultValue, defaultStyle);
    return agent;
  });
  await Promise.all(result.map((agent) => writeFile(
    `${backupDir}/agents/${agent.id}-after.json`,
    JSON.stringify(agent, null, 2),
    "utf8",
  )));

  const verification = {
    passed: true,
    marker,
    defaultStyle,
    backupDir,
    agents: result.map((agent) => ({
      id: agent.id,
      name: agent.name,
      promptChars: agent.system_prompt.length,
      promptSha256: sha(agent.system_prompt),
      styleOptions: agent.preset_fields.find((field) => field.id === "animation_style")?.options?.length,
    })),
  };
  await writeFile(`${backupDir}/verification.json`, JSON.stringify(verification, null, 2), "utf8");
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
