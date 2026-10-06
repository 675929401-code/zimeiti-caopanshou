/**
 * 收益记录工具
 * 用于视频生成成功后记录收益（进货成本、售卖价、利润）
 * 所有角色遵循同一计费口径；is_admin 只用于审计身份，不代表免单。
 */
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export interface RevenueRecordInput {
  userId: string;
  userRole: "admin" | "student";
  modelId: string;
  taskId?: string;
  costPrice: number;       // 进货成本（元）
  sellingPrice: number;    // 售卖价（元）
  recordType?: "video" | "chat" | "image" | "voice" | "deep_thinking" | "extract";
  creditsCharged?: number; // 实际扣除积分数（对话类）
  cashCharged?: number;    // 实际扣除现金数（视频/封面类）
  billingExempt?: boolean; // 仅历史角色免单迁移使用；显式零价不是角色免单
}

const REVENUE_MONEY_DECIMALS = 12;
const REVENUE_PAGE_SIZE = 1_000;

export class RevenueReadError extends Error {
  readonly code = "REVENUE_DATA_UNAVAILABLE";

  constructor(message = "收益数据暂时无法读取") {
    super(message);
    this.name = "RevenueReadError";
  }
}

type RevenueReadOptions = {
  startDate?: string;
  endDate?: string;
  userId?: string;
  modelId?: string;
  recordType?: string;
};

async function readAllBillableRevenueRows(
  columns: string,
  options: RevenueReadOptions,
): Promise<Record<string, unknown>[]> {
  const db = getSupabaseAdminClient();
  const rows: Record<string, unknown>[] = [];

  for (let offset = 0; ; offset += REVENUE_PAGE_SIZE) {
    let query = db
      .from("revenue_records")
      .select(columns)
      .eq("billing_exempt", false)
      .order("created_at", { ascending: true })
      .range(offset, offset + REVENUE_PAGE_SIZE - 1);
    if (options.startDate) query = query.gte("created_at", options.startDate);
    if (options.endDate) query = query.lte("created_at", `${options.endDate} 23:59:59`);
    if (options.userId) query = query.eq("user_id", options.userId);
    if (options.modelId) query = query.eq("model_id", options.modelId);
    if (options.recordType) query = query.eq("record_type", options.recordType);

    const { data, error } = await query;
    if (error || !data) {
      throw new RevenueReadError(error?.message || "收益数据读取失败");
    }
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < REVENUE_PAGE_SIZE) return rows;
  }
}

/**
 * 成本价和售卖价都由调用方以人民币元传入。利润与这两个快照保持同一
 * 币种和精度；不从积分数或实际扣款字段反推，避免单位混用。
 */
export function calculateRevenueProfitYuan(sellingPrice: number, costPrice: number): number {
  const profit = Number((sellingPrice - costPrice).toFixed(REVENUE_MONEY_DECIMALS));
  return Object.is(profit, -0) ? 0 : profit;
}

/**
 * 记录收益。管理员使用标记 is_admin = true，但只要产生了真实扣款就纳入统计。
 */
export async function recordRevenue(input: RevenueRecordInput): Promise<void> {
  const db = getSupabaseAdminClient();

  const payload = {
    user_id: input.userId,
    model_id: input.modelId,
    task_id: input.taskId,
    cost_price: input.costPrice,
    selling_price: input.sellingPrice,
    profit: calculateRevenueProfitYuan(input.sellingPrice, input.costPrice),
    is_admin: input.userRole === "admin",
    record_type: input.recordType || "video",
    credits_charged: input.creditsCharged ?? 0,
    cash_charged: input.cashCharged ?? 0,
    billing_exempt: input.billingExempt === true,
  };
  const { error } = await db.from("revenue_records").insert(payload);
  if (!error) return;

  // Commerce tasks use a database-enforced unique task key. If a process
  // crashed after the insert but before its local receipt was saved, the same
  // task may reach this point again. Treat the unique conflict as fulfilled
  // only after verifying that the stored financial snapshot is identical.
  if (input.taskId && error.code === "23505") {
    const { data: existing, error: readError } = await db
      .from("revenue_records")
      .select("user_id, model_id, task_id, cost_price, selling_price, profit, is_admin, billing_exempt, record_type, credits_charged, cash_charged")
      .eq("user_id", input.userId)
      .eq("task_id", input.taskId)
      .eq("record_type", payload.record_type)
      .limit(1)
      .maybeSingle();
    if (!readError && existing) {
      const same =
        existing.user_id === payload.user_id &&
        existing.model_id === payload.model_id &&
        existing.task_id === payload.task_id &&
        Number(existing.cost_price) === Number(payload.cost_price) &&
        Number(existing.selling_price) === Number(payload.selling_price) &&
        Number(existing.profit) === Number(payload.profit) &&
        Boolean(existing.is_admin) === Boolean(payload.is_admin) &&
        Boolean(existing.billing_exempt) === Boolean(payload.billing_exempt) &&
        existing.record_type === payload.record_type &&
        Number(existing.credits_charged || 0) === Number(payload.credits_charged) &&
        Number(existing.cash_charged || 0) === Number(payload.cash_charged);
      if (same) return;
      throw new Error(`收益幂等键 ${input.taskId} 已被不同账务快照占用`);
    }
    throw new Error(`收益记录冲突后无法核对原记录：${readError?.message || "记录不存在"}`);
  }
  throw new Error(`收益记录写入失败：${error.message}`);
}

