/**
 * 对标站公开下发的 Agent 工具卡原文（2026-09-09 登录会话捕获）。
 * 来源 GET /api/v1/agent/skills；证据文件：
 * 运行日志/代码落地-20260907/提示词捕获计划-20260909/登录态捕获-初批/agent_skills.json
 * 这些是角色契约级原文，不是完整系统提示词；本地模板保持独立实现，
 * 本模块仅提供对照参考与版本指纹（skill_hash），不参与任务编译。
 */
export type BenchmarkPromptReference={
  slug:string;name:string;description:string;whenToUse:string[];inputFields:string[];outputFields:string[];tools:string[];skillHash:string;
  capturedAt:string;endpoint:string;evidenceFile:string;
};
export const benchmarkAgentSkills:BenchmarkPromptReference[]=[
  {slug:'reference_material_analyzer',name:'Reference Material Analyzer',description:'以**擅长电商创意分析的多模态助手**身份，将用户本轮附带的参考图/音视频与文本约束，整理为第一步「分析 JSON」。字段与校验见 `PromptAnalysisPayload`，与 `reference_material_analysis` 中的任务说明一致，供后续候选提示词与脚本生成消费。',whenToUse:['用户上传了参考图、视频、音频，需要结构化理解（主体、卖点、人群、场景、各素材角色）','后续要生成视频/图片提示词或脚本，依赖「素材级」事实与推断','用户希望从画面反推受众、使用场景或可执行的创作线索'],inputFields:['user_requirement（本轮意图）','references（当前消息中的参考素材及 `@` 标签）','previous_tool_summaries（前序工具摘要）','conversation_summary（会话摘要）'],outputFields:['elements（数组：每项含 `id`、`type`（仅 `image` / `video` / `audio`）、`mention`（如 `@图片1`）、`desc`、`role`（如 主体参考/动作参考/场景参考/音色参考/其他）、`product_related`）','product（对象：`detected`、`name`、`category`、`features`、`selling_points`）','audience（字符串数组：由画面调性、人群线索推断的标签）','scenarios（字符串数组：具体使用场景）'],tools:['resolve_attached_reference_urls'],skillHash:'5fc0e96a2ec3757b8596306f64bf5fc2a38810c5a5e85bda84905f9539d7fcef',capturedAt:'2026-09-09T13:05:00Z',endpoint:'/api/commerce/v1/agent/skills',evidenceFile:'运行日志/代码落地-20260907/提示词捕获计划-20260909/登录态捕获-初批/agent_skills.json'},
  {slug:'reference_video_breakdown',name:'Reference Video Breakdown',description:'以短视频导演兼内容策略师身份，对**参考视频做帧级拉片拆解**，产出可「换产品复刻拍摄」的结构化报告。',whenToUse:['用户要拉片、拆解参考视频、爆款结构分析或逐秒/逐帧说明','附带了参考视频，希望复刻镜头、节奏、台词框架或剪辑逻辑','需要比素材略览更深的**拍摄语言级**说明（景别、运镜、布光、音效节点等）'],inputFields:['user_requirement（本轮关注点，如侧重的段落或产品替换假设）','references（当前消息中的参考素材；**以视频为主**）','previous_tool_summaries（前序工具摘要）','conversation_summary（会话摘要）'],outputFields:['视频总时长、整体风格关键词（3～5个）','核心情绪弧线：用一句话描述观众从开头到结尾的情绪变化','特别说明（如有的话）：比如语言（普通话、英语、方言）、口音（东北口、台湾口、港普）、方言（粤语、闽南语、四川话）等','动作描述请具体到身体部位，避免模糊词汇（❌"演员展示产品" ✅"右手拇指从左向右缓慢划过产品表面，镜头随手部移动轻微右移"）','道具与场景描述中，用 @图片n / @视频n / @音频n 标注所有与原产品相关的元素'],tools:[],skillHash:'332adc7183fdae393055e8de71568187ad72db089a4c0a1cbb08f0d862bae',capturedAt:'2026-09-09T13:05:00Z',endpoint:'/api/commerce/v1/agent/skills',evidenceFile:'运行日志/代码落地-20260907/提示词捕获计划-20260909/登录态捕获-初批/agent_skills.json'},
  {slug:'video_script_generator',name:'Video Script Generator',description:'以「专业视频脚本策划师」视角，根据用户需求、参考素材与人货场分析，产出可进编辑器的短视频脚本文案。输出形态与线上 `video_script_generation_prompts` 一致：单一 JSON 对象，正文落在 `content` 中（含总览、场景光线、逐秒镜头拆解），并与产品侧时长、画幅、内容类型/拍摄方式等约束一致。',whenToUse:['用户要短视频脚本、口播结构、分镜表或逐秒镜头说明','需要基于商品图、参考视频、音频等素材写可执行的拍摄级描述','用户进入视频工作区前，要一版可直接复制或再改的结构化脚本'],inputFields:['user_requirement（本轮创作意图与约束）','references（已解析的参考素材列表；标签用于正文引用）','previous_tool_summaries（前序工具产出摘要，如素材分析、爆款拆解）','conversation_summary（会话记忆摘要）'],outputFields:['summary（短摘要，便于会话与列表展示）','title（脚本标题）','content（唯一长正文：须包含「视频总览」「场景与光线」「逐秒镜头拆解列表」三段；镜号与结构化分镜只写在本字段的逐秒小节中；总字数约 1000、上限 1500；不要额外段落或文末总结）'],tools:['resolve_attached_reference_urls'],skillHash:'5311c19a271b11a15583916f50a73466f06ad386f47f4c84594f1d226a0bbc21',capturedAt:'2026-09-09T13:05:00Z',endpoint:'/api/commerce/v1/agent/skills',evidenceFile:'运行日志/代码落地-20260907/提示词捕获计划-20260909/登录态捕获-初批/agent_skills.json'},
];
/** 本地模板 → 对标原文卡。仅做对照参考，不改变本地模板编译。 */
export const benchmarkReferenceByTemplate:Record<string,string>={
  'prompt-assist.analyze':'reference_material_analyzer',
  'prompt-assist.breakdown':'reference_video_breakdown',
  'prompt-assist.script':'video_script_generator',
};
export function benchmarkReferenceFor(templateId:string):BenchmarkPromptReference|undefined{
  const slug=benchmarkReferenceByTemplate[templateId];
  return slug?benchmarkAgentSkills.find(s=>s.slug===slug):undefined;
}
