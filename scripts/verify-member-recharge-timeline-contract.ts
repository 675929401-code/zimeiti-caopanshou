import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  availableRechargeSource,
  buildRechargeReadModel,
  normalizeRechargeChannel,
  unavailableRechargeSource,
  type RechargeDatabaseRow,
  type RechargeSourceId,
  type RechargeSourceResult,
} from "@/lib/server/admin-recharge-read-model";

const asOf = "2026-10-03T00:00:00.000Z";
const window = { startAt: null, endBefore: null, timezone: "Asia/Shanghai" as const };

function available(id: RechargeSourceId, rows: RechargeDatabaseRow[]): RechargeSourceResult {
  return availableRechargeSource(id, rows, { asOf });
}

function order(index: number, overrides: RechargeDatabaseRow = {}): RechargeDatabaseRow {
  const paid = index <= 7;
  const refunded = index === 4;
  const timestamp = new Date(Date.parse("2026-10-02T12:00:00.000Z") - index * 60_000).toISOString();
  return {
    id: `order-row-${index}`,
    user_id: index === 5 ? "deleted-user" : "user-1",
    trade_order_id: `order-${index}`,
    type: index % 2 === 0 ? "cash" : "credits",
    amount: index * 10,
    credits_amount: index % 2 === 0 ? null : index * 100,
    status: refunded ? "refunded" : paid ? "paid" : "expired",
    payment_method: index % 2 === 0 ? "Alipay" : "Wechat",
    payment_provider: "XUNHUPAY",
    provider_paid_amount: paid ? index * 10 : null,
    provider_trade_order_id: paid ? `order-${index}` : null,
    provider_transaction_id: paid ? `provider-${index}` : null,
    provider_confirmed_at: paid && index !== 3 ? timestamp : null,
    paid_at: paid ? timestamp : null,
    refunded_at: refunded ? timestamp : null,
    created_at: timestamp,
    ...overrides,
  };
}

const paymentOrders = Array.from({ length: 44 }, (_, index) => order(index + 1));
const walletOperations = Array.from({ length: 6 }, (_, index) => {
  const orderIndex = index + 1;
  const cash = orderIndex % 2 === 0;
  return {
    id: String(orderIndex),
    user_id: orderIndex === 5 ? "deleted-user" : "user-1",
    wallet: cash ? "cash" : "credits",
    operation_kind: cash ? "cash_topup" : "credit_topup",
    idempotency_key: `payment:order-${orderIndex}`,
    amount: cash ? orderIndex * 10 : orderIndex * 100,
    delta: cash ? orderIndex * 10 : orderIndex * 100,
    status: "completed",
    balance_before: 0,
    balance_after: cash ? orderIndex * 10 : orderIndex * 100,
    description: "支付到账",
    metadata: { source: "payment", trade_order_id: `order-${orderIndex}` },
    legacy_transaction_id: `legacy-${orderIndex}`,
    created_at: paymentOrders[orderIndex - 1].created_at,
    completed_at: paymentOrders[orderIndex - 1].paid_at,
  } satisfies RechargeDatabaseRow;
});

const creditTransactions: RechargeDatabaseRow[] = walletOperations
  .filter((row) => row.wallet === "credits")
  .map((row) => ({
    id: row.legacy_transaction_id,
    user_id: row.user_id,
    amount: row.delta,
    type: "recharge",
    transaction_type: "recharge",
    balance_after: row.balance_after,
    description: "历史镜像",
    metadata: { wallet_operation_id: row.id, idempotency_key: row.idempotency_key },
    created_at: row.created_at,
  }));
creditTransactions.push({
  id: "legacy-unmatched",
  user_id: "deleted-user",
  amount: 25,
  type: "recharge",
  transaction_type: "recharge",
  balance_after: 25,
  description: "统一钱包接入前充值",
  metadata: {},
  created_at: "2026-09-01T00:00:00.000Z",
});

