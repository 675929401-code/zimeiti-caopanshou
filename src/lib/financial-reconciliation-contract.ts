export const FINANCIAL_RECONCILIATION_SCHEMA_VERSION = 2;
export const FINANCIAL_RECONCILIATION_DEFAULT_PAGE_SIZE = 50;
export const FINANCIAL_RECONCILIATION_MIN_PAGE_SIZE = 50;
export const FINANCIAL_RECONCILIATION_MAX_PAGE_SIZE = 100;
export const FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS = 1_200;
export const FINANCIAL_RECONCILIATION_CURSOR_TTL_MS = 6 * 60 * 60 * 1_000;

export type FinancialReconciliationStageId =
  | "negative_balances"
  | "payment_integrity"
  | "refund_finality"
  | "large_balance_movements";

export type FinancialReconciliationStageStatus =
  | "pending"
  | "running"
  | "complete"
  | "partial"
  | "unavailable";

export type FinancialIssueSeverity = "critical" | "warning" | "info";

export interface FinancialIssue {
  id: string;
  stageId: FinancialReconciliationStageId;
  type: string;
  severity: FinancialIssueSeverity;
  recordId: string;
  userId: string | null;
  detail: string;
  sourceRefs: string[];
}

export interface FinancialIssueSummary {
  totalIssues: number;
  critical: number;
  warning: number;
  info: number;
}

export interface FinancialSourceGap {
  stageId: FinancialReconciliationStageId;
  source: string;
  code: string;
  detail: string;
}

export interface FinancialStageProgress {
  id: FinancialReconciliationStageId;
  label: string;
  description: string;
  sources: string[];
  status: FinancialReconciliationStageStatus;
  scanned: number;
  total: number | null;
  issues: FinancialIssueSummary;
  gaps: FinancialSourceGap[];
}

export interface FinancialReconciliationCoverage {
  status: "scanning" | "complete" | "partial";
  complete: boolean;
  scanned: number;
  total: number | null;
  stages: FinancialStageProgress[];
  sourceGaps: FinancialSourceGap[];
}

export interface FinancialReconciliationResponse {
  ok: true;
  schemaVersion: typeof FINANCIAL_RECONCILIATION_SCHEMA_VERSION;
  scanId: string;
  snapshotAt: string;
  checkedAt: string;
  currentStage: {
    id: FinancialReconciliationStageId;
    label: string;
    pageScanned: number;
    pageIssues: number;
  };
  coverage: FinancialReconciliationCoverage;
  summary: FinancialIssueSummary;
  issues: FinancialIssue[];
  nextCursor: string | null;
  checkpoint: {
    resumable: boolean;
    expiresAt: string;
    snapshotAt: string;
    populationBoundary: "created_at_lte_snapshot";
    rowState: "read_time_current";
  };
  rateLimit: {
    scope: "process-local-admin";
    minimumIntervalMs: number;
    retryAfterSeconds: number;
  };
  readPolicy: {
    readOnly: true;
    databaseWrites: 0;
    providerCalls: 0;
    pageSize: number;
  };
}

export interface FinancialReconciliationRateLimitedResponse {
  ok: false;
  code: "FINANCIAL_RECONCILIATION_RATE_LIMITED";
  error: string;
  retryAfterSeconds: number;
  nextAllowedAt: string;
}

export type FinancialRow = Record<string, unknown>;

export interface FinancialStageDefinition {
  id: FinancialReconciliationStageId;
  label: string;
  description: string;
  sources: string[];
}

export const FINANCIAL_RECONCILIATION_STAGES: readonly FinancialStageDefinition[] = [
  {
    id: "negative_balances",
    label: "余额底线",
    description: "逐页核对所有纳入快照的会员积分与现金余额，不允许出现负数。",
    sources: ["users"],
  },
  {
    id: "payment_integrity",
    label: "支付到账与渠道凭证",
    description: "逐页核对 paid/refunded 订单、统一钱包完成记录、金额快照与渠道确认凭证。",
    sources: ["payment_orders", "wallet_operations"],
  },
  {
    id: "refund_finality",
    label: "退款终态",
    description: "逐页核对退款状态机、订单回执、钱包冻结与释放记录，不把未决状态当作成功。",
    sources: ["payment_refund_attempts", "payment_orders", "wallet_operations"],
  },
  {
    id: "large_balance_movements",
    label: "高额余额变动",
    description: "逐页扫描余额审计日志，标记超过积分或现金阈值的变动供人工复核。",
    sources: ["balance_audit_log"],
  },
] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameAmount(left: unknown, right: unknown): boolean {
  const leftNumber = finiteNumber(left);
  const rightNumber = finiteNumber(right);
  return leftNumber != null && rightNumber != null && Math.abs(leftNumber - rightNumber) < 0.000001;
}

