import { classifyWalletEntry, readWalletTotals } from "@/lib/member-wallet-history";
import { toPublicTransactionMetadata } from "@/lib/public-billing-explanation";
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
        "id, credits, credits_reserved, cash_balance"
      )
      .eq("id", payload.userId)
      .maybeSingle();

    if (userError) throw new Error("WALLET_BALANCE_UNAVAILABLE");
    if (!user) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    // 获取最近积分流水（最多20条）
    const { data: creditTransactions, error: creditsError } = await client
      .from("credit_transactions")
      .select("id, type, amount, description, balance_after, created_at, metadata")
      .eq("user_id", payload.userId)
      .order("created_at", { ascending: false })
      .limit(20);

    // 获取最近现金流水（最多20条）
    const { data: cashTransactions, error: cashError } = await client
      .from("cash_transactions")
      .select("id, type, amount, balance_after, description, reference_id, created_at")
      .eq("user_id", payload.userId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (creditsError || cashError) throw new Error("WALLET_HISTORY_UNAVAILABLE");
    const [credits,cash] = await Promise.all([
      readWalletTotals(client,payload.userId,"credit_transactions"),
      readWalletTotals(client,payload.userId,"cash_transactions"),
    ]);
    const label = (type: string) => ({refund: "退款", topup: "充值", spend: "消费", adjustment: "调整"})[classifyWalletEntry(type)];
    return NextResponse.json({
      // 积分资产
      credits: {
        balance: Math.max(0,Number(user.credits) - Number(user.credits_reserved || 0)),
        totalRecharged: credits.recharged,
        totalConsumed: credits.consumed,
      },
      // 现金资产
      cash: {
        balance: Number(user.cash_balance || 0),
        totalRecharged: cash.recharged,
        totalConsumed: cash.consumed,
      },
      // 最近流水
      recentCreditTransactions: (creditTransactions || []).map((transaction: any) => ({
        ...transaction,
        metadata: toPublicTransactionMetadata(transaction.metadata),
        description: normalizeDisplayText(transaction.description, "积分"+label(transaction.type)),
      })),
      recentCashTransactions: (cashTransactions || []).map((transaction: any) => ({
        ...transaction,
        description: normalizeDisplayText(transaction.description, "现金"+label(transaction.type)),
      })),
    }, { headers: {"Cache-Control":"private, no-store"} });
  } catch (err) {
    console.error("User assets GET error:", err);
    return NextResponse.json({ error: "查询资产失败" }, { status: 500 });
  }
}
