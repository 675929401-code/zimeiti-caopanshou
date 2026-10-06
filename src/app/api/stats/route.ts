// User usage statistics API
// GET /api/stats — returns usage summary for the authenticated user
// GET /api/stats?admin=true — returns platform-wide stats (admin only)

import { getSupabaseClient } from "@/storage/database/supabase-client";
import { verifyToken } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonValue = any;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }

    const token = authHeader.slice(7);
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: "登录已过期" }, { status: 401 });
    }

    const client = getSupabaseClient();
    const isAdminRequest = request.nextUrl.searchParams.get("admin") === "true";

    if (isAdminRequest) {
      for (const [permission, operation] of [
        ["billing.view", "platform_statistics_billing_read"],
        ["members.view", "platform_statistics_members_read"],
      ] as const) {
        const authorization = await authorizeAdminCapability(request, permission, {
          operation,
          requireStepUp: false,
        });
        if (!authorization.ok) return authorization.response;
      }
    }

    if (isAdminRequest) {
      // ---- Admin platform-wide stats ----
      
      // Total users
      const { count: totalUsers } = await client
        .from("users")
        .select("*", { count: "exact", head: true })
        .eq("role", "student");

      // Active users (used credits in last 7 days)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: activeUsersData } = await client
        .from("credit_transactions")
        .select("user_id")
        .eq("type", "consume")
        .gte("created_at", sevenDaysAgo);
      const activeUsers = new Set(activeUsersData?.map((t: { user_id: string }) => t.user_id) || []).size;

      // Total credits consumed
      const { data: consumptionData } = await client
        .from("credit_transactions")
        .select("amount, user_id, metadata, created_at")
        .eq("type", "consume");

      const totalCreditsConsumed = Math.abs(
        consumptionData?.reduce((sum: number, t: { amount: number }) => sum + t.amount, 0) || 0
      );

      // Revenue estimate: credits consumed / credits_per_yuan
      const { data: settingsData } = await client
        .from("platform_settings")
        .select("setting_key, setting_value");
      const settings: Record<string, string> = {};
      settingsData?.forEach((s: { setting_key: string; setting_value: string }) => {
        settings[s.setting_key] = s.setting_value;
      });
      const creditsPerYuan = parseFloat(settings.credits_per_yuan || "50");
      const totalRevenue = totalCreditsConsumed / creditsPerYuan;

      // Cost estimate from metadata
      let totalCostRmb = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCachedTokens = 0;
      
      consumptionData?.forEach((t: { amount: number; metadata: Record<string, unknown> }) => {
        const meta = t.metadata || {};
        if (meta.actual_cost_rmb) totalCostRmb += Number(meta.actual_cost_rmb);
        if (meta.prompt_tokens) totalInputTokens += Number(meta.prompt_tokens);
        if (meta.completion_tokens) totalOutputTokens += Number(meta.completion_tokens);
        if (meta.cached_tokens) totalCachedTokens += Number(meta.cached_tokens);
      });

      const totalProfit = totalRevenue - totalCostRmb;

      // Daily consumption for last 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: dailyData } = await client
        .from("credit_transactions")
        .select("amount, created_at, metadata")
        .eq("type", "consume")
        .gte("created_at", thirtyDaysAgo);

      const dailyStats: Record<string, { credits: number; cost_rmb: number; messages: number }> = {};
      dailyData?.forEach((t: { amount: number; created_at: string; metadata: Record<string, unknown> }) => {
        const day = t.created_at.slice(0, 10);
        if (!dailyStats[day]) dailyStats[day] = { credits: 0, cost_rmb: 0, messages: 0 };
        dailyStats[day].credits += Math.abs(t.amount);
        dailyStats[day].cost_rmb += Number(t.metadata?.actual_cost_rmb || 0);
        dailyStats[day].messages += 1;
      });

      // Agent usage ranking
      const agentUsage: Record<string, { count: number; credits: number }> = {};
      consumptionData?.forEach((t: { amount: number; metadata: Record<string, unknown> }) => {
        const agentName = String(t.metadata?.agent_name || "历史记录（未标注智能体）");
        if (!agentUsage[agentName]) agentUsage[agentName] = { count: 0, credits: 0 };
        agentUsage[agentName].count += 1;
        agentUsage[agentName].credits += Math.abs(t.amount);
      });

      // Top users by consumption
      const userConsumption: Record<string, { credits: number; messages: number }> = {};
      consumptionData?.forEach((t: { amount: number; user_id: string; metadata: JsonValue; created_at: string }) => {
        if (!userConsumption[t.user_id]) userConsumption[t.user_id] = { credits: 0, messages: 0 };
        userConsumption[t.user_id].credits += Math.abs(t.amount);
        userConsumption[t.user_id].messages += 1;
      });

      // Get user details for top consumers
      const topUserIds = Object.entries(userConsumption)
        .sort(([, a], [, b]) => b.credits - a.credits)
        .slice(0, 10)
        .map(([id]) => id);

      const { data: topUsersData } = await client
        .from("users")
        .select("id, username, display_name, credits")
        .in("id", topUserIds);

      const topUsers = topUsersData?.map((u: { id: string; username: string; display_name: string; credits: number }) => ({
        ...u,
        consumed: userConsumption[u.id]?.credits || 0,
        messages: userConsumption[u.id]?.messages || 0,
      }));

      return NextResponse.json({
        overview: {
          totalUsers: totalUsers || 0,
          activeUsers7d: activeUsers,
          totalCreditsConsumed,
          totalRevenueRmb: Math.round(totalRevenue * 100) / 100,
          totalCostRmb: Math.round(totalCostRmb * 100) / 100,
          totalProfitRmb: Math.round(totalProfit * 100) / 100,
          profitMargin: totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 100) : 0,
          totalInputTokens,
          totalOutputTokens,
          totalCachedTokens,
        },
        dailyStats,
        agentRanking: Object.entries(agentUsage)
          .sort(([, a], [, b]) => b.credits - a.credits)
          .map(([name, data]) => ({ name, messages: data.count, credits: data.credits })),
        topUsers,
      });
    } else {
      // ---- Individual user stats ----
      const userId = payload.userId;

      // Get consumption summary
      const { data: transactions } = await client
        .from("credit_transactions")
        .select("amount, description, metadata, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(100);

      const consumeTransactions = transactions || [];
      
      let totalConsumed = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      
      consumeTransactions.forEach((t: { amount: number; metadata: JsonValue }) => {
        if (t.amount < 0) {
          totalConsumed += Math.abs(t.amount);
          totalInputTokens += Number(t.metadata?.prompt_tokens || 0);
          totalOutputTokens += Number(t.metadata?.completion_tokens || 0);
        }
      });

      // Current credits
      const { data: user } = await client
        .from("users")
        .select("credits")
        .eq("id", userId)
        .single();

      // Agent usage breakdown
      const agentBreakdown: Record<string, { credits: number; messages: number }> = {};
      consumeTransactions.forEach((t: { amount: number; metadata: Record<string, unknown> }) => {
        if (t.amount < 0) {
          const agentName = String(t.metadata?.agent_name || "历史记录（未标注智能体）");
          if (!agentBreakdown[agentName]) agentBreakdown[agentName] = { credits: 0, messages: 0 };
          agentBreakdown[agentName].credits += Math.abs(t.amount);
          agentBreakdown[agentName].messages += 1;
        }
      });

      return NextResponse.json({
        remaining: user?.credits || 0,
        totalConsumed,
        totalInputTokens,
        totalOutputTokens,
        agentBreakdown: Object.entries(agentBreakdown)
          .sort(([, a], [, b]) => b.credits - a.credits)
          .map(([name, data]) => ({ name, ...data })),
        recentTransactions: consumeTransactions.slice(0, 20),
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
