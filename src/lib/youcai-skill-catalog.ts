export type YoucaiSkillSource = "official" | "community";

export type YoucaiSkillCategory =
  | "writing"
  | "image"
  | "video"
  | "audio-music"
  | "film"
  | "commercial"
  | "productivity";

export interface YoucaiSkillDefinition {
  id: string;
  source: YoucaiSkillSource;
  title: string;
  commandName: string;
  category: YoucaiSkillCategory;
  categoryLabel: string;
  tags: readonly string[];
  version: string;
  author: string;
  priceCredits: number;
  installedByDefault: boolean;
  agentAutoInvokeEnabled: boolean;
  summary: string;
  contract: string;
  triggerTerms: readonly string[];
}

const CATEGORY_LABELS: Record<YoucaiSkillCategory, string> = {
  writing: "文本写作",
  image: "图片设计",
  video: "视频创作",
  "audio-music": "音频音乐",
  film: "影视制作",
  commercial: "商业营销",
  productivity: "效率工具",
};

type SkillSeed = Omit<YoucaiSkillDefinition, "categoryLabel" | "priceCredits">;

function defineSkill(seed: SkillSeed): YoucaiSkillDefinition {
  return {
    ...seed,
    categoryLabel: CATEGORY_LABELS[seed.category],
    priceCredits: 0,
  };
}

