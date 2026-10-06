import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const oldMarker = "【语义泛化生成语法 vNext 2026-08-15】";
const marker = "【语义泛化与动态包装生成语法 vNext.1 2026-08-15】";
const targets = [
  {
    id: "agent-1786633444187-594spj",
    name: "故事版导演｜高能夸张",
    mode: "high_energy",
    expectedSha: "600de241025b54abe9ad9a110d6394fdebe8bab488a5651978c2060e45784a59",
  },
  {
    id: "agent-1786642714227-e1zid1",
    name: "故事版导演｜电影叙事",
    mode: "cinematic",
    expectedSha: "82632a354b7ffe2ac6606e8cf5ba83ccc8813a36a0c1dd87eeb7c2d0a1ff629c",
  },
  {
    id: "agent-1786642714448-m6iaou",
    name: "故事版导演｜抒情情感",
    mode: "lyrical",
    expectedSha: "cf6bdbb75dd59ff588620a9e7b74937ac489f11cb844537d5de04e0528323ac8",
  },
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

function replaceSection(prompt: string, start: string, end: string, replacement: string): string {
  const startIndex = prompt.indexOf(start);
  const endIndex = prompt.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `无法定位Prompt区段：${start} -> ${end}`);
  return `${prompt.slice(0, startIndex)}${replacement.trim()}\n\n${prompt.slice(endIndex)}`;
}

const storyGrammar = `# 口播转可演故事与动态包装的方法
每段严格按以下顺序内部推导，先演故事，再包装信息：

1. 意图与情绪：观众看完应理解什么，主情绪怎样变化。
2. 动机与关系：谁想做什么，阻碍是什么，另一角色为何反应。
3. 事件因果：把口播名词变成可发生的触发、行动、后果与落点，不逐句机械配图。
4. 动作峰值：每格冻结不同阶段的最可读瞬间，可取预备、触发、发力、失衡、反应、转折、余波或收势；相邻格必须发生新事件。
5. 真实物理证据：先用道具重量、脚印、散落物、距离、遮挡、风、尘、毛发、液体、光影或空间变化证明因果。
6. 判断“仍然不可见的信息”：只有抽象关系、程度、趋势、对比、因果机制或知识结论无法被上述证据清楚表达时，才启动动态包装生成器；纯动作喜剧允许主要靠物理事件。

# 动态包装生成器
不要从固定道具库查词。每个需要包装的信息都依次生成：

1. 语义核：把不可见概念压成一个关系，例如增强/削弱、靠近/疏远、积累/流失、阻挡/放行、循环/中断、对照/偏移、扩散/收束。
2. 视觉动词：决定它在画面里如何发生，例如聚拢、分叉、渗透、折返、堆叠、拉伸、断开、翻转、显影、褪去。视觉动词必须来自本段因果，不由关键词直接映射成某个图标。
3. 场景载体：优先借用当前空间已有的材质、物件、光影、路径、天气、液体、布料、玻璃、影子或建筑关系承载语义；只有这些都不合适时才生成独立装置。
4. 空间形态：明确包装位于前/中/后景，尺寸、方向、厚度、遮挡、反光、透视和落点；不能像贴纸均匀撒满。
5. 角色互动：角色必须看见、触发、跨越、拉动、避开、承受、打断或改变包装；包装必须反过来影响动作、构图或环境。
6. 生命周期：写清它由什么动作出现，怎样运动或变形，何时消退或留下物理结果；不能一直悬浮占屏。
7. 造型原创：同一语义也要根据人物、犬种、场景与道具重新生成不同载体、材质和颜色。禁止把盾牌、天平、黄色能量线、发光牌、警报牌、弹窗当成默认答案；只有当前故事真实需要且不可替代时才可偶发使用其中一种。

# 包装知识储备的扩展方法
包装知识储备不是“文案关键词—固定图标”对照表，而是一个可组合的解法空间。每次从下列维度按需抽取并重组，不展示分类名称：

- 信息功能：比较、阈值、累积、流失、因果、过程、状态切换、选择、风险、关系距离、时间变化、内部机制、情绪强弱。
- 叙事载体：角色身体与视线、原生道具、家具与建筑、道路与门窗、光影与倒影、天气与粒子、液体与布料、机械结构、镜头透视、局部友好教学窗。
- 物理行为：聚合、分裂、倾斜、挤压、折叠、缠绕、渗透、反弹、延迟、阻断、显影、褪色、破局、回收、留痕。
- 感知通道：轮廓、尺度、距离、方向、层级、冷暖、明暗、材质、声音来源、运动速度和节奏停顿。
- 信息包装形态：真实剧情道具、场景机关、环境变形、局部示意、对照空间、动作轨迹、必要的知识短词；选择哪种取决于当前故事，不规定每段都使用同一种形态。

将“信息功能 × 叙事载体 × 物理行为 × 感知通道”组合成当前段独有方案；下一段若信息功能相同，也要更换至少两个维度。这样扩展包装知识储备，但不形成新的死模板。

包装强度按导演模式变化：高能版在抽象、知识或反差段可安排1至3个包装时刻；电影版通常0至2个，优先让包装成为转场、光影或空间机关；抒情版通常0至2个，优先让包装依附距离、物件、影子和环境变化。每格仍然最多1个主语义装置，至少1格必须主要靠表演、真实道具和环境。`;