function issue(input: Omit<FinancialIssue, "id">): FinancialIssue {
  return {
    ...input,
    id: `${input.stageId}:${input.type}:${input.recordId}`,
  };
}

export function emptyFinancialIssueSummary(): FinancialIssueSummary {
  return { totalIssues: 0, critical: 0, warning: 0, info: 0 };
}

export function summarizeFinancialIssues(issues: readonly FinancialIssue[]): FinancialIssueSummary {
  return issues.reduce<FinancialIssueSummary>((summary, item) => {
    summary.totalIssues += 1;
    summary[item.severity] += 1;
    return summary;
  }, emptyFinancialIssueSummary());
}

export function addFinancialIssueSummaries(
  left: FinancialIssueSummary,
  right: FinancialIssueSummary,
): FinancialIssueSummary {
  return {
    totalIssues: left.totalIssues + right.totalIssues,
    critical: left.critical + right.critical,
    warning: left.warning + right.warning,
    info: left.info + right.info,
  };
}

export function clampFinancialReconciliationPageSize(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return FINANCIAL_RECONCILIATION_DEFAULT_PAGE_SIZE;
  return Math.max(
    FINANCIAL_RECONCILIATION_MIN_PAGE_SIZE,
    Math.min(FINANCIAL_RECONCILIATION_MAX_PAGE_SIZE, Math.trunc(value as number)),
  );
}

export function newFinancialStageProgress(definition: FinancialStageDefinition): FinancialStageProgress {
  return {
    ...definition,
    sources: [...definition.sources],
    status: "pending",
    scanned: 0,
    total: null,
    issues: emptyFinancialIssueSummary(),
    gaps: [],
  };
}

export function evaluateNegativeBalance(row: FinancialRow): FinancialIssue[] {
  const recordId = text(row.id) || "unknown-user";
  const credits = finiteNumber(row.credits);
  const cash = finiteNumber(row.cash_balance);
  const negativeFields = [
    credits != null && credits < 0 ? `积分 ${credits}` : "",
    cash != null && cash < 0 ? `现金 ¥${cash}` : "",
  ].filter(Boolean);
  if (negativeFields.length === 0) return [];
  return [issue({
    stageId: "negative_balances",
    type: "negative_balance",
    severity: "critical",
    recordId,
    userId: recordId,
    detail: `${text(row.display_name) || text(row.username) || recordId} 出现负余额：${negativeFields.join("，")}`,
    sourceRefs: [`users:${recordId}`],
  })];
}

export function paymentWalletIdentity(order: FinancialRow): {
  idempotencyKey: string;
  operationKind: "credit_topup" | "cash_topup" | null;
  expectedAmount: number | null;
} {
  const tradeOrderId = text(order.trade_order_id);
  const orderType = text(order.type).toLowerCase();
  return {
    idempotencyKey: tradeOrderId ? `payment:${tradeOrderId}` : "",
    operationKind: orderType === "credits" ? "credit_topup" : orderType === "cash" ? "cash_topup" : null,
    expectedAmount: orderType === "credits" ? finiteNumber(order.credits_amount) : orderType === "cash" ? finiteNumber(order.amount) : null,
  };
}

