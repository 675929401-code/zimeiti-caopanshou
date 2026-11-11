/**
 * Adapted from AiToEarn (MIT), Copyright (c) 2025 AiToEarn.
 * Upstream commit: 47e5a6fa8a5d2d0a52f1b7b5220a2ed3c034c294.
 * Sources: PublishDialog.util.ts (account identity, topics, aspect ratio),
 * store/plugin/plugin.utils.ts (platform projection), store/plugin/constants.ts.
 * Full license and adoption boundaries: docs/third-party/aitoearn/.
 * This module contains no upstream auth store, credentials or network client.
 */
import type { PublishingPlatform } from "./publishing-contract";

export const PUBLISHING_PLUGIN_DOWNLOADS = {
  chrome: "https://chromewebstore.google.com/detail/aitoearn-extension/hnmocdhmnfgcjnedmdgfefcobideaeja",
  china: "https://ai-to-earn.oss-cn-beijing.aliyuncs.com/comment/aitoearn-extension.crx",
  github: "https://github.com/yikart/AiToEarn/releases/download/v2.1.0/aitoearn-extension.crx",
  guide: "https://docs.aitoearn.ai/zh/use/plugin-publish",
  updateGuide: "https://aitoearn.cn/zh-CN/websit/plugin-update-docs",
  source: "https://github.com/yikart/AiToEarn/tree/47e5a6fa8a5d2d0a52f1b7b5220a2ed3c034c294",
  commit: "47e5a6fa8a5d2d0a52f1b7b5220a2ed3c034c294",
} as const;
export const PUBLISHING_PROVIDER_LEGAL_LINKS = {
  privacy: "https://aitoearn.ai/en/websit/privacy-policy",
  terms: "https://aitoearn.cn/zh-CN/websit/terms-of-service",
} as const;

/** The audited source transport, NOT the wider public WebAPI documentation. */
export const NATIVE_PLATFORM_CAPABILITIES = [
  { platform: "xhs", name: "小红书", transport: "browser_plugin", contentTypes: ["image", "video"], maxImages: 9, coverRequired: true, scheduling: "browser_plugin", available: true },
  { platform: "wxSph", name: "视频号", transport: "browser_plugin", contentTypes: ["video"], maxImages: 0, coverRequired: true, scheduling: "browser_plugin", available: true },
  { platform: "douyin", name: "抖音", transport: "api_handoff", contentTypes: ["image", "video"], maxImages: 0, coverRequired: false, scheduling: "unavailable", available: false },
] as const;

/** Audited native platform catalog, not a claim that these connectors are configured. */
export const NATIVE_OFFICIAL_API_PLATFORMS = [
  { platform: "xhs", name: "小红书" }, { platform: "wxSph", name: "视频号" },
  { platform: "douyin", name: "抖音" }, { platform: "KWAI", name: "快手" },
  { platform: "bilibili", name: "哔哩哔哩" }, { platform: "wxGzh", name: "微信公众号" },
  { platform: "tiktok", name: "TikTok" }, { platform: "youtube", name: "YouTube" },
  { platform: "twitter", name: "X" }, { platform: "facebook", name: "Facebook" },
  { platform: "instagram", name: "Instagram" }, { platform: "threads", name: "Threads" },
  { platform: "pinterest", name: "Pinterest" }, { platform: "linkedin", name: "LinkedIn" },
] as const;

export interface NativePublishingAccountIdentity { id?: string; platform: string; uid?: string }
export function isSamePublishingAccount(previous: NativePublishingAccountIdentity, next: NativePublishingAccountIdentity): boolean {
  // Unlike the original id shortcut, equal IDs never override a platform mismatch.
  if (previous.platform !== next.platform) return false;
  if (previous.id && next.id && previous.id === next.id) return true;
  return Boolean(previous.uid && next.uid && previous.uid === next.uid);
}

