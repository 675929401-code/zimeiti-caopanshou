import { NextRequest, NextResponse } from "next/server";
import {
  availableRechargeSource,
  buildRechargeReadModel,
  clampRechargeTimelineLimit,
  notRequestedRechargeSource,
  rechargeSourceErrorCode,
  unavailableRechargeSource,
  type RechargeDatabaseRow,
  type RechargeLegacyRow,
  type RechargeReconciliationModel,
  type RechargeSourceId,
  type RechargeSourceResult,
} from "@/lib/server/admin-recharge-read-model";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;
const FULL_MAX_ROWS_PER_SOURCE = 100_000;
const SUMMARY_MAX_ROWS_PER_SOURCE = 500;
const SUMMARY_CACHE_TTL_MS = 60_000;
const SUMMARY_CACHE_MAX_ENTRIES = 256;
const PAYMENT_COLUMNS = "id,user_id,trade_order_id,type,amount,credits_amount,status,payment_method,payment_provider,provider_trade_order_id,provider_transaction_id,provider_paid_amount,provider_confirmed_at,paid_at,refund_attempt_id,provider_refund_id,provider_refund_amount,provider_refund_status,refunded_at,created_at";
const WALLET_COLUMNS = "id,user_id,wallet,operation_kind,idempotency_key,amount,delta,status,balance_before,balance_after,description,metadata,legacy_transaction_id,created_at,completed_at";
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Authorization, Cookie",
};

type PageResult = { data: RechargeDatabaseRow[] | null; error: unknown };
type RechargeResponseBase = Pick<RechargeReconciliationModel, "summary" | "timeline" | "dataQuality" | "sourceStates" | "asOf" | "window">;
type SummaryCacheStatus = "miss" | "hit" | "shared";
type SummaryCacheEntry = { payload: RechargeResponseBase; expiresAtMs: number };
type SummaryInflightEntry = { promise: Promise<RechargeResponseBase>; nextAllowedAtMs: number };

const summaryCache = new Map<string, SummaryCacheEntry>();
const summaryInflight = new Map<string, SummaryInflightEntry>();

function noStore(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(key, value);
  return response;
}

function dateBoundary(value: string | null, endExclusive = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + (endExclusive ? 24 * 60 * 60 * 1000 : 0)).toISOString();
}

async function readSource(
  id: RechargeSourceId,
  asOf: string,
  fetchPage: (from: number, to: number) => PromiseLike<PageResult>,
  maxRows = FULL_MAX_ROWS_PER_SOURCE,
): Promise<RechargeSourceResult> {
  const rows: RechargeDatabaseRow[] = [];
  try {
    for (let from = 0; from < maxRows; from += PAGE_SIZE) {
      const batchSize = Math.min(PAGE_SIZE, maxRows - from);
      const { data, error } = await fetchPage(from, from + batchSize - 1);
      if (error) return unavailableRechargeSource(id, rechargeSourceErrorCode(error));
      const page = (data || []).slice(0, batchSize);
      rows.push(...page);
      if (page.length < batchSize) return availableRechargeSource(id, rows, { asOf });
    }
    return availableRechargeSource(id, rows, {
      asOf,
      truncated: true,
      partial: true,
      errorCode: "SOURCE_ROW_LIMIT_REACHED",
    });
  } catch (error) {
    return unavailableRechargeSource(id, rechargeSourceErrorCode(error));
  }
}

function rowsOf(source: RechargeSourceResult): RechargeDatabaseRow[] {
  return Array.isArray(source.rows) ? source.rows : [];
}

function readable(source: RechargeSourceResult): boolean {
  return source.state === "available" || source.state === "partial";
}

function makePartial(source: RechargeSourceResult, error: unknown): RechargeSourceResult {
  if (!source.rows) return unavailableRechargeSource(source.id, rechargeSourceErrorCode(error));
  return availableRechargeSource(source.id, source.rows, {
    asOf: source.asOf || new Date().toISOString(),
    truncated: source.truncated,
    partial: true,
    errorCode: rechargeSourceErrorCode(error),
  });
}

function makeTruncated(source: RechargeSourceResult): RechargeSourceResult {
  if (!source.rows) return source;
  return availableRechargeSource(source.id, source.rows, {
    asOf: source.asOf || new Date().toISOString(),
    truncated: true,
    partial: true,
    errorCode: "SOURCE_ROW_LIMIT_REACHED",
  });
}

