import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const marker = "【高能语义主包装 v6.3.4】";

interface AdminAgent {
  id: string;
  name: string;
  system_prompt: string;
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

function refine(prompt: string): string {
  assert.match(prompt, /【语义包装判定门 v6\.3\.3】/);
  assert.doesNotMatch(prompt, /【高能语义主包装 v6\.3\.4】/);
  const expression = /# 当前导演策略\r?\n[\s\S]*?(?=\r?\n# 输入合同\r?\n)/;
  assert.match(prompt, expression);
  const body = `# 当前导演策略
【对标视觉事件语法 v6.3】
【高能空间分层校准 v6.3.1】
${marker}
本卡负责高能夸张短视频。高能来自事件升级、空间升级、角色表演和一处不可替代的语义主包装，不来自把同一种发光线、圆环或大字重复四格。把当前口播改编为“异常动作钩子 -> 主人误判与身体喜剧 -> 语义证据场 -> 强结论落点”。

四格必须形成至少三种明显不同的主体剪影、三种景别和两个视觉舞台。第一舞台是真实发生地；其中一格必须从当前动作、道具或因果自然展开为“语义证据场”，并成为本段唯一的主包装场。语义证据场可以是可触摸的放大机制、实体对比装置、局部友好剖面、路径障碍、尺度变化、瞬间舞台或角色能进入的因果演示，但必须由当前文案推导，不能套用固定模板。人物和宠物必须观察、触摸、躲避、追逐或改变其中的实体，不能站着看抽象图标。

每段至少有一处语义主包装，但不规定总特效数量。其余格先用夸张表演、真实道具、空间变化、碎屑路径和环境反馈讲清；只有仍缺信息时才增加辅助包装。禁止四格都用线条、圆环、爱心或暖金光，禁止抽象空背景、巨型盾牌、巨型文字、乱码标签和无角色参与的知识卡。

动作使用低机位广角、极近特写、前景冲撞、快速推近、横摇追拍和弹性压缩拉伸。至少一格出现强预备与爆发，一格出现急刹或回震，一格出现能被缩略图读懂的极端表情和身体剪影；高速动作让地毯、靠垫、玩具、门、家具、风、尘或毛发发生物理反馈。

色彩采用清透高饱和的青蓝阴影、暖金主光、鲜明服装与道具点色，语义证据场可切换更强的互补色和深色背景来建立层级，随后回到真实环境完成结论。故事画面内部不生成中文、英文、盾牌文字或标签。`;
  return prompt.replace(expression, `${body}\n`);
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const initial = await jsonRequest<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = initial.agents.find((item) => item.id === agentId);
  assert.ok(agent, "未找到高能夸张导演卡片");
  const nextPrompt = refine(agent.system_prompt);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-v6.3.4-${stamp}`;
  await mkdir(backupDir, { recursive: true });
  await writeFile(`${backupDir}/before.json`, JSON.stringify({
    id: agent.id,
    name: agent.name,
    prompt: agent.system_prompt,
    prompt_sha256: sha256(agent.system_prompt),
    updated_at: agent.updated_at,
  }, null, 2), "utf8");

  await jsonRequest(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 10 }),
  });
  await jsonRequest(`${baseUrl}/api/admin/agents`, session.token, {
    method: "PUT",
    body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt }),
  });
  await jsonRequest(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 10 }),
  });

  const verified = await jsonRequest<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const after = verified.agents.find((item) => item.id === agentId);
  assert.ok(after, "高能导演不存在，无法校验v6.3.4写入");
  assert.ok(after.system_prompt.includes(marker), "高能导演v6.3.4没有写入");
  await writeFile(`${backupDir}/after-summary.json`, JSON.stringify({
    marker,
    before_sha256: sha256(agent.system_prompt),
    after_sha256: sha256(after.system_prompt),
    before_chars: agent.system_prompt.length,
    after_chars: after.system_prompt.length,
  }, null, 2), "utf8");
  console.log(JSON.stringify({ passed: true, backupDir }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
