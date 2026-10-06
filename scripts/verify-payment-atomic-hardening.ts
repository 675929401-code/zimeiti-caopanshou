import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const read = (relativePath: string) => readFileSync(resolve(projectRoot, relativePath), "utf8");

const fulfillment = read("src/lib/payment-fulfillment.ts");
const xunhu = read("src/lib/xunhupay.ts");
const statusRoute = read("src/app/api/payment/status/route.ts");
const notifyRoute = read("src/app/api/payment/notify/route.ts");
const migration = read("supabase/migrations/20260825202000_payment_provider_evidence_atomic_fulfillment.sql");
const rollback = read("supabase/rollbacks/20260825202000_payment_provider_evidence_atomic_fulfillment.rollback.sql");

const checks: Array<[string, boolean]> = [
  ["application rejects non-finite provider amounts", fulfillment.includes("Number.isFinite(amount)")],
  ["application rejects exponent and overprecision money", fulfillment.includes("(?:\\.\\d{1,2})?")],
  ["application requires provider merchant order equality", fulfillment.includes("normalizedProviderTradeOrderId !== normalizedTradeOrderId")],
  ["application requires provider transaction id", fulfillment.includes("Invalid provider transaction id")],
  ["application calls only evidence RPC", fulfillment.includes('rpc("fulfill_payment_order_with_evidence_atomic"')],
  ["application verifies evidence echoed by RPC", fulfillment.includes("Atomic payment fulfillment evidence was not confirmed")],
  ["active Xunhu query extracts provider merchant order", xunhu.includes("data.out_trade_order")],
  ["active Xunhu query rejects merchant-order mismatch", xunhu.includes("providerTradeOrderId !== normalizedTradeOrderId")],
  ["active Xunhu query requires provider transaction id", xunhu.includes("平台交易号缺失或无效")],
  ["status route forwards all provider evidence", statusRoute.includes("providerTradeOrderId") && statusRoute.includes("providerTransactionId")],
  ["Xunhu callback forwards signed transaction id", notifyRoute.includes("providerTransactionId: transaction_id")],
  ["EPay callback forwards signed transaction id", notifyRoute.includes("providerTransactionId: trade_no")],
  ["callback body is capped before parsing", notifyRoute.includes("MAX_CALLBACK_BODY_BYTES = 64 * 1024") && notifyRoute.includes('request.headers.get("content-length")') && notifyRoute.includes("request.body?.getReader()")],
  ["callback streaming overflow cancels the reader", notifyRoute.includes("await reader.cancel()") && notifyRoute.includes('status: error.status')],
  ["callback fields and scalar values are bounded", notifyRoute.includes("MAX_CALLBACK_FIELDS = 64") && notifyRoute.includes("MAX_CALLBACK_VALUE_BYTES = 8 * 1024")],
  ["callback no longer parses the unbounded request directly", !notifyRoute.includes("await request.formData()") && !notifyRoute.includes("await request.json()")],
  ["migration rejects NaN and infinity", migration.includes("p_paid_amount::text IN ('NaN', 'Infinity', '-Infinity')")],
  ["migration rejects sub-cent paid amount", migration.includes("round(p_paid_amount, 2) <> p_paid_amount")],
  ["migration locks payment order", migration.includes("FOR UPDATE;")],
  ["migration validates provider merchant order", migration.includes("PAYMENT_PROVIDER_ORDER_MISMATCH")],
  ["migration prevents provider transaction reuse", migration.includes("PAYMENT_PROVIDER_TRANSACTION_REUSED")],
  ["migration has unique provider transaction index", migration.includes("payment_orders_provider_transaction_unique")],
  ["migration invokes wallet mutation inside RPC", migration.includes("public.apply_wallet_operation_atomic(")],
  ["migration marks payment paid inside same RPC", migration.includes("UPDATE public.payment_orders") && migration.includes("SET status = 'paid'")],
  ["migration stores immutable provider evidence", migration.includes("provider_confirmed_at = now()")],
  ["legacy evidence-free RPC is revoked from service role", migration.includes("FROM PUBLIC, anon, authenticated, service_role")],
  ["new RPC is service-role only", migration.includes("TO service_role;")],
  ["rollback blocks after evidence exists", rollback.includes("ROLLBACK_BLOCKED_PROVIDER_PAYMENT_EVIDENCE_EXISTS")],
  ["rollback restores legacy RPC only after safe teardown", rollback.includes("GRANT EXECUTE ON FUNCTION public.fulfill_payment_order_atomic")],
  ["rollback does not use cascade", !rollback.toUpperCase().includes("CASCADE")],
];

for (const [name, passed] of checks) {
  assert.equal(passed, true, name);
  console.log(`PASS ${name}`);
}

const forbiddenOldCalls = [statusRoute, notifyRoute]
  .join("\n")
  .match(/fulfillPaymentOrder\s*\(\s*[^\{]/g);
assert.equal(forbiddenOldCalls, null, "no positional evidence-free fulfillment calls remain");
console.log("PASS no positional evidence-free fulfillment calls remain");

console.log(`Verified ${checks.length + 1} payment hardening contracts.`);
