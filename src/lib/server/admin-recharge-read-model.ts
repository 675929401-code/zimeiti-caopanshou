export const RECHARGE_TIMELINE_DEFAULT_LIMIT = 80;
export const RECHARGE_TIMELINE_MAX_LIMIT = 200;

export type RechargeCategory = "credits" | "cash" | "";
export type RechargeSourceStateValue = "available" | "partial" | "unavailable" | "not_requested";
export type RechargeSourceId =
  | "payment_orders"
  | "wallet_operations"
  | "credit_transactions"
  | "cash_transactions"
  | "payment_refund_attempts"
  | "offline_payment_receipts"
  | "member_activation_events"
  | "member_package_assignments"
  | "users";

export type RechargeDatabaseRow = Record<string, unknown>;

export interface RechargeSourceResult {
  id: RechargeSourceId;
  state: RechargeSourceStateValue;
  rows: RechargeDatabaseRow[] | null;
  rowCount: number | null;
  truncated: boolean;
  errorCode: string | null;
  asOf: string | null;
}

export interface RechargeSourceState extends Omit<RechargeSourceResult, "rows"> {
  label: string;
}

export interface RechargeWindow {
  startAt: string | null;
  endBefore: string | null;
  timezone: "Asia/Shanghai";
}

export interface RechargeTimelineEvent {
  id: string;
  dedupeKey: string;
  kind: "online_payment" | "wallet_credit" | "legacy_credit" | "refund" | "offline_payment" | "member_activation" | "member_package";
  title: string;
  detail: string;
  occurredAt: string;
  status: string;
  statusLabel: string;
  evidenceState: "available" | "partial" | "unavailable";
  sourceIds: RechargeSourceId[];
  user: {
    id: string;
    displayName: string;
    identityState: "current" | "historical_or_deleted" | "unavailable";
  };
  wallet: "credits" | "cash" | "none" | null;
  amount: {
    currency: number | null;
    credits: number | null;
    cash: number | null;
  };
  includedInRevenue: boolean | null;
  revenueEffect: number | null;
  channel: {
    provider: string | null;
    providerLabel: string;
    method: string | null;
    methodLabel: string;
    rawProvider: string | null;
    rawMethod: string | null;
  };
  providerConfirmation: {
    state: "confirmed" | "unavailable" | "not_applicable";
    confirmedAt: string | null;
    transactionId: string | null;
  };
  references: {
    tradeOrderId: string | null;
    walletOperationId: string | null;
    legacyTransactionId: string | null;
    refundAttemptId: string | null;
    offlineReceiptId: string | null;
    activationEventId: string | null;
    packageAssignmentId: string | null;
  };
}

export interface RechargeLegacyRow extends RechargeDatabaseRow {
  accountingScope: string;
  includedInCreditedTotal: "是" | "否";
  userId: string;
  userName: string;
  identityState: "current" | "historical_or_deleted" | "unavailable";
  phone: string;
  email: string;
  memberStatus: string;
  wallet: string;
  businessType: string;
  accountingStatus: string;
  deltaCredits: number;
  deltaCash: number;
  balanceBefore: number | "";
  balanceAfter: number | "";
  orderAmount: number | "";
  orderStatus: string;
  paymentMethod: string;
  paymentProvider: string;
  normalizedPaymentMethod: string | null;
  normalizedPaymentProvider: string | null;
  providerConfirmationState: "confirmed" | "unavailable" | "not_applicable";
  tradeOrderId: string;
  providerTradeOrderId: string;
  providerTransactionId: string;
  walletOperationId: string;
  offlineReceiptId?: string;
  offlineReference?: string;
  payerReferenceMasked?: string;
  activationEventId?: string;
  idempotencyKey: string;
  legacyTransactionId: string;
  description: string;
  createdAt: string;
  completedAt: string;
  paidAt: string;
  providerConfirmedAt: string | null;
  voidedAt?: string;
  voidReason?: string;
  metadata: RechargeDatabaseRow;
}

export interface RechargeReconciliationSummary {
  recordCount: number;
  creditedOperationCount: number | null;
  totalCreditsCredited: number | null;
  totalCashCredited: number | null;
  paidOrderAmount: number | null;
  unmatchedOrderCount: number | null;
  offlineConfirmedCount: number | null;
  offlineConfirmedAmount: number | null;
  offlineVoidedCount: number | null;
  paidOrderScopeCount: number | null;
  paidWithoutWalletCreditCount: number | null;
  providerConfirmationMissingCount: number | null;
  legacyUnmatchedTopupCount: number | null;
  revenue: {
    currency: "CNY";
    onlineProviderConfirmedAmount: number | null;
    offlineConfirmedAmount: number | null;
    grossConfirmedAmount: number | null;
    completedRefundAmount: number | null;
    netConfirmedAmount: number | null;
    expiredOrdersIncluded: false;
  };
  truncated: boolean;
  timezone: "Asia/Shanghai";
}

export interface RechargeReconciliationModel {
  rows: RechargeLegacyRow[];
  summary: RechargeReconciliationSummary;
  timeline: {
    events: RechargeTimelineEvent[];
    totalCount: number;
    limit: number;
    truncated: boolean;
  };
  dataQuality: {
    status: "complete" | "partial" | "unavailable";
    availableSources: number;
    partialSources: number;
    unavailableSources: number;
    notRequestedSources: number;
    truncatedSources: number;
    notes: string[];
  };
  sourceStates: RechargeSourceState[];
  asOf: string;
  window: RechargeWindow;
}

