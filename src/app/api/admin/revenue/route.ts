/**
 * 收益统计 API
 * GET - 管理员查看收益统计（日/月/模型/账号/明细维度）
 */
import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { getRevenueStats, getUserRevenueStats, getRevenueDetails, RevenueReadError } from "@/lib/revenue";

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const period = searchParams.get("period") || "day";
  const startDate = searchParams.get("start_date") || undefined;
  const endDate = searchParams.get("end_date") || undefined;
  const modelId = searchParams.get("model_id") || undefined;
  const userId = searchParams.get("user_id") || undefined;
  const recordType = searchParams.get("record_type") || undefined;
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("page_size") || "20");

  try {
    if (period === "user") {
      return NextResponse.json(await getUserRevenueStats({ startDate, endDate, userId, page, pageSize }));
    }
    if (period === "detail") {
      return NextResponse.json(await getRevenueDetails({ startDate, endDate, userId, recordType, page, pageSize }));
    }
    return NextResponse.json(await getRevenueStats({ period: period as "day" | "month" | "model", startDate, endDate, modelId }));
  } catch (error) {
    console.error("[admin/revenue] read failed", error);
    return NextResponse.json({
      error: "收益数据暂时无法读取，请稍后重试",
      code: error instanceof RevenueReadError ? error.code : "REVENUE_DATA_UNAVAILABLE",
    }, { status: 503 });
  }
}
