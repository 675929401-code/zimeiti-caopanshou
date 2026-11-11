import "server-only";
import { Agent } from "undici";

/** Only generation responses which carry the image synchronously get a long
 * wait. Async submissions/status reads and other short HTTP calls stay apart. */
export function synchronousImageProviderTimeoutMs(protocol: unknown): number | undefined {
  if (protocol === "google_generate_content") return 12 * 60 * 1000;
  if (["images_generations", "images_edits", "chat_completions"].includes(String(protocol))) return 10 * 60 * 1000;
  return undefined;
}

/** One fetch, with no retries or global dispatcher mutation. Return the native
 * Response unchanged so existing audited body readers retain their semantics. */
export async function fetchSynchronousImageProvider(
  input: string | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12 * 60 * 1000) throw new Error("IMAGE_HTTP_TIMEOUT_INVALID");
  const method = init.method || (typeof input === "string" ? "GET" : input.method);
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  if (method.toUpperCase() === "POST") {
    const dispatch = dispatcher.dispatch.bind(dispatcher);
    let dispatched = false;
    // Native fetch can re-dispatch HTTP 421 internally even with redirects
    // disabled. A paid request may reach this local transport gate only once.
    dispatcher.dispatch = (options, handler) => {
      if (dispatched) throw new Error("IMAGE_HTTP_POST_ALREADY_DISPATCHED");
      dispatched = true;
      return dispatch(options, handler);
    };
  }
  const signals = [AbortSignal.timeout(timeoutMs), init.signal, typeof input === "string" ? undefined : input.signal]
    .filter((signal): signal is AbortSignal => Boolean(signal));
  // A 307/308 can replay a paid POST. Leave its outcome unknown instead of
  // following another endpoint, even if the original Request allowed redirects.
  const options: RequestInit & { dispatcher: Agent } = { ...init,
    ...(method.toUpperCase() === "POST" ? { redirect: "error" as const } : {}),
    signal: AbortSignal.any(signals), dispatcher };
  try {
    const response = await fetch(input, options);
    // close() is graceful: it waits for the in-flight response body. destroy()
    // here would cut off the existing bounded/audited body reader.
    void dispatcher.close().catch(() => undefined);
    return response;
  } catch (error) {
    await dispatcher.destroy().catch(() => undefined);
    throw error;
  }
}
