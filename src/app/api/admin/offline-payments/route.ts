import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api-middleware";
import { getAccountGovernanceInfo } from "@/lib/account-governance";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CHANNELS = new Set(["wechat", "alipay", "bank_transfer", "cash", "other"]);
const STATUSES = new Set(["confirmed", "voided"]);
const PAGE_SIZE = 1000;
const MAX_SUMMARY_ROWS = 100_000;

type DatabaseRow = Record<string, any>;

function requestKey(request: Request, body: Record<string, unknown>) {
  const value = String(request.headers.get("idempotency-key") || body.idempotencyKey || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(value) ? value : null;
}

function dateBoundary(value: string | null, endExclusive = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + (endExclusive ? 86_400_000 : 0)).toISOString();
}

function rpcFailure(receipt: DatabaseRow | null, action: "record" | "void") {
  const code = typeof receipt?.code === "string" ? receipt.code : "OFFLINE_PAYMENT_FAILED";
  const messages: Record<string, string> = {
    OFFLINE_PAYMENT_REFERENCE_REQUIRED: "微信、支付宝或银行转账必须填写可核对的交易流水号",
    OFFLINE_PAYMENT_REFERENCE_EXISTS: "该支付渠道的交易流水号已经登记，不能重复入账",
    OFFLINE_PAYMENT_IDEMPOTENCY_CONFLICT: "该操作编号对应的收款内容不一致，请先核对原记录",
    OFFLINE_PAYMENT_AMOUNT_INVALID: "收款金额无效",
    OFFLINE_PAYMENT_TIME_INVALID: "付款时间无效",
    OFFLINE_PAYMENT_PAYER_MASK_INVALID: "付款方标识只能填写脱敏后的尾号、字母、星号或圆点",
    OFFLINE_PAYMENT_USER_INVALID: "学员不存在或该账号不能作为收款对象",
    OFFLINE_PAYMENT_NOT_FOUND: "线下收款凭证不存在",
    OFFLINE_PAYMENT_VOID_INPUT_INVALID: "作废原因至少填写 4 个字，并保留有效操作编号",
  };
  const status = code.endsWith("NOT_FOUND") ? 404 : code.includes("EXISTS") || code.includes("CONFLICT") ? 409 : 400;
  return NextResponse.json({ error: messages[code] || (action === "record" ? "线下收款补录未通过业务校验" : "收款凭证作废未通过业务校验"), code }, { status });
}

async function loadUsers(database: any, ids: string[]) {
  const users = new Map<string, DatabaseRow>();
  for (let index = 0; index < ids.length; index += 500) {
    const { data, error } = await database.from("users")
      .select("id,username,display_name,phone,email,member_status,role,is_active,status")
      .in("id", ids.slice(index, index + 500));
    if (error) throw error;
    for (const row of data || []) users.set(String(row.id), row);
  }
  return users;
}

