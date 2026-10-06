import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
  const root = process.cwd();
  const read = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");
  const [route, client, lifecycle, machine, migration, rollback] = await Promise.all([
    read("src/app/api/payment/create/route.ts"),
    read("src/components/recharge-dialog.tsx"),
    read("src/lib/payment-order-creation.ts"),
    read("src/lib/payment-order-creation-machine.ts"),
    read("supabase/migrations/20261003114500_payment_order_creation_exactly_once.sql"),
    read("supabase/rollbacks/20261003114500_payment_order_creation_exactly_once.rollback.sql"),
  ]);
  const checks: string[] = [];

  function pass(name: string, condition: unknown): void {
    assert.ok(condition, name);
    checks.push(name);
  }

  pass("create API requires the Idempotency-Key header", route.includes('request.headers.get("idempotency-key")'));
  pass("stable key is validated before provider orchestration", route.indexOf("validatePaymentCreationIdempotencyKey") < route.indexOf("runPaymentOrderCreation"));
  pass("merchant order id is deterministic from user and key", lifecycle.includes('sha256(`${input.userId}\\u0000${input.idempotencyKey}`)'));
  pass("request fingerprint binds amount method provider and callback origin", [
    "amount: input.amount.toFixed(2)",
    "paymentMethodId: input.paymentMethodId",
    "paymentProvider: input.paymentProvider",
    "callbackOrigin: input.callbackOrigin",
  ].every((marker) => lifecycle.includes(marker)));
  pass("route never inserts payment_orders after a provider call", !route.includes('.from("payment_orders").insert'));
  pass("machine claims and checkpoints before provider dispatch", machine.indexOf("dependencies.claim()") < machine.indexOf("dependencies.markProviderStarted")
    && machine.indexOf("dependencies.markProviderStarted") < machine.indexOf("dependencies.createProviderOrder"));
  pass("provider-started retries cannot dispatch again", machine.includes('claim.action === "reconciliation_required"')
    && migration.includes("IF v_order.creation_state = 'provider_started'"));
  pass("provider result finalize failure stores a recovery snapshot", machine.includes('"local_finalize_failed"')
    && migration.includes("provider_creation_snapshot = coalesce(v_snapshot, provider_creation_snapshot)"));
  pass("stored provider result is recovered without another provider call", machine.includes('claim.action === "recover"')
    && machine.indexOf('claim.action === "recover"') < machine.indexOf("dependencies.createProviderOrder"));
  pass("same user and key have one durable merchant order", migration.includes("payment_orders_user_create_idempotency_unique")
    && migration.includes("ON public.payment_orders (user_id, client_idempotency_key)"));
  pass("merchant order id is database unique", migration.includes("payment_orders_trade_order_unique"));
  pass("RPCs are service-role only", migration.includes("FROM PUBLIC, anon, authenticated, service_role")
    && migration.includes("TO service_role;"));
  pass("migration absence fails before provider", lifecycle.includes("PAYMENT_CREATE_MIGRATION_NOT_READY")
    && lifecycle.includes("本次未调用支付渠道"));
  pass("rollback refuses to erase creation evidence", rollback.includes("ROLLBACK_BLOCKED_PAYMENT_CREATION_EVIDENCE_EXISTS"));
  pass("rollback does not cascade", !rollback.toUpperCase().includes("CASCADE"));
  pass("client sends and retains a session-scoped stable key", client.includes('"Idempotency-Key": idempotencyKey')
    && client.includes("PAYMENT_CREATE_ATTEMPT_STORAGE_KEY")
    && client.includes("getOrCreatePaymentIdempotencyKey"));
  pass("client only rotates a conflicting key explicitly", client.includes('data.code === "PAYMENT_CREATE_IDEMPOTENCY_CONFLICT"'));
  pass("Xunhu contract retains merchant id amount callbacks and attach", [
    "tradeOrderId: params.tradeOrderId",
    "totalFee: params.normalizedAmount.toFixed(2)",
    "notifyUrl: params.notifyUrl",
    "returnUrl: params.returnUrl",
    "attach: JSON.stringify",
  ].every((marker) => route.includes(marker)));
  pass("EPay contract retains out trade number money type and callbacks", [
    "outTradeNo: params.tradeOrderId",
    "money: params.normalizedAmount.toFixed(2)",
    "type: epayType",
    "notifyUrl: params.notifyUrl",
    "returnUrl: params.returnUrl",
  ].every((marker) => route.includes(marker)));

  console.log(JSON.stringify({
    verifier: "payment-create-preflight",
    passed: checks.length,
    checks,
    providerCalls: 0,
    databaseWrites: 0,
    migrationsApplied: 0,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