const cashTransactions: RechargeDatabaseRow[] = walletOperations
  .filter((row) => row.wallet === "cash")
  .map((row) => ({
    id: row.legacy_transaction_id,
    user_id: row.user_id,
    amount: row.delta,
    type: "topup",
    balance_after: row.balance_after,
    description: "历史镜像",
    reference_id: row.idempotency_key,
    metadata: { wallet_operation_id: row.id },
    created_at: row.created_at,
  }));

const baseSources: Record<RechargeSourceId, RechargeSourceResult> = {
  payment_orders: available("payment_orders", paymentOrders),
  wallet_operations: available("wallet_operations", walletOperations),
  credit_transactions: available("credit_transactions", creditTransactions),
  cash_transactions: available("cash_transactions", cashTransactions),
  payment_refund_attempts: available("payment_refund_attempts", [{
    attempt_id: "refund-4",
    trade_order_id: "order-4",
    user_id: "user-1",
    state: "completed",
    order_type: "cash",
    payment_provider: "xunhupay",
    paid_amount: 40,
    wallet_amount: 40,
    reason: "管理员退款",
    provider_refund_id: "provider-refund-4",
    provider_refund_amount: 40,
    created_at: "2026-10-02T12:30:00.000Z",
    updated_at: "2026-10-02T12:31:00.000Z",
    completed_at: "2026-10-02T12:31:00.000Z",
  }]),
  offline_payment_receipts: available("offline_payment_receipts", [
    { id: "offline-1", user_id: "user-1", payment_channel: "微信转账", business_type: "membership_tuition", amount: 60, status: "confirmed", paid_at: "2026-10-02T10:00:00.000Z", created_at: "2026-10-02T10:01:00.000Z" },
    { id: "offline-void", user_id: "user-1", payment_channel: "cash", business_type: "membership_tuition", amount: 999, status: "voided", paid_at: "2026-10-01T10:00:00.000Z", voided_at: "2026-10-02T09:00:00.000Z", created_at: "2026-10-01T10:01:00.000Z" },
  ]),
  member_activation_events: available("member_activation_events", [{ id: "activation-1", user_id: "user-1", member_status: "active", activation_method: "admin_manual", activation_fee: 60, created_at: "2026-10-02T10:02:00.000Z" }]),
  member_package_assignments: available("member_package_assignments", [{ id: "package-1", user_id: "user-1", package_name: "正式会员", membership_status: "active", credits: 100, cash_amount: 0, created_at: "2026-10-02T10:03:00.000Z" }]),
  users: available("users", [{ id: "user-1", display_name: "当前会员", username: "member", phone: "13800000000", member_status: "active" }]),
};

function build(sources = baseSources, timelineLimit = 200) {
  return buildRechargeReadModel({ sources, asOf, window, timelineLimit });
}

const model = build();
assert.equal(model.summary.paidOrderScopeCount, 7, "paid/refunded 核对范围必须只含 7 笔，不得把 37 笔 expired 算入");
assert.equal(model.summary.paidWithoutWalletCreditCount, 1, "7 笔已支付范围内只有 order-7 缺少 completed 钱包入账");
assert.equal(model.summary.unmatchedOrderCount, 1, "旧字段 unmatchedOrderCount 也必须收窄到 7 笔 paid/refunded，37 笔 expired 不能算异常");
assert.equal(model.summary.providerConfirmationMissingCount, 1, "paid 订单缺渠道确认必须单独计数");
assert.equal(model.summary.revenue.expiredOrdersIncluded, false, "expired 永远不能计入收入");
assert.equal(model.summary.revenue.onlineProviderConfirmedAmount, 250, "线上确认收入只累计 6 笔具有 provider_confirmed_at 的订单");
assert.equal(model.summary.revenue.offlineConfirmedAmount, 60, "线下收入只累计 confirmed，voided 不计收入");
assert.equal(model.summary.revenue.completedRefundAmount, 40, "只扣除 completed 退款");
assert.equal(model.summary.revenue.netConfirmedAmount, null, "仍有 paid 缺渠道确认时净确认收入必须 unavailable，而不是不完整数字");
assert.equal(model.summary.legacyUnmatchedTopupCount, 1, "统一钱包镜像必须去重，只保留一条真正未匹配历史充值");

