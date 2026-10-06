import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const marker = "【对标视觉事件语法 v6.3】";
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

const strategyByMode = {
  high_energy: `${marker}
本卡负责高能夸张短视频。核心不是“多加线条”，而是让每一格都出现新的、能被缩略图读懂的视觉事件。把当前口播改编为“异常动作钩子 -> 主人误判与身体喜剧 -> 狗狗真实意图的可见证据 -> 因果反转 -> 强结论落点”。

使用低机位广角、前景冲撞、爆发式推近、横摇追拍、弹性压缩拉伸和明确的预备-爆发-急刹-回震。角色眉眼、瞳孔、嘴角、耳尾、重心和四肢必须形成强剪影；宠物始终保持自然四足。高速动作至少改变一次环境：地毯掀起、靠垫飞离、道具滚动、尘云划出路径、家具形成障碍或空间被知识装置重新组织。每张故事板至少包含：一格极端动作峰值、一格表情或身体反应近景、一格不依赖文字的因果证据、一格空间级高潮或结论。速度线、光圈和电流只能辅助动作，不能替代事件，也不能五格连续重复。`,
  cinematic: `${marker}
本卡负责电影化连续叙事。电影感不等于五格都在同一客厅温和对话，而是用空间、遮挡、动作和证据逐步改写观众对事件的理解。把当前口播改编为“建立关系与空间 -> 触发误会 -> 行动造成距离变化 -> 发现可见证据 -> 关系或知识落点”。

使用建立镜头、人物肩后关系镜头、低机位跟拍、景深转移、动作匹配和有动机的推拉横移。相邻格保持角色身份和空间轴线，但允许镜头进入道具近景、主观感知、局部演示空间或更大的结论场景，不能只是相同双人构图换焦段。每张故事板至少包含：一格空间建立、一格触发近景、一格行为后果、一格可见证据或机制、一格有余韵的宽幅落点（只有四格时合并职责）。包装优先成为可触摸的道具、环境变化、局部演示窗或一次有意义的转场，不用发光线条串满全片。`,
  lyrical: `${marker}
本卡负责抒情与情感关系。抒情不等于五张相似的暖光肖像，而是通过距离、空位、触碰、等待、道具和光线变化形成清楚的情绪事件。把当前口播改编为“情绪状态 -> 关系触发 -> 犹豫或失去 -> 看见真实意图 -> 温柔或酸涩落点”。

使用缓推、平稳横移、前景遮挡、主观视线、手部与耳尾特写、关系剪影和有呼吸感的宽幅构图。每张故事板至少包含：一格明确动作、一格双方距离改变、一格能证明内心状态的具体物件或空间证据、一格构图明显变化的情绪峰值。心形、波纹、微光和丝带只有在触碰或关系语义不可由表演讲清时才出现；整张故事板最多让一种线性光效成为一格的主视觉，其余格用表演、道具、环境和留白推进。`,
} as const;

const semanticVisualization = `${marker}
语义先由角色表演和物理事件承担，包装只补足“观众仍然看不见、但必须理解”的信息。每段只选一个最有效的可视化载体，并按以下优先级决定：
1. 物理证据：具体道具、痕迹、距离、重量、遮挡、散落物、门缝、秤、放大镜、玩具或环境反馈；
2. 场景化机制：把因果做成角色能进入、躲避、触碰或观察的小型演示空间、局部剖面窗、路径障碍或舞台装置；
3. 环境变形：光色、景深、家具、风、尘、毛发、碎屑和空间尺度随当前动作发生可见变化；
4. 图形强调：问号、星星、心跳、速度线、波纹、轮廓光只用于一瞬间的情绪或力度，不能成为所有语义的默认答案。

禁止把“暖金线、光环、丝带、心跳线”当作万能母题；同一种线性效果不得在两格以上充当主视觉。至少一格完全不使用图形特效，只靠角色姿态、表情、道具和环境讲清。知识或结论优先使用无文字的图标、形状、颜色对比和角色互动；故事画面内部禁止生成中文或英文字牌、盾牌文字、对白气泡和口播字幕。英文 Frame 制作说明只能位于每格下方独立白色说明条中，不属于故事场景，视频不得读取或动画化说明条。

可视化必须写清实体来源、位置、尺度、遮挡、反光和角色如何触发它。医学与身体机制只做友好局部放大窗，不展示完整开膛式身体。`;

