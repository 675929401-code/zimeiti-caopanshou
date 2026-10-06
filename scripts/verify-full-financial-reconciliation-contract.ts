import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  FINANCIAL_RECONCILIATION_STAGES,
  evaluateLargeBalanceDelta,
  evaluateNegativeBalance,
  evaluatePaymentOrder,
  evaluateRefundAttempt,
  type FinancialRow,
} from "../src/lib/financial-reconciliation-contract";

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

assert.deepEqual(
  FINANCIAL_RECONCILIATION_STAGES.map((stage) => stage.id),
  ["negative_balances", "payment_integrity", "refund_finality", "large_balance_movements"],
  "全量资金扫描必须覆盖四个独立阶段",
);

assert.equal(evaluateNegativeBalance({ id: "u-ok", credits: 0, cash_balance: 0 }).length, 0);
assert.equal(evaluateNegativeBalance({ id: "u-negative", credits: -1, cash_balance: 0 })[0]?.type, "negative_balance");

const paidOrder: FinancialRow = {
  id: "order-row-1",
  user_id: "u-1",
  trade_order_id: "trade-1",
  type: "credits",
  amount: 10,
  credits_amount: 100,
  status: "paid",
  payment_provider: "xunhupay",
  provider_trade_order_id: "trade-1",
  provider_transaction_id: "provider-1",
  provider_paid_amount: 10,
  provider_confirmed_at: "2026-10-01T00:00:00.000Z",
};
const validTopup = new Map<string, FinancialRow>([["payment:trade-1", {
  id: "op-1",
  status: "completed",
  operation_kind: "credit_topup",
  idempotency_key: "payment:trade-1",
  amount: 100,
  balance_before: 0,
  balance_after: 100,
}]]);
assert.deepEqual(
  evaluatePaymentOrder(paidOrder, validTopup, { providerEvidenceAvailable: true, walletEvidenceAvailable: true }),
  [],
  "完整的支付、渠道和钱包证据不应误报",
);
const missingWalletIssues = evaluatePaymentOrder(paidOrder, new Map(), {
  providerEvidenceAvailable: true,
  walletEvidenceAvailable: true,
});
assert.ok(missingWalletIssues.some((item) => item.type === "paid_order_wallet_mismatch" && item.severity === "critical"));
const missingProviderIssues = evaluatePaymentOrder({ ...paidOrder, provider_confirmed_at: null }, validTopup, {
  providerEvidenceAvailable: true,
  walletEvidenceAvailable: true,
});
assert.ok(missingProviderIssues.some((item) => item.type === "provider_confirmation_incomplete"));
assert.ok(
  !evaluatePaymentOrder(paidOrder, new Map(), { providerEvidenceAvailable: true, walletEvidenceAvailable: false })
    .some((item) => item.type === "paid_order_wallet_mismatch"),
  "钱包来源不可用时必须标来源缺口，不能伪造订单未到账问题",
);

