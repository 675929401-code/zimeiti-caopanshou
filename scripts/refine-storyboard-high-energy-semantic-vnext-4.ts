import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "1488ba6e20e67782535af52748a67f1897e9560ce50b7b6c4753b85572221e34",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);
const oldMarker = "【对标风格锁与语义包装编排 vNext.3 2026-08-15】";
const marker = "【主次决策与视觉母题导演 vNext.4 2026-08-15】";

interface PromptVersion {
  id: string;
  ts: number;
  prompt: string;
}

interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields?: unknown;
  output_style?: Record<string, unknown>;
  guide_message?: string;
  updated_at?: string;
  [key: string]: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function replaceExact(prompt: string, from: string, to: string, label: string): string {
  assert.equal(prompt.split(from).length - 1, 1, `${label}待替换文本数量异常`);
  return prompt.replace(from, to);
}

function replaceSection(prompt: string, start: string, end: string, replacement: string): string {
  const startIndex = prompt.indexOf(start);
  const endIndex = prompt.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `无法定位Prompt区段：${start} -> ${end}`);
  return `${prompt.slice(0, startIndex)}${replacement.trim()}\n\n${prompt.slice(endIndex)}`;
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

const directorStrategy = `# 当前导演策略
本卡负责抓眼、反差、喜剧动作和知识警示。高能来自清楚主冲突、可读动作峰值、强弱节奏与可信物理余波，不来自逐句堆图或每格爆炸发光。

选择优先级固定为：用户特殊要求 ＞ 文案事实 ＞ 角色一致性 ＞ 故事可读性 ＞ 动作可执行性 ＞ 包装冲击力 ＞ 装饰丰富度。

每段先只锁定一个主冲突、一个核心信息任务和一个统一视觉母题。口播的次要句只能帮助主冲突升级或收束；不能为每句话另起道具、图标或舞台。视觉母题必须经历“出现 → 增强 → 与角色/环境碰撞 → 转化或收束”，成为跨格因果线，不是静态贴纸。

内部生成三类候选但绝不展示推理：A角色表演，B现实道具/环境，C语义隐喻包装。按语义准确、20%缩略图冲击、角色互动、视频可执行、批次独特性、安全稳定六项评分，选择一个主方案；其余候选最多作为辅层，不得平均堆叠。

- 动作链：预备/蓄力 → 发力 → 另一角色反应 → 环境余波 → 清晰停留。人体或犬体风险高时降低动作极限，但保留清晰轮廓、受力方向和喜剧反差。
- 视觉密度一张一弛：每格只有一个主焦点，并至少具备角色表演、现实物理、语义包装中的两层；全段至少一格主要靠表演或真实物理。不得每格都爆炸、发光、张嘴或同等高强度。
- 动态色彩脚本：环境基础色 → 冲突功能色 → 高潮强调色 → 结尾回归色。强调色从文案和场景推导，金色不是默认滤镜。
- 过渡钩子：用上一镜的视线、飞散物、光线、门、滚动物或动作方向自然交给下一镜，不靠无关闪白硬切。
- 开场尽快建立异常或冲突，可用误会、动作失衡、道具连锁、表情反差或空间突变，不固定为奔跑；高潮前允许短暂留白。`;

const diversityLedger = `# 批次多样性账本
通读同一批全部段落，内部记录人物、犬种、主道具、包装家族、功能色、机位、构图、知识装置，以及视觉母题的出现、碰撞和收束方式：

- 相邻段禁止整套复用；语义确需复用某类形式时，至少改变场景载体、角色互动、物理行为或生命周期，不得只换颜色。
- 同一段的机位与构图要服务动作阶段，禁止连续正面平视、监控式同角度和同一主体比例。
- 功能色遵循本段动态色彩脚本；避免全片黄色线条、金光滤镜或同色高潮。
- 每格0或1个主语义装置，允许纯表演/真实物理格；包装必须改变角色动作、空间关系或可见结果。
- 若与本批已有方案高度相似，返回三候选重新选择，不得带着重复方案输出。`;

const repairRules = `# 失败预检与源头修复
输出前先执行反例淘汰，不展示过程：

- 道具或效果换到无关文案仍成立：语义不专属，淘汰重选。
- 装饰未与角色或环境发生看得见的互动：淘汰或改成可触发、可碰撞、可留痕的方案。
- 缩略到20%没有唯一钩子：强化动作剪影、尺度差、颜色对比或唯一主装置，但不增加第二焦点。
- 文字不稳或超过短标签预算：改为无文字图形、动作或物理证据；不得保留乱码风险。
- 人体/犬体危险：降低旋转、拉伸或腾空极限，保持自然四足、稳定关节和动作方向。
- 道具遮脸或遮挡因果：调整前中后景、尺寸、透视和落点；包装太弱则增强角色互动，不是继续堆发光。
- 医学或健康表达不适：改为局部无创放大、透明外轮廓、友好示意、测量装置或环境隐喻。`;

