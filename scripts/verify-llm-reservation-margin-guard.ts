import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { calculateCredits, type BillingConfig } from "../src/lib/billing";
import {
  LLM_PROVIDER_INPUT_ALLOWANCE_TOKENS,
  LlmCreditReservationError,
  quoteLlmStreamReservation,
  validateLlmStreamReservationSettlement,
} from "../src/lib/llm-credit-reservation";

const config: BillingConfig = {
  inputCostPerMillion: 0.6,
  outputCostPerMillion: 3,
  cachedCostPerMillion: 0.06,
  profitMargin: 9.090909,
  creditsPerYuan: 50,
  tokenRoundingEnabled: false,
  tokenRoundingUnit: 0,
  tokenRoundingMin: 100,
  tokenRoundingMax: 10_000,
};

// Reproduce the shape that previously produced a 2,996-token reservation for
// a provider receipt of 4,834 prompt tokens. No network or provider is called.
const messages = [{ role: "user", content: "x".repeat(1_800) }];
const serializedBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
const legacyInputBudget = serializedBytes + messages.length * 64 + 1_024;
const actualPromptTokens = 4_834;
const actualCompletionTokens = 23;
assert.ok(legacyInputBudget < actualPromptTokens, "fixture must reproduce the former under-reservation");

const quote = quoteLlmStreamReservation({
  model: "gpt-6-sol",
  messages,
  max_tokens: 128,
}, config, 1);
assert.ok(quote, "bounded text requests must produce a reservation quote");
assert.equal(LLM_PROVIDER_INPUT_ALLOWANCE_TOKENS, 8_192);
assert.ok(quote.inputBudget >= actualPromptTokens, "new input budget must cover the real GPT-6 receipt");

const actualBilling = calculateCredits(config, actualPromptTokens, actualCompletionTokens, 0);
assert.equal(actualBilling.actualCostRmb, 0.002969);
assert.equal(actualBilling.creditsCharged, 0.17);
assert.ok(actualBilling.sellPriceRmb > actualBilling.actualCostRmb);
assert.ok(actualBilling.profitRmb > 0);
assert.ok(quote.amount >= actualBilling.creditsCharged, "quoted wallet hold must cover the actual bill");
assert.equal(validateLlmStreamReservationSettlement({ amount: quote.amount }, actualBilling), actualBilling);

assert.throws(
  () => validateLlmStreamReservationSettlement({ amount: 0.12 }, actualBilling),
  (error: unknown) => error instanceof LlmCreditReservationError
    && error.code === "LLM_RESERVATION_BUDGET_EXCEEDED",
  "an under-reserved request must fail closed instead of scaling revenue below cost",
);

assert.throws(
  () => validateLlmStreamReservationSettlement(
    { amount: actualBilling.creditsCharged },
    { ...actualBilling, sellPriceRmb: 0.002305, profitRmb: -0.000664 },
  ),
  (error: unknown) => error instanceof LlmCreditReservationError
    && error.code === "LLM_BILLING_MARGIN_INVALID",
  "negative-margin settlement must be rejected",
);

const routeSource = readFileSync(resolve(process.cwd(), "src/app/api/llm/route.ts"), "utf8");
const handlerSource = readFileSync(resolve(process.cwd(), "src/app/api/llm/handle-stream.ts"), "utf8");
assert.ok(routeSource.includes("streamQuote?.amount === 0 || Boolean(streamReservation)"));
assert.ok(routeSource.includes('streamReservation ? "reservation_authorized_live_delivery"'));
assert.ok(handlerSource.includes("if (!liveDelivery)"));
assert.ok(handlerSource.includes("reservationNeedsReconciliation"));
assert.ok(handlerSource.includes("LLM live reservation retained for reconciliation"));

console.log(JSON.stringify({
  verifier: "llm-reservation-margin-guard",
  providerCalls: 0,
  paidCostRmb: 0,
  legacyInputBudget,
  guardedInputBudget: quote.inputBudget,
  actualPromptTokens,
  actualCompletionTokens,
  reservedCredits: quote.amount,
  actualCredits: actualBilling.creditsCharged,
  actualCostRmb: actualBilling.actualCostRmb,
  sellPriceRmb: actualBilling.sellPriceRmb,
  profitRmb: actualBilling.profitRmb,
  paidDelivery: "reservation_authorized_live_delivery",
  result: "PASS",
}, null, 2));
