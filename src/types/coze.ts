// 🔒 核心底层代码 — 锁定保护
//
// 本文件是核心类型定义，前后端数据契约。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #11 核心类型定义"。
//
// 锁定范围：整个文件
// 锁定原因：类型定义是前后端数据契约，修改字段会导致运行时错误
// 特别锁定：DEFAULT_CARD_LAYOUT / DEFAULT_PAGE_LAYOUT（主页布局配置）

// Coze API types

export interface CozeBot {
  bot_id: string;
  bot_name: string;
  description: string;
  icon_url: string;
  publish_status: string;
  version: string;
  create_time: number;
  update_time: number;
}

export interface CozeBotDetail {
  bot_id: string;
  bot_name: string;
  description: string;
  icon_url: string;
  prompt_info: string;
  plugin_info_list: Array<{
    plugin_id: string;
    name: string;
    description: string;
  }>;
  workflow_info_list: Array<{
    workflow_id: string;
    name: string;
    description: string;
  }>;
  knowledge: {
    knowledge_bases: Array<{
      knowledge_id: string;
      name: string;
    }>;
  };
  model_info: {
    model: string;
  };
}

export interface CozeConversation {
  id: string;
  bot_id: string;
  created_at: number;
  last_section_id: string;
  name: string;
}

export interface CozeMessage {
  id: string;
  conversation_id: string;
  bot_id: string;
  chat_id: string;
  role: "user" | "assistant";
  type: "answer" | "follow_up" | "verbose" | "function_call" | "function_output";
  content: string;
  content_type: string;
  created_at: number;
  updated_at: number;
}

export interface CozeChatResponse {
  id: string;
  conversation_id: string;
  bot_id: string;
  status: "created" | "in_progress" | "completed" | "failed" | "canceled";
}

// SSE event types
export interface CozeSSEEvent {
  event: string;
  data: string;
}

export interface CozeMessageDelta {
  id: string;
  conversation_id: string;
  bot_id: string;
  chat_id: string;
  role: string;
  type: string;
  content: string;
  reasoning_content: string;
  content_type: string;
  created_at: number;
}

// App-level types

export type AgentSource = "coze" | "coze_coding" | "llm";

export interface Agent {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  category: string;
  botId: string | null;
  source: AgentSource;
  isPinned?: boolean;
  is_active?: boolean;
  costPerMessage?: number;
  /** 基础费用积分（如生图固定10积分），0=纯token计费 */
  baseFee?: number;
  // 排序权重（越小越靠前，分类内排序依据）
  sort_order?: number;
  // 智能体访问控制
  user_access?: "available" | "hidden"; // available=用户可用, hidden=对用户隐藏
  // LLM-specific fields
  systemPrompt?: string;
  model?: string;
  // Coze Coding-specific fields
  cozeCodingApiUrl?: string;
  cozeCodingProjectId?: string;
  cozeCodingApiToken?: string;
  // 预设配置字段
  presetFields?: PresetField[];
  // 输出样式配置
  outputStyle?: OutputStyle;
  // 思考标记开关
  enableThinkTags?: boolean;
  // 智能体级LLM高级配置
  proxyUrl?: string;            // 指定代理地址（覆盖全局LLM_API_BASE_URL）
  proxy_url?: string;           // snake_case alias
  deepThinkingType?: number;    // 深度思考模式：0=不开启, 1=全局思考, 2=自带思考
  deep_thinking_type?: number;  // snake_case alias
  deductDeepThink?: number;     // 深度思考积分系数（开启后扣费=基础×系数）
  deduct_deep_think?: number;   // snake_case alias
  maxContextRounds?: number;    // 上下文轮次限制（0=不限，默认30）
  max_context_rounds?: number;  // snake_case alias
  maxContextTokens?: number;    // 上下文Tokens限制（0=不限，默认0由模型窗口决定）
  max_context_tokens?: number;  // snake_case alias
  maxReplyTokens?: number;      // 回复Tokens限制（0=不限，默认16384）
  max_reply_tokens?: number;    // snake_case alias
  timeout?: number;             // 调用超时时间秒（默认300）
  enableWebSearch?: boolean;    // 联网搜索开关
  enable_web_search?: boolean;  // snake_case alias
  temperature?: number;         // 生成温度 0-2，默认不传(使用模型默认值)
  responseFormat?: "text" | "markdown" | "json_object";  // 输出格式约束
  response_format?: "text" | "markdown" | "json_object"; // snake_case alias
  // 智能体级独立Token计费字段（已废弃，保留兼容计费引擎）
  token_billing_enabled?: boolean;   // 是否启用独立token计费（false=走全局配置）
  input_cost_per_million?: number;   // 输入成本（元/百万token）
  output_cost_per_million?: number;  // 输出成本（元/百万token）
  cached_cost_per_million?: number;  // 缓存成本（元/百万token）
  profit_margin?: number;            // 利润率%（如50表示50%利润）
  token_rounding_unit?: number;      // token取整单位（0=不取整）
  // 关联的LLM模型预设
  model_id?: string;                   // 关联的llm_models预设ID，从模型管理中选择
  model_public_id?: string;            // 公开模型目录中的精确绑定标识
  // 关联模型计费信息（前端展示用，由/api/bots填充）
  model_billing?: {
    token_billing_enabled: boolean;    // 模型是否启用了token计费
    cost_per_use?: number;             // 模型每次使用费用
    cost_price?: number;               // 模型进货价
  } | null;
  cover_url?: string;                  // 应用背景图URL
  guideMessage?: string;               // 聊天界面引导语
  guide_message?: string;              // snake_case alias
}