function responseBase(model: RechargeReconciliationModel): RechargeResponseBase {
  return {
    summary: model.summary,
    timeline: model.timeline,
    dataQuality: model.dataQuality,
    sourceStates: model.sourceStates,
    asOf: model.asOf,
    window: model.window,
  };
}

function pruneSummaryCache(nowMs: number) {
  for (const [key, entry] of summaryCache) {
    if (entry.expiresAtMs <= nowMs) summaryCache.delete(key);
  }
  while (summaryCache.size > SUMMARY_CACHE_MAX_ENTRIES) {
    const oldest = summaryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    summaryCache.delete(oldest);
  }
}

function summaryNextAllowedAt(payload: RechargeResponseBase): number {
  const asOfMs = Date.parse(payload.asOf);
  return (Number.isFinite(asOfMs) ? asOfMs : Date.now()) + SUMMARY_CACHE_TTL_MS;
}

function summaryMetadata(payload: RechargeResponseBase, cacheStatus: SummaryCacheStatus, nowMs = Date.now()) {
  const asOfMs = Date.parse(payload.asOf);
  const observedAtMs = Number.isFinite(asOfMs) ? asOfMs : nowMs;
  const nextAllowedAtMs = observedAtMs + SUMMARY_CACHE_TTL_MS;
  const retryAfterSeconds = Math.max(0, Math.ceil((nextAllowedAtMs - nowMs) / 1_000));
  return {
    ...payload,
    freshness: {
      state: nowMs <= nextAllowedAtMs ? "fresh" as const : "stale" as const,
      ageMs: Math.max(0, nowMs - observedAtMs),
      maxAgeMs: SUMMARY_CACHE_TTL_MS,
      basis: "process_cache_age" as const,
    },
    nextRefreshAt: new Date(nextAllowedAtMs).toISOString(),
    cacheStatus,
    rateLimit: {
      scope: "process-local-admin-filter" as const,
      limit: 1,
      intervalMs: SUMMARY_CACHE_TTL_MS,
      remaining: retryAfterSeconds > 0 ? 0 as const : 1 as const,
      retryAfterSeconds,
      nextAllowedAt: new Date(nextAllowedAtMs).toISOString(),
    },
    readBudget: {
      mode: "summary" as const,
      maxRowsPerSource: SUMMARY_MAX_ROWS_PER_SOURCE,
      exhaustive: payload.dataQuality.status === "complete" && payload.dataQuality.truncatedSources === 0,
    },
  };
}

function summaryRateLimited(nextAllowedAtMs: number, payload: RechargeResponseBase | null, reason: "cooldown" | "single_flight") {
  const nowMs = Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil((nextAllowedAtMs - nowMs) / 1_000));
  const asOf = payload?.asOf || new Date(nowMs).toISOString();
  const asOfMs = Date.parse(asOf);
  return NextResponse.json({
    error: reason === "single_flight" ? "同一筛选的充值时间线正在读取，请稍后重试" : "充值时间线刷新过于频繁，请在冷却结束后重试",
    code: reason === "single_flight" ? "RECHARGE_TIMELINE_SINGLE_FLIGHT" : "RECHARGE_TIMELINE_REFRESH_RATE_LIMITED",
    asOf,
    freshness: {
      state: "fresh",
      ageMs: Number.isFinite(asOfMs) ? Math.max(0, nowMs - asOfMs) : 0,
      maxAgeMs: SUMMARY_CACHE_TTL_MS,
      basis: "process_cache_age",
    },
    nextRefreshAt: new Date(nextAllowedAtMs).toISOString(),
    cacheStatus: "rate_limited",
    rateLimit: {
      scope: "process-local-admin-filter",
      limit: 1,
      intervalMs: SUMMARY_CACHE_TTL_MS,
      remaining: 0,
      retryAfterSeconds,
      nextAllowedAt: new Date(nextAllowedAtMs).toISOString(),
    },
    readBudget: {
      mode: "summary",
      maxRowsPerSource: SUMMARY_MAX_ROWS_PER_SOURCE,
      exhaustive: payload ? payload.dataQuality.status === "complete" && payload.dataQuality.truncatedSources === 0 : null,
    },
  }, {
    status: 429,
    headers: { ...NO_STORE_HEADERS, "Retry-After": String(retryAfterSeconds) },
  });
}

function summaryKey(input: {
  actorId: string;
  userId: string;
  category: string;
  startAt: string | null;
  endBefore: string | null;
  timelineLimit: number;
}) {
  return JSON.stringify(input);
}