export function normalizePublishingTopics(topics: readonly string[]): string[] {
  const topicKeys = new Set<string>();
  const normalizedTopics: string[] = [];
  for (const topic of topics) {
    const topicText = topic.replace(/\[话题\]/g, "").replace(/^#+/, "").replace(/#+$/, "").trim();
    const topicKey = topicText.toLowerCase();
    if (!topicText || topicKeys.has(topicKey)) continue;
    topicKeys.add(topicKey);
    normalizedTopics.push(topicText);
  }
  return normalizedTopics;
}

/** Upstream appendTopicsToDescription, kept separate from plugin topic parameters. */
export function appendPublishingTopics(description: string, topics: readonly string[]): string {
  const existing = new Set([...description.matchAll(/#([^\s#]+)/g)].map(match => match[1].toLowerCase()));
  const additions = normalizePublishingTopics(topics).filter(topic => !existing.has(topic.toLowerCase())).map(topic => `#${topic}`).join(" ");
  return additions ? `${description}\n${additions}`.trim() : description.trim();
}

/** Native parseTopicString + plugin/store.ts text projection; limits from fixed platform constants. */
export function prepareNativePluginContent(platform: PublishingPlatform, title: string, description: string, topics: readonly string[]) {
  const errors: string[] = [];
  const bodyTopics: string[] = []; let desc = description;
  for (const match of description.matchAll(/#(\S+)/g)) { bodyTopics.push(match[1]); desc = desc.replace(match[0], ""); }
  desc = desc.trim();
  if (/#(?:\s+\S+|\S*#\S*)/.test(description)) errors.push("正文话题格式有误，请使用 #话题 并以空格分隔");
  for (const group of [bodyTopics, topics]) {
    const normalized = group.map(topic => topic.replace(/\[话题\]/g, "").replace(/^#+/, "").replace(/#+$/, "").trim().toLowerCase()).filter(Boolean);
    if (new Set(normalized).size !== normalized.length) errors.push("同一组话题中存在重复项，请调整后再发布");
  }
  const merged = normalizePublishingTopics([...bodyTopics, ...topics]);
  const titleLimit = platform === "xhs" ? 20 : platform === "wxSph" ? 16 : 30;
  if (title.length > titleLimit) errors.push(`${platform === "xhs" ? "小红书" : platform === "wxSph" ? "视频号" : "抖音"}标题最多 ${titleLimit} 字符（表情按实际字符单元计算）`);
  if (desc.length > 1000) errors.push("去除话题后的正文最多 1000 字符，请调整此账号正文");
  if ((platform === "xhs" || platform === "douyin") && merged.length > 5) errors.push("正文与标签合计最多 5 个不同话题");
  return { title, desc, topics: merged, errors: [...new Set(errors)] };
}
export interface NativePreflightMedia { role: string; fileName: string; type: string; size: number; width?: number; height?: number; duration?: number }
export function validateNativePublishingMedia(platform: PublishingPlatform, contentType: "image" | "video", media: readonly NativePreflightMedia[], cover?: NativePreflightMedia, scheduledAt?: string | null): string[] {
  const errors: string[] = [];
  const images = media.filter(item => item.role === "image"), videos = media.filter(item => item.role === "video");
  if (contentType === "image" && (platform === "wxSph" || images.length < 1 || images.length > (platform === "douyin" ? 35 : 9) || videos.length)) errors.push(platform === "douyin" ? "抖音图文请选择 1 至 35 张图片" : "小红书图文请选择 1 至 9 张图片，视频号仅支持视频");
  if (contentType === "video" && videos.length !== 1) errors.push("请为此账号选择且仅选择一条成片");
  if (contentType === "video" && platform !== "douyin" && !cover) errors.push("此平台的视频发布需要封面");
  for (const item of [...media, ...(cover ? [cover] : [])]) {
    if (!Number.isSafeInteger(item.size) || item.size <= 0) errors.push("素材文件为空或尚未读取");
    if (item.role === "video") {
      if (item.type !== "video/mp4" || !/\.mp4$/i.test(item.fileName)) errors.push("本站发布适配当前使用 MP4 成片，请重新选择文件");
      if (item.size > 1024 ** 3) errors.push("单个视频不能超过 1 GiB");
      if (!Number.isFinite(item.duration) || !item.duration || item.duration <= 0) errors.push("视频时长尚未读取，请重新关联成片");
      else if (item.duration > 3600) errors.push("视频时长不能超过 3600 秒");
      if (platform === "wxSph" && (!item.width || !item.height || !Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width <= 0 || item.height <= 0)) errors.push("视频号需要真实视频宽高，请重新关联成片");
    } else {
      if (!["image/jpeg", "image/png", "image/webp"].includes(item.type)) errors.push("本站发布适配当前使用 JPG、PNG 或 WebP 图片");
      if (platform === "douyin" && !["image/jpeg", "image/png"].includes(item.type)) errors.push("抖音浏览器通道当前使用 JPG 或 PNG 图片与封面");
      if (item.size > 20 * 1024 ** 2) errors.push("单张图片或封面不能超过 20 MiB");
    }
  }
  if (scheduledAt && (!Number.isFinite(Date.parse(scheduledAt)) || Date.parse(scheduledAt) <= Date.now())) errors.push("定时时间必须晚于当前时间");
  return [...new Set(errors)];
}

export function nativeAspectRatioMatches(width: number, height: number, ratio: number, threshold = 0.02): boolean {
  if (![width, height, ratio, threshold].every(Number.isFinite) || width <= 0 || height <= 0 || ratio <= 0 || threshold < 0) return false;
  return Math.abs(width / height - ratio) <= threshold;
}
export function nativeAspectRatioInRange(width: number, height: number, minRatio: number, maxRatio: number, threshold = 0.02): boolean {
  if (![width, height, minRatio, maxRatio, threshold].every(Number.isFinite) || width <= 0 || height <= 0 || minRatio <= 0 || maxRatio < minRatio || threshold < 0) return false;
  const actualRatio = width / height;
  return actualRatio >= minRatio - threshold && actualRatio <= maxRatio + threshold;
}

export interface NativeVideoMetadata { width: number; height: number; duration: number; size: number }
export interface NativeWxPoi {
  latitude?: number; longitude?: number; poiCity?: string; poiName?: string; poiAddress?: string;
  poiId?: string; province?: string; region?: string; fullAddress?: string; poiCheckSum?: string;
}
export interface NativeWxEvent { eventTopicId: string; eventName: string; eventCreatorNickname?: string; eventAttendCount?: number }
export interface NativePlatformOptions {
  xhs?: { declaration?: 1 | 2 | 3 };
  wxSph?: { poiInfo?: NativeWxPoi; event?: NativeWxEvent; extLink?: string; postFlag?: 0 | 1 };
  douyin?: { privacyLevel?: "public" | "private" };
}
export interface NativePluginPlatformConfig {
  userDeclarationBind?: { origin: 1 | 2 | 3 };
  wxSph?: { videoMetadata: NativeVideoMetadata; poiInfo?: NativeWxPoi; event?: NativeWxEvent; extLink?: string; postFlag?: 0 | 1 };
}

/** Closed projection adapted from upstream buildPluginPlatformConfig. Input is validated by V2 DTO. */
export function buildNativePluginPlatformConfig(platform: PublishingPlatform, options: NativePlatformOptions, video?: NativeVideoMetadata): NativePluginPlatformConfig | undefined {
  if (platform === "xhs") {
    const origin = options.xhs?.declaration;
    return origin === undefined ? undefined : { userDeclarationBind: { origin } };
  }
  if (platform === "wxSph" && video) {
    const input = options.wxSph;
    // Only declared properties cross the plugin boundary; no spread of an open payload.
    return { wxSph: {
      videoMetadata: { width: video.width, height: video.height, duration: video.duration, size: video.size },
      ...(input?.poiInfo ? { poiInfo: {
        ...(input.poiInfo.latitude !== undefined ? { latitude: input.poiInfo.latitude } : {}),
        ...(input.poiInfo.longitude !== undefined ? { longitude: input.poiInfo.longitude } : {}),
        ...Object.fromEntries((["poiCity", "poiName", "poiAddress", "poiId", "province", "region", "fullAddress", "poiCheckSum"] as const).flatMap(key => input.poiInfo?.[key] !== undefined ? [[key, input.poiInfo[key]]] : [])),
      } } : {}),
      ...(input?.event ? { event: { eventTopicId: input.event.eventTopicId, eventName: input.event.eventName,
        ...(input.event.eventCreatorNickname !== undefined ? { eventCreatorNickname: input.event.eventCreatorNickname } : {}),
        ...(input.event.eventAttendCount !== undefined ? { eventAttendCount: input.event.eventAttendCount } : {}),
      } } : {}),
      ...(input?.extLink ? { extLink: input.extLink } : {}),
      ...(input?.postFlag !== undefined ? { postFlag: input.postFlag } : {}),
    } };
  }
  return undefined;
}

export function nativeCalendarRange(anchor: Date, view: "month" | "week"): { start: Date; end: Date; days: Date[] } {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), view === "month" ? 1 : anchor.getDate());
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const count = view === "month" ? 42 : 7;
  const days = Array.from({ length: count }, (_, offset) => { const date = new Date(start); date.setDate(date.getDate() + offset); return date; });
  const end = new Date(days[count - 1]); end.setDate(end.getDate() + 1);
  return { start, end, days };
}
