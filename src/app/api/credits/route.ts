import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { normalizeDisplayText } from "@/lib/display-normalization";
import { recoverLlmCreditReservations } from "@/lib/llm-credit-reservation";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

export async function GET(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return NextResponse.json({ error: "Login expired" }, { status: 401 });
  }

  const userId = request.nextUrl.searchParams.get("user_id");
  if (!userId) {
    return NextResponse.json({ error: "Missing user_id" }, { status: 400 });
  }
  const includeTransactions = request.nextUrl.searchParams.get("include_transactions") !== "0";

  if (payload.userId !== userId) {
    const memberAccess = await authorizeAdminCapability(request, "members.view", {
      operation: "member_balance_view",
    });
    if (!memberAccess.ok) return memberAccess.response;
    const billingAccess = await authorizeAdminCapability(request, "billing.view", {
      operation: "member_transactions_view",
    });
    if (!billingAccess.ok) return billingAccess.response;
  }

  try {
    const client = getSupabaseClient();
    if (payload.userId === userId) {
      await recoverLlmCreditReservations(userId);
    }
    const [{ data: user, error: userError }, transactionResult] = await Promise.all([
      client
        .from("users")
        .select("credits, credits_reserved, cash_balance, member_status")
        .eq("id", userId)
        .single(),
      includeTransactions
        ? client
          .from("credit_transactions")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(100)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const { data: transactions, error: transactionError } = transactionResult;

    if (userError || !user) {
      return NextResponse.json({ error: "Realtime balance unavailable" }, { status: 503 });
    }
    if (transactionError) {
      return NextResponse.json({ error: "Realtime transactions unavailable" }, { status: 503 });
    }

    return NextResponse.json({
      credits: Math.max(0, Number(user.credits ?? 0) - Number(user.credits_reserved ?? 0)),
      reservedCredits: Number(user.credits_reserved ?? 0),
      cashBalance: Number(user.cash_balance ?? 0),
      memberStatus: user.member_status || "inactive",
      transactions: (transactions || []).map((transaction: any) => ({
        ...transaction,
        description: normalizeDisplayText(transaction.description, transaction.type === "recharge" ? "积分充值" : "积分消耗"),
      })),
    });
  } catch (error) {
    console.error("Credits GET error:", error);
    return NextResponse.json({ error: "Realtime balance unavailable" }, { status: 503 });
  }
}