export function evaluatePaymentOrder(
  order: FinancialRow,
  walletOperationsByKey: ReadonlyMap<string, FinancialRow>,
  options: { providerEvidenceAvailable: boolean; walletEvidenceAvailable: boolean },
): FinancialIssue[] {
  const issues: FinancialIssue[] = [];
  const recordId = text(order.trade_order_id) || text(order.id) || "unknown-order";
  const userId = text(order.user_id) || null;
  const status = text(order.status).toLowerCase();
  const identity = paymentWalletIdentity(order);

  if (!identity.operationKind || identity.expectedAmount == null || identity.expectedAmount <= 0) {
    issues.push(issue({
      stageId: "payment_integrity",
      type: "payment_amount_snapshot_invalid",
      severity: "critical",
      recordId,
      userId,
      detail: `订单 ${recordId} 缺少可核对的钱包类型或到账金额快照。`,
      sourceRefs: [`payment_orders:${recordId}`],
    }));
  } else if (options.walletEvidenceAvailable) {
    const operation = walletOperationsByKey.get(identity.idempotencyKey);
    const walletMatched = operation
      && text(operation.status).toLowerCase() === "completed"
      && text(operation.operation_kind).toLowerCase() === identity.operationKind
      && sameAmount(operation.amount, identity.expectedAmount)
      && finiteNumber(operation.balance_before) != null
      && finiteNumber(operation.balance_after) != null;
    if (!walletMatched) {
      issues.push(issue({
        stageId: "payment_integrity",
        type: "paid_order_wallet_mismatch",
        severity: "critical",
        recordId,
        userId,
        detail: `订单 ${recordId} 为 ${status}，但没有金额与状态都匹配的 completed 钱包到账记录。`,
        sourceRefs: [`payment_orders:${recordId}`, `wallet_operations:${identity.idempotencyKey}`],
      }));
    }
  }

  if (options.providerEvidenceAvailable) {
    const providerAmountMatched = sameAmount(order.provider_paid_amount, order.amount);
    const providerEvidenceMatched = Boolean(
      text(order.payment_provider)
      && text(order.provider_trade_order_id) === recordId
      && text(order.provider_transaction_id)
      && providerAmountMatched
      && text(order.provider_confirmed_at),
    );
    if (!providerEvidenceMatched) {
      issues.push(issue({
        stageId: "payment_integrity",
        type: "provider_confirmation_incomplete",
        severity: "critical",
        recordId,
        userId,
        detail: `订单 ${recordId} 缺少完整渠道订单号、渠道流水号、实付金额或确认时间，不能计为渠道已确认收入。`,
        sourceRefs: [`payment_orders:${recordId}`],
      }));
    }
  }

  if (status === "refunded") {
    const receiptComplete = Boolean(
      text(order.refund_attempt_id)
      && text(order.provider_refund_id)
      && sameAmount(order.provider_refund_amount, order.amount)
      && text(order.provider_refund_status)
      && text(order.refunded_at),
    );
    if (!receiptComplete) {
      issues.push(issue({
        stageId: "payment_integrity",
        type: "refunded_order_receipt_incomplete",
        severity: "critical",
        recordId,
        userId,
        detail: `退款订单 ${recordId} 的退款尝试、渠道回执、金额或完成时间不完整。`,
        sourceRefs: [`payment_orders:${recordId}`],
      }));
    }
  }
  return issues;
}

export function refundWalletOperationIds(attempt: FinancialRow): string[] {
  return [text(attempt.wallet_operation_id), text(attempt.release_operation_id)].filter(Boolean);
}

