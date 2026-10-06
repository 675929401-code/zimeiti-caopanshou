import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { DEFAULT_PAGE_LAYOUT, PageLayoutConfig } from "@/types/coze";

const SETTINGS_KEY = "page_layout";

// GET /api/settings/layout — 获取页面布局配置
export async function GET() {
  try {
    const client = getSupabaseAdminClient();
    const { data, error } = await client
      .from("platform_settings")
      .select("setting_value")
      .eq("setting_key", SETTINGS_KEY)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("[layout] fetch error:", error);
    }

    if (!data?.setting_value) {
      return NextResponse.json({ layout: DEFAULT_PAGE_LAYOUT });
    }

    const saved = typeof data.setting_value === "string" ? JSON.parse(data.setting_value) : data.setting_value;
    // 合并默认值，确保新增字段有值
    const layout: PageLayoutConfig = {
      card: { ...DEFAULT_PAGE_LAYOUT.card, ...saved?.card },
      nav: { ...DEFAULT_PAGE_LAYOUT.nav, ...saved?.nav },
      category: { ...DEFAULT_PAGE_LAYOUT.category, ...saved?.category },
    };

    return NextResponse.json({ layout });
  } catch (err) {
    console.error("[layout] GET error:", err);
    return NextResponse.json({ layout: DEFAULT_PAGE_LAYOUT });
  }
}

// PUT /api/settings/layout — 保存页面布局配置（仅管理员）
export async function PUT(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "brand.settings.manage", {
    operation: "brand_layout_settings_write",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    const { layout } = body;

    if (!layout) {
      return NextResponse.json({ error: "缺少布局配置" }, { status: 400 });
    }

    const client = getSupabaseAdminClient();
    const value = typeof layout === "string" ? layout : JSON.stringify(layout);

    const { error } = await client
      .from("platform_settings")
      .upsert(
        { setting_key: SETTINGS_KEY, setting_value: value, updated_at: new Date().toISOString() },
        { onConflict: "setting_key" }
      );

    if (error) {
      console.error("[layout] save error:", error);
      return NextResponse.json({ error: "保存失败" }, { status: 500 });
    }

    return NextResponse.json({ success: true, layout });
  } catch (err) {
    console.error("[layout] PUT error:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

// DELETE /api/settings/layout — 恢复默认布局（仅管理员）
export async function DELETE(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "brand.settings.manage", {
    operation: "brand_layout_settings_reset",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;
  try {
    const client = getSupabaseAdminClient();
    const { error } = await client
      .from("platform_settings")
      .delete()
      .eq("setting_key", SETTINGS_KEY);

    if (error) {
      console.error("[layout] delete error:", error);
      return NextResponse.json({ error: "重置失败" }, { status: 500 });
    }

    return NextResponse.json({ success: true, layout: DEFAULT_PAGE_LAYOUT });
  } catch (err) {
    console.error("[layout] DELETE error:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}
