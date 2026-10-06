import { randomUUID } from "node:crypto";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const adminUsername = process.env.VERIFY_ADMIN_USERNAME || "18685178259";

type CoverModelRow = {
  id: string;
  name: string;
  model_name: string;
  provider: string | null;
  selling_price: number | null;
  cost_price: number | null;
};

async function createAdminToken(): Promise<string> {
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
  if (!admin?.id) throw new Error("no active admin user available for image model probe");
  return createToken({
    userId: String(admin.id),
    username: String(admin.username || "admin"),
    role: "admin",
    displayName: String(admin.display_name || "本地验收管理员"),
    sessionId: `image-models-${randomUUID()}`,
  });
}

async function main() {
  const db = getSupabaseClient();
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim() || await createAdminToken();
  const { data, error } = await db
    .from("cover_models")
    .select("id, name, model_name, provider, selling_price, cost_price")
    .eq("is_active", true)
    .eq("is_hidden", false)
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const rows = (data || []) as CoverModelRow[];
  if (rows.length === 0) throw new Error("no visible cover/image models");

  const results = [];
  for (const row of rows) {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/admin/image-test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ modelId: row.id }),
    });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      message?: string;
      diagnosticCode?: string;
      paidProbeUsed?: boolean;
      latency?: number;
    };
    results.push({
      id: row.id,
      name: row.name,
      modelName: row.model_name,
      provider: row.provider,
      sellingPrice: Number(row.selling_price),
      costPrice: Number(row.cost_price),
      httpStatus: response.status,
      ok: response.ok && payload.success === true && payload.paidProbeUsed === false,
      diagnosticCode: payload.diagnosticCode || null,
      latencyMs: payload.latency ?? Date.now() - startedAt,
      paidProbeUsed: payload.paidProbeUsed === true,
      message: String(payload.message || "").slice(0, 160),
    });
  }

  const failed = results.filter((item) => !item.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    baseUrl,
    tested: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    paidCalls: 0,
    results,
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
