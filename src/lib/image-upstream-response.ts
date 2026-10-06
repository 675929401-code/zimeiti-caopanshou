export type ParsedImageUpstreamResponse = {
  format: "json" | "sse" | "invalid";
  payload: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
};

export type ParsedImageSseFrame = {
  eventType: string;
  payload: Record<string, unknown>;
};

export class ImageUpstreamResponseTooLargeError extends Error {
  readonly maximumBytes: number;

  constructor(maximumBytes: number) {
    super(`图片上游响应超过 ${maximumBytes} 字节限制`);
    this.name = "ImageUpstreamResponseTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerError(payload: Record<string, unknown> | null, eventType = "") {
  const rawError = payload?.error;
  const structured = objectValue(rawError);
  const message = typeof rawError === "string"
    ? rawError
    : typeof structured?.message === "string"
      ? structured.message
      : typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.detail === "string"
          ? payload.detail
          : "";
  const code = String(structured?.code || structured?.type || payload?.code || eventType || "IMAGE_UPSTREAM_EVENT_ERROR").trim();
  return eventType.toLowerCase() === "error" || Boolean(rawError)
    ? { code: code || "IMAGE_UPSTREAM_EVENT_ERROR", message: message || "上游返回错误事件" }
    : null;
}

function parseObject(value: string) {
  try { return objectValue(JSON.parse(value)); } catch { return null; }
}

function mergePayload(left: Record<string, unknown> | null, right: Record<string, unknown>) {
  if (!left) return structuredClone(right);
  const merged: Record<string, unknown> = { ...left };
  for (const [key, rightValue] of Object.entries(right)) {
    const leftValue = merged[key];
    if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      merged[key] = [...leftValue, ...rightValue];
    } else {
      const leftObject = objectValue(leftValue);
      const rightObject = objectValue(rightValue);
      merged[key] = leftObject && rightObject ? mergePayload(leftObject, rightObject) : rightValue;
    }
  }
  return merged;
}

export function parseImageSseFrames(raw: string): ParsedImageSseFrame[] {
  const frames: ParsedImageSseFrame[] = [];
  for (const block of raw.trim().split(/\r?\n\r?\n/u)) {
    let eventType = "";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const joined = dataLines.join("\n").trim();
    if (!joined || joined === "[DONE]") continue;
    const joinedPayload = parseObject(joined);
    if (joinedPayload) {
      frames.push({ eventType, payload: joinedPayload });
      continue;
    }
    // Some relays omit the blank line between events. Preserve every complete
    // JSON data line rather than accidentally returning only the final event.
    for (const dataLine of dataLines) {
      const payload = parseObject(dataLine.trim());
      if (payload) frames.push({ eventType, payload });
    }
  }
  return frames;
}

export async function readImageUpstreamResponseText(response: Response, maximumBytes: number) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ImageUpstreamResponseTooLargeError(maximumBytes);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ImageUpstreamResponseTooLargeError(maximumBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export function parseImageUpstreamResponse(raw: string, contentType = ""): ParsedImageUpstreamResponse {
  const trimmed = raw.trim();
  const direct = parseObject(trimmed);
  if (direct) return { format: "json", payload: direct, error: providerError(direct) };

  const looksLikeSse = contentType.toLowerCase().includes("text/event-stream")
    || /^(?:event|data):/mu.test(trimmed);
  if (!looksLikeSse) return { format: "invalid", payload: null, error: null };

  let aggregatePayload: Record<string, unknown> | null = null;
  for (const { eventType, payload } of parseImageSseFrames(trimmed)) {
    const error = providerError(payload, eventType);
    if (error) return { format: "sse", payload, error };
    aggregatePayload = mergePayload(aggregatePayload, payload);
  }
  return { format: "sse", payload: aggregatePayload, error: null };
}
