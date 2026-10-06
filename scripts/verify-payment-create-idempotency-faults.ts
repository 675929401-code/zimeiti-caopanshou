import assert from "node:assert/strict";
import {
  runPaymentOrderCreation,
  type PaymentCreationClaim,
  type PaymentCreationMachineDependencies,
  type PaymentCreationProviderResult,
  type PaymentCreationRecord,
} from "../src/lib/payment-order-creation-machine";

const providerResult: PaymentCreationProviderResult = {
  paymentUrl: "https://fixture.invalid/pay/merchant-order",
  qrcodeUrl: "https://fixture.invalid/qr/merchant-order",
  platformOrderId: "provider-order-1",
};

function baseRecord(): PaymentCreationRecord {
  return {
    tradeOrderId: "PAY_credits_ONE_MERCHANT_ORDER",
    userId: "fixture-user",
    idempotencyKey: "recharge-fixture-stable-key",
    requestFingerprint: "a".repeat(64),
    state: "reserved",
    type: "credits",
    amount: 100,
    creditsAmount: 5000,
    paymentMethod: "wechat",
    paymentProvider: "xunhupay",
    leaseOwner: "fixture-lease",
    leaseToken: 1,
    providerResult: null,
  };
}

function claim(action: PaymentCreationClaim["action"], record: PaymentCreationRecord): PaymentCreationClaim {
  return { action, record: { ...record, providerResult: record.providerResult && { ...record.providerResult } } };
}

async function normalReplayScenario(): Promise<void> {
  let record = baseRecord();
  let providerCalls = 0;
  const dependencies: PaymentCreationMachineDependencies = {
    claim: async () => record.state === "ready" ? claim("replay", record) : claim("execute", record),
    markProviderStarted: async () => {
      record = { ...record, state: "provider_started" };
      return claim("execute", record);
    },
    createProviderOrder: async () => {
      providerCalls += 1;
      return providerResult;
    },
    finalize: async (_current, result) => {
      record = { ...record, state: "ready", leaseOwner: null, providerResult: { ...result } };
      return claim("replay", record);
    },
    markRecoveryRequired: async () => {
      throw new Error("unexpected recovery");
    },
  };

  const first = await runPaymentOrderCreation(dependencies);
  const second = await runPaymentOrderCreation(dependencies);
  assert.equal(first.kind, "ready");
  assert.equal(second.kind, "ready");
  assert.equal(second.kind === "ready" && second.replayed, true);
  assert.equal(providerCalls, 1, "ready replay must not call the provider twice");
  assert.equal(first.record.tradeOrderId, second.record.tradeOrderId, "replay must reuse one merchant order");
}

async function inProgressScenario(): Promise<void> {
  const record = baseRecord();
  let providerCalls = 0;
  const outcome = await runPaymentOrderCreation({
    claim: async () => claim("in_progress", record),
    markProviderStarted: async () => { throw new Error("must not start"); },
    createProviderOrder: async () => { providerCalls += 1; return providerResult; },
    finalize: async () => { throw new Error("must not finalize"); },
    markRecoveryRequired: async () => { throw new Error("must not recover"); },
  });
  assert.equal(outcome.kind, "in_progress");
  assert.equal(providerCalls, 0, "concurrent replay must stop before provider dispatch");
}

async function providerUnknownScenario(): Promise<void> {
  let record = baseRecord();
  let providerCalls = 0;
  const dependencies: PaymentCreationMachineDependencies = {
    claim: async () => record.state === "reconciliation_required"
      ? claim("reconciliation_required", record)
      : claim("execute", record),
    markProviderStarted: async () => {
      record = { ...record, state: "provider_started" };
      return claim("execute", record);
    },
    createProviderOrder: async () => {
      providerCalls += 1;
      throw new Error("transport outcome unknown");
    },
    finalize: async () => { throw new Error("must not finalize"); },
    markRecoveryRequired: async () => {
      record = { ...record, state: "reconciliation_required", leaseOwner: null };
      return claim("reconciliation_required", record);
    },
  };

  const first = await runPaymentOrderCreation(dependencies);
  const second = await runPaymentOrderCreation(dependencies);
  assert.equal(first.kind, "reconciliation_required");
  assert.equal(second.kind, "reconciliation_required");
  assert.equal(providerCalls, 1, "unknown provider outcome must never be auto-replayed");
}

async function finalizeRecoveryScenario(): Promise<void> {
  let record = baseRecord();
  let providerCalls = 0;
  let failFinalizeOnce = true;
  const dependencies: PaymentCreationMachineDependencies = {
    claim: async () => {
      if (record.state === "reconciliation_required" && record.providerResult) {
        record = { ...record, leaseOwner: "recovery-lease", leaseToken: record.leaseToken + 1 };
        return claim("recover", record);
      }
      if (record.state === "ready") return claim("replay", record);
      return claim("execute", record);
    },
    markProviderStarted: async () => {
      record = { ...record, state: "provider_started" };
      return claim("execute", record);
    },
    createProviderOrder: async () => {
      providerCalls += 1;
      return providerResult;
    },
    finalize: async (_current, result) => {
      if (failFinalizeOnce) {
        failFinalizeOnce = false;
        throw new Error("local finalize unavailable");
      }
      record = { ...record, state: "ready", leaseOwner: null, providerResult: { ...result } };
      return claim("replay", record);
    },
    markRecoveryRequired: async (_current, result) => {
      record = {
        ...record,
        state: "reconciliation_required",
        leaseOwner: null,
        providerResult: result && { ...result },
      };
      return claim("reconciliation_required", record);
    },
  };

  const first = await runPaymentOrderCreation(dependencies);
  assert.equal(first.kind, "reconciliation_required");
  assert.equal(first.kind === "reconciliation_required" && first.providerSucceeded, true);
  assert.equal(first.kind === "reconciliation_required" && first.recoveryPersisted, true);

  const recovered = await runPaymentOrderCreation(dependencies);
  assert.equal(recovered.kind, "ready");
  assert.equal(recovered.kind === "ready" && recovered.recovered, true);
  assert.equal(providerCalls, 1, "stored provider success must finalize without another provider call");
}

async function preProviderCheckpointFailureScenario(): Promise<void> {
  const record = baseRecord();
  let providerCalls = 0;
  await assert.rejects(() => runPaymentOrderCreation({
    claim: async () => claim("execute", record),
    markProviderStarted: async () => { throw new Error("checkpoint unavailable"); },
    createProviderOrder: async () => { providerCalls += 1; return providerResult; },
    finalize: async () => { throw new Error("must not finalize"); },
    markRecoveryRequired: async () => { throw new Error("must not recover"); },
  }), /checkpoint unavailable/u);
  assert.equal(providerCalls, 0, "checkpoint failure must happen before provider dispatch");
}

async function main(): Promise<void> {
  await normalReplayScenario();
  await inProgressScenario();
  await providerUnknownScenario();
  await finalizeRecoveryScenario();
  await preProviderCheckpointFailureScenario();

  console.log(JSON.stringify({
    verifier: "payment-create-idempotency-faults",
    scenarios: 5,
    providerCalls: "fixture counters only",
    realProviderCalls: 0,
    databaseWrites: 0,
    migrationsApplied: 0,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
