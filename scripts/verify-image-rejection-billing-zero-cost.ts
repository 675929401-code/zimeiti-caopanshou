import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getImageRejectionBillingRelease,
  ImageRequestRejectedError,
  MemoryImageExactlyOnceStore,
  runImageExactlyOnce,
} from "../src/lib/image-exactly-once";
import {
  imageFailureBillingReleaseProjection,
  imageFailureBillingStateFromOperations,
} from "../src/lib/image-failure-history";

const userId = "billing-zero-cost-user";
const clientIdempotencyKey = "imgkey_billing_release_001";
const clientTraceId = "imgtrace_billing_release_001";
const payloadFingerprint = "a".repeat(64);
const referenceId = "image:h3_billing_release_001";
const amount = 0.42;

async function main() {
  const store = new MemoryImageExactlyOnceStore();
  await assert.rejects(() => runImageExactlyOnce({
    store,
    userId,
    clientIdempotencyKey,
    clientTraceId,
    payloadFingerprint,
    rejectionBilling: { referenceId, amount },
    beforeSubmitOnce: async () => undefined,
    submitOnce: async () => {
      throw new ImageRequestRejectedError({
        source: "provider",
        code: "IMAGE_UPSTREAM_REQUEST_REJECTED",
        upstreamStatus: 400,
      });
    },
  }), ImageRequestRejectedError);

  const rejected = await store.get({ userId, clientIdempotencyKey, clientTraceId });
  assert.ok(rejected, "durable rejection receipt missing");
  const pending = getImageRejectionBillingRelease(rejected);
  assert.equal(pending?.state, "pending", "rejection was not fenced by durable billing_release_pending");
  assert.equal(pending?.referenceId, referenceId);

  const charged = imageFailureBillingStateFromOperations({
    billingReferenceId: referenceId,
    billingExempt: false,
    operations: [{
      idempotency_key: referenceId,
      operation_kind: "cash_charge",
      amount,
      status: "completed",
    }],
  });
  const held = imageFailureBillingReleaseProjection(charged.state);
  assert.equal(held.canResubmit, false, "persisted rejection with unreleased charge allowed a new-key retry");
  assert.equal(held.billingHeld, true);
  assert.equal(held.billingReleaseState, "pending");

  const released = imageFailureBillingStateFromOperations({
    billingReferenceId: referenceId,
    billingExempt: false,
    operations: [
      { idempotency_key: referenceId, operation_kind: "cash_charge", amount, status: "completed" },
      { idempotency_key: `${referenceId}:release`, operation_kind: "cash_refund", amount, status: "completed" },
    ],
  });
  const eligible = imageFailureBillingReleaseProjection(released.state);
  assert.equal(eligible.canResubmit, true, "confirmed net release did not enable a new-key retry");
  assert.equal(eligible.billingHeld, false);
  assert.equal(eligible.billingReleaseState, "confirmed");

  const confirmed = await store.markRejectionBillingRelease(rejected, {
    schema: "image_billing_release.v1",
    state: "confirmed",
    referenceId,
    amount,
    updatedAt: new Date().toISOString(),
  });
  assert.equal(confirmed && getImageRejectionBillingRelease(confirmed)?.state, "confirmed");

  const [statusRoute, generateRoute, history] = await Promise.all([
    readFile(path.resolve("src/app/api/image/status/route.ts"), "utf8"),
    readFile(path.resolve("src/app/api/image/generate/route.ts"), "utf8"),
    readFile(path.resolve("src/lib/image-failure-history.ts"), "utf8"),
  ]);
  assert.match(statusRoute, /state: release\.canResubmit \? "rejected" : "billing_release_pending"/u);
  assert.match(statusRoute, /imageFailureBillingStateFromOperations/u);
  assert.match(statusRoute, /billingHeld: release\.billingHeld/u);
  assert.match(generateRoute, /requiresLedgerConfirmation: true/u);
  assert.match(generateRoute, /readImageReservationBilling\(billingReservation\)/u);
  assert.match(generateRoute, /`\$\{billingReservation\.referenceId\}:release`/u);
  assert.match(generateRoute, /markRejectionBillingRelease/u);
  assert.match(generateRoute, /原费用快照不完整；确认账务释放前不可重新提交/u);
  assert.match(history, /imageFailureBillingReleaseProjection/u);

  console.log("image rejection billing zero-cost verifier: PASS");
  console.log("- durable rejection billing release pending/confirmed receipt: PASS");
  console.log("- unreleased charge blocks new-key resubmission: PASS");
  console.log("- confirmed idempotent release enables resubmission: PASS");
  console.log("- network calls: 0; database calls: 0; provider calls: 0; production writes: 0");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