const linkedWallet = model.timeline.events.find((event) => event.id === "wallet-operation:1");
assert(linkedWallet, "统一钱包事件缺失");
assert.deepEqual(linkedWallet.sourceIds, ["credit_transactions", "wallet_operations"], "统一钱包与 legacy 镜像必须合并证据来源");
assert.equal(model.timeline.events.filter((event) => event.kind === "legacy_credit").length, 1, "legacy 镜像不得重复形成时间线事件");

const missingProviderEvent = model.timeline.events.find((event) => event.id === "payment-order:order-3");
assert(missingProviderEvent, "缺渠道确认订单缺失");
assert.deepEqual(missingProviderEvent.providerConfirmation, { state: "unavailable", confirmedAt: null, transactionId: "provider-3" });
assert.equal(missingProviderEvent.includedInRevenue, null, "缺渠道确认不得推断为收入");

const expiredEvent = model.timeline.events.find((event) => event.id === "payment-order:order-8");
assert(expiredEvent, "expired 订单仍应保留为历史事件");
assert.equal(expiredEvent.includedInRevenue, false);
assert.equal(expiredEvent.revenueEffect, 0);
assert.equal(paymentOrders.filter((row) => row.status === "expired").length, 37, "夹具必须保持 37 笔 expired 边界");

const deletedAccountEvent = model.timeline.events.find((event) => event.user.id === "deleted-user");
assert(deletedAccountEvent, "已删除账号关联的账务事实不得被用户表 join 丢弃");
assert.equal(deletedAccountEvent.user.displayName, "已删除账号");
assert.equal(deletedAccountEvent.user.identityState, "historical_or_deleted");

assert.deepEqual(normalizeRechargeChannel("XUNHU_PAY", "Wechat"), {
  provider: "xunhupay",
  providerLabel: "迅虎支付",
  method: "wechat",
  methodLabel: "微信",
  rawProvider: "XUNHU_PAY",
  rawMethod: "Wechat",
});
assert.equal(normalizeRechargeChannel("xunhupay", "Alipay").method, "alipay", "支付方式大小写必须归一");

const bounded = build(baseSources, 5);
assert.equal(bounded.timeline.events.length, 5, "时间线响应必须受 limit 约束");
assert.equal(bounded.timeline.limit, 5);
assert.equal(bounded.timeline.truncated, true);
assert(bounded.timeline.totalCount > bounded.timeline.events.length);

const reversedSources = Object.fromEntries(Object.entries(baseSources).map(([id, source]) => [id, { ...source, rows: source.rows ? [...source.rows].reverse() : null }])) as Record<RechargeSourceId, RechargeSourceResult>;
assert.deepEqual(build(reversedSources).timeline.events.map((event) => event.id), model.timeline.events.map((event) => event.id), "输入顺序变化不得改变去重和时间线顺序");

const missingTableSources: Record<RechargeSourceId, RechargeSourceResult> = {
  ...baseSources,
  offline_payment_receipts: unavailableRechargeSource("offline_payment_receipts", "SOURCE_TABLE_UNAVAILABLE"),
  member_activation_events: unavailableRechargeSource("member_activation_events", "SOURCE_TABLE_UNAVAILABLE"),
  member_package_assignments: unavailableRechargeSource("member_package_assignments", "SOURCE_TABLE_UNAVAILABLE"),
};
const missingTableModel = build(missingTableSources);
assert.equal(missingTableModel.summary.offlineConfirmedCount, null, "缺表不能显示 0 条线下收款");
assert.equal(missingTableModel.summary.offlineConfirmedAmount, null, "缺表不能显示 0 元线下收款");
assert.equal(missingTableModel.summary.revenue.grossConfirmedAmount, null, "收入依赖来源缺失时必须 unavailable");
assert.equal(missingTableModel.dataQuality.status, "partial");
assert.equal(missingTableModel.sourceStates.find((source) => source.id === "offline_payment_receipts")?.state, "unavailable");

