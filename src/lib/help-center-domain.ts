import { REQUIRED_PUBLIC_ARTICLES } from "./help-center-public-articles";

export const HELP_CENTER_SETTING_KEY = "help_center_catalog_v1";
export const HELP_CENTER_SCHEMA_VERSION = 1 as const;

export type HelpCategoryId =
  | "quick-start"
  | "guides"
  | "cases"
  | "faq"
  | "troubleshooting";

export type HelpArticleStatus = "draft" | "published";
export type HelpArticleVisibility = "public" | "authenticated" | "admins";
export type HelpArticleType = "guide" | "case" | "faq" | "troubleshooting";
export type HelpMediaKind = "image" | "video";
export type HelpMediaSourceKind = "generated_result" | "ui_capture" | "test_fixture" | "waiting";
export type HelpMediaVerification = "verified" | "waiting" | "invalid";

export interface HelpCategory {
  id: HelpCategoryId;
  label: string;
  description: string;
  sortOrder: number;
}

export interface HelpStep {
  title: string;
  body: string;
}

export interface HelpFailure {
  problem: string;
  action: string;
}

export interface HelpMediaTrace {
  taskId: string | null;
  runId: string | null;
  historyId: string | null;
  artifactPath: string;
  sourceRecord: string;
  verifiedAt: string;
  note: string;
}

export interface HelpMediaInternal {
  id: string;
  title: string;
  kind: HelpMediaKind;
  sourceKind: HelpMediaSourceKind;
  verificationStatus: HelpMediaVerification;
  assetPath: string;
  posterPath: string;
  captionsPath: string;
  alt: string;
  textSummary: string;
  aspectRatio: string;
  generatedAt: string;
  publicModelName: string;
  sourcePage: string;
  promptSummary: string;
  parameters: Record<string, string>;
  trace: HelpMediaTrace;
}

export interface HelpArticle {
  id: string;
  slug: string;
  categoryId: HelpCategoryId;
  articleType: HelpArticleType;
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
  notes: string;
  returnPath: string;
  returnLabel: string;
  status: HelpArticleStatus;
  pinned: boolean;
  recommended: boolean;
  sortOrder: number;
  visibility: HelpArticleVisibility;
  publishedAt: string | null;
  updatedAt: string;
  readMinutes: number;
  mediaIds: string[];
  coverMediaId: string | null;
}

export interface HelpArticleVersion {
  id: string;
  articleId: string;
  revision: number;
  savedAt: string;
  savedBy: string;
  action: "create" | "update" | "rollback";
  snapshot: HelpArticle | null;
}

export interface HelpCatalog {
  schemaVersion: typeof HELP_CENTER_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  categories: HelpCategory[];
  media: HelpMediaInternal[];
  articles: HelpArticle[];
  history: HelpArticleVersion[];
}

export type PublicHelpMedia = Omit<HelpMediaInternal, "trace" | "verificationStatus"> & {
  evidenceLabel: string;
};

export interface PublicHelpCatalog {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  preview: boolean;
  categories: HelpCategory[];
  media: PublicHelpMedia[];
  articles: HelpArticle[];
}

const CATEGORIES: HelpCategory[] = [
  { id: "quick-start", label: "快速开始", description: "第一次完成创作的最短路径", sortOrder: 10 },
  { id: "guides", label: "使用说明", description: "按功能和生产阶段查看操作方法", sortOrder: 20 },
  { id: "cases", label: "案例展示", description: "只收录可追溯的真实生成结果", sortOrder: 30 },
  { id: "faq", label: "常见问题", description: "费用、等待、下载与记录说明", sortOrder: 40 },
  { id: "troubleshooting", label: "故障排查", description: "按状态定位失败并安全重试", sortOrder: 50 },
];