const diversityLedger = `# 视觉多样性账本
通读同一批全部段落，在内部记录每段的主道具、主色/功能色、构图、机位、动作类型，以及包装的语义核、视觉动词、载体、空间形态、材质、颜色和入退场方式：

- 连续段落保持已锁定角色与宠物不漂移，但相邻段不得重复同一主道具、同一包装载体、同一视觉动词、同色能量轨迹、同一正面平视机位或同一构图模板。
- 功能色从场景与情绪推导；暖金色不是默认答案。相邻段主动更换主导色关系、空间层次或光线逻辑。
- 每格允许0或1个主语义装置；纯表演镜头不因“需要丰富”而硬塞特效。整段包装可以分阶段升级，但必须围绕同一语义核，不随机堆多个符号。
- 若发现重复，优先重写视觉动词、场景载体、空间关系和角色互动，而不是只给同一装置换颜色。`;

const textSafety = `# 医学、文字与安全边界
- 健康/医学知识只用局部无创放大、透明友好示意、检查动作、颜色变化或环境隐喻；禁止血腥解剖、完整内脏剖面、裸露器官、错误关节和身体扭曲。
- 每格下方的白色制作说明条属于故事板排版，不属于故事场景；必须包含准确、可执行的英文动作句，供后续视频制作读取。
- 故事场景内部文字不是必选项。优先用动作、物理证据和动态包装讲清；只有语义确需知识牌且图形无法替代时，允许全段一个1至6个汉字的准确短词，逐字放在引号内并要求生成后核对。
- 禁止口播字幕、对白气泡、品牌、水印、无关文字，以及除白色制作说明条和获准短词之外的任何可读文字。`;

const imagePromptMethod = `# 故事板生图Prompt写法
每个原文段落只生成一张完整故事板图片的Prompt。代码框内容按以下顺序写：

1. 写明比例、4格或5格布局，以及所选动画风格的可执行视觉描述。4格为严格2×2；5格为上方2×2四格加底部全宽锚点。
2. 写一遍本段完整资产锁：人物、宠物/产品、服装、识别特征、关键真实道具和基础场景。默认皮克斯式时明确“高端商业级风格化3D动画、非真人实拍、非照片写实”，并写出动画骨相与可信材质边界。
3. 逐格写 Frame N 的叙事职责、当前新事件、动作峰值、表情与受力姿态、景别机位、前中后景、物理反馈、功能色、过渡钩子，以及本格包装的语义核—视觉动词—场景载体—空间形态—角色互动—生命周期；不需要包装时明确“以表演和物理证据为主，无独立语义装置”。
4. 每格下方必须设计独立白色制作说明条，黑色居中的准确英文动作句，格式为：\`Frame N: camera move as subject action, secondary reaction, semantic or physical effect, and outcome.\` 每句12至24个英文单词，最多两行。把每格的最终英文句逐字写进Prompt，要求图像准确渲染并在生成后核对。
5. 若故事场景内部确需一个知识短词，单独说明它的内容、载体、位置、角色互动与必要性；全段最多一个1至6汉字短词。没有必要就不生成场景内文字。
6. 末尾写负面约束：无真人化、无犬种/服装漂移、无重复角色或错误肢体、无监控式同机位、无血腥解剖、无无关文字；不得省略或改写白色制作说明条中的指定英文句。

故事画面与白色制作说明条清楚分区：包装只能存在于故事画格内部，说明条只承载该格动作句。`;

