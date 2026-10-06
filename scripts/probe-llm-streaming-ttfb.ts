import { randomUUID } from "node:crypto";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const adminUsername = process.env.VERIFY_ADMIN_USERNAME || "18685178259";
const timeoutMs = Number(process.env.LLM_STREAM_TIMEOUT_MS || 70_000);
const requestedModelId = process.env.LLM_STREAM_MODEL_ID || "";
const requestedModelName = process.env.LLM_STREAM_MODEL_NAME || "";

type PublicChatModel = {
  id: string;
  displayName: string;
  publicPrice?: number;
  capabilities?: Record<string, unknown>;
};

type SseProbeStats = {
  ok: boolean;
  baseUrl: string;
  model: {
    id: string;
    displayName: string;
    publicPrice: number | null;
  };
  http: {
    status: number;
    contentType: string;
    xAccelBuffering: string | null;
    cacheControl: string | null;
  };
  timings: {
    headersMs: number;
    firstBodyChunkMs: number | null;
    firstDataEventMs: number | null;
    firstContentDeltaMs: number | null;
    doneMs: number | null;
    totalMs: number;
  };
  stream: {
    bodyChunkCount: number;
    sseEventCount: number;
    contentEventCount: number;
    contentChars: number;
    firstDeltaChars: number;
    maxDeltaChars: number;
    sawDone: boolean;
    burstLike: boolean;
  };
  errors: string[];
};

async function createAdminToken(): Promise<string> {
  const providedToken = process.env.LLM_E2E_TOKEN?.trim();
  if (providedToken) return providedToken;

  if (process.env.LLM_E2E_ALLOW_DEV_SESSION === "1" && /^http:\/\/127\.0\.0\.1(?::\d+)?$/u.test(baseUrl)) {
    const response = await fetch(`${baseUrl}/api/auth/dev-session`, {
      headers: { "x-local-workbench": "ai-creation-studio-local" },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({})) as { token?: string; user?: { role?: string }; error?: string };
    if (!response.ok || !payload.token || payload.user?.role !== "admin") {
      throw new Error(payload.error || `local dev session failed with HTTP ${response.status}`);
    }
    return payload.token;
  }

  const db = getSupabaseClient();
  const { data: preferredAdmin } = await db
    .from("users")
    .select("id, username, display_name, role, is_active")
    .eq("username", adminUsername)
    .eq("role", "admin")
    .eq("is_active", true)
    .maybeSingle();

  const { data: fallbackAdmin, error: fallbackError } = preferredAdmin
    ? { data: null, error: null }
    : await db
      .from("users")
      .select("id, username, display_name, role, is_active")
      .eq("role", "admin")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

  if (fallbackError) throw fallbackError;
  const admin = preferredAdmin || fallbackAdmin;
  if (!admin?.id) throw new Error("no active admin user available for LLM streaming probe");

  return createToken({
    userId: String(admin.id),
    username: String(admin.username || "admin"),
    role: "admin",
    displayName: String(admin.display_name || "本地流式验证管理员"),
    sessionId: `llm-stream-${randomUUID()}`,
  });
}

async function fetchChatModels(token: string): Promise<PublicChatModel[]> {
  const response = await fetch(`${baseUrl}/api/chat-models`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`/api/chat-models failed with HTTP ${response.status}: ${text.slice(0, 180)}`);
  }
  const payload = JSON.parse(text) as { models?: PublicChatModel[] };
  if (!Array.isArray(payload.models) || payload.models.length === 0) {
    throw new Error("/api/chat-models returned no public chat models");
  }
  return payload.models;
}

function selectModel(models: PublicChatModel[]): PublicChatModel {
  if (requestedModelId) {
    const exact = models.find((model) => model.id === requestedModelId);
    if (!exact) throw new Error(`LLM_STREAM_MODEL_ID not found in public chat models: ${requestedModelId}`);
    return exact;
  }
  if (requestedModelName) {
    const byName = models.find((model) => model.displayName.toLowerCase().includes(requestedModelName.toLowerCase()));
    if (!byName) throw new Error(`LLM_STREAM_MODEL_NAME not found in public chat models: ${requestedModelName}`);
    return byName;
  }
  return models[0];
}

function extractContentDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const delta = first?.delta as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const deltaContent = delta?.content;
  const messageContent = message?.content;
  if (typeof deltaContent === "string") return deltaContent;
  if (typeof messageContent === "string") return messageContent;
  return "";
}

