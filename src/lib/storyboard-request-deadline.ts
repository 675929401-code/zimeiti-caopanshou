/** Bounded transport waits never imply that a generation was not submitted. */
export const STORYBOARD_READ_DEADLINE_MS = 20_000;
export const STORYBOARD_VIDEO_SUBMIT_DEADLINE_MS = 240_000;

export class StoryboardRequestTimeoutError extends Error {
  readonly code = "STORYBOARD_REQUEST_TIMEOUT";
  constructor(message = "请求等待超时，请查询原请求状态后重试") {
    super(message);
    this.name = "StoryboardRequestTimeoutError";
  }
}

type DeadlineOptions = { timeoutMs?: number; message?: string };

function requestLease(parent: AbortSignal | null | undefined, options: DeadlineOptions) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectWait: (reason: unknown) => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
  const onAbort = () => {
    rejectWait(new DOMException("请求已停止", "AbortError"));
    controller.abort();
  };
  const timeoutMs = options.timeoutMs ?? STORYBOARD_READ_DEADLINE_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("请求等待时限无效");
  timer = setTimeout(() => {
    rejectWait(new StoryboardRequestTimeoutError(options.message));
    controller.abort();
  }, timeoutMs);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const stopTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  return {
    signal: controller.signal,
    wait: <T>(operation: () => Promise<T>) => Promise.race([interrupted, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new DOMException("请求已停止", "AbortError");
      return operation();
    })]),
    stopTimer,
    close: () => { stopTimer(); parent?.removeEventListener("abort", onAbort); controller.abort(); },
  };
}

/** Includes both response headers and the entire JSON body in one deadline. */
export async function fetchStoryboardJson<T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: DeadlineOptions = {},
): Promise<{ response: Response; data: T }> {
  const lease = requestLease(init.signal, options);
  try {
    return await lease.wait(async () => {
      const response = await fetch(input, { ...init, signal: lease.signal });
      const data = await response.json().catch(() => ({})) as T;
      return { response, data };
    });
  } finally { lease.close(); }
}

/** The header deadline ends at the handshake; caller closes the live stream. */
export async function openStoryboardStream(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: DeadlineOptions = {},
): Promise<{ response: Response; close: () => void }> {
  const lease = requestLease(init.signal, options);
  try {
    const response = await lease.wait(async () => {
      const result = await fetch(input, { ...init, signal: lease.signal });
      // Error bodies can also stall; finish reading them while still bounded.
      if (!result.ok && result.body) {
        const text = await result.text();
        return new Response(text, { status: result.status, statusText: result.statusText, headers: result.headers });
      }
      return result;
    });
    lease.stopTimer();
    return { response, close: lease.close };
  } catch (error) { lease.close(); throw error; }
}
