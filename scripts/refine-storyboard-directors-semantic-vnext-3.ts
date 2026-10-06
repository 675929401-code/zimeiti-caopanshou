import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const oldMarker = "【语义泛化与开放包装知识库 vNext.2 2026-08-15】";
const marker = "【对标风格锁与语义包装编排 vNext.3 2026-08-15】";
const targets = [
  { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张", mode: "high_energy", expectedSha: "f4035491d9aaba5615adc7a321fd274bd533a07cbb12ce3321fb9c40e2e74764" },
  { id: "agent-1786642714227-e1zid1", name: "故事版导演｜电影叙事", mode: "cinematic", expectedSha: "20a031d87d50ce45e6abe52ec8a298921aea96a2841f2bb9c77876f0f3da0c85" },
  { id: "agent-1786642714448-m6iaou", name: "故事版导演｜抒情情感", mode: "lyrical", expectedSha: "0524237023ac2f38e90a0398a5c2bc9c04480e32a92fa453aaf398caf0679337" },
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

const packagingKnowledge = `# 包装知识储备与编排方法
包装不是“关键词—固定图标”对照表，也不是把特效全部删掉。先判定信息任务，再从多个包装家族中选择、改造和组合；盾牌、天平、金线、发光牌、警报牌、弹窗都保留为合法候选，但没有任何一种是默认答案。

可调用的开放家族包括但不限于：
- 剧情道具：球、食盆、量杯、玩具、门、牵引绳、衣物、家具、交通与工作器具，让真实物件承担比较、因果或选择。
- 测量与状态：刻度盘、计量杯、进度槽、温度/重量/距离标尺、阈值门、倒计时、前后对照；必须嵌入场景并由角色触发。
- 标识与结论：知识卡、警示牌、发光牌、标签、徽章、印章、盾牌、奖章、票据、路牌；造型、材质和短词由本段语义决定。
- 关系与平衡：天平、跷跷板、杠杆、托盘、分岔路径、桥、门槛、边界、保护罩；可表达取舍、挤占、阻挡、保护或关系距离。
- 流动与轨迹：能量线、声波、气流、粒子、液体、光带、脚印、速度线、回声、气味路径；颜色不固定为金色，方向、密度和衰减必须服从因果。
- 空间与环境：房间伸缩、地面倾斜、墙面开合、物件堆叠、影子变形、天气转场、局部舞台化、前后景对照、回忆窗与未来窗。
- 局部友好示意：放大镜、透明外轮廓、局部无创剖视、简化流程图、对照泡、标注线与环境隐喻；医学内容不得出现血腥器官。
- 漫画与动作包装：爆发线、冲击烟尘、弹性拖影、定格闪光、拟声形状、速度弧、夸张反应符号；服务动作峰值，不得遮挡主体或替代真实受力。

每个包装时刻用六步原创编排：语义核 → 视觉动词 → 场景载体 → 空间形态 → 角色互动 → 生命周期。再执行三次判断：
1. 适配：它是否比纯表演更快讲清当前信息；若不是，保留纯表演。
2. 丰富：同一段需要多个包装时刻时，围绕同一因果链使用不同家族或不同物理阶段，形成“预示—爆发—结论”，不只是同一图标换色。
3. 场景化：角色必须看见、举起、踩过、拉动、撞开、避开、承受或改变它；包装出现、运动、转化、消退，并留下动作或物理结果。

包装强度随模式和内容变化：
- 高能版：喜剧动作段可有1至2个动作包装；知识、健康、反差或结论段通常安排2至4个包装时刻，并至少使用两种不同包装家族；仍保留至少1格纯表演或真实物理证据。高潮/揭示格可以使用一个大型主包装作为构图中心。
- 电影版：通常1至2个包装时刻，优先化为转场、光影、空间机关或关键剧情道具；避免广告贴纸感。
- 抒情版：通常1至2个包装时刻，优先依附距离、旧物、影子、天气、窗景与环境变化；文字和图标更克制。

文字也是包装资源而非禁区。每格下方的英文制作说明条始终必有；故事场景内部，高能知识/健康/结论段可按需使用全段1至2处短标签，电影或抒情段通常0至1处。短标签限1至8个汉字或一个稳定英文/数字组合，必须写出精确内容、载体、位置、互动和核对要求。不要生成整句口播字幕。`;

const styleLock = `# 对标一致的皮克斯式3D动画风格锁
- 默认画面必须明确写成“对标一致的高端商业级皮克斯式风格化3D动画电影”，这描述的是动画造型与制作质感，不复制任何现成角色或IP形象。
- 人物使用清晰动画骨相：略大头部、放大且有高光的眼睛、简化鼻唇下颌、可读眉眼、归纳的大块发束、丝滑哑光无毛孔皮肤；体态与服装由当前文案推导，不固定黄卫衣年轻女性。
- 宠物使用明确犬种轮廓、动画化头颅与眼睛、短宽口鼻和成束蓬松毛发，同时保持自然四足、稳定骨骼和可信落地受力。
- 材质可以精细可信，但绝不滑向真人、半写实真人、照片写实、真人毛孔、真人发丝、蜡像脸或照片级动物。风格优先级高于材质细节。
- 每个视频Prompt开头重新完整锁定上述风格，并写明“只让参考图里的风格化3D角色动起来”；视频不得把卡通参考图重绘成真人或半写实人物。`;

const textSafety = `# 医学、文字与安全边界
- 健康/医学知识只用局部无创放大、透明友好示意、检查动作、颜色变化、测量包装或环境隐喻；禁止血腥解剖、完整内脏剖面、裸露器官、错误关节和身体扭曲。
- 每格下方的白色制作说明条属于故事板排版，不属于故事场景；必须包含准确、可执行的英文动作句，供后续视频制作读取。
- 故事场景内的知识短词、标签和数字是合法包装资源：高能知识/健康/结论段按需0至2处，电影或抒情段通常0至1处；每处限1至8个汉字或一个稳定英文/数字组合。必须把精确字符串放在引号内，指定载体、位置、互动与生成后逐字核对。
- 禁止整句口播字幕、对白气泡、品牌、水印、无关文字，以及除白色制作说明条和已获准短标签之外的可读文字。模型若无法稳定呈现某个长词，缩短标签并让图形、动作和物理证据承担主信息。`;

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
  assert.equal(sha256(prompt), target.expectedSha, `${target.name}当前Prompt不是预期vNext.2`);
  let next = replaceExact(prompt, oldMarker, marker, `${target.name}版本标记`);
  next = replaceSection(next, "# 包装知识储备的扩展方法", "# 视觉多样性账本", packagingKnowledge);
  next = replaceSection(next, "# 医学、文字与安全边界", "# 画面底片", textSafety);
  next = replaceExact(next, "# 画面底片", `${styleLock}\n\n# 画面底片`, `${target.name}风格锁插入`);
  next = replaceExact(
    next,
    "2. 写一遍本段完整资产锁：人物、宠物/产品、服装、识别特征、关键真实道具和基础场景。默认皮克斯式时明确“高端商业级风格化3D动画、非真人实拍、非照片写实”，并写出动画骨相与可信材质边界。",
    "2. 写一遍本段完整资产锁：人物、宠物/产品、服装、识别特征、关键真实道具和基础场景。开头明确“对标一致的高端商业级皮克斯式风格化3D动画电影，非真人、非半写实、非照片写实”，并写出动画骨相、归纳毛发与可信材质边界；不得只写笼统的3D或电影感。",
    `${target.name}生图风格锁`,
  );
  next = replaceExact(
    next,
    "5. 若故事场景内部确需一个知识短词，单独说明它的内容、载体、位置、角色互动与必要性；全段最多一个1至6汉字短词。没有必要就不生成场景内文字。",
    "5. 把文字当作可选包装：高能知识/健康/结论段按需设计全段0至2处短标签，电影或抒情段通常0至1处；每处限1至8个汉字或一个稳定英文/数字组合。逐字写出内容，并说明载体、位置、角色互动、必要性和生成后核对；不得生成整句口播字幕。",
    `${target.name}场景文字预算`,
  );
  next = replaceExact(
    next,
    "6. 每格下方都有白色制作说明条和一条准确英文动作句；故事场景内默认无文字，确有必要时全段只有一个准确短词。",
    "6. 每格下方都有白色制作说明条和一条准确英文动作句；故事场景内短标签按模式与语义使用，高能知识/健康/结论段应主动判断0至2处，电影或抒情段通常0至1处，均逐字可核对。",
    `${target.name}文字质量门`,
  );
  next = replaceExact(
    next,
    "9. 默认非真人、非照片写实的电影级风格化3D动画；人物、犬体、手指、关节、服装、毛色和道具稳定。医学表达友好无创。",
    "9. 默认并明确写出对标一致的高端商业级皮克斯式风格化3D动画；绝不真人、半写实或照片写实。人物、犬体、手指、关节、服装、毛色和道具稳定，医学表达友好无创。",
    `${target.name}风格质量门`,
  );
  assert.equal(next.split(marker).length - 1, 1, `${target.name}vNext.3标记异常`);
  assert.match(next, /可调用的开放家族/u);
  assert.match(next, /非真人、非半写实、非照片写实/u);
  assert.match(next, /高能知识\/健康\/结论段按需设计/u);
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
  const backupDir = `backups/storyboard-directors-semantic-vnext-3-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  const results = [];

  for (const target of targets) {
    const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
    assert.ok(agent, `未找到目标智能体：${target.name}`);
    await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
    const nextPrompt = updatePrompt(agent.system_prompt, target);
    const outputStyle = {
      ...(agent.output_style || {}),
      schema_version: "storyboard_director_output_style.v3.3",
      benchmark_style_lock: "premium_pixar_style_3d_animation_no_live_action_no_semirealism",
      packaging_policy: "open_family_semantic_orchestration",
      packaging_families: ["story_props", "measurement_state", "signage_conclusion", "relationship_balance", "flow_trajectory", "space_environment", "friendly_local_diagram", "comic_action"],
      storyboard_caption_strips: "required_exact_english_action_sentence_per_panel",
      in_scene_text_budget: target.mode === "high_energy" ? "semantic_0_to_2" : "semantic_0_to_1",
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
    assert.ok(verified && verified.system_prompt.includes(marker), `${target.name}vNext.3未生效`);
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
