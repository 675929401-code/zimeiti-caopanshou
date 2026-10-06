import { randomUUID } from "node:crypto";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const adminUsername = process.env.VERIFY_ADMIN_USERNAME || "18685178259";
const perModelTimeoutMs = Number(process.env.LLM_E2E_TIMEOUT_MS || 35_000);

type PublicChatModel = {
  id: string;
  displayName: string;
  publicPrice?: number;
  capabilities?: Record<string, unknown>;
};

type ProbeResult = {
  id: string;
  displayName: string;
  publicPrice: number | null;
  status: number | null;
  ok: boolean;
  elapsedMs: number;
  responseBytes: number;
  code?: string;
  message?: string;
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
  if (!admin?.id) throw new Error("no active admin user available for LLM model E2E");

  return createToken({
    userId: String(admin.id),
    username: String(admin.username || "admin"),
    role: "admin",
    displayName: String(admin.display_name || "本地验收管理员"),
    sessionId: `llm-all-models-${randomUUID()}`,
  });
}

async function fetchChatModels(token: string): Promise<PublicChatModel[]> {
  const response = await fetch(`${baseUrl}/api/chat-models`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as { models?: PublicChatModel[]; error?: string };
  if (!response.ok || !Array.isArray(payload.models)) {
    throw new Error(payload.error || `/api/chat-models failed with HTTP ${response.status}`);
  }
  return payload.models;
}

function summarizeFailure(status: number | null, bodyText: string, thrown?: unknown): Pick<ProbeResult, "code" | "message"> {
  if (thrown) {
    return {
      code: thrown instanceof Error && thrown.name === "AbortError" ? "TIMEOUT" : "REQUEST_ERROR",
      message: thrown instanceof Error ? thrown.message.slice(0, 180) : String(thrown).slice(0, 180),
    };
  }

  try {
    const parsed = JSON.parse(bodyText) as { code?: string; error?: string; message?: string; details?: string };
    return {
      code: parsed.code || parsed.error || (status ? `HTTP_${status}` : "UNKNOWN"),
      message: String(parsed.message || parsed.details || parsed.error || "").slice(0, 220),
    };
  } catch {
    return {
      code: status ? `HTTP_${status}` : "UNKNOWN",
      message: bodyText.slice(0, 220),
    };
  }
}

async function probeModel(token: string, model: PublicChatModel, index: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), perModelTimeoutMs);
  const clientRequestId = `llm_all_${randomUUID()}`;
  const marker = `LLM_ALL_MODELS_E2E_${String(index + 1).padStart(2, "0")}_${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}`;
  const startedAt = Date.now();

  try {
    const response = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": clientRequestId,
      },
      body: JSON.stringify({
        client_request_id: clientRequestId,
        messages: [{ role: "user", content: `只回复 OK。验收标记：${marker}` }],
        stream: false,
        agentName: "AI对话",
        agentId: "__free_chat__",
        modelId: model.id,
        model_overridden: true,
        deepThinkingType: 0,
        deepThinkingOverridden: true,
        enableWebSearch: false,
        enableWebSearchOverridden: true,
        maxContextRounds: 0,
        maxContextTokens: 1000,
        maxReplyTokens: 8,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    const elapsedMs = Date.now() - startedAt;
    if (response.ok && text.trim().length > 0) {
      return {
        id: model.id,
        displayName: model.displayName,
        publicPrice: Number.isFinite(Number(model.publicPrice)) ? Number(model.publicPrice) : null,
        status: response.status,
        ok: true,
        elapsedMs,
        responseBytes: text.length,
      };
    }

    return {
      id: model.id,
      displayName: model.displayName,
      publicPrice: Number.isFinite(Number(model.publicPrice)) ? Number(model.publicPrice) : null,
      status: response.status,
      ok: false,
      elapsedMs,
      responseBytes: text.length,
      ...summarizeFailure(response.status, text),
    };
  } catch (error) {
    return {
      id: model.id,
      displayName: model.displayName,
      publicPrice: Number.isFinite(Number(model.publicPrice)) ? Number(model.publicPrice) : null,
      status: null,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      responseBytes: 0,
      ...summarizeFailure(null, "", error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("--plan")) {
    console.log(JSON.stringify({ mode: "plan", networkPosts: 0, command: "node --import tsx scripts/probe-llm-all-public-models-e2e.ts" }));
    return;
  }
  const token = await createAdminToken();
  const models = await fetchChatModels(token);
  if (models.length === 0) throw new Error("no public chat models exposed");

  const results: ProbeResult[] = [];
  for (const [index, model] of models.entries()) {
    results.push(await probeModel(token, model, index));
  }

  const failed = results.filter((item) => !item.ok);
  const priceSnapshotBlocked = failed.filter((item) =>
    /price|价格|snapshot|快照|PRICE/i.test(`${item.code || ""} ${item.message || ""}`),
  );

  console.log(JSON.stringify({
    ok: failed.length === 0,
    baseUrl,
    tested: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    priceSnapshotBlocked: priceSnapshotBlocked.length,
    results,
  }, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