const visualBase = `统一资产只锁定人物身份、宠物品种、服装、关键道具和主场景方向，不锁死每格机位、景别、前后景和视觉舞台。角色一致，画面必须变化。

- 商业级3D动画画质：清楚轮廓、可信毛发与布料、明亮高光、干净冷暖分离、电影级体积光和景深；避免灰、闷、脏、塑料感和写实摄影感；
- 每格必须有不同的主体剪影、相机高度、景别或前后景关系；五格中至少覆盖远/全景、中景、近景或极近特写三种尺度；
- 同一地点连续时，可进入道具近景、主观感知、局部机制空间或结论舞台，再回到真实环境；不得五格都把人物和宠物并排放在同一沙发前；
- 动作必须有峰值：预备、发力、反应、后果或收势之一，而不是站着解释；环境至少在一格对动作产生物理反馈；
- 每格只保留一个视觉中心。特效服务主体，不遮脸、不取代角色、不形成满屏模板光圈；
- 画内不生成品牌、水印、对白、口播字幕和知识文字。只有面板下方英文制作说明条允许出现文字。`;

const storyboardPromptRules = `每个原文段落只生成一张完整故事板图片。

输出语言：生图Prompt主体必须使用简体中文，只有固定版式短句“top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel”和每格下方英文Frame制作说明可以使用英文。禁止整段生图Prompt改写成英文。

1. 先把口播转成4至5个“视觉事件”，每格必须承担不同职责：建立、触发、升级、证据/机制、反转/落点。只有四格时合并相邻职责，不得复制同一动作或换角度重拍。
2. 四格使用标准2x2；五格必须原样写入“top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel”。底部宽幅格必须承担空间高潮、因果揭示、警示、结论或情绪落点，不能只是把上一格拉远。
3. 逐格直接写可见画面：叙事职责、唯一机位景别、主体动作峰值、面部与身体反应、道具和环境反馈、当前语义载体、光色、与下一格的动作/视线/道具交接。不要解释设计意图。
4. 视觉差异门：五格至少有4种明显不同的构图或主体剪影，至少2种不同的空间层次；高能版至少1格空间级奇观和1格极端表演，电影版至少1格机制/证据画面和1次有动机转场，抒情版至少1格具体情感证据和1格强关系剪影。
5. 视觉载体差异门：整张图至少使用两类载体（表演、物理道具、环境反馈、场景化机制、图形强调），禁止五格都使用光线、圆环、丝带或心跳波。至少一格不含任何图形特效。
6. 文字安全门：故事画面内部不生成任何中文或英文字牌。每格下方可放独立白色制作说明条，格式为“Frame N: camera move as subject action, secondary reaction, physical or semantic effect, and outcome.”，每句18至26个英文单词；说明条与画面严格分离。
7. Prompt要具体但紧凑：统一设定只写一次；逐格避免重复整段资产描述，用固定资产名称指代。完整生图Prompt以1800至3200个中文字符为目标，禁止靠同义画质词堆长。
8. 禁止上2下3等宽、五张独立图、错序拼贴、监控视角重复、相同双主体站位反复、错误肢体、宠物人形化、角色复制和资产漂移。`;

const videoPromptRules = `第一段写读取协议：把完整故事板作为角色、场景、道具、表演阶段和视觉载体参考，生成用户选择的8、10或15秒正常全屏视频。只读取每格故事画面，不读取、不放大、不复现白色说明条、Frame编号或任何文字；若参考图中意外出现乱码或文字，视频必须忽略并移除。成片不得显示网格、分隔线、拼图或分屏。

输出语言：视频Prompt必须使用简体中文大白话写可执行动作，不输出英文镜头段落，不复述Frame英文说明；模型名称、必要技术缩写和时间数字除外。

随后按实际镜头数用大白话逐镜写“怎么演”：
“镜头N（起止秒）：相机从哪里开始怎样移动；人物和宠物从什么姿势开始，依次做哪些连续动作；表情、耳尾、重心和环境怎样反应；故事板中的道具、机制或特效怎样被触发并在何处结束；用动作、视线、方向、声音或道具交给下一镜。”

- 8秒高能2至3镜、电影2至3镜、抒情1至2镜；10秒高能3至4镜、电影2至3镜、抒情1至2镜；15秒高能4至5镜、电影3至4镜、抒情2至3镜。面板数不是切镜数；
- 角色始终是画面主体。任何盾牌、图标、演示窗或特效都只能作为辅助证据，除非口播明确讲该物体，否则不得单独占满全屏、遮住角色或成为长时间中心；
- 视频只动画化故事板中已经存在的可见载体，不把线条升级为巨大标牌，不凭空生成中文或英文，不让角色读字牌；
- 每镜保留一个主要运镜、一个核心动作和一个关键反应，动作有预备、发力、反应与收势；避免同时推拉、旋转、俯冲；
- 人物和宠物不说话、不做对白口型。只写脚步、犬爪、衣料、道具、呼吸和环境等自然声音；不生成旁白、歌词、口播字幕或背景音乐；
- 镜头时间轴连续覆盖目标时长，最后0.5至1秒留下稳定落幅。`;