export interface BuildRechargeReadModelInput {
  sources: Record<RechargeSourceId, RechargeSourceResult>;
  supplementalOrders?: RechargeDatabaseRow[];
  supplementalWalletOperations?: RechargeDatabaseRow[];
  asOf: string;
  window: RechargeWindow;
  timelineLimit?: number;
}

const SOURCE_LABELS: Record<RechargeSourceId, string> = {
  payment_orders: "在线支付订单",
  wallet_operations: "统一钱包操作",
  credit_transactions: "历史积分流水",
  cash_transactions: "历史现金流水",
  payment_refund_attempts: "支付退款",
  offline_payment_receipts: "线下收款凭证",
  member_activation_events: "会员激活事件",
  member_package_assignments: "会员套餐派发",
  users: "会员账号资料",
};

const SOURCE_ORDER = Object.keys(SOURCE_LABELS) as RechargeSourceId[];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText || null;
}

function finiteNumber(value: unknown): number | null {
  if (value === "" || value == null) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function amount(value: unknown): number {
  return finiteNumber(value) ?? 0;
}

function isoTimestamp(value: unknown): string | null {
  const valueText = text(value);
  if (!valueText) return null;
  const timestamp = Date.parse(valueText);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function objectValue(value: unknown): RechargeDatabaseRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RechargeDatabaseRow : {};
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as RechargeDatabaseRow).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
}

function stableRowKey(row: RechargeDatabaseRow): string {
  return JSON.stringify(stableValue(row));
}