const completedRefund: FinancialRow = {
  attempt_id: "refund-1",
  trade_order_id: "trade-1",
  user_id: "u-1",
  state: "completed",
  order_type: "credits",
  paid_amount: 10,
  wallet_amount: 100,
  wallet_operation_id: "reserve-1",
  provider_refund_id: "provider-refund-1",
  provider_refund_amount: 10,
  provider_status: "CD",
  completed_at: "2026-10-01T01:00:00.000Z",
};
const refundedOrder = new Map<string, FinancialRow>([["trade-1", {
  trade_order_id: "trade-1",
  status: "refunded",
  amount: 10,
  refund_attempt_id: "refund-1",
  provider_refund_id: "provider-refund-1",
  provider_refund_amount: 10,
  provider_refund_status: "CD",
  refunded_at: "2026-10-01T01:00:00.000Z",
}]]);
const reserveOperations = new Map<string, FinancialRow>([["reserve-1", {
  id: "reserve-1",
  status: "completed",
  operation_kind: "credit_charge",
  amount: 100,
}]]);
assert.deepEqual(evaluateRefundAttempt(completedRefund, refundedOrder, reserveOperations, {
  orderEvidenceAvailable: true,
  walletEvidenceAvailable: true,
  snapshotAt: "2026-10-02T00:00:00.000Z",
}), [], "完成退款的订单、渠道与钱包证据全部匹配时不应误报");
assert.ok(evaluateRefundAttempt({
  ...completedRefund,
  state: "reconciliation_required",
}, refundedOrder, reserveOperations, {
  orderEvidenceAvailable: true,
  walletEvidenceAvailable: true,
  snapshotAt: "2026-10-02T00:00:00.000Z",
}).some((item) => item.type === "refund_reconciliation_required" && item.severity === "critical"));
assert.ok(evaluateRefundAttempt({
  ...completedRefund,
  state: "released",
  release_operation_id: null,
  provider_status: "UD",
  released_at: "2026-10-01T01:00:00.000Z",
}, new Map([["trade-1", { trade_order_id: "trade-1", status: "paid" }]]), reserveOperations, {
  orderEvidenceAvailable: true,
  walletEvidenceAvailable: true,
  snapshotAt: "2026-10-02T00:00:00.000Z",
}).some((item) => item.type === "refund_wallet_release_mismatch"));

assert.equal(evaluateLargeBalanceDelta({ id: 1, field: "credits", delta: 10_000 }).length, 0);
assert.equal(evaluateLargeBalanceDelta({ id: 2, field: "credits", delta: 10_001 })[0]?.type, "large_balance_delta");
assert.equal(evaluateLargeBalanceDelta({ id: 3, field: "cash_balance", delta: -101 })[0]?.severity, "warning");

const route = read("src/app/api/admin/consistency-check/route.ts");
const server = read("src/lib/server/full-financial-reconciliation.ts");
const panel = read("src/components/billing-audit-panel.tsx");

assert.match(route, /authorizeAdminCapability\(request, "billing\.view"/u);
assert.match(route, /private, no-store/u);
assert.match(route, /status: 429/u);
assert.match(route, /"Retry-After"/u);
assert.match(route, /FINANCIAL_RECONCILIATION_READ_ONLY/u);
assert.doesNotMatch(route, /verifyAdminToken|getTokenFromHeaders/u);

assert.match(server, /createHmac\("sha256"/u);
assert.match(server, /timingSafeEqual/u);
assert.match(server, /created_at_lte_snapshot/u);
assert.match(server, /\.limit\(state\.pageSize \+ 1\)/u);
assert.match(server, /FINANCIAL_RECONCILIATION_MIN_REQUEST_INTERVAL_MS/u);
assert.match(server, /payment_refund_attempts/u);
assert.match(server, /wallet_operations/u);
assert.doesNotMatch(server, /\.limit\((?:50|100)\)/u, "不得把固定样本上限伪装成全量扫描");
assert.doesNotMatch(server, /\.from\([^)]*\)[\s\S]{0,240}\.(?:insert|update|delete|upsert)\(/u, "全量对账服务必须保持只读");

for (const marker of [
  "开始全量扫描",
  "暂停扫描",
  "继续检查点",
  "sessionStorage",
  "visibilitychange",
  "navigator.onLine",
  "AbortController",
  "全量范围通过",
  "全量扫描完成，发现",
  "coverage.complete",
  "sourceGaps",
  "motion-reduce:transition-none",
]) {
  assert.ok(panel.includes(marker), `资金对账 UI 缺少 ${marker}`);
}
assert.doesNotMatch(panel, /text-\[(?:[0-9]|1[01])px\]/u, "资金审计面板可见字号不得低于 12px");

console.log(JSON.stringify({
  ok: true,
  stages: FINANCIAL_RECONCILIATION_STAGES.length,
  readOnly: true,
  providerCalls: 0,
  writes: 0,
}, null, 2));
