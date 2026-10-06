import { NextResponse } from "next/server";
import { z } from "zod";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { redactOperationText } from "@/lib/operation-flight-recorder";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const MAX_REQUEST_BYTES = 32 * 1024;

const problemTypes = [
  "chat_timeout", "send_failed", "stream_interrupted", "api_error",
  "payment_create_failed", "payment_callback_missing", "balance_not_updated", "payment_timeout",
  "video_submit_failed", "video_poll_timeout", "video_billing_error", "video_all_channels_down",
  "cover_generate_failed", "cover_workflow_timeout", "cover_billing_error",
  "auth_login_failed", "auth_token_expired", "auth_register_code_failed",
  "network_error", "page_crash", "slow_response", "render_error", "manual_report",
] as const;

const diagnosticSchema = z.object({
  problem_type: z.enum(problemTypes),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  description: z.string().trim().min(1).max(2000),
  context: z.record(z.string(), z.unknown()).optional().default({}),
  conversation_id: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128).nullish(),
  agent_id: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128).nullish(),
  agent_name: z.string().trim().max(120).nullish(),
  page_url: z.string().trim().max(2048).nullish(),
}).strict();

class BodyTooLargeError extends Error {}

function isClientAbort(request: Request, error: unknown): boolean {
  if (request.signal.aborted) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError"
    || /aborted|abort|premature|terminated|connection closed|socket closed/iu.test(error.message);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new BodyTooLargeError();
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

const sensitiveKey = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|signature|sign)/i;

function sanitizePageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value, "http://diagnostic.local");
    // Diagnostic routing only needs the pathname. Query parameters can contain
    // short-lived media tickets, OAuth state, or other credentials and must
    // never be persisted in the diagnostic log.
    return parsed.pathname.slice(0, 2048) || "/";
  } catch {
    return value.split(/[?#]/u, 1)[0].slice(0, 2048) || null;
  }
}

function sanitizeContext(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactOperationText(value, 500) || "";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeContext(item, depth + 1));
  if (!value || typeof value !== "object") return String(value).slice(0, 500);

  const sanitized: Record<string, unknown> = {};
  for (const [rawKey, nested] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    const key = rawKey.slice(0, 64);
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") continue;
    sanitized[key] = sensitiveKey.test(key) ? "[REDACTED]" : sanitizeContext(nested, depth + 1);
  }
  return sanitized;
}

export async function POST(request: Request) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return NextResponse.json({ error: "未授权" }, { status: 401 });

  const auth = await verifyToken(token).catch(() => null);
  if (!auth?.userId) return NextResponse.json({ error: "未授权" }, { status: 401 });

  try {
    const parsed = diagnosticSchema.safeParse(await readBoundedJson(request));
    if (!parsed.success) {
      return NextResponse.json({ error: "诊断数据格式无效" }, { status: 400 });
    }

    const body = parsed.data;
    const context = sanitizeContext(body.context) as Record<string, unknown>;
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("diagnostic_logs")
      .insert({
        user_id: auth.userId,
        username: auth.username || null,
        display_name: auth.displayName || auth.username || null,
        problem_type: body.problem_type,
        severity: body.severity,
        description: redactOperationText(body.description, 2000) || "已记录异常",
        context,
        conversation_id: body.conversation_id || null,
        agent_id: body.agent_id || null,
        agent_name: redactOperationText(body.agent_name, 120),
        user_agent: (request.headers.get("user-agent") || "").slice(0, 512) || null,
        page_url: sanitizePageUrl(body.page_url),
        status: "pending",
      })
      .select("id, created_at")
      .single();

    if (error) {
      console.error("[diagnostic-logs] insert failed", { code: error.code });
      return NextResponse.json({ error: "上报失败" }, { status: 500 });
    }

    return NextResponse.json(
      { success: true, id: data.id, created_at: data.created_at },
      { status: 201 },
    );
  } catch (error) {
    // Automatic reports are fire-and-forget. Navigating away can close the XHR
    // while the server is still reading its body; that is a client cancellation,
    // not an application fault and must not pollute production error trends.
    if (isClientAbort(request, error)) {
      return new NextResponse(null, { status: 499 });
    }
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "请求体过大" }, { status: 413 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "诊断数据格式无效" }, { status: 400 });
    }
    console.error("[diagnostic-logs] request failed", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "服务器异常" }, { status: 500 });
  }
}
