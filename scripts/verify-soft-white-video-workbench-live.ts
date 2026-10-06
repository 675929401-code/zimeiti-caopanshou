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
      displayName: String(data.display_name || "本地验收管理员"),
      sessionId: `theme-acceptance-${randomUUID()}`,
    });
  }

  const navigationOnly = process.argv.includes("--navigation-only");
  if (!navigationOnly) {
    await import("./verify-soft-white-video-workbench-live.mjs");
  }
  if (process.argv.includes("--navigation") || navigationOnly) {
    const { main: verifyNavigation } = await import("./verify-local-navigation-experience.mjs");
    const runId = `theme-r344-primary-${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}`;
    await verifyNavigation(["--scope=primary", `--run-id=${runId}`]);
  }
}

void main();
