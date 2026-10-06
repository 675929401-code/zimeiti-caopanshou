import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const marker = "【语义包装判定门 v6.3.3】";
const targets = [
  { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张" },
  { id: "agent-1786642714227-e1zid1", name: "故事版导演｜电影叙事" },
  { id: "agent-1786642714448-m6iaou", name: "故事版导演｜抒情情感" },
] as const;

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

function calibrate(prompt: string): string {
  assert.match(prompt, /【时长-格数-镜头校准 v6\.3\.2】/);
  assert.doesNotMatch(prompt, /【语义包装判定门 v6\.3\.3】/);
  let next = prompt.replace(
    "图形强调可以在2至3格出现，但每格必须是由当前语义推导出的不同效果，并始终与真实道具、空间尺度、碎屑路径、局部放大证据和角色互动共同工作。",
    "图形强调不设固定数量，只在当前语义无法由表演和物理事件完整呈现时使用，并始终与真实道具、空间尺度、碎屑路径、局部放大证据和角色互动共同工作。",
  );
  next = next.replace(
    "3. 特效必须保留但按语义选择：高能版4格中允许2至3格使用彼此不同的语义特效；电影版允许1至2格；抒情版允许0至1格。至少一格只靠角色表演、实体道具和环境反馈讲清。问号、星星、冲击波、速度线、心跳、局部放大窗、图标装置都必须来自当前语义，写清来源、位置、尺度、触发动作和结束状态；禁止四格都使用同一种线、圆环或暖金光。",
    `3. ${marker} 特效不设固定格数。逐格先问：只靠角色表演、实体道具和环境反馈，观众能否一眼看懂当前语义？能看懂就不添加图形包装；仍看不懂时，只添加一个最能补足信息的语义包装。整张图可以只有一个，也可以多格各自出现，但每个包装必须承担不同信息功能。问号、星星、冲击波、速度线、心跳、局部放大窗、图标装置都要写清来源、位置、尺度、触发动作和结束状态；禁止为显得热闹而凑数量，禁止四格复用同一种线、圆环或暖金光。`,
  );
  next = next.replace(
    "5. 高能版有2至3格不同语义特效，电影版1至2格，抒情版0至1格；至少一格完全靠表演、道具和环境；",
    "5. 语义包装数量由当前文案决定，没有最低或固定数量；每个包装都有不可替代的信息作用，且至少一格完全靠表演、道具和环境；",
  );
  assert.match(next, /特效不设固定格数/);
  assert.doesNotMatch(next, /高能版4格中允许2至3格|高能版有2至3格不同语义特效/);
  return next;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const initial = await jsonRequest<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const rows = targets.map((target) => initial.agents.find((agent) => agent.id === target.id));
  assert.ok(rows.every(Boolean), "三张故事版导演卡片未全部找到");
  const agents = rows as AdminAgent[];

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-directors-v6.3.3-${stamp}`;
  await mkdir(backupDir, { recursive: true });
  await writeFile(`${backupDir}/before.json`, JSON.stringify({
    created_at: new Date().toISOString(),
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      prompt: agent.system_prompt,
      prompt_sha256: sha256(agent.system_prompt),
      updated_at: agent.updated_at,
    })),
  }, null, 2), "utf8");

  for (const target of targets) {
    const agent = agents.find((item) => item.id === target.id)!;
    const nextPrompt = calibrate(agent.system_prompt);
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
  }

  const verified = await jsonRequest<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const summary = targets.map((target) => {
    const before = agents.find((item) => item.id === target.id)!;
    const after = verified.agents.find((item) => item.id === target.id)!;
    assert.ok(after.system_prompt.includes(marker), `${target.name}未写入v6.3.3`);
    return {
      id: target.id,
      name: target.name,
      before_sha256: sha256(before.system_prompt),
      after_sha256: sha256(after.system_prompt),
      before_chars: before.system_prompt.length,
      after_chars: after.system_prompt.length,
    };
  });
  await writeFile(`${backupDir}/after-summary.json`, JSON.stringify({ marker, agents: summary }, null, 2), "utf8");
  console.log(JSON.stringify({ passed: true, backupDir, agents: summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
