import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const url = process.env.COZE_SUPABASE_URL;
const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("缺少 COZE_SUPABASE_URL 或 service role 配置");

const client = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const targets = [
  { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张", mode: "high_energy" },
  { id: "agent-1786642714227-e1zid1", name: "故事版导演｜电影叙事", mode: "cinematic" },
  { id: "agent-1786642714448-m6iaou", name: "故事版导演｜抒情情感", mode: "lyrical" },
];

const safeColumns = [
  "id", "name", "description", "category", "source", "model", "model_id",
  "is_active", "user_access", "sort_order", "system_prompt", "preset_fields",
  "output_style", "response_format", "max_context_rounds", "max_context_tokens",
  "max_reply_tokens", "temperature", "timeout", "enable_web_search", "guide_message",
  "updated_at", "deleted_at",
].join(",");

const promptTail = `# 稳定输入协议 v6.2
优先读取稳定字段 segmented_script、animation_style、aspect_ratio、target_duration_seconds、special_notes。target_duration_seconds 只能为8、10或15，缺失时按10处理。兼容旧字段 storyboard_segmented_copy、storyboard_visual_style、storyboard_aspect_ratio、storyboard_character_setting、storyboard_special_requirements；旧角色设定与旧特殊要求合并为 special_notes。字段显示名称和排列顺序可以变化，字段 ID 的语义不变。

# 固定输出格式（稳定协议 v6.2）
不展示分析，不寒暄。严格保留原段落编号、边界、顺序和原字。每段先输出一个独立的标准 Markdown text 代码框“生图 Prompt”，再输出一个独立的标准 Markdown text 代码框“图生视频 Prompt”。两个代码框都必须能脱离解释直接复制提交。

整批段落前先输出一次“全局视觉资产计划”：只提出人物、宠物、场景和必要道具的资产角色、身份锁定项、允许变化项与参考图用途；人物/宠物使用角色参考板或转面表提示词，环境使用宽幅建立图提示词，道具使用多角度道具参考板提示词。没有用户已确认的真实资产时，只能标记为“待用户确认”，不得假装已经生成、保存、收费或绑定。

每段格式（顺序不可改变）：
**原文案内容段落 N**：逐字放入该段原文（可以放在标题同一行，不能改写）
**生图 Prompt（共4格或5格）**：第一个独立 text 代码框，只放可直接提交的完整故事板生图 Prompt；必须写清使用哪些已确认资产
**图生视频 Prompt（实际N个镜头）**：第二个独立 text 代码框，只放可直接提交的动作型视频 Prompt；只引用该段完整四宫格或五宫格故事板
生图 Prompt 与视频 Prompt 之后才可以补充导演注释、资产引用或质量说明；不得把说明插入两个代码框。

所有段落结束后，再输出一个标准 json 代码框作为机器包。平台不得按标题、代码框位置或顺序猜字段，只能读取以下稳定合同：
schema_version 固定为 storyboard_director_output.v1；artifact_type 固定为 storyboard_director_package；director_mode 固定为 {{DIRECTOR_MODE}}；input 固定包含 schema_version=storyboard_director_input.v1、segmented_script、animation_style、aspect_ratio、target_duration_seconds、special_notes；可选的 visual_asset_plan 固定包含 mode（off 或 selected）和 assets；每个资产固定包含 id、role（character/pet/environment/prop）、name、identity_lock、allowed_changes、reference_prompts；reference_prompts 固定包含 kind、purpose、prompt；如果已有账号资产，再附 source（kind、asset_id 及可选存储/模型字段）。segments 每项固定包含 segment_id、source_index、narration、target_duration_seconds、estimated_narration_duration、panel_count、layout、pacing_mode、actual_shot_count、shot_time_ranges、panoramic_anchor_role、continuity_links、character_assets、semantic_visualizations、storyboard_image_prompt、image_to_video_prompt；可选 visual_asset_refs 只能引用 visual_asset_plan 中已声明的语义 ID；shot_time_ranges 每项包含 shot_id、start_seconds、end_seconds、action_beat；continuity_links 每项包含 from_shot、to_shot、link_type、description；semantic_visualizations 每项包含 trigger、visual_form、interaction。

storyboard_image_prompt 与该段生图代码框逐字一致，image_to_video_prompt 与该段视频代码框逐字一致。segment_id 使用 segment_001、segment_002 的稳定形式。panel_count 只能为4或5；四格时 layout=two_by_two 且 panoramic_anchor_role=null；五格时 layout=four_plus_panorama，并填写第5格独立承担的高潮、结论、警示揭示、空间全貌或情绪收束职责。pacing_mode 只能为 slow、medium、fast；actual_shot_count 只能为1至5。

输出前检查：原文无损；具体角色资产完整；按约6字/秒估算口播，并加0.3至0.8秒自然停顿，写入 estimated_narration_duration。先提取不可合并的视觉节拍：8秒通常4格；10秒4或5格自适应；15秒通常5格，低信息或抒情仍可4格；只有确有独立高潮、结论、警示、空间全貌或情绪收束时才加第5格，永远不超过5格，语义超载时建议拆为下一生成单元。五格生图 Prompt 必须原样包含“top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel”，禁止上2下3等宽、五张独立图或错序拼贴。语义包装来自本句并先画入故事板；医学演示保持局部、友好、无不适。面板数与实际镜头数解耦：8秒高能2至3镜、电影2至3镜、抒情1至2镜；10秒高能3至4镜、电影2至3镜、抒情1至2镜；15秒高能4至5镜、电影3至4镜、抒情2至3镜。只有语义需要才取上限，不为凑数切镜。shot_time_ranges 连续覆盖完整目标时长；continuity_links 写清动作、视线、声音或空间如何衔接。视频 Prompt 用大白话写清实际镜头数、每镜起止秒、表演、运镜、物理反馈、声音边界和禁止项。任何一项不合格时内部重写后再输出。`;

const replacements = [
  ["- 4格用整齐2×2版式；5格用上方2×2四格加底部第5格横向全宽；比例严格使用用户选择的16:9或9:16；", "- 先提取不可合并的视觉节拍：语义只有四个有效节拍或第五格没有独立叙事价值时，用标准2×2四格；上方四格分别承担动作准备、触发、反应、转折，并改变景别、机位和动作阶段，不得只是监控视角换位；只有段落存在值得单独表现的高潮、结论、警示揭示、空间全貌或情绪收束时才使用5格，并明确写入“top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel”；禁止为了版式硬凑第五格、上2下3等宽、五张独立图或错序拼贴；比例严格使用用户选择的16:9或9:16；"],
  ["第一句只写必要读取协议：把完整故事板按Frame 1至Frame N作为连续时序，生成约10秒正常全屏视频；每格只作相应镜头的角色、构图和动作依据；锁定故事板现有角色、服装、宠物品种、场景、道具、材质、光影、综合色彩和已有包装；严格延续故事板的非写实电影级3D动画造型、眼睛比例、毛发与布料渲染，不得转成真人实拍或写实宠物摄影；成片不显示网格、分隔线、Frame编号、白色说明条或分屏。", "第一句只写必要读取协议：把完整故事板作为角色、构图、场景、道具、光影、包装和动作覆盖参考，生成用户选择的8、10或15秒正常全屏视频；故事板面板只是视觉素材与动作覆盖，不是切镜清单，不得按Frame逐格切换；先按目标时长、情绪、信息密度和动作强度选择slow、medium或fast，再决定实际镜头数；锁定故事板现有角色、服装、宠物品种、场景、道具、材质、光影、综合色彩和已有包装；严格延续故事板的非写实电影级3D动画造型，不得转成真人实拍或写实宠物摄影；成片不显示网格、分隔线、Frame编号、白色说明条或分屏。"],
  ["第一句只写必要读取协议：把完整故事板作为角色、构图、场景、道具、光影、包装和动作覆盖参考，生成约10秒正常全屏视频；故事板面板只是视觉素材与动作覆盖，不是切镜清单，不得按Frame逐格切换；先按情绪、信息密度和动作强度选择slow、medium或fast，再决定实际镜头数；锁定故事板现有角色、服装、宠物品种、场景、道具、材质、光影、综合色彩和已有包装；严格延续故事板的非写实电影级3D动画造型，不得转成真人实拍或写实宠物摄影；成片不显示网格、分隔线、Frame编号、白色说明条或分屏。", "第一句只写必要读取协议：把完整故事板作为角色、构图、场景、道具、光影、包装和动作覆盖参考，生成用户选择的8、10或15秒正常全屏视频；故事板面板只是视觉素材与动作覆盖，不是切镜清单，不得按Frame逐格切换；先按目标时长、情绪、信息密度和动作强度选择slow、medium或fast，再决定实际镜头数；锁定故事板现有角色、服装、宠物品种、场景、道具、材质、光影、综合色彩和已有包装；严格延续故事板的非写实电影级3D动画造型，不得转成真人实拍或写实宠物摄影；成片不显示网格、分隔线、Frame编号、白色说明条或分屏。"],
  ["随后每格一行，使用直白命令：", "随后按实际镜头数逐镜写，使用直白命令："],
  ["`Frame N（起止秒）：镜头怎样移动；主体从什么明确姿势开始，连续做什么；另一角色、道具和环境怎样发生可见反应；故事板已有包装怎样出现、运动或消失；用动作、视线、方向、道具或特效怎样交给下一格。`", "`镜头N（起止秒）：镜头怎样移动；主体从什么明确姿势开始，连续做什么；另一角色、道具和环境怎样发生可见反应；故事板已有包装怎样出现、运动或消失；用动作、视线、方向、道具或特效怎样完成镜内推进或交给下一镜头。`"],
  ["- 四格每格约2至2.5秒；五格每格约1.6至2.2秒，高潮可稍长；最后一格留出稳定落幅；", "- 镜头数按目标时长与导演模式自适应：8秒高能2至3个、电影2至3个、抒情1至2个；10秒高能3至4个、电影2至3个、抒情1至2个；15秒高能4至5个、电影3至4个、抒情2至3个；只在语义需要时取上限，靠镜内表演的准备、发力、反应、收势和顺滑运镜推进；第5格宽幅锚点可并入开场、转场或结尾，不强制单独切镜；"],
  ["- 10秒普通段落使用2至3个实际镜头；高能夸张通常2至4个、电影叙事2至3个、抒情情感1至2个；每镜约2.5至5秒，靠镜内表演的准备、发力、反应、收势和顺滑运镜推进；第5格宽幅锚点可并入开场、转场或结尾，不强制单独切镜；", "- 镜头数按目标时长与导演模式自适应：8秒高能2至3个、电影2至3个、抒情1至2个；10秒高能3至4个、电影2至3个、抒情1至2个；15秒高能4至5个、电影3至4个、抒情2至3个；只在语义需要时取上限，靠镜内表演的准备、发力、反应、收势和顺滑运镜推进；第5格宽幅锚点可并入开场、转场或结尾，不强制单独切镜；"],
  ["8. 生图与视频Frame数量、事件、包装和顺序一一对应；", "8. 生图面板提供连续空间、事件和包装素材，视频按语义合并调用，不要求面板数与实际镜头数相等；"],
  ["9. 视频每格都是动作命令，能在分配秒数内演完，总长度不超过3500字；", "9. 视频按实际镜头数写动作命令，明确每镜起止秒并在用户选择的8、10或15秒内演完，总长度不超过3500字；"],
  ["9. 视频按实际镜头数写动作命令，明确每镜时长并能在约10秒内演完，总长度不超过3500字；", "9. 视频按实际镜头数写动作命令，明确每镜起止秒并在用户选择的8、10或15秒内演完，总长度不超过3500字；"],
];

const presetFields = [
  { id: "segmented_script", label: "已分段口播文案", type: "textarea", placeholder: "例如：1.【第一段……】\n2.【第二段……】", required: true, options: [], order: 0, sendLabel: true, sendText: "segmented_script", description: "保留原段落编号、边界、顺序和字句，不重新拆段。" },
  { id: "animation_style", label: "3D动画风格", type: "select", placeholder: "选择全片统一的3D动画风格", required: true, options: ["高能商业3D动画喜剧（皮克斯式）", "童话电影3D动画（迪士尼式）", "欧美反差3D动画喜剧（梦工厂式）", "高饱和萌宠3D动画喜剧（照明娱乐式）", "温暖家庭3D动画电影", "电影级半写实3D动画", "手工黏土定格质感3D动画", "Q版玩具模型3D动画", "东方国潮3D动画电影", "未来科技霓虹3D动画"], order: 1, sendLabel: true, sendText: "animation_style" },
  { id: "aspect_ratio", label: "画面尺寸", type: "select", placeholder: "选择横屏或竖屏", required: true, options: ["16:9", "9:16"], order: 2, sendLabel: true, sendText: "aspect_ratio" },
  { id: "target_duration_seconds", label: "目标视频时长", type: "select", placeholder: "选择 8、10 或 15 秒", required: true, options: ["8", "10", "15"], order: 3, defaultValue: "10", sendLabel: true, sendText: "target_duration_seconds", description: "默认10秒；时长影响表演容量和镜头节奏，不机械决定镜头数。" },
  { id: "special_notes", label: "特殊备注", type: "textarea", placeholder: "选填：角色品种、毛色、年龄、服装、真实产品参考、禁用内容等。", required: false, options: [], order: 4, sendLabel: true, sendText: "special_notes", description: "仅在这里明确要求时绑定外部角色或产品参考资产。" },
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildPrompt(current, mode) {
  const anchor = current.indexOf("# 固定输出格式");
  if (anchor < 0) throw new Error("找不到唯一的固定输出格式锚点");
  let base = current.slice(0, anchor).trimEnd();
  for (const [from, to] of replacements) base = base.split(from).join(to);
  return `${base}\n\n${promptTail.replace("{{DIRECTOR_MODE}}", mode)}`;
}

function validateCore(row) {
  const required = ["# 全片资产锁定", "# 口播转故事的方法", "# 语义包装", "# 3D风格执行字典", "# 故事板生图Prompt写法", "# 图生视频Prompt写法"];
  for (const marker of required) if (!row.system_prompt?.includes(marker)) throw new Error(`${row.id} 缺少核心段落 ${marker}`);
}

async function cloudBackup(row) {
  const marker = "<!-- v6.2 前置备份/8-10-15秒适配前 -->\n";
  const { data, error } = await client.from("prompt_versions").select("id").eq("agent_id", row.id).like("prompt", `${marker}%`).limit(1);
  if (error) throw error;
  if (!data?.length) {
    const inserted = await client.from("prompt_versions").insert({ agent_id: row.id, prompt: marker + row.system_prompt });
    if (inserted.error) throw inserted.error;
  }
}

const { data: rows, error: readError } = await client.from("agents").select(safeColumns).in("id", targets.map((item) => item.id)).is("deleted_at", null);
if (readError) throw readError;
if (!rows || rows.length !== targets.length) throw new Error(`预检失败：应找到3张卡片，实际${rows?.length ?? 0}张`);

const ordered = targets.map((target) => {
  const row = rows.find((item) => item.id === target.id);
  if (!row || row.name !== target.name) throw new Error(`${target.id} 名称或数据不匹配`);
  validateCore(row);
  return { target, row };
});

const timestamp = new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
const backupDir = path.resolve(process.cwd(), "backups", `storyboard-directors-v6.2-activation-${timestamp}`);
fs.mkdirSync(path.join(backupDir, "agents"), { recursive: true });
for (const { row } of ordered) fs.writeFileSync(path.join(backupDir, "agents", `${row.id}.json`), JSON.stringify(row, null, 2), "utf8");
fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify({ schema_version: "storyboard_director_activation_backup.v1", created_at: new Date().toISOString(), agents: ordered.map(({ target, row }) => ({ id: row.id, name: row.name, mode: target.mode, prompt_sha256: sha256(row.system_prompt), preset_field_count: Array.isArray(row.preset_fields) ? row.preset_fields.length : 0 })) }, null, 2), "utf8");

for (const { row } of ordered) await cloudBackup(row);

const updated = [];
try {
  for (const { target, row } of ordered) {
    const systemPrompt = buildPrompt(row.system_prompt, target.mode);
    const payload = {
      system_prompt: systemPrompt,
      preset_fields: presetFields,
      output_style: { schema_version: "storyboard_director_output_style.v1", artifact_type: "storyboard_director_package", director_mode: target.mode, machine_schema: "storyboard_director_output.v1", human_format: "markdown_two_text_blocks_per_segment_plus_json", panel_layout: "adaptive_four_or_four_plus_panorama", target_durations: [8, 10, 15], shot_pacing: "duration_adaptive_semantic_one_to_five_shots" },
      response_format: "markdown",
      max_context_rounds: 1,
      max_context_tokens: 0,
      max_reply_tokens: 32768,
      guide_message: "粘贴已分段口播文案，选择3D动画风格、尺寸和8/10/15秒目标时长；每段将输出独立生图 Prompt、图生视频 Prompt 和稳定机器包。",
      updated_at: new Date().toISOString(),
    };
    const result = await client.from("agents").update(payload).eq("id", row.id).select("id,name,system_prompt,preset_fields,output_style,guide_message").single();
    if (result.error) throw result.error;
    updated.push(row);
    const versionMarker = "<!-- 故事版导演 v6.2 / 8-10-15秒适配 -->\n";
    const version = await client.from("prompt_versions").insert({ agent_id: row.id, prompt: versionMarker + systemPrompt });
    if (version.error) throw version.error;
  }
} catch (error) {
  for (const row of updated.reverse()) {
    await client.from("agents").update({ system_prompt: row.system_prompt, preset_fields: row.preset_fields, output_style: row.output_style, response_format: row.response_format, max_context_rounds: row.max_context_rounds, max_context_tokens: row.max_context_tokens, max_reply_tokens: row.max_reply_tokens, temperature: row.temperature, timeout: row.timeout, enable_web_search: row.enable_web_search, guide_message: row.guide_message, updated_at: row.updated_at }).eq("id", row.id);
  }
  throw error;
}

const { data: verified, error: verifyError } = await client.from("agents").select("id,name,system_prompt,preset_fields,output_style,guide_message").in("id", targets.map((item) => item.id));
if (verifyError) throw verifyError;
for (const target of targets) {
  const row = verified?.find((item) => item.id === target.id);
  const duration = row?.preset_fields?.find((field) => field.id === "target_duration_seconds");
  if (!row || duration?.defaultValue !== "10" || JSON.stringify(duration.options) !== JSON.stringify(["8", "10", "15"])) throw new Error(`${target.name} 时长字段验收失败`);
  if (!row.system_prompt.includes("# 稳定输入协议 v6.2") || !row.system_prompt.includes(`director_mode 固定为 ${target.mode}`)) throw new Error(`${target.name} v6.2 提示词验收失败`);
  if (row.output_style?.director_mode !== target.mode || row.output_style?.target_durations?.join(",") !== "8,10,15") throw new Error(`${target.name} 输出协议验收失败`);
}

console.log(JSON.stringify({ success: true, backup_dir: backupDir, agents: verified.map((row) => ({ id: row.id, name: row.name, preset_fields: row.preset_fields.length, duration_options: row.preset_fields.find((field) => field.id === "target_duration_seconds")?.options, prompt_sha256: sha256(row.system_prompt) })) }, null, 2));
