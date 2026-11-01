import { captureOfflineAuthVersions, recordOfflineSession, recordOfflineTask } from "@/lib/media-history-offline-auth";

/** Identifies a transport failure, not a server-side denial or invalid ticket. */
export class MediaHistoryVideoNetworkError extends Error {
  constructor() {
    super("网络暂时不可用，请稍后重试");
    this.name = "MediaHistoryVideoNetworkError";
  }
}

/** Server refusal stays distinct from a transport failure for offline policy. */
export class MediaHistoryVideoAccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MediaHistoryVideoAccessError";
  }
}

/** Short-lived, task-scoped media tickets; never put the account token in a URL. */
export async function requestMediaHistoryVideoUrl(
  previewPath: string,
  token: string | null,
  options: { download?: boolean; filename?: string; signal?: AbortSignal; userId?: string } = {},
): Promise<string> {
  if (!token) throw new Error("请先登录后查看视频");
  const mainVideo = /^\/api\/video\/storage\/([A-Za-z0-9_.-]+)$/.exec(previewPath);
  const commerceVideo = /^\/api\/media-history\/commerce\/content\/([A-Za-z0-9_.-]+)$/.exec(previewPath);
  if (!mainVideo && !commerceVideo) throw new Error("视频记录缺少有效的播放入口");
  const params = new URLSearchParams(mainVideo
    ? { taskId: mainVideo[1], scope: options.download ? "download" : "playback" }
    : { assetId: commerceVideo![1], scope: options.download ? "download" : "playback" });
  if (mainVideo && options.filename) params.set("name", options.filename);
  const ticketEndpoint = mainVideo
    ? "/api/video/access-ticket"
    : "/api/media-history/commerce/access-ticket";
  const authVersions = options.userId && mainVideo ? captureOfflineAuthVersions(options.userId, token, mainVideo[1]) : null;
  let response: Response;
  try {
    response = await fetch(`${ticketEndpoint}?${params}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    if (error instanceof TypeError || (error instanceof DOMException && error.name === "NetworkError")) {
      throw new MediaHistoryVideoNetworkError();
    }
    throw error;
  }
  const current = () => !options.signal?.aborted;
  if (!response.ok) {
    // Revoke as soon as authenticated response headers establish a denial.
    // Error bodies can stall or be aborted; they must not keep an older grant alive.
    if (options.userId && mainVideo && current()) {
      if (response.status === 401 || response.status === 403) await recordOfflineSession(options.userId, token, "denied", current);
      else if (response.status === 404 || response.status === 410) await recordOfflineTask(options.userId, token, mainVideo[1], true, current);
    }
    const result = await response.json().catch(() => ({}));
    throw new MediaHistoryVideoAccessError(response.status, result.error || "视频暂时无法访问，请稍后重试");
  }
  const result = await response.json().catch(() => ({}));
  const target = new URL(String(result.url || ""), window.location.origin);
  const expectedPath = mainVideo
    ? (options.download ? "/api/video/proxy-download" : "/api/video/proxy")
    : `/api/media-history/commerce/content/${commerceVideo![1]}`;
  const validDownloadShape = Boolean(mainVideo) || options.download
    ? (Boolean(mainVideo) || target.searchParams.get("download") === "1")
    : !target.searchParams.has("download");
  if (
    target.origin !== window.location.origin
    || target.pathname !== expectedPath
    || !target.searchParams.get("media_ticket")
    || !validDownloadShape
  ) {
    throw new Error("视频播放入口无效，请刷新后重试");
  }
  if (options.userId && mainVideo && current()) {
    await recordOfflineSession(options.userId, token, "verified", current, authVersions?.session);
    await recordOfflineTask(options.userId, token, mainVideo[1], false, current, authVersions?.task);
    const currentVersions = captureOfflineAuthVersions(options.userId, token, mainVideo[1]);
    if (authVersions && (currentVersions.session !== authVersions.session || currentVersions.task !== authVersions.task)) {
      throw new MediaHistoryVideoAccessError(403, "视频访问状态已更新，请重新验证");
    }
  }
  return `${target.pathname}${target.search}`;
}