export function evaluateRefundAttempt(
  attempt: FinancialRow,
  ordersByTradeOrderId: ReadonlyMap<string, FinancialRow>,
  walletOperationsById: ReadonlyMap<string, FinancialRow>,
  options: { orderEvidenceAvailable: boolean; walletEvidenceAvailable: boolean; snapshotAt: string },
): FinancialIssue[] {
  const issues: FinancialIssue[] = [];
  const recordId = text(attempt.attempt_id) || "unknown-refund";
  const tradeOrderId = text(attempt.trade_order_id);
  const userId = text(attempt.user_id) || null;
  const state = text(attempt.state).toLowerCase();
  const walletAmount = finiteNumber(attempt.wallet_amount);
  const reservationId = text(attempt.wallet_operation_id);
  const releaseId = text(attempt.release_operation_id);

  if (state === "reconciliation_required") {
    issues.push(issue({
      stageId: "refund_finality",
      type: "refund_reconciliation_required",
      severity: "critical",
      recordId,
      userId,
      detail: `退款 ${recordId} 处于 reconciliation_required，必须人工对账，禁止自动重试。`,
      sourceRefs: [`payment_refund_attempts:${recordId}`, `payment_orders:${tradeOrderId}`],
    }));
  } else if (state === "reserved" || state === "provider_started") {
    const leaseExpired = Date.parse(text(attempt.lease_until)) <= Date.parse(options.snapshotAt);
    issues.push(issue({
      stageId: "refund_finality",
      type: leaseExpired ? "refund_nonterminal_lease_expired" : "refund_in_progress",
      severity: leaseExpired ? "critical" : "info",
      recordId,
      userId,
      detail: leaseExpired
        ? `退款 ${recordId} 尚未终态且租约已过期。`
        : `退款 ${recordId} 在快照时仍处于 ${state}，暂未形成最终结果。`,
      sourceRefs: [`payment_refund_attempts:${recordId}`],
    }));
  } else if (state !== "completed" && state !== "released") {
    issues.push(issue({
      stageId: "refund_finality",
      type: "refund_state_unknown",
      severity: "critical",
      recordId,
      userId,
      detail: `退款 ${recordId} 出现未识别状态 ${state || "空"}。`,
      sourceRefs: [`payment_refund_attempts:${recordId}`],
    }));
  }

  if (options.walletEvidenceAvailable) {
    const reservation = walletOperationsById.get(reservationId);
    const expectedReservationKind = text(attempt.order_type).toLowerCase() === "credits" ? "credit_charge" : "cash_charge";
    if (!reservation
      || text(reservation.status).toLowerCase() !== "completed"
      || text(reservation.operation_kind).toLowerCase() !== expectedReservationKind
      || !sameAmount(reservation.amount, walletAmount)) {
      issues.push(issue({
        stageId: "refund_finality",
        type: "refund_wallet_reservation_mismatch",
        severity: "critical",
        recordId,
        userId,
        detail: `退款 ${recordId} 缺少金额匹配的 completed 钱包冻结记录。`,
        sourceRefs: [`payment_refund_attempts:${recordId}`, `wallet_operations:${reservationId || "missing"}`],
      }));
    }
    if (state === "released") {
      const release = walletOperationsById.get(releaseId);
      const expectedReleaseKind = text(attempt.order_type).toLowerCase() === "credits" ? "credit_refund" : "cash_refund";
      if (!release
        || text(release.status).toLowerCase() !== "completed"
        || text(release.operation_kind).toLowerCase() !== expectedReleaseKind
        || !sameAmount(release.amount, walletAmount)) {
        issues.push(issue({
          stageId: "refund_finality",
          type: "refund_wallet_release_mismatch",
          severity: "critical",
          recordId,
          userId,
          detail: `已释放退款 ${recordId} 缺少金额匹配的 completed 钱包返还记录。`,
          sourceRefs: [`payment_refund_attempts:${recordId}`, `wallet_operations:${releaseId || "missing"}`],
        }));
      }
    }
  }

  if (options.orderEvidenceAvailable) {
    const order = ordersByTradeOrderId.get(tradeOrderId);
    if (!order) {
      issues.push(issue({
        stageId: "refund_finality",
        type: "refund_order_missing",
        severity: "critical",
        recordId,
        userId,
        detail: `退款 ${recordId} 找不到对应支付订单 ${tradeOrderId || "空"}。`,
        sourceRefs: [`payment_refund_attempts:${recordId}`, `payment_orders:${tradeOrderId || "missing"}`],
      }));
    } else if (state === "completed") {
      const orderMatched = text(order.status).toLowerCase() === "refunded"
        && text(order.refund_attempt_id) === recordId
        && text(order.provider_refund_id) === text(attempt.provider_refund_id)
        && sameAmount(order.provider_refund_amount, attempt.provider_refund_amount)
        && sameAmount(attempt.provider_refund_amount, attempt.paid_amount)
        && text(attempt.provider_status).toUpperCase() === "CD"
        && text(attempt.completed_at);
      if (!orderMatched) {
        issues.push(issue({
          stageId: "refund_finality",
          type: "refund_completed_receipt_mismatch",
          severity: "critical",
          recordId,
          userId,
          detail: `已完成退款 ${recordId} 与订单终态、渠道回执或退款金额不一致。`,
          sourceRefs: [`payment_refund_attempts:${recordId}`, `payment_orders:${tradeOrderId}`],
        }));
      }
    } else if (state === "released") {
      if (text(order.status).toLowerCase() !== "paid" || text(attempt.provider_status).toUpperCase() !== "UD" || !text(attempt.released_at)) {
        issues.push(issue({
          stageId: "refund_finality",
          type: "refund_release_receipt_mismatch",
          severity: "critical",
          recordId,
          userId,
          detail: `已释放退款 ${recordId} 未保持订单 paid，或缺少 UD/释放时间凭证。`,
          sourceRefs: [`payment_refund_attempts:${recordId}`, `payment_orders:${tradeOrderId}`],
        }));
      }
    }
  }
  return issues;
}

export function evaluateLargeBalanceDelta(row: FinancialRow): FinancialIssue[] {
  const delta = finiteNumber(row.delta);
  if (delta == null) return [];
  const field = text(row.field).toLowerCase();
  const threshold = field === "cash_balance" ? 100 : 10_000;
  if (Math.abs(delta) <= threshold) return [];
  const recordId = text(row.id) || `${text(row.user_id)}:${text(row.created_at)}`;
  return [issue({
    stageId: "large_balance_movements",
    type: "large_balance_delta",
    severity: "warning",
    recordId,
    userId: text(row.user_id) || null,
    detail: `${field === "cash_balance" ? "现金" : "积分"}单笔变动 ${delta}，超过复核阈值 ${threshold}；来源 ${text(row.source) || "未记录"}。`,
    sourceRefs: [`balance_audit_log:${recordId}`, text(row.source_id) ? `${text(row.source)}:${text(row.source_id)}` : ""].filter(Boolean),
  })];
}
