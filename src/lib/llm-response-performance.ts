import type { OperationPerformanceTrace } from "./operation-performance-trace";
import { SseEventStreamDecoder, type DecodedSseEvent } from "./sse-stream-decoder";

/** Observe the delivered protocol, without cloning, withholding or rewriting bytes. */
export function observeLlmPerformanceResponse(
  response: Response,
  trace: OperationPerformanceTrace | null,
): Response {
  if (!trace) return response;
  const sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  const decoder = sse ? new SseEventStreamDecoder() : null;
  let completed = false;
  let billingComplete = false;
  let businessError: { outcome: "error" | "unknown"; errorCode: string } | null = null;
  const inspect = (events: DecodedSseEvent[]) => {
    for (const event of events) {
      if (event.data.trim() === "[DONE]" || event.event === "done" || event.event === "conversation.chat.completed") completed = true;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(event.data); } catch {
        if (event.event === "error" && !businessError) businessError = { outcome: "error", errorCode: "LLM_RESPONSE_ERROR" };
        continue;
      }
      if (!payload || typeof payload !== "object") continue;
      if (payload.billing_complete === true) billingComplete = true;
      if (payload.error || event.event === "error" || payload.reconciliation_required === true) {
        const code = typeof payload.code === "string" ? payload.code : "LLM_RESPONSE_ERROR";
        const unknown = payload.reconciliation_required === true || /UNKNOWN|RECONCILIATION|PERSISTENCE_FAILED/u.test(code);
        // Unknown settlement/persistence must not be overwritten by a later error.
        if (!businessError || unknown) businessError = { outcome: unknown ? "unknown" : "error", errorCode: code };
      }
    }
  };
  let terminalObserved = false;
  const terminal = (override?: { outcome: "error" | "cancelled"; errorCode: string }) => {
    if (terminalObserved) return;
    terminalObserved = true;
    const result = override || businessError || (!response.ok
      ? { outcome: "error" as const, errorCode: "LLM_RESPONSE_ERROR" }
      : sse && !(completed && (billingComplete || response.headers.get("X-LLM-Guarded") === "true"))
        ? { outcome: "unknown" as const, errorCode: "LLM_STREAM_TERMINAL_UNKNOWN" }
        : { outcome: "success" as const, errorCode: null });
    trace.checkpoint("response.terminal", { ...result, httpStatus: response.status });
  };
  if (!response.body) {
    trace.checkpoint("response.first_byte", { httpStatus: response.status });
    terminal();
    return response;
  }
  const reader = response.body.getReader();
  let firstChunkObserved = false;
  const observedBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (terminalObserved) return; // Cancellation already closed the consumer.
          if (done) {
            if (decoder) inspect(decoder.finish());
            terminal();
            controller.close();
            return;
          }
          if (!firstChunkObserved) {
            // Local delivery/progress frames are response bytes, not upstream bytes.
            trace.checkpoint("response.first_byte", { httpStatus: response.status });
            firstChunkObserved = true;
          }
          if (decoder) inspect(decoder.push(value));
          controller.enqueue(value);
        }
      } catch (error) {
        if (!terminalObserved) {
          terminal({ outcome: "error", errorCode: "LLM_STREAM_OBSERVE_FAILED" });
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      terminal({ outcome: "cancelled", errorCode: "LLM_STREAM_CANCELLED" });
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(observedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}