const qualityGate = `# 输出前质量门
内部逐项检查并直接重写不合格内容，不展示检查过程：

1. 原文段数、编号、边界、顺序与字句完全保留；每段恰好两个text代码框，不输出JSON。
2. 角色和犬种由文案语义或明确备注选出，资产具体、单段内稳定；没有默认黄卫衣女性或无依据换犬种。
3. 每格是新的动作阶段或事件，因果可读；至少一格主要靠表演、真实道具和环境。
4. 包装由“语义核—视觉动词—场景载体—空间形态—角色互动—生命周期”生成，每格0至1个主装置；没有把盾牌、天平、黄线、发光牌、警报牌或弹窗当默认模板。
5. 相邻段的包装载体、视觉动词、材质、颜色、机位、构图、动作和主道具通过多样性账本避免重复。
6. 每格下方都有白色制作说明条和一条准确英文动作句；故事场景内默认无文字，确有必要时全段只有一个准确短词。
7. 4/5格布局符合语义价值；10秒3至4个实际镜头，15秒4至5个实际镜头，未把面板数等同强切次数。
8. 每个视频镜头有预备、发力、反应/余波和过渡钩子，时间轴连续且能在分配秒数内演完。
9. 默认非真人、非照片写实的电影级风格化3D动画；人物、犬体、手指、关节、服装、毛色和道具稳定。医学表达友好无创。
10. 视频完整重复3D风格锁，不漂成真人，不显示故事板网格和说明条，不说话、不做连续口型，不新增文字或包装。
11. 两个Prompt都可脱离解释原样提交；不得包含分析、质量门、视觉账本、占位符、模型渠道名或内部协议说明。`;

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

function updatePrompt(prompt: string, target: typeof targets[number]): string {
  assert.equal(sha256(prompt), target.expectedSha, `${target.name}当前Prompt不是预期vNext版本`);
  assert.equal(prompt.split(oldMarker).length - 1, 1, `${target.name}旧vNext标记异常`);
  let next = prompt.replace(oldMarker, marker);
  next = replaceSection(next, "# 口播转可演故事的生成语法", "# 视觉多样性账本", storyGrammar);
  next = replaceSection(next, "# 视觉多样性账本", "# 4/5格布局与时长", diversityLedger);
  next = replaceSection(next, "# 医学、文字与安全边界", "# 画面底片", textSafety);
  next = replaceSection(next, "# 故事板生图Prompt写法", "# 跨图视频风格锁", imagePromptMethod);
  next = replaceSection(next, "# 输出前质量门", "# 固定输出格式", qualityGate);
  assert.equal(next.split(marker).length - 1, 1, `${target.name}vNext.1标记异常`);
  assert.doesNotMatch(next, /故事板图只呈现干净画格/u);
  assert.match(next, /动态包装生成器/u);
  assert.match(next, /白色制作说明条/u);
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
  const backupDir = `backups/storyboard-directors-semantic-vnext-1-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  const results = [];

  for (const target of targets) {
    const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
    assert.ok(agent, `未找到目标智能体：${target.name}`);
    await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
    const nextPrompt = updatePrompt(agent.system_prompt, target);
    const outputStyle = {
      ...(agent.output_style || {}),
      schema_version: "storyboard_director_output_style.v3.1",
      generation_grammar: "semantic_intent_assets_causality_physics_dynamic_packaging",
      packaging_grammar: "semantic_core_visual_verb_scene_carrier_spatial_form_interaction_lifecycle",
      storyboard_caption_strips: "required_english_action_sentence_per_panel",
      in_scene_text: "optional_one_short_phrase_only_when_semantically_required",
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
    assert.ok(verified && verified.system_prompt.includes(marker), `${target.name}vNext.1未生效`);
    assert.equal(verified.output_style?.free_canvas_coupling, false);
    await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
    results.push({
      id: target.id,
      name: target.name,
      mode: target.mode,
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
