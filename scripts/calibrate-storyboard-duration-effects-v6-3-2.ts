import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const marker = "【时长-格数-镜头校准 v6.3.2】";
const targets = [
  { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张", mode: "high_energy" },
  { id: "agent-1786642714227-e1zid1", name: "故事版导演｜电影叙事", mode: "cinematic" },
  { id: "agent-1786642714448-m6iaou", name: "故事版导演｜抒情情感", mode: "lyrical" },
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceSection(prompt: string, heading: string, nextHeading: string, body: string): string {
  const expression = new RegExp(
    `${escapeRegExp(heading)}\\r?\\n[\\s\\S]*?(?=\\r?\\n${escapeRegExp(nextHeading)}\\r?\\n)`,
  );
  assert.match(prompt, expression, `缺少可替换段落：${heading}`);
  return prompt.replace(expression, `${heading}\n${body.trim()}\n`);
}

const storyboardRules = `${marker}
每个原文段落只生成一张完整故事板图片。格数由目标视频时长决定，不再自由漂移：
- 8秒：固定4格，标准2x2，panel_count=4，layout=two_by_two；为2至3个真实视频镜头提供动作阶段；
- 10秒：固定4格，标准2x2，panel_count=4，layout=two_by_two；为3至4个真实视频镜头提供动作阶段；
- 15秒：固定5格，上方四格2x2加底部全宽锚点，panel_count=5，layout=four_plus_panorama；为4至5个真实视频镜头提供动作阶段。
8秒和10秒不得生成第五格；15秒必须原样写入“top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel”。底部第五格承担空间高潮、因果揭示、结论或情绪落点，不能重复第四格。

输出语言：生图Prompt主体使用简体中文；只有15秒固定版式短句和每格下方英文Frame制作说明可以使用英文。

1. 先把口播转成与格数一致的视觉事件。4格依次承担“建立/触发、升级、证据/机制、反转/落点”；5格依次承担“建立、触发、升级、证据/机制、高潮/落点”。不得用同一动作换角度凑格。
2. 每格写可见画面：职责、唯一机位景别、主体动作峰值、表情与身体反应、道具和环境反馈、语义特效、光色，以及与下一格的动作/视线/道具交接。不要解释设计意图。
3. 特效必须保留但按语义选择：高能版4格中允许2至3格使用彼此不同的语义特效；电影版允许1至2格；抒情版允许0至1格。至少一格只靠角色表演、实体道具和环境反馈讲清。问号、星星、冲击波、速度线、心跳、局部放大窗、图标装置都必须来自当前语义，写清来源、位置、尺度、触发动作和结束状态；禁止四格都使用同一种线、圆环或暖金光。
4. 4格至少3种明显不同的主体剪影和3种景别；5格至少4种主体剪影。高能版至少一个动作峰值、一个极端反应和一个空间或实体证据；电影版至少一个机制/证据画面和一次有动机转场；抒情版至少一个具体情感证据和一个强关系剪影。
5. 故事面板内部不生成中文或英文字牌。每格下方可放与画面完全分离的白色制作说明条，格式为“Frame N: camera move as subject action, secondary reaction, semantic effect, and outcome.”，每句18至26个英文单词。
6. 统一资产只写一次，完整生图Prompt以1800至3000个中文字符为目标。禁止五张独立图、上2下3等宽、错序拼贴、监控视角重复、错误肢体、宠物人形化、角色复制和资产漂移。`;

const videoRules = `${marker}
第一段写读取协议：完整故事板只用于读取角色、场景、道具、动作阶段和已经画出的语义特效。视频不得读取、不放大、不复现白色说明条、Frame编号或任何文字；若参考图意外出现乱码或文字，必须忽略并移除。成片不得显示网格、分隔线、拼图或分屏。

输出语言：视频Prompt必须使用简体中文大白话写可执行动作。

随后按真实镜头数逐镜写“怎么演”，每镜开头必须标注“来源格：Frame N”或“来源格：Frame N至Frame M”，明确视频只从哪些故事格读取首态、动作和终态：
“镜头N（起止秒，来源格：Frame X）：相机从哪里开始怎样移动；人物和宠物从什么姿势开始，依次做哪些连续动作；表情、耳尾、重心和环境怎样反应；参考格里已经画出的语义特效怎样被动作触发、运动并结束；用动作、视线、方向、声音或道具交给下一镜。”

- 8秒2至3镜，10秒3至4镜，15秒4至5镜；面板数提供动作阶段，不等于强制逐格硬切。镜头少于格数时，一个连续镜头可以从相邻两格读取起点和终点，但不能轮播整张拼图；
- 特效要随动作演起来，但不得变成独立主角：不把线条升级为巨大标牌，不把问号、盾牌、演示窗单独放满屏，不凭空生成文字；
- 角色始终是主体。每镜一个主要运镜、一个核心动作、一个关键反应，动作有预备、发力、反应和收势；
- 人物和宠物不说话、不做对白口型。只写脚步、犬爪、衣料、道具、呼吸和环境等自然声音；不生成旁白、字幕、歌词或背景音乐；
- 时间轴连续覆盖目标时长，最后0.5至1秒留下稳定落幅。`;

const qualityGate = `${marker}
输出前直接重写不合格内容，不展示检查过程：
1. 原口播逐字保留，具体人物、宠物、服装、道具已锁定；
2. 8秒和10秒必须4格，15秒必须5格；8秒2至3镜、10秒3至4镜、15秒4至5镜；
3. 每格恰好出现要求的一人一宠，不复制、镜像或增加主体；
4. 4格至少3种不同剪影和景别，不能都在同一沙发前；5格至少4种；
5. 高能版有2至3格不同语义特效，电影版1至2格，抒情版0至1格；至少一格完全靠表演、道具和环境；
6. 特效来源和触发动作清楚，同一种线、环或光效不得连续占主视觉；
7. 故事画面内部没有可读文字、盾牌文字、字幕或对白；英文只在独立白色制作说明条；
8. 每个视频镜头已绑定来源Frame，视频不轮播整张拼图、不读取说明条、不围绕乱码或巨型图标拍摄；
9. 生图Prompt主体为中文，视频Prompt为中文大白话；
10. 时间轴完整，动作、声音和语义特效能顺滑交接。`;

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

function calibrate(prompt: string, mode: typeof targets[number]["mode"]): string {
  assert.match(prompt, /【对标视觉事件语法 v6\.3】/);
  assert.doesNotMatch(prompt, /【时长-格数-镜头校准 v6\.3\.2】/);
  let next = replaceSection(prompt, "# 故事板生图Prompt写法", "# 图生视频Prompt写法", storyboardRules);
  next = replaceSection(next, "# 图生视频Prompt写法", "# 输出前质量门", videoRules);
  next = replaceSection(next, "# 输出前质量门", "# 稳定输入协议 v6.2", qualityGate);
  if (mode === "high_energy") {
    next = next.replace(
      "图形强调最多辅助一格，优先用真实道具、空间尺度、碎屑路径、局部放大证据和角色互动表达语义。",
      "图形强调可以在2至3格出现，但每格必须是由当前语义推导出的不同效果，并始终与真实道具、空间尺度、碎屑路径、局部放大证据和角色互动共同工作。",
    );
  }
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
  const backupDir = `backups/storyboard-directors-v6.3.2-${stamp}`;
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
    const nextPrompt = calibrate(agent.system_prompt, target.mode);
    assert.match(nextPrompt, /10秒：固定4格/);
    assert.match(nextPrompt, /每镜开头必须标注/);
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
    assert.ok(after.system_prompt.includes(marker), `${target.name}未写入v6.3.2`);
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
