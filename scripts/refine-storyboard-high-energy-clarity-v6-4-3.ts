import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const marker = "【高能文字纯净与动作峰值校准 v6.4.3】";

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
  assert.match(prompt, /【高能动作差异校准 v6\.4\.2】/);
  assert.doesNotMatch(prompt, /【高能文字纯净与动作峰值校准 v6\.4\.3】/);

  const anchor = "\n# 输入合同\n";
  assert.ok(prompt.includes(anchor), "高能提示词缺少输入合同锚点");
  const calibration = `
# 文字纯净与动作峰值复核
${marker}
这是输出前的精确复核，不改变旧版高能创作核心：

1. 画内可读中文由本段语义决定，可以为零，最多两个短词；每个短词只出现一次，只能完整写在一个占画面20%至35%的正面实体主资产上。文字必须从第一帧就完整、正对镜头、无遮挡、无透视扭曲、无逐字生成和无变形动画。
2. 除上述短词与每格独立英文制作说明条外，故事画面内禁止任何可读文字、数字、字母、小标签、仪表刻度、手机内容、UI菜单和信息墙。饮食、检查、风险与解决方案全部改用食盆、量勺、体重秤、放大镜、封闭药瓶、方向轨道等无字实体图形表达。
3. 一段最多只有一个知识舞台镜头，且10秒成片中不超过2.2秒。知识舞台必须由上一镜动作撞开、推入或触发，并在一个清晰动作峰值后立即回到角色完成真实检查、阻挡、保护或纠正，禁止角色长时间站在静态仪表墙前观看。
4. 10秒优先4格和3至4个真实镜头；只有独立的宽幅高潮或结论确有新增信息价值时才使用第5格，且第5格并入最后镜头的收势，不新增一次切镜。15秒仍按既有隔离分支执行。
5. 每个真实镜头只保留一个主动作峰值和一个关键反应：先写角色起势，再写物理后果，最后写环境反馈或语义包装。前半段至少有一次明显位移、抓空、急刹、碰撞或飞散；后半段必须让角色亲手完成解决动作，不能以纯展示收尾。
6. 视频只让故事板已经画出的实体和特效运动。若参考图含除允许短词之外的小字或乱码，视频Prompt必须明确忽略并移除；不得围绕小字、信息面板或说明条运镜。
7. 缩略图与静音视频复核：遮住所有制作说明条后，观众仍能看懂起因、升级、知识转折和正确行动；任一镜若只剩站立观看、同地点换机位、线条叠加或文字说明，必须改成可见动作事件。
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
  const backupDir = `backups/storyboard-high-energy-v6.4.3-${stamp}`;
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
  assert.ok(verified, "高能导演不存在，无法校验v6.4.3写入");
  assert.ok(verified.system_prompt.includes(marker), "v6.4.3校准没有写入");
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
