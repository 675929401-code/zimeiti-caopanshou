import assert from "node:assert/strict";

import { mapDurableVoiceHistoryRow, sanitizeLegacyVoiceHistory } from "../src/lib/voice-generation-history-mapper";
import { canLoadVoiceHistoryForRetry, voiceHistoryRetryUnavailableReason } from "../src/lib/voice-history-retry";
import type { DurableVoiceHistoryRow } from "../src/lib/voice-generation-history-mapper";
import type { VoiceGeneration } from "../src/lib/types";

function row(overrides: Partial<DurableVoiceHistoryRow>): DurableVoiceHistoryRow {
  return {
    request_id: "request-1",
    user_id: "user-1",
    phase: "tts",
    model_id: "voice-1",
    charge_credits: 0,
    refunded_credits: 0,
    state: "refunded",
    response: null,
    error: { message: "未完成" },
    metadata: {
      history_snapshot: {
        voice_model_name: "测试音色",
        input_text: "合同测试文案",
        output_format: "mp3",
        speed_ratio: 1,
        emotion: "neutral",
        engine: "volcano",
      },
    },
    started_at: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

const unknown = mapDurableVoiceHistoryRow(row({ state: "failed_unknown" }));
assert.equal(unknown.status, "failed");
assert.equal(unknown.terminalState, "failed_unknown");
assert.equal(unknown.billingState, "not_charged");
assert.equal(unknown.retryEligible, false, "failed_unknown must stay blocked even when charge is zero");
assert.equal(canLoadVoiceHistoryForRetry(unknown), false);
assert.match(voiceHistoryRetryUnavailableReason(unknown), /终态尚未确认/u);

const neverCharged = mapDurableVoiceHistoryRow(row({ state: "refunded" }));
assert.equal(neverCharged.billingState, "not_charged");
assert.equal(neverCharged.retryEligible, true);
assert.equal(canLoadVoiceHistoryForRetry(neverCharged), true);

const exempt = mapDurableVoiceHistoryRow(row({ state: "refunded", billing_exempt: true }));
assert.equal(exempt.billingState, "exempt");
assert.equal(canLoadVoiceHistoryForRetry(exempt), true);

const fullyRefunded = mapDurableVoiceHistoryRow(row({
  state: "refunded",
  charge_credits: 12,
  refunded_credits: 12,
  wallet_operation_id: 42,
  refunded_at: "2026-09-16T00:01:00.000Z",
}));
assert.equal(fullyRefunded.billingState, "fully_refunded");
assert.equal(fullyRefunded.cost, 0);
assert.equal(canLoadVoiceHistoryForRetry(fullyRefunded), true);

const refundUnconfirmed = mapDurableVoiceHistoryRow(row({
  state: "refunded",
  charge_credits: 12,
  refunded_credits: 12,
  wallet_operation_id: 42,
  refunded_at: null,
}));
assert.equal(refundUnconfirmed.billingState, "unknown");
assert.equal(refundUnconfirmed.retryEligible, false);
assert.equal(canLoadVoiceHistoryForRetry(refundUnconfirmed), false);

const legacyFailure: VoiceGeneration = {
  id: "legacy-1",
  userId: "user-1",
  voiceModelId: "voice-1",
  voiceModelName: "旧音色",
  inputText: "旧记录",
  textLength: 3,
  outputFormat: "mp3",
  speedRatio: 1,
  emotion: "neutral",
  engine: "volcano",
  cost: 0,
  status: "failed",
  createdAt: "2026-09-15T00:00:00.000Z",
};
const sanitizedLegacy = sanitizeLegacyVoiceHistory(legacyFailure);
assert.equal(sanitizedLegacy.terminalState, "legacy_unknown");
assert.equal(sanitizedLegacy.billingState, "unknown");
assert.equal(sanitizedLegacy.retryEligible, false);
assert.equal(canLoadVoiceHistoryForRetry(sanitizedLegacy), false);

const incompleteSnapshot = { ...neverCharged, inputText: "" };
assert.equal(canLoadVoiceHistoryForRetry(incompleteSnapshot), false);
assert.match(voiceHistoryRetryUnavailableReason(incompleteSnapshot), /缺少原文/u);

console.log(JSON.stringify({
  passed: true,
  cases: [
    "failed_unknown blocked despite zero charge",
    "terminal zero-charge failure allowed",
    "billing-exempt terminal failure allowed",
    "fully refunded terminal failure allowed",
    "refund without timestamp blocked",
    "legacy failure without durable proof blocked",
    "incomplete retry snapshot blocked",
  ],
}, null, 2));
