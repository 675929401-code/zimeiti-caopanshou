import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const oldMarker = "【语义泛化与动态包装生成语法 vNext.1 2026-08-15】";
const marker = "【语义泛化与开放包装知识库 vNext.2 2026-08-15】";
const targets = [
  { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张", expectedSha: "db6e63c40894bc7fd5a26cbbfb73ff0e6f48667cd97d21210658f1bc01bb2b1c" },
  { id: "agent-1786642714227-e1zid1", name: "故事版导演｜电影叙事", expectedSha: "9750abcdf6ee358d728accc1555dea389cf395a9926bfdba16178ce861770724" },
  { id: "agent-1786642714448-m6iaou", name: "故事版导演｜抒情情感", expectedSha: "135370322d531b154c6a7b9089a18cd761d8f63d08aca933a0f9aa0f9df05951" },
] as const;

interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  output_style?: Record<string, unknown>;
  updated_at?: string;
  [key: string]: unknown;
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

function replaceExact(prompt: string, from: string, to: string, label: string): string {
  assert.equal(prompt.split(from).length - 1, 1, `${label}待替换文本数量异常`);
  return prompt.replace(from, to);
}

function updatePrompt(prompt: string, target: typeof targets[number]): string {
  assert.equal(sha256(prompt), target.expectedSha, `${target.name}当前Prompt不是预期vNext.1`);
  let next = replaceExact(prompt, oldMarker, marker, `${target.name}版本标记`);
  next = replaceExact(
    next,
    "7. 造型原创：同一语义也要根据人物、犬种、场景与道具重新生成不同载体、材质和颜色。禁止把盾牌、天平、黄色能量线、发光牌、警报牌、弹窗当成默认答案；只有当前故事真实需要且不可替代时才可偶发使用其中一种。",
    "7. 造型原创：同一语义也要根据人物、犬种、场景与道具重新生成不同载体、材质和颜色。盾牌、天平、金色能量线、发光牌、警报牌、弹窗，以及更广泛的真实道具、场景机关、环境变形、局部示意和动作轨迹，全部是合法候选，不设黑名单；根据当前文案与场景自由组合。验收只反对无理由机械套用和相邻段原样复制，不因某种包装形式本身出现而扣分。",
    `${target.name}开放包装候选`,
  );
  next = replaceExact(
    next,
    "- 连续段落保持已锁定角色与宠物不漂移，但相邻段不得重复同一主道具、同一包装载体、同一视觉动词、同色能量轨迹、同一正面平视机位或同一构图模板。",
    "- 连续段落保持已锁定角色与宠物不漂移。相邻段可以在语义确实需要时复用某类道具或效果，但必须说明新的语义核、场景载体、互动方式或生命周期；不得无理由原样复制整套包装、同一正面平视机位和同一构图模板。",
    `${target.name}灵活复用规则`,
  );
  next = replaceExact(
    next,
    "4. 包装由“语义核—视觉动词—场景载体—空间形态—角色互动—生命周期”生成，每格0至1个主装置；没有把盾牌、天平、黄线、发光牌、警报牌或弹窗当默认模板。",
    "4. 包装由“语义核—视觉动词—场景载体—空间形态—角色互动—生命周期”生成，每格0至1个主装置；盾牌、天平、金线、发光牌、警报牌、弹窗等均可按需出现，检查的是适配度、丰富度、原创组合与角色互动，不是检查它们必须为零。",
    `${target.name}包装验收口径`,
  );
  next = replaceExact(
    next,
    "5. 相邻段的包装载体、视觉动词、材质、颜色、机位、构图、动作和主道具通过多样性账本避免重复。",
    "5. 相邻段的包装载体、视觉动词、材质、颜色、机位、构图、动作和主道具通过多样性账本做有理由的搭配；允许语义驱动的复用，禁止偷懒式整套复制。",
    `${target.name}多样性验收口径`,
  );
  assert.equal(next.split(marker).length - 1, 1, `${target.name}vNext.2标记异常`);
  assert.match(next, /全部是合法候选，不设黑名单/u);
  assert.match(next, /不是检查它们必须为零/u);
  return next;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");
  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-directors-semantic-vnext-2-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  const results = [];

  for (const target of targets) {
    const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
    assert.ok(agent, `未找到目标智能体：${target.name}`);
    await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
    const nextPrompt = updatePrompt(agent.system_prompt, target);
    const outputStyle = {
      ...(agent.output_style || {}),
      schema_version: "storyboard_director_output_style.v3.2",
      packaging_policy: "open_candidate_library_semantic_fit_over_zero_occurrence",
      packaging_forms_allowed: ["story_prop", "scene_mechanism", "environment_transform", "local_diagram", "motion_trace", "shield", "scale", "energy_line", "luminous_card", "warning_sign", "popup"],
      free_canvas_coupling: false,
    };
    await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
      method: "POST",
      body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }),
    });
    await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
      method: "PUT",
      body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt, output_style: outputStyle }),
    });
    await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
      method: "POST",
      body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }),
    });
    const verifiedPayload: { agents: AgentRecord[] } = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
    const verified: AgentRecord | undefined = verifiedPayload.agents.find((item: AgentRecord) => item.id === target.id);
    assert.ok(verified && verified.system_prompt.includes(marker), `${target.name}vNext.2未生效`);
    assert.equal(verified.output_style?.free_canvas_coupling, false);
    await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
    results.push({
      id: target.id,
      name: target.name,
      beforeSha256: sha256(agent.system_prompt),
      afterSha256: sha256(verified.system_prompt),
      promptChars: verified.system_prompt.length,
      updatedAt: verified.updated_at,
    });
  }
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify({ passed: true, marker, backupDir, results }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ passed: true, backupDir, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