/**
 * 获取收益统计。历史管理员免扣记录不计入；今后管理员真实扣款正常计入。
 * @param period "day" | "month" | "total"
 * @param startDate 开始日期 (YYYY-MM-DD)
 * @param endDate 结束日期 (YYYY-MM-DD)
 */
export async function getRevenueStats(options: {
  period: "day" | "month" | "model";
  startDate?: string;
  endDate?: string;
  modelId?: string;
}) {
  const data = await readAllBillableRevenueRows(
    "cost_price, selling_price, created_at, model_id, is_admin, billing_exempt, record_type, credits_charged, cash_charged",
    options,
  );

  // 按维度分组
  const summary = {
    totalRevenue: 0,
    totalCost: 0,
    totalProfit: 0,
    count: data.length,
  };

  for (const r of data) {
    const selling = Number(r.selling_price) || 0;
    const cost = Number(r.cost_price) || 0;
    summary.totalRevenue += selling;
    summary.totalCost += cost;
    summary.totalProfit += selling - cost;
  }

  // 按时间分组
  const grouped: Record<string, { revenue: number; cost: number; profit: number; count: number }> = {};

  for (const r of data) {
    const date = new Date(r.created_at as string);
    let key: string;

    if (options.period === "day") {
      key = date.toISOString().slice(0, 10); // YYYY-MM-DD
    } else if (options.period === "month") {
      key = date.toISOString().slice(0, 7); // YYYY-MM
    } else {
      key = r.model_id as string;
    }

    if (!grouped[key]) {
      grouped[key] = { revenue: 0, cost: 0, profit: 0, count: 0 };
    }

    const selling = Number(r.selling_price) || 0;
    const cost = Number(r.cost_price) || 0;
    grouped[key].revenue += selling;
    grouped[key].cost += cost;
    grouped[key].profit += selling - cost;
    grouped[key].count += 1;
  }

  // 转换为数组
  const records = Object.entries(grouped)
    .map(([key, val]) => ({
      period: key,
      revenue: Math.round(val.revenue * 100) / 100,
      cost: Math.round(val.cost * 100) / 100,
      profit: Math.round(val.profit * 100) / 100,
      count: val.count,
    }))
    .sort((a, b) => b.period.localeCompare(a.period));

  return {
    records,
    summary: {
      totalRevenue: Math.round(summary.totalRevenue * 100) / 100,
      totalCost: Math.round(summary.totalCost * 100) / 100,
      totalProfit: Math.round(summary.totalProfit * 100) / 100,
      count: summary.count,
    },
  };
}

/**
 * 获取账号维度收益统计（管理员真实扣款同样纳入）
 * 每个学员的充值/消费/利润汇总
 */