export const YOUCAI_SKILL_CATALOG: readonly YoucaiSkillDefinition[] = [
  defineSkill({
    id: "official:skill-creator", source: "official", title: "Skill 创建专家", commandName: "skill-creator",
    category: "productivity", tags: ["创作工作流"], version: "1.5.1", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "把个人方法、工作流或第三方说明整理成可调用的创作 Skill。",
    contract: "先确认用途、触发条件、输入、输出与限制，再交付平台兼容的 Skill 结构；普通创作任务不使用。",
    triggerTerms: ["创建skill", "制作skill", "导入skill", "适配skill", "修改skill", "技能创建"],
  }),
  defineSkill({
    id: "official:ad-script-master", source: "official", title: "商业广告脚本", commandName: "ad-script-master",
    category: "commercial", tags: ["广告营销", "剧本创作", "视频生成"], version: "2.3.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "从商业目标、受众与卖点证据出发，形成可拍摄、可投放的广告方案。",
    contract: "输出受众洞察、核心创意、文案、时长结构、镜头清单、CTA 与合规检查；定稿脚本转模型提示词应交给视频类 Skill。",
    triggerTerms: ["广告脚本", "品牌片", "产品宣传片", "信息流广告", "带货视频", "商业广告", "投放脚本"],
  }),
  defineSkill({
    id: "official:drama-shot-prompt", source: "official", title: "影视分镜提示词", commandName: "drama-shot-prompt",
    category: "film", tags: ["短剧漫剧", "分镜设计", "镜头语言"], version: "5.1.1", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "把剧本和角色、场景、道具资产编排成镜头级分镜。",
    contract: "保持完整剧情与资产连续性，输出镜头编号、景别、机位、动作、表演、声音与生成提示词；只输出分镜文本，不冒充已生成视频。",
    triggerTerms: ["分镜", "镜头拆分", "镜头编排", "故事板", "shot", "优化镜头提示词"],
  }),
  defineSkill({
    id: "official:film-asset-design", source: "official", title: "影视资产设计", commandName: "film-asset-design",
    category: "film", tags: ["角色设计", "场景设计", "图片生成"], version: "1.0.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "为角色、服装、道具和场景建立可持续复用的视觉资产方案。",
    contract: "提取并锁定视觉特征，按角色三视图、表情姿态、道具多角度、场景空间与时天气变体组织可执行图片提示词。",
    triggerTerms: ["角色三视图", "人物设定图", "角色卡", "表情九宫格", "道具设定", "场景概念图", "影视资产"],
  }),
  defineSkill({
    id: "official:drama-script", source: "official", title: "爽剧剧本创作", commandName: "drama-script",
    category: "film", tags: ["短剧漫剧", "剧本创作"], version: "2.4.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "面向快节奏、强冲突和高爽点的短剧剧本创作。",
    contract: "围绕钩子、冲突升级、反转、爽点兑现和集尾悬念组织摘要、场次与完整对白；非爽剧题材交给通用剧本。",
    triggerTerms: ["爽剧", "爽文短剧", "霸总短剧", "赘婿", "重生复仇", "逆袭短剧"],
  }),
  defineSkill({
    id: "official:video-prompt", source: "official", title: "视频提示词创作", commandName: "video-prompt",
    category: "video", tags: ["提示词", "视频生成", "镜头语言"], version: "5.8", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "把纯文本创意编译为通用视频模型可执行的完整提示词。",
    contract: "补齐主体、场景、表演、运镜、节奏、时长、声音和连续性；参考素材分析由多模态或专用 Skill 负责。",
    triggerTerms: ["视频提示词", "视频prompt", "文生视频提示词", "运镜提示词", "镜头提示词"],
  }),
  defineSkill({
    id: "official:h3-prompt-writing", source: "official", title: "MiniMax H3 提示词", commandName: "h3-prompt-writing",
    category: "video", tags: ["提示词", "视频生成", "MiniMax H3"], version: "1.0.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "为 MiniMax H3 的文本、图片、首尾帧与多参考模式组织提示词。",
    contract: "按 H3 模式整理综合多模态描述、整体声景、非叙事音乐、关键帧约束和参考素材标签，不混用其他模型协议。",
    triggerTerms: ["minimax h3", "h3提示词", "h3视频", "t2va", "i2va", "ref2va"],
  }),
  defineSkill({
    id: "official:seedance-20", source: "official", title: "Seedance 2.0 专业制作", commandName: "seedance-20",
    category: "video", tags: ["提示词", "视频生成", "Seedance", "创作工作流"], version: "6.7.1", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "Seedance 2.0 的完整制作规划、提示词工程与成片故障排查。",
    contract: "覆盖多镜头、参考素材、首尾帧、连续性、动作、运镜、灯光、音频与安全边界；简单最终提示词优先使用 sd2-pe。",
    triggerTerms: ["seedance 2.0专业", "seedance工作流", "seedance故障", "seedance成片", "seedance多镜头"],
  }),
  defineSkill({
    id: "official:sd2-pe", source: "official", title: "Seedance 2.0 提示词优化", commandName: "sd2-pe",
    category: "video", tags: ["提示词", "视频生成", "Seedance"], version: "1.0.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "把文生视频、多参考、首尾帧、编辑或延长需求编译成 Seedance 2.0 Prompt。",
    contract: "输出可直接提交的 Seedance 2.0 提示词文本，并明确引用关系、动作时间线和硬约束；不宣称已经生成视频。",
    triggerTerms: ["seedance 2.0提示词", "即梦2.0提示词", "sd2提示词", "seedance多参考"],
  }),
  defineSkill({
    id: "official:sd25-pe", source: "official", title: "Seedance 2.5 提示词优化", commandName: "sd25-pe",
    category: "video", tags: ["提示词", "视频生成", "Seedance"], version: "1.0.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "为 Seedance 2.5 的多参考、关键帧、故事板、编辑与延长模式优化提示词。",
    contract: "只输出 Seedance 2.5 文本方案；当前执行层不支持 2.5 时必须明确说明，禁止静默改用 2.0。",
    triggerTerms: ["seedance 2.5", "即梦2.5", "sd25", "2.5提示词"],
  }),
  defineSkill({
    id: "official:poster-design", source: "official", title: "专业海报设计", commandName: "poster-design",
    category: "image", tags: ["提示词", "图片生成", "广告营销"], version: "1.1.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "把主题、品牌、受众和准确文案转化为专业海报或封面方案。",
    contract: "输出视觉概念、信息层级、版式、比例、品牌约束和最终图片提示词；必须逐字保留用户指定文案。",
    triggerTerms: ["海报设计", "封面设计", "活动主视觉", "banner", "公众号头图", "专辑封面"],
  }),
  defineSkill({
    id: "official:script-rewrite", source: "official", title: "剧本优化改写", commandName: "script-rewrite",
    category: "writing", tags: ["剧本创作", "优化改写"], version: "1.2.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "把外部剧本整理为平台标准格式，并修复场景、人物和对白标注。",
    contract: "默认只修格式不改变故事内容；若用户要求内容改写，先明确范围并保留人物、事实与已确认情节。",
    triggerTerms: ["剧本格式", "剧本标准化", "修复对白格式", "整理剧本", "上传剧本"],
  }),
  defineSkill({
    id: "official:script-brief", source: "official", title: "剧本创作简报", commandName: "script-brief",
    category: "writing", tags: ["剧本创作", "创作工作流"], version: "1.0.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "把一句话故事想法扩展为可执行的专业剧本需求简报。",
    contract: "补齐题材、风格、集数、受众、角色、冲突、剧情走向、卖点和禁区，作为后续剧本 Skill 的输入。",
    triggerTerms: ["剧本简报", "不知道怎么写剧本需求", "故事想法扩写", "剧本需求", "创作大纲"],
  }),
  defineSkill({
    id: "official:image-prompt", source: "official", title: "图片提示词创作", commandName: "image-prompt",
    category: "image", tags: ["提示词", "图片生成"], version: "3.3.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "面向主流图片模型生成、优化、改写或反推图片提示词。",
    contract: "按主体、动作、环境、构图、光线、材质、风格、比例和负面约束输出；根据目标模型调整语法，不冒充已经出图。",
    triggerTerms: ["图片提示词", "生图提示词", "绘画prompt", "反推提示词", "优化图片prompt"],
  }),
  defineSkill({
    id: "official:platform-help", source: "official", title: "平台使用帮助", commandName: "platform-help",
    category: "productivity", tags: ["创作工作流"], version: "4.0.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "解释有彩视界的功能、Skill、创作路径、积分授权与常见操作。",
    contract: "只基于平台已确认能力回答，优先给出明确页面路径和操作步骤；不能确认的运行状态必须标注，不编造功能、价格或会员权益。",
    triggerTerms: ["有彩视界怎么用", "平台怎么用", "skill怎么安装", "怎么绑定微信", "积分授权", "功能在哪里", "推荐哪个工具"],
  }),
  defineSkill({
    id: "official:social-content-optimizer", source: "official", title: "社媒内容优化", commandName: "social-content-optimizer",
    category: "commercial", tags: ["社媒运营", "广告营销", "优化改写"], version: "1.0.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "为小红书、抖音、公众号、微博等平台创作和优化发布文案。",
    contract: "按平台机制处理标题、开头钩子、正文结构、互动、标签和发布建议；不承担图片或视频模型提示词。",
    triggerTerms: ["小红书文案", "抖音文案", "社媒文案", "提高曝光", "涨粉文案", "公众号文案"],
  }),
  defineSkill({
    id: "official:video-deconstruct-analyzer", source: "official", title: "视频拉片分析", commandName: "video-deconstruct-analyzer",
    category: "film", tags: ["视频拆解", "镜头语言", "优化改写"], version: "1.0.1", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "基于实际视频或关键帧做逐镜拉片、视听语言分析和复刻简报。",
    contract: "只分析用户实际提供的素材，输出镜头、表演、节奏、声音、画面风格和可迁移语法；没有素材时先索取，不虚构拉片结果。",
    triggerTerms: ["视频拉片", "逐镜拉片", "逐镜分析", "拆解这个视频", "镜头复刻", "视听语言分析", "反推视频"],
  }),
  defineSkill({
    id: "official:general-script", source: "official", title: "通用剧本创作", commandName: "general-script",
    category: "writing", tags: ["剧本创作"], version: "2.3.1", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "覆盖童话、教育、情感、传统影视、原创、改编与续写的通用剧本。",
    contract: "按创作类型、受众、基调、素材、集数和续写状态输出标准剧本；强爽点短剧应交给爽剧剧本 Skill。",
    triggerTerms: ["童话剧本", "小说改编", "通用剧本", "教育剧本", "情感剧本", "续写剧本"],
  }),
  defineSkill({
    id: "official:music-prompt", source: "official", title: "音乐提示词创作", commandName: "music-prompt",
    category: "audio-music", tags: ["提示词", "歌曲音乐"], version: "1.0.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "创作歌词、曲风、旋律气质、配器、结构和音乐模型提示词。",
    contract: "按用途、情绪曲线、速度、调性、配器、声线、段落结构与制作要求输出；旁白、对白和音效交给音频提示词。",
    triggerTerms: ["音乐提示词", "写歌词", "创作歌曲", "bgm提示词", "配乐方案", "编曲提示词"],
  }),
  defineSkill({
    id: "official:audio-prompt", source: "official", title: "音频提示词创作", commandName: "audio-prompt",
    category: "audio-music", tags: ["提示词", "配音旁白"], version: "2.6.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "为旁白、配音、对白、环境声和综合音频生成整理可执行输入。",
    contract: "输出最终朗读文本、角色声线、表演、停顿、时间轴、音效、环境音与多语种要求；独立歌曲交给音乐 Skill。",
    triggerTerms: ["音频提示词", "配音提示词", "旁白生成", "多角色对白", "环境音", "声音设计"],
  }),
  defineSkill({
    id: "official:skill-assistant", source: "official", title: "默认 Skill 调度助手", commandName: "skill-assistant",
    category: "productivity", tags: ["创作工作流"], version: "3.0.0", author: "有彩视界",
    installedByDefault: true, agentAutoInvokeEnabled: true,
    summary: "在需求未明确命中其他专业 Skill 时判断最合适的创作方法。",
    contract: "先根据能力目录推荐专业 Skill；确认没有更合适的能力后，才使用通用创作方法直接回答。",
    triggerTerms: ["不知道用哪个skill", "选择技能", "技能推荐", "需求不明确", "怎么开始创作"],
  }),
  defineSkill({
    id: "community:ip-toy-grid-motion", source: "community", title: "IP潮玩六宫格动态海报", commandName: "ip-toy-grid-motion",
    category: "video", tags: ["角色设计", "提示词", "图片生成", "视频生成", "创作工作流"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "把 IP 角色或吉祥物参考图转为不规则六宫格潮玩海报及竖版动态方案。",
    contract: "保持角色身份与六宫格布局稳定，输出静态海报提示词、分层动效提示词和交付检查；没有角色参考图时先索取，不直接生成付费媒体。",
    triggerTerms: ["ip六宫格", "潮玩六宫格", "六宫格动态海报", "吉祥物动态海报"],
  }),
  defineSkill({
    id: "community:poster-motion-planner", source: "community", title: "动态海报分镜策划", commandName: "poster-motion-planner",
    category: "video", tags: ["视频生成", "分镜设计", "提示词", "镜头语言", "场景设计"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "分析静态海报构图与文字层级，生成一镜到底的动态海报分镜和提示词。",
    contract: "只分析用户实际上传的海报，输出构图诊断、动效方向、时间轴、运镜和可交接视频提示词；不冒充已生成视频。",
    triggerTerms: ["动态海报分镜", "海报动起来", "海报动效策划", "一镜到底海报"],
  }),
  defineSkill({
    id: "community:dot-matrix-brand-wordmark-motion", source: "community", title: "点阵品牌字标动效", commandName: "dot-matrix-brand-wordmark-motion",
    category: "film", tags: ["视频生成", "提示词", "镜头语言", "创作工作流"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "把品牌 Logo、字标或标语素材整理成横版落版图与 8 秒点阵品牌动效提示词。",
    contract: "先确认原始字标与精确文案，再输出落版构图、点阵转换时间轴和最终视频提示词；不从零设计商标，不直接生成视频。",
    triggerTerms: ["点阵字标", "品牌字标动效", "logo点阵动效", "8秒品牌落版"],
  }),
  defineSkill({
    id: "community:fpv-tour-video-generator", source: "community", title: "场景优先 FPV 穿越视频策划", commandName: "fpv-tour-video-generator",
    category: "video", tags: ["视频生成", "提示词", "镜头语言", "场景设计", "创作工作流"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "将角色与场景参考转化为场景主导、连续一镜到底的 FPV 穿越视频方案。",
    contract: "输出穿越路径、空间节点、镜头速度、避障与连续性约束及最终提示词；真实视频只能交由受控工具并需用户授权。",
    triggerTerms: ["fpv穿越", "一镜到底穿越", "场景穿越视频", "空间漫游"],
  }),
  defineSkill({
    id: "community:storyboard", source: "community", title: "N宫格分镜故事板", commandName: "storyboard",
    category: "film", tags: ["分镜设计", "剧本创作", "镜头语言", "场景设计", "图片生成"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "将故事描述或剧本拆解为逐镜分镜表和多宫格故事板提案。",
    contract: "输出逐镜表、宫格布局、角色与场景连续性、每格图像提示词和可选图像工具提案；未授权时不直接生图。",
    triggerTerms: ["n宫格分镜", "多宫格故事板", "分镜故事板", "画故事板"],
  }),
  defineSkill({
    id: "community:film-reference-prompt-writer", source: "community", title: "电影视觉参考提示词大师", commandName: "film-reference-prompt-writer",
    category: "film", tags: ["提示词", "视频拆解", "镜头语言", "图片生成", "视频生成"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "分析电影片名、剧照或截图的色彩、灯光、构图和镜头语言，转译为图像或视频提示词。",
    contract: "对用户实际提供的电影参考做可见证据分析，输出视觉语法、可迁移约束与生图/视频提示词；没有可用素材时不虚构拉片结果。",
    triggerTerms: ["电影质感提示词", "剧照反推", "电影视觉参考", "电影镜头语法"],
  }),
  defineSkill({
    id: "community:voiceover-direction", source: "community", title: "口播与配音导演", commandName: "voiceover-direction",
    category: "audio-music", tags: ["配音旁白", "表演指导", "剧本创作", "优化改写"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "优化旁白、广告、课程和角色台词的可说性与表演节奏。",
    contract: "给出停顿、重音、气口、情绪动作、录制和补录建议，保持原文事实与角色设定。",
    triggerTerms: ["口播导演", "配音导演", "停顿重音", "台词表演", "补录建议"],
  }),
  defineSkill({
    id: "community:transcript-broll-planner", source: "community", title: "口播 B-roll 镜头规划", commandName: "transcript-broll-planner",
    category: "film", tags: ["剧本创作", "分镜设计", "提示词", "镜头语言", "视频生成"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "将口播、采访或课程文稿拆成 A-roll/B-roll 搭配和逐段画面表。",
    contract: "围绕信息锚点、剪辑节奏、证据画面和转场输出可执行 B-roll 规划，不添加无法证明的素材。",
    triggerTerms: ["b-roll", "broll", "口播镜头规划", "补画面", "a-roll"],
  }),
  defineSkill({
    id: "community:multi-platform-image-prompts", source: "community", title: "多平台 AI 绘画提示词工坊", commandName: "multi-platform-image-prompts",
    category: "image", tags: ["提示词", "图片生成", "优化改写", "创作工作流"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "把灵感或参考描述转换成多种绘画平台的提示词变体。",
    contract: "分别给出平台适配语法、负面提示词、构图变体和保真约束，不混淆不同模型特性。",
    triggerTerms: ["多平台绘画", "midjourney和sd", "flux提示词", "绘画平台适配"],
  }),
  defineSkill({
    id: "community:paper-art-explainer", source: "community", title: "纸艺科普视频策划", commandName: "paper-art-explainer",
    category: "film", tags: ["分镜设计", "场景设计", "视频生成", "创作工作流", "提示词"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "把知识或故事转成纸张拼贴、纸艺定格风格的视频方案。",
    contract: "通过纸张材质、层级、手工运动、隐喻、分镜、声音和审核交接形成完整制作规划。",
    triggerTerms: ["纸艺视频", "纸张定格", "纸艺科普", "拼贴动画"],
  }),
  defineSkill({
    id: "community:outdoor-ad-prompt", source: "community", title: "户外广告视觉提示词", commandName: "outdoor-ad-prompt",
    category: "commercial", tags: ["广告营销", "提示词", "图片生成", "场景设计", "创作工作流"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "为广告牌、大屏和户外场景生成兼顾空间与文案层级的视觉提示词。",
    contract: "准确处理媒介尺寸、观看距离、真实空间融合、光线、品牌信息和文案可读性。",
    triggerTerms: ["户外广告", "广告牌效果图", "大屏广告", "楼宇广告"],
  }),
  defineSkill({
    id: "community:minimalist-product-ad", source: "community", title: "极简高端产品广告方案", commandName: "minimalist-product-ad",
    category: "commercial", tags: ["广告营销", "电商视觉", "剧本创作", "分镜设计", "视频生成"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "为新品和消费品规划极简高级的广告创意、锚定图和视频节拍。",
    contract: "先梳理产品事实，再输出核心概念、精炼文案、画面锚点、分镜、视频提示词和音乐方向。",
    triggerTerms: ["极简产品广告", "高端产品片", "新品广告", "数码产品广告"],
  }),
  defineSkill({
    id: "community:micro-expression-video-prompt", source: "community", title: "人物微表情视频提示词", commandName: "micro-expression-video-prompt",
    category: "video", tags: ["视频生成", "表演指导", "提示词", "角色设计", "镜头语言"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "设计人物眼神、呼吸、微表情和克制肢体动作的情绪递进。",
    contract: "保持原剧情、角色与镜头不变，只增强可见且连续的细腻表演和关系变化。",
    triggerTerms: ["微表情", "眼神表演", "人物细腻表演", "呼吸动作"],
  }),
  defineSkill({
    id: "community:handdrawn-live-video-prompt", source: "community", title: "手绘实体融入实拍视频提示词", commandName: "handdrawn-live-video-prompt",
    category: "video", tags: ["视频生成", "提示词", "场景设计", "MiniMax H3"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "为真实空间中的手绘发光实体设计连续形变、互动和空间改造。",
    contract: "建立手绘材质、光影反馈、物理接触、变形时间线和镜头连续性，避免实体漂移或突然换形。",
    triggerTerms: ["手绘融入实拍", "蜡笔实体", "粉笔动画", "手绘发光实体"],
  }),
  defineSkill({
    id: "community:ecommerce-image", source: "community", title: "电商商品视觉策划", commandName: "ecommerce-image",
    category: "commercial", tags: ["电商视觉", "图片生成", "提示词", "创作工作流"], version: "1", author: "雪风",
    installedByDefault: false, agentAutoInvokeEnabled: false,
    summary: "基于真实商品素材规划主图、详情图、场景图和成套电商视觉。",
    contract: "锁定商品结构、材质、颜色和品牌细节，规划图片序列与提示词，禁止擅自改变商品外观。",
    triggerTerms: ["电商主图", "商品详情图", "电商视觉", "产品场景图"],
  }),
] as const;

export const YOUCAI_SKILL_CATEGORIES = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({
  value: value as YoucaiSkillCategory,
  label,
}));

export const YOUCAI_SKILL_TAGS = Array.from(
  new Set(YOUCAI_SKILL_CATALOG.flatMap((skill) => skill.tags)),
);

export function findYoucaiSkillByCommand(commandName: string): YoucaiSkillDefinition | undefined {
  const normalized = commandName.trim().replace(/^\//u, "").toLowerCase();
  return YOUCAI_SKILL_CATALOG.find((skill) => skill.commandName.toLowerCase() === normalized);
}

export function parseYoucaiSkillInvocation(input: string): {
  skill?: YoucaiSkillDefinition;
  request: string;
  explicit: boolean;
} {
  const normalized = input.trim();
  const match = /^\/([a-z\d-]+)(?:\s+([\s\S]*))?$/iu.exec(normalized);
  if (!match) return { request: normalized, explicit: false };
  return {
    skill: findYoucaiSkillByCommand(match[1]),
    request: (match[2] || "").trim(),
    explicit: true,
  };
}

export function inferYoucaiSkill(input: string): YoucaiSkillDefinition | undefined {
  const explicit = parseYoucaiSkillInvocation(input);
  if (explicit.explicit) return explicit.skill;
  const normalized = input.toLowerCase().replace(/\s+/gu, " ");
  let best: { skill: YoucaiSkillDefinition; score: number } | undefined;
  for (const skill of YOUCAI_SKILL_CATALOG) {
    if (!skill.agentAutoInvokeEnabled) continue;
    const score = skill.triggerTerms.reduce((total, term) => (
      normalized.includes(term.toLowerCase()) ? total + Math.max(2, term.length) : total
    ), 0);
    if (score > 0 && (!best || score > best.score)) best = { skill, score };
  }
  return best?.skill;
}

export function buildYoucaiSkillDirectory(): string {
  return YOUCAI_SKILL_CATALOG
    .filter((skill) => skill.source === "official")
    .map((skill) => `/${skill.commandName}｜${skill.title}｜${skill.contract}`)
    .join("\n");
}
