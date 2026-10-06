import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { normalizePluginMetadata } from "@/lib/plugin-metadata";

/**
 * 公共插件元数据读取 API。
 * 此路由可由浏览器访问，因此绝不返回 config、密钥或内部端点。
 * 
 * GET /api/plugins/active?role=extract_workflow
 * GET /api/plugins/active?role=cover_workflow
 * GET /api/plugins/active?role=thinking_model
 */

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const role = searchParams.get("role");

    if (!role) {
      return NextResponse.json({ error: "必须指定 role 参数" }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from("plugins")
      .select("id, name, type, subtype, role, price_per_use, price_unit")
      .eq("role", role)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[Plugins/Active] Fetch error:", error);
      return NextResponse.json({ error: "读取插件配置失败" }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ plugin: null });
    }

    // 仅返回公开元数据；业务端的私密配置必须通过服务端仓储直接读取。
    return NextResponse.json({ plugin: normalizePluginMetadata(data) });
  } catch (err) {
    console.error("[Plugins/Active] GET error:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}
