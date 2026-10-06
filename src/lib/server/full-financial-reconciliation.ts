import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  FINANCIAL_RECONCILIATION_CURSOR_TTL_MS,
  FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS,
  FINANCIAL_RECONCILIATION_SCHEMA_VERSION,
  FINANCIAL_RECONCILIATION_STAGES,
  addFinancialIssueSummaries,
  clampFinancialReconciliationPageSize,
  emptyFinancialIssueSummary,
  evaluateLargeBalanceDelta,
  evaluateNegativeBalance,
  evaluatePaymentOrder,
  evaluateRefundAttempt,
  newFinancialStageProgress,
  paymentWalletIdentity,
  refundWalletOperationIds,
  summarizeFinancialIssues,
  type FinancialIssue,
  type FinancialIssueSummary,
  type FinancialReconciliationCoverage,
  type FinancialReconciliationResponse,
  type FinancialRow,
  type FinancialSourceGap,
  type FinancialStageProgress,
} from "@/lib/financial-reconciliation-contract";
import { requireServerSecret } from "@/lib/server-secrets";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

interface FinancialReconciliationCursorState {
  schemaVersion: typeof FINANCIAL_RECONCILIATION_SCHEMA_VERSION;
  scanId: string;
  actorHash: string;
  snapshotAt: string;
  expiresAt: string;
  stageIndex: number;
  afterKey: string | null;
  pageSize: number;
  stages: FinancialStageProgress[];
  summary: FinancialIssueSummary;
}

interface StagePageResult {
  scanned: number;
  total: number | null;
  lastKey: string | null;
  hasMore: boolean;
  issues: FinancialIssue[];
  gaps: FinancialSourceGap[];
  unavailable: boolean;
}

interface QueryResult<T = FinancialRow> {
  data: T[] | null;
  error: unknown;
  count?: number | null;
}

interface RateState {
  inFlight: boolean;
  lastStartedAtMs: number;
  lastSeenAtMs: number;
}

type FinancialReadResult =
  | { allowed: true; value: FinancialReconciliationResponse }
  | {
      allowed: false;
      reason: "minimum_interval" | "single_flight";
      retryAfterMs: number;
      nextAllowedAtMs: number;
    };

const PAYMENT_FULL_COLUMNS = [
  "id", "user_id", "trade_order_id", "type", "amount", "credits_amount", "status",
  "payment_provider", "paid_at", "created_at", "provider_trade_order_id",
  "provider_transaction_id", "provider_paid_amount", "provider_confirmed_at",
  "refund_attempt_id", "provider_refund_id", "provider_refund_amount",
  "provider_refund_status", "refunded_at",
].join(",");

const PAYMENT_BASE_COLUMNS = [
  "id", "user_id", "trade_order_id", "type", "amount", "credits_amount", "status",
  "payment_provider", "paid_at", "created_at",
].join(",");

const REFUND_COLUMNS = [
  "attempt_id", "trade_order_id", "user_id", "state", "order_type", "paid_amount",
  "wallet_amount", "wallet_operation_id", "release_operation_id", "lease_until",
  "provider_refund_id", "provider_refund_amount", "provider_status", "created_at",
  "updated_at", "completed_at", "released_at",
].join(",");

const rateStates = new Map<string, RateState>();

export class FinancialReconciliationCursorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FinancialReconciliationCursorError";
    this.code = code;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function cursorSecret(): string {
  return process.env.FINANCIAL_RECONCILIATION_CURSOR_SECRET?.trim()
    || requireServerSecret("JWT_SECRET");
}

function hmac(value: string): Buffer {
  return createHmac("sha256", cursorSecret()).update(value).digest();
}

function actorHash(actorId: string): string {
  return createHmac("sha256", cursorSecret()).update(`financial-reconciliation:${actorId}`).digest("base64url");
}

