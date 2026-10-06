export interface DecodedSseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

interface PendingSseEvent {
  event: string;
  data: string[];
  id?: string;
  retry?: number;
}

function emptyPendingEvent(): PendingSseEvent {
  return { event: "message", data: [] };
}

/**
 * Incremental UTF-8/SSE decoder. It keeps partial code points and partial SSE
 * fields between network chunks, supports multi-line data, and de-duplicates
 * replayed events when the server provides an SSE id.
 */
export class SseEventStreamDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly seenEventIds = new Set<string>();
  private buffer = "";
  private pending = emptyPendingEvent();
  private skipLeadingLf = false;

  push(chunk: Uint8Array): DecodedSseEvent[] {
    this.appendDecodedText(this.decoder.decode(chunk, { stream: true }));
    return this.drain(false);
  }

  finish(): DecodedSseEvent[] {
    this.appendDecodedText(this.decoder.decode());
    return this.drain(true);
  }

  resetReplayWindow(): void {
    this.seenEventIds.clear();
  }

  private appendDecodedText(text: string): void {
    // A CR already terminates a line. When CRLF spans network chunks, consume
    // the following LF without inventing a blank line and dispatching early.
    // Empty decoder output (including partial UTF-8) must retain this state.
    if (!text) return;
    if (this.skipLeadingLf && text.startsWith("\n")) text = text.slice(1);
    this.skipLeadingLf = text.endsWith("\r");
    this.buffer += text;
  }

  private drain(flush: boolean): DecodedSseEvent[] {
    const normalized = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    this.buffer = flush ? "" : (lines.pop() ?? "");
    const events: DecodedSseEvent[] = [];

    for (const line of lines) {
      if (line === "") {
        const event = this.dispatchPending();
        if (event) events.push(event);
        continue;
      }
      if (line.startsWith(":")) continue;

      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") this.pending.event = value || "message";
      else if (field === "data") this.pending.data.push(value);
      else if (field === "id" && !value.includes("\u0000")) this.pending.id = value;
      else if (field === "retry" && /^\d+$/.test(value)) this.pending.retry = Number(value);
    }

    if (flush) {
      const event = this.dispatchPending();
      if (event) events.push(event);
    }
    return events;
  }

  private dispatchPending(): DecodedSseEvent | null {
    const current = this.pending;
    this.pending = emptyPendingEvent();
    if (current.data.length === 0) return null;
    if (current.id && this.seenEventIds.has(current.id)) return null;
    if (current.id) this.seenEventIds.add(current.id);
    return {
      event: current.event || "message",
      data: current.data.join("\n"),
      ...(current.id ? { id: current.id } : {}),
      ...(current.retry != null ? { retry: current.retry } : {}),
    };
  }
}

/** Merge a continuation without duplicating the suffix re-sent by the model. */
export function mergeContinuationText(base: string, continuation: string): string {
  if (!base) return continuation;
  if (!continuation) return base;
  const maxOverlap = Math.min(base.length, continuation.length, 16_384);
  for (let size = maxOverlap; size >= 4; size--) {
    if (base.slice(-size) === continuation.slice(0, size)) {
      return base + continuation.slice(size);
    }
  }
  return base + continuation;
}
