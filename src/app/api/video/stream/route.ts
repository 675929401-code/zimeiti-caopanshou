import { NextRequest } from "next/server";

import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { readOwnedVideoTaskStatus } from "@/lib/video-task-status";

const SNAPSHOT_INTERVAL_MS = 3_000;
const HEARTBEAT_EVERY = 5;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function terminalEvent(status: string) {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "progress";
}

/**
 * Authenticated passive SSE observer.
 *
 * The dedicated media worker owns provider polling, task transitions, stable
 * asset persistence, and settlement. This GET only repeats an owner-scoped
 * database snapshot, so browser reconnects and multiple tabs cannot amplify
 * supplier requests or race terminal accounting.
 */
export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;

  const searchParams = new URL(request.url).searchParams;
  if (!searchParams.get("taskId") || !searchParams.get("modelId")) {
    return Response.json({ error: "缺少taskId或modelId" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        if (cancelled || request.signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        let iteration = 0;
        while (!cancelled && !request.signal.aborted) {
          const response = await readOwnedVideoTaskStatus(authorization.user, searchParams);
          const payload = await response.json().catch(() => ({
            error: "任务状态暂时无法读取，请稍后重试",
          })) as Record<string, unknown>;
          const status = String(payload.status || "");
          if (!response.ok) {
            if (response.status === 404 || response.status === 410) {
              send("failed", {
                ...payload,
                taskId: searchParams.get("taskId"),
                status: "failed",
                errorMessage: payload.errorMessage || payload.error || "任务不可用",
                retryable: false,
              });
              break;
            }
            send("error", {
              taskId: searchParams.get("taskId"),
              message: payload.errorMessage || payload.error || "任务状态暂时无法读取",
              errorCode: payload.errorCode || payload.code || "VIDEO_STATUS_READ_FAILED",
            });
          } else {
            const event = terminalEvent(status);
            send(event, payload);
            if (event !== "progress") break;
          }
          iteration += 1;
          if (iteration % HEARTBEAT_EVERY === 0) send("heartbeat", { ts: Date.now() });
          await sleep(SNAPSHOT_INTERVAL_MS, request.signal);
        }
      } catch {
        send("error", {
          taskId: searchParams.get("taskId"),
          message: "任务状态连接暂时中断，页面会安全重连",
          errorCode: "VIDEO_STATUS_STREAM_INTERRUPTED",
        });
      } finally {
        if (!cancelled) {
          cancelled = true;
          try { controller.close(); } catch { /* already closed by the client */ }
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