function encodeCursor(state: FinancialReconciliationCursorState): string {
  const body = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${body}.${hmac(body).toString("base64url")}`;
}

function parseIso(value: unknown): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function decodeCursor(cursor: string, actorId: string, nowMs: number): FinancialReconciliationCursorState {
  if (!cursor || cursor.length > 96_000) {
    throw new FinancialReconciliationCursorError("CURSOR_INVALID", "扫描检查点无效，请重新开始");
  }
  const [body, signature, ...rest] = cursor.split(".");
  if (!body || !signature || rest.length > 0) {
    throw new FinancialReconciliationCursorError("CURSOR_INVALID", "扫描检查点格式无效，请重新开始");
  }
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(signature, "base64url");
  } catch {
    throw new FinancialReconciliationCursorError("CURSOR_INVALID", "扫描检查点签名无效，请重新开始");
  }
  const expectedSignature = hmac(body);
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
    throw new FinancialReconciliationCursorError("CURSOR_TAMPERED", "扫描检查点校验失败，请重新开始");
  }
  let state: FinancialReconciliationCursorState;
  try {
    state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FinancialReconciliationCursorState;
  } catch {
    throw new FinancialReconciliationCursorError("CURSOR_INVALID", "扫描检查点内容无效，请重新开始");
  }
  const stageShapeValid = Array.isArray(state.stages)
    && state.stages.length === FINANCIAL_RECONCILIATION_STAGES.length
    && state.stages.every((stage, index) => stage?.id === FINANCIAL_RECONCILIATION_STAGES[index]?.id);
  if (state.schemaVersion !== FINANCIAL_RECONCILIATION_SCHEMA_VERSION
    || state.actorHash !== actorHash(actorId)
    || !state.scanId
    || !Number.isInteger(state.stageIndex)
    || state.stageIndex < 0
    || state.stageIndex > FINANCIAL_RECONCILIATION_STAGES.length
    || !stageShapeValid
    || !Number.isFinite(parseIso(state.snapshotAt))
    || !Number.isFinite(parseIso(state.expiresAt))) {
    throw new FinancialReconciliationCursorError("CURSOR_INVALID", "扫描检查点结构无效，请重新开始");
  }
  if (parseIso(state.expiresAt) <= nowMs) {
    throw new FinancialReconciliationCursorError("CURSOR_EXPIRED", "扫描检查点已过期，请重新开始");
  }
  return state;
}

function createCursorState(actorId: string, pageSize: number, nowMs: number): FinancialReconciliationCursorState {
  const snapshotAt = new Date(nowMs).toISOString();
  return {
    schemaVersion: FINANCIAL_RECONCILIATION_SCHEMA_VERSION,
    scanId: randomUUID(),
    actorHash: actorHash(actorId),
    snapshotAt,
    expiresAt: new Date(nowMs + FINANCIAL_RECONCILIATION_CURSOR_TTL_MS).toISOString(),
    stageIndex: 0,
    afterKey: null,
    pageSize: clampFinancialReconciliationPageSize(pageSize),
    stages: FINANCIAL_RECONCILIATION_STAGES.map(newFinancialStageProgress),
    summary: emptyFinancialIssueSummary(),
  };
}

function boundedSignal(requestSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(8_000);
  if (!requestSignal || typeof AbortSignal.any !== "function") return timeout;
  return AbortSignal.any([requestSignal, timeout]);
}

function errorCode(error: unknown): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = text(record.code);
  const message = `${text(record.message)} ${text(record.details)} ${text(record.hint)}`;
  if (code === "42P01" || code === "PGRST205" || /schema cache|relation .* does not exist|could not find the table/iu.test(message)) {
    return "SOURCE_TABLE_UNAVAILABLE";
  }
  if (code === "42703" || /column .* does not exist|could not find .* column/iu.test(message)) {
    return "SOURCE_SCHEMA_UNAVAILABLE";
  }
  if (/abort|timeout/iu.test(message)) return "SOURCE_READ_TIMEOUT";
  return code ? `SOURCE_READ_FAILED:${code}` : "SOURCE_READ_FAILED";
}

function optionalPaymentColumnsUnavailable(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = `${text(record.message)} ${text(record.details)} ${text(record.hint)}`;
  return /provider_(?:trade_order_id|transaction_id|paid_amount|confirmed_at|refund_id|refund_amount|refund_status)|refund_attempt_id|refunded_at/iu.test(message)
    && errorCode(error) === "SOURCE_SCHEMA_UNAVAILABLE";
}

function gap(stageId: FinancialStageProgress["id"], source: string, code: string, detail: string): FinancialSourceGap {
  return { stageId, source, code, detail };
}

function uniqueGaps(gaps: readonly FinancialSourceGap[]): FinancialSourceGap[] {
  const seen = new Set<string>();
  return gaps.filter((item) => {
    const key = `${item.stageId}:${item.source}:${item.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rowsOf(result: QueryResult): FinancialRow[] {
  return Array.isArray(result.data) ? result.data : [];
}

async function countRows(
  table: string,
  primaryKey: string,
  snapshotAt: string,
  signal: AbortSignal,
  statuses?: readonly string[],
): Promise<{ count: number | null; error: unknown }> {
  let query = getSupabaseAdminClient()
    .from(table)
    .select(primaryKey, { count: "exact", head: true })
    .lte("created_at", snapshotAt);
  if (statuses?.length) query = query.in("status", [...statuses]);
  const result = await query.abortSignal(signal) as QueryResult;
  return { count: typeof result.count === "number" ? result.count : null, error: result.error };
}

async function readNegativeBalancesPage(
  state: FinancialReconciliationCursorState,
  requestSignal?: AbortSignal,
): Promise<StagePageResult> {
  const signal = boundedSignal(requestSignal);
  let query = getSupabaseAdminClient()
    .from("users")
    .select("id,username,display_name,credits,cash_balance,created_at")
    .lte("created_at", state.snapshotAt)
    .order("id", { ascending: true })
    .limit(state.pageSize + 1);
  if (state.afterKey) query = query.gt("id", state.afterKey);
  const countPromise = state.stages[state.stageIndex]?.total == null
    ? countRows("users", "id", state.snapshotAt, signal)
    : Promise.resolve({ count: state.stages[state.stageIndex]?.total ?? null, error: null });
  const [pageResult, countResult] = await Promise.all([
    query.abortSignal(signal) as PromiseLike<QueryResult>,
    countPromise,
  ]);
  if (pageResult.error) {
    const code = errorCode(pageResult.error);
    return {
      scanned: 0, total: countResult.count, lastKey: null, hasMore: false, issues: [], unavailable: true,
      gaps: [gap("negative_balances", "users", code, "会员余额来源读取失败，本阶段不能判定通过。")],
    };
  }
  const allRows = rowsOf(pageResult);
  const hasMore = allRows.length > state.pageSize;
  const rows = allRows.slice(0, state.pageSize);
  const issues = rows.flatMap(evaluateNegativeBalance);
  const gaps = countResult.error
    ? [gap("negative_balances", "users", errorCode(countResult.error), "会员总数暂不可得；逐页扫描仍继续，结束前不判定完整覆盖。")]
    : [];
  return {
    scanned: rows.length,
    total: countResult.count,
    lastKey: rows.length ? text(rows.at(-1)?.id) : state.afterKey,
    hasMore,
    issues,
    gaps,
    unavailable: false,
  };
}

async function readPaymentIntegrityPage(
  state: FinancialReconciliationCursorState,
  requestSignal?: AbortSignal,
): Promise<StagePageResult> {
  const signal = boundedSignal(requestSignal);
  const pageQuery = (columns: string) => {
    let query = getSupabaseAdminClient()
      .from("payment_orders")
      .select(columns)
      .lte("created_at", state.snapshotAt)
      .in("status", ["paid", "refunded"])
      .order("id", { ascending: true })
      .limit(state.pageSize + 1);
    if (state.afterKey) query = query.gt("id", state.afterKey);
    return query.abortSignal(signal) as PromiseLike<QueryResult>;
  };
  const countPromise = state.stages[state.stageIndex]?.total == null
    ? countRows("payment_orders", "id", state.snapshotAt, signal, ["paid", "refunded"])
    : Promise.resolve({ count: state.stages[state.stageIndex]?.total ?? null, error: null });
  const initialResults = await Promise.all([pageQuery(PAYMENT_FULL_COLUMNS), countPromise]);
  let pageResult = initialResults[0];
  const countResult = initialResults[1];
  let providerEvidenceAvailable = true;
  const gaps: FinancialSourceGap[] = [];
  if (pageResult.error && optionalPaymentColumnsUnavailable(pageResult.error)) {
    providerEvidenceAvailable = false;
    gaps.push(gap(
      "payment_integrity",
      "payment_orders.provider_evidence",
      "SOURCE_SCHEMA_UNAVAILABLE",
      "渠道确认或退款回执字段未就绪；钱包到账仍扫描，但本阶段不能判定完整。",
    ));
    pageResult = await pageQuery(PAYMENT_BASE_COLUMNS);
  }
  if (pageResult.error) {
    const code = errorCode(pageResult.error);
    return {
      scanned: 0, total: countResult.count, lastKey: null, hasMore: false, issues: [], unavailable: true,
      gaps: [...gaps, gap("payment_integrity", "payment_orders", code, "支付订单来源读取失败，本阶段不能判定通过。")],
    };
  }
  if (countResult.error) {
    gaps.push(gap("payment_integrity", "payment_orders", errorCode(countResult.error), "支付订单总数暂不可得；结束前不判定完整覆盖。"));
  }
  const allRows = rowsOf(pageResult);
  const hasMore = allRows.length > state.pageSize;
  const rows = allRows.slice(0, state.pageSize);
  const keys = [...new Set(rows.map((row) => paymentWalletIdentity(row).idempotencyKey).filter(Boolean))];
  let walletEvidenceAvailable = true;
  const walletOperationsByKey = new Map<string, FinancialRow>();
  if (keys.length) {
    const walletResult = await getSupabaseAdminClient()
      .from("wallet_operations")
      .select("id,user_id,operation_kind,idempotency_key,status,amount,balance_before,balance_after,completed_at")
      .in("idempotency_key", keys)
      .abortSignal(signal) as QueryResult;
    if (walletResult.error) {
      walletEvidenceAvailable = false;
      gaps.push(gap("payment_integrity", "wallet_operations", errorCode(walletResult.error), "统一钱包记录读取失败；相关订单不被误报为未到账，但本阶段保持部分覆盖。"));
    } else {
      for (const operation of rowsOf(walletResult)) {
        const key = text(operation.idempotency_key);
        if (key) walletOperationsByKey.set(key, operation);
      }
    }
  }
  const issues = rows.flatMap((row) => evaluatePaymentOrder(row, walletOperationsByKey, {
    providerEvidenceAvailable,
    walletEvidenceAvailable,
  }));
  return {
    scanned: rows.length,
    total: countResult.count,
    lastKey: rows.length ? text(rows.at(-1)?.id) : state.afterKey,
    hasMore,
    issues,
    gaps: uniqueGaps(gaps),
    unavailable: false,
  };
}

async function readRefundFinalityPage(
  state: FinancialReconciliationCursorState,
  requestSignal?: AbortSignal,
): Promise<StagePageResult> {
  const signal = boundedSignal(requestSignal);
  let query = getSupabaseAdminClient()
    .from("payment_refund_attempts")
    .select(REFUND_COLUMNS)
    .lte("created_at", state.snapshotAt)
    .order("attempt_id", { ascending: true })
    .limit(state.pageSize + 1);
  if (state.afterKey) query = query.gt("attempt_id", state.afterKey);
  const countPromise = state.stages[state.stageIndex]?.total == null
    ? countRows("payment_refund_attempts", "attempt_id", state.snapshotAt, signal)
    : Promise.resolve({ count: state.stages[state.stageIndex]?.total ?? null, error: null });
  const [pageResult, countResult] = await Promise.all([
    query.abortSignal(signal) as PromiseLike<QueryResult>,
    countPromise,
  ]);
  if (pageResult.error) {
    const code = errorCode(pageResult.error);
    return {
      scanned: 0, total: countResult.count, lastKey: null, hasMore: false, issues: [], unavailable: true,
      gaps: [gap("refund_finality", "payment_refund_attempts", code, "退款状态来源读取失败，本阶段不能判定通过。")],
    };
  }
  const gaps: FinancialSourceGap[] = countResult.error
    ? [gap("refund_finality", "payment_refund_attempts", errorCode(countResult.error), "退款总数暂不可得；结束前不判定完整覆盖。")]
    : [];
  const allRows = rowsOf(pageResult);
  const hasMore = allRows.length > state.pageSize;
  const rows = allRows.slice(0, state.pageSize);
  const tradeOrderIds = [...new Set(rows.map((row) => text(row.trade_order_id)).filter(Boolean))];
  const walletOperationIds = [...new Set(rows.flatMap(refundWalletOperationIds))];
  const [ordersResult, walletResult] = await Promise.all([
    tradeOrderIds.length
      ? getSupabaseAdminClient()
        .from("payment_orders")
        .select("id,trade_order_id,status,amount,refund_attempt_id,provider_refund_id,provider_refund_amount,provider_refund_status,refunded_at")
        .in("trade_order_id", tradeOrderIds)
        .abortSignal(signal) as PromiseLike<QueryResult>
      : Promise.resolve({ data: [], error: null } as QueryResult),
    walletOperationIds.length
      ? getSupabaseAdminClient()
        .from("wallet_operations")
        .select("id,operation_kind,status,amount,balance_before,balance_after,completed_at")
        .in("id", walletOperationIds)
        .abortSignal(signal) as PromiseLike<QueryResult>
      : Promise.resolve({ data: [], error: null } as QueryResult),
  ]);
  const orderEvidenceAvailable = !ordersResult.error;
  const walletEvidenceAvailable = !walletResult.error;
  if (ordersResult.error) {
    gaps.push(gap("refund_finality", "payment_orders", errorCode(ordersResult.error), "退款对应订单读取失败；本批不推断订单终态。"));
  }
  if (walletResult.error) {
    gaps.push(gap("refund_finality", "wallet_operations", errorCode(walletResult.error), "退款钱包冻结/释放记录读取失败；本批不推断钱包终态。"));
  }
  const ordersByTradeOrderId = new Map<string, FinancialRow>();
  for (const order of rowsOf(ordersResult)) {
    const key = text(order.trade_order_id);
    if (key) ordersByTradeOrderId.set(key, order);
  }
  const walletOperationsById = new Map<string, FinancialRow>();
  for (const operation of rowsOf(walletResult)) {
    const key = text(operation.id);
    if (key) walletOperationsById.set(key, operation);
  }
  const issues = rows.flatMap((row) => evaluateRefundAttempt(row, ordersByTradeOrderId, walletOperationsById, {
    orderEvidenceAvailable,
    walletEvidenceAvailable,
    snapshotAt: state.snapshotAt,
  }));
  return {
    scanned: rows.length,
    total: countResult.count,
    lastKey: rows.length ? text(rows.at(-1)?.attempt_id) : state.afterKey,
    hasMore,
    issues,
    gaps: uniqueGaps(gaps),
    unavailable: false,
  };
}

async function readLargeBalanceMovementsPage(
  state: FinancialReconciliationCursorState,
  requestSignal?: AbortSignal,
): Promise<StagePageResult> {
  const signal = boundedSignal(requestSignal);
  let query = getSupabaseAdminClient()
    .from("balance_audit_log")
    .select("id,user_id,field,delta,source,source_id,created_at")
    .lte("created_at", state.snapshotAt)
    .order("id", { ascending: true })
    .limit(state.pageSize + 1);
  if (state.afterKey) query = query.gt("id", state.afterKey);
  const countPromise = state.stages[state.stageIndex]?.total == null
    ? countRows("balance_audit_log", "id", state.snapshotAt, signal)
    : Promise.resolve({ count: state.stages[state.stageIndex]?.total ?? null, error: null });
  const [pageResult, countResult] = await Promise.all([
    query.abortSignal(signal) as PromiseLike<QueryResult>,
    countPromise,
  ]);
  if (pageResult.error) {
    const code = errorCode(pageResult.error);
    return {
      scanned: 0, total: countResult.count, lastKey: null, hasMore: false, issues: [], unavailable: true,
      gaps: [gap("large_balance_movements", "balance_audit_log", code, "余额审计日志读取失败，本阶段不能判定通过。")],
    };
  }
  const allRows = rowsOf(pageResult);
  const hasMore = allRows.length > state.pageSize;
  const rows = allRows.slice(0, state.pageSize);
  return {
    scanned: rows.length,
    total: countResult.count,
    lastKey: rows.length ? text(rows.at(-1)?.id) : state.afterKey,
    hasMore,
    issues: rows.flatMap(evaluateLargeBalanceDelta),
    gaps: countResult.error
      ? [gap("large_balance_movements", "balance_audit_log", errorCode(countResult.error), "余额审计日志总数暂不可得；结束前不判定完整覆盖。")]
      : [],
    unavailable: false,
  };
}

async function readStagePage(
  state: FinancialReconciliationCursorState,
  requestSignal?: AbortSignal,
): Promise<StagePageResult> {
  const stageId = FINANCIAL_RECONCILIATION_STAGES[state.stageIndex]?.id;
  if (stageId === "negative_balances") return readNegativeBalancesPage(state, requestSignal);
  if (stageId === "payment_integrity") return readPaymentIntegrityPage(state, requestSignal);
  if (stageId === "refund_finality") return readRefundFinalityPage(state, requestSignal);
  if (stageId === "large_balance_movements") return readLargeBalanceMovementsPage(state, requestSignal);
  throw new FinancialReconciliationCursorError("CURSOR_COMPLETE", "扫描已经完成，请重新开始新的快照");
}

function buildCoverage(state: FinancialReconciliationCursorState): FinancialReconciliationCoverage {
  const terminal = state.stageIndex >= FINANCIAL_RECONCILIATION_STAGES.length;
  const complete = terminal && state.stages.every((stage) => stage.status === "complete");
  const totalsKnown = state.stages.every((stage) => typeof stage.total === "number");
  return {
    status: terminal ? (complete ? "complete" : "partial") : "scanning",
    complete,
    scanned: state.stages.reduce((sum, stage) => sum + stage.scanned, 0),
    total: totalsKnown ? state.stages.reduce((sum, stage) => sum + (stage.total || 0), 0) : null,
    stages: state.stages,
    sourceGaps: uniqueGaps(state.stages.flatMap((stage) => stage.gaps)),
  };
}

async function readFinancialReconciliationPage(input: {
  actorId: string;
  cursor: string | null;
  pageSize: number;
  requestSignal?: AbortSignal;
  nowMs?: number;
}): Promise<FinancialReconciliationResponse> {
  const nowMs = input.nowMs ?? Date.now();
  const state = input.cursor
    ? decodeCursor(input.cursor, input.actorId, nowMs)
    : createCursorState(input.actorId, input.pageSize, nowMs);
  const stageDefinition = FINANCIAL_RECONCILIATION_STAGES[state.stageIndex];
  if (!stageDefinition) {
    throw new FinancialReconciliationCursorError("CURSOR_COMPLETE", "扫描已经完成，请重新开始新的快照");
  }
  const page = await readStagePage(state, input.requestSignal);
  const progress = state.stages[state.stageIndex];
  if (!progress) throw new FinancialReconciliationCursorError("CURSOR_INVALID", "扫描阶段不存在，请重新开始");
  const pageSummary = summarizeFinancialIssues(page.issues);
  progress.scanned += page.scanned;
  progress.total = page.total ?? progress.total;
  progress.issues = addFinancialIssueSummaries(progress.issues, pageSummary);
  progress.gaps = uniqueGaps([...progress.gaps, ...page.gaps]);
  state.summary = addFinancialIssueSummaries(state.summary, pageSummary);

  if (page.unavailable) {
    progress.status = "unavailable";
    state.stageIndex += 1;
    state.afterKey = null;
  } else if (page.hasMore) {
    progress.status = "running";
    state.afterKey = page.lastKey;
  } else {
    if (progress.total == null) progress.total = progress.scanned;
    if (progress.total !== progress.scanned) {
      progress.gaps = uniqueGaps([...progress.gaps, gap(
        progress.id,
        progress.sources.join("+"),
        "SNAPSHOT_POPULATION_CHANGED",
        `阶段计数为 ${progress.total}，实际扫描 ${progress.scanned}；扫描期间可能发生删除，结果保持部分覆盖。`,
      )]);
    }
    progress.status = progress.gaps.length ? "partial" : "complete";
    state.stageIndex += 1;
    state.afterKey = null;
  }

  const coverage = buildCoverage(state);
  const nextCursor = state.stageIndex < FINANCIAL_RECONCILIATION_STAGES.length
    ? encodeCursor(state)
    : null;
  return {
    ok: true,
    schemaVersion: FINANCIAL_RECONCILIATION_SCHEMA_VERSION,
    scanId: state.scanId,
    snapshotAt: state.snapshotAt,
    checkedAt: new Date(nowMs).toISOString(),
    currentStage: {
      id: stageDefinition.id,
      label: stageDefinition.label,
      pageScanned: page.scanned,
      pageIssues: page.issues.length,
    },
    coverage,
    summary: state.summary,
    issues: page.issues,
    nextCursor,
    checkpoint: {
      resumable: nextCursor != null,
      expiresAt: state.expiresAt,
      snapshotAt: state.snapshotAt,
      populationBoundary: "created_at_lte_snapshot",
      rowState: "read_time_current",
    },
    rateLimit: {
      scope: "process-local-admin",
      minimumIntervalMs: FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS,
      retryAfterSeconds: Math.ceil(FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS / 1_000),
    },
    readPolicy: {
      readOnly: true,
      databaseWrites: 0,
      providerCalls: 0,
      pageSize: state.pageSize,
    },
  };
}

function pruneRateStates(nowMs: number): void {
  if (rateStates.size < 500) return;
  for (const [key, value] of rateStates) {
    if (!value.inFlight && nowMs - value.lastSeenAtMs > 30 * 60 * 1_000) rateStates.delete(key);
  }
}

export async function readFullFinancialReconciliationForAdmin(input: {
  actorId: string;
  cursor: string | null;
  pageSize: number;
  requestSignal?: AbortSignal;
  nowMs?: number;
}): Promise<FinancialReadResult> {
  const nowMs = input.nowMs ?? Date.now();
  pruneRateStates(nowMs);
  const current = rateStates.get(input.actorId);
  if (current?.inFlight) {
    return {
      allowed: false,
      reason: "single_flight",
      retryAfterMs: FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS,
      nextAllowedAtMs: Math.max(nowMs + FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS, current.lastStartedAtMs + FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS),
    };
  }
  const elapsed = current ? nowMs - current.lastStartedAtMs : Number.POSITIVE_INFINITY;
  if (elapsed < FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS) {
    const retryAfterMs = FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS - elapsed;
    if (current) current.lastSeenAtMs = nowMs;
    return {
      allowed: false,
      reason: "minimum_interval",
      retryAfterMs,
      nextAllowedAtMs: nowMs + retryAfterMs,
    };
  }
  const state: RateState = { inFlight: true, lastStartedAtMs: nowMs, lastSeenAtMs: nowMs };
  rateStates.set(input.actorId, state);
  try {
    return {
      allowed: true,
      value: await readFinancialReconciliationPage(input),
    };
  } finally {
    state.inFlight = false;
    state.lastSeenAtMs = Date.now();
  }
}

export function resetFinancialReconciliationRateLimitForTests(): void {
  rateStates.clear();
}
