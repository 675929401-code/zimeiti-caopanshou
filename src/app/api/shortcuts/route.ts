import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";

// GET - 获取已启用的快捷图标（公开接口，前台侧边栏使用）
export async function GET() {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("shortcut_icons")
      .select("id, title, icon_svg, icon_color, link_type, link_value, sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) return NextResponse.json({ error: "获取快捷图标失败" }, { status: 500 });
    return NextResponse.json({ shortcuts: data || [] });
  } catch {
    return NextResponse.json({ error: "获取快捷图标失败" }, { status: 500 });
  }
}
