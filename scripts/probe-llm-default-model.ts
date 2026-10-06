import assert from "node:assert/strict";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");

async function main() {
  const client = getSupabaseClient();
  const { data: admin, error } = await client
    .from("users")
    .select("id, username, display_name")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  assert.ok(admin?.id, "no active admin user available for local default-model probe");

  const token = await createToken({
    userId: admin.id,
    username: admin.username || "admin",
    role: "admin",
    displayName: admin.display_name || "本地验证管理员",
    sessionId: `probe-${crypto.randomUUID()}`,
  });

  const clientRequestId = `llm_${crypto.randomUUID()}`;
  const marker = `CODEX_MODEL_CANARY_${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}`;
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
      messages: [{ role: "user", content: `只回复 OK。验证标记：${marker}` }],
      stream: false,
      agentName: "AI对话",
      agentId: "__free_chat__",
      deepThinkingType: 0,
      deepThinkingOverridden: true,
      enableWebSearch: false,
      enableWebSearchOverridden: true,
    }),
  });

  const text = await response.text();
  const elapsedMs = Date.now() - startedAt;
  if (!response.ok) {
    let code = "";
    try {
      const json = JSON.parse(text) as { code?: string; error?: string };
      code = json.code || json.error || "";
    } catch {
      code = text.slice(0, 160);
    }
    throw new Error(`LLM default-model probe failed: status=${response.status} code=${code}`);
  }

  assert.ok(text.trim().length > 0, "LLM default-model probe returned empty response");
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    status: response.status,
    elapsedMs,
    responseBytes: text.length,
    marker,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
