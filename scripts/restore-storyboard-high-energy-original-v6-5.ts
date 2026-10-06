import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const sourcePath = "backups/storyboard-directors-v6.2-preflight-20260814T060331Z/agents/agent-1786633444187-594spj.json";
const marker = "【原始高能核心恢复与15秒隔离适配 v6.5】";

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

function buildPrompt(originalPrompt: string): string {
  assert.match(originalPrompt, /^# 角色/u);
  assert.match(originalPrompt, /约10秒/u);
  assert.doesNotMatch(originalPrompt, /v6\.3|v6\.4|v6\.5/u);

  const durationRules = `

# 时长隔离适配
${marker}
保留上方原始高能导演方法不变，只按用户明确选择的目标时长调整镜头承载量：

- 目标10秒或未提供时长：优先生成4格2x2故事板，对应3至4个实际视频镜头，每镜约2.5至4秒。只有结论、警示、高潮或情绪收束确实需要独立宽幅锚点时才生成第5格；第5格必须放在底部全宽，并与前一格合并为最后一个实际镜头的转折和收势，不得因此增加一次机械切镜。
- 目标15秒：生成4至5格故事板，对应4至5个实际视频镜头，每镜约2.5至4秒。仍以文案语义和动作阶段决定镜头数，不为凑数重复机位或复制角色。
- 面板数只负责提供连续动作关键帧，不等于剪辑次数。视频Prompt必须给出覆盖完整目标时长的时间段，并按实际镜头写角色怎么演、动作如何接续、镜头怎样运动；禁止逐格强切、监控式换角度和知识牌长时间占屏。
- 画面包装必须从当前口播语义推导为可见实体、物理反馈、表情动作或环境变化；不套固定特效清单。医学和身体内部信息只使用友好局部示意、外部图形隐喻或无刺激性的检查动作，禁止完整解剖、裸露内脏、身体扭曲和错误关节。
- 视频中的角色不说话、不做连续口型；只允许与动作一致的自然张嘴反应。视频不得显示故事板网格、Frame编号、制作说明条、乱码或额外字幕。
`;

  const inputAnchor = "\n# 输入合同\n";
  assert.ok(originalPrompt.includes(inputAnchor), "原始高能提示词缺少输入合同锚点");
  return originalPrompt.replace(inputAnchor, `${durationRules}${inputAnchor}`);
}

async function main() {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as AgentRecord;
  const nextPrompt = buildPrompt(source.system_prompt);

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const current = payload.agents.find((item) => item.id === agentId);
  assert.ok(current?.system_prompt, "未找到高能导演");

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-original-v6.5-${stamp}`;
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
  assert.ok(verified, "恢复后未找到高能导演");
  assert.match(verified.system_prompt, /【原始高能核心恢复与15秒隔离适配 v6\.5】/u);
  assert.ok(verified.system_prompt.length < 7000, "恢复后的提示词仍然过度膨胀");

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
    sourceChars: source.system_prompt.length,
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
