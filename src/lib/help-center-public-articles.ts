import type { HelpArticle, HelpArticleType, HelpCategoryId, HelpFailure, HelpStep } from "./help-center-domain";

const PUBLISHED_AT = "2026-08-22T08:00:00+08:00";

interface PublicArticleInput {
  id: string;
  slug: string;
  categoryId: HelpCategoryId;
  articleType?: HelpArticleType;
  title: string;
  summary: string;
  keywords: string[];
  body: string;
  applicability: string;
  preparation: string[];
  steps: HelpStep[];
  costAndWait: string;
  successCriteria: string[];
  failures: HelpFailure[];
  returnPath: string;
  returnLabel: string;
  sortOrder: number;
  readMinutes: number;
  recommended?: boolean;
}

function publicArticle(input: PublicArticleInput): HelpArticle {
  return {
    ...input,
    articleType: input.articleType ?? "guide",
    notes: "本页是自媒体操盘手主站根据自身功能重新编写的原创说明，不复制对标网站文章正文。模型能力、价格、权益和可用状态均以主站当前界面与真实任务记录为准。",
    status: "published",
    pinned: false,
    recommended: input.recommended ?? true,
    visibility: "public",
    publishedAt: PUBLISHED_AT,
    updatedAt: PUBLISHED_AT,
    mediaIds: [],
    coverMediaId: null,
  };
}

const SEEDANCE_66_DIRECTIONS = [
  "文生视频：雨夜便利店、清晨菜场、海边露营、宠物诊所、旧书店、天台花园、地下车库、厨房早餐、山谷徒步、未来实验室、古城灯会。",
  "首帧图生视频：角色回头、推门入场、拾起道具、奔跑急停、窗边起身、产品旋转、液体飞溅、花朵绽放、纸艺展开、机械组装、天气转场。",
  "多图参考：统一人物、服装延续、产品多角度、场景接续、道具锁定、宠物一致、车辆外观、建筑结构、包装色板、光线迁移、动作姿态。",
  "局部编辑：移除路人、更换天空、修正手部、替换道具、改变服装颜色、清理文字、调整灯光、扩展景别、改变季节、重排主体、补全遮挡。",
  "视频补全：向前补开场、向后补结尾、延长停留、补因果动作、补反应镜头、补环境建立、补产品特写、补转场、补空镜、补字幕安全区、补声音收束。",
  "声音与叙事：无对白口播、画外旁白、环境声主导、动作音效、音乐卡点、静音反差、双人对话、宠物无口型、广告旁白、知识讲解、情绪递进。",
] as const;

/**
 * 对标站公开文章路径的本地主站原创替代内容。
 * 它们只在公共帮助目录中合并，不写入管理员可编辑的持久化目录，
 * 因而不会覆盖用户已经维护的帮助文章，也不受旧目录快照缺少新 slug 的影响。
 */
