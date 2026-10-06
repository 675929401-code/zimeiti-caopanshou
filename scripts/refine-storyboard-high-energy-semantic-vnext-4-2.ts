import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "fef1331a75640908d50394c4631f4749cff7f57c2a3f0e5a95772c5ec2020571",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);
const oldMarker = "【主次决策与视觉母题导演 vNext.4.1 2026-08-15】";
const marker = "【主次决策与视觉母题导演 vNext.4.2 2026-08-15】";
const ruleBlock = [
  "【高能结构安全与相对对标门禁】",
  "1. 人体结构先过硬门禁：每只可见手都必须沿手腕—前臂—肘—上臂清楚回溯到唯一人物，禁止遮挡制造第三手、无主手臂或重复肢体错觉。双手扶狗仅在两条完整手臂均清楚可见且手指数量合理时使用；构图有风险就改为单手接触，或让人物以无接触的表情和后撤动作反应。犬体同样保持唯一头身、自然四足与明确关节。",
  "2. 高能不是静态说明：每格必须有一个由当前语义推导的视觉事件和一个可在缩略图读出的动作峰值；普通站立、平视监控、只有角色对望或安静海报式收束均不合格。4格至少3格、5格至少4格达到强动作或强视觉钩子；结尾可短暂回落，但仍须保留有因果意义的记忆动作、空间转化或知识落点。",
  "3. 全段至少两格使用彼此不同的强透视、前景冲击或动态机位，至少两格出现可信受力、散落、形变、尘屑、牵引张力、织物或环境连锁等物理反馈；至少一格把本段核心知识转成英雄级空间道具或知识揭示，并让角色真实触发、躲避、承接或改变它。不得为达标复用固定盾牌、天平、金线、警报牌或弹窗。",
  "4. 主道具与特效必须从本段语义核现推，并完成出现→增强→与角色/环境碰撞→转化或收束的生命周期。若换到无关文案仍成立、只悬浮不参与表演，或同批相邻方案整套相似，立即淘汰并重选。",
  "5. 输出前按对标逐格复核：人体/犬体与身份完整性是硬门禁；再检查动作峰值与剪影、机位景别与前景、语义包装生命周期、物理反馈与漫画动效、功能色层级、因果钩子、表情、文字准确和跨文案差异。任何多手、多肢、归属不清或角色漂移都不得交付。",
].join("\n");

interface PromptVersion {
  id: string;
  prompt: string;
}

interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields?: unknown;
  output_style?: Record<string, unknown>;
  guide_message?: string;
  [key: string]: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function replaceOnce(prompt: string, from: string, to: string, label: string): string {
  assert.equal(prompt.split(from).length - 1, 1, `${label}待替换文本数量异常`);
  return prompt.replace(from, to);
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

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
  assert.ok(agent, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前Prompt不是预期vNext.4.1");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的后续卡片基线异常：${id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-2-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");

  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }),
  });
  const beforeHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`,
    session.token,
  );
  const rollbackVersion = beforeHistory.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "vNext.4.1回滚版本未进入平台历史");

  const nextPrompt = replaceOnce(agent.system_prompt, oldMarker, `${marker}\n${ruleBlock}`, "版本标记");
  for (const fragment of ["第三手", "双手扶狗", "4格至少3格", "5格至少4格", "至少两格使用", "英雄级空间道具", "出现→增强→与角色/环境碰撞→转化或收束"]) {
    assert.ok(nextPrompt.includes(fragment), `新门禁缺失：${fragment}`);
  }

  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.2",
    anatomy_integrity_gate: "hard_fail_extra_or_ambiguous_limbs; trace_each_hand_to_one_owner",
    high_energy_panel_gate: "4panels>=3_hooks;5panels>=4_hooks;>=2_dynamic_perspective;>=2_physical_feedback;>=1_semantic_hero_reveal",
    benchmark_relative_audit: true,
    free_canvas_coupling: false,
  };
  await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
    method: "PUT",
    body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt, output_style: outputStyle }),
  });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }),
  });

  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === target.id);
  assert.ok(verified && verified.system_prompt.includes(marker), "高能vNext.4.2未生效");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止提前修改的后续卡发生变化：${id}`);
  }

  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`,
    session.token,
  );
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === sha256(verified.system_prompt));
  assert.ok(liveVersion, "vNext.4.2当前版本未进入平台历史");
  await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
  const verification = {
    passed: true,
    agentId: agent.id,
    agentName: agent.name,
    beforeSha256: target.expectedSha,
    afterSha256: sha256(verified.system_prompt),
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: agent.system_prompt.length,
    promptCharsAfter: verified.system_prompt.length,
    outputStyle: verified.output_style,
    changeSummary: [
      "all visible hands must trace to one unique person; risky two-hand contact degrades to one-hand/no-contact",
      "every panel has a semantic visual event and readable action peak; 4-panel>=3 hooks, 5-panel>=4 hooks",
      ">=2 dynamic perspective/foreground panels, >=2 physical-feedback panels, >=1 semantic hero reveal",
      "semantic prop lifecycle and benchmark-relative preflight are explicit output gates",
    ],
    siblingsUnchanged: [...siblingExpectedShas.entries()].map(([id, promptSha256]) => ({ id, promptSha256 })),
    freeCanvasCoupling: false,
    backupDir,
  };
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
