import jianyingTemplates from "@/lib/jianying-cover-templates.generated.json";

export type CoverRatio = "3:4" | "4:3";

export type CoverLayout =
  | "editorial-left"
  | "sticker-stack"
  | "bottom-banner"
  | "clean-column"
  | "outline-pop"
  | "dark-split"
  | "jianying";

export interface CoverTextLayer {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSizeRatio: number;
  fontFamily: string;
  fontFile: string;
  fontWeight: number;
  fill: string;
  opacity: number;
  align: "left" | "center" | "right";
  charSpacing: number;
  lineHeight: number;
  angle: number;
  scaleX: number;
  scaleY: number;
  stroke: string;
  strokeWidthRatio: number;
  shadow: { color: string; opacity: number; distanceRatio: number; angle: number; blurRatio: number } | null;
  background: string;
  zIndex: number;
}

export interface CoverTemplate {
  id: string;
  name: string;
  category: string;
  ratio: CoverRatio;
  layout: CoverLayout;
  image: string;
  accent: string;
  secondary: string;
  ink: string;
  surface: string;
  titleColor: string;
  title: string;
  subtitle: string;
  badge: string;
  preview?: string;
  originalWidth?: number;
  originalHeight?: number;
  sourceSeries?: string;
  layers?: CoverTextLayer[];
}

const portrait = "/cover-assets/creator-portrait.png";
const landscape = "/cover-assets/business-landscape.png";

const families: Array<Omit<CoverTemplate, "id" | "ratio" | "image">> = [
  {
    name: "醒目头条",
    category: "观点",
    layout: "editorial-left",
    accent: "#f4cb45",
    secondary: "#e84c38",
    ink: "#17201d",
    surface: "#fffdf5",
    titleColor: "#ffffff",
    title: "普通人如何\n抓住新机会",
    subtitle: "三个判断方法，一次讲清",
    badge: "今日必看",
  },
  {
    name: "便签爆点",
    category: "教程",
    layout: "sticker-stack",
    accent: "#f6d54a",
    secondary: "#25a27f",
    ink: "#18211e",
    surface: "#fff9e8",
    titleColor: "#18211e",
    title: "新手做账号\n先避开这 5 个坑",
    subtitle: "少走弯路的实操清单",
    badge: "新手指南",
  },
  {
    name: "信息横幅",
    category: "职场",
    layout: "bottom-banner",
    accent: "#f3c63f",
    secondary: "#d94f39",
    ink: "#111816",
    surface: "#ffffff",
    titleColor: "#ffffff",
    title: "职场新人\n生存指南",
    subtitle: "真正拉开差距的 4 件事",
    badge: "干货",
  },
  {
    name: "留白专栏",
    category: "知识",
    layout: "clean-column",
    accent: "#e94935",
    secondary: "#168673",
    ink: "#1e2522",
    surface: "#f8f7f2",
    titleColor: "#1e2522",
    title: "把复杂问题\n讲得简单",
    subtitle: "结构化表达的底层方法",
    badge: "方法论",
  },
  {
    name: "描边热榜",
    category: "观点",
    layout: "outline-pop",
    accent: "#e9f04a",
    secondary: "#ff6248",
    ink: "#121716",
    surface: "#ffffff",
    titleColor: "#ffffff",
    title: "别再盲目努力\n方向更重要",
    subtitle: "重新理解有效成长",
    badge: "热议",
  },
  {
    name: "深色对谈",
    category: "职场",
    layout: "dark-split",
    accent: "#f2c84b",
    secondary: "#f05b43",
    ink: "#101715",
    surface: "#17201d",
    titleColor: "#ffffff",
    title: "高手都在用的\n沟通框架",
    subtitle: "从会说到让人愿意听",
    badge: "深度拆解",
  },
];

const BUILTIN_TEMPLATES: CoverTemplate[] = families.flatMap((family, index) =>
  (["3:4", "4:3"] as const).map((ratio) => ({
    ...family,
    id: `${ratio.replace(":", "x")}-${index + 1}`,
    ratio,
    image: ratio === "3:4" ? portrait : landscape,
  })),
);

export const COVER_TEMPLATES: CoverTemplate[] = [
  ...(jianyingTemplates as CoverTemplate[]),
  ...BUILTIN_TEMPLATES,
];

export const COVER_DIMENSIONS: Record<CoverRatio, { width: number; height: number; exportScale: number }> = {
  "3:4": { width: 540, height: 720, exportScale: 2 },
  "4:3": { width: 720, height: 540, exportScale: 2 },
};

export function getDefaultTemplate(ratio: CoverRatio): CoverTemplate {
  return COVER_TEMPLATES.find((template) => template.ratio === ratio) ?? COVER_TEMPLATES[0];
}
