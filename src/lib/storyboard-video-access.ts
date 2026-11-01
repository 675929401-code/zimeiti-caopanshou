export interface StoryboardVideoAccessOptions {
  scope?: "playback" | "download";
  filename?: string;
  source?: "origin";
  signal?: AbortSignal;
}

/** Obtain access to an existing owned video; this never submits a generation. */
export async function requestVideoAccessUrl(taskId: string, token: string, options: StoryboardVideoAccessOptions = {}): Promise<string> {
  if (typeof taskId !== "string" || !taskId.trim() || typeof token !== "string" || !token.trim()) throw new Error("缺少视频访问凭据，请重新登录后重试");
  const scope = options.scope ?? "playback";
  if (scope !== "playback" && scope !== "download") throw new Error("视频访问用途无效");
  if (options.source !== undefined && options.source !== "origin") throw new Error("视频来源选项无效");
  if (options.filename !== undefined && (typeof options.filename !== "string" || /[\r\n\0]/u.test(options.filename))) throw new Error("视频下载文件名无效");
  const params = new URLSearchParams({ taskId, scope });
  if (options.filename) params.set("name", options.filename);
  if (options.source) params.set("source", options.source);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, 15_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const response = await fetch(`/api/video/access-ticket?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal,
    });
    const data: unknown = await response.json().catch(() => null);
    const result = data && typeof data === "object" ? data as { url?: unknown; error?: unknown } : {};
    if (!response.ok) throw new Error(typeof result.error === "string" && result.error.trim() ? result.error : "视频访问凭据生成失败，请稍后重试");
    if (typeof result.url !== "string" || !result.url.trim() || !/^(?:\/(?!\/)|https?:\/\/)/iu.test(result.url)) throw new Error("视频播放地址无效，请刷新后重试");
    return result.url;
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) throw new Error("视频访问凭据请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
