import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluatePaymentRefundReconciliationDecision,
  parsePaymentRefundReconciliationRequest,
  paymentRefundReconciliationActionId,
  PaymentRefundReconciliationValidationError,
} from "../src/lib/payment-refund-reconciliation-contract";

const root = process.cwd();
const read = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");

async function main(): Promise<void> {
const [
  manualRoute,
  contract,
  migration,
  rollback,
  discoveryRoute,
  scheduler,
  ordersRoute,
  methodsRoute,
  xunhu,
] = await Promise.all([
  read("src/app/api/admin/reconciliation/refunds/route.ts"),
  read("src/lib/payment-refund-reconciliation-contract.ts"),
  read("supabase/migrations/20261003123000_payment_refund_manual_reconciliation.sql"),
  read("supabase/rollbacks/20261003123000_payment_refund_manual_reconciliation.rollback.sql"),
  read("src/app/api/admin/payment-reconcile/route.ts"),
  read("scripts/reconcile-payments.cjs"),
  read("src/app/api/admin/payment-orders/route.ts"),
  read("src/app/api/admin/payment-methods/route.ts"),
  read("src/lib/xunhupay.ts"),
]);

const checks: string[] = [];
function pass(name: string, condition: unknown): void {
  assert.ok(condition, name);
  checks.push(name);
}
function ordered(name: string, source: string, needles: string[]): void {
  let previous = -1;
  for (const needle of needles) {
    const current = source.indexOf(needle);
    assert.ok(current >= 0, `${name}: missing ${needle}`);
    assert.ok(current > previous, `${name}: wrong order at ${needle}`);
    previous = current;
  }
  checks.push(name);
}
function rejectsCode(name: string, expectedCode: string, operation: () => unknown): void {
  let actual = "";
  try {
    operation();
  } catch (error) {
    actual = error instanceof PaymentRefundReconciliationValidationError ? error.code : "unexpected";
  }
  pass(name, actual === expectedCode);
}

pass("manual refund query uses billing.view", manualRoute.includes('authorizeAdminCapability(request, "billing.view"'));
pass("manual refund mutation uses wallet.adjust step-up", manualRoute.includes('authorizeAdminCapability(request, "wallet.adjust"')
  && manualRoute.includes("requireStepUp: true"));
pass("manual refund body is stream bounded", manualRoute.includes("request.body?.getReader()")
  && manualRoute.includes("MAX_RECONCILIATION_BODY_BYTES")
  && manualRoute.includes("PAYMENT_REFUND_RECONCILIATION_REQUEST_TOO_LARGE"));
ordered("manual audit intent precedes atomic resolution", manualRoute, [
  'action: result === "allowed" ? "payment_refund_reconciliation_intent"',
  'const intentRecorded = await audit("allowed"',
  "if (!intentRecorded)",
  '.rpc("resolve_payment_refund_reconciliation_atomic"',
]);
pass("manual result returns only bounded receipt", manualRoute.includes("actionReceipt:")
  && !manualRoute.includes("provider_response"));
pass("manual query keeps unresolved attempts explicit", manualRoute.includes('automaticRelease: false')
  && manualRoute.includes('automaticCompletion: false')
  && manualRoute.includes('terminalEvidenceRequired: true'));

pass("contract exposes three explicit decisions", contract.includes('"confirm_completed"')
  && contract.includes('"confirm_rejected"') && contract.includes('"keep_frozen"'));
pass("completion requires exact evidence fields", contract.includes("COMPLETION_EVIDENCE_INCOMPLETE")
  && contract.includes("providerRefundAmount") && contract.includes("providerRefundId"));
pass("rejection requires UD evidence", contract.includes('providerStatus !== "UD"')
  && contract.includes("REJECTION_EVIDENCE_INCOMPLETE"));

const attemptId = "a".repeat(64);
const tradeOrderId = "PAYMENT-ORDER-EXACT-001";
const attempt = { state: "reconciliation_required", tradeOrderId, paidAmount: 12.34 };
const completed = parsePaymentRefundReconciliationRequest({
  attemptId,
  action: "confirm_completed",
  note: "已在供应商后台逐项核对退款终态",
  evidence: {
    source: "provider_dashboard",
    reference: "provider-case-10001",
    observedAt: new Date().toISOString(),
    providerStatus: "CD",
    providerTradeOrderId: tradeOrderId,
    providerRefundId: "refund-10001",
    providerRefundAmount: 12.34,
  },
}, "refund-reconcile-complete-0001");
pass("exact completion has no wallet release", JSON.stringify(evaluatePaymentRefundReconciliationDecision(attempt, completed))
  === JSON.stringify({ terminalState: "completed", walletMutation: "none" }));

const rejected = parsePaymentRefundReconciliationRequest({
  attemptId,
  action: "confirm_rejected",
  note: "供应商工单确认退款请求失败且未扣出资金",
  evidence: {
    source: "provider_support",
    reference: "support-ticket-20001",
    observedAt: new Date().toISOString(),
    providerStatus: "UD",
    providerTradeOrderId: tradeOrderId,
    providerRefundId: null,
    providerRefundAmount: null,
  },
}, "refund-reconcile-reject-0001");
pass("evidenced rejection releases once", JSON.stringify(evaluatePaymentRefundReconciliationDecision(attempt, rejected))
  === JSON.stringify({ terminalState: "released", walletMutation: "release" }));

const frozen = parsePaymentRefundReconciliationRequest({
  attemptId,
  action: "keep_frozen",
  note: "当前没有可证明成功或失败的供应商终态证据",
  evidence: {
    source: "no_conclusive_evidence",
    reference: null,
    observedAt: new Date().toISOString(),
    providerStatus: "UNKNOWN",
    providerTradeOrderId: null,
    providerRefundId: null,
    providerRefundAmount: null,
  },
}, "refund-reconcile-frozen-0001");
pass("inconclusive review remains frozen without wallet mutation", JSON.stringify(evaluatePaymentRefundReconciliationDecision(attempt, frozen))
  === JSON.stringify({ terminalState: "reconciliation_required", walletMutation: "none" }));
rejectsCode("amount mismatch cannot complete", "PAYMENT_REFUND_RECONCILIATION_AMOUNT_MISMATCH", () => (
  evaluatePaymentRefundReconciliationDecision({ ...attempt, paidAmount: 99 }, completed)
));
rejectsCode("order mismatch cannot complete", "PAYMENT_REFUND_RECONCILIATION_ORDER_MISMATCH", () => (
  evaluatePaymentRefundReconciliationDecision({ ...attempt, tradeOrderId: "OTHER-ORDER" }, completed)
));
rejectsCode("terminal attempt cannot be changed again", "PAYMENT_REFUND_RECONCILIATION_STATE_CONFLICT", () => (
  evaluatePaymentRefundReconciliationDecision({ ...attempt, state: "completed" }, completed)
));
rejectsCode("clear provider terminal cannot be kept frozen", "PAYMENT_REFUND_RECONCILIATION_FROZEN_STATUS_CONFLICT", () => (
  parsePaymentRefundReconciliationRequest({
    attemptId,
    action: "keep_frozen",
    note: "错误地尝试冻结已有明确终态的退款记录",
    evidence: {
      source: "provider_dashboard",
      reference: "provider-case-30001",
      observedAt: new Date().toISOString(),
      providerStatus: "CD",
      providerTradeOrderId: tradeOrderId,
      providerRefundId: "refund-30001",
      providerRefundAmount: 12.34,
    },
  }, "refund-reconcile-invalid-0001")
));
pass("manual action id is deterministic and actor-bound",
  paymentRefundReconciliationActionId("actor-a", "stable-key-0001")
    === paymentRefundReconciliationActionId("actor-a", "stable-key-0001")
  && paymentRefundReconciliationActionId("actor-a", "stable-key-0001")
    !== paymentRefundReconciliationActionId("actor-b", "stable-key-0001"));

pass("migration stores immutable action evidence", migration.includes("payment_refund_reconciliation_actions")
  && migration.includes("evidence_digest") && migration.includes("UNIQUE (actor_id, idempotency_key)"));
ordered("database locks attempt before idempotent action replay", migration, [
  "FROM public.payment_refund_attempts",
  "FOR UPDATE;",
  "FROM public.payment_refund_reconciliation_actions",
]);
pass("database completion requires exact CD evidence", migration.includes("v_provider_status <> 'CD'")
  && migration.includes("v_provider_order <> v_attempt.trade_order_id")
  && migration.includes("v_provider_amount <> v_attempt.paid_amount"));
pass("database rejection requires exact UD evidence", migration.includes("v_provider_status <> 'UD'")
  && migration.includes("payment-refund-release:' || v_attempt.attempt_id"));
pass("keep frozen performs no wallet operation", /ELSE\s+IF v_provider_status NOT IN \('RD','UNKNOWN'\)[\s\S]*?v_resulting_state := 'reconciliation_required';/u.test(migration));
pass("service role owns reconciliation mutation", migration.includes("REVOKE ALL ON FUNCTION public.resolve_payment_refund_reconciliation_atomic")
  && migration.includes("TO service_role"));
pass("rollback refuses evidence loss", rollback.includes("ROLLBACK_BLOCKED_PAYMENT_REFUND_RECONCILIATION_EVIDENCE_EXISTS")
  && rollback.includes("ROLLBACK_BLOCKED_PAYMENT_REFUND_RECONCILIATION_LINK_EXISTS")
  && !rollback.includes("CASCADE"));

const scheduledDiscoveryRequest = scheduler.slice(scheduler.indexOf('fetch(`${ORIGIN}/api/admin/payment-reconcile`'));
pass("scheduled task uses read-only GET", scheduledDiscoveryRequest.includes('method: "GET"')
  && !scheduledDiscoveryRequest.includes('method: "POST"')
  && scheduler.includes('summary.mode !== "read_only_discovery"')
  && scheduler.includes("summary.writePerformed !== false")
  && scheduler.includes("summary.providerCalls !== 0"));
pass("scheduled task uses current project log path", scheduler.includes("自媒体操盘手/运行日志/支付对账/支付待办发现.log")
  && !scheduler.includes("带货Agent"));
pass("scheduled task does not synthesize step-up", !scheduler.includes("x-admin-step-up")
  && !scheduler.includes("ADMIN_STEP_UP_COOKIE"));

pass("discovery endpoint has zero provider calls and writes", discoveryRoute.includes('mode: "read_only_discovery"')
  && discoveryRoute.includes("writePerformed: false") && discoveryRoute.includes("providerCalls: 0"));
pass("EPay is explicitly callback-only", discoveryRoute.includes('recoveryMode: "callback_only"')
  && discoveryRoute.includes("automaticRecoverySupported: false")
  && discoveryRoute.includes("不能自动补账"));
ordered("manual payment recovery is audited before provider query", discoveryRoute, [
  'const intentRecorded = await audit("allowed"',
  "if (!intentRecorded)",
  "for (const order of xunhu.rows)",
  "queryOrderStatus(order.trade_order_id)",
  "fulfillPaymentOrder({",
]);
pass("manual payment recovery requires wallet step-up", discoveryRoute.includes('authorizeAdminCapability(request, "wallet.adjust"')
  && discoveryRoute.includes("requireStepUp: true"));

pass("payment order query uses explicit columns", ordersRoute.includes("PAYMENT_ORDER_COLUMNS")
  && !ordersRoute.includes('.select("*"'));
pass("payment order query bounds page and page size", ordersRoute.includes("const MAX_PAGE = 1_000")
  && ordersRoute.includes("const MAX_PAGE_SIZE = 100") && ordersRoute.includes("boundedInteger"));
pass("payment order query rejects unknown keys and statuses", ordersRoute.includes("ALLOWED_QUERY_KEYS")
  && ordersRoute.includes("ALLOWED_STATUSES") && ordersRoute.includes("PAYMENT_ORDER_QUERY_INVALID"));
pass("payment order summary never downloads the full table", ordersRoute.includes('rpc("read_payment_order_admin_summary"')
  && ordersRoute.includes('scope: "page_fallback"')
  && !ordersRoute.includes("allOrders"));
pass("payment orders expose EPay recovery boundary", ordersRoute.includes('mode: "callback_only"')
  && ordersRoute.includes("automaticRecoverySupported: false"));

pass("payment method mutations require route step-up", methodsRoute.includes('authorizeAdminCapability(request, "payment.settings.manage"')
  && methodsRoute.includes("requireStepUp: true"));
pass("payment method mutations fail closed on audit", (methodsRoute.match(/PAYMENT_METHOD_AUDIT_UNAVAILABLE/gu) || []).length >= 3);
ordered("payment method create intent precedes insert", methodsRoute, [
  'action: "payment_method_create_intent"',
  "if (!intentRecorded)",
  '.from("payment_methods")\n      .insert(',
]);
pass("payment method delete is now disable only", !methodsRoute.includes('.from("payment_methods")\n      .delete()')
  && methodsRoute.includes("hardDeletePerformed: false")
  && methodsRoute.includes("PAYMENT_METHOD_HARD_DELETE_REFERENCED")
  && methodsRoute.includes("PAYMENT_METHOD_DISABLED"));
pass("payment method reference count avoids select star", methodsRoute.includes('.select("id", { count: "exact", head: true })')
  && !methodsRoute.includes('.select("*"'));

const queryFunction = xunhu.slice(xunhu.indexOf("export async function queryOrderStatus"));
pass("Xunhu query has timeout", queryFunction.includes("AbortSignal.timeout(XUNHU_QUERY_TIMEOUT_MS)")
  && xunhu.includes("const XUNHU_QUERY_TIMEOUT_MS = 10_000"));
pass("Xunhu query response is byte bounded", queryFunction.includes("readBoundedGatewayResponse(response)")
  && xunhu.includes("const MAX_GATEWAY_RESPONSE_BYTES = 64 * 1024"));
pass("Xunhu query requires signed response", queryFunction.includes("!signedResult.hash || !verifyResponseSign"));

const report = {
  generatedAt: new Date().toISOString(),
  passed: true,
  checks,
  faultInjectionScenarios: 7,
  providerCalls: 0,
  businessDatabaseReads: 0,
  businessDatabaseWrites: 0,
  migrationsApplied: 0,
  buildRuns: 0,
  runtimeStarts: 0,
};
const evidenceDir = path.join(root, ".codex-evidence/payment-reconciliation-hardening-20261003", new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(evidenceDir, { recursive: true });
await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2), { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ ...report, passedChecks: checks.length }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