export async function GET(request: Request) {
  return withAdminAuth(request, async (_admin, database) => {
    try {
      const { searchParams } = new URL(request.url);
      const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(searchParams.get("pageSize") || "30", 10) || 30));
      const userId = (searchParams.get("userId") || "").trim();
      const channel = CHANNELS.has(searchParams.get("channel") || "") ? searchParams.get("channel") || "" : "";
      const status = STATUSES.has(searchParams.get("status") || "") ? searchParams.get("status") || "" : "";
      const startAt = dateBoundary(searchParams.get("startDate"));
      const endBefore = dateBoundary(searchParams.get("endDate"), true);
      const search = (searchParams.get("search") || "").trim().slice(0, 120).replace(/[^\p{L}\p{N}\s._-]/gu, "");
      const adminDatabase = database as any;

      const applyFilters = (base: any) => {
        let query = base;
        if (userId) query = query.eq("user_id", userId);
        if (channel) query = query.eq("payment_channel", channel);
        if (status) query = query.eq("status", status);
        if (startAt) query = query.gte("paid_at", startAt);
        if (endBefore) query = query.lt("paid_at", endBefore);
        if (search) query = query.or(`merchant_reference.ilike.%${search}%,note.ilike.%${search}%`);
        return query;
      };

      const from = (page - 1) * pageSize;
      const listQuery = applyFilters(adminDatabase.from("offline_payment_receipts")
        .select("id,user_id,payment_channel,business_type,amount,currency,paid_at,merchant_reference,payer_reference_masked,note,status,activation_event_id,created_by,created_at,voided_at,voided_by,void_reason", { count: "exact" }))
        .order("paid_at", { ascending: false })
        .range(from, from + pageSize - 1);
      const { data: pageRows, error: pageError, count } = await listQuery;
      if (pageError) throw pageError;

      const summaryRows: DatabaseRow[] = [];
      for (let offset = 0; offset < MAX_SUMMARY_ROWS; offset += PAGE_SIZE) {
        const { data, error } = await applyFilters(adminDatabase.from("offline_payment_receipts")
          .select("id,user_id,status,amount,payment_channel,business_type"))
          .order("paid_at", { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw error;
        summaryRows.push(...(data || []));
        if ((data || []).length < PAGE_SIZE) break;
      }
      const allUserIds = [...new Set([...(pageRows || []), ...summaryRows].map((row: DatabaseRow) => String(row.user_id || "")).filter(Boolean))];
      const users = await loadUsers(adminDatabase, allUserIds);
      const receipts = (pageRows || []).map((row: DatabaseRow) => ({
        ...row,
        user: users.get(String(row.user_id)) || null,
      }));
      const confirmedRows = summaryRows.filter((row) => row.status === "confirmed");
      return NextResponse.json({
        receipts,
        totalCount: count || 0,
        page,
        pageSize,
        summary: {
          confirmedCount: confirmedRows.length,
          confirmedAmount: confirmedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
          voidedCount: summaryRows.filter((row) => row.status === "voided").length,
          wechatAmount: confirmedRows.filter((row) => row.payment_channel === "wechat").reduce((sum, row) => sum + Number(row.amount || 0), 0),
          truncated: summaryRows.length >= MAX_SUMMARY_ROWS,
        },
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("读取线下收款凭证失败:", error);
      return NextResponse.json({ error: "读取线下收款凭证失败" }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return withAdminAuth(request, async (admin, database) => {
    const adminDatabase = database as any;
    const body = await request.json() as Record<string, unknown>;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const paymentChannel = typeof body.paymentChannel === "string" ? body.paymentChannel.trim() : "";
    const amount = Number(body.amount);
    const paidAt = typeof body.paidAt === "string" ? body.paidAt.trim() : "";
    const merchantReference = typeof body.merchantReference === "string" ? body.merchantReference.trim() : "";
    const payerReferenceMasked = typeof body.payerReferenceMasked === "string" ? body.payerReferenceMasked.trim() : "";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const key = requestKey(request, body);
    if (!UUID_PATTERN.test(userId) || !CHANNELS.has(paymentChannel) || !Number.isFinite(amount) || amount <= 0
      || !Number.isFinite(Date.parse(paidAt)) || !key || note.length > 2000 || merchantReference.length > 160
      || payerReferenceMasked.length > 32) {
      return NextResponse.json({ error: "线下收款补录参数无效" }, { status: 400 });
    }
    const { data: target, error: targetError } = await adminDatabase.from("users")
      .select("id,username,display_name,email,phone,role,is_active,status,member_status")
      .eq("id", userId)
      .maybeSingle();
    if (targetError) return NextResponse.json({ error: "学员读取失败" }, { status: 500 });
    if (!target || target.role === "admin") return NextResponse.json({ error: "学员不存在或不能激活管理员账号" }, { status: 404 });
    const { data: priorReceipt, error: priorError } = await adminDatabase.from("offline_payment_receipts")
      .select("id")
      .eq("created_by", admin.id)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (priorError) return NextResponse.json({ error: "原操作编号核对失败，本次未重复提交" }, { status: 503 });
    if (!priorReceipt && target.member_status === "active") {
      return NextResponse.json({ error: "该学员已经是正式会员；如需补做历史账，请先由财务核对，避免重复收款与重复激活" }, { status: 409 });
    }
    if (getAccountGovernanceInfo(target).isFixture) {
      return NextResponse.json({ error: "测试/E2E/验收账号禁止写入正式线下收款账本" }, { status: 400 });
    }
    const { data, error } = await adminDatabase.rpc("record_offline_payment_and_activate_member_atomic", {
      p_admin_id: admin.id,
      p_user_id: userId,
      p_payment_channel: paymentChannel,
      p_business_type: "membership_tuition",
      p_amount: amount,
      p_paid_at: new Date(paidAt).toISOString(),
      p_merchant_reference: merchantReference,
      p_payer_reference_masked: payerReferenceMasked,
      p_note: note,
      p_idempotency_key: key,
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01"].includes(String(error.code || ""));
      console.error("线下收款原子补录失败:", { code: error.code, message: error.message });
      return NextResponse.json({
        error: missing ? "线下收款迁移尚未就绪，本次未入账" : "收款结果尚未确认，请保留原操作编号核对，禁止换编号重复提交",
        code: missing ? "OFFLINE_PAYMENT_MIGRATION_NOT_READY" : "OFFLINE_PAYMENT_OUTCOME_UNKNOWN",
      }, { status: 503 });
    }
    const receipt = data as DatabaseRow | null;
    if (receipt?.success !== true) return rpcFailure(receipt, "record");
    return NextResponse.json({ success: true, idempotencyKey: key, receipt });
  });
}

export async function PATCH(request: Request) {
  return withAdminAuth(request, async (admin, database) => {
    const body = await request.json() as Record<string, unknown>;
    const receiptId = typeof body.receiptId === "string" ? body.receiptId.trim() : "";
    const voidReason = typeof body.voidReason === "string" ? body.voidReason.trim() : "";
    const key = requestKey(request, body);
    if (!UUID_PATTERN.test(receiptId) || voidReason.length < 4 || voidReason.length > 1000 || !key) {
      return NextResponse.json({ error: "请填写至少 4 个字的作废原因" }, { status: 400 });
    }
    const { data, error } = await (database as any).rpc("void_offline_payment_receipt_atomic", {
      p_admin_id: admin.id,
      p_receipt_id: receiptId,
      p_void_reason: voidReason,
      p_idempotency_key: key,
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01"].includes(String(error.code || ""));
      return NextResponse.json({
        error: missing ? "线下收款迁移尚未就绪" : "作废结果尚未确认，请保留原操作编号核对",
        code: missing ? "OFFLINE_PAYMENT_MIGRATION_NOT_READY" : "OFFLINE_PAYMENT_VOID_OUTCOME_UNKNOWN",
      }, { status: 503 });
    }
    const receipt = data as DatabaseRow | null;
    if (receipt?.success !== true) return rpcFailure(receipt, "void");
    return NextResponse.json({ success: true, idempotencyKey: key, receipt });
  });
}
