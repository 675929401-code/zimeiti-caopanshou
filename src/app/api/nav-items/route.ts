import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";

// GET - 获取前端展示的导航项（仅active的）
export async function GET() {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("nav_items")
      .select("id, name, icon, icon_type, icon_image, description, status, sort_order")
      .eq("is_active", true)
      .neq("status", "hidden")
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[nav-items] public GET error:", error);
      return NextResponse.json({ error: "Realtime navigation data unavailable" }, { status: 503 });
    }
    return NextResponse.json({ navItems: data || [] });
  } catch (err) {
    console.error("[nav-items] public GET exception:", err);
    return NextResponse.json({ error: "Realtime navigation data unavailable" }, { status: 503 });
  }
}