function extractError(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  const direct = value.error || value.message || value.code;
  return typeof direct === "string" ? direct.slice(0, 220) : "";
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("--plan")) {
    console.log(JSON.stringify({ mode: "plan", networkPosts: 0, command: "node --import tsx scripts/probe-llm-streaming-ttfb.ts" }));
    return;
  }
  const token = await createAdminToken();
  const models = await fetchChatModels(token);
  const model = selectModel(models);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const clientRequestId = `llm_stream_${randomUUID()}`;
  const startedAt = Date.now();

  const response = await fetch(`${baseUrl}/api/llm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": clientRequestId,
    },
    body: JSON.stringify({
      client_request_id: clientRequestId,
      messages: [{
        role: "user",
        content: [
          "请用中文写一段约 260 字的流式输出验收说明。",
          "要求：分成 4 个短段，语气自然，只输出正文，不要表格。",
          `验收标记：STREAM_TTFB_${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}`,
        ].join("\n"),
      }],
      stream: true,
      agentName: "AI对话",
      agentId: "__free_chat__",
      modelId: model.id,
      model_overridden: true,
      deepThinkingType: 0,
      deepThinkingOverridden: true,
      enableWebSearch: false,
      enableWebSearchOverridden: true,
      maxContextRounds: 0,
      maxContextTokens: 1200,
      maxReplyTokens: 420,
    }),
    signal: controller.signal,
  });

  const headersMs = Date.now() - startedAt;
  const contentType = response.headers.get("content-type") || "";
  const responseBody = response.body;
  if (!response.ok || !responseBody || !contentType.includes("text/event-stream")) {
    const text = await response.text().catch(() => "");
    clearTimeout(timeout);
    throw new Error(`streaming probe failed: status=${response.status}, contentType=${contentType}, body=${text.slice(0, 260)}`);
  }

  const decoder = new TextDecoder();
  const reader = responseBody.getReader();
  let pending = "";
  let firstBodyChunkMs: number | null = null;
  let firstDataEventMs: number | null = null;
  let firstContentDeltaMs: number | null = null;
  let doneMs: number | null = null;
  let bodyChunkCount = 0;
  let sseEventCount = 0;
  let contentEventCount = 0;
  let contentChars = 0;
  let firstDeltaChars = 0;
  let maxDeltaChars = 0;
  let sawDone = false;
  const errors: string[] = [];

  const consumeBlock = (block: string) => {
    const dataLines = block
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/u, ""));

    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    if (!data) return;

    if (firstDataEventMs === null) firstDataEventMs = Date.now() - startedAt;
    sseEventCount += 1;

    if (data === "[DONE]") {
      sawDone = true;
      doneMs = Date.now() - startedAt;
      return;
    }

    try {
      const parsed = JSON.parse(data) as unknown;
      const errorText = extractError(parsed);
      if (errorText) errors.push(errorText);
      const delta = extractContentDelta(parsed);
      if (delta) {
        if (firstContentDeltaMs === null) firstContentDeltaMs = Date.now() - startedAt;
        contentEventCount += 1;
        contentChars += delta.length;
        if (firstDeltaChars === 0) firstDeltaChars = delta.length;
        maxDeltaChars = Math.max(maxDeltaChars, delta.length);
      }
    } catch (error) {
      errors.push(error instanceof Error ? `JSON_PARSE_ERROR: ${error.message}` : "JSON_PARSE_ERROR");
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstBodyChunkMs === null) firstBodyChunkMs = Date.now() - startedAt;
      bodyChunkCount += 1;
      pending += decoder.decode(value, { stream: true });

      const blocks = pending.split(/\r?\n\r?\n/u);
      pending = blocks.pop() || "";
      for (const block of blocks) consumeBlock(block);
      if (sawDone) break;
    }
    pending += decoder.decode();
    if (pending.trim()) consumeBlock(pending);
  } finally {
    clearTimeout(timeout);
  }

  const totalMs = Date.now() - startedAt;
  const stats: SseProbeStats = {
    ok: sawDone && contentChars > 0 && errors.length === 0,
    baseUrl,
    model: {
      id: model.id,
      displayName: model.displayName,
      publicPrice: Number.isFinite(Number(model.publicPrice)) ? Number(model.publicPrice) : null,
    },
    http: {
      status: response.status,
      contentType,
      xAccelBuffering: response.headers.get("x-accel-buffering"),
      cacheControl: response.headers.get("cache-control"),
    },
    timings: {
      headersMs,
      firstBodyChunkMs,
      firstDataEventMs,
      firstContentDeltaMs,
      doneMs,
      totalMs,
    },
    stream: {
      bodyChunkCount,
      sseEventCount,
      contentEventCount,
      contentChars,
      firstDeltaChars,
      maxDeltaChars,
      sawDone,
      burstLike: contentEventCount <= 2 || (firstDeltaChars > 0 && firstDeltaChars / Math.max(contentChars, 1) > 0.7),
    },
    errors,
  };

  console.log(JSON.stringify(stats, null, 2));
  if (!stats.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