const truncatedSources: Record<RechargeSourceId, RechargeSourceResult> = {
  ...baseSources,
  payment_orders: availableRechargeSource("payment_orders", paymentOrders, {
    asOf,
    truncated: true,
    partial: true,
    errorCode: "SOURCE_ROW_LIMIT_REACHED",
  }),
};
const truncatedModel = build(truncatedSources);
assert.equal(truncatedModel.dataQuality.status, "partial", "有界读取触发上限时整体质量必须是 partial");
assert.equal(truncatedModel.dataQuality.truncatedSources, 1, "读取上限必须进入 truncatedSources");
assert.equal(truncatedModel.sourceStates.find((source) => source.id === "payment_orders")?.state, "partial");
assert.equal(truncatedModel.summary.paidOrderScopeCount, null, "有界样本不得冒充全量 paid 订单数");
assert.equal(truncatedModel.summary.unmatchedOrderCount, null, "有界样本不得冒充全量未入账异常数");

assert(Array.isArray(model.rows), "必须保留旧消费者 rows 数组");
assert.equal(typeof model.summary.recordCount, "number", "必须保留旧 summary.recordCount");
assert.equal(model.rows.some((row) => row.normalizedPaymentMethod === "wechat"), true, "旧 rows 增量返回渠道标准值");

const root = process.cwd();
const routeSource = readFileSync(resolve(root, "src/app/api/admin/reconciliation/recharges/route.ts"), "utf8");
const componentSource = readFileSync(resolve(root, "src/components/admin/recharge-timeline-panel.tsx"), "utf8");
const componentCss = readFileSync(resolve(root, "src/components/admin/recharge-timeline-panel.module.css"), "utf8");
for (const table of ["payment_orders", "wallet_operations", "credit_transactions", "cash_transactions", "payment_refund_attempts", "offline_payment_receipts", "member_activation_events", "member_package_assignments"]) {
  assert(routeSource.includes(`\"${table}\"`), `API 缺少只读来源 ${table}`);
}
const databaseSurface = routeSource
  .replaceAll("summaryCache.delete", "summaryCache.evict")
  .replaceAll("summaryInflight.delete", "summaryInflight.evict");
