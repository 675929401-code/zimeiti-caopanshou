import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const marker = "【高能空间分层校准 v6.3.1】";

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
  assert.match(prompt, /【对标视觉事件语法 v6\.3】/);
  assert.doesNotMatch(prompt, /【高能空间分层校准 v6\.3\.1】/);
  const expression = /# 当前导演策略\r?\n[\s\S]*?(?=\r?\n# 输入合同\r?\n)/;
  assert.match(prompt, expression);
  const body = `# 当前导演策略
【对标视觉事件语法 v6.3】
${marker}
本卡负责高能夸张短视频。高能来自事件升级、空间升级和角色表演，不来自把同一种发光线、圆环或大字重复五次。把当前口播改编为“异常动作钩子 -> 主人误判与身体喜剧 -> 可触摸的证据或机制 -> 认知反转 -> 空间级高潮落点”。

五格必须形成至少四种明显不同的主体剪影，并使用至少两个视觉舞台：第一舞台是真实发生地；第二舞台是从当前道具、动作或因果自然展开的语义证据场、局部机制场或高能结论舞台。第二舞台不能是抽象空背景配巨大文字，也不能凭空出现；必须让人物和宠物触摸、躲避、追逐、观察或改变其中的实体。随后可回到真实环境完成结论。禁止五格全部停留在同一沙发、同一地毯和同一暖光机位。

动作使用低机位广角、极近特写、前景冲撞、快速推近、横摇追拍和弹性压缩拉伸。至少一格出现强预备与爆发，一格出现急刹或回震，一格出现能被缩略图读懂的极端表情与身体剪影；高速动作必须让地毯、靠垫、玩具、门、家具、尘云或其他当前环境发生物理反馈。

色彩采用清透高饱和的青蓝阴影、暖金主光、鲜明服装和道具点色，保留深色对比与明亮轮廓光；不得整张图只有棕黄暖色。图形强调最多辅助一格，优先用真实道具、空间尺度、碎屑路径、局部放大证据和角色互动表达语义。故事画面内部不生成中文、英文、盾牌文字或标签。`;
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
  const backupDir = `backups/storyboard-high-energy-v6.3.1-${stamp}`;
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
  const after = verified.agents.find((item) => item.id === agent.id);
  assert.ok(after, "高能导演不存在，无法校验v6.3.1写入");
  assert.ok(after.system_prompt.includes(marker), "高能导演v6.3.1没有写入");
  const history = await jsonRequest<{ versions: Array<{ prompt: string }> }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`,
    session.token,
  );
  assert.ok(history.versions.some((item) => sha256(item.prompt) === sha256(agent.system_prompt)), "云端历史缺少旧版");

  await writeFile(`${backupDir}/after-summary.json`, JSON.stringify({
    marker,
    before_sha256: sha256(agent.system_prompt),
    after_sha256: sha256(after.system_prompt),
    before_chars: agent.system_prompt.length,
    after_chars: after.system_prompt.length,
    prompt_versions: history.versions.length,
  }, null, 2), "utf8");
  console.log(JSON.stringify({ passed: true, backupDir, promptVersions: history.versions.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
