import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

const SETTING_KEY = "video_page_config";

// GET /api/settings/video-page - 获取视频页面配置（公开）
export async function GET() {
  try {
    const client = getSupabaseAdminClient();
    const { data, error } = await client
      .from("platform_settings")
      .select("setting_value")
      .eq("setting_key", SETTING_KEY)
      .single();

    if (error || !data) {
      return NextResponse.json({ config: null });
    }

    let config = null;
    try {
      config = JSON.parse(data.setting_value);
    } catch {
      config = null;
    }

    return NextResponse.json({ config });
  } catch (err) {
    console.error("Failed to fetch video page config:", err);
    return NextResponse.json({ config: null });
  }
}

// PUT /api/settings/video-page - 更新视频页面配置（仅管理员）
export async function PUT(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "brand.settings.manage", {
    operation: "brand_video_page_settings_write",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    const { config } = body as { config: Record<string, unknown> };

    if (!config || typeof config !== "object") {
      return NextResponse.json({ error: "无效的配置数据" }, { status: 400 });
    }

    const client = getSupabaseAdminClient();
    const { error } = await client
      .from("platform_settings")
      .upsert(
        {
          setting_key: SETTING_KEY,
          setting_value: JSON.stringify(config),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "setting_key" }
      );

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to update video page config:", err);
    return NextResponse.json({ error: "更新配置失败" }, { status: 500 });
  }
}