function csvCell(value: unknown) {
  let valueText = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@]/.test(valueText)) valueText = `'${valueText}`;
  return `"${valueText.replace(/"/g, '""')}"`;
}

function beijingText(value: unknown) {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date)
    : String(value);
}

async function readSupplementalRows(
  sourceId: RechargeSourceId,
  values: string[],
  fetchBatch: (values: string[]) => PromiseLike<PageResult>,
  maxRows = FULL_MAX_ROWS_PER_SOURCE,
): Promise<{ rows: RechargeDatabaseRow[]; error: unknown | null; truncated: boolean }> {
  const rows: RechargeDatabaseRow[] = [];
  const boundedValues = values.slice(0, Math.max(0, maxRows));
  const truncated = boundedValues.length < values.length;
  try {
    for (let index = 0; index < boundedValues.length; index += 500) {
      const batchSize = Math.min(500, boundedValues.length - index, maxRows - rows.length);
      if (batchSize <= 0) break;
      const { data, error } = await fetchBatch(boundedValues.slice(index, index + batchSize));
      if (error) return { rows, error, truncated };
      rows.push(...(data || []).slice(0, batchSize));
    }
    return { rows, error: null, truncated };
  } catch (error) {
    return { rows, error: error || new Error(`${sourceId}:supplemental-read-failed`), truncated };
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = (searchParams.get("userId") || "").trim();
  const category = searchParams.get("category") === "credits" || searchParams.get("category") === "cash"
    ? searchParams.get("category") as "credits" | "cash"
    : "";
  const startAt = dateBoundary(searchParams.get("startDate") || searchParams.get("start_date"));
  const endBefore = dateBoundary(searchParams.get("endDate") || searchParams.get("end_date"), true);
  const format = searchParams.get("format") === "csv" ? "csv" : "json";
  const summaryOnly = format === "json" && searchParams.get("summaryOnly") === "1";
  const bypassCache = summaryOnly && searchParams.get("refresh") === "1";
  const timelineLimit = clampRechargeTimelineLimit(Number.parseInt(searchParams.get("timelineLimit") || "", 10));
  const authorization = await authorizeAdminCapability(request, format === "csv" ? "billing.export" : "billing.view", {
    requireStepUp: format === "csv",
    operation: format === "csv" ? "member_recharge_timeline_export" : "member_recharge_timeline_read",
  });
  if (!authorization.ok) return noStore(authorization.response);

  try {
    const readModel = async (maxRowsPerSource: number): Promise<RechargeReconciliationModel> => {
      const asOf = new Date().toISOString();
      const db = getSupabaseAdminClient();

      const [walletInitial, ordersInitial, creditInitial, cashInitial, refundInitial, offlineInitial, activationInitial, packageInitial] = await Promise.all([
      readSource("wallet_operations", asOf, (from, to) => {
        let query = db.from("wallet_operations").select(WALLET_COLUMNS)
          .in("operation_kind", category === "credits" ? ["credit_topup"] : category === "cash" ? ["cash_topup"] : ["credit_topup", "cash_topup"])
          .order("created_at", { ascending: false });
        if (userId) query = query.eq("user_id", userId);
        if (startAt) query = query.gte("created_at", startAt);
        if (endBefore) query = query.lt("created_at", endBefore);
        return query.range(from, to) as unknown as PromiseLike<PageResult>;
      }, maxRowsPerSource),
      readSource("payment_orders", asOf, (from, to) => {
        let query = db.from("payment_orders").select(PAYMENT_COLUMNS).order("created_at", { ascending: false });
        if (userId) query = query.eq("user_id", userId);
        if (category) query = query.eq("type", category);
        if (startAt) query = query.gte("created_at", startAt);
        if (endBefore) query = query.lt("created_at", endBefore);
        return query.range(from, to) as unknown as PromiseLike<PageResult>;
      }, maxRowsPerSource),
      category === "cash" ? Promise.resolve(notRequestedRechargeSource("credit_transactions")) : readSource("credit_transactions", asOf, (from, to) => {
        let query = db.from("credit_transactions")
          .select("id,user_id,amount,type,transaction_type,balance_after,description,metadata,created_at")
          .or("type.in.(recharge,topup),transaction_type.in.(recharge,topup)")
          .order("created_at", { ascending: false });
        if (userId) query = query.eq("user_id", userId);
        if (startAt) query = query.gte("created_at", startAt);
        if (endBefore) query = query.lt("created_at", endBefore);
        return query.range(from, to) as unknown as PromiseLike<PageResult>;
      }, maxRowsPerSource),
      category === "credits" ? Promise.resolve(notRequestedRechargeSource("cash_transactions")) : readSource("cash_transactions", asOf, (from, to) => {
        let query = db.from("cash_transactions")
          .select("id,user_id,amount,type,balance_after,description,reference_id,metadata,created_at")
          .in("type", ["topup", "recharge"])
          .order("created_at", { ascending: false });
        if (userId) query = query.eq("user_id", userId);
        if (startAt) query = query.gte("created_at", startAt);
        if (endBefore) query = query.lt("created_at", endBefore);
        return query.range(from, to) as unknown as PromiseLike<PageResult>;
      }, maxRowsPerSource),
      readSource("payment_refund_attempts", asOf, (from, to) => {
        let query = db.from("payment_refund_attempts")
          .select("attempt_id,trade_order_id,user_id,state,order_type,payment_provider,paid_amount,wallet_amount,reason,provider_refund_id,provider_refund_amount,provider_status,created_at,updated_at,completed_at,released_at")
          .order("updated_at", { ascending: false });
        if (userId) query = query.eq("user_id", userId);
        if (category) query = query.eq("order_type", category);
        if (startAt) query = query.gte("updated_at", startAt);
        if (endBefore) query = query.lt("updated_at", endBefore);
        return query.range(from, to) as unknown as PromiseLike<PageResult>;
      }, maxRowsPerSource),
      category ? Promise.resolve(notRequestedRechargeSource("offline_payment_receipts")) : readSource("offline_payment_receipts", asOf, (from, to) => {
        let query = db.from("offline_payment_receipts")
          .select("id,user_id,payment_channel,business_type,amount,currency,paid_at,merchant_reference,payer_reference_masked,note,status,activation_event_id,created_by,created_at,voided_at,voided_by,void_reason")
          .order("paid_at", { ascending: false });
        if (userId) query = query.eq("user_id", userId);
        if (startAt) query = query.gte("paid_at", startAt);
        if (endBefore) query = query.lt("paid_at", endBefore);
        return query.range(from, to) as unknown as PromiseLike<PageResult>;
      }, maxRowsPerSource),
      category ? Promise.resolve(notRequestedRechargeSource("member_activation_events")) : readSource("member_activation_events", asOf, (from, to) => {
        let query = db.from("member_activation_events")
          .select("id,user_id,member_status,activation_method,activation_reference,activation_fee,activation_note,idempotency_key,created_at")
          .order("created_at", { ascending: false });
        if (userId) query = query.eq("user_id", userId);
        if (startAt) query = query.gte("created_at", startAt);
        if (endBefore) query = query.lt("created_at", endBefore);
        return query.range(from, to) as unknown as PromiseLike<PageResult>;
      }, maxRowsPerSource),
      category ? Promise.resolve(notRequestedRechargeSource("member_package_assignments")) : readSource("member_package_assignments", asOf, (from, to) => {
        let query = db.from("member_package_assignments")
          .select("id,user_id,invitation_record_id,profile_key,profile_version,package_name,membership_status,duration_days,member_expires_at,credits,cash_amount,note,assigned_by,request_key,credit_operation_id,cash_operation_id,created_at")
          .order("created_at", { ascending: false });
        if (userId) query = query.eq("user_id", userId);
        if (startAt) query = query.gte("created_at", startAt);
        if (endBefore) query = query.lt("created_at", endBefore);
        return query.range(from, to) as unknown as PromiseLike<PageResult>;
      }, maxRowsPerSource),
    ]);

    let walletSource = walletInitial;
    let orderSource = ordersInitial;
    const walletTradeIds = new Set(rowsOf(walletSource).map((row) => {
      const key = String(row.idempotency_key || "");
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as RechargeDatabaseRow : {};
      return key.startsWith("payment:") ? key.slice("payment:".length) : String(metadata.trade_order_id || "");
    }).filter(Boolean));
    const primaryTradeIds = new Set(rowsOf(orderSource).map((row) => String(row.trade_order_id || "")).filter(Boolean));
    const supplementalOrderBudget = Math.max(0, maxRowsPerSource - rowsOf(orderSource).length);
    const supplementalOrderRead = readable(orderSource) && readable(walletSource)
      ? await readSupplementalRows("payment_orders", [...walletTradeIds].filter((id) => !primaryTradeIds.has(id)), (tradeIds) => db.from("payment_orders").select(PAYMENT_COLUMNS).in("trade_order_id", tradeIds) as unknown as PromiseLike<PageResult>, supplementalOrderBudget)
      : { rows: [], error: null, truncated: false };
    if (supplementalOrderRead.error) orderSource = makePartial(orderSource, supplementalOrderRead.error);
    if (supplementalOrderRead.truncated) orderSource = makeTruncated(orderSource);

    const paidOrderKeys = rowsOf(orderSource)
      .filter((row) => ["paid", "refunded"].includes(String(row.status || "").toLowerCase()))
      .map((row) => String(row.trade_order_id || ""))
      .filter(Boolean)
      .filter((tradeOrderId) => !walletTradeIds.has(tradeOrderId))
      .map((tradeOrderId) => `payment:${tradeOrderId}`);
    const supplementalWalletBudget = Math.max(0, maxRowsPerSource - rowsOf(walletSource).length);
    const supplementalWalletRead = readable(orderSource) && readable(walletSource)
      ? await readSupplementalRows("wallet_operations", paidOrderKeys, (keys) => db.from("wallet_operations").select(WALLET_COLUMNS).in("idempotency_key", keys) as unknown as PromiseLike<PageResult>, supplementalWalletBudget)
      : { rows: [], error: null, truncated: false };
    if (supplementalWalletRead.error) walletSource = makePartial(walletSource, supplementalWalletRead.error);
    if (supplementalWalletRead.truncated) walletSource = makeTruncated(walletSource);

    const sourcesWithoutUsers = [walletSource, orderSource, creditInitial, cashInitial, refundInitial, offlineInitial, activationInitial, packageInitial];
    const userIds = [...new Set([
      ...sourcesWithoutUsers.flatMap((source) => rowsOf(source)),
      ...supplementalOrderRead.rows,
      ...supplementalWalletRead.rows,
    ].map((row) => String(row.user_id || "")).filter(Boolean))];
    const usersRead = userIds.length === 0
      ? { rows: [], error: null, truncated: false }
      : await readSupplementalRows("users", userIds, (ids) => db.from("users").select("id,username,display_name,phone,email,member_status").in("id", ids) as unknown as PromiseLike<PageResult>, maxRowsPerSource);
    const usersSource = usersRead.error
      ? unavailableRechargeSource("users", rechargeSourceErrorCode(usersRead.error))
      : availableRechargeSource("users", usersRead.rows, {
        asOf,
        truncated: usersRead.truncated,
        partial: usersRead.truncated,
        errorCode: usersRead.truncated ? "SOURCE_ROW_LIMIT_REACHED" : null,
      });

      return buildRechargeReadModel({
      sources: {
        payment_orders: orderSource,
        wallet_operations: walletSource,
        credit_transactions: creditInitial,
        cash_transactions: cashInitial,
        payment_refund_attempts: refundInitial,
        offline_payment_receipts: offlineInitial,
        member_activation_events: activationInitial,
        member_package_assignments: packageInitial,
        users: usersSource,
      },
      supplementalOrders: supplementalOrderRead.rows,
      supplementalWalletOperations: supplementalWalletRead.rows,
      asOf,
      window: { startAt, endBefore, timezone: "Asia/Shanghai" },
      timelineLimit,
      });
    };

    if (summaryOnly) {
      const cacheKey = summaryKey({
        actorId: authorization.actor.userId,
        userId,
        category,
        startAt,
        endBefore,
        timelineLimit,
      });
      const nowMs = Date.now();
      pruneSummaryCache(nowMs);
      const cached = summaryCache.get(cacheKey) || null;
      const activeRead = summaryInflight.get(cacheKey) || null;
      if (bypassCache && cached) return summaryRateLimited(cached.expiresAtMs, cached.payload, "cooldown");
      if (bypassCache && activeRead) return summaryRateLimited(activeRead.nextAllowedAtMs, null, "single_flight");
      if (cached) {
        return NextResponse.json(summaryMetadata(cached.payload, "hit", nowMs), {
          headers: {
            ...NO_STORE_HEADERS,
            "X-RateLimit-Limit": "1",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": new Date(cached.expiresAtMs).toISOString(),
          },
        });
      }

      let cacheStatus: SummaryCacheStatus = "shared";
      let summaryPromise = activeRead?.promise;
      if (!summaryPromise) {
        cacheStatus = "miss";
        const startedAtMs = Date.now();
        summaryPromise = readModel(SUMMARY_MAX_ROWS_PER_SOURCE)
          .then(responseBase)
          .then((payload) => {
            const expiresAtMs = summaryNextAllowedAt(payload);
            summaryCache.set(cacheKey, { payload, expiresAtMs });
            pruneSummaryCache(Date.now());
            return payload;
          })
          .finally(() => summaryInflight.delete(cacheKey));
        summaryInflight.set(cacheKey, {
          promise: summaryPromise,
          nextAllowedAtMs: startedAtMs + SUMMARY_CACHE_TTL_MS,
        });
      }
      const payload = await summaryPromise;
      const metadata = summaryMetadata(payload, cacheStatus);
      return NextResponse.json(metadata, {
        headers: {
          ...NO_STORE_HEADERS,
          "X-RateLimit-Limit": "1",
          "X-RateLimit-Remaining": String(metadata.rateLimit.remaining),
          "X-RateLimit-Reset": metadata.nextRefreshAt,
        },
      });
    }

    const model = await readModel(FULL_MAX_ROWS_PER_SOURCE);

    if (format === "json") {
      const base = responseBase(model);
      const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
      const pageSize = Math.min(200, Math.max(1, Number.parseInt(searchParams.get("pageSize") || "50", 10) || 50));
      const start = (page - 1) * pageSize;
      return NextResponse.json({ rows: model.rows.slice(start, start + pageSize), totalCount: model.rows.length, page, pageSize, ...base }, { headers: NO_STORE_HEADERS });
    }

    const columns: Array<[keyof RechargeLegacyRow, string, boolean?]> = [
      ["accountingScope", "记录层级"], ["includedInCreditedTotal", "纳入到账合计"], ["userId", "学员ID"], ["userName", "学员姓名"],
      ["phone", "手机号"], ["email", "邮箱"], ["memberStatus", "会员状态"], ["wallet", "钱包类型"], ["businessType", "业务类型"],
      ["accountingStatus", "账务状态"], ["deltaCredits", "入账积分"], ["deltaCash", "入账现金元"], ["balanceBefore", "入账前余额"], ["balanceAfter", "入账后余额"],
      ["orderAmount", "支付订单金额元"], ["orderStatus", "支付订单状态"], ["paymentMethod", "支付方式"], ["paymentProvider", "支付渠道"], ["tradeOrderId", "商户订单号"],
      ["providerTradeOrderId", "渠道商户单号"], ["providerTransactionId", "渠道交易号"],
      ["walletOperationId", "钱包操作ID"], ["idempotencyKey", "幂等键"], ["legacyTransactionId", "历史流水ID"], ["offlineReceiptId", "线下收款凭证ID"], ["offlineReference", "线下交易流水号"],
      ["payerReferenceMasked", "付款方脱敏标识"], ["activationEventId", "会员激活事件ID"], ["description", "说明"], ["createdAt", "创建时间(北京时间)", true], ["completedAt", "入账完成时间(北京时间)", true],
      ["paidAt", "支付完成时间(北京时间)", true], ["providerConfirmedAt", "渠道确认时间(北京时间)", true], ["voidedAt", "作废时间(北京时间)", true], ["voidReason", "作废原因"], ["metadata", "审计元数据"],
      ["identityState", "账号资料状态"], ["normalizedPaymentMethod", "支付方式标准值"], ["normalizedPaymentProvider", "支付渠道标准值"], ["providerConfirmationState", "渠道确认状态"],
    ];
    const csv = [
      columns.map(([, label]) => csvCell(label)).join(","),
      ...model.rows.map((row) => columns.map(([key, , isDate]) => csvCell(isDate ? beijingText(row[key]) : row[key])).join(",")),
    ].join("\r\n");
    const scope = userId ? `member-${userId.slice(0, 8)}` : "all-members";
    const fileDateParts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) => fileDateParts.find((item) => item.type === type)?.value || "00";
    const fileDate = `${part("year")}-${part("month")}-${part("day")}`;
    return new NextResponse(`\uFEFF${csv}`, {
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`会员充值对账-${scope}-${fileDate}.csv`)}`,
        "X-Reconciliation-Rows": String(model.rows.length),
        "X-Reconciliation-Truncated": String(model.summary.truncated),
        "X-Reconciliation-Data-Quality": model.dataQuality.status,
      },
    });
  } catch (error) {
    console.error("会员充值对账导出失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "会员充值对账导出失败" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