assert.doesNotMatch(databaseSurface, /\.(?:insert|update|upsert|delete|rpc)\s*\(/u, "充值时间线 API 必须保持只读");
assert(routeSource.includes("timeline") && routeSource.includes("dataQuality") && routeSource.includes("sourceStates") && routeSource.includes("asOf") && routeSource.includes("window"), "API 增量响应字段不完整");
assert(routeSource.includes('authorizeAdminCapability(request, format === "csv" ? "billing.export" : "billing.view"'), "资金读取必须经过 billing.view，CSV 必须经过 billing.export");
assert(routeSource.includes('requireStepUp: format === "csv"'), "CSV 导出必须保留更高权限与 step-up 门禁");
assert(!routeSource.includes("verifyAdminToken") && !routeSource.includes("getTokenFromHeaders"), "充值 API 不得回退到仅校验 admin 角色");
const summaryBudget = Number(routeSource.match(/SUMMARY_MAX_ROWS_PER_SOURCE\s*=\s*([0-9_]+)/u)?.[1].replaceAll("_", ""));
const fullBudget = Number(routeSource.match(/FULL_MAX_ROWS_PER_SOURCE\s*=\s*([0-9_]+)/u)?.[1].replaceAll("_", ""));
assert(Number.isFinite(summaryBudget) && Number.isFinite(fullBudget) && summaryBudget > 0 && summaryBudget <= 2_000 && summaryBudget < fullBudget, "summaryOnly 每源行上限必须明显低于完整对账路径");
assert(routeSource.includes("SOURCE_ROW_LIMIT_REACHED") && routeSource.includes("partial: true") && routeSource.includes("truncated: true"), "摘要触发行上限后必须显式 partial/truncated");
assert(routeSource.includes("SUMMARY_CACHE_TTL_MS = 60_000") && routeSource.includes("summaryCache") && routeSource.includes("summaryInflight"), "summaryOnly 必须有 60 秒进程缓存与单飞");
assert(routeSource.includes('status: 429') && routeSource.includes('"Retry-After"'), "手动刷新冷却必须返回 429 和 Retry-After");
for (const field of ["freshness", "nextRefreshAt", "cacheStatus", "rateLimit", "readBudget"]) {
  assert(routeSource.includes(field), `summaryOnly 缺少低成本元数据 ${field}`);
}
assert(componentSource.includes('endpoint = "/api/admin/reconciliation/recharges"'), "组件必须只消费统一充值事实 API");
assert(componentSource.includes("暂不可用") && componentSource.includes("渠道确认不可用"), "组件缺少 unavailable 展示语义");
assert(componentSource.includes("recharge-timeline-panel.module.css"), "组件必须使用私有 CSS module");
assert.match(componentSource, /variant\?:\s*"default"\s*\|\s*"command_center"/u, "组件必须暴露可选 command_center 视觉变体");
assert.match(componentSource, /data-variant=\{variant\}/u, "组件根节点必须标记局部变体");
assert.match(componentSource, /token\?:\s*string\s*\|\s*null/u, "组件必须允许宿主显式传入管理员 token");
assert(componentSource.includes('token === undefined ? localStorage.getItem("auth_token") : token'), "显式 token 必须优先，只有未传时才兼容 localStorage");
assert(componentSource.includes("useState(180)") && componentSource.includes('{ value: 180, label: "近 180 天" }'), "默认时间窗必须是可解释的近 180 天");
assert(componentSource.includes('url.searchParams.set("refresh", "1")') && componentSource.includes("response.status === 429"), "Panel 必须尊重手动刷新冷却和 429");
assert(componentSource.includes('document.addEventListener("visibilitychange"') && componentSource.includes('window.addEventListener("online"') && componentSource.includes('window.addEventListener("offline"'), "Panel 必须监听页面可见性与网络恢复");
assert(componentSource.includes("document.hidden") && componentSource.includes("navigator.onLine") && componentSource.includes("requestAbortRef.current?.abort()"), "Panel 在后台或离线时必须阻止读取并中止在途请求");
assert(componentSource.includes("resumeNeedsRead") && componentSource.includes("!hasCurrentSnapshot || (autoRefresh && nextRefreshAtMs <= Date.now())"), "Panel 恢复后只能在无当前快照或自动刷新已开启且快照过期时重读");
assert(componentSource.includes("页面位于后台") && componentSource.includes("浏览器当前离线") && componentSource.includes('className={styles.pause}'), "Panel 必须显示明确的暂停原因");
assert.match(componentSource, /autoRefresh\?:\s*boolean/u, "Panel 必须暴露可选自动刷新开关");
assert(componentSource.includes("autoRefresh = false"), "Panel 自动刷新必须默认关闭，避免其他挂载意外增负");
assert(componentSource.includes("window.setTimeout") && componentSource.includes("void load(false)") && !componentSource.includes("setInterval"), "自动刷新必须按 nextRefreshAt 使用一次性定时器，不得轮询或重叠");
assert(componentSource.includes('response.headers.get("Retry-After")') && componentSource.includes("requestAbortRef.current) return"), "Panel 失败重试必须遵守 Retry-After 并拒绝重叠请求");
assert(!componentCss.includes(":global"), "充值组件 CSS 不得扩散到全局作用域");
assert(componentCss.includes('.panel[data-variant="command_center"]'), "私有 CSS 必须为深空指挥中心提供局部配色");
assert.doesNotMatch(componentCss, /(?:background|color):\s*var\(--(?:card|foreground|background|primary|muted|muted-foreground)\)/u, "实际样式必须通过组件局部变量，不得直接绑定全局主题变量");
const visibleFontSizes = [...componentCss.matchAll(/font-size:\s*([0-9.]+)px/gu)].map((match) => Number(match[1]));
assert(visibleFontSizes.length > 0 && visibleFontSizes.every((size) => size >= 12), "组件所有明示像素字号必须至少 12px");

console.log("MEMBER-RECHARGE-TIMELINE contract: 44 orders / 7 paid-scope, expired anomaly exclusion, deterministic dedupe, unavailable + bounded partial semantics, billing capability gate, 60s cache/single-flight/rate-limit, 180-day panel and private visual variants passed; database writes: 0.");
