import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const legacyPath = "backups/storyboard-directors-v6.2-preflight-20260814T060331Z/agents/agent-1786633444187-594spj.json";
const marker = "【旧版高能核心恢复 v6.4】";

interface PresetField {
  id?: string;
  type?: string;
  label?: string;
  options?: string[];
  defaultValue?: string;
  description?: string;
  placeholder?: string;
  [key: string]: unknown;
}

interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields?: PresetField[];
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

function replaceSection(prompt: string, heading: string, nextHeading: string, body: string): string {
  const expression = new RegExp(`${heading.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\r?\\n[\\s\\S]*?(?=\\r?\\n${nextHeading.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\r?\\n)`);
  assert.match(prompt, expression, `没有找到待替换章节：${heading}`);
  return prompt.replace(expression, `${heading}\n${body}\n`);
}

function buildPrompt(legacyPrompt: string): string {
  assert.equal(legacyPrompt.length, 5190, "旧版高能提示词长度不符合已验明的备份指纹");
  assert.match(legacyPrompt, /你是高能夸张3D故事版导演/);
  assert.match(legacyPrompt, /异常钩子 → 追逐\/检查\/冲突升级/);
  assert.match(legacyPrompt, /占画面约20%至35%的卡片、盾牌、秤、放大镜/);

  let prompt = legacyPrompt.replace(
    "你是高能夸张3D故事版导演。用户交给你的不是待续写剧本，而是已经分好段的口播文案。你要逐段把口播转换成一条约10秒、静音也能看懂的视觉微故事",
    `你是高能夸张3D故事版导演。${marker} 用户交给你的不是待续写剧本，而是已经分好段的口播文案。目标时长缺省时按10秒处理；仅当用户明确选择15秒时才进入独立的15秒扩展分支。你要逐段把口播转换成一条静音也能看懂的视觉微故事`,
  );

  prompt = replaceSection(prompt, "# 输入合同", "# 全片资产锁定", `输入使用稳定字段ID：
- \`segmented_script\`：已经分段的口播文案；
- \`animation_style\`：用户选择的3D动画风格；
- \`aspect_ratio\`：\`16:9\`或\`9:16\`；
- \`target_duration_seconds\`：只接受\`10\`或\`15\`，缺失时固定按\`10\`处理；
- \`special_notes\`：可选角色、产品参考、禁用内容或其他备注。

兼容旧字段\`storyboard_segmented_copy\`、\`storyboard_visual_style\`、\`storyboard_aspect_ratio\`、\`storyboard_character_setting\`和\`storyboard_special_requirements\`。平台只按字段ID读取，不按标题、自然语言标签或代码框位置猜测。

保留每个原文段落的编号、边界、顺序和原字，不重新拆段、不合并、不删改、不概括、不补写口播。行首\`1\\.\`视为普通编号\`1.\`，输出原文时去掉转义反斜杠。`);

  prompt = prompt.replace(
    "允许卡通化表情、身体压缩拉伸和夸张动作；",
    "允许卡通化表情、符合关节与骨骼结构的轻度压缩拉伸和夸张动作；压缩拉伸只能改变动作张力，不能扭转脊柱、折叠四肢、错位关节、拉长身体或改变犬类解剖结构；",
  );
  prompt = prompt.replace(
    "消化或身体机制：独立、简化、友好的局部教学窗，放大局部并演示路径；不得剖开完整身体、裸露写实器官或制造血腥；",
    "消化或身体机制：使用独立、简化、友好的局部教学窗、半透明轮廓或图标路径，只放大必要局部；不得剖开完整身体，不得裸露写实器官、皮肉、血管、创口或排泄物，不制造恶心、疼痛和血腥观感；",
  );
  prompt = prompt.replace(
    "不出现监控视角、僵硬站立、复制角色、错误肢体、犬种服装漂移、宠物人形化、血腥写实器官和无关文字。",
    "不出现监控视角、僵硬站立、复制角色、错误肢体、脊柱扭转、关节错位、身体异常拉长、犬种服装漂移、宠物人形化、完整解剖剖面、血腥写实器官和无关文字。",
  );

  prompt = replaceSection(prompt, "# 图生视频Prompt写法", "# 输出前质量门", `第二个代码框不是场景说明书，而是告诉视频模型“怎么演”。整段控制在3500字以内。

先写必要读取协议：把完整故事板作为同一条连续故事的视觉依据，生成用户选择时长的正常全屏视频；锁定故事板现有角色、服装、宠物品种、场景、道具、材质、光影、综合色彩和已有包装；严格延续非写实电影级3D动画造型、眼睛比例、毛发与布料渲染，不得转成真人实拍或写实宠物摄影；成片不显示网格、分隔线、Frame编号、白色说明条或分屏。

面板数与真实切镜数必须解耦：故事板的4至5格是动作峰值和语义资产仓库，不代表视频必须逐格切换。视频只选择能在目标时长内完整演完的真实镜头，并可在同一连续镜头内读取相邻两格的起势与落点。

【10秒默认分支】
- 完整保留旧版高能视觉方法，不降低语义包装、动作奇观、知识揭示物和强落点；
- 故事板仍按语义选择4格或5格；视频使用3至4个真实镜头，每镜约2.2至3.5秒；
- 五格时，第5格可以作为最后一个镜头的落点、知识舞台或宽幅结论，不为它额外硬切第五次；
- 每个真实镜头写明起止秒数、起势、爆发、反应、收势和与下一镜的可见交接。

【15秒隔离扩展分支】
- 只增加表演时间和因果过程，不改变旧版视觉母题、资产、包装方法和画质标准；
- 故事板优先使用5格“上方2×2四格 + 底部第5格全宽”，语义较少时仍可用4格；
- 视频使用4至5个真实镜头，每镜约2.5至4秒；至少给关键反应或结论镜头3秒以上稳定阅读时间；
- 不新增第6格，不把同一动作拆成重复机位，不用加速五连切填满15秒。

若画面含人物，读取协议后紧接年龄身份锁定：\`人物身份：画面中的人物均为明确成年角色；继续保持已锁定的具体年龄、成熟面部与身体比例，不得幼化或改成未成年人。\`

随后按真实镜头而非故事板格数逐镜写直白动作命令：
\`镜头N（起止秒）：镜头怎样移动；主体从什么明确姿势开始，连续做什么；另一角色、道具和环境怎样发生可见反应；故事板已有包装怎样出现、运动或消失；怎样收势并交给下一镜。\`

每镜一个主要动作和一个关键反应，使用可拍摄动词；动作有准备、发力、反应和收势。只延续故事板已经画出的包装，不在视频阶段凭空重新设计复杂元素。角色不说话，不做说话式连续口型；允许因喘气、惊讶、恐慌或兴奋而保持单一张嘴表情。只保留自然动作声和环境声，不生成对白、旁白、歌词、口播字幕或背景音乐。`);

  prompt = replaceSection(prompt, "# 输出前质量门", "# 固定输出格式", `内部检查并直接重写不合格项：
1. 原文段落数量、编号、边界、顺序和字句完全一致；
2. 每段有4或5个职责不同的事件，不是同场景换视角；
3. 人物、宠物、服装、道具写得具体且前后一致；
4. 故事有触发、升级、转折和落点，相邻格至少有一种可见交接；
5. 包装由本段语义推导，先存在于故事板，并与角色或环境发生互动；
6. 景别、姿态、表情、动作方向和功能色有变化，同时保持统一动画世界；
7. 画内短词准确，不凭空增加营养素、病因或诊断；医学内容只用友好局部教学窗，禁止完整身体解剖、裸露内脏、血管、创口、排泄物或刺激性生理细节；
8. 宠物和人物保持正常骨骼、关节、四肢数量与物种结构；禁止脊柱扭转、关节错位、肢体折叠、身体异常拉长和畸变式压缩拉伸；
9. 生图与视频事件、包装和顺序相符，但故事板格数不机械等于真实切镜数；10秒为3至4镜，15秒为4至5镜；
10. 视频每镜都是动作命令，能在分配秒数内演完，镜头时间连续并覆盖完整目标时长；
11. 两个人类可见代码框均可脱离解释直接提交；机器JSON中的两个Prompt必须与相应代码框逐字一致；
12. 输出前从缩略图视角复核：一眼能读懂动作、表情、语义主包装与结论，不能像固定机位监控截图。`);

  const outputHeading = "# 固定输出格式";
  const outputIndex = prompt.indexOf(outputHeading);
  assert.ok(outputIndex > 0, "旧提示词没有固定输出格式章节");
  prompt = `${prompt.slice(0, outputIndex)}${outputHeading}
直接输出结果，不寒暄，不展示内部分析。每个原文段落严格依次输出：

**原文案内容段落 N**：逐字放入对应段落原文

**故事板分镜图文生图 Prompt（共X格）**：
\`\`\`text
只放可整体复制的故事板生图Prompt
\`\`\`

**图生视频 Prompt（目标T秒 / 实际Y镜）**：
\`\`\`text
只放可整体复制、一次提交的整合图生视频Prompt
\`\`\`

每个视频代码框最后逐字写入：\`声音与口型：角色不说话，不做说话式连续口型；只保留自然动作声和环境声；无对白、旁白、歌词、口播字幕和背景音乐。\`

所有段落的人类可见结果输出完后，再输出一个\`json\`机器包。机器包必须是合法JSON，字段名和枚举不得改写：
\`\`\`json
{
  "schema_version": "storyboard_director_output.v1",
  "artifact_type": "storyboard_director_package",
  "director_mode": "high_energy",
  "input": {
    "schema_version": "storyboard_director_input.v1",
    "segmented_script": "原始分段文案",
    "director_mode": "high_energy",
    "animation_style": "用户选择值",
    "aspect_ratio": "16:9",
    "target_duration_seconds": 10,
    "special_notes": "用户备注或空字符串"
  },
  "segments": [
    {
      "segment_id": "segment_001",
      "source_index": 1,
      "narration": "该段原文",
      "target_duration_seconds": 10,
      "estimated_narration_duration": 9.2,
      "panel_count": 5,
      "layout": "four_plus_panorama",
      "pacing_mode": "fast",
      "actual_shot_count": 4,
      "shot_time_ranges": [
        { "shot_id": "shot_01", "start_seconds": 0, "end_seconds": 2.4, "action_beat": "可见动作节拍" }
      ],
      "panoramic_anchor_role": "第5格承担的独立高潮或结论价值；四格时为null",
      "continuity_links": [
        { "from_shot": "shot_01", "to_shot": "shot_02", "link_type": "action_match", "description": "可见交接" }
      ],
      "character_assets": ["完整具体资产锁定"],
      "semantic_visualizations": [
        { "trigger": "原文语义触发", "visual_form": "画进故事板的包装形态", "interaction": "角色与包装的可见互动" }
      ],
      "storyboard_image_prompt": "与本段生图text代码框逐字一致",
      "image_to_video_prompt": "与本段视频text代码框逐字一致"
    }
  ]
}
\`\`\`

约束：10秒时\`target_duration_seconds=10\`且\`actual_shot_count\`只能为3或4；15秒时只能为15且\`actual_shot_count\`只能为4或5。\`shot_time_ranges\`数量必须等于真实镜头数，从0秒连续覆盖到目标时长；\`continuity_links\`数量等于真实镜头数减1。4格时\`layout=two_by_two\`且\`panoramic_anchor_role=null\`；5格时\`layout=four_plus_panorama\`，生图Prompt必须逐字包含英文版式句\`top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel\`。固定顺序永远是：原文、生图代码框、视频代码框；最后统一机器JSON。`;

  assert.match(prompt, /【旧版高能核心恢复 v6\.4】/);
  assert.match(prompt, /【10秒默认分支】/);
  assert.match(prompt, /【15秒隔离扩展分支】/);
  assert.match(prompt, /storyboard_director_output\.v1/);
  assert.match(prompt, /禁止完整身体解剖/);
  assert.match(prompt, /禁止脊柱扭转/);
  assert.doesNotMatch(prompt, /不输出JSON/);
  return prompt;
}

