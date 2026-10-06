/** Short-lived, task-scoped media tickets; never put the account token in a URL. */
export async function requestMediaHistoryVideoUrl(
  previewPath: string,
  token: string | null,
  options: { download?: boolean; filename?: string; signal?: AbortSignal } = {},
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
  const response = await fetch(`${ticketEndpoint}?${params}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: options.signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "视频暂时无法访问，请稍后重试");
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
  return `${target.pathname}${target.search}`;
}
