import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

async function main() {
  if (!String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim()) {
    const previewRuntime = await import("./start-local-data-preview.mjs");
    const runtime = JSON.parse(await readFile(previewRuntime.LOCAL_PREVIEW_RUNTIME_FILE, "utf8"));
    const local = previewRuntime.validateLocalPreviewRuntime(runtime);
    process.env.COZE_SUPABASE_URL = local.supabaseUrl;
    process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = local.serviceRoleKey;
    process.env.COZE_SUPABASE_ANON_KEY = local.anonKey;
    process.env.JWT_SECRET = local.jwtSecret;

    const [{ createToken }, { getSupabaseClient }] = await Promise.all([
      import("@/lib/auth"),
      import("@/storage/database/supabase-client"),
    ]);
    const db = getSupabaseClient();
    const { data, error } = await db
      .from("users")
      .select("id, username, display_name")
      .eq("role", "admin")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    assert.ok(data?.id, "LOCAL_ACCEPTANCE_ADMIN_REQUIRED");
    process.env.LOCAL_NAV_ADMIN_TOKEN = await createToken({
      userId: String(data.id),
      username: String(data.username || "admin"),
      role: "admin",
      displayName: String(data.display_name || "商业IP定位验收"),
      sessionId: `bip-positioning-acceptance-${randomUUID()}`,
    });
  }

  await import("./verify-business-ip-positioning-live.mjs");
}

void main();
