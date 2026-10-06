import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const SETTINGS_KEY = "ui_preferences";

// GET /api/settings/ui-preferences — 获取UI偏好设置（导航/分类/智能体排序和显示覆盖）
export async function GET(request: NextRequest) {
  try {
    const client = getSupabaseAdminClient();
    const { data, error } = await client
      .from("platform_settings")
      .select("setting_value, updated_at")
      .eq("setting_key", SETTINGS_KEY)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("[ui-prefs] fetch error:", error);
    }

    if (!data?.setting_value) {
      return NextResponse.json({ preferences: null });
    }

    const preferences = typeof data.setting_value === "string"
      ? JSON.parse(data.setting_value)
      : data.setting_value;

    return NextResponse.json({ preferences, updatedAt: data.updated_at });
  } catch (err) {
    console.error("[ui-prefs] GET error:", err);
    return NextResponse.json({ preferences: null });
  }
}

// PUT /api/settings/ui-preferences — 保存UI偏好设置（仅管理员）
export async function PUT(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "brand.settings.manage", {
    operation: "brand_navigation_preferences_write",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    const { preferences } = body;

    if (!preferences || typeof preferences !== "object") {
      return NextResponse.json({ error: "缺少偏好数据" }, { status: 400 });
    }

    const client = getSupabaseAdminClient();
    const value = typeof preferences === "string" ? preferences : JSON.stringify(preferences);

    const { error } = await client
      .from("platform_settings")
      .upsert(
        { setting_key: SETTINGS_KEY, setting_value: value, updated_at: new Date().toISOString() },
        { onConflict: "setting_key" }
      );

    if (error) {
      console.error("[ui-prefs] save error:", error);
      return NextResponse.json({ error: "保存失败" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[ui-prefs] PUT error:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}
