/** Provider delivery references are metadata, never a request to copy bytes. */
export function providerMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

export const MEDIA_STREAM_IDLE_MS = 30_000;
export const MEDIA_CANCEL_DEADLINE_MS = 20_000;

/** A stalled connection falls back to snapshots without cancelling its task. */
export async function readMediaStreamWithDeadline<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs = MEDIA_STREAM_IDLE_MS,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("实时连接暂时没有回应，正在改用任务状态查询"));
          void reader.cancel().catch(() => undefined);
        }, idleMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
