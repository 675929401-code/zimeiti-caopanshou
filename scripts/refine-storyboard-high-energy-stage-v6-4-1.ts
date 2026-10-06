import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const marker = "【高能实体舞台校准 v6.4.1】";

interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
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

function refine(prompt: string): string {
  assert.match(prompt, /【旧版高能核心恢复 v6\.4】/);
  assert.doesNotMatch(prompt, /【高能实体舞台校准 v6\.4\.1】/);
  const anchor = "\n# 输入合同\n";
  assert.ok(prompt.includes(anchor), "高能提示词缺少输入合同锚点");
  const calibration = `
# 高能对标实体舞台
${marker}
高能不是给普通客厅画面叠一层波纹、圆环、图标或悬浮界面。先让角色在真实空间中做出明确动作，再让当前语义改变空间、道具、光色和角色行为。

1. 若一段包含两个以上连续异常行为、误会或冲突，把它们用同一运动方向、追逐、抢救、检查或道具轨迹串成一条动作升级链；至少一格出现大位移、高速追拍、前景冲撞或环境连锁反应，不能连续三格只站在原地观察。
2. 线圈、波纹、速度线和小图标只能辅助动作来源，整张故事板最多一格把线性效果作为主要包装；其余格优先用飞散实体、场景尺度变化、巨型道具、可进入的演示空间和可触碰的语义装置。
3. 至少一格必须把当前核心知识转成占画面25%至40%的实体语义主舞台，并让原场景发生明显空间与光色跃迁。角色必须撞上、急刹、推动、托举、躲避、跨越或被它照亮，不能只是站在旁边看一张普通悬浮UI卡。
4. 风险、异常或医学警示优先使用高对比黑金、深青金或琥珀警戒舞台，例如由动作撞开的警报门、巨型检测装置、危险关卡或结果机关；检查、解决和正确行动优先回到清透蓝白金、青绿金或暖冷分离的结论舞台。颜色只服务语义，不得整片统一棕黄。
5. 结论格必须比前一格更宽、更稳、更易读：把正确行动变成角色正在完成的英雄式动作，并让错误选项被挡回、分流、缩小、熄灭或退出画面。结论装置必须来自本段语义，不是每段固定使用盾牌。
6. 必要知识短词只放在最大实体资产上，最多两个、逐字准确；所有小图标内禁止生成文字。英文制作说明条保持独立，不侵入故事画面。
7. 缩略图复核时，五格应至少呈现三种不同剪影、三种景别、两个不同空间舞台和一条清晰因果路径；若去掉说明条仍无法按画面顺序复述故事，必须重写。
`;
  return prompt.replace(anchor, `${calibration}${anchor}`);
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");
  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const current = payload.agents.find((item) => item.id === agentId);
  assert.ok(current?.system_prompt, "未找到高能导演");
  const nextPrompt = refine(current.system_prompt);
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-v6.4.1-${stamp}`;
  await mkdir(backupDir, { recursive: true });
  await writeFile(`${backupDir}/before.json`, JSON.stringify({
    id: current.id,
    name: current.name,
    system_prompt: current.system_prompt,
    prompt_sha256: sha256(current.system_prompt),
    updated_at: current.updated_at,
  }, null, 2), "utf8");
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, prompt: current.system_prompt, max_versions: 20 }),
  });
  await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
    method: "PUT",
    body: JSON.stringify({ agentId, system_prompt: nextPrompt }),
  });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, prompt: nextPrompt, max_versions: 20 }),
  });
  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === agentId);
  assert.ok(verified, "高能导演不存在，无法校验v6.4.1写入");
  assert.ok(verified.system_prompt.includes(marker), "v6.4.1实体舞台校准没有写入");
  await writeFile(`${backupDir}/after.json`, JSON.stringify({
    id: verified.id,
    name: verified.name,
    system_prompt: verified.system_prompt,
    prompt_sha256: sha256(verified.system_prompt),
    prompt_chars: verified.system_prompt.length,
  }, null, 2), "utf8");
  console.log(JSON.stringify({
    passed: true,
    marker,
    backupDir,
    beforeChars: current.system_prompt.length,
    afterChars: verified.system_prompt.length,
    beforeSha256: sha256(current.system_prompt),
    afterSha256: sha256(verified.system_prompt),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
