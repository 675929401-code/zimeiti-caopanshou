import {
  YOUCAI_SKILL_CATALOG,
  inferYoucaiSkill,
  parseYoucaiSkillInvocation,
  type YoucaiSkillCategory,
  type YoucaiSkillDefinition,
} from "./youcai-skill-catalog";

export const YOUCAI_SKILL_RUNTIME_SCHEMA_VERSION = "2026-08-27.public-contract-v1";
export const YOUCAI_FIXED_OSS_COMMIT = "4f318097c54a2e24ea34d3c9d23d30f5ec332f11";

export type YoucaiSkillProvenance =
  | "oss_public_source"
  | "public_contract_reimplementation"
  | "internal_original";

export type YoucaiSkillOutputKind = "prompt" | "structured_result" | "tool_proposal";
export type YoucaiSkillToolKind = "image" | "video" | "audio" | "music";
export type YoucaiSkillExecutionMode =
  | "explicit_and_automatic"
  | "explicit_only_until_user_enables";

export interface YoucaiSkillInputProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: readonly (string | number | boolean)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: YoucaiSkillInputProperty;
}

export interface YoucaiSkillInputSchema {
  type: "object";
  properties: Readonly<Record<string, YoucaiSkillInputProperty>>;
  required: readonly string[];
  additionalProperties: false;
}

export interface YoucaiSkillOutputContract {
  primaryKind: YoucaiSkillOutputKind;
  allowedKinds: readonly YoucaiSkillOutputKind[];
  format: "text" | "json";
  strict: boolean;
  description: string;
  exactRootKeys?: readonly string[];
  constraints: readonly string[];
}

export interface YoucaiSkillResource {
  path: string;
  purpose: string;
  evidence: "public_source" | "public_metadata";
}

export interface YoucaiSkillFixedSource {
  repository: "oiuv/ai-short-drama";
  commit: typeof YOUCAI_FIXED_OSS_COMMIT;
  path: string;
  url: string;
  sha256: string;
}

export interface YoucaiSkillPermissions {
  readUserText: true;
  readAttachments: boolean;
  toolProposalKinds: readonly YoucaiSkillToolKind[];
  directExecution: false;
  paidTools: {
    directExecution: false;
    requiresExplicitAuthorization: true;
    requiresModelSelection: true;
    requiresPricePreview: true;
  };
}

export interface YoucaiSkillRuntimeDefinition {
  id: string;
  commandName: string;
  title: string;
  version: string;
  category: YoucaiSkillCategory;
  publicStoreId: string;
  provenance: YoucaiSkillProvenance;
  sourceDisclosure: string;
  fixedSource?: YoucaiSkillFixedSource;
  inputSchema: YoucaiSkillInputSchema;
  outputContract: YoucaiSkillOutputContract;
  resources: readonly YoucaiSkillResource[];
  permissions: YoucaiSkillPermissions;
  executionMode: YoucaiSkillExecutionMode;
  invocation: {
    commandName: string;
    explicitCommandPriority: true;
    unknownExplicitCommand: "reject";
    automaticEligibleByDefault: boolean;
  };
  qualityGates: readonly string[];
}

function text(
  description: string,
  options: { enum?: readonly string[]; default?: string } = {},
): YoucaiSkillInputProperty {
  return { type: "string", description, ...options };
}

function integer(
  description: string,
  options: { default?: number; minimum?: number; maximum?: number } = {},
): YoucaiSkillInputProperty {
  return { type: "integer", description, ...options };
}