const MEDIA: HelpMediaInternal[] = [
  {
    id: "ui-storyboard-workbench-20260814",
    title: "分镜工作台当前桌面界面",
    kind: "image",
    sourceKind: "ui_capture",
    verificationStatus: "verified",
    assetPath: "/help/storyboard-workbench.png",
    posterPath: "",
    captionsPath: "",
    alt: "本平台分镜工作台桌面界面，左侧为公开模型选择，右侧为三张纵向分镜任务卡",
    textSummary: "真实页面操作截图。它用于说明提示词、图片门禁和视频入口的位置，不把卡片空态当作真实生成结果。",
    aspectRatio: "16:9",
    generatedAt: "2026-08-14T08:51:38+08:00",
    publicModelName: "不适用（页面操作）",
    sourcePage: "/storyboard-workbench",
    promptSummary: "无；页面操作截图未提交生成任务。",
    parameters: { 视口: "桌面端", 状态: "未提交任务", 用途: "操作位置说明" },
    trace: {
      taskId: "并行任务03",
      runId: null,
      historyId: null,
      artifactPath: "public/help/storyboard-workbench.png",
      sourceRecord: "并行任务03-主站公告帮助中心审计验收报告-2026-08-14.md",
      verifiedAt: "2026-08-14T10:01:09+08:00",
      note: "真实页面操作截图；无付费生成，不作为案例结果。",
    },
  },
  {
    id: "ui-free-canvas-20260812",
    title: "自由画布三阶段制作面板",
    kind: "image",
    sourceKind: "ui_capture",
    verificationStatus: "verified",
    assetPath: "/help/free-canvas-images.png",
    posterPath: "",
    captionsPath: "",
    alt: "本平台自由画布界面，右侧制作面板显示导演拆解、批量生图和批量视频三个阶段",
    textSummary: "真实页面操作截图。截图中的 Mock 模型仅用于无费用界面验收，不是本平台真实生成案例。",
    aspectRatio: "16:9",
    generatedAt: "2026-08-12T16:42:54+08:00",
    publicModelName: "不适用（页面操作）",
    sourcePage: "/free-canvas",
    promptSummary: "无；该素材只证明页面流程与控件状态。",
    parameters: { 模式: "自由画布", 阶段: "制作面板", 费用: "无费用 UI 验收" },
    trace: {
      taskId: "并行任务03",
      runId: null,
      historyId: null,
      artifactPath: "public/help/free-canvas-images.png",
      sourceRecord: "并行任务03-主站公告帮助中心审计验收报告-2026-08-14.md",
      verifiedAt: "2026-08-14T10:01:09+08:00",
      note: "真实页面操作；画面中的 Mock 标签必须向用户明示，不作为生成质量证据。",
    },
  },
  {
    id: "generated-cat-reference-20260809",
    title: "猫咪科普语义参考图",
    kind: "image",
    sourceKind: "generated_result",
    verificationStatus: "waiting",
    assetPath: "/help/cat-reference-result.png",
    posterPath: "",
    captionsPath: "",
    alt: "橘白猫坐在蓝色坐垫上，思考气泡中对比健康体态与过胖体态",
    textSummary: "本地归档中的生成图片，展示如何把抽象的健康体态对比转换为可见语义。内部运行标识补齐前不作为已发布案例。",
    aspectRatio: "16:9",
    generatedAt: "2026-08-09T06:36:45+08:00",
    publicModelName: "等待历史记录核验",
    sourcePage: "/free-canvas",
    promptSummary: "宠物健康科普；用问号与体态对比气泡表达抽象语义。",
    parameters: { 画幅: "16:9", 类型: "关键帧", 状态: "等待运行记录核验" },
    trace: {
      taskId: "cat-canvas-demo",
      runId: null,
      historyId: "96cd882a-fb75-487a-bfc7-e47064fb737d",
      artifactPath: "public/help/cat-reference-result.png",
      sourceRecord: ".tmp-e2e/cat-canvas-demo-report.json",
      verifiedAt: "",
      note: "文件存在且可解码；历史记录状态为 draft，公开模型名尚待核验。",
    },
  },
  {
    id: "generated-storyboard-video-v50",
    title: "故事板图生视频片段",
    kind: "video",
    sourceKind: "generated_result",
    verificationStatus: "waiting",
    assetPath: "/help/storyboard-video-case.mp4",
    posterPath: "/help/storyboard-video-poster.png",
    captionsPath: "/help/storyboard-video-case.zh-CN.vtt",
    alt: "一段由五格故事板驱动的图生视频测试片段",
    textSummary: "本地 live 测试归档视频。内部任务标识、生成时间和公开模型显示名补齐前不作为已发布案例。",
    aspectRatio: "16:9",
    generatedAt: "2026-08-14T02:10:37+08:00",
    publicModelName: "等待任务记录核验",
    sourcePage: "/storyboard-workbench",
    promptSummary: "女子抛出零食，金毛在门边做出连续反应；镜头延续故事板中的角色与空间关系。",
    parameters: { 画幅: "16:9", 类型: "图生视频", 状态: "等待任务记录核验" },
    trace: {
      taskId: "storyboard-v50-live",
      runId: "storyboard-run-resume-msrtr2yr",
      historyId: null,
      artifactPath: "public/help/storyboard-video-case.mp4",
      sourceRecord: ".tmp-e2e/storyboard-v50-live-result.json",
      verifiedAt: "",
      note: "文件存在且可播放，review storyboard-v50-live-fixed 已通过；公开模型名尚待核验。",
    },
  },
];

const NOW = "2026-08-14T14:35:00+08:00";