function updatePrompt(prompt: string): string {
  assert.equal(sha256(prompt), target.expectedSha, "高能版当前Prompt不是预期vNext.3");
  let next = replaceExact(prompt, oldMarker, marker, "版本标记");
  next = replaceSection(next, "# 当前导演策略", "# 输入合同", directorStrategy);
  next = replaceExact(
    next,
    "2. 未指定人物时，从场景、人群、关系、地域语境和动作需求推导具体的成年年龄、性别呈现、地域外观、发型、服装、鞋履与体态。不得跨任务默认黄卫衣年轻女性，也不得为了省字写成含混的“主人”“一个人”。若原文确有未成年人则如实保留；否则照护、家庭、职场角色默认明确成年。",
    "2. 用户未指定人物且文案没有年龄、性别、关系或职业事实要求时，默认选择一位明确成年亚洲女性；再从当前场景与动作需求推导具体年龄、发型、服装、鞋履、体态和身份并锁定。不得固定黄卫衣模板，也不得写成含混的“主人”“一个人”。文案或用户明确人物时严格服从。",
    "默认人物规则",
  );
  next = replaceSection(next, "# 视觉多样性账本", "# 4/5格布局与时长", diversityLedger);
  next = replaceExact(next, "# 输出前质量门", `${repairRules}\n\n# 输出前质量门`, "失败修复规则");
  next = replaceExact(
    next,
    "3. 每镜只有一个主运镜、一个核心动作和一个关键反应。动作有预备—爆发—余波，强弱交替；高潮前后允许短暂停顿，最后0.5至1秒稳定落幅。",
    "3. 每镜只有一个主运镜、一个核心动作和一个关键反应。按预备/蓄力—发力—反应—环境余波—清晰停留写清角色怎么演；强弱交替，高潮前后允许短暂停顿，最后0.5至1秒稳定落幅，并用视线、飞散物、光线、门、滚动物或动作方向交给下一镜。",
    "视频动作链",
  );
  next = replaceExact(
    next,
    "3. 每格是新的动作阶段或事件，因果可读；至少一格主要靠表演、真实道具和环境。",
    "3. 每格是新的动作阶段或事件，只有一个主焦点，并至少具备角色表演、现实物理、语义包装中的两层；全段至少一格主要靠表演或真实物理，密度有张有弛。",
    "视觉密度质量门",
  );
  next = replaceExact(
    next,
    "5. 相邻段的包装载体、视觉动词、材质、颜色、机位、构图、动作和主道具通过多样性账本做有理由的搭配；允许语义驱动的复用，禁止偷懒式整套复制。",
    "5. 批次账本覆盖人物、犬种、主道具、包装家族、功能色、机位、构图和知识装置；允许有理由复用单一形式，禁止相邻段整套复制，重复时返回三候选重选。",
    "批次账本质量门",
  );
  next = replaceExact(
    next,
    "8. 每个视频镜头有预备、发力、反应/余波和过渡钩子，时间轴连续且能在分配秒数内演完。",
    "8. 每个视频镜头写清预备/蓄力、发力、反应、环境余波、清晰停留和过渡钩子，时间轴连续且能在分配秒数内演完。",
    "动作链质量门",
  );
  assert.equal(next.split(marker).length - 1, 1, "vNext.4标记异常");
  assert.match(next, /内部生成三类候选但绝不展示推理/u);
  assert.match(next, /默认选择一位明确成年亚洲女性/u);
  assert.match(next, /环境基础色 → 冲突功能色 → 高潮强调色 → 结尾回归色/u);
  assert.match(next, /缩略到20%没有唯一钩子/u);
  return next;
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
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `后续卡片基线异常：${id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-change-${stamp}`;
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
  assert.ok(rollbackVersion, "vNext.3回滚版本未进入平台历史");

  const nextPrompt = updatePrompt(agent.system_prompt);
  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4",
    director_selection: "one_primary_conflict_one_information_task_one_visual_motif",
    internal_candidate_scoring: ["character_performance", "physical_prop_environment", "semantic_metaphor_packaging"],
    visual_motif_lifecycle: "appear_intensify_collide_transform_resolve",
    dynamic_color_script: "base_conflict_climax_return",
    density_policy: "one_focus_two_layers_rhythm",
    default_unspecified_person: "specific_adult_asian_woman_scene_inferred_assets",
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

  const verifiedPayload: { agents: AgentRecord[] } = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === target.id);
  assert.ok(verified && verified.system_prompt.includes(marker), "高能vNext.4未生效");
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
  assert.ok(liveVersion, "vNext.4当前版本未进入平台历史");
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
    siblingsUnchanged: [...siblingExpectedShas.entries()].map(([id, promptSha256]) => ({ id, promptSha256 })),
    backupDir,
  };
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
