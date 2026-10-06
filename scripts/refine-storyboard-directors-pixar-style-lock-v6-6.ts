import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const marker = "【皮克斯3D跨图视频风格锁 v6.6】";
const defaultPixarStyle = "高能商业3D动画喜剧（皮克斯式）";

const agentIds = [
  "agent-1786633444187-594spj",
  "agent-1786642714227-e1zid1",
  "agent-1786642714448-m6iaou",
] as const;

interface PresetField {
  id: string;
  label: string;
  type: "text" | "select" | "textarea";
  placeholder?: string;
  required?: boolean;
  options?: string[];
  order?: number;
  defaultValue?: string;
  [key: string]: unknown;
}

interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields: PresetField[];
  output_style?: Record<string, unknown>;
  guide_message?: string;
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

const oldPixarLine = "1. `高能商业3D动画喜剧（皮克斯式）`：圆润但精致的电影角色造型，放大高光眼睛，可信毛发与布料，暖亮轮廓光、综合色彩、强姿态剪影、弹性压缩拉伸和电影级浅景深；兼具可信底片与夸张漫画动作。";

const newPixarLine = "1. `高能商业3D动画喜剧（皮克斯式）`（默认）：高端商业级风格化3D动画电影造型。人物使用圆润动画头骨与面部拓扑、略放大的高光眼睛、简化但清晰的鼻唇和眉眼、成熟但明确非真人的身体比例；宠物保留可读犬种、自然四足和动画化表情。皮肤为平滑无可见毛孔的半写实PBR动画材质，毛发、布料、木材可以细腻可信，但“材质真实”绝不等于真人化。使用暖金轮廓高光、青蓝干净暗部、综合色彩、强姿态剪影、弹性压缩拉伸和电影级浅景深。禁止真人照片脸、实拍皮肤纹理、真实毛孔、真人解剖五官比例、蜡像脸、照片级宠物摄影，禁止把动画参考图重绘成真人。";

const styleLockBlock = `

# 皮克斯3D跨图视频风格锁
${marker}
- 当 animation_style 缺失、为空或用户未明确选择时，必须使用“${defaultPixarStyle}”；其余9种3D风格仅在用户主动选择时生效。
- 生图Prompt与图生视频Prompt必须读取同一个动画风格，不得在视频阶段重新解释风格。两份Prompt的开头都要写出所选风格的可执行视觉特征，不能只写“电影级”“高品质”或只在末尾追加禁止词。
- 默认皮克斯式的正向锚点是：风格化3D动画头骨和五官比例、略放大高光眼睛、平滑无可见毛孔的半写实PBR动画皮肤、清晰动画轮廓、可信毛发与布料、暖金高光与青蓝干净暗部。材质细腻不等于真人实拍。
- 默认皮克斯式的反向边界是：真人照片脸、实拍皮肤纹理、真实毛孔、真人鼻梁下颌和法令纹、蜡像脸、照片级真人摄影、照片级宠物摄影、从动画参考图重绘为真人。任何一项出现都判定风格漂移并重写。
- 图生视频Prompt第一段必须先写“风格首要锁定”，再写角色、场景和动作。若文字描述与故事板可见造型冲突，以故事板里已经生成的动画化头骨、眼睛比例、轮廓和材质为最高真值；只允许让角色动起来，不允许真人化重设计。
- 视频不得把故事板内的语义特效独立放大成整段主画面。特效必须由角色动作触发、服务当前语义并及时收束；角色、宠物和故事动作始终是主体。
- 输出前必须做跨模态一致性检查：生图与视频的角色年龄、五官比例、服装、宠物品种、材质、色彩和动画风格逐项一致；发现真人化、宠物写实摄影化或统一棕黄滤镜时，直接重写Prompt后再输出。
`;

