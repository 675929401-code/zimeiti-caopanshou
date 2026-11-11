export class CoverRequestBodyError extends Error {
  constructor(message: string, readonly status: 413 | 422) { super(message); }
}

/** Enforce the limit while reading; Content-Length is only an early hint. */
export async function readCoverRequestJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > maximumBytes) throw new CoverRequestBodyError("封面参数过大", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new CoverRequestBodyError("缺少封面参数", 422);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) { await reader.cancel(); throw new CoverRequestBodyError("封面参数过大", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CoverRequestBodyError("封面参数格式无效，请检查后再提交", 422); }
}
