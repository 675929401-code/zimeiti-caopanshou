/**
 * Chat 工具函数 — 从 app-context.tsx 拆分出的纯函数
 * 
 * 零 React 依赖，零 hooks。
 */

/**
 * 判断会话ID是否为本地临时ID（尚未在Coze服务端创建）
 */
export function isLocalConvId(id: string): boolean {
  return id.startsWith("local_") || id.startsWith("conv_");
}

/** Cross-realm safe AbortError detection for browser, tests and embedded webviews. */
export function isAbortLikeError(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

/**
 * 带自动重试的 fetch — 仅对网络级错误（TypeError）自动重试
 * 
 * - TypeError("Failed to fetch"/"network error") = 瞬态网络错误 → 重试
 * - AbortError = 用户取消 → 不重试，直接抛出
 * - 正常 HTTP 响应（含 4xx/5xx）→ 不重试，直接返回 Response
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 1,
  baseDelay = 1500,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const signalAborted = (options.signal as AbortSignal | undefined)?.aborted;
      console.log(`[fetchWithRetry] attempt=${attempt}, url=${url}, signal.aborted=${signalAborted}`);
      const res = await fetch(url, options);
      console.log(`[fetchWithRetry] fetch returned: status=${res.status}, ok=${res.ok}`);
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const isAbortError = isAbortLikeError(err, options.signal as AbortSignal | undefined);
      if (isAbortError) {
        console.warn(`[fetchWithRetry] AbortError on attempt=${attempt}`);
        throw lastError;
      }

      const isTypeError = err instanceof TypeError;
      if (!isTypeError || attempt >= maxRetries) {
        console.warn(`[fetchWithRetry] FAILED: attempt=${attempt}, isTypeError=${isTypeError}, error=${lastError.message}`);
        throw lastError;
      }

      const delay = baseDelay * (attempt + 1);
      console.warn(`[fetchWithRetry] 网络错误，${delay}ms 后重试 (${attempt + 1}/${maxRetries})...`, lastError.message);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError || new Error("Network error");
}
