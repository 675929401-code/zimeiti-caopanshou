import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { adminPasswordError } from "@/lib/admin-password-policy";
import { hashPassword, verifyPassword } from "@/lib/auth";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
} from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

async function requireSuper(request: NextRequest, requireStepUp: boolean) {
  const authorization = await authorizeAdminCapability(request, "security.manage", {
    requireStepUp,
    operation: "management_password",
  });
  if (!authorization.ok) return authorization;
  if (authorization.access.adminLevel !== "super_admin") {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "仅超级管理员可以配置平台管理密码", code: "SUPER_ADMIN_REQUIRED" }, { status: 403 }),
    };
  }
  return authorization;
}

async function readCurrentHash() {
  const { data, error } = await getSupabaseAdminClient()
    .from("platform_settings")
    .select("setting_key,setting_value")
    .in("setting_key", ["operation_password", "operation_password_hash"]);
  if (error) throw error;
  const rows = (data || []) as Array<{ setting_key: string; setting_value: string | null }>;
  return rows.find((row) => row.setting_key === "operation_password" && row.setting_value)?.setting_value
    || rows.find((row) => row.setting_key === "operation_password_hash" && row.setting_value)?.setting_value
    || "";
}

export async function GET(request: NextRequest) {
  const authorization = await requireSuper(request, false);
  if (!authorization.ok) return authorization.response;
  try {
    return NextResponse.json({ isSet: Boolean(await readCurrentHash()) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to check management password:", error);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authorization = await requireSuper(request, true);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json().catch(() => ({})) as {
      action?: "generate" | "set" | "change" | "remove";
      newPassword?: string;
      oldPassword?: string;
      password?: string;
    };
    const action = body.action || "set";
    const client = getSupabaseAdminClient();
    const currentHash = await readCurrentHash();
    const currentPassword = String(body.oldPassword || body.password || "");

    if (action === "remove") {
      if (currentHash && (!currentPassword || !await verifyPassword(currentPassword, currentHash))) {
        return NextResponse.json({ error: "当前管理密码错误" }, { status: 401 });
      }
      const { error } = await client.from("platform_settings").delete().in("setting_key", ["operation_password", "operation_password_hash"]);
      if (error) throw error;
      await appendAdminGovernanceAudit({
        actorId: authorization.actor.userId,
        actorLevel: "super_admin",
        permissionKey: "security.manage",
        action: "management_password_remove",
        result: "success",
        resource: "platform_settings",
        request,
      });
      return NextResponse.json({ success: true });
    }

    if ((action === "change" || (action === "set" && Boolean(currentHash)))
      && (!currentPassword || !await verifyPassword(currentPassword, currentHash))) {
      return NextResponse.json({ error: "当前管理密码错误" }, { status: 401 });
    }

    const rawPassword = action === "generate"
      ? `${crypto.randomBytes(5).toString("base64url")}8a`
      : String(body.newPassword || "");
    const passwordError = adminPasswordError(rawPassword);
    if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });
    const hash = await hashPassword(rawPassword);
    const { error } = await client.from("platform_settings").upsert(
      { setting_key: "operation_password", setting_value: hash, updated_at: new Date().toISOString() },
      { onConflict: "setting_key" },
    );
    if (error) throw error;
    await client.from("platform_settings").delete().eq("setting_key", "operation_password_hash");
    await appendAdminGovernanceAudit({
      actorId: authorization.actor.userId,
      actorLevel: "super_admin",
      permissionKey: "security.manage",
      action: action === "generate" ? "management_password_generate" : currentHash ? "management_password_change" : "management_password_set",
      result: "success",
      resource: "platform_settings",
      request,
    });
    return NextResponse.json(action === "generate" ? { success: true, password: rawPassword } : { success: true });
  } catch (error) {
    console.error("Failed to update management password:", error);
    return NextResponse.json({ error: "操作失败" }, { status: 500 });
  }
}