export interface Conversation {
  id: string;
  botId: string | null;
  agentId: string;
  agentName: string;
  agentIconUrl: string;
  title: string;
  lastMessage: string;
  lastMessageTime: number;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  messagesLoaded?: boolean; // true if messages have been loaded from server (lazy loading)
  dirty?: boolean; // true if this conversation has unsynced changes (incremental sync)
  source?: string; // "llm" | "coze" | "coze_coding" — agent source type
  modelOverride?: string; // 用户切换的模型名称，记忆功能：切回会话时恢复
  type?: "chat" | "video"; // chat=普通对话, video=视频任务记录
  videoTaskId?: string; // 关联的 video_tasks 表 ID（type=video 时）
  videoModelName?: string; // 视频模型名称（type=video 时，用于侧边栏显示）
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  displayContent?: string; // 前端展示内容（与 content 不同时，content 用于 API 发送，displayContent 用于界面显示）
  agentId?: string;
  agentName?: string;
  agentIconUrl?: string;
  timestamp: number;
  isStreaming?: boolean;
  streamStatus?: string; // 长耗时流的实时阶段/已接收进度，不混入最终正文
  reasoningContent?: string;
  images?: string[]; // 图片 URL 列表
  // 生图模型输出（model_type=drawing 时使用）
  generatedImages?: {
    url: string;
    width?: number;
    height?: number;
    revisedPrompt?: string;
    order?: number;
    label?: string;
    title?: string;
    sourcePrompt?: string;
    filename?: string;
  }[];
  // 视频任务关联字段（source=video 时使用）
  videoTaskId?: string;
  videoModelId?: string;
  videoStatus?: string; // processing / completed / failed
  videoUrl?: string;
  // 发送失败标记（LLM/Coze API 完全失败时标记用户消息）
  error?: string; // 错误提示文本，非空表示发送失败
}

// Credits / Points system
export interface CreditsInfo {
  total: number;        // 总积分
  used: number;         // 已消耗
  remaining: number;    // 剩余
  costPerMessage: number; // 每次对话消耗
}

export interface CreditsTransaction {
  id: string;
  type: "recharge" | "consume";
  amount: number;
  description: string;
  timestamp: number;
  balanceAfter: number;
}

export interface AgentCategory {
  id: string;
  name: string;
  icon?: string;
  visibility?: "normal" | "view_only" | "private"; // normal=正常, view_only=用户可见不可用, private=仅管理员可见
}

