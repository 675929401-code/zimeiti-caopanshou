import assert from "node:assert/strict";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const adminUsername = process.env.VERIFY_ADMIN_USERNAME || "18685178259";

type PublicModel = {
  id?: string;
  displayName?: string;
  publicPrice?: number;
  capabilities?: Record<string, unknown>;
};

async function fetchJson<T>(path: string, token?: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed: status=${response.status} body=${text.slice(0, 180)}`);
  }
  return JSON.parse(text) as T;
}

function modelRows(payload: unknown): PublicModel[] {
  const value = payload as { models?: unknown };
  return Array.isArray(value.models) ? value.models as PublicModel[] : [];
}

function assertPublicModels(name: string, rows: PublicModel[], expectedType: string, options: {
  requirePositivePrice?: boolean;
} = {}): void {
  assert.ok(rows.length > 0, `${name} should expose at least one model`);
  for (const [index, row] of rows.entries()) {
    assert.match(String(row.id || ""), /^pm_[A-Za-z0-9_-]{16,120}$/u, `${name}[${index}] public id invalid`);
    assert.ok(String(row.displayName || "").trim(), `${name}[${index}] displayName missing`);
    assert.equal(row.capabilities?.type, expectedType, `${name}[${index}] type mismatch`);
    assert.ok(Number.isFinite(Number(row.publicPrice)), `${name}[${index}] publicPrice must be finite`);
    if (options.requirePositivePrice) {
      assert.ok(Number(row.publicPrice) > 0, `${name}[${index}] publicPrice must be positive`);
    }
  }
}

async function main() {
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
  assert.ok(admin?.id, "no active admin user available");

  const token = await createToken({
    userId: String(admin.id),
    username: String(admin.username || "admin"),
    role: "admin",
    displayName: String(admin.display_name || "本地验证管理员"),
    sessionId: `model-catalog-${crypto.randomUUID()}`,
  });

  const [chatPayload, youcaiChatPayload, imagePayload, videoPayload] = await Promise.all([
    fetchJson("/api/chat-models", token),
    fetchJson("/api/youcai/chat-models", token),
    fetchJson("/api/cover-models?surface=image-workbench", token),
    fetchJson("/api/video/models?surface=video-page", token),
  ]);

  const chatModels = modelRows(chatPayload);
  const youcaiChatModels = modelRows(youcaiChatPayload);
  const imageModels = modelRows(imagePayload);
  const videoModels = modelRows(videoPayload);

  assertPublicModels("chatModels", chatModels, "text");
  assertPublicModels("youcaiChatModels", youcaiChatModels, "text");
  assertPublicModels("imageModels", imageModels, "image", { requirePositivePrice: true });
  assertPublicModels("videoModels", videoModels, "video", { requirePositivePrice: true });

  const { data: coverRows, error: coverError } = await db
    .from("cover_models")
    .select("id, name, model_name, provider, api_endpoint, api_key, cost_price, selling_price, is_active, is_hidden")
    .eq("is_active", true)
    .eq("is_hidden", false)
    .order("sort_order", { ascending: true });
  if (coverError) throw coverError;

  const coverProblems = (coverRows || []).flatMap((row: Record<string, unknown>) => {
    const problems: string[] = [];
    if (!String(row.model_name || "").trim()) problems.push("model_name missing");
    if (!String(row.api_endpoint || "").trim()) problems.push("api_endpoint missing");
    if (!String(row.api_key || "").trim()) problems.push("api_key missing");
    if (!Number.isFinite(Number(row.cost_price)) || Number(row.cost_price) < 0) problems.push("cost_price invalid");
    if (!Number.isFinite(Number(row.selling_price)) || Number(row.selling_price) <= 0) problems.push("selling_price invalid");
    return problems.map((problem) => `${row.id}: ${problem}`);
  });
  assert.deepEqual(coverProblems, [], `cover model config problems: ${coverProblems.join("; ")}`);

  const firstCover = (coverRows || [])[0] as { id?: string; name?: string } | undefined;
  assert.ok(firstCover?.id, "no visible cover model for zero-cost admin connection check");
  const imageTest = await fetch(`${baseUrl}/api/admin/image-test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ modelId: firstCover.id }),
  });
  const imageTestPayload = await imageTest.json().catch(() => ({})) as {
    success?: boolean;
    message?: string;
    paidProbeUsed?: boolean;
    diagnosticCode?: string;
  };
  assert.equal(imageTest.ok, true, "admin image-test HTTP failed");
  assert.equal(imageTestPayload.paidProbeUsed, false, "admin image-test must remain zero-cost");
  assert.equal(imageTestPayload.success, true, `admin image-test failed: ${imageTestPayload.message || imageTestPayload.diagnosticCode || "unknown"}`);

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    adminMatched: String(admin.username || "") === adminUsername,
    counts: {
      chatModels: chatModels.length,
      youcaiChatModels: youcaiChatModels.length,
      imageModels: imageModels.length,
      videoModels: videoModels.length,
      visibleCoverModels: (coverRows || []).length,
    },
    defaults: {
      chat: chatModels[0]?.displayName,
      youcaiChat: youcaiChatModels[0]?.displayName,
      image: imageModels[0]?.displayName,
      video: videoModels[0]?.displayName,
    },
    zeroCostChecks: {
      imageModelConnection: {
        model: firstCover.name || firstCover.id,
        diagnosticCode: imageTestPayload.diagnosticCode || "CONTRACT_OK",
        paidProbeUsed: false,
      },
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