export const REQUIRED_PUBLIC_ARTICLES: readonly HelpArticle[] = [
  publicArticle({
    id: "article-public-changelog",
    slug: "changelog",
    categoryId: "guides",
    articleType: "guide",
    title: "自媒体操盘手 · 更新日志",
    summary: "按版本记录主站已经交付的功能、兼容变化、修复范围与仍待验证的边界。",
    keywords: ["更新日志", "版本", "新增", "修复", "兼容", "迁移"],
    body: "更新日志只记录已经进入当前主站代码并通过对应验收的变化。界面存在、源码存在和真实生成成功是三种不同证据，日志会分别说明，避免把计划功能写成已上线。\n\n每条记录应包含日期、影响页面、用户可见变化、是否需要迁移，以及验证方式。涉及模型生成时，还应区分公共只读验收、登录态调用和真实付费任务。",
    applicability: "想确认最近一次本地拉取包含哪些变化、升级是否影响旧项目，或排查某个入口从哪个版本开始出现。",
    preparation: ["确认当前部署的构建时间或版本标识", "保留升级前的数据库与环境配置备份", "区分源码更新和外部模型服务状态"],
    steps: [
      { title: "先按日期定位版本", body: "从最新记录向前查找，确认当前部署是否已经包含目标变更。" },
      { title: "阅读影响范围", body: "核对涉及的页面、接口、数据字段和权限，不把相邻模块的变化推断为本功能变化。" },
      { title: "检查迁移要求", body: "如记录包含配置、数据库或素材迁移，先在备份环境验证再更新生产环境。" },
      { title: "按证据复验", body: "页面修复做浏览器验收，接口修复检查状态码，模型能力用经授权的真实任务单独验证。" },
    ],
    costAndWait: "阅读日志和执行只读检查不产生模型费用。真实生成、批量回归或外部服务测试可能产生费用，必须以提交前页面提示和当前授权为准。",
    successCriteria: ["能定位当前部署对应的版本记录", "影响范围与实际页面、接口一致", "需要迁移的步骤有备份和回滚方案"],
    failures: [
      { problem: "代码已更新但页面仍是旧版", action: "检查是否完成重新构建、进程重启和浏览器缓存刷新，不要重复覆盖源码。" },
      { problem: "日志写着可用但模型调用失败", action: "继续核对账号权限、模型配置和供应方状态；界面交付不等于外部调用已通过。" },
    ],
    returnPath: "/articles",
    returnLabel: "返回帮助中心",
    sortOrder: 5,
    readMinutes: 4,
  }),
  publicArticle({
    id: "article-public-credits-faq",
    slug: "credits-faq",
    categoryId: "faq",
    articleType: "faq",
    title: "自媒体操盘手积分功能常见问答",
    summary: "解释积分余额、预计费用、实际消费、失败核对和充值权益之间的关系。",
    keywords: ["积分", "余额", "充值", "扣费", "消费记录", "失败"],
    body: "积分是主站内调用部分 AI 能力时使用的计量单位，不等同于现金余额。不同模型、分辨率、时长和输出数量可能采用不同计费规则，提交前应以当前操作按钮附近的预计费用为准。\n\n实际消费必须以任务与账务记录为证据。任务失败时先确认是否创建了供应方任务、是否产生消费记录，再决定查询、申诉或重新生成；不能仅凭页面提示猜测退款。",
    applicability: "准备充值、提交付费任务，或遇到余额变化、任务失败、重复点击和消费记录无法对应时。",
    preparation: ["记录提交前余额与页面预计费用", "保存任务号、时间、公开模型名和输出数量", "确认登录账号与产生任务的账号一致"],
    steps: [
      { title: "提交前确认", body: "检查模型、数量、画幅、时长和预计费用，批量任务要按总数量重新核算。" },
      { title: "提交后保留任务", body: "进入排队后不要重复点击；刷新应继续查询原任务，而不是创建第二个任务。" },
      { title: "按账务记录核对", body: "用任务号、消费时间和积分变化建立一一对应，不按当前价格反推历史消费。" },
      { title: "异常时分级处理", body: "先查询原任务，再核对消费；只有确认需要重新生成时才接受可能再次计费。" },
    ],
    costAndWait: "查看余额和消费记录通常不产生模型费用。充值与生成属于不同链路；到账时间、赠送权益与有效期以主站当前充值页面展示为准。",
    successCriteria: ["预计费用在提交前可见", "任务号与消费记录可以对应", "重新生成前明确知道可能再次扣费"],
    failures: [
      { problem: "余额减少但页面没有结果", action: "保留任务号并查询任务、保存和交付阶段，不要立即重复提交。" },
      { problem: "消费金额与记忆中的价格不同", action: "查看该任务创建时的参数和账务记录，不使用现在的模型价格倒推。" },
    ],
    returnPath: "/recharge",
    returnLabel: "查看积分充值",
    sortOrder: 5,
    readMinutes: 5,
  }),
  publicArticle({
    id: "article-public-gpt-image-2",
    slug: "GPT-Image-2",
    categoryId: "guides",
    title: "GPT-Image-2 提示词使用指南",
    summary: "用目标、主体、环境、构图和硬约束组织可复用的生产级生图提示词。",
    keywords: ["GPT-Image-2", "生图提示词", "构图", "文字渲染", "图像编辑"],
    body: "稳定的图片提示词应先说明用途，再描述主体、动作、环境、光线和构图，最后列出必须满足与禁止出现的条件。不要依靠大量近义形容词制造质量，关键是让每个约束可观察、可检查。\n\n涉及海报文字、角色一致性或局部编辑时，应把需要保留的内容和允许变化的内容分开写。主站的提示词工具负责整理文本，真正的尺寸、质量和费用仍由所选生图模型参数决定。",
    applicability: "广告图、角色定妆、场景概念图、带文字海报、参考图编辑和多轮视觉迭代。",
    preparation: ["明确图片最终用途与画幅", "准备有权使用的参考图", "列出必须保留、允许修改和禁止出现的元素"],
    steps: [
      { title: "定义目标与画幅", body: "先写清广告、封面、角色表或信息图等用途，并确定横竖比例。" },
      { title: "建立画面层级", body: "按主体、动作、环境、光线、镜头和材质的顺序描述，避免互相冲突。" },
      { title: "添加可验证约束", body: "明确人物数量、文字内容、留白区域、品牌禁用项和不允许变化的参考特征。" },
      { title: "小样验证后迭代", body: "先生成少量结果，只修改失败的约束；不要每轮同时更换主体、风格和构图。" },
    ],
    costAndWait: "提示词整理与图片生成是两步。是否收费、分辨率与等待时间由主站当前执行模型决定；先用最低必要数量验证，再批量生成。",
    successCriteria: ["主体、数量和构图与用途一致", "参考图中要求保留的身份特征稳定", "文字和禁止项可逐项检查"],
    failures: [
      { problem: "提示词很长但结果仍漂移", action: "删除重复形容词，改为可观察的主体特征、位置关系和硬约束。" },
      { problem: "编辑时整张图被重画", action: "把保留区域和修改区域分别说明，并缩小一次迭代的变化范围。" },
    ],
    returnPath: "/tools/text/image-prompt",
    returnLabel: "打开图片提示词工具",
    sortOrder: 10,
    readMinutes: 6,
  }),
  publicArticle({
    id: "article-public-seedance-prompt",
    slug: "seedance-2-prompt",
    categoryId: "guides",
    title: "Seedance 2.0 提示词指南（主站适配版）",
    summary: "把故事要求写成可执行的时间轴、角色动作、镜头运动、声音和连续性约束。",
    keywords: ["Seedance 2.0", "视频提示词", "时间轴", "图生视频", "运镜"],
    body: "视频提示词不是静态画面描述。主站采用“参考绑定—时长—动作节拍—镜头—声音—硬约束”的结构，让模型知道什么保持不变、什么在何时发生。\n\n每个时间段只安排能够完成的动作，并给动作留下起势、过程和结果。图片只负责锁定身份与起始视觉，视频提示词仍要补充动作方向、镜头速度、环境响应和结尾状态。",
    applicability: "文生视频、首帧图生视频、多图参考、无对白宠物动画、产品广告与连续短剧情节。",
    preparation: ["确认模型当前支持的时长与参考方式", "锁定角色、场景、道具和画幅", "把原文拆成单镜头可完成的核心动作"],
    steps: [
      { title: "绑定参考", body: "说明每张参考图分别控制角色、场景、道具还是首尾帧，禁止模糊引用。" },
      { title: "编排秒级动作", body: "从 0 秒开始连续分段，每段包含主体动作、环境反馈和结束状态。" },
      { title: "补充镜头与声音", body: "写清景别、机位、移动速度以及旁白、对白、环境声和音效的关系。" },
      { title: "增加硬约束", body: "限制角色漂移、多余人物、错误口型、文字水印、镜头瞬移和时间轴越界。" },
    ],
    costAndWait: "文章与提示词编辑不等于已生成视频。真实视频任务按当前模型、时长、清晰度和数量计费，排队、生成、保存和裁剪是不同等待阶段。",
    successCriteria: ["时间轴从 0 秒开始且不超过接口时长", "每段动作前后状态连续", "参考图角色与最终视频身份一致"],
    failures: [
      { problem: "动作写了很多但模型只完成一部分", action: "减少同一时间段的并行动作，把核心动作拆成起势、过程和结果。" },
      { problem: "角色像参考图但不会动", action: "补充重心、肢体、视线、环境反馈和镜头跟随，不要只重复外观。" },
    ],
    returnPath: "/tools/video",
    returnLabel: "进入视频创作",
    sortOrder: 20,
    readMinutes: 7,
  }),
  publicArticle({
    id: "article-public-seedance-66",
    slug: "seedance-2-prompt-66",
    categoryId: "guides",
    title: "Seedance 2.0 视频生成、编辑、补全提示词 66 个原创练习方向",
    summary: "按六类能力组织 66 个本地主站原创练习方向，用于建立自己的案例库。",
    keywords: ["Seedance 2.0", "66个案例", "视频生成", "视频编辑", "视频补全", "练习"],
    body: `本地主站不搬运其他网站的 66 条案例原文，而是重新设计六组、每组十一项的练习方向，共 66 项。每一项都应自行补充主体、时长、参考绑定、动作时间轴与硬约束。\n\n${SEEDANCE_66_DIRECTIONS.join("\n\n")}\n\n这些方向是练习索引，不是已生成结果。选择一个方向后，应先用单条低风险任务验证，再沉淀成带输入、参数、任务号和结果的真实案例。`,
    applicability: "需要系统练习文生视频、图生视频、多图参考、编辑、补全与声音叙事，或为团队建立内部案例库。",
    preparation: ["从六组中只选一个练习方向", "准备有权使用的参考素材", "记录模型、时长、画幅和预期检查点"],
    steps: [
      { title: "选择能力组", body: "先确定本次只验证生成、参考、编辑、补全或声音中的一项能力。" },
      { title: "把方向改写成完整提示词", body: "补齐主体、场景、动作时间轴、镜头、声音和禁止项。" },
      { title: "单条运行并记录", body: "保存输入、参数、任务号、费用、等待时间和原始结果，不只保存成片。" },
      { title: "按失败类型复盘", body: "区分角色漂移、动作缺失、镜头错误、声音问题和交付失败，再定向修改。" },
    ],
    costAndWait: "66 项是内容索引，不代表自动创建 66 个任务。任何真实生成都应逐条授权并按主站当前价格计费；不要一次性批量提交未经验证的练习。",
    successCriteria: ["六组各包含十一项且总数为 66", "每次运行只验证明确能力", "真实案例保留输入、参数、任务与结果证据"],
    failures: [
      { problem: "把方向名称直接当成提示词", action: "补齐参考绑定、秒级动作、镜头、声音和硬约束后再提交。" },
      { problem: "一次批量跑完 66 项", action: "先做每组一个代表任务，通过后再分批扩展，避免费用和错误同时放大。" },
    ],
    returnPath: "/tools/video",
    returnLabel: "进入视频创作",
    sortOrder: 30,
    readMinutes: 8,
  }),
  publicArticle({
    id: "article-public-seedance-film-guide",
    slug: "seedance-2-video-prompt-guide",
    categoryId: "guides",
    title: "Seedance 2.0 影视场景提示词指南",
    summary: "把人物调度、空间关系、镜头节奏和声音设计组合成可拍摄的影视场景。",
    keywords: ["Seedance 2.0", "影视场景", "人物调度", "镜头语言", "连续性"],
    body: "影视场景提示词的重点不是堆积电影术语，而是建立空间、人物动机和镜头因果。先说明人物在哪里、为什么行动、动作改变了什么，再决定镜头如何揭示信息。\n\n一个镜头最好只有一个主要叙事任务。需要转场时，利用动作、视线、声音或构图相似性连接前后镜头，并明确轴线、方向和道具位置，减少空间跳变。",
    applicability: "剧情短片、影视工坊分镜、广告叙事、口播配画和无对白动画场景。",
    preparation: ["确定场景平面关系和人物动线", "为每镜写一句叙事任务", "锁定角色、服装、道具和光线方向"],
    steps: [
      { title: "先写场景与动机", body: "交代人物位置、目标和阻力，让动作有因果而不是随意移动。" },
      { title: "安排镜头信息", body: "建立镜头、动作镜头、反应镜头和结果镜头各承担一个主要信息。" },
      { title: "维护空间连续", body: "统一轴线、出入画方向、视线和道具位置，必要时用空镜重建空间。" },
      { title: "用声音连接", body: "旁白、对白、环境声和动作音效应服务节奏，可用声音先行连接转场。" },
    ],
    costAndWait: "场景设计和提示词整理不产生视频结果。进入影视工坊或视频模型后，费用和等待取决于镜头数量、时长、模型及输出规格。",
    successCriteria: ["每镜有清楚的叙事任务", "人物动线与轴线连续", "镜头和声音共同推动信息而非重复说明"],
    failures: [
      { problem: "镜头很炫但故事看不懂", action: "删去不承担信息的运镜，恢复人物目标、动作原因和结果镜头。" },
      { problem: "人物方向反复变化", action: "检查轴线、出入画方向和视线匹配，必要时插入建立空间的全景。" },
    ],
    returnPath: "/tools/film-studio",
    returnLabel: "进入影视工坊",
    sortOrder: 40,
    readMinutes: 7,
  }),
  publicArticle({
    id: "article-public-seedance-agent",
    slug: "seedance-agent-v2",
    categoryId: "quick-start",
    title: "智能生视频 Agent 2.0 使用指南",
    summary: "说明多模态 Agent 如何规划任务、选择工具、请求确认并交付可追溯的视频结果。",
    keywords: ["创作 Agent", "智能生视频", "多模态", "工具调用", "任务规划"],
    body: "创作 Agent 是任务编排入口，不是单一视频模型。它先识别用户目标和已有素材，再决定是否需要文案、提示词、图片、声音或视频工具，并在实际付费或写入前请求必要确认。\n\n高质量请求应包含用途、受众、时长、画幅、风格、参考素材和禁止项。Agent 可以补齐缺失信息，但不能替用户猜测付费预算、素材授权和关键角色设定。",
    applicability: "从一句创意开始组织多步骤视频，或希望统一调用主站文案、生图、音频和视频能力。",
    preparation: ["明确最终交付是方案、提示词还是成片", "上传有权使用的参考图片或视频", "确认画幅、时长、预算和是否允许付费调用"],
    steps: [
      { title: "描述完整目标", body: "说明主题、平台、受众、风格、时长、画幅和需要保留的参考特征。" },
      { title: "检查 Agent 计划", body: "确认它选择的步骤、工具和预期输出，不需要的媒体阶段应删除。" },
      { title: "逐阶段确认", body: "先确认文案和提示词，再确认图片；真实视频提交前重新核对模型与费用。" },
      { title: "验收并保存证据", body: "检查任务号、媒体地址、参数和历史记录，不能只以聊天回复作为生成成功证据。" },
    ],
    costAndWait: "与 Agent 对话不代表已经创建媒体任务。只有实际调用模型时才按相应工具计费；多个阶段的等待和费用应分别显示。",
    successCriteria: ["Agent 计划与用户目标一致", "付费调用前有明确参数和确认", "交付结果能在任务或媒体历史中追溯"],
    failures: [
      { problem: "Agent 一次生成了过多内容", action: "缩小交付目标并要求分阶段确认，先只产出方案或提示词。" },
      { problem: "聊天说成功但没有媒体", action: "检查真实任务号、结果地址和历史记录；缺少这些证据时不能判定生成成功。" },
    ],
    returnPath: "/tools/chat",
    returnLabel: "打开创作 Agent",
    sortOrder: 15,
    readMinutes: 6,
  }),
  publicArticle({
    id: "article-public-update-5",
    slug: "update-5",
    categoryId: "guides",
    title: "自媒体操盘手近期重要功能更新速递",
    summary: "集中说明影视工坊、创作 Agent、画布、灵感内容、工具目录和主站接入的当前进展。",
    keywords: ["功能更新", "影视工坊", "创作 Agent", "画布", "灵感广场", "工具目录"],
    body: "本轮更新重点不是增加孤立按钮，而是让创作入口与主站已有能力保持同一套登录、模型、项目和媒体数据。公开页面可以先完成结构和只读验收，真实生成仍需通过主站权限与计费链路。\n\n新增与对齐范围包括影视工坊多类剧本入口、通用创作 Agent、可复制的只读画布示例、灵感内容筛选、文案与媒体工具目录，以及帮助文章兼容路径。原有主站功能继续保留，不因新增动画与影视能力被替换。",
    applicability: "了解本轮主站整合了什么、哪些入口可以只读体验，以及哪些能力仍需要登录或真实模型配置。",
    preparation: ["刷新到当前生产构建", "确认主站登录与模型目录可访问", "真实生成前核对费用和权限"],
    steps: [
      { title: "从首页进入模块", body: "使用统一侧栏访问 Agent、影视工坊、画布、灵感广场和工具目录。" },
      { title: "先验证公开内容", body: "检查页面结构、筛选、示例、帮助文章和只读预览，不触发付费任务。" },
      { title: "再验证主站接入", body: "登录后确认模型、项目、媒体历史和积分仍使用主站数据。" },
      { title: "按链路验收生成", body: "文案、图片、视频分别保存任务证据，任何一段失败都不应伪装为成片成功。" },
    ],
    costAndWait: "浏览公开内容不调用付费模型。登录、生成、保存和下载的费用与等待仍按各主站工具当前规则执行。",
    successCriteria: ["新增入口与原主站功能同时存在", "公开只读操作不产生写入或扣费", "真实模型结果能进入主站项目与媒体记录"],
    failures: [
      { problem: "更新后只看到新壳子，旧功能消失", action: "检查是否误替换主站路由或数据源；整合应为增量，不应删除原入口。" },
      { problem: "按钮可点但链路没有结果", action: "继续核对接口、登录、模型配置、任务保存和结果交付，不以导航成功代替功能成功。" },
    ],
    returnPath: "/",
    returnLabel: "返回主站首页",
    sortOrder: 25,
    readMinutes: 5,
  }),
  publicArticle({
    id: "article-public-user-group",
    slug: "youcai-group",
    categoryId: "faq",
    articleType: "faq",
    title: "关于自媒体操盘手：用户交流与问题反馈",
    summary: "说明提交问题、功能建议和验收证据时应准备的信息；当前不展示未经配置的群二维码。",
    keywords: ["用户交流", "问题反馈", "BUG", "功能建议", "任务证据", "隐私"],
    body: "主站欢迎提交问题与功能建议。为了让问题能够复现，请同时提供发生时间、页面路径、操作步骤、公开模型名、脱敏错误和任务号；不要发送密码、令牌、Cookie 或完整个人资料。\n\n当前代码没有配置经过确认的官方交流群二维码，因此本页不会复制其他网站群信息或展示占位二维码。后续若主站建立正式渠道，应由管理员在可验证的公告中发布。",
    applicability: "反馈页面异常、模型任务失败、功能建议、素材显示问题或帮助文档错误。",
    preparation: ["记录页面路径和发生时间", "整理最短复现步骤", "准备脱敏截图、任务号和公开错误摘要"],
    steps: [
      { title: "先确认问题范围", body: "说明是页面显示、权限、模型调用、任务保存还是媒体交付问题。" },
      { title: "提供复现步骤", body: "从进入页面开始按顺序列出操作，并注明预期结果和实际结果。" },
      { title: "附上安全证据", body: "提供公开模型名、任务号与脱敏截图，删除令牌、账号隐私和供应方密钥。" },
      { title: "跟踪处理结果", body: "修复后使用相同步骤复验；无法复现时保留环境和版本信息。" },
    ],
    costAndWait: "阅读说明和提交反馈不产生模型费用。处理时间取决于复现信息是否完整，以及问题是否涉及外部模型服务。",
    successCriteria: ["反馈包含路径、步骤、时间和预期/实际结果", "敏感信息已脱敏", "修复后可以按同一流程复验"],
    failures: [
      { problem: "只提供“不能用”", action: "补充页面、操作、时间、错误和任务号，否则无法定位具体链路。" },
      { problem: "截图中包含令牌或个人信息", action: "立即撤回并轮换相关凭证，再提交脱敏版本。" },
    ],
    returnPath: "/articles",
    returnLabel: "查看帮助文章",
    sortOrder: 15,
    readMinutes: 4,
  }),
] as const;

export function findRequiredPublicArticle(slug: string): HelpArticle | undefined {
  return REQUIRED_PUBLIC_ARTICLES.find((article) => article.slug === slug);
}