const qualityGate = `输出前逐格自检并直接重写不合格内容，不展示检查过程：
1. 原口播逐字保留，因果从动作中看得懂；
2. 具体人物、宠物、服装和道具已锁定，没有“同一个人/同一只狗”等模糊描述；
3. 每格恰好出现要求的一人一宠，不重复、镜像或增加同类主体；
4. 五格至少4种不同构图或主体剪影，不能五格都在同一沙发前进行温和对话；
5. 至少一格纯表演、一格物理证据或场景化机制、一格明显环境/空间变化；抒情低信息段允许把后两项合并；
6. 同一种线、环、丝带、波纹或发光轨迹不得在两格以上作为主视觉，至少一格完全无图形特效；
7. 故事面板内部没有可读文字、盾牌文字、标签、字幕或对白；英文只存在于白色制作说明条；
8. 宽幅第五格有独立价值，不是上一格的重复远景；
9. 视频Prompt不读取Frame说明条，不围绕乱码或巨型图标拍摄，角色和真实动作始终为主体；
10. 生图Prompt主体为简体中文，视频Prompt为简体中文大白话；除固定版式短句和英文Frame制作说明外，不得整段输出英文；
11. 图像面板数与视频真实镜头数解耦，时间轴完整，动作和声音能顺滑交接。`;

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

function upgradePrompt(prompt: string, mode: keyof typeof strategyByMode): string {
  let next = prompt.replaceAll("约10秒", "用户选择的8、10或15秒");
  next = replaceSection(next, "# 当前导演策略", "# 输入合同", strategyByMode[mode]);
  next = replaceSection(next, "# 语义包装", "# 画面底片", semanticVisualization);
  next = replaceSection(next, "# 画面底片", "# 3D风格执行字典", visualBase);
  next = replaceSection(next, "# 故事板生图Prompt写法", "# 图生视频Prompt写法", storyboardPromptRules);
  next = replaceSection(next, "# 图生视频Prompt写法", "# 输出前质量门", videoPromptRules);
  next = replaceSection(next, "# 输出前质量门", "# 稳定输入协议 v6.2", qualityGate);
  return next;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const initial = await jsonRequest<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const current = targets.map((target) => initial.agents.find((agent) => agent.id === target.id));
  assert.ok(current.every(Boolean), "三张故事版导演卡片未全部找到");

  const rows = current as AdminAgent[];
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-directors-benchmark-v6.3-${stamp}`;
  await mkdir(backupDir, { recursive: true });
  await writeFile(`${backupDir}/before.json`, JSON.stringify({
    created_at: new Date().toISOString(),
    purpose: "Benchmark visual-event grammar v6.3 preflight backup",
    agents: rows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      prompt: agent.system_prompt,
      prompt_sha256: sha256(agent.system_prompt),
      updated_at: agent.updated_at,
    })),
  }, null, 2), "utf8");

  for (const target of targets) {
    const agent = rows.find((item) => item.id === target.id)!;
    assert.ok(!agent.system_prompt.includes(marker), `${agent.name}已经包含v6.3，拒绝重复追加`);
    const nextPrompt = upgradePrompt(agent.system_prompt, target.mode);
    assert.ok(nextPrompt.includes(marker));
    assert.doesNotMatch(nextPrompt, /画内必要短词最多两个|占画面20%至35%的知识\/结果揭示物/);
    assert.match(nextPrompt, /故事画面内部禁止生成中文或英文字牌/);
    assert.match(nextPrompt, /同一种线性效果不得在两格以上充当主视觉/);

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
  const summary = [];
  for (const target of targets) {
    const before = rows.find((item) => item.id === target.id)!;
    const after = verified.agents.find((item) => item.id === target.id)!;
    assert.ok(after.system_prompt.includes(marker), `${target.name}未写入v6.3`);
    const history = await jsonRequest<{ versions: Array<{ prompt: string }> }>(
      `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(target.id)}`,
      session.token,
    );
    assert.ok(history.versions.some((item) => sha256(item.prompt) === sha256(before.system_prompt)), `${target.name}缺少云端旧版历史`);
    assert.ok(history.versions.some((item) => item.prompt.includes(marker)), `${target.name}缺少云端v6.3历史`);
    summary.push({
      id: target.id,
      name: target.name,
      before_chars: before.system_prompt.length,
      after_chars: after.system_prompt.length,
      prompt_versions: history.versions.length,
      before_sha256: sha256(before.system_prompt),
      after_sha256: sha256(after.system_prompt),
    });
  }

  await writeFile(`${backupDir}/after-summary.json`, JSON.stringify({
    created_at: new Date().toISOString(),
    marker,
    agents: summary,
  }, null, 2), "utf8");
  console.log(JSON.stringify({ passed: true, backupDir, agents: summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
