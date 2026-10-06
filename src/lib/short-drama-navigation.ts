export type ShortDramaIconKey =
  | "sparkles"
  | "clapperboard"
  | "book-open"
  | "upload"
  | "file-text"
  | "users"
  | "landmark"
  | "package"
  | "panels-top-left"
  | "film";

export type ShortDramaAccent = "coral" | "cyan" | "slate" | "amber";

export interface ShortDramaEntryCard {
  readonly key: "爽剧" | "通用短剧" | "正剧" | "上传剧本";
  readonly title: string;
  readonly eyebrow: string;
  readonly description: string;
  readonly bullets: readonly string[];
  readonly href: string | null;
  readonly status: "available" | "coming-soon";
  readonly accent: ShortDramaAccent;
  readonly icon: ShortDramaIconKey;
}

export interface ShortDramaWorkflowStep {
  readonly step: number;
  readonly key: "剧本" | "角色" | "场景" | "道具" | "分镜" | "视频";
  readonly title: string;
  readonly description: string;
  readonly href: string;
  readonly icon: ShortDramaIconKey;
}

export interface ShortDramaUtilityLink {
  readonly title: string;
  readonly description: string;
  readonly href: string;
  readonly label: string;
}

/**
 * 影视工坊只负责组织入口。真实生成、权限和计费继续由目标工作台的服务端 API 校验。
 * 查询参数仅用于保留来源和预选阶段，目标页面即使暂未消费参数也能安全打开。
 */
export const SHORT_DRAMA_ENTRY_CARDS = [
  {
    key: "爽剧",
    title: "爽剧",
    eyebrow: "高密度节奏",
    description: "从冲突、反转和情绪回报出发，先完成可编辑剧本，再进入分镜工作台。",
    bullets: ["冲突前置", "节拍可回改", "竖屏优先"],
    href: "/storyboard-workbench?entry=short-drama&mode=爽剧",
    status: "available",
    accent: "coral",
    icon: "sparkles",
  },
  {
    key: "通用短剧",
    title: "短剧",
    eyebrow: "灵活改编",
    description: "适合口播、知识、萌宠和品牌故事，将文案拆成画面与视频提示结构。",
    bullets: ["文案拆解", "镜头规划", "多比例适配"],
    href: "/storyboard-workbench?entry=short-drama&mode=通用短剧",
    status: "available",
    accent: "cyan",
    icon: "clapperboard",
  },
  {
    key: "正剧",
    title: "正剧",
    eyebrow: "长叙事工作流",
    description: "正剧工作流正在升级，当前暂不可用；可先使用通用短剧入口整理内容。",
    bullets: ["人物关系", "跨集连续性", "版本管理"],
    href: null,
    status: "coming-soon",
    accent: "slate",
    icon: "book-open",
  },
  {
    key: "上传剧本",
    title: "上传剧本",
    eyebrow: "从已有素材开始",
    description: "进入分镜工作台整理已有剧本；文件解析能力以工作台当前支持范围为准。",
    bullets: ["保留原稿", "人工确认", "继续拆镜"],
    href: "/storyboard-workbench?entry=short-drama&mode=upload",
    status: "available",
    accent: "amber",
    icon: "upload",
  },
] as const satisfies readonly ShortDramaEntryCard[];

export const SHORT_DRAMA_WORKFLOW_STEPS = [
  {
    step: 1,
    key: "剧本",
    title: "剧本策划",
    description: "整理主题、受众、叙事节拍与旁白。",
    href: "/storyboard-workbench?entry=short-drama&stage=script",
    icon: "file-text",
  },
  {
    step: 2,
    key: "角色",
    title: "角色设定",
    description: "在分镜工作台维护角色参考与一致性。",
    href: "/storyboard-workbench?entry=short-drama&stage=character",
    icon: "users",
  },
  {
    step: 3,
    key: "场景",
    title: "场景设计",
    description: "组织地点、时间、光线和美术风格。",
    href: "/storyboard-workbench?entry=short-drama&stage=scene",
    icon: "landmark",
  },
  {
    step: 4,
    key: "道具",
    title: "道具管理",
    description: "沉淀贯穿镜头的关键物件和语义线索。",
    href: "/storyboard-workbench?entry=short-drama&stage=prop",
    icon: "package",
  },
  {
    step: 5,
    key: "分镜",
    title: "分镜生成",
    description: "将剧本拆成可审核、可回改的镜头单元。",
    href: "/storyboard-workbench?entry=short-drama&stage=storyboard",
    icon: "panels-top-left",
  },
  {
    step: 6,
    key: "视频",
    title: "视频成片",
    description: "在视频工作台生成片段并回看任务状态。",
    href: "/video?entry=short-drama&stage=video",
    icon: "film",
  },
] as const satisfies readonly ShortDramaWorkflowStep[];

export const SHORT_DRAMA_UTILITY_LINKS = [
  {
    title: "分镜资产",
    description: "集中整理角色、场景、道具和视觉参考。",
    href: "/storyboard-workbench?entry=short-drama&stage=assets",
    label: "进入分镜工作台",
  },
  {
    title: "配音工作台",
    description: "为旁白和口播准备声音，不要求画面角色开口。",
    href: "/voice-studio",
    label: "进入配音",
  },
  {
    title: "项目记录",
    description: "返回影视工坊项目库，继续当前项目的创作记录。",
    href: "/short-drama#projects",
    label: "返回项目库",
  },
  {
    title: "灵感广场",
    description: "浏览我方原创方法示例，再带着结构进入创作。",
    href: "/inspiration",
    label: "浏览灵感",
  },
] as const satisfies readonly ShortDramaUtilityLink[];

export const SHORT_DRAMA_FEATURED_TEMPLATE = {
  key: "pet-silent-narration",
  title: "宠物无对白口播",
  description: "把口播文案拆成可见动作与环境反馈，声音在后期以旁白加入，画面中的人物和宠物都不张嘴说话。",
  variables: ["文案", "动画风格", "视频尺寸"],
  constraints: ["后期旁白", "人物不张嘴", "宠物不张嘴"],
  href: "/tools/text/general-script?profile=pet-silent-narration",
} as const;
