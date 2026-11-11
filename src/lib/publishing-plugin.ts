import {
  isPublishingSafeHttps, isPublishingShareLink,
  type PublishingMutationResponse, type PublishingPlatform,
} from "./publishing-contract";
import { NATIVE_PLATFORM_CAPABILITIES, prepareNativePluginContent, type NativePluginPlatformConfig, type NativeWxPoi, type NativeWxEvent } from "./publishing-native";

export const PUBLISHING_PLUGIN_GUIDE = "https://docs.aitoearn.ai/zh/use/plugin-publish";
export type PluginIssueCode = "not_installed" | "invalid_plugin" | "version_invalid" | "not_authorized" | "account_unavailable" | "account_changed" | "account_busy" | "session_changed" | "permit_required" | "already_started" | "publish_unknown" | "invalid_receipt" | "transport_unavailable" | "media_invalid" | "search_unavailable";
const issueMessages: Record<PluginIssueCode, string> = {
  account_busy: "同一浏览器中的这个平台账号有发布进行中，请核对原任务。",
  not_installed: "未检测到发布插件。请安装官方插件，授权当前网站后刷新页面。",
  invalid_plugin: "当前插件缺少所需能力。请更新官方插件并刷新页面。",
  version_invalid: "无法验证插件版本。请更新官方插件后重新检测。",
  not_authorized: "插件尚未授权当前网站。请在插件中选择 Authorize Only，添加本站来源并刷新页面。",
  account_unavailable: "无法读取当前平台账号。请在同一浏览器登录目标平台，然后重新检测。",
  account_changed: "浏览器中的平台账号已变化。已停止发布，请重新读取并确认账号。",
  session_changed: "本站登录身份已变化，已停止后续发布。请重新登录并核对原任务。",
  permit_required: "没有本次执行许可，未调用插件。请查询原任务状态。",
  already_started: "此任务已经发起，不能再次调用插件。请核对原任务和平台作品。",
  publish_unknown: "插件执行状态待核对。请到平台检查原作品，系统不会自动重发或返还次数。",
  invalid_receipt: "插件返回结果无法验证。请到平台核对原作品，系统不会自动重发。",
  transport_unavailable: "当前目标未配置经过核验的发布连接，未调用插件。",
  media_invalid: "本次素材或平台参数不完整，未调用插件。请核对原任务后重新准备内容。",
  search_unavailable: "当前插件无法完成搜索。请检查插件版本和视频号登录状态后再试。",
};

