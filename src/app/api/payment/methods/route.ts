// 🔒 核心底层代码 — 锁定保护
//
// 本文件是支付方式配置 API。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #12 支付系统"。

import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

// GET /api/payment/methods - 获取活跃的支付方式列表（公开接口）
export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("payment_methods")
      .select("id, name, code, icon, provider, is_active, sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("获取支付方式失败:", error);
      return NextResponse.json({ error: "实时支付数据暂不可用", code: "REALTIME_DATA_UNAVAILABLE" }, { status: 503 });
    }

    return NextResponse.json({ methods: data || [] });
  } catch (error) {
    console.error("支付方式API异常:", error);
    return NextResponse.json({ error: "服务器异常" }, { status: 500 });
  }
}
