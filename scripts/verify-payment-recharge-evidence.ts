import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluatePaidOrderSettlement } from "../src/lib/payment-settlement-status";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const dialog = read("src/components/recharge-dialog.tsx");
const status = read("src/app/api/payment/status/route.ts");
const resultPage = read("src/app/payment/result/page.tsx");
const settlement = read("src/lib/payment-settlement-status.ts");

const manualStart = dialog.indexOf("const handleManualCheck = async () =>");
const manualEnd = dialog.indexOf("// 返回充值表单", manualStart);
assert.ok(manualStart >= 0 && manualEnd > manualStart, "manual payment check block exists");
const manual = dialog.slice(manualStart, manualEnd);

assert.ok(dialog.includes("const createInFlightRef = useRef(false)"), "checkout has a synchronous double-click lock");
assert.ok(dialog.includes("if (createInFlightRef.current) return"), "duplicate create attempts are blocked before fetch");
assert.ok(dialog.includes("createInFlightRef.current = true") && dialog.includes("createInFlightRef.current = false"), "checkout lock is acquired and released");
assert.ok(dialog.includes("reportPaymentCallbackMissing(tradeOrderId, type)"), "polling diagnostics bind to the polled order");

assert.ok(manual.includes('data.order?.status === "paid" && data.order?.balance_credited === true'), "manual confirmation requires paid plus credited evidence");
assert.ok(!manual.includes("/api/credits?user_id="), "manual confirmation never infers payment from a wallet snapshot");
assert.ok(!manual.includes("newCredits > oldCredits") && !manual.includes("newCash > oldCash"), "unrelated balance increases cannot mark an order paid");
assert.ok(manual.includes("startPolling(qrcodeData.tradeOrderId, qrcodeData.payType)"), "pending manual checks resume order polling");

assert.ok(status.includes("payment_provider"), "status query reads the order provider");
assert.ok(status.includes("normalizedProvider === 'xunhupay'"), "active Xunhu reconciliation is provider scoped");
assert.ok(status.includes("providerReconciliationAttempted"), "expiry logic records whether provider reconciliation ran");
assert.ok(status.includes("providerReconciliationConclusive"), "an unavailable Xunhu query cannot become unpaid evidence");
assert.ok(status.includes("providerAllowsExpiry"), "Xunhu expiry requires a conclusive provider result");
assert.ok(status.indexOf("queryPaymentPlatformThrottled") < status.indexOf("status: 'expired'"), "provider reconciliation precedes local expiry");
assert.ok(!status.includes("cleanExpiredUserOrders"), "one status lookup never expires unrelated provider orders without their own reconciliation");
assert.equal((status.match(/\.update\(\{ status: 'expired' \}\)/gu) || []).length, 1, "expiry mutation exists only for the current order");
assert.ok(status.includes("evaluatePaidOrderSettlement"), "paid status is evaluated against provider, wallet and ledger evidence");
assert.ok(status.includes('publicStatus = "reconciliation_required"'), "unproven paid markers are not exposed as success");
assert.ok(status.includes("recorded_status: order.status"), "raw order marker remains available without masquerading as settlement");
assert.ok(status.includes("balance_credited: balanceCredited"), "status response exposes explicit credit evidence");
assert.ok(!status.includes("...order,"), "provider transaction evidence is not spread into the user response");
assert.ok(dialog.includes('data.order?.status === "paid" && data.order?.balance_credited === true'), "checkout success requires credited evidence");
assert.ok(dialog.includes('setPollingStatus("reconciliation")'), "checkout shows a dedicated reconciliation state");
assert.ok(resultPage.includes('order?.status === "paid" && order?.balance_credited === true'), "result page success requires credited evidence");
assert.ok(resultPage.includes("到账核对中") && resultPage.includes("请勿重复支付"), "result page honestly explains incomplete settlement");
assert.ok(settlement.includes("PROVIDER_CONFIRMATION_INCOMPLETE"), "provider evidence is mandatory");
assert.ok(settlement.includes("COMPLETED_WALLET_OPERATION_MISSING"), "completed wallet operation is mandatory");
assert.ok(settlement.includes("MATCHING_WALLET_LEDGER_MISSING"), "matching immutable ledger entry is mandatory");

const paidOrder = {
  trade_order_id: "PAY_SETTLEMENT_FIXTURE",
  user_id: "fixture-user",
  type: "cash",
  amount: 10,
  payment_provider: "xunhupay",
  provider_trade_order_id: "PAY_SETTLEMENT_FIXTURE",
  provider_transaction_id: "provider-transaction-fixture",
  provider_paid_amount: 10,
  provider_confirmed_at: "2026-10-04T00:00:00.000Z",
};
const walletOperation = {
  id: "wallet-operation-fixture",
  user_id: "fixture-user",
  status: "completed",
  operation_kind: "cash_topup",
  idempotency_key: "payment:PAY_SETTLEMENT_FIXTURE",
  amount: 10,
  balance_before: 5,
  balance_after: 15,
};
const ledgerEntry = {
  operation_id: "wallet-operation-fixture",
  user_id: "fixture-user",
  operation_kind: "cash_topup",
  idempotency_key: "payment:PAY_SETTLEMENT_FIXTURE",
  delta: 10,
  balance_before: 5,
  balance_after: 15,
};
assert.deepEqual(
  evaluatePaidOrderSettlement({ order: paidOrder, walletOperations: [walletOperation], ledgerEntries: [ledgerEntry] }),
  { status: "credited", balanceCredited: true, issueCodes: [] },
  "exact provider, wallet and ledger evidence proves credit",
);
assert.equal(
  evaluatePaidOrderSettlement({ order: { ...paidOrder, provider_transaction_id: null }, walletOperations: [walletOperation], ledgerEntries: [ledgerEntry] }).status,
  "reconciliation_required",
  "missing provider evidence cannot display credited",
);
assert.equal(
  evaluatePaidOrderSettlement({ order: paidOrder, walletOperations: [], ledgerEntries: [] }).status,
  "reconciliation_required",
  "legacy paid marker without wallet evidence cannot display credited",
);
assert.equal(
  evaluatePaidOrderSettlement({ order: paidOrder, walletOperations: [walletOperation], ledgerEntries: [] }).status,
  "reconciliation_required",
  "wallet operation without immutable ledger cannot display credited",
);

console.log("Payment recharge evidence contract: 33/33 checks passed; network/provider/database calls: 0.");