// Preset field configuration for agent dialog
export interface PresetField {
  id: string;
  label: string;           // 字段标签（用户看到的弹窗描述文案）
  type: "text" | "select" | "textarea"; // text=文本输入, select=下拉选择, textarea=多行文本(粘贴内容)
  placeholder: string;     // 占位提示文字
  required: boolean;       // 是否必填
  options: string[];       // select 类型的预设选项
  order: number;           // 排序序号
  contentPrefix?: string;  // 隐藏前缀：发送时自动在用户内容前追加此文本。如"文案如下："，最终发送"文案如下：[用户内容]"（紧凑拼接，无额外换行）。不填则只发送用户内容
  sendLabel?: boolean;     // 是否发送label：true=发送label作为前缀（如"视频风格：3D卡通"），false=只发送用户输入的值
  sendText?: string;       // 自定义发送文案：当sendLabel=false时可设置替代label的发送文本。如label显示"选择风格"，但发送"视频风格"
  description?: string;    // 字段说明（弹窗中显示在输入框下方的小字提示）
  defaultValue?: string;   // 可选默认值；未配置时保持空值
}

// Card layout configuration - 管理员可自定义卡片布局
export interface CardLayoutConfig {
  // 卡片尺寸
  cardWidth: number;         // 卡片宽度(px), 0=自适应
  cardMinWidth: number;      // 卡片最小宽度(px), 用于网格 minmax, 0=自动计算
  cardHeight: number;        // 卡片高度(px), 0=自适应
  columns: number;           // 一行列数 (2-6)

  // 头像设置
  avatarSize: number;        // 头像大小(px)，向后兼容，当 avatarWidth/Height 未设置时使用
  avatarWidth: number;       // 头像宽度(px)，0=使用avatarSize
  avatarHeight: number;      // 头像高度(px)，0=使用avatarSize
  avatarPosition: "left" | "right" | "top" | "top-center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"; // 头像位置
  avatarRadius: number;      // 头像圆角(px)

  // 字体设置
  titleFontSize: number;     // 标题字号(px)
  titleFontWeight: number;   // 标题粗细 (300-900)
  titleColor: string;        // 标题颜色
  titleLetterSpacing: number;// 标题字距(px)
  titleFontFamily: string;   // 标题字体(预设字体ID)
  descFontSize: number;      // 描述字号(px)
  descFontWeight: number;    // 描述粗细
  descColor: string;         // 描述颜色
  descLetterSpacing: number; // 描述字距(px)
  descMaxLines: number;      // 描述最大行数
  descLineHeight: number;    // 描述行高(倍数, 如1.6)

  // 标题位置偏移（独立于整体文字偏移）
  titleOffsetX: number;      // 标题水平偏移(px), 正=右移, 负=左移
  titleOffsetY: number;      // 标题垂直偏移(px), 正=下移, 负=上移

  // 文字位置偏移
  textOffsetX: number;       // 文字水平偏移(px), 正=右移, 负=左移
  textOffsetY: number;       // 文字垂直偏移(px), 正=下移, 负=上移

  // 间距设置
  gapX: number;              // 水平间距(px)
  gapY: number;              // 垂直间距(px)
  paddingX: number;          // 卡片内左右padding(px)
  paddingY: number;          // 卡片内上下padding(px)

  // 对齐与样式
  alignment: "left" | "center" | "stretch"; // 卡片对齐方式
  borderRadius: number;      // 卡片圆角(px)
  showShadow: boolean;       // 是否显示阴影
  cardBg: string;            // 卡片背景色
  opacity: number;           // 卡片透明度(30-100, 百分比)
}

// 导航栏布局配置
export interface NavLayoutConfig {
  fontSize: number;           // 标题字号(px)
  descFontSize: number;       // 描述字号(px)
  iconSize: number;           // 图标大小(px)
  buttonPaddingX: number;     // 按钮水平内边距(px)
  buttonPaddingY: number;     // 按钮垂直内边距(px)
  buttonGap: number;          // 按钮间距(px)
  buttonBorderRadius: number; // 按钮圆角(px)
  containerPaddingX: number;  // 容器水平内边距(px)
  containerPaddingY: number;  // 容器垂直内边距(px)
}

// 分类栏布局配置
export interface CategoryLayoutConfig {
  fontSize: number;           // 标签字号(px)
  tagPaddingX: number;        // 标签水平内边距(px)
  tagPaddingY: number;        // 标签垂直内边距(px)
  tagGap: number;             // 标签间距(px)
  tagBorderRadius: number;    // 标签圆角(px)
}

// 完整页面布局配置
export interface PageLayoutConfig {
  card: CardLayoutConfig;
  nav: NavLayoutConfig;
  category: CategoryLayoutConfig;
  /** 按分类 ID 的独立覆盖配置，key=分类ID, value=覆盖的卡片配置（仅存差异项） */
  categoryOverrides?: Record<string, Partial<CardLayoutConfig>>;
}