const ARTICLES: HelpArticle[] = [
  {
    id: "article-storyboard-flow",
    slug: "storyboard-prompt-image-video",
    categoryId: "quick-start",
    articleType: "guide",
    title: "分镜工作台：从提示词到图片，再到视频",
    summary: "先分别准备生图和视频提示词，通过图片可用性门禁后，再提交图生视频。",
    keywords: ["分镜工作台", "生图提示词", "视频提示词", "图片门禁", "图生视频"],
    body: "分镜卡把生图与视频拆成上下两个阶段。图片接口返回地址后，页面仍会检查地址是否可访问、浏览器是否完成解码；只有真实可用的图片才能解锁视频。",
    applicability: "已有成对提示词，或已由故事版导演生成结构化分镜，希望逐卡审核图片后再生成视频。",
    preparation: ["生图提示词与视频提示词分别准备，不要互相替代", "确认公开模型名称、画幅、时长和提交按钮附近的预计费用", "批量任务前先用一张图片或一条短视频验证"],
    steps: [
      { title: "导入两类提示词", body: "把生图提示词和视频提示词放入各自输入区，检查段落编号与卡片顺序。" },
      { title: "选择图片模型并生成", body: "确认画幅和参考图后提交；等待卡片进入明确成功或失败状态。" },
      { title: "核验图片门禁", body: "预览应可见、自然宽高大于零且地址可被视频模型访问；破图时不要继续。" },
      { title: "选择时长并生成视频", body: "视频会复用当前卡片的已验证故事板与视频提示词；提交后保留任务状态。" },
      { title: "预览与下载", body: "播放确认角色、动作与镜头连续，再从卡片或媒体历史下载。" },
    ],
    costAndWait: "图片与视频分别计费，价格以提交前的实时显示为准。批量生图按约 5 秒错峰提交、批量视频按约 8 秒错峰提交；错峰是提交节奏，不代表每条任务会在该时间内完成。",
    successCriteria: ["图片预览可正常解码且视频按钮解锁", "视频任务只创建一次，刷新后继续原任务而非重复提交", "成品可播放、可下载，并能在历史入口找到对应记录"],
    failures: [
      { problem: "图片成功但视频仍锁定", action: "检查预览是否破图、是否为公网 http/https 地址，以及浏览器是否完成解码。" },
      { problem: "双击后担心重复扣费", action: "先看卡片任务状态和历史记录，不要再次提交；界面会阻止同卡重复创建。" },
      { problem: "视频失败", action: "保留任务号、公开模型名、时间和错误摘要，在原卡片确认后重试。" },
    ],
    notes: "本教程截图是真实页面操作；空卡片不代表已生成案例。用户端不会展示渠道、密钥或内部模型 ID。",
    returnPath: "/storyboard-workbench",
    returnLabel: "进入分镜工作台",
    status: "published",
    pinned: true,
    recommended: true,
    sortOrder: 10,
    visibility: "public",
    publishedAt: NOW,
    updatedAt: NOW,
    readMinutes: 5,
    mediaIds: ["ui-storyboard-workbench-20260814"],
    coverMediaId: "ui-storyboard-workbench-20260814",
  },
  {
    id: "article-free-canvas-flow",
    slug: "free-canvas-full-workflow",
    categoryId: "guides",
    articleType: "guide",
    title: "自由画布：三阶段完成一条分镜流程",
    summary: "按镜头拆分、开始生图、生成视频的顺序推进，并在每个阶段保留可恢复记录。",
    keywords: ["自由画布", "镜头拆分", "批量生图", "批量视频", "生成记录"],
    body: "自由画布的正式生产入口固定为三个阶段。高频结果预览和下载位于画布顶部；设置、历史和检查工具集中在制作面板中。先确认角色和分镜，再逐步生成，可减少错误扩散。",
    applicability: "需要把完整文案拆成多个镜头，并为每镜保存口播、视频提示词、生图提示词、关键帧和视频的一对一关系。",
    preparation: ["准备完整原文和补充要求", "确认画幅、风格以及是否允许生成后自动裁剪", "角色定妆图生成后先人工确认，再批量生成关键帧"],
    steps: [
      { title: "镜头拆分", body: "让导演读取全文并建立角色、口播段、两类提示词与镜头关系；先修正文案和顺序。" },
      { title: "确认角色资产", body: "逐角色检查外观与身份；未确认的角色图不应进入分镜关键帧。" },
      { title: "开始生图", body: "图片节点只读取本镜生图提示词和对应角色参考，不读取视频提示词。" },
      { title: "生成视频", body: "视频节点读取本镜视频提示词和已确认关键帧；失败只重试对应镜头。" },
      { title: "生成记录与下载", body: "确认运行快照已保存，再预览和按镜头编号下载结果。" },
    ],
    costAndWait: "镜头拆分可能需要等待智能体返回；图片和视频生成分别计费。批量入口采用错峰提交，任务可以并发运行。开启自动裁剪时按模型完整原片计费，裁剪完成前仍属于处理中。",
    successCriteria: ["每段口播只对应一组视频提示词、生图提示词、图片和视频", "图片节点与视频节点读取正确的上游内容", "生成记录中存在可恢复的节点、连线、状态与结果地址"],
    failures: [
      { problem: "导演质检未通过", action: "批量队列会暂停；可以先修正提示词，单卡手动生成不应被无关地禁用。" },
      { problem: "角色外观覆盖剧情", action: "确认角色图只锁身份，关键帧应从本镜生图提示词重新构图。" },
      { problem: "刷新后看不到结果", action: "打开生成记录恢复最近快照；重要媒体先下载，不依赖浏览器长期保存。" },
    ],
    notes: "截图来自真实自由画布页面操作，画面中的 Mock 模型用于无费用 UI 验收，不能当作真实生成案例。",
    returnPath: "/free-canvas",
    returnLabel: "进入自由画布",
    status: "published",
    pinned: true,
    recommended: true,
    sortOrder: 20,
    visibility: "public",
    publishedAt: NOW,
    updatedAt: NOW,
    readMinutes: 6,
    mediaIds: ["ui-free-canvas-20260812"],
    coverMediaId: "ui-free-canvas-20260812",
  },
  {
    id: "article-public-image-url",
    slug: "image-url-and-safe-retry",
    categoryId: "troubleshooting",
    articleType: "troubleshooting",
    title: "失败重试与公共图片 URL：先定位，再决定是否重新生成",
    summary: "区分任务查询、免费重检和可能再次计费的重新生成，避免把本地路径提交给视频模型。",
    keywords: ["失败重试", "公共图片URL", "公网", "解码", "重复扣费", "502"],
    body: "上游返回 completed 和一个 URL，只能说明模型阶段结束；平台还要检查来源文件、浏览器解码与交付状态。公共图片 URL 必须是视频模型可以访问的 http/https 地址，本机路径和登录页地址都不合格。",
    applicability: "图片不显示、视频按钮未解锁、任务长时间处理中、历史媒体失效，或准备点击重新生成之前。",
    preparation: ["记录任务时间、公开模型名和页面上的错误摘要", "确认预览地址不是 localhost、私网或本机文件路径", "先区分免费重检与会再次计费的重新生成"],
    steps: [
      { title: "先查询原任务", body: "刷新状态或使用继续查询，确认上游是否仍在运行；不要用第二次提交代替查询。" },
      { title: "检查媒体可交付性", body: "图片需可下载并完成浏览器解码；视频需能读取元数据并正常播放。" },
      { title: "检查 URL", body: "图生视频必须使用可访问的 http/https 地址；本机路径先通过平台入库或迁移。" },
      { title: "选择重检或重试", body: "免费重检只检查原任务；只有明确确认可能再次计费时，才重新生成。" },
      { title: "保留诊断信息", body: "记录卡片、阶段、耗时和脱敏错误，便于管理员按提交、轮询、保存或交付阶段定位。" },
    ],
    costAndWait: "继续查询和重新检查原任务不应创建新任务；重新生成可能再次收费。对象存储转存、裁剪或媒体探测会增加交付等待时间，不能把上游完成直接当成可下载成品。",
    successCriteria: ["原任务状态与页面状态一致", "图片可解码或视频可播放并可下载", "重新生成前出现费用风险提示且由用户明确确认"],
    failures: [
      { problem: "地址打开是登录页或 403", action: "使用平台同源预览/入库能力，不要把主登录令牌拼进 URL。" },
      { problem: "旧媒体返回 502", action: "保留元数据并显示失效状态；先尝试原任务恢复，不能伪装为可用。" },
      { problem: "裁剪后仍显示处理中", action: "等待裁剪和保存完成；缺少裁剪文件时不能交付原生长视频冒充成品。" },
    ],
    notes: "本说明不承诺失败自动退款；费用与账务不一致时，应使用任务号和消费记录交由管理员核对。",
    returnPath: "/storyboard-workbench",
    returnLabel: "返回分镜工作台",
    status: "published",
    pinned: false,
    recommended: true,
    sortOrder: 10,
    visibility: "public",
    publishedAt: NOW,
    updatedAt: NOW,
    readMinutes: 5,
    mediaIds: ["ui-storyboard-workbench-20260814"],
    coverMediaId: "ui-storyboard-workbench-20260814",
  },
  {
    id: "article-director-modes",
    slug: "storyboard-director-three-modes",
    categoryId: "guides",
    articleType: "guide",
    title: "故事版导演三种模式：高能夸张、电影叙事、抒情情感",
    summary: "根据节奏和镜头容量选择导演，不用同一种拍法处理所有文案。",
    keywords: ["故事版导演", "高能夸张", "电影叙事", "抒情情感", "8秒", "10秒", "15秒"],
    body: "三种导演共享同一结构化输入与输出协议，但镜头节奏不同：高能夸张偏快速动作和强姿态，电影叙事偏中速连续调度，抒情情感偏缓推、主观视线和微表演。",
    applicability: "已经完成分段口播，希望先由导演生成故事板包，再进入分镜工作台。",
    preparation: ["按原顺序准备已分段口播", "选择统一 3D 风格和 16:9 或 9:16", "选择 8、10 或 15 秒目标时长", "把角色或产品限制写入特殊备注"],
    steps: [
      { title: "高能夸张", body: "适合反差、追逐、笑点和强动作；相同时长下允许更多动作节拍。" },
      { title: "电影叙事", body: "适合有动机的跟拍、关系变化和空间连续；默认用于多数连续小故事。" },
      { title: "抒情情感", body: "适合安静陪伴、回忆和情绪转折；镜头更少，停留更长。" },
      { title: "检查结构化结果", body: "确认模式、画幅、时长、镜头数和每段原文边界均被保留。" },
    ],
    costAndWait: "导演返回时间取决于当前智能体模型和内容长度。只生成结构化方案时不应被描述为已经完成图片或视频；后续媒体生成按各自页面实时价格计费。",
    successCriteria: ["每段原文顺序和边界不变", "导演模式与节奏字段一致", "8/10/15 秒对应镜头容量符合页面当前规则", "结果能被分镜工作台识别"],
    failures: [
      { problem: "高能模式镜头过多", action: "先删去不推进动作的切镜，保留起因、反应和结果。" },
      { problem: "抒情模式像静态图", action: "补充视线、呼吸、距离和缓慢镜头运动，不靠频繁切镜制造节奏。" },
    ],
    notes: "文字结构已完成；等待三种模式的当前真实页面截图与同源 run 证据后发布。",
    returnPath: "/",
    returnLabel: "返回应用广场",
    status: "draft",
    pinned: true,
    recommended: true,
    sortOrder: 5,
    visibility: "public",
    publishedAt: null,
    updatedAt: NOW,
    readMinutes: 4,
    mediaIds: [],
    coverMediaId: null,
  },
  {
    id: "article-duration-choice",
    slug: "choose-8-10-15-seconds",
    categoryId: "guides",
    articleType: "guide",
    title: "8、10、15 秒怎么选",
    summary: "用动作容量和模型原生时长做选择，不把提示词时间轴当成接口时长。",
    keywords: ["8秒", "10秒", "15秒", "时长", "裁剪", "计费"],
    body: "8 秒适合单一动作链，10 秒适合完整起因与反应，15 秒可以容纳更多连续调度。最终接口时长由模型参数决定；提示词中的时间轴只引导节奏。",
    applicability: "在故事版导演或视频卡片提交前选择目标时长。",
    preparation: ["确认模型支持固定、离散还是区间时长", "确认是否允许生成后自动裁剪", "按约 6 字/秒检查口播是否装得下"],
    steps: [
      { title: "先看动作容量", body: "单一动作优先 8 秒，完整微故事优先 10 秒，更多调度再考虑 15 秒。" },
      { title: "再看模型能力", body: "模型不能原生匹配时，只有明确开启自动裁剪才可提交固定长时模型。" },
      { title: "最后看费用", body: "自动裁剪按完整原片计费，不能按裁后成片时长估算。" },
    ],
    costAndWait: "固定长时模型即使最终裁成更短片段，也按完整原片计费；裁剪和保存会增加等待。",
    successCriteria: ["目标时长与模型参数一致", "时间轴从 0 秒开始连续且不越界", "自动裁剪授权和完整原片费用说明清楚"],
    failures: [{ problem: "成片比目标长", action: "检查是否启用自动裁剪以及裁剪任务是否仍在处理中。" }],
    notes: "等待当前页面时长控件和真实任务对照素材后发布。",
    returnPath: "/storyboard-workbench",
    returnLabel: "进入分镜工作台",
    status: "draft",
    pinned: false,
    recommended: false,
    sortOrder: 30,
    visibility: "public",
    publishedAt: null,
    updatedAt: NOW,
    readMinutes: 4,
    mediaIds: [],
    coverMediaId: null,
  },
  {
    id: "article-toolbox-four",
    slug: "toolbox-four-text-tools",
    categoryId: "guides",
    articleType: "guide",
    title: "工具箱四项文字功能",
    summary: "提取、分段、格式处理等高频入口的使用边界。",
    keywords: ["工具箱", "文案提取", "分段", "格式", "排版"],
    body: "本教程只建立字段与步骤骨架，不复制其他页面文案。当前任务不修改任何工具页，待四项功能的当前真实操作截图和失败状态齐全后再发布。",
    applicability: "需要先整理文案，再进入故事版或自由画布。",
    preparation: ["保留原文备份", "确认输入来源有权使用", "长文本先分批验证"],
    steps: [{ title: "等待真实案例", body: "需要为四个工具分别补拍当前页面、成功态、空态和失败态。" }],
    costAndWait: "等待页面真实费用与耗时证据；不得用旧说明猜测。",
    successCriteria: ["四项工具各自有当前真实页面证据", "成功与失败边界可复现"],
    failures: [{ problem: "素材不足", action: "保持草稿，不把计划或旧截图写成已完成教程。" }],
    notes: "等待真实案例。",
    returnPath: "/",
    returnLabel: "返回应用广场",
    status: "draft",
    pinned: false,
    recommended: false,
    sortOrder: 40,
    visibility: "public",
    publishedAt: null,
    updatedAt: NOW,
    readMinutes: 3,
    mediaIds: [],
    coverMediaId: null,
  },
  {
    id: "article-history-download",
    slug: "media-history-and-download",
    categoryId: "faq",
    articleType: "faq",
    title: "各工作台历史、原始视频链路与下载",
    summary: "任务与账务记录按账号和工作台隔离；普通视频不复制到平台硬盘，播放期限跟随上游来源。",
    keywords: ["媒体历史", "下载", "原始链路", "上游有效期", "服务端记录"],
    body: "历史记录按账号和工作台隔离。视频制作只显示视频制作任务，分镜工作台只显示分镜任务。普通视频通过受鉴权的原始链路播放和下载，平台不做第二份永久存储；只有全部支持的取件路径都确认返回 404 或 410，才会把失效来源移出历史。",
    applicability: "需要在原工作台找回任务、预览封面、播放或下载仍由上游提供的作品。",
    preparation: ["先登录生成任务所属账号", "确认浏览器存储空间", "重要作品先下载到可靠位置"],
    steps: [
      { title: "回到原工作台", body: "在哪个工作台生成，就在该工作台的历史入口查看，记录不会跨工作台混排。" },
      { title: "预览与下载", body: "完成态展示视频抽帧封面并支持播放、下载；进行中展示真实同步状态。" },
      { title: "跟随原始来源", body: "没有固定三天倒计时；源有效即可播放或下载，网络超时和上游 5xx 不会被误判为永久失效。" },
      { title: "账号隔离", body: "切换账号后只读取当前账号记录，浏览器不得沿用上一账号缓存。" },
    ],
    costAndWait: "查看、筛选和本地缓存不触发付费模型。下载时间取决于文件大小和媒体源可用性。",
    successCriteria: ["历史按账号与工作台隔离", "视频封面、播放和下载可用", "只有确认 404 或 410 的来源才移出历史"],
    failures: [{ problem: "任务长时间无更新", action: "在原工作台刷新任务状态；查询原任务不会创建新任务或重复收费。" }],
    notes: "等待各工作台当前历史界面的脱敏截图齐全后发布。",
    returnPath: "/video",
    returnLabel: "进入视频制作",
    status: "draft",
    pinned: false,
    recommended: true,
    sortOrder: 10,
    visibility: "authenticated",
    publishedAt: null,
    updatedAt: NOW,
    readMinutes: 4,
    mediaIds: [],
    coverMediaId: null,
  },
  {
    id: "article-billing-wait",
    slug: "billing-and-generation-wait",
    categoryId: "faq",
    articleType: "faq",
    title: "扣费、生成等待与失败核对",
    summary: "提交前看预计费用，提交后保留任务号，失败时先核对账务再决定重试。",
    keywords: ["扣费", "等待", "任务号", "失败", "退款", "消费记录"],
    body: "图片、视频和裁剪阶段的等待含义不同。页面只能按已有账务记录展示实际费用，不应按模型标价反推缺失账单。",
    applicability: "提交生成前，或任务失败、余额变化与状态不一致时。",
    preparation: ["记录提交前余额与预计费用", "保存任务号、公开模型名和时间", "不要连续点击提交"],
    steps: [
      { title: "提交前", body: "核对任务数量、时长、画幅和预计费用。" },
      { title: "运行中", body: "区分排队、模型生成、保存、裁剪与交付阶段。" },
      { title: "失败后", body: "先核对消费记录和原任务状态，再决定是否重新生成。" },
    ],
    costAndWait: "价格以提交按钮附近实时显示为准；本教程不承诺所有失败都会自动退款。",
    successCriteria: ["任务状态、余额和消费记录可以一一核对", "重新生成前明确提示可能再次计费"],
    failures: [{ problem: "费用字段缺失", action: "显示“暂无可核对费用”，不要按当前标价猜测历史扣费。" }],
    notes: "等待真实消费记录截图和脱敏任务对照后发布。",
    returnPath: "/video",
    returnLabel: "返回视频制作",
    status: "draft",
    pinned: false,
    recommended: false,
    sortOrder: 20,
    visibility: "authenticated",
    publishedAt: null,
    updatedAt: NOW,
    readMinutes: 4,
    mediaIds: [],
    coverMediaId: null,
  },
  {
    id: "article-cat-case",
    slug: "case-cat-semantic-reference",
    categoryId: "cases",
    articleType: "case",
    title: "真实案例：把猫咪体态问题变成可见参考图",
    summary: "对照提示词摘要、画幅和生成结果，观察语义包装如何服务口播。",
    keywords: ["真实案例", "猫咪", "参考图", "语义包装", "角色一致性"],
    body: "图片文件已存在且可解码，但在公开模型显示名与 history/run 标识核验完成前，案例保持草稿。",
    applicability: "参考如何把无法直接看见的健康判断转换成角色表演、对比气泡和环境证据。",
    preparation: ["核对源文案与提示词摘要", "核对 history/run 标识", "核对公开模型显示名和生成时间"],
    steps: [{ title: "等待证据核验", body: "补齐运行记录后再公开结果对照。" }],
    costAndWait: "等待原任务账务记录，不按当前价格猜测。",
    successCriteria: ["图片、运行记录、模型公开名和生成时间可一一对应"],
    failures: [{ problem: "证据字段缺失", action: "保持草稿并标记等待真实案例，不发布。" }],
    notes: "等待真实案例证据补齐。",
    returnPath: "/free-canvas",
    returnLabel: "进入自由画布",
    status: "draft",
    pinned: false,
    recommended: false,
    sortOrder: 10,
    visibility: "public",
    publishedAt: null,
    updatedAt: NOW,
    readMinutes: 3,
    mediaIds: ["generated-cat-reference-20260809"],
    coverMediaId: "generated-cat-reference-20260809",
  },
  {
    id: "article-video-case",
    slug: "case-storyboard-to-video",
    categoryId: "cases",
    articleType: "case",
    title: "真实案例：五格故事板到图生视频",
    summary: "同一案例中对照故事板、提示词摘要、参数与视频结果。",
    keywords: ["真实案例", "故事板", "图生视频", "五格", "视频"],
    body: "视频文件与海报已存在且可播放，但公开模型名与 task/review 证据核验完成前保持草稿。",
    applicability: "检查角色、场景和动作是否从故事板延续到视频。",
    preparation: ["核对原始故事板", "核对视频任务与公开模型名", "核对画幅、时长和生成时间"],
    steps: [{ title: "等待证据核验", body: "补齐同一任务的 task/review 记录后再发布。" }],
    costAndWait: "等待原任务账务记录，不按当前模型价格猜测。",
    successCriteria: ["视频可播放", "任务记录与文件同源", "公开参数和结果一致"],
    failures: [{ problem: "只有文件名没有任务记录", action: "不能当作已发布真实案例。" }],
    notes: "等待真实案例证据补齐。",
    returnPath: "/storyboard-workbench",
    returnLabel: "进入分镜工作台",
    status: "draft",
    pinned: false,
    recommended: false,
    sortOrder: 20,
    visibility: "public",
    publishedAt: null,
    updatedAt: NOW,
    readMinutes: 3,
    mediaIds: ["generated-storyboard-video-v50"],
    coverMediaId: "generated-storyboard-video-v50",
  },
];