function buildPrompt(currentPrompt: string): string {
  assert.match(currentPrompt, /^# 角色/u);
  assert.ok(currentPrompt.includes(oldPixarLine) || currentPrompt.includes(newPixarLine), "缺少皮克斯风格字典锚点");
  assert.ok(currentPrompt.includes("# 图生视频Prompt写法"), "缺少图生视频Prompt锚点");

  let nextPrompt = currentPrompt.replace(oldPixarLine, newPixarLine);
  const blockStart = "\n# 皮克斯3D跨图视频风格锁\n";
  if (nextPrompt.includes(blockStart)) {
    const start = nextPrompt.indexOf(blockStart);
    const end = nextPrompt.indexOf("\n# 图生视频Prompt写法", start);
    assert.ok(end > start, "既有皮克斯风格锁边界异常");
    nextPrompt = `${nextPrompt.slice(0, start)}${nextPrompt.slice(end)}`;
  }
  nextPrompt = nextPrompt.replace("\n# 图生视频Prompt写法", `${styleLockBlock}\n# 图生视频Prompt写法`);

  assert.equal(nextPrompt.split(marker).length - 1, 1, "皮克斯风格锁重复");
  assert.match(nextPrompt, /风格首要锁定/u);
  assert.match(nextPrompt, /平滑无可见毛孔/u);
  return nextPrompt;
}

function buildPresetFields(fields: PresetField[]): PresetField[] {
  assert.ok(Array.isArray(fields) && fields.length >= 5, "接收模板字段不足");
  let found = false;
  const next = fields.map((field) => {
    if (field.id !== "animation_style") return field;
    found = true;
    assert.equal(field.type, "select", "动画风格字段不是下拉选择");
    assert.equal(field.options?.length, 10, "动画风格必须保留10个选项");
    assert.equal(field.options?.[0], defaultPixarStyle, "皮克斯式必须保持首个选项");
    return {
      ...field,
      defaultValue: defaultPixarStyle,
      description: "默认皮克斯3D；如需其他视觉方向，可从10种3D动画风格中切换。",
    };
  });
  assert.ok(found, "未找到 animation_style 字段");
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
  const backupDir = `backups/storyboard-directors-pixar-style-lock-v6.6-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });

  const beforeManifest = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    prompt_chars: agent.system_prompt.length,
    prompt_sha256: sha256(agent.system_prompt),
    animation_style_default: agent.preset_fields.find((field) => field.id === "animation_style")?.defaultValue ?? null,
    updated_at: agent.updated_at ?? null,
  }));
  await writeFile(`${backupDir}/manifest-before.json`, JSON.stringify(beforeManifest, null, 2), "utf8");
  await Promise.all(agents.map((agent) => writeFile(
    `${backupDir}/agents/${agent.id}-before.json`,
    JSON.stringify(agent, null, 2),
    "utf8",
  )));

  for (const agent of agents) {
    const nextPrompt = buildPrompt(agent.system_prompt);
    const nextPresetFields = buildPresetFields(agent.preset_fields);

    await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
      method: "POST",
      body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }),
    });
    await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
      method: "PUT",
      body: JSON.stringify({
        agentId: agent.id,
        system_prompt: nextPrompt,
        preset_fields: nextPresetFields,
      }),
    });
    await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
      method: "POST",
      body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }),
    });
  }

  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verifiedAgents = agentIds.map((id) => {
    const agent = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(agent, `更新后未找到故事版导演：${id}`);
    assert.equal(agent.system_prompt.split(marker).length - 1, 1, `${agent.name} 风格锁数量异常`);
    assert.match(agent.system_prompt, /高端商业级风格化3D动画电影造型/u);
    assert.match(agent.system_prompt, /视频阶段重新解释风格/u);
    const styleField = agent.preset_fields.find((field) => field.id === "animation_style");
    assert.equal(styleField?.options?.length, 10, `${agent.name} 风格选项数量变化`);
    assert.equal(styleField?.defaultValue, defaultPixarStyle, `${agent.name} 默认风格未生效`);
    return agent;
  });

  await Promise.all(verifiedAgents.map((agent) => writeFile(
    `${backupDir}/agents/${agent.id}-after.json`,
    JSON.stringify(agent, null, 2),
    "utf8",
  )));

  const result = {
    passed: true,
    marker,
    defaultPixarStyle,
    backupDir,
    agents: verifiedAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      prompt_chars: agent.system_prompt.length,
      prompt_sha256: sha256(agent.system_prompt),
      animation_style_default: agent.preset_fields.find((field) => field.id === "animation_style")?.defaultValue,
      style_option_count: agent.preset_fields.find((field) => field.id === "animation_style")?.options?.length,
    })),
  };
  await writeFile(`${backupDir}/verification.json`, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
