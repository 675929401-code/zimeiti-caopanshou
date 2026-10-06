export type PaymentSettlementRow = Record<string, unknown>;

export type PaymentSettlementEvaluation = {
  status: "credited" | "reconciliation_required";
  balanceCredited: boolean;
  issueCodes: string[];
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameAmount(left: unknown, right: unknown, precision = 6): boolean {
  const a = finite(left);
  const b = finite(right);
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= 10 ** -precision;
}

/**
 * A legacy `payment_orders.status = paid` marker is not proof that a balance
 * was credited. User-facing success requires provider evidence, the exact
 * completed wallet operation, and its one matching immutable ledger entry.
 */
export function evaluatePaidOrderSettlement(input: {
  order: PaymentSettlementRow;
  walletOperations: PaymentSettlementRow[];
  ledgerEntries: PaymentSettlementRow[];
}): PaymentSettlementEvaluation {
  const { order, walletOperations, ledgerEntries } = input;
  const issueCodes: string[] = [];
  const tradeOrderId = text(order.trade_order_id);
  const userId = text(order.user_id);
  const orderType = text(order.type).toLowerCase();
  const expectedOperationKind = orderType === "credits"
    ? "credit_topup"
    : orderType === "cash"
      ? "cash_topup"
      : "";
  const expectedWalletAmount = orderType === "credits"
    ? finite(order.credits_amount)
    : orderType === "cash"
      ? finite(order.amount)
      : null;
  const idempotencyKey = `payment:${tradeOrderId}`;

  const providerEvidenceComplete = Boolean(
    tradeOrderId
    && text(order.payment_provider)
    && text(order.provider_trade_order_id) === tradeOrderId
    && text(order.provider_transaction_id)
    && sameAmount(order.provider_paid_amount, order.amount, 2)
    && text(order.provider_confirmed_at),
  );
  if (!providerEvidenceComplete) issueCodes.push("PROVIDER_CONFIRMATION_INCOMPLETE");

  if (!expectedOperationKind || expectedWalletAmount == null || expectedWalletAmount <= 0) {
    issueCodes.push("PAYMENT_AMOUNT_SNAPSHOT_INVALID");
  }

  const operation = walletOperations.length === 1 ? walletOperations[0] : null;
  const operationMatches = Boolean(
    operation
    && text(operation.user_id) === userId
    && text(operation.status).toLowerCase() === "completed"
    && text(operation.operation_kind).toLowerCase() === expectedOperationKind
    && text(operation.idempotency_key) === idempotencyKey
    && sameAmount(operation.amount, expectedWalletAmount)
    && finite(operation.balance_before) != null
    && finite(operation.balance_after) != null,
  );
  if (!operationMatches) issueCodes.push("COMPLETED_WALLET_OPERATION_MISSING");

  const ledger = ledgerEntries.length === 1 ? ledgerEntries[0] : null;
  const ledgerMatches = Boolean(
    operationMatches
    && ledger
    && text(ledger.operation_id) === text(operation?.id)
    && text(ledger.user_id) === userId
    && text(ledger.operation_kind).toLowerCase() === expectedOperationKind
    && text(ledger.idempotency_key) === idempotencyKey
    && sameAmount(ledger.delta, expectedWalletAmount)
    && sameAmount(ledger.balance_before, operation?.balance_before)
    && sameAmount(ledger.balance_after, operation?.balance_after),
  );
  if (!ledgerMatches) issueCodes.push("MATCHING_WALLET_LEDGER_MISSING");

  return issueCodes.length === 0
    ? { status: "credited", balanceCredited: true, issueCodes }
    : { status: "reconciliation_required", balanceCredited: false, issueCodes };
}