function uniqueRows(rows: RechargeDatabaseRow[]): RechargeDatabaseRow[] {
  const ordered = [...rows].sort((left, right) => stableRowKey(left).localeCompare(stableRowKey(right)));
  const seen = new Set<string>();
  return ordered.filter((row) => {
    const key = stableRowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceRows(source: RechargeSourceResult): RechargeDatabaseRow[] {
  return source.rows ? uniqueRows(source.rows) : [];
}

function sourceComplete(source: RechargeSourceResult): boolean {
  return source.state === "available" && !source.truncated;
}

function sourceReadable(source: RechargeSourceResult): boolean {
  return (source.state === "available" || source.state === "partial") && Array.isArray(source.rows);
}

export function availableRechargeSource(id: RechargeSourceId, rows: RechargeDatabaseRow[], options: { asOf: string; truncated?: boolean; partial?: boolean; errorCode?: string | null }): RechargeSourceResult {
  return {
    id,
    state: options.partial ? "partial" : "available",
    rows,
    rowCount: rows.length,
    truncated: Boolean(options.truncated),
    errorCode: options.errorCode || null,
    asOf: options.asOf,
  };
}

export function unavailableRechargeSource(id: RechargeSourceId, errorCode: string): RechargeSourceResult {
  return { id, state: "unavailable", rows: null, rowCount: null, truncated: false, errorCode, asOf: null };
}

export function notRequestedRechargeSource(id: RechargeSourceId): RechargeSourceResult {
  return { id, state: "not_requested", rows: null, rowCount: null, truncated: false, errorCode: null, asOf: null };
}

export function clampRechargeTimelineLimit(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return RECHARGE_TIMELINE_DEFAULT_LIMIT;
  return Math.min(RECHARGE_TIMELINE_MAX_LIMIT, Math.max(1, Math.trunc(value as number)));
}

export function rechargeSourceErrorCode(error: unknown): string {
  const record = objectValue(error);
  const code = text(record.code);
  const message = `${text(record.message)} ${text(record.details)} ${text(record.hint)}`;
  if (code === "42P01" || code === "PGRST205" || /schema cache|does not exist|could not find the table/iu.test(message)) return "SOURCE_TABLE_UNAVAILABLE";
  if (/column .* does not exist|could not find .* column/iu.test(message)) return "SOURCE_SCHEMA_UNAVAILABLE";
  return code ? `SOURCE_READ_FAILED:${code}` : "SOURCE_READ_FAILED";
}

export function normalizeRechargeChannel(providerValue: unknown, methodValue: unknown) {
  const rawProvider = nullableText(providerValue);
  const rawMethod = nullableText(methodValue);
  const providerKey = (rawProvider || "").toLowerCase().replace(/[\s_-]+/gu, "");
  const methodKey = (rawMethod || "").toLowerCase().replace(/[\s_-]+/gu, "");
  const provider = providerKey === "xunhupay" || providerKey === "xunhu" || providerKey === "迅虎支付"
    ? "xunhupay"
    : providerKey === "epay" || providerKey === "易支付"
      ? "epay"
      : providerKey === "offline" || providerKey === "manual" || providerKey === "线下人工核验"
        ? "offline"
        : rawProvider?.toLowerCase() || null;
  const method = ["wechat", "wechatpay", "wxpay", "微信", "微信支付", "微信转账"].includes(methodKey)
    ? "wechat"
    : ["alipay", "支付宝", "支付宝支付", "支付宝转账"].includes(methodKey)
      ? "alipay"
      : ["bank", "banktransfer", "银行", "银行转账"].includes(methodKey)
        ? "bank_transfer"
        : ["cash", "现金"].includes(methodKey)
          ? "cash"
          : rawMethod?.toLowerCase() || null;
  const providerLabel = provider === "xunhupay" ? "迅虎支付" : provider === "epay" ? "易支付" : provider === "offline" ? "线下人工核验" : rawProvider || "渠道未记录";
  const methodLabel = method === "wechat" ? "微信" : method === "alipay" ? "支付宝" : method === "bank_transfer" ? "银行转账" : method === "cash" ? "现金" : rawMethod || "方式未记录";
  return { provider, providerLabel, method, methodLabel, rawProvider, rawMethod };
}

function providerConfirmation(order: RechargeDatabaseRow) {
  const orderStatus = text(order.status).toLowerCase();
  if (orderStatus !== "paid" && orderStatus !== "refunded") {
    return { state: "not_applicable" as const, confirmedAt: null, transactionId: nullableText(order.provider_transaction_id) };
  }
  const confirmedAt = isoTimestamp(order.provider_confirmed_at);
  if (!confirmedAt) return { state: "unavailable" as const, confirmedAt: null, transactionId: nullableText(order.provider_transaction_id) };
  return { state: "confirmed" as const, confirmedAt, transactionId: nullableText(order.provider_transaction_id) };
}

function tradeOrderIdFromWallet(row: RechargeDatabaseRow): string {
  const key = text(row.idempotency_key);
  const metadata = objectValue(row.metadata);
  if (key.startsWith("payment:")) return key.slice("payment:".length);
  return text(metadata.trade_order_id);
}

function rechargeIdentity(userId: string, users: Map<string, RechargeDatabaseRow>, usersSource: RechargeSourceResult) {
  const user = users.get(userId);
  if (user) {
    return {
      id: userId,
      displayName: text(user.display_name) || text(user.username) || text(user.phone) || text(user.email) || userId,
      identityState: "current" as const,
    };
  }
  if (!sourceReadable(usersSource)) return { id: userId, displayName: "账号资料不可用", identityState: "unavailable" as const };
  return { id: userId, displayName: "已删除账号", identityState: "historical_or_deleted" as const };
}

function legacySourceForWallet(
  operation: RechargeDatabaseRow,
  credits: RechargeDatabaseRow[],
  cash: RechargeDatabaseRow[],
): { sourceIds: RechargeSourceId[]; matchedLegacyKeys: string[] } {
  const operationId = text(operation.id);
  const legacyId = text(operation.legacy_transaction_id);
  const idempotencyKey = text(operation.idempotency_key);
  const wallet = text(operation.wallet);
  const sourceRowsToInspect = wallet === "cash" ? cash : credits;
  const sourceId: RechargeSourceId = wallet === "cash" ? "cash_transactions" : "credit_transactions";
  const matchedLegacyKeys: string[] = [];
  for (const row of sourceRowsToInspect) {
    const metadata = objectValue(row.metadata);
    const rowId = text(row.id);
    const walletOperationId = text(metadata.wallet_operation_id);
    const legacyKey = `${sourceId}:${rowId || stableRowKey(row)}`;
    if ((legacyId && rowId === legacyId)
      || (operationId && walletOperationId === operationId)
      || (idempotencyKey && (text(metadata.idempotency_key) === idempotencyKey || text(row.reference_id) === idempotencyKey))) {
      matchedLegacyKeys.push(legacyKey);
    }
  }
  return { sourceIds: matchedLegacyKeys.length > 0 ? ["wallet_operations", sourceId] : ["wallet_operations"], matchedLegacyKeys };
}

function withinWindow(timestamp: string, window: RechargeWindow): boolean {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return false;
  if (window.startAt && value < Date.parse(window.startAt)) return false;
  if (window.endBefore && value >= Date.parse(window.endBefore)) return false;
  return true;
}

function statusLabel(status: string): string {
  const normalized = status.toLowerCase();
  return normalized === "paid" ? "已支付"
    : normalized === "refunded" ? "已退款"
      : normalized === "expired" ? "已过期"
        : normalized === "completed" ? "已完成"
          : normalized === "confirmed" ? "已确认"
            : normalized === "voided" ? "已作废"
              : normalized === "processing" || normalized === "reserved" || normalized === "provider_started" ? "处理中"
                : normalized === "reconciliation_required" ? "待核对"
                  : normalized === "released" ? "已释放"
                    : normalized === "active" ? "已激活"
                      : normalized === "trial" ? "试用中"
                        : normalized === "inactive" ? "未激活"
                          : normalized === "expired_member" ? "会员已到期"
                            : normalized || "状态未记录";
}

function baseReferences(overrides: Partial<RechargeTimelineEvent["references"]> = {}): RechargeTimelineEvent["references"] {
  return {
    tradeOrderId: null,
    walletOperationId: null,
    legacyTransactionId: null,
    refundAttemptId: null,
    offlineReceiptId: null,
    activationEventId: null,
    packageAssignmentId: null,
    ...overrides,
  };
}

function noProviderConfirmation(): RechargeTimelineEvent["providerConfirmation"] {
  return { state: "not_applicable", confirmedAt: null, transactionId: null };
}

function emptyChannel() {
  return normalizeRechargeChannel(null, null);
}

function addEvent(events: Map<string, RechargeTimelineEvent>, event: RechargeTimelineEvent) {
  const current = events.get(event.dedupeKey);
  if (!current) {
    events.set(event.dedupeKey, { ...event, sourceIds: [...new Set(event.sourceIds)].sort() as RechargeSourceId[] });
    return;
  }
  const sourceIds = [...new Set([...current.sourceIds, ...event.sourceIds])].sort() as RechargeSourceId[];
  const selected = stableRowKey(event as unknown as RechargeDatabaseRow).localeCompare(stableRowKey(current as unknown as RechargeDatabaseRow)) < 0 ? event : current;
  events.set(event.dedupeKey, { ...selected, sourceIds });
}

function legacyTopup(row: RechargeDatabaseRow, wallet: "credits" | "cash"): boolean {
  const rowType = text(row.type).toLowerCase();
  const transactionType = text(row.transaction_type).toLowerCase();
  return wallet === "credits"
    ? rowType === "recharge" || rowType === "topup" || transactionType === "recharge" || transactionType === "topup"
    : rowType === "topup" || rowType === "recharge";
}

export function buildRechargeReadModel(input: BuildRechargeReadModelInput): RechargeReconciliationModel {
  const timelineLimit = clampRechargeTimelineLimit(input.timelineLimit);
  const paymentOrders = sourceRows(input.sources.payment_orders);
  const walletOperations = sourceRows(input.sources.wallet_operations);
  const creditTransactions = sourceRows(input.sources.credit_transactions).filter((row) => legacyTopup(row, "credits"));
  const cashTransactions = sourceRows(input.sources.cash_transactions).filter((row) => legacyTopup(row, "cash"));
  const refundAttempts = sourceRows(input.sources.payment_refund_attempts);
  const offlineReceipts = sourceRows(input.sources.offline_payment_receipts);
  const activationEvents = sourceRows(input.sources.member_activation_events);
  const packageAssignments = sourceRows(input.sources.member_package_assignments);
  const allOrders = uniqueRows([...paymentOrders, ...(input.supplementalOrders || [])]);
  const allWalletOperations = uniqueRows([...walletOperations, ...(input.supplementalWalletOperations || [])]);
  const users = new Map<string, RechargeDatabaseRow>();
  for (const row of sourceRows(input.sources.users)) {
    const id = text(row.id);
    if (id) users.set(id, row);
  }
  const orderByTradeId = new Map<string, RechargeDatabaseRow>();
  for (const row of allOrders) {
    const tradeOrderId = text(row.trade_order_id);
    if (tradeOrderId) orderByTradeId.set(tradeOrderId, row);
  }
  const completedWalletTradeIds = new Set(allWalletOperations
    .filter((row) => text(row.status).toLowerCase() === "completed")
    .map(tradeOrderIdFromWallet)
    .filter(Boolean));
  const events = new Map<string, RechargeTimelineEvent>();
  const matchedLegacyKeys = new Set<string>();

  for (const order of allOrders) {
    const tradeOrderId = text(order.trade_order_id);
    const orderId = tradeOrderId || text(order.id) || stableRowKey(order);
    const userId = text(order.user_id);
    const status = text(order.status).toLowerCase() || "unknown";
    const occurredAt = isoTimestamp(order.paid_at) || isoTimestamp(order.refunded_at) || isoTimestamp(order.created_at);
    if (!occurredAt || !withinWindow(occurredAt, input.window)) continue;
    const confirmation = providerConfirmation(order);
    const orderAmount = finiteNumber(order.provider_paid_amount) ?? finiteNumber(order.amount);
    const channel = normalizeRechargeChannel(order.payment_provider, order.payment_method);
    const paidScope = status === "paid" || status === "refunded";
    const includedInRevenue = paidScope ? (confirmation.state === "confirmed" ? true : null) : false;
    const revenueEffect = paidScope ? (confirmation.state === "confirmed" ? orderAmount : null) : 0;
    addEvent(events, {
      id: `payment-order:${orderId}`,
      dedupeKey: `payment-order:${orderId}`,
      kind: "online_payment",
      title: status === "expired" ? "在线充值订单已过期" : status === "refunded" ? "在线充值订单已退款" : status === "paid" ? "在线充值已支付" : "在线充值订单",
      detail: `${channel.providerLabel} · ${channel.methodLabel}${tradeOrderId ? ` · ${tradeOrderId}` : ""}`,
      occurredAt,
      status,
      statusLabel: statusLabel(status),
      evidenceState: paidScope && confirmation.state !== "confirmed" ? "unavailable" : "available",
      sourceIds: ["payment_orders"],
      user: rechargeIdentity(userId, users, input.sources.users),
      wallet: text(order.type) === "cash" ? "cash" : text(order.type) === "credits" ? "credits" : null,
      amount: {
        currency: finiteNumber(order.amount),
        credits: text(order.type) === "credits" ? finiteNumber(order.credits_amount) : null,
        cash: text(order.type) === "cash" ? finiteNumber(order.amount) : null,
      },
      includedInRevenue,
      revenueEffect,
      channel,
      providerConfirmation: confirmation,
      references: baseReferences({ tradeOrderId: tradeOrderId || null }),
    });
  }

  for (const operation of allWalletOperations) {
    const operationId = text(operation.id) || stableRowKey(operation);
    const userId = text(operation.user_id);
    const wallet = text(operation.wallet) === "cash" ? "cash" : "credits";
    const occurredAt = isoTimestamp(operation.completed_at) || isoTimestamp(operation.created_at);
    if (!occurredAt || !withinWindow(occurredAt, input.window)) continue;
    const legacy = legacySourceForWallet(operation, creditTransactions, cashTransactions);
    legacy.matchedLegacyKeys.forEach((key) => matchedLegacyKeys.add(key));
    const tradeOrderId = tradeOrderIdFromWallet(operation);
    const order = tradeOrderId ? orderByTradeId.get(tradeOrderId) : undefined;
    const channel = order ? normalizeRechargeChannel(order.payment_provider, order.payment_method) : emptyChannel();
    const status = text(operation.status).toLowerCase() || "unknown";
    const delta = finiteNumber(operation.delta);
    addEvent(events, {
      id: `wallet-operation:${operationId}`,
      dedupeKey: `wallet-operation:${operationId}`,
      kind: "wallet_credit",
      title: wallet === "cash" ? "现金钱包入账" : "积分钱包入账",
      detail: text(operation.description) || (tradeOrderId ? `关联订单 ${tradeOrderId}` : "统一钱包入账"),
      occurredAt,
      status,
      statusLabel: statusLabel(status),
      evidenceState: status === "completed" ? "available" : "partial",
      sourceIds: legacy.sourceIds,
      user: rechargeIdentity(userId, users, input.sources.users),
      wallet,
      amount: {
        currency: wallet === "cash" ? delta : null,
        credits: wallet === "credits" ? delta : null,
        cash: wallet === "cash" ? delta : null,
      },
      includedInRevenue: false,
      revenueEffect: 0,
      channel,
      providerConfirmation: order ? providerConfirmation(order) : noProviderConfirmation(),
      references: baseReferences({
        tradeOrderId: tradeOrderId || null,
        walletOperationId: operationId,
        legacyTransactionId: nullableText(operation.legacy_transaction_id),
      }),
    });
  }

  const addLegacyEvents = (rows: RechargeDatabaseRow[], wallet: "credits" | "cash", sourceId: "credit_transactions" | "cash_transactions") => {
    for (const row of rows) {
      const rowId = text(row.id) || stableRowKey(row);
      const legacyKey = `${sourceId}:${rowId}`;
      if (matchedLegacyKeys.has(legacyKey)) continue;
      const occurredAt = isoTimestamp(row.created_at);
      if (!occurredAt || !withinWindow(occurredAt, input.window)) continue;
      const userId = text(row.user_id);
      const value = finiteNumber(row.amount);
      addEvent(events, {
        id: `legacy-topup:${sourceId}:${rowId}`,
        dedupeKey: `legacy-topup:${sourceId}:${rowId}`,
        kind: "legacy_credit",
        title: wallet === "cash" ? "历史现金充值" : "历史积分充值",
        detail: text(row.description) || "统一钱包账本接入前的历史充值记录",
        occurredAt,
        status: "completed",
        statusLabel: "历史已入账",
        evidenceState: "partial",
        sourceIds: [sourceId],
        user: rechargeIdentity(userId, users, input.sources.users),
        wallet,
        amount: { currency: wallet === "cash" ? value : null, credits: wallet === "credits" ? value : null, cash: wallet === "cash" ? value : null },
        includedInRevenue: null,
        revenueEffect: null,
        channel: emptyChannel(),
        providerConfirmation: noProviderConfirmation(),
        references: baseReferences({ legacyTransactionId: rowId }),
      });
    }
  };
  addLegacyEvents(creditTransactions, "credits", "credit_transactions");
  addLegacyEvents(cashTransactions, "cash", "cash_transactions");

  for (const refund of refundAttempts) {
    const attemptId = text(refund.attempt_id) || stableRowKey(refund);
    const userId = text(refund.user_id);
    const status = text(refund.state).toLowerCase() || "unknown";
    const occurredAt = isoTimestamp(refund.completed_at) || isoTimestamp(refund.updated_at) || isoTimestamp(refund.created_at);
    if (!occurredAt || !withinWindow(occurredAt, input.window)) continue;
    const refundAmount = finiteNumber(refund.provider_refund_amount) ?? finiteNumber(refund.paid_amount);
    const completed = status === "completed";
    addEvent(events, {
      id: `payment-refund:${attemptId}`,
      dedupeKey: `payment-refund:${attemptId}`,
      kind: "refund",
      title: completed ? "支付退款已完成" : status === "reconciliation_required" ? "支付退款待核对" : "支付退款处理中",
      detail: text(refund.reason) || (text(refund.trade_order_id) ? `关联订单 ${text(refund.trade_order_id)}` : "支付退款"),
      occurredAt,
      status,
      statusLabel: statusLabel(status),
      evidenceState: completed ? "available" : status === "reconciliation_required" ? "unavailable" : "partial",
      sourceIds: ["payment_refund_attempts"],
      user: rechargeIdentity(userId, users, input.sources.users),
      wallet: text(refund.order_type) === "cash" ? "cash" : text(refund.order_type) === "credits" ? "credits" : null,
      amount: { currency: refundAmount, credits: null, cash: text(refund.order_type) === "cash" ? finiteNumber(refund.wallet_amount) : null },
      includedInRevenue: completed,
      revenueEffect: completed && refundAmount != null ? -refundAmount : null,
      channel: normalizeRechargeChannel(refund.payment_provider, null),
      providerConfirmation: completed
        ? { state: "confirmed", confirmedAt: occurredAt, transactionId: nullableText(refund.provider_refund_id) }
        : { state: "unavailable", confirmedAt: null, transactionId: nullableText(refund.provider_refund_id) },
      references: baseReferences({ tradeOrderId: nullableText(refund.trade_order_id), refundAttemptId: attemptId }),
    });
  }

  for (const receipt of offlineReceipts) {
    const receiptId = text(receipt.id) || stableRowKey(receipt);
    const userId = text(receipt.user_id);
    const status = text(receipt.status).toLowerCase() || "unknown";
    const occurredAt = isoTimestamp(status === "voided" ? receipt.voided_at : receipt.paid_at) || isoTimestamp(receipt.created_at);
    if (!occurredAt || !withinWindow(occurredAt, input.window)) continue;
    const confirmed = status === "confirmed";
    addEvent(events, {
      id: `offline-payment:${receiptId}`,
      dedupeKey: `offline-payment:${receiptId}`,
      kind: "offline_payment",
      title: confirmed ? "线下收款已确认" : status === "voided" ? "线下收款已作废" : "线下收款凭证",
      detail: text(receipt.note) || text(receipt.business_type) || "线下会员收款",
      occurredAt,
      status,
      statusLabel: statusLabel(status),
      evidenceState: confirmed || status === "voided" ? "available" : "partial",
      sourceIds: ["offline_payment_receipts"],
      user: rechargeIdentity(userId, users, input.sources.users),
      wallet: "none",
      amount: { currency: finiteNumber(receipt.amount), credits: null, cash: null },
      includedInRevenue: confirmed,
      revenueEffect: confirmed ? finiteNumber(receipt.amount) : 0,
      channel: normalizeRechargeChannel("offline", receipt.payment_channel),
      providerConfirmation: noProviderConfirmation(),
      references: baseReferences({ offlineReceiptId: receiptId, activationEventId: nullableText(receipt.activation_event_id) }),
    });
  }

  for (const activation of activationEvents) {
    const eventId = text(activation.id) || stableRowKey(activation);
    const userId = text(activation.user_id);
    const occurredAt = isoTimestamp(activation.created_at);
    if (!occurredAt || !withinWindow(occurredAt, input.window)) continue;
    const memberStatus = text(activation.member_status).toLowerCase() || "unknown";
    addEvent(events, {
      id: `member-activation:${eventId}`,
      dedupeKey: `member-activation:${eventId}`,
      kind: "member_activation",
      title: memberStatus === "active" ? "正式会员激活" : memberStatus === "trial" ? "试用会员开通" : "会员状态变更",
      detail: [text(activation.activation_method), text(activation.activation_note)].filter(Boolean).join(" · ") || "会员激活状态留痕",
      occurredAt,
      status: memberStatus === "expired" ? "expired_member" : memberStatus,
      statusLabel: statusLabel(memberStatus === "expired" ? "expired_member" : memberStatus),
      evidenceState: "available",
      sourceIds: ["member_activation_events"],
      user: rechargeIdentity(userId, users, input.sources.users),
      wallet: "none",
      amount: { currency: finiteNumber(activation.activation_fee), credits: null, cash: null },
      includedInRevenue: false,
      revenueEffect: 0,
      channel: emptyChannel(),
      providerConfirmation: noProviderConfirmation(),
      references: baseReferences({ activationEventId: eventId }),
    });
  }

  for (const assignment of packageAssignments) {
    const assignmentId = text(assignment.id) || stableRowKey(assignment);
    const userId = text(assignment.user_id);
    const occurredAt = isoTimestamp(assignment.created_at);
    if (!occurredAt || !withinWindow(occurredAt, input.window)) continue;
    const membershipStatus = text(assignment.membership_status).toLowerCase() || "unknown";
    addEvent(events, {
      id: `member-package:${assignmentId}`,
      dedupeKey: `member-package:${assignmentId}`,
      kind: "member_package",
      title: `套餐已派发：${text(assignment.package_name) || "会员套餐"}`,
      detail: [finiteNumber(assignment.credits) ? `${amount(assignment.credits)} 积分` : "", finiteNumber(assignment.cash_amount) ? `¥${amount(assignment.cash_amount).toFixed(2)} 现金` : "", text(assignment.note)].filter(Boolean).join(" · ") || "套餐权益已记录",
      occurredAt,
      status: membershipStatus,
      statusLabel: statusLabel(membershipStatus),
      evidenceState: "available",
      sourceIds: ["member_package_assignments"],
      user: rechargeIdentity(userId, users, input.sources.users),
      wallet: "none",
      amount: { currency: null, credits: finiteNumber(assignment.credits), cash: finiteNumber(assignment.cash_amount) },
      includedInRevenue: false,
      revenueEffect: 0,
      channel: emptyChannel(),
      providerConfirmation: noProviderConfirmation(),
      references: baseReferences({ packageAssignmentId: assignmentId }),
    });
  }

  const eventList = [...events.values()].sort((left, right) => {
    const timestampDifference = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    return timestampDifference || left.id.localeCompare(right.id);
  });

  const legacyRows: RechargeLegacyRow[] = [];
  for (const operation of walletOperations) {
    const metadata = objectValue(operation.metadata);
    const tradeOrderId = tradeOrderIdFromWallet(operation);
    const order = tradeOrderId ? orderByTradeId.get(tradeOrderId) : undefined;
    const userId = text(operation.user_id);
    const identity = rechargeIdentity(userId, users, input.sources.users);
    const wallet = text(operation.wallet) === "cash" ? "cash" : "credits";
    const completed = text(operation.status).toLowerCase() === "completed";
    const confirmation = order ? providerConfirmation(order) : noProviderConfirmation();
    const channel = normalizeRechargeChannel(order?.payment_provider, order?.payment_method);
    legacyRows.push({
      accountingScope: "钱包入账",
      includedInCreditedTotal: completed ? "是" : "否",
      userId,
      userName: identity.displayName,
      identityState: identity.identityState,
      phone: text(users.get(userId)?.phone),
      email: text(users.get(userId)?.email),
      memberStatus: text(users.get(userId)?.member_status),
      wallet: wallet === "cash" ? "现金" : "积分",
      businessType: text(metadata.source) === "payment" || order ? "在线支付到账" : text(metadata.source) === "admin_manual" ? "管理员手动充值/调整" : "其他入账",
      accountingStatus: completed ? "已入账" : "处理中",
      deltaCredits: wallet === "credits" ? amount(operation.delta) : 0,
      deltaCash: wallet === "cash" ? amount(operation.delta) : 0,
      balanceBefore: finiteNumber(operation.balance_before) ?? "",
      balanceAfter: finiteNumber(operation.balance_after) ?? "",
      orderAmount: order ? amount(order.amount) : "",
      orderStatus: text(order?.status),
      paymentMethod: text(order?.payment_method),
      paymentProvider: text(order?.payment_provider),
      normalizedPaymentMethod: channel.method,
      normalizedPaymentProvider: channel.provider,
      providerConfirmationState: confirmation.state,
      tradeOrderId: text(order?.trade_order_id) || tradeOrderId,
      providerTradeOrderId: text(order?.provider_trade_order_id),
      providerTransactionId: text(order?.provider_transaction_id),
      walletOperationId: text(operation.id),
      idempotencyKey: text(operation.idempotency_key),
      legacyTransactionId: text(operation.legacy_transaction_id),
      description: text(operation.description),
      createdAt: text(operation.created_at),
      completedAt: text(operation.completed_at),
      paidAt: text(order?.paid_at),
      providerConfirmedAt: confirmation.confirmedAt,
      metadata,
    });
  }

  for (const order of paymentOrders) {
    const tradeOrderId = text(order.trade_order_id);
    if (tradeOrderId && completedWalletTradeIds.has(tradeOrderId)) continue;
    const userId = text(order.user_id);
    const identity = rechargeIdentity(userId, users, input.sources.users);
    const confirmation = providerConfirmation(order);
    const channel = normalizeRechargeChannel(order.payment_provider, order.payment_method);
    legacyRows.push({
      accountingScope: "支付订单",
      includedInCreditedTotal: "否",
      userId,
      userName: identity.displayName,
      identityState: identity.identityState,
      phone: text(users.get(userId)?.phone),
      email: text(users.get(userId)?.email),
      memberStatus: text(users.get(userId)?.member_status),
      wallet: text(order.type) === "cash" ? "现金" : "积分",
      businessType: "在线支付订单（未匹配已完成钱包入账）",
      accountingStatus: text(order.status) || "未知",
      deltaCredits: 0,
      deltaCash: 0,
      balanceBefore: "",
      balanceAfter: "",
      orderAmount: amount(order.amount),
      orderStatus: text(order.status),
      paymentMethod: text(order.payment_method),
      paymentProvider: text(order.payment_provider),
      normalizedPaymentMethod: channel.method,
      normalizedPaymentProvider: channel.provider,
      providerConfirmationState: confirmation.state,
      tradeOrderId,
      providerTradeOrderId: text(order.provider_trade_order_id),
      providerTransactionId: text(order.provider_transaction_id),
      walletOperationId: "",
      idempotencyKey: "",
      legacyTransactionId: "",
      description: "",
      createdAt: text(order.created_at),
      completedAt: "",
      paidAt: text(order.paid_at),
      providerConfirmedAt: confirmation.confirmedAt,
      metadata: {},
    });
  }

  for (const receipt of offlineReceipts) {
    const userId = text(receipt.user_id);
    const identity = rechargeIdentity(userId, users, input.sources.users);
    const channel = normalizeRechargeChannel("offline", receipt.payment_channel);
    legacyRows.push({
      accountingScope: "线下收款",
      includedInCreditedTotal: "否",
      userId,
      userName: identity.displayName,
      identityState: identity.identityState,
      phone: text(users.get(userId)?.phone),
      email: text(users.get(userId)?.email),
      memberStatus: text(users.get(userId)?.member_status),
      wallet: "不进入钱包",
      businessType: text(receipt.business_type) === "membership_tuition" ? "线下会员学费" : "其他线下收款",
      accountingStatus: text(receipt.status) === "confirmed" ? "已确认" : text(receipt.status) === "voided" ? "已作废" : text(receipt.status),
      deltaCredits: 0,
      deltaCash: 0,
      balanceBefore: "",
      balanceAfter: "",
      orderAmount: amount(receipt.amount),
      orderStatus: text(receipt.status),
      paymentMethod: text(receipt.payment_channel),
      paymentProvider: "线下人工核验",
      normalizedPaymentMethod: channel.method,
      normalizedPaymentProvider: channel.provider,
      providerConfirmationState: "not_applicable",
      tradeOrderId: text(receipt.merchant_reference),
      providerTradeOrderId: "",
      providerTransactionId: "",
      walletOperationId: "",
      offlineReceiptId: text(receipt.id),
      offlineReference: text(receipt.merchant_reference),
      payerReferenceMasked: text(receipt.payer_reference_masked),
      activationEventId: text(receipt.activation_event_id),
      idempotencyKey: "",
      legacyTransactionId: "",
      description: text(receipt.note),
      createdAt: text(receipt.created_at),
      completedAt: "",
      paidAt: text(receipt.paid_at),
      providerConfirmedAt: null,
      voidedAt: text(receipt.voided_at),
      voidReason: text(receipt.void_reason),
      metadata: { created_by: receipt.created_by ?? null, voided_by: receipt.voided_by ?? null },
    });
  }

  legacyRows.sort((left, right) => {
    const leftAt = Date.parse(left.createdAt || left.paidAt || "") || 0;
    const rightAt = Date.parse(right.createdAt || right.paidAt || "") || 0;
    return rightAt - leftAt || `${left.accountingScope}:${left.walletOperationId}:${left.tradeOrderId}`.localeCompare(`${right.accountingScope}:${right.walletOperationId}:${right.tradeOrderId}`);
  });

  const completedOperations = walletOperations.filter((row) => text(row.status).toLowerCase() === "completed");
  const paidScopeOrders = paymentOrders.filter((row) => ["paid", "refunded"].includes(text(row.status).toLowerCase()));
  const providerConfirmedOrders = paidScopeOrders.filter((row) => providerConfirmation(row).state === "confirmed");
  const providerMissingOrders = paidScopeOrders.filter((row) => providerConfirmation(row).state === "unavailable");
  const confirmedOffline = offlineReceipts.filter((row) => text(row.status).toLowerCase() === "confirmed");
  const completedRefunds = refundAttempts.filter((row) => text(row.state).toLowerCase() === "completed");
  const onlineProviderConfirmedAmount = sourceComplete(input.sources.payment_orders)
    ? providerConfirmedOrders.reduce((sum, row) => sum + (finiteNumber(row.provider_paid_amount) ?? amount(row.amount)), 0)
    : null;
  const offlineConfirmedAmount = sourceComplete(input.sources.offline_payment_receipts)
    ? confirmedOffline.reduce((sum, row) => sum + amount(row.amount), 0)
    : null;
  const completedRefundAmount = sourceComplete(input.sources.payment_refund_attempts)
    ? completedRefunds.reduce((sum, row) => sum + (finiteNumber(row.provider_refund_amount) ?? amount(row.paid_amount)), 0)
    : null;
  const grossConfirmedAmount = onlineProviderConfirmedAmount != null && offlineConfirmedAmount != null
    ? onlineProviderConfirmedAmount + offlineConfirmedAmount
    : null;
  const netConfirmedAmount = grossConfirmedAmount != null && completedRefundAmount != null && providerMissingOrders.length === 0
    ? grossConfirmedAmount - completedRefundAmount
    : null;
  const legacyReadable = sourceComplete(input.sources.credit_transactions) && sourceComplete(input.sources.cash_transactions) && sourceComplete(input.sources.wallet_operations);
  const unmatchedLegacyCount = [...creditTransactions.map((row) => `credit_transactions:${text(row.id) || stableRowKey(row)}`), ...cashTransactions.map((row) => `cash_transactions:${text(row.id) || stableRowKey(row)}`)]
    .filter((key) => !matchedLegacyKeys.has(key)).length;
  const paymentAndWalletComplete = sourceComplete(input.sources.payment_orders) && sourceComplete(input.sources.wallet_operations);
  const sourceStates: RechargeSourceState[] = SOURCE_ORDER.map((id) => ({
    id,
    label: SOURCE_LABELS[id],
    state: input.sources[id].state,
    rowCount: input.sources[id].rowCount,
    truncated: input.sources[id].truncated,
    errorCode: input.sources[id].errorCode,
    asOf: input.sources[id].asOf,
  }));
  const requestedStates = sourceStates.filter((source) => source.state !== "not_requested");
  const unavailableSources = requestedStates.filter((source) => source.state === "unavailable").length;
  const partialSources = requestedStates.filter((source) => source.state === "partial").length;
  const truncatedSources = requestedStates.filter((source) => source.truncated).length;
  const availableSources = requestedStates.filter((source) => source.state === "available").length;
  const dataQualityStatus = availableSources === 0 && (unavailableSources > 0 || partialSources > 0)
    ? "unavailable"
    : unavailableSources > 0 || partialSources > 0 || truncatedSources > 0
      ? "partial"
      : "complete";

  return {
    rows: legacyRows,
    summary: {
      recordCount: legacyRows.length,
      creditedOperationCount: sourceComplete(input.sources.wallet_operations) ? completedOperations.length : null,
      totalCreditsCredited: sourceComplete(input.sources.wallet_operations) ? completedOperations.filter((row) => text(row.wallet) === "credits").reduce((sum, row) => sum + amount(row.delta), 0) : null,
      totalCashCredited: sourceComplete(input.sources.wallet_operations) ? completedOperations.filter((row) => text(row.wallet) === "cash").reduce((sum, row) => sum + amount(row.delta), 0) : null,
      paidOrderAmount: sourceComplete(input.sources.payment_orders) ? paymentOrders.filter((row) => text(row.status).toLowerCase() === "paid").reduce((sum, row) => sum + amount(row.amount), 0) : null,
      unmatchedOrderCount: paymentAndWalletComplete ? paidScopeOrders.filter((row) => !completedWalletTradeIds.has(text(row.trade_order_id))).length : null,
      offlineConfirmedCount: sourceComplete(input.sources.offline_payment_receipts) ? confirmedOffline.length : null,
      offlineConfirmedAmount,
      offlineVoidedCount: sourceComplete(input.sources.offline_payment_receipts) ? offlineReceipts.filter((row) => text(row.status).toLowerCase() === "voided").length : null,
      paidOrderScopeCount: sourceComplete(input.sources.payment_orders) ? paidScopeOrders.length : null,
      paidWithoutWalletCreditCount: paymentAndWalletComplete ? paidScopeOrders.filter((row) => !completedWalletTradeIds.has(text(row.trade_order_id))).length : null,
      providerConfirmationMissingCount: sourceComplete(input.sources.payment_orders) ? providerMissingOrders.length : null,
      legacyUnmatchedTopupCount: legacyReadable ? unmatchedLegacyCount : null,
      revenue: {
        currency: "CNY",
        onlineProviderConfirmedAmount,
        offlineConfirmedAmount,
        grossConfirmedAmount,
        completedRefundAmount,
        netConfirmedAmount,
        expiredOrdersIncluded: false,
      },
      truncated: sourceStates.some((source) => source.truncated),
      timezone: "Asia/Shanghai",
    },
    timeline: {
      events: eventList.slice(0, timelineLimit),
      totalCount: eventList.length,
      limit: timelineLimit,
      truncated: eventList.length > timelineLimit,
    },
    dataQuality: {
      status: dataQualityStatus,
      availableSources,
      partialSources,
      unavailableSources,
      notRequestedSources: sourceStates.filter((source) => source.state === "not_requested").length,
      truncatedSources,
      notes: sourceStates
        .filter((source) => source.state === "unavailable" || source.state === "partial" || source.truncated)
        .map((source) => `${source.id}:${source.errorCode || (source.truncated ? "SOURCE_ROW_LIMIT_REACHED" : "SOURCE_PARTIAL")}`),
    },
    sourceStates,
    asOf: input.asOf,
    window: input.window,
  };
}
