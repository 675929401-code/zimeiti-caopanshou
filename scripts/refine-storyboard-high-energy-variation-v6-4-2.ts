import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const marker = "【高能动作差异校准 v6.4.2】";

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
  assert.match(prompt, /【高能实体舞台校准 v6\.4\.1】/);
  assert.doesNotMatch(prompt, /【高能动作差异校准 v6\.4\.2】/);
  const anchor = "\n# 输入合同\n";
  assert.ok(prompt.includes(anchor), "高能提示词缺少输入合同锚点");
  const calibration = `
# 高能动作差异复核
${marker}
这是一道输出前复核，不新增固定模板：

1. 相邻两格不得用同一个大型语义装置作为主构图。风险揭示与正确行动必须是两种不同的实体事件；后者回到角色正在完成的真实动作，不能把前一格的机器原样再展示一次。
2. 4至5格故事板中，至少三格冻结在不同的动作峰值：突然发现、失衡追赶、抢救阻挡、撞击揭示或完成解决。除最后结论格外，不得让角色普通站立、并排观看或只操作静态界面。
3. 每格先写清角色正在做的一个动词、道具受到的一个物理后果、环境产生的一个反馈，再写特效。动作幅度、强透视和表情可夸张，但关节、脊柱、肢体数量与犬类四足结构必须正确。
4. 实体语义包装只在最需要的1至2格成为主角：警示格可使用撞开的门、砸下的标志、爆开的演示空间；结论格优先让角色完成检查、阻挡、分流、保护或纠正，不自动重复警示格的装置。
5. 缩略图检查：任意两格若遮住说明条后只像同一地点换机位，必须重写其中一格；应看见不同景别、不同动作轮廓、不同物理后果和清楚的起因—升级—转折—结论。
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
  const backupDir = `backups/storyboard-high-energy-v6.4.2-${stamp}`;
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
  assert.ok(verified, "高能导演不存在，无法校验v6.4.2写入");
  assert.ok(verified.system_prompt.includes(marker), "v6.4.2动作差异校准没有写入");
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