function refinePresetFields(fields: PresetField[] | undefined): PresetField[] {
  assert.ok(Array.isArray(fields) && fields.length > 0, "线上高能卡片缺少接收字段");
  return fields.map((field) => field.id === "target_duration_seconds"
    ? {
        ...field,
        options: ["10", "15"],
        defaultValue: "10",
        description: "默认10秒；15秒使用独立扩展分支，不改变10秒高能创作核心。",
        placeholder: "选择 10 或 15 秒",
      }
    : field);
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const current = payload.agents.find((item) => item.id === agentId);
  assert.ok(current?.system_prompt, "未找到线上高能导演");

  const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as { system_prompt?: string; prompt?: string };
  const legacyPrompt = legacy.system_prompt || legacy.prompt || "";
  const nextPrompt = buildPrompt(legacyPrompt);
  const nextFields = refinePresetFields(current.preset_fields);
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-default10-v6.4-${stamp}`;
  await mkdir(backupDir, { recursive: true });
  await writeFile(`${backupDir}/before-current.json`, JSON.stringify({
    id: current.id,
    name: current.name,
    system_prompt: current.system_prompt,
    preset_fields: current.preset_fields,
    prompt_sha256: sha256(current.system_prompt),
    updated_at: current.updated_at,
  }, null, 2), "utf8");
  await writeFile(`${backupDir}/legacy-core.json`, JSON.stringify({
    source: legacyPath,
    system_prompt: legacyPrompt,
    prompt_sha256: sha256(legacyPrompt),
  }, null, 2), "utf8");

  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, prompt: current.system_prompt, max_versions: 20 }),
  });
  await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
    method: "PUT",
    body: JSON.stringify({
      agentId,
      system_prompt: nextPrompt,
      preset_fields: nextFields,
    }),
  });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId, prompt: nextPrompt, max_versions: 20 }),
  });

  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === agentId);
  assert.ok(verified, "写入后没有找到高能导演");
  assert.equal(sha256(verified.system_prompt), sha256(nextPrompt), "线上提示词哈希与写入值不一致");
  const durationField = verified.preset_fields?.find((field) => field.id === "target_duration_seconds");
  assert.deepEqual(durationField?.options, ["10", "15"], "高能卡片时长选项没有收敛为10/15秒");
  assert.equal(durationField?.defaultValue, "10", "高能卡片默认时长不是10秒");

  await writeFile(`${backupDir}/after.json`, JSON.stringify({
    id: verified.id,
    name: verified.name,
    system_prompt: verified.system_prompt,
    preset_fields: verified.preset_fields,
    prompt_sha256: sha256(verified.system_prompt),
    prompt_chars: verified.system_prompt.length,
  }, null, 2), "utf8");
  console.log(JSON.stringify({
    passed: true,
    backupDir,
    legacyPromptChars: legacyPrompt.length,
    restoredPromptChars: nextPrompt.length,
    beforeSha256: sha256(current.system_prompt),
    legacySha256: sha256(legacyPrompt),
    afterSha256: sha256(nextPrompt),
    durationOptions: durationField?.options,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