// 默认导航栏布局 — 今天的配置快照（2026-06-07 锁定） 2026-07-26 高级感升级
export const DEFAULT_NAV_LAYOUT: NavLayoutConfig = {
  fontSize: 15,
  descFontSize: 11,
  iconSize: 20,
  buttonPaddingX: 18,
  buttonPaddingY: 9,
  buttonGap: 8,
  buttonBorderRadius: 12,
  containerPaddingX: 8,
  containerPaddingY: 8,
};

// 默认分类栏布局 — 今天的配置快照（2026-06-07 锁定） 2026-07-27 融合方案
export const DEFAULT_CATEGORY_LAYOUT: CategoryLayoutConfig = {
  fontSize: 14,        // 13 → 14（更精致）
  tagPaddingX: 14,     // 16 → 14（紧凑）
  tagPaddingY: 7,      // 3 → 7（增加呼吸感）
  tagGap: 4,
  tagBorderRadius: 8,  // 30 → 8（圆角矩形，非 pill）
};

// 默认卡片布局配置
// 默认卡片布局 — 今天的配置快照（2026-06-07 锁定）
export const DEFAULT_CARD_LAYOUT: CardLayoutConfig = {
  cardWidth: 0,
  cardMinWidth: 0,
  cardHeight: 90,
  columns: 4,
  avatarSize: 56,
  avatarWidth: 81,
  avatarHeight: 87,
  avatarPosition: "left",
  avatarRadius: 18,
  titleFontSize: 21,
  titleFontWeight: 600,
  titleColor: "",
  titleLetterSpacing: 0,
  titleFontFamily: "",
  descFontSize: 13,
  descFontWeight: 400,
  descColor: "#666666",
  descLetterSpacing: 0,
  descMaxLines: 3,
  descLineHeight: 1.5,
  titleOffsetX: 0,
  titleOffsetY: 0,
  textOffsetX: 0,
  textOffsetY: 0,
  gapX: 12,
  gapY: 10,
  paddingX: 14,
  paddingY: 5,
  alignment: "left",
  borderRadius: 12,
  showShadow: false,
  cardBg: "",
  opacity: 100,
};

// 默认页面布局（包含所有区域）
export const DEFAULT_PAGE_LAYOUT: PageLayoutConfig = {
  card: DEFAULT_CARD_LAYOUT,
  nav: DEFAULT_NAV_LAYOUT,
  category: DEFAULT_CATEGORY_LAYOUT,
};