/** Raw plugin errors may contain cookies. Only this closed set reaches the UI. */
export class PublishingPluginError extends Error {
  readonly code: PluginIssueCode;
  constructor(code: PluginIssueCode) { super(issueMessages[code]); this.name = "PublishingPluginError"; this.code = code; }
}
export function publishingPluginMessage(error: unknown): string {
  return error instanceof PublishingPluginError ? error.message : issueMessages.publish_unknown;
}
export interface PublishingPluginAccount {
  platform: PublishingPlatform;
  uid: string;
  account: string;
  nickname: string;
  avatar?: string;
}
export interface PublishingPluginProgress { stage: "download" | "upload" | "publish" | "complete" | "error"; progress: number }
export interface PublishingPluginReceipt { success: boolean; workId?: string; shareLink?: string; mediaMd5sum?: string; videoClipTaskId?: string; scheduledTime?: number; publishTime?: string; errorCode?: string }
interface PublishingPluginCommonParams {
  platform: PublishingPlatform;
  title: string;
  desc: string;
  topics: string[];
  cover?: File;
  visibility?: "public" | "private";
  requestId?: string;
  platformConfig?: NativePluginPlatformConfig;
  scheduledTime?: number;
}
export type PublishingPluginParams = PublishingPluginCommonParams & (
  { type: "video"; video: File; images?: never } | { type: "image"; images: File[]; video?: never }
);
export interface NativePublishingPermit { attemptId: string; shouldExecute: boolean; platform: PublishingPlatform }
interface PluginApi {
  getVersion(): Promise<unknown>;
  checkPermission(): Promise<unknown>;
  login(platform: PublishingPlatform): Promise<unknown>;
  publish(params: PublishingPluginParams, onProgress?: (event: unknown) => void): Promise<unknown>;
  wxSphSearchLocation?(params: { query: string }): Promise<unknown>;
  wxSphSearchActivity?(params: { query: string }): Promise<unknown>;
}
declare global { interface Window { AIToEarnPlugin?: unknown } }
const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || !isPublishingSafeHttps(value)) return;
  const url = new URL(value);
  if ([...url.searchParams.keys()].some(key => /cookie|token|authorization|secret|password|api.?key/i.test(key))) return;
  url.hash = "";
  return url.href;
}
function getPlugin(source?: unknown): PluginApi {
  const candidate = source === undefined && typeof window !== "undefined" ? window.AIToEarnPlugin : source;
  if (!candidate) throw new PublishingPluginError("not_installed");
  const plugin = record(candidate);
  if (!plugin || !["getVersion", "checkPermission", "login", "publish"].every(key => typeof plugin[key] === "function")) throw new PublishingPluginError("invalid_plugin");
  return candidate as PluginApi;
}
async function verify(plugin: PluginApi): Promise<string> {
  let result: unknown;
  try { result = await plugin.getVersion(); } catch { throw new PublishingPluginError("version_invalid"); }
  const version = record(result)?.version;
  if (typeof version !== "string" || version.length > 80 || !/^v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new PublishingPluginError("version_invalid");
  let permission: unknown;
  try { permission = await plugin.checkPermission(); } catch { throw new PublishingPluginError("not_authorized"); }
  const granted = record(permission);
  if (granted?.granted !== true || granted.hostAccess === false) throw new PublishingPluginError("not_authorized");
  return version;
}

export function projectPublishingAccount(value: unknown, platform: PublishingPlatform): PublishingPluginAccount {
  const original = record(value);
  const rawUid = original?.uid;
  if (typeof rawUid !== "string" || rawUid.length > 160 || /[\u0000-\u001f\u007f]/.test(rawUid)) throw new PublishingPluginError("account_unavailable");
  const uid = rawUid.trim();
  if (!uid || original?.type !== platform) throw new PublishingPluginError("account_unavailable");
  const avatar = safeUrl(original.avatar);
  return { platform, uid, account: text(original.account, 160), nickname: text(original.nickname, 200), ...(avatar ? { avatar } : {}) };
}
async function login(plugin: PluginApi, platform: PublishingPlatform): Promise<PublishingPluginAccount> {
  try { return projectPublishingAccount(await plugin.login(platform), platform); }
  catch { throw new PublishingPluginError("account_unavailable"); }
}
export async function inspectPublishingPlugin(platform: PublishingPlatform, source?: unknown): Promise<{ version: string; account: PublishingPluginAccount }> {
  const plugin = getPlugin(source);
  const version = await verify(plugin);
  return { version, account: await login(plugin, platform) };
}
export function projectPublishingReceipt(value: unknown, platform: PublishingPlatform): PublishingPluginReceipt {
  const original = record(value);
  if (typeof original?.success !== "boolean") throw new PublishingPluginError("invalid_receipt");
  // An untrusted browser report is never upgraded to an authoritative platform receipt.
  const workId = typeof original.workId === "string" && /^[A-Za-z0-9_-]{1,240}$/.test(original.workId) ? original.workId : "";
  const shareLink = safeUrl(original.shareLink);
  const platformData = platform === "wxSph" ? record(original.platformData) : null;
  const md5 = platformData?.mediaMd5sum ?? (platform === "wxSph" ? workId : undefined);
  const clipId = platformData?.videoClipTaskId;
  const scheduledTime = platformData?.scheduledTime;
  const publishTime = original.publishTime;
  const errorCode = ["WX_SPH_LOGIN_EXPIRED", "PUBLISH_FAILED", "NETWORK_ERROR", "UPLOAD_FAILED"].includes(String(original.errorCode)) ? String(original.errorCode) : undefined;
  return { success: original.success, ...(workId ? { workId } : {}), ...(shareLink && isPublishingShareLink(platform, shareLink) ? { shareLink } : {}),
    ...(typeof md5 === "string" && /^[a-f0-9]{32}$/i.test(md5) ? { mediaMd5sum: md5.toLowerCase() } : {}),
    ...(typeof clipId === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(clipId) ? { videoClipTaskId: clipId } : {}),
    ...(typeof scheduledTime === "number" && Number.isSafeInteger(scheduledTime) && scheduledTime > 0 && scheduledTime < 8640000000000000 ? { scheduledTime } : {}),
    ...(typeof publishTime === "number" && Number.isSafeInteger(publishTime) && publishTime > 0 && publishTime < 8640000000000000 ? { publishTime: new Date(publishTime).toISOString() } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

/** A runner is retained for the lifetime of a workbench. Every accepted task is consumed before any await. */
export function createPublishingPluginRunner(source?: unknown) {
  const started = new Set<string>();
  async function dispatch(permit: NativePublishingPermit, expected: PublishingPluginAccount, params: PublishingPluginParams, onProgress?: (event: PublishingPluginProgress) => void, shouldContinue: () => boolean = () => true): Promise<PublishingPluginReceipt> {
      if (permit.shouldExecute !== true || !permit.attemptId) throw new PublishingPluginError("permit_required");
      if (started.has(permit.attemptId)) throw new PublishingPluginError("already_started");
      // Even preflight failure after a claim consumes this browser's ability to replay that task.
      started.add(permit.attemptId);
      if (!shouldContinue()) throw new PublishingPluginError("session_changed");
      if (permit.platform !== params.platform || expected.platform !== params.platform) throw new PublishingPluginError("account_changed");
      const plugin = getPlugin(source);
      await verify(plugin);
      const current = await login(plugin, params.platform);
      if (current.uid !== expected.uid) throw new PublishingPluginError("account_changed");
      if (!shouldContinue()) throw new PublishingPluginError("session_changed");
      let raw: unknown;
      try {
        raw = await plugin.publish(params, event => {
          const progress = record(event);
          const stage = progress?.stage;
          if (!["download", "upload", "publish", "complete", "error"].includes(String(stage))) return;
          if (typeof progress?.progress !== "number" || !Number.isFinite(progress.progress)) return;
          // message/data may carry arbitrary secrets. Never forward either field.
          onProgress?.({ stage: stage as PublishingPluginProgress["stage"], progress: Math.min(100, Math.max(0, progress.progress)) });
        });
      } catch { throw new PublishingPluginError("publish_unknown"); }
      return projectPublishingReceipt(raw, params.platform);
  }
  return {
    /** Validated platform adapters reuse the same once-only dispatch boundary. */
    executeBrowserPermit: dispatch,
    async execute(claim: PublishingMutationResponse, expected: PublishingPluginAccount, params: PublishingPluginParams, onProgress?: (event: PublishingPluginProgress) => void, shouldContinue: () => boolean = () => true): Promise<PublishingPluginReceipt> {
      return dispatch({ attemptId: claim.task?.id || "", shouldExecute: claim.shouldExecute === true, platform: claim.task?.platform || params.platform }, expected, params, onProgress, shouldContinue);
    },
    async executeNative(permit: NativePublishingPermit, expected: PublishingPluginAccount, params: PublishingPluginParams, onProgress?: (event: PublishingPluginProgress) => void, shouldContinue: () => boolean = () => true): Promise<PublishingPluginReceipt> {
      const capability = NATIVE_PLATFORM_CAPABILITIES.find(item => item.platform === permit.platform);
      if (!capability || capability.transport !== "browser_plugin") throw new PublishingPluginError("transport_unavailable");
      const content = prepareNativePluginContent(params.platform, params.title, params.desc, params.topics);
      if (content.errors.length) throw new PublishingPluginError("media_invalid");
      if (!(capability.contentTypes as readonly string[]).includes(params.type)) throw new PublishingPluginError("media_invalid");
      const validFile = (file: unknown): file is File => typeof File !== "undefined" && file instanceof File && file.size > 0;
      if (params.type === "image" && (!params.images.length || params.images.length > capability.maxImages || params.images.some(file => !validFile(file) || !["image/jpeg", "image/png", "image/webp"].includes(file.type)))) throw new PublishingPluginError("media_invalid");
      if (params.type === "image" && params.images.some(file => file.size > 20 * 1024 ** 2)) throw new PublishingPluginError("media_invalid");
      if (params.type === "video" && (!validFile(params.video) || !/\.mp4$/i.test(params.video.name) || params.video.type !== "video/mp4" || (capability.coverRequired && (!validFile(params.cover) || !["image/jpeg", "image/png", "image/webp"].includes(params.cover.type))))) throw new PublishingPluginError("media_invalid");
      if (params.type === "video" && (params.video.size > 1024 ** 3 || params.cover && params.cover.size > 20 * 1024 ** 2)) throw new PublishingPluginError("media_invalid");
      if (params.scheduledTime !== undefined && (capability.scheduling !== "browser_plugin" || !Number.isFinite(params.scheduledTime) || params.scheduledTime <= Date.now())) throw new PublishingPluginError("media_invalid");
      if (params.platform === "wxSph") {
        const metadata = params.platformConfig?.wxSph?.videoMetadata;
        if (!metadata || ![metadata.width, metadata.height, metadata.duration, metadata.size].every(value => Number.isFinite(value) && value > 0) || metadata.duration > 3600 || params.type !== "video" || metadata.size !== params.video.size) throw new PublishingPluginError("media_invalid");
      }
      if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new PublishingPluginError('transport_unavailable');
      return navigator.locks.request(`publishing:browser:${params.platform}:${encodeURIComponent(expected.uid)}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new PublishingPluginError('account_busy');
        return dispatch(permit, expected, { ...params, title: content.title, desc: content.desc, topics: content.topics }, onProgress, shouldContinue);
      });
    },
  };
}

/** Search projections follow the native editor; raw plugin objects and errors never escape. */
export async function searchPublishingLocations(query: string, source?: unknown): Promise<NativeWxPoi[]> {
  if (query.trim().length < 2 || query.length > 120) return [];
  const plugin = getPlugin(source); await verify(plugin);
  if (typeof plugin.wxSphSearchLocation !== "function") throw new PublishingPluginError("search_unavailable");
  let value: unknown;
  try { value = await plugin.wxSphSearchLocation({ query: query.trim() }); } catch { throw new PublishingPluginError("search_unavailable"); }
  if (!Array.isArray(value)) throw new PublishingPluginError("search_unavailable");
  return value.slice(0, 50).flatMap(candidate => {
    const item = record(candidate); if (!item) return [];
    const poi: NativeWxPoi = {};
    for (const key of ["poiCity", "poiName", "poiAddress", "poiId", "province", "region", "fullAddress", "poiCheckSum"] as const) {
      const safe = text(item[key], key === "poiAddress" || key === "fullAddress" ? 500 : 200); if (safe) poi[key] = safe;
    }
    if (!poi.poiId || !poi.poiName) return [];
    if (typeof item.latitude === "number" && Number.isFinite(item.latitude) && Math.abs(item.latitude) <= 90) poi.latitude = item.latitude;
    if (typeof item.longitude === "number" && Number.isFinite(item.longitude) && Math.abs(item.longitude) <= 180) poi.longitude = item.longitude;
    return [poi];
  });
}
export async function searchPublishingActivities(query: string, source?: unknown): Promise<NativeWxEvent[]> {
  if (query.trim().length < 2 || query.length > 120) return [];
  const plugin = getPlugin(source); await verify(plugin);
  if (typeof plugin.wxSphSearchActivity !== "function") throw new PublishingPluginError("search_unavailable");
  let value: unknown;
  try { value = await plugin.wxSphSearchActivity({ query: query.trim() }); } catch { throw new PublishingPluginError("search_unavailable"); }
  if (!Array.isArray(value)) throw new PublishingPluginError("search_unavailable");
  return value.slice(0, 50).flatMap(candidate => {
    const item = record(candidate); if (!item) return [];
    const eventTopicId = text(item.eventTopicId, 200), eventName = text(item.eventName, 200);
    if (!eventTopicId || !eventName) return [];
    const nickname = text(item.eventCreatorNickname, 200);
    return [{ eventTopicId, eventName, ...(nickname ? { eventCreatorNickname: nickname } : {}),
      ...(typeof item.eventAttendCount === "number" && Number.isSafeInteger(item.eventAttendCount) && item.eventAttendCount >= 0 ? { eventAttendCount: item.eventAttendCount } : {}),
    }];
  });
}