function bool(description: string, defaultValue?: boolean): YoucaiSkillInputProperty {
  return {
    type: "boolean",
    description,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

function textList(description: string): YoucaiSkillInputProperty {
  return { type: "array", description, items: text("条目") };
}

function schema(
  properties: Readonly<Record<string, YoucaiSkillInputProperty>>,
  required: readonly string[] = [],
): YoucaiSkillInputSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const EMPTY_SCHEMA = schema({});

const INPUT_SCHEMAS: Readonly<Record<string, YoucaiSkillInputSchema>> = {
  "skill-creator": schema({
    mode: text("工作模式", { enum: ["create", "adapt", "improve", "catalog"] }),
    request: text("希望创建、适配、改进或盘点的 Skill 需求"),
    sourceSkill: text("可选的公开或用户提供来源 Skill"),
    sourceResources: text("可选的来源资源清单"),
    scanReport: text("可选的现有目录扫描结果"),
  }, ["mode", "request"]),
  "ad-script-master": schema({
    brief: text("广告任务简报"),
    objective: text("传播目标", { enum: ["auto", "awareness", "consideration", "leads", "conversion", "download", "sales"], default: "auto" }),
    duration: text("目标时长"),
    platform: text("发布平台"),
    audience: text("目标人群"),
    market: text("市场或地区"),
    targetVideoModel: text("目标视频模型"),
    outputDepth: text("输出深度", { enum: ["quick", "standard", "production"], default: "standard" }),
    requirements: text("其他限制"),
  }, ["brief"]),
  "drama-shot-prompt": schema({
    mode: text("创建或优化模式"),
    episodeContent: text("本集剧情内容"),
    episodeNumber: integer("集数", { minimum: 1 }),
    characters: text("角色资料"),
    scenes: text("场景资料"),
    props: text("道具资料"),
    videoStyle: text("视频风格"),
    videoRatio: text("画幅比例"),
    currentShotPrompt: text("待优化镜头提示词"),
    currentShotDuration: integer("待优化镜头时长", { minimum: 1 }),
    currentShotContext: text("待优化镜头上下文"),
    optimizationRequirement: text("优化要求"),
  }, ["episodeContent", "episodeNumber", "characters", "scenes"]),
  "film-asset-design": schema({ query: text("角色、场景或道具设计任务") }),
  "drama-script": schema({
    theme: text("主题", { enum: ["两性主题", "暴力主题", "优势主题", "复仇主题"] }),
    genre: text("频道", { enum: ["auto", "男频", "女频"], default: "auto" }),
    storyTone: text("基调", { enum: ["爽", "甜", "虐", "悬疑"], default: "爽" }),
    detail: text("详细需求"),
    episodes: integer("本次生成集数", { default: 5, minimum: 1 }),
    totalEpisodes: integer("规划总集数", { minimum: 1 }),
    isFinale: bool("是否完结", false),
    existingEpisodes: integer("已有集数", { default: 0, minimum: 0 }),
  }, ["theme"]),
  "video-prompt": schema({
    description: text("视频内容或脚本"),
    videoStyle: text("视频风格", { enum: ["", "cinematic", "korean-drama", "japanese-drama", "ancient-romance", "palace-drama", "wuxia", "suspense", "hongkong-90s", "retro-film", "rural-period-realism", "cyberpunk", "war-epic", "western-wilderness", "classic-black-white", "horror-film", "retro-atomic-punk", "chinese-anime", "anime-japanese", "shanghai-animation", "american-cartoon-2d", "ink-wash", "pixel-art", "dark-comic", "black-white-comic", "cinematic-painterly", "shonen-anime", "crayon-illustration", "shadow-puppet", "3d-chinese", "3d-cartoon", "3d-american", "clay-motion", "stop-motion", "ue5-realistic", "stylized-3d", "cel-shaded-3d", "miniature-3d", "designer-toy-3d", "victorian-dark-fantasy"] }),
    duration: text("时长", { enum: ["auto", "3s", "4s", "5s", "6s", "7s", "8s", "9s", "10s", "11s", "12s", "13s", "14s", "15s"], default: "auto" }),
    enableTimestamp: bool("是否输出时间轴", false),
  }, ["description"]),
  "h3-prompt-writing": EMPTY_SCHEMA,
  "seedance-20": EMPTY_SCHEMA,
  "sd2-pe": EMPTY_SCHEMA,
  "sd25-pe": EMPTY_SCHEMA,
  "poster-design": schema({
    brief: text("海报任务简报"),
    subtype: text("海报类型", { enum: ["auto", "xiaohongshu-cover", "wechat-cover", "weibo-banner", "story-vertical", "movie-poster", "event-poster", "music-festival-poster", "magazine-cover", "book-cover", "album-cover", "ad-banner", "promo-poster"], default: "auto" }),
    platform: text("目标平台"),
    aspectRatio: text("画幅比例"),
    exactCopy: text("必须原样出现的文案"),
    requirements: text("其他限制"),
  }, ["brief"]),
  "script-rewrite": schema({
    sourceContent: text("待改编内容"),
    scriptType: text("剧本类型", { enum: ["爽剧", "短剧"] }),
    title: text("可选标题"),
  }, ["sourceContent", "scriptType"]),
  "script-brief": schema({
    description: text("故事构想"),
    scriptType: text("剧本类型", { enum: ["爽剧", "短剧"] }),
    genre: text("题材", { enum: ["auto", "爱情", "复仇", "悬疑", "成长", "冒险", "喜剧", "励志", "奇幻", "科幻", "家庭", "职场", "校园", "历史"], default: "auto" }),
  }, ["description", "scriptType"]),
  "image-prompt": schema({
    mode: text("工作模式", { enum: ["text-to-prompt", "image-to-prompt"], default: "text-to-prompt" }),
    description: text("画面描述"),
    style: text("目标风格"),
    imageUrl: text("参考图 URL 或项目内资产引用"),
    detailLevel: text("详细程度", { enum: ["brief", "standard", "detailed"], default: "standard" }),
    targetModel: text("目标模型", { enum: ["gpt-image-2", "gemini-banana", "seedream", "universal"], default: "universal" }),
  }, ["mode", "detailLevel"]),
  "platform-help": EMPTY_SCHEMA,
  "social-content-optimizer": EMPTY_SCHEMA,
  "video-deconstruct-analyzer": schema({ query: text("公开视频或用户提供素材的分析任务") }),
  "general-script": schema({
    creationType: text("创作方式", { enum: ["原创", "改编"] }),
    sourceContent: text("改编来源"),
    targetAudience: text("目标受众", { enum: ["全年龄", "儿童", "青少年", "成人"], default: "全年龄" }),
    storyTone: text("故事基调", { enum: ["温馨", "悬疑", "幽默", "励志", "冒险", "自定义"], default: "温馨" }),
    detail: text("详细需求"),
    episodes: integer("本次生成集数", { default: 0, minimum: 0 }),
    totalEpisodes: integer("规划总集数", { minimum: 1 }),
    isFinale: bool("是否完结", false),
    existingEpisodes: integer("已有集数", { default: 0, minimum: 0 }),
  }, ["creationType"]),
  "music-prompt": schema({
    description: text("歌曲或配乐需求"),
    taskType: text("任务类型", { enum: ["auto", "full-song", "lyrics-only", "lyrics-edit", "music-prompt", "instrumental", "soundtrack"], default: "auto" }),
    existingLyrics: text("待修改歌词"),
    language: text("语言"),
  }, ["description"]),
  "audio-prompt": schema({
    description: text("音频需求"),
    style: text("音频场景", { enum: ["auto", "影视剧情", "有声书", "播客对谈", "广告配音", "多语种", "时间轴控制", "游戏音效"], default: "auto" }),
  }, ["description"]),
  "skill-assistant": schema({ query: text("Skill 选择、安装、调用或编排问题") }),
  "ip-toy-grid-motion": schema({
    request: text("六宫格静态与动态海报需求"),
    referenceAssetIds: textList("用户拥有的角色或产品参考资产 ID"),
    aspectRatio: text("画幅比例"),
    duration: text("动态版本时长"),
  }, ["request", "referenceAssetIds"]),
  "poster-motion-planner": schema({
    request: text("动态海报目标"), posterAssetId: text("用户拥有的海报资产 ID"), duration: text("目标时长"),
  }, ["request", "posterAssetId"]),
  "dot-matrix-brand-wordmark-motion": schema({
    request: text("点阵品牌字标动效需求"), brandAssetIds: textList("用户拥有的品牌资产 ID"), exactCopy: text("必须原样保留的品牌文字"), duration: text("目标时长"),
  }, ["request", "brandAssetIds"]),
  "fpv-tour-video-generator": schema({
    request: text("FPV 穿越叙事与路径"), sceneAssetIds: textList("用户拥有的场景资产 ID"), characterAssetIds: textList("可选角色资产 ID"), duration: text("目标时长"),
  }, ["request", "sceneAssetIds"]),
  storyboard: schema({
    story: text("故事、文案或创意"), panelCount: integer("宫格数量", { default: 9, minimum: 4, maximum: 25 }), aspectRatio: text("画幅比例"), referenceAssetIds: textList("可选参考资产 ID"),
  }, ["story"]),
  "film-reference-prompt-writer": schema({
    request: text("电影视觉参考目标"), referenceAssetIds: textList("可选参考资产 ID"), filmTitle: text("可选公开片名参考"), targetMedium: text("交付媒介", { enum: ["image", "video", "both"], default: "both" }),
  }, ["request"]),
  "voiceover-direction": schema({ script: text("待配音文案"), voiceProfile: text("目标声线"), constraints: text("禁用项和其他限制") }, ["script"]),
  "transcript-broll-planner": schema({ transcript: text("口播或采访逐字稿"), duration: text("成片时长"), assetHints: text("已有素材线索") }, ["transcript"]),
  "multi-platform-image-prompts": schema({ request: text("图片传播任务"), platforms: textList("目标平台"), referenceAssetIds: textList("可选参考资产 ID") }, ["request", "platforms"]),
  "paper-art-explainer": schema({ topic: text("科普或故事主题"), audience: text("目标人群"), duration: text("目标时长") }, ["topic"]),
  "outdoor-ad-prompt": schema({ brief: text("户外广告简报"), placement: text("媒介和空间位置"), exactCopy: text("必须原样出现的文案"), referenceAssetIds: textList("品牌或产品资产 ID") }, ["brief", "placement"]),
  "minimalist-product-ad": schema({ brief: text("产品广告简报"), productAssetIds: textList("用户拥有的产品资产 ID"), duration: text("目标时长") }, ["brief", "productAssetIds"]),
  "micro-expression-video-prompt": schema({ scene: text("剧情与关系"), characterAssetIds: textList("角色参考资产 ID"), duration: text("目标时长") }, ["scene"]),
  "handdrawn-live-video-prompt": schema({ request: text("手绘实体融入实拍的任务"), referenceAssetIds: textList("参考资产 ID"), duration: text("目标时长") }, ["request"]),
  "ecommerce-image": schema({ brief: text("电商视觉简报"), productAssetIds: textList("用户拥有的商品资产 ID"), imageCount: integer("图片数量", { default: 6, minimum: 1, maximum: 20 }) }, ["brief", "productAssetIds"]),
};

const FIXED_OSS_SOURCES: Readonly<Record<string, YoucaiSkillFixedSource>> = {
  "drama-script": {
    repository: "oiuv/ai-short-drama", commit: YOUCAI_FIXED_OSS_COMMIT,
    path: "skills/drama-script/SKILL.md",
    url: `https://github.com/oiuv/ai-short-drama/blob/${YOUCAI_FIXED_OSS_COMMIT}/skills/drama-script/SKILL.md`,
    sha256: "81A9C36881B839AC1EDA286C2229B32A2A16E11A3C8E2D8EAC62E532D4BAE254",
  },
  "drama-shot-prompt": {
    repository: "oiuv/ai-short-drama", commit: YOUCAI_FIXED_OSS_COMMIT,
    path: "skills/drama-shot-prompt/SKILL.md",
    url: `https://github.com/oiuv/ai-short-drama/blob/${YOUCAI_FIXED_OSS_COMMIT}/skills/drama-shot-prompt/SKILL.md`,
    sha256: "381197BCE8B535BA8B2E745605263C0169615E0BFD8D0545A6F50B3074CE7E53",
  },
  "script-brief": {
    repository: "oiuv/ai-short-drama", commit: YOUCAI_FIXED_OSS_COMMIT,
    path: "skills/script-brief/SKILL.md",
    url: `https://github.com/oiuv/ai-short-drama/blob/${YOUCAI_FIXED_OSS_COMMIT}/skills/script-brief/SKILL.md`,
    sha256: "BFD80F0F46D76B86B4527859B65609DDEC801D513743270AB7BB60A922F449E3",
  },
  "sd2-pe": {
    repository: "oiuv/ai-short-drama", commit: YOUCAI_FIXED_OSS_COMMIT,
    path: "skills/sd2-pe/SKILL.md",
    url: `https://github.com/oiuv/ai-short-drama/blob/${YOUCAI_FIXED_OSS_COMMIT}/skills/sd2-pe/SKILL.md`,
    sha256: "3C3667C7D007FBFDA78B7B7C3186590FDB59EEEFA3B35159EA52E0AA3D3900CA",
  },
  "sd25-pe": {
    repository: "oiuv/ai-short-drama", commit: YOUCAI_FIXED_OSS_COMMIT,
    path: "skills/sd25-pe/SKILL.md",
    url: `https://github.com/oiuv/ai-short-drama/blob/${YOUCAI_FIXED_OSS_COMMIT}/skills/sd25-pe/SKILL.md`,
    sha256: "A83F6759FE9083B6A438BC6614727A55CCE684A9C78CDACE4B01F52CE374E805",
  },
};

const STRICT_OUTPUT_CONTRACTS: Readonly<Record<string, YoucaiSkillOutputContract>> = {
  "drama-script": {
    primaryKind: "structured_result", allowedKinds: ["structured_result"], format: "json", strict: true,
    description: "公开固定提交定义的爽剧剧本结构。",
    exactRootKeys: ["summary", "episodes", "characters", "scenes", "props"],
    constraints: ["仅输出 JSON", "根字段必须且只能按契约组织", "空数组必须保留", "不得在 JSON 外追加 Markdown"],
  },
  "drama-shot-prompt": {
    primaryKind: "structured_result", allowedKinds: ["structured_result"], format: "json", strict: true,
    description: "公开固定提交定义的镜头数组。",
    exactRootKeys: ["shots"],
    constraints: ["每个镜头包含 shotOrder、sceneName、characters、action、dialogue、prompt、duration", "duration 为 4 到 15 的整数", "action 不超过 30 个中文字符", "dialogue 可为空", "不得输出 Markdown"],
  },
  "script-brief": {
    primaryKind: "structured_result", allowedKinds: ["structured_result"], format: "json", strict: true,
    description: "公开固定提交定义的剧本简报结构。",
    exactRootKeys: ["brief", "genreDetected", "tips"],
    constraints: ["brief 为 800 到 1500 个中文字符", "tips 为 2 到 3 条", "不输出完整对白、分镜或模型参数", "仅输出 JSON"],
  },
  "sd2-pe": {
    primaryKind: "prompt", allowedKinds: ["prompt"], format: "text", strict: true,
    description: "公开固定提交定义的 Seedance 2.0 提示词编译结果。",
    constraints: ["简单、编辑、延长路径输出单一提示词", "两个及以上镜头的复杂路径按公开契约输出三个严格区段", "只编写提示词，不发起生成"],
  },
  "sd25-pe": {
    primaryKind: "prompt", allowedKinds: ["prompt"], format: "text", strict: true,
    description: "公开固定提交定义的 Seedance 2.5 提示词编译结果。",
    constraints: ["默认仅输出最终提示词", "只读使用输入资产", "不虚构未观察到的视觉事实", "只编写提示词，不发起生成"],
  },
};

const PROMPT_FIRST_COMMANDS = new Set([
  "video-prompt", "h3-prompt-writing", "seedance-20", "poster-design", "image-prompt",
  "music-prompt", "audio-prompt", "ip-toy-grid-motion", "poster-motion-planner",
  "dot-matrix-brand-wordmark-motion", "fpv-tour-video-generator", "film-reference-prompt-writer",
  "multi-platform-image-prompts", "outdoor-ad-prompt", "micro-expression-video-prompt",
  "handdrawn-live-video-prompt",
]);

const TOOL_PROPOSALS: Readonly<Record<string, readonly YoucaiSkillToolKind[]>> = {
  "ad-script-master": ["image", "video", "audio", "music"],
  "drama-shot-prompt": ["video"], "film-asset-design": ["image"], "drama-script": ["image", "video"],
  "video-prompt": ["video"], "h3-prompt-writing": ["video"], "seedance-20": ["video"],
  "sd2-pe": ["video"], "sd25-pe": ["video"], "poster-design": ["image"],
  "script-rewrite": ["image", "video"], "script-brief": ["image", "video"], "image-prompt": ["image"],
  "social-content-optimizer": ["image", "video"], "video-deconstruct-analyzer": ["image", "video", "audio"],
  "general-script": ["image", "video"], "music-prompt": ["music"], "audio-prompt": ["audio"],
  "ip-toy-grid-motion": ["image", "video"], "poster-motion-planner": ["video"],
  "dot-matrix-brand-wordmark-motion": ["image", "video"], "fpv-tour-video-generator": ["video"],
  storyboard: ["image"], "film-reference-prompt-writer": ["image", "video"],
  "voiceover-direction": ["audio"], "transcript-broll-planner": ["image", "video"],
  "multi-platform-image-prompts": ["image"], "paper-art-explainer": ["image", "video", "audio"],
  "outdoor-ad-prompt": ["image"], "minimalist-product-ad": ["image", "video", "music"],
  "micro-expression-video-prompt": ["video"], "handdrawn-live-video-prompt": ["video"],
  "ecommerce-image": ["image"],
};

const PUBLIC_STORE_IDS: Readonly<Record<string, string>> = {
  "ip-toy-grid-motion": "cmt7gya0l003pdpk58r0ny4wg",
  "poster-motion-planner": "cmt7hc0li007qdpk5fwj8npjo",
  "dot-matrix-brand-wordmark-motion": "cmt7hg953008mdpk5nlvjzrkl",
  "fpv-tour-video-generator": "cmt7gz3tq0041dpk51hioswqr",
  storyboard: "cmt7hd5ez007zdpk5m8yebezz",
  "film-reference-prompt-writer": "cmt7hdhr30089dpk5lwmjgqa7",
  "voiceover-direction": "cmt63iftf005yu8nab8gku8uc",
  "transcript-broll-planner": "cmt6324uf0052u8nabgwr64nk",
  "multi-platform-image-prompts": "cmt631ptz004tu8nafoj92tvl",
  "paper-art-explainer": "cmt62xw24004gu8napasxj4s2",
  "outdoor-ad-prompt": "cmt62xnmn0047u8naw7vyik5m",
  "minimalist-product-ad": "cmt62xct5003xu8naws2q96m2",
  "micro-expression-video-prompt": "cmt62w353003nu8na0sbeslug",
  "handdrawn-live-video-prompt": "cmt62vgz70033u8na01u4m8nu",
  "ecommerce-image": "cmt62v5vq002su8na3lbqiw8j",
};

const RESOURCE_PATHS: Readonly<Record<string, readonly YoucaiSkillResource[]>> = {
  "drama-script": ["references/satisfaction-model.md", "references/theme-patterns.md", "references/template-analysis.md"].map((path) => ({ path, purpose: "固定公开 Skill 配套参考", evidence: "public_source" as const })),
  "ip-toy-grid-motion": ["references/motion-six-grid-prompt-template.cn.md", "references/prompt-fidelity-rules.cn.md", "references/static-six-grid-prompt-template.cn.md"].map((path) => ({ path, purpose: "公开商店资源清单中的模板或保真规则", evidence: "public_metadata" as const })),
  "dot-matrix-brand-wordmark-motion": [{ path: "references/chinese-prompts.md", purpose: "公开商店资源清单中的中文提示词参考", evidence: "public_metadata" }],
  storyboard: [{ path: "references/panel-prompt-system.md", purpose: "公开商店资源清单中的宫格提示词参考", evidence: "public_metadata" }],
  "film-reference-prompt-writer": ["references/camera-movement.md", "references/prompt-and-output.md", "references/visual-analysis.md"].map((path) => ({ path, purpose: "公开商店资源清单中的电影视觉参考", evidence: "public_metadata" as const })),
};

const BASE_QUALITY_GATES = [
  "输入参数必须先通过 schema 校验",
  "显式斜杠命令优先于自动意图匹配",
  "输出类型与格式必须符合 outputContract",
  "不得把工具建议描述成已经生成的媒体",
  "付费工具只能形成 proposal，必须由用户确认模型、价格和授权后在主站工作台执行",
] as const;

function buildGenericOutputContract(commandName: string): YoucaiSkillOutputContract {
  const primaryKind: YoucaiSkillOutputKind = PROMPT_FIRST_COMMANDS.has(commandName) ? "prompt" : "structured_result";
  const hasTools = (TOOL_PROPOSALS[commandName]?.length || 0) > 0;
  return {
    primaryKind,
    allowedKinds: hasTools ? [primaryKind, "tool_proposal"] : [primaryKind],
    format: primaryKind === "prompt" ? "text" : "json",
    strict: false,
    description: primaryKind === "prompt"
      ? "根据公开参数和可见交互语义生成可编辑提示词，可附带主站工具建议。"
      : "根据公开参数和可见交互语义生成结构化创作结果，可附带主站工具建议。",
    constraints: [
      "不得复制或声称掌握对标站隐藏系统 Prompt",
      "不得绕过主站鉴权、模型目录、定价、任务和资产回写链路",
      "tool_proposal 必须包含目标能力和用户可确认参数，不得直接执行",
    ],
  };
}

function makeRuntimeDefinition(skill: YoucaiSkillDefinition): YoucaiSkillRuntimeDefinition {
  const inputSchema = INPUT_SCHEMAS[skill.commandName];
  if (!inputSchema) throw new Error(`Missing input schema for /${skill.commandName}`);
  const fixedSource = FIXED_OSS_SOURCES[skill.commandName];
  const declaredToolKinds = TOOL_PROPOSALS[skill.commandName] || [];
  const outputContract = STRICT_OUTPUT_CONTRACTS[skill.commandName] || buildGenericOutputContract(skill.commandName);
  const toolProposalKinds = outputContract.allowedKinds.includes("tool_proposal")
    ? declaredToolKinds
    : [];
  return {
    id: skill.id,
    commandName: skill.commandName,
    title: skill.title,
    version: skill.version,
    category: skill.category,
    publicStoreId: PUBLIC_STORE_IDS[skill.commandName] || skill.commandName,
    provenance: fixedSource ? "oss_public_source" : "public_contract_reimplementation",
    sourceDisclosure: fixedSource
      ? `执行契约固定引用 oiuv/ai-short-drama@${YOUCAI_FIXED_OSS_COMMIT} 的公开 SKILL.md；未使用隐藏系统 Prompt。`
      : "依据公开商店元数据、公开参数 schema 与正常可见交互进行行为等价原创实现；未复制或声称获得隐藏系统 Prompt。",
    ...(fixedSource ? { fixedSource } : {}),
    inputSchema,
    outputContract,
    resources: RESOURCE_PATHS[skill.commandName] || [],
    permissions: {
      readUserText: true,
      readAttachments: declaredToolKinds.length > 0,
      toolProposalKinds,
      directExecution: false,
      paidTools: {
        directExecution: false,
        requiresExplicitAuthorization: true,
        requiresModelSelection: true,
        requiresPricePreview: true,
      },
    },
    executionMode: skill.agentAutoInvokeEnabled
      ? "explicit_and_automatic"
      : "explicit_only_until_user_enables",
    invocation: {
      commandName: skill.commandName,
      explicitCommandPriority: true,
      unknownExplicitCommand: "reject",
      automaticEligibleByDefault: skill.agentAutoInvokeEnabled,
    },
    qualityGates: [
      ...BASE_QUALITY_GATES,
      fixedSource ? "严格遵守固定公开提交的输出字段和禁止项" : "只实现公开可观察行为，不推断私密编排指令",
    ],
  };
}

export const YOUCAI_SKILL_RUNTIME: readonly YoucaiSkillRuntimeDefinition[] =
  YOUCAI_SKILL_CATALOG.map(makeRuntimeDefinition);

const RUNTIME_BY_COMMAND = new Map(
  YOUCAI_SKILL_RUNTIME.map((runtime) => [runtime.commandName, runtime]),
);

export function findYoucaiSkillRuntime(commandName: string): YoucaiSkillRuntimeDefinition | undefined {
  return RUNTIME_BY_COMMAND.get(commandName.trim().replace(/^\//u, "").toLowerCase());
}

export type YoucaiSkillRuntimeResolution =
  | { state: "resolved"; runtime: YoucaiSkillRuntimeDefinition; request: string; explicit: boolean }
  | { state: "unknown_explicit_command"; commandName: string; request: string; explicit: true }
  | { state: "no_match"; request: string; explicit: false };

export function resolveYoucaiSkillRuntimeInvocation(input: string): YoucaiSkillRuntimeResolution {
  const parsed = parseYoucaiSkillInvocation(input);
  if (parsed.explicit) {
    if (parsed.skill) {
      const runtime = findYoucaiSkillRuntime(parsed.skill.commandName);
      if (runtime) return { state: "resolved", runtime, request: parsed.request, explicit: true };
    }
    const commandName = /^\/([a-z\d-]+)/iu.exec(input.trim())?.[1] || "";
    return { state: "unknown_explicit_command", commandName, request: parsed.request, explicit: true };
  }
  const inferred = inferYoucaiSkill(input);
  if (!inferred) return { state: "no_match", request: parsed.request, explicit: false };
  const runtime = findYoucaiSkillRuntime(inferred.commandName);
  return runtime
    ? { state: "resolved", runtime, request: parsed.request, explicit: false }
    : { state: "no_match", request: parsed.request, explicit: false };
}