// 标题预设字体 — 15种精选字体
export const TITLE_FONT_PRESETS = [
  { id: "noto-serif-sc",       name: "思源宋体",     family: "'Noto Serif SC', 'Source Han Serif SC', 'STSong', 'SimSun', serif" },
  { id: "noto-sans-sc",        name: "思源黑体",     family: "'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { id: "lxgw-wenkai",         name: "霞鹜文楷",     family: "'LXGW WenKai TC', 'LXGW WenKai', 'KaiTi', 'STKaiti', serif" },
  { id: "ma-shan-zheng",       name: "马善政楷体",   family: "'Ma Shan Zheng', 'STKaiti', cursive" },
  { id: "zcool-xiaowei",       name: "站酷小薇体",   family: "'ZCOOL XiaoWei', 'STKaiti', serif" },
  { id: "zcool-kuaile",        name: "站酷快乐体",   family: "'ZCOOL KuaiLe', 'STKaiti', cursive" },
  { id: "zcool-qingke",        name: "站酷庆科黄油", family: "'ZCOOL QingKe HuangYou', 'STKaiti', cursive" },
  { id: "long-cang",           name: "龙藏体",       family: "'Long Cang', 'STKaiti', cursive" },
  { id: "zhi-mang-xing",       name: "志芒行书",     family: "'Zhi Mang Xing', 'STXingkai', cursive" },
  { id: "liu-jian-mao-cao",    name: "柳检毛草",     family: "'Liu Jian Mao Cao', 'STCaoshu', cursive" },
  { id: "kai-ti",              name: "楷体",         family: "'KaiTi', 'STKaiti', '楷体_GB2312', serif" },
  { id: "fang-song",           name: "仿宋体",       family: "'FangSong', 'STFangsong', serif" },
  { id: "deng-xian",           name: "等线体",       family: "'DengXian', '等线', sans-serif" },
  { id: "song-ti",             name: "宋体",         family: "'SimSun', 'STSong', '宋体', serif" },
  { id: "hei-ti",              name: "黑体",         family: "'SimHei', 'STHeiti', '黑体', sans-serif" },
] as const;

// 根据 ID 获取字体 family 字符串
export function getTitleFontFamily(fontId: string | null | undefined): string | undefined {
  if (!fontId) return undefined;
  return TITLE_FONT_PRESETS.find(f => f.id === fontId)?.family;
}

// Video generation types
export interface VideoModel {
  id: string;
  name: string;
  displayName?: string;
  variantLabel?: string;
  avatarUrl?: string;
  provider: string;
  apiEndpoint?: string;
  apiKey?: string;
  protocolType: string;
  requestTemplate?: Record<string, unknown>;
  responseMapping?: Record<string, unknown>;
  pricePerUse: number;
  currency: string;
  durationSeconds: number;
  maxDuration: number;
  minDuration?: number;
  durationMode?: "fixed" | "discrete" | "range";
  nativeDurations?: number[];
  durationStep?: number;
  supportsImageInput: boolean;
  /** 该模型必须提供参考图片才能提交 */
  requiresImage?: boolean;
  /** 该模型需要源视频URL（如视频编辑模型） */
  requiresSourceVideo?: boolean;
  /** 该模型可选接收源视频；必填模型也必须为 true。 */
  supportsSourceVideoInput?: boolean;
  /** 分辨率层级（如 "720p"/"1080p"），部分模型需要此参数 */
  resolutionTier?: string;
  resolutionOptions?: string[];
  defaultResolution?: string;
  /** UI 显示标签，格式为 resolution=label；提交仍使用原始 resolution ID。 */
  resolutionLabels?: string[];
  /** 直接实测组合，格式为 resolution|duration|aspectRatio。 */
  directVerifiedCombinations?: string[];
  verificationNotice?: string;
  resolutionPrices?: Record<string, number>;
  aspectRatios?: string[];
  /** 每个任务最多可提交的参考图数量。 */
  maxReferenceImages?: number;
  /** 工作流输入语义，供视频制作页只展示真正支持的输入控件。 */
  workflowInputMode?: "text" | "multi_image" | "first_last_frame" | "image_audio_lipsync" | "multi_image_audio" | "flexible_image";
  supportsPrompt?: boolean;
  requiresFirstFrame?: boolean;
  requiresLastFrame?: boolean;
  /** 服务端已经统一判定的输入控件展示语义。 */
  showFirstFrame?: boolean;
  showLastFrame?: boolean;
  showReferenceImages?: boolean;
  showAudioInputs?: boolean;
  minReferenceImages?: number;
  /** 是否支持参考音频。 */
  supportsAudioInput?: boolean;
  /** 每个任务最多可提交的参考音频数量。 */
  maxReferenceAudios?: number;
  minReferenceAudios?: number;
  /** per_use=按次，output_second=按输出视频秒数。 */
  billingUnit?: "per_use" | "output_second";
  /** 模型可出现的工作台；video-edit 表示可用于重生成编辑素材。 */
  workspaceSurfaces?: string[];
  /** 上游是否提供真正的远程取消，false 时不能把“停止等待”伪装成取消计费。 */
  supportsRemoteCancel?: boolean;
  /** 是否允许用户显式选择生成声音或静音；仅由服务端模型协议能力公开。 */
  supportsGenerateAudioToggle?: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  /** 代理平台的实际模型名（如 grok-video-3-10s） */
  modelName?: string;
  /** 成功率（-1=无数据） */
  successRate?: number;
  /** 总请求数 */
  totalRequests?: number;
  /** 成功次数 */
  successCount?: number;
  /** 失败次数 */
  failCount?: number;
  /** 最近成功时间 */
  lastSuccessAt?: string | null;
}

export interface VideoTask {
  canRetry?: boolean;
  clientRequestId?: string;
  clientRequestFingerprint?: string;
  id: string;
  userId: string;
  modelId: string;
  publicModelId?: string;
  followsSourceDuration?: boolean;
  supportsRemoteCancel?: boolean;
  taskLabel: string;
  prompt: string;
  firstFrameUrl: string;
  lastFrameUrl: string;
  referenceImageUrl: string;
  aspectRatio: string;
  resolution: string;
  durationSeconds: number;
  status: "pending" | "queued" | "processing" | "finalizing" | "completed" | "failed" | "cancelled";
  taskIdExternal: string;
  videoUrl: string;
  storageUrl: string;
  thumbnailUrl: string;
  errorMessage: string;
  priceCharged: number;
  billingState?: string;
  createdAt: string;
  completedAt: string | null;
  // joined
  modelName?: string;
  // batch fields
  batchId?: string;
  batchTopic?: string;
  cardIndex?: number;
  needsProxy?: boolean;
}

export const VIDEO_ASPECT_RATIOS = [
  { label: "横屏 16:9", value: "16:9" },
  { label: "竖屏 9:16", value: "9:16" },
] as const;

// 智能体输出样式配置
export interface OutputStyle {
  // 文字
  fontSize?: number;            // 12-20px，默认14
  fontFamily?: "system" | "serif" | "sans-serif" | "monospace";  // 字体族
  lineHeight?: number;          // 1.4-2.4，默认1.8
  headingColor?: string;        // 标题颜色，默认主题色
  headingWeight?: number;       // 标题字重 400-900，默认700

  // 间距
  paragraphSpacing?: number;    // 段间距 8-32px，默认16
  firstLineIndent?: boolean;    // 首行缩进，默认false
  contentPadding?: number;      // 内容区内边距 8-32px，默认16

  // 分割与对齐
  dividerStyle?: "none" | "solid" | "dashed" | "dotted";  // 分割线样式
  textAlign?: "left" | "center" | "justify";               // 文字对齐

  // 列表样式
  listStyle?: "decimal" | "disc" | "square";  // 序号样式

  // 引用块样式
  quoteStyle?: "border" | "background" | "card";  // 引用块样式

  // 标签贴纸
  tags?: Array<{ text: string; color: string; }>;  // 预设标签

  // 深度思考展示
  showReasoning?: boolean;  // 开启深度思考折叠展示，默认false

  // 综合智能体：附加生图模型配置。保存在 output_style 内，避免新增数据库字段。
  hybridImageGeneration?: {
    enabled?: boolean;
    model?: string;
    modelId?: string;
    routingMode?: "auto" | "manual" | "always";
    defaultCount?: number;
  };
}

// 默认输出样式
export const DEFAULT_OUTPUT_STYLE: OutputStyle = {
  fontSize: 14,
  fontFamily: "system",
  lineHeight: 1.8,
  headingColor: "var(--primary)",
  headingWeight: 700,
  paragraphSpacing: 16,
  firstLineIndent: false,
  contentPadding: 16,
  dividerStyle: "dashed",
  textAlign: "left",
  listStyle: "decimal",
  quoteStyle: "border",
  tags: [],
};

// 类型别名，方便使用
export type CardLayout = CardLayoutConfig;

// Auth types
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "student";
  credits: number;
  isActive: boolean;
  allowedCategories: string[] | null; // 非管理员显式允许的导航ID；空/缺失=无权限，管理员为 null（全权限）
  memberStatus?: "inactive" | "trial" | "active" | "expired"; // 会员状态
  email?: string;
  phone?: string;
  avatarUrl?: string;
  themePreference?: string | null; // 通过 user + IP + 七天租约验证后的主题；null=跟随平台默认
  themeModePreference?: "system" | "light" | "dark" | null;
  themePreferenceExpiresAt?: string | null;
  themePreferenceStatus?: "active" | "none" | "expired" | "ip_changed" | "storage_unavailable";
  hasPassword?: boolean; // 是否已设置密码（无密码用户需引导设置）
}

// 试用套餐
export interface TrialPlan {
  id: string;
  name: string;
  description: string;
  credits: number;
  duration_days: number;
  is_active: boolean;
  sort_order: number;
  agent_ids?: string[]; // 包含的智能体ID列表
  created_at?: string;
  updated_at?: string;
}

// 用户试用激活记录
export interface UserTrialActivation {
  id: string;
  user_id: string;
  plan_id: string;
  activated_at: string;
  expires_at: string;
  credits_granted: number;
  is_active: boolean;
}

export interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
}
