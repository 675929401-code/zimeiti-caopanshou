import { NextResponse } from "next/server";
import { getBillingRules } from "@/lib/billing";

// GET /api/credits/rules - 获取积分规则说明（面向用户，无需认证）
export async function GET() {
  try {
    const rules = await getBillingRules();
    return NextResponse.json(rules);
  } catch (err) {
    console.error("Credits rules GET error:", err);
    return NextResponse.json({ error: "获取积分规则失败" }, { status: 500 });
  }
}
