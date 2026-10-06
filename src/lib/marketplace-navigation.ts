import { STORAGE_KEYS } from "@/lib/storage-keys";

const SECONDARY_RETURN_MARKER = "secondary_page_return_to_marketplace";

export const MARKETPLACE_SHOW_ALL_EVENT = "marketplace:show-all";
const MARKETPLACE_SHOW_ALL_PENDING = "marketplace_show_all_pending";

/**
 * 电脑端一级导航的稳定产品分类。
 * key 与 route 是运行时合同，展示名称统一为四个汉字，不从数据库或
 * localStorage 覆盖，避免不同入口出现多套叫法与顺序。
 */
export const PRIMARY_NAVIGATION = [
  { key: "marketplace", label: "应用广场", route: "/", icon: "LayoutGrid", description: "智能体与业务能力入口" },
  { key: "toolbox", label: "效率工具", route: "/tools", icon: "Wrench", description: "文案提取、视频提取、文字排版与智能分段" },
  { key: "storyboard_workbench", label: "分镜编排", route: "/storyboard-workbench", icon: "Clapperboard", description: "统一组织分镜图片、视频提示词与生成状态" },
  { key: "image_workbench", label: "图像生成", route: "/image-workbench", icon: "Image", description: "批量文生图与图生图" },
  { key: "create", label: "视频创作", route: "/video", icon: "Film", description: "AI 视频生成与任务管理" },
  { key: "voice", label: "声音制作", route: "/voice-studio/workspace", icon: "Mic", description: "配音、音色与声音任务" },
  { key: "cover", label: "封面设计", route: "/cover", icon: "Palette", description: "封面构图与生成" },
  { key: "youcai", label: "漫剧创作", route: "/youcai", icon: "Sparkles", description: "进入漫剧创作工作台" },
  { key: "commerce_agent", label: "带货创作", route: "/commerce", icon: "ShoppingBag", description: "商品图、商详套图与带货视频创作" },
] as const;

export type PrimaryNavigationKey = (typeof PRIMARY_NAVIGATION)[number]["key"];

export const PRIMARY_NAVIGATION_ORDER = PRIMARY_NAVIGATION.map((item) => item.key) as readonly PrimaryNavigationKey[];
export const PRIMARY_NAVIGATION_KEYS = new Set<string>(PRIMARY_NAVIGATION_ORDER);

const PRIMARY_NAVIGATION_BY_KEY = new Map<string, (typeof PRIMARY_NAVIGATION)[number]>(
  PRIMARY_NAVIGATION.map((item) => [item.key, item] as const),
);

const PRIMARY_NAVIGATION_LEGACY_LABELS: Record<string, PrimaryNavigationKey> = {
  "应用广场": "marketplace",
  "工具箱": "toolbox",
  "效率工具": "toolbox",
  "分镜工作台": "storyboard_workbench",
  "分镜编排": "storyboard_workbench",
  "AI生图工作台": "image_workbench",
  "3D动画工作流": "image_workbench",
  "3D动画": "image_workbench",
  "图像生成": "image_workbench",
  "视频制作": "create",
  "视频工坊": "create",
  "视频创作": "create",
  "语音克隆": "voice",
  "智音工坊": "voice",
  "声音制作": "voice",
  "封面制作": "cover",
  "封面设计": "cover",
  "有彩创作": "youcai",
  "有彩视界": "youcai",
  "漫剧工作台": "youcai",
  "漫剧创作": "youcai",
  "带货Agent": "commerce_agent",
  "带货创作": "commerce_agent",
};

export function isPrimaryNavigationKey(key: string): key is PrimaryNavigationKey {
  return PRIMARY_NAVIGATION_KEYS.has(key);
}

export function getPrimaryNavigationItem(key: string) {
  return PRIMARY_NAVIGATION_BY_KEY.get(key);
}

export function getPrimaryNavigationLabel(key: string, fallback = ""): string {
  return getPrimaryNavigationItem(key)?.label || fallback;
}

export function resolvePrimaryNavigationKey(label: string): PrimaryNavigationKey | undefined {
  return PRIMARY_NAVIGATION_LEGACY_LABELS[label.replace(/\s+/gu, "")];
}

export function getPrimaryNavigationLabelForRoute(route: string, fallback: string): string {
  const normalized = route.split("?")[0].replace(/\/+$/u, "") || "/";
  const item = PRIMARY_NAVIGATION.find((entry) => normalized === entry.route || normalized.startsWith(`${entry.route}/`));
  return item?.label || fallback;
}

/** 通知已挂载的应用广场回到“全部智能体”。仅改变前端筛选状态。 */
export function requestMarketplaceShowAll(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(MARKETPLACE_SHOW_ALL_PENDING, "1");
  window.dispatchEvent(new Event(MARKETPLACE_SHOW_ALL_EVENT));
}

export function consumeMarketplaceShowAllRequest(): boolean {
  if (typeof window === "undefined") return false;
  if (window.sessionStorage.getItem(MARKETPLACE_SHOW_ALL_PENDING) !== "1") return false;
  window.sessionStorage.removeItem(MARKETPLACE_SHOW_ALL_PENDING);
  return true;
}

export function markSecondaryPageReturn(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(SECONDARY_RETURN_MARKER, "1");
}

/** Clear navigation intents that would reopen the private application shell.
 * Authentication failures use this before returning to the public homepage so
 * a stale secondary-page marker cannot immediately set `entered_app` again. */
export function clearMarketplaceReturnIntent(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SECONDARY_RETURN_MARKER);
  window.sessionStorage.removeItem(MARKETPLACE_SHOW_ALL_PENDING);
}

export function consumeSecondaryPageReturn(): boolean {
  if (typeof window === "undefined") return false;
  if (window.sessionStorage.getItem(SECONDARY_RETURN_MARKER) !== "1") return false;

  window.sessionStorage.removeItem(SECONDARY_RETURN_MARKER);
  window.sessionStorage.setItem("entered_app", "1");
  window.localStorage.setItem(STORAGE_KEYS.ACTIVE_VIEW, "marketplace");
  return true;
}