const SEED_CATALOG: HelpCatalog = {
  schemaVersion: HELP_CENTER_SCHEMA_VERSION,
  revision: 1,
  updatedAt: NOW,
  categories: CATEGORIES,
  media: MEDIA,
  articles: ARTICLES,
  history: [],
};

export function cloneHelpCatalog(catalog: HelpCatalog = SEED_CATALOG): HelpCatalog {
  return JSON.parse(JSON.stringify(catalog)) as HelpCatalog;
}

export function createSeedHelpCatalog(): HelpCatalog {
  return cloneHelpCatalog(SEED_CATALOG);
}

export function isSafeHelpAssetPath(path: string): boolean {
  return path === "" || (path.startsWith("/help/") && !path.includes("..") && !/[?#]/.test(path));
}

export function isSafeReturnPath(path: string): boolean {
  return /^\/[a-z0-9/_-]*(?:\?[a-z0-9_=&-]+)?$/i.test(path) && !path.startsWith("//");
}

function evidenceLabel(media: HelpMediaInternal): string {
  if (media.sourceKind === "generated_result") return "真实生成结果";
  if (media.sourceKind === "ui_capture") return "真实页面操作";
  if (media.sourceKind === "test_fixture") return "验收夹具（非真实案例）";
  return "等待真实素材";
}

export function articlePublicationIssues(article: HelpArticle, media: HelpMediaInternal[]): string[] {
  const issues: string[] = [];
  const selected = article.mediaIds.map((id) => media.find((item) => item.id === id)).filter(Boolean) as HelpMediaInternal[];
  if (!article.title.trim()) issues.push("缺少标题");
  if (!article.summary.trim()) issues.push("缺少摘要");
  if (!article.body.trim()) issues.push("缺少正文");
  if (!article.applicability.trim()) issues.push("缺少适用场景");
  if (article.preparation.length === 0) issues.push("缺少准备内容");
  if (article.steps.length === 0) issues.push("缺少步骤");
  if (!article.costAndWait.trim()) issues.push("缺少费用与等待说明");
  if (article.successCriteria.length === 0) issues.push("缺少成功判定");
  if (article.failures.length === 0) issues.push("缺少常见失败");
  if (!article.publishedAt || Number.isNaN(new Date(article.publishedAt).getTime())) issues.push("缺少有效发布时间");
  if (!isSafeReturnPath(article.returnPath)) issues.push("返回入口不是安全站内路径");
  if (article.mediaIds.length === 0) issues.push("缺少真实页面或真实生成媒体");
  if (selected.length !== article.mediaIds.length) issues.push("存在未登记媒体");
  if (selected.some((item) => item.verificationStatus !== "verified")) issues.push("存在未完成证据核验的媒体");
  if (selected.some((item) => !isSafeHelpAssetPath(item.assetPath) || !isSafeHelpAssetPath(item.posterPath) || !isSafeHelpAssetPath(item.captionsPath))) issues.push("媒体路径不安全");
  if (article.articleType === "case" && selected.some((item) => item.sourceKind !== "generated_result")) issues.push("案例只能使用真实生成结果");
  if (article.articleType === "case" && selected.some((item) => !item.trace.taskId && !item.trace.runId && !item.trace.historyId)) issues.push("案例缺少 task/run/history 追溯标识");
  return issues;
}

export function validateHelpCatalog(catalog: HelpCatalog): string[] {
  const issues: string[] = [];
  if (catalog.schemaVersion !== HELP_CENTER_SCHEMA_VERSION) issues.push("帮助中心数据版本不受支持");
  const slugs = new Set<string>();
  for (const article of catalog.articles) {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(article.slug)) issues.push(`${article.title || article.id} 的 slug 无效`);
    if (slugs.has(article.slug)) issues.push(`slug 重复：${article.slug}`);
    slugs.add(article.slug);
    if (article.status === "published") issues.push(...articlePublicationIssues(article, catalog.media).map((item) => `${article.title}：${item}`));
  }
  return issues;
}

export function normalizeHelpCatalog(value: unknown): HelpCatalog {
  if (!value || typeof value !== "object") return createSeedHelpCatalog();
  const source = value as Partial<HelpCatalog>;
  if (source.schemaVersion !== HELP_CENTER_SCHEMA_VERSION || !Array.isArray(source.articles) || !Array.isArray(source.media)) {
    return createSeedHelpCatalog();
  }
  return {
    schemaVersion: HELP_CENTER_SCHEMA_VERSION,
    revision: Math.max(1, Number(source.revision) || 1),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : NOW,
    categories: Array.isArray(source.categories) && source.categories.length ? source.categories : cloneHelpCatalog().categories,
    media: source.media,
    articles: source.articles,
    history: Array.isArray(source.history) ? source.history.slice(0, 60) : [],
  };
}

function canViewArticle(article: HelpArticle, viewer: { authenticated: boolean; admin: boolean }, now: Date): boolean {
  if (article.status !== "published") return false;
  if (!article.publishedAt || Number.isNaN(new Date(article.publishedAt).getTime()) || new Date(article.publishedAt) > now) return false;
  if (article.visibility === "admins") return viewer.admin;
  if (article.visibility === "authenticated") return viewer.authenticated;
  return true;
}

export function buildPublicHelpCatalog(
  catalog: HelpCatalog,
  viewer: { authenticated: boolean; admin: boolean },
  previewSlug = "",
  now = new Date(),
): PublicHelpCatalog {
  const requiredSlugs = new Set(REQUIRED_PUBLIC_ARTICLES.map((article) => article.slug));
  const articleSource = [
    ...catalog.articles.filter((article) => !requiredSlugs.has(article.slug)),
    ...REQUIRED_PUBLIC_ARTICLES,
  ];
  const previewArticle = previewSlug && viewer.admin
    ? articleSource.find((article) => article.slug === previewSlug)
    : undefined;
  const articles = previewArticle
    ? [previewArticle]
    : articleSource.filter((article) => canViewArticle(article, viewer, now));
  const mediaIds = new Set(articles.flatMap((article) => article.mediaIds));
  const media = catalog.media
    .filter((item) => mediaIds.has(item.id)
      && item.verificationStatus === "verified"
      && (item.sourceKind === "generated_result" || item.sourceKind === "ui_capture"))
    .map((mediaItem) => {
      const item: PublicHelpMedia = {
        id: mediaItem.id,
        title: mediaItem.title,
        kind: mediaItem.kind,
        sourceKind: mediaItem.sourceKind,
        assetPath: mediaItem.assetPath,
        posterPath: mediaItem.posterPath,
        captionsPath: mediaItem.captionsPath,
        alt: mediaItem.alt,
        textSummary: mediaItem.textSummary,
        aspectRatio: mediaItem.aspectRatio,
        generatedAt: mediaItem.generatedAt,
        publicModelName: mediaItem.publicModelName,
        sourcePage: mediaItem.sourcePage,
        promptSummary: mediaItem.promptSummary,
        parameters: mediaItem.parameters,
        evidenceLabel: evidenceLabel(mediaItem),
      };
      return item;
    });
  return {
    schemaVersion: catalog.schemaVersion,
    revision: catalog.revision,
    updatedAt: catalog.updatedAt,
    preview: Boolean(previewArticle),
    categories: [...catalog.categories].sort((a, b) => a.sortOrder - b.sortOrder),
    media,
    articles: [...articles].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.recommended) - Number(a.recommended) || a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, "zh-CN")),
  };
}
