import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { normalizeDisplayText } from "@/lib/display-normalization";

// GET /api/user/assets — 用户资产概览（充值/消耗/余额全览）
export async function GET(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;
    const payload = authorization.user;

    const client = getSupabaseClient();

    // 查询用户资产概览（余额 + 累计充值/消耗）
    const { data: user, error: userError } = await client
      .from("users")
      .select(
        "id, credits, cash_balance, total_credits_recharged, total_credits_consumed, total_cash_recharged, total_cash_consumed"
      )
      .eq("id", payload.userId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    // 获取最近积分流水（最多20条）
    const { data: creditTransactions } = await client
      .from("credit_transactions")
      .select("id, type, amount, description, balance_after, created_at, metadata")
      .eq("user_id", payload.userId)
      .order("created_at", { ascending: false })
      .limit(20);

    // 获取最近现金流水（最多20条）
    const { data: cashTransactions } = await client
      .from("cash_transactions")
      .select("id, type, amount, balance_after, description, reference_id, created_at")
      .eq("user_id", payload.userId)
      .order("created_at", { ascending: false })
      .limit(20);

    return NextResponse.json({
      // 积分资产
      credits: {
        balance: Number(user.credits),
        totalRecharged: Number(user.total_credits_recharged || 0),
        totalConsumed: Number(user.total_credits_consumed || 0),
      },
      // 现金资产
      cash: {
        balance: Number(user.cash_balance || 0),
        totalRecharged: Number(user.total_cash_recharged || 0),
        totalConsumed: Number(user.total_cash_consumed || 0),
      },
      // 最近流水
      recentCreditTransactions: (creditTransactions || []).map((transaction: any) => ({
        ...transaction,
        description: normalizeDisplayText(transaction.description, transaction.type === "recharge" ? "积分充值" : "积分消耗"),
      })),
      recentCashTransactions: (cashTransactions || []).map((transaction: any) => ({
        ...transaction,
        description: normalizeDisplayText(transaction.description, transaction.type === "topup" ? "现金充值" : "现金消耗"),
      })),
    });
  } catch (err) {
    console.error("User assets GET error:", err);
    return NextResponse.json({ error: "查询资产失败" }, { status: 500 });
  }
}
