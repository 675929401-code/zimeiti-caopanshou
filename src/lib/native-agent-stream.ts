/** Main-site OpenAI-style SSE only. Never interprets model text as a tool grant. */
export type NativeAgentMainFrame = {
  text: string;
  done: boolean;
  billing: { operationId: string; creditsCharged: number } | null;
  errorCode: string | null;
};
export function readNativeAgentMainFrame(frame: string): NativeAgentMainFrame {
  const empty: NativeAgentMainFrame = { text: "", done: false, billing: null, errorCode: null };
  const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /u, "")).join("\n");
  if (data.trim() === "[DONE]") return { ...empty, done: true };
  if (!data) return empty;
  let raw: unknown;
  try { raw = JSON.parse(data); } catch { throw new Error("NATIVE_AGENT_STREAM_INVALID"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("NATIVE_AGENT_STREAM_INVALID");
  const row = raw as Record<string, unknown>;
  const choice = Array.isArray(row.choices) ? row.choices[0] as Record<string, unknown> | undefined : undefined;
  const delta = choice?.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {};
  const text = typeof delta.content === "string" ? delta.content : "";
  // Reasoning is not public task content. Only a server-issued billing receipt is retained.
  const billing = row.billing_complete === true && typeof row.operation_id === "string" && row.operation_id.length <= 160
    && typeof row.credits_charged === "number" && Number.isFinite(row.credits_charged) && row.credits_charged >= 0
    ? { operationId: row.operation_id, creditsCharged: row.credits_charged } : null;
  const errorCode = typeof row.code === "string" && /^[A-Z0-9_:.-]{1,100}$/u.test(row.code) ? row.code : row.error ? "NATIVE_AGENT_MAIN_RESPONSE_FAILED" : null;
  return { text, done: false, billing, errorCode };
}

export class NativeAgentSseDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private complete = false;
  push(chunk: Uint8Array): NativeAgentMainFrame[] {
    if (this.complete) throw new Error("NATIVE_AGENT_STREAM_ALREADY_ENDED");
    return this.consume(this.decoder.decode(chunk, { stream: true }));
  }
  finish(): NativeAgentMainFrame[] {
    if (this.complete) return [];
    this.complete = true;
    const frames = this.consume(this.decoder.decode());
    if (this.buffer.trim()) throw new Error("NATIVE_AGENT_STREAM_TRUNCATED");
    return frames;
  }
  private consume(text: string): NativeAgentMainFrame[] {
    this.buffer += text;
    const frames: NativeAgentMainFrame[] = [];
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/u.exec(this.buffer))) {
      const frame = this.buffer.slice(0, separator.index);
      if (new TextEncoder().encode(frame).byteLength > 65536) throw new Error("NATIVE_AGENT_STREAM_FRAME_TOO_LARGE");
      frames.push(readNativeAgentMainFrame(frame));
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
    }
    if (new TextEncoder().encode(this.buffer).byteLength > 65536) throw new Error("NATIVE_AGENT_STREAM_FRAME_TOO_LARGE");
    return frames;
  }
}

/** Old native UI event envelope, with database identity for reliable replay. */
export function nativeAgentSse(event: { id: string; seq: number; taskId: string; data: unknown }): Uint8Array {
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new Error("NATIVE_AGENT_EVENT_SEQUENCE_INVALID");
  return new TextEncoder().encode(`id: ${event.seq}\ndata: ${JSON.stringify({ ...Object(event.data), uuid: event.id, taskId: event.taskId })}\n\n`);
}
