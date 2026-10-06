export type PaymentCreationState =
  | "reserved"
  | "provider_started"
  | "reconciliation_required"
  | "ready";

export type PaymentCreationProviderResult = {
  paymentUrl: string;
  qrcodeUrl: string;
  platformOrderId: string | null;
};

export type PaymentCreationRecord = {
  tradeOrderId: string;
  userId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  state: PaymentCreationState;
  type: "credits" | "cash";
  amount: number;
  creditsAmount: number | null;
  paymentMethod: string;
  paymentProvider: "xunhupay" | "epay";
  leaseOwner: string | null;
  leaseToken: number;
  providerResult: PaymentCreationProviderResult | null;
};

export type PaymentCreationClaim = {
  action: "execute" | "recover" | "in_progress" | "replay" | "reconciliation_required";
  record: PaymentCreationRecord;
};

export type PaymentCreationMachineDependencies = {
  claim(): Promise<PaymentCreationClaim>;
  markProviderStarted(record: PaymentCreationRecord): Promise<PaymentCreationClaim>;
  createProviderOrder(record: PaymentCreationRecord): Promise<PaymentCreationProviderResult>;
  finalize(record: PaymentCreationRecord, result: PaymentCreationProviderResult): Promise<PaymentCreationClaim>;
  markRecoveryRequired(
    record: PaymentCreationRecord,
    result: PaymentCreationProviderResult | null,
    reason: "provider_outcome_unknown" | "local_finalize_failed",
  ): Promise<PaymentCreationClaim>;
};

export type PaymentCreationMachineOutcome =
  | { kind: "ready"; record: PaymentCreationRecord; replayed: boolean; recovered: boolean }
  | { kind: "in_progress"; record: PaymentCreationRecord }
  | {
      kind: "reconciliation_required";
      record: PaymentCreationRecord;
      providerSucceeded: boolean;
      recoveryPersisted: boolean;
      reason: "provider_outcome_unknown" | "local_finalize_failed" | "reconciliation_required";
    };

async function persistRecovery(
  dependencies: PaymentCreationMachineDependencies,
  record: PaymentCreationRecord,
  result: PaymentCreationProviderResult | null,
  reason: "provider_outcome_unknown" | "local_finalize_failed",
): Promise<PaymentCreationMachineOutcome> {
  try {
    const recovery = await dependencies.markRecoveryRequired(record, result, reason);
    if (recovery.action === "replay" && recovery.record.state === "ready") {
      return { kind: "ready", record: recovery.record, replayed: true, recovered: true };
    }
    return {
      kind: "reconciliation_required",
      record: recovery.record,
      providerSucceeded: result !== null,
      recoveryPersisted: true,
      reason,
    };
  } catch {
    // markProviderStarted committed before the provider request. Even if this
    // second write is unavailable, that durable state prevents another caller
    // from creating a second provider order for the same merchant order.
    return {
      kind: "reconciliation_required",
      record,
      providerSucceeded: result !== null,
      recoveryPersisted: false,
      reason,
    };
  }
}

/**
 * Runs one payment-create attempt. The provider is reachable only after a
 * durable local claim and provider-start checkpoint. Replays never call it.
 */
export async function runPaymentOrderCreation(
  dependencies: PaymentCreationMachineDependencies,
): Promise<PaymentCreationMachineOutcome> {
  const claim = await dependencies.claim();

  if (claim.action === "replay") {
    return { kind: "ready", record: claim.record, replayed: true, recovered: false };
  }
  if (claim.action === "in_progress") {
    return { kind: "in_progress", record: claim.record };
  }
  if (claim.action === "reconciliation_required") {
    return {
      kind: "reconciliation_required",
      record: claim.record,
      providerSucceeded: false,
      recoveryPersisted: true,
      reason: "reconciliation_required",
    };
  }

  if (claim.action === "recover") {
    if (!claim.record.providerResult) {
      return {
        kind: "reconciliation_required",
        record: claim.record,
        providerSucceeded: false,
        recoveryPersisted: true,
        reason: "reconciliation_required",
      };
    }
    try {
      const finalized = await dependencies.finalize(claim.record, claim.record.providerResult);
      return { kind: "ready", record: finalized.record, replayed: true, recovered: true };
    } catch {
      return persistRecovery(
        dependencies,
        claim.record,
        claim.record.providerResult,
        "local_finalize_failed",
      );
    }
  }

  // This checkpoint is deliberately before createProviderOrder. If it fails,
  // the provider has not been called and the reserved lease can be reclaimed.
  const started = await dependencies.markProviderStarted(claim.record);
  if (started.action === "replay" && started.record.state === "ready") {
    return { kind: "ready", record: started.record, replayed: true, recovered: false };
  }

  let providerResult: PaymentCreationProviderResult;
  try {
    providerResult = await dependencies.createProviderOrder(started.record);
  } catch {
    return persistRecovery(
      dependencies,
      started.record,
      null,
      "provider_outcome_unknown",
    );
  }

  try {
    const finalized = await dependencies.finalize(started.record, providerResult);
    return { kind: "ready", record: finalized.record, replayed: false, recovered: false };
  } catch {
    return persistRecovery(
      dependencies,
      started.record,
      providerResult,
      "local_finalize_failed",
    );
  }
}