export async function getUserRevenueStats(options: {
  startDate?: string;
  endDate?: string;
  userId?: string;
  page?: number;
  pageSize?: number;
}) {
  const db = getSupabaseAdminClient();
  const page = options.page || 1;
  const pageSize = options.pageSize || 20;
  const offset = (page - 1) * pageSize;

  const revenueData = await readAllBillableRevenueRows(
    "user_id, cost_price, selling_price, record_type, created_at, is_admin, billing_exempt, credits_charged, cash_charged",
    options,
  );

  // 按用户分组
  const userMap: Record<string, { revenue: number; cost: number; profit: number; count: number; types: Record<string, number> }> = {};
  for (const r of revenueData) {
    const uid = r.user_id as string;
    if (!userMap[uid]) {
      userMap[uid] = { revenue: 0, cost: 0, profit: 0, count: 0, types: {} };
    }
    const selling = Number(r.selling_price) || 0;
    const cost = Number(r.cost_price) || 0;
    userMap[uid].revenue += selling;
    userMap[uid].cost += cost;
    userMap[uid].profit += selling - cost;
    userMap[uid].count += 1;
    const rt = (r.record_type as string) || "unknown";
    userMap[uid].types[rt] = (userMap[uid].types[rt] || 0) + 1;
  }

  // 批量查询用户信息
  const userIds = Object.keys(userMap);
  let userInfoMap: Record<string, { name: string; phone: string; email: string }> = {};
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await db
      .from("users")
      .select("id, display_name, phone, email")
      .in("id", userIds);
    if (usersError) throw new RevenueReadError(usersError.message);
    if (users) {
      for (const u of users) {
        const u2 = u as Record<string, unknown>;
        userInfoMap[u2.id as string] = { name: (u2.display_name as string) || "", phone: (u2.phone as string) || "", email: (u2.email as string) || "" };
      }
    }
  }

  // 排序（按收益降序）并分页
  const sortedUsers = Object.entries(userMap)
    .map(([uid, val]) => ({
      userId: uid,
      name: userInfoMap[uid]?.name || "未知",
      phone: userInfoMap[uid]?.phone || "",
      email: userInfoMap[uid]?.email || "",
      revenue: Math.round(val.revenue * 100) / 100,
      cost: Math.round(val.cost * 100) / 100,
      profit: Math.round(val.profit * 100) / 100,
      count: val.count,
      types: val.types,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const pagedUsers = sortedUsers.slice(offset, offset + pageSize);

  return {
    users: pagedUsers,
    totalCount: sortedUsers.length,
  };
}

/**
 * 获取收益明细流水（管理员真实扣款同样纳入）
 * 每条记录含用户/模型/类型/金额/时间
 */
export async function getRevenueDetails(options: {
  startDate?: string;
  endDate?: string;
  userId?: string;
  recordType?: string;
  page?: number;
  pageSize?: number;
}) {
  const db = getSupabaseAdminClient();
  const page = options.page || 1;
  const pageSize = options.pageSize || 20;
  const offset = (page - 1) * pageSize;

  let query = db
    .from("revenue_records")
    .select("id, user_id, model_id, cost_price, selling_price, profit, is_admin, billing_exempt, record_type, task_id, created_at, credits_charged, cash_charged", { count: "exact" })
    .eq("billing_exempt", false)
    .order("created_at", { ascending: false });

  if (options.startDate) query = query.gte("created_at", options.startDate);
  if (options.endDate) query = query.lte("created_at", `${options.endDate} 23:59:59`);
  if (options.userId) query = query.eq("user_id", options.userId);
  if (options.recordType) query = query.eq("record_type", options.recordType);

  query = query.range(offset, offset + pageSize - 1);

  const { data, count, error } = await query;
  if (error || !data) throw new RevenueReadError(error?.message || "收益明细读取失败");

  // 批量查用户名
  const userIds = [...new Set(data.map((r: Record<string, unknown>) => r.user_id as string))];
  let userInfoMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await db.from("users").select("id, display_name").in("id", userIds);
    if (usersError) throw new RevenueReadError(usersError.message);
    if (users) {
      for (const u of users) userInfoMap[u.id] = (u as Record<string, unknown>).display_name as string || "";
    }
  }

  const records = data.map((r: Record<string, unknown>) => ({
    id: r.id,
    userId: r.user_id,
    userName: userInfoMap[(r.user_id as string)] || "未知",
    modelId: r.model_id,
    costPrice: Number(r.cost_price) || 0,
    sellingPrice: Number(r.selling_price) || 0,
    profit: Number(r.profit) || 0,
    isAdmin: Boolean(r.is_admin),
    billingExempt: Boolean(r.billing_exempt),
    recordType: r.record_type,
    taskId: r.task_id,
    createdAt: r.created_at,
    creditsCharged: Number(r.credits_charged) || 0,
    cashCharged: Number(r.cash_charged) || 0,
  }));

  return { records, totalCount: count || 0 };
}
