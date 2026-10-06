import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ImageExactlyOnceError,
  MemoryImageExactlyOnceStore,
  runImageExactlyOnce,
  strictImagePayloadFingerprint,
} from "../src/lib/image-exactly-once";

const root = process.cwd();
const read = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");

async function verifyRuntimeContract() {
  const store = new MemoryImageExactlyOnceStore();
  const base = {
    store,
    userId: "verify-user",
    clientIdempotencyKey: "verify_image_request_0001",
    clientTraceId: "verify_image_trace_0001",
    payloadFingerprint: strictImagePayloadFingerprint({ prompt: "一只橙色小猫", model: "verify" }),
  };
  let submits = 0;
  const first = await runImageExactlyOnce({
    ...base,
    submitOnce: async () => {
      submits += 1;
      return {
        imageStorageUri: "object://tencent_cos/images%2Fverify.png",
        storageKey: "images/verify.png",
      };
    },
  });
  const replay = await runImageExactlyOnce({
    ...base,
    submitOnce: async () => {
      submits += 1;
      return {};
    },
  });
  assert.equal(submits, 1, "replay must not call the provider twice");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response, first.response);

  await assert.rejects(
    runImageExactlyOnce({
      ...base,
      payloadFingerprint: strictImagePayloadFingerprint({ prompt: "different" }),
      submitOnce: async () => ({}),
    }),
    (error: unknown) => error instanceof ImageExactlyOnceError
      && error.code === "IMAGE_IDEMPOTENCY_CONFLICT",
  );
}

async function verifySourceAndMigrationContract() {
  const [route, statusRoute, exactStore, migration, rollback, bridge] = await Promise.all([
    read("src/app/api/image/generate/route.ts"),
    read("src/app/api/image/status/route.ts"),
    read("src/lib/image-exactly-once.ts"),
    read("supabase/migrations/20260825174500_image_generation_exactly_once.sql"),
    read("supabase/rollbacks/20260825174500_image_generation_exactly_once.rollback.sql"),
    read("src/app/api/bridge/upload/route.ts"),
  ]);

  assert.match(route, /new DatabaseImageExactlyOnceStore\(\)/u);
  assert.match(statusRoute, /new DatabaseImageExactlyOnceStore\(\)/u);
  assert.match(route, /IMAGE_IDEMPOTENCY_KEY_REQUIRED/u);
  assert.match(route, /IMAGE_TRACE_ID_REQUIRED/u);
  assert.match(route, /IMAGE_PRICE_NOT_CONFIGURED/u);
  assert.match(route, /persistGeneratedImage\(/u);
  assert.match(route, /persistAutodlH3SelfhostImageWithRecovery\(/u);
  assert.match(route, /imageStorageUri: persisted\.storageUri/u);
  assert.match(route, /assetId: delivery\.assetId/u);
  assert.match(route, /idempotencyReplayed/u);
  assert.match(statusRoute, /provider_completed_pending_delivery/u);

  const reservation = route.indexOf("const reserveImageBudgetOnce");
  const deduction = route.indexOf("executeCashDeduction({", reservation);
  const providerCallback = route.indexOf("submitOnce: async () =>", deduction);
  const delivery = route.indexOf("finalizeImageExactlyOnceDelivery({");
  assert.ok(reservation >= 0 && deduction > reservation && providerCallback > deduction,
    "the durable-intent winner must reserve budget before its only provider callback");
  assert.ok(delivery > deduction, "asset ownership must be finalized only after billing");
  assert.match(route, /const billingReferenceId = `image:\$\{h3OperationId\}`/u);
  assert.match(route, /executeCashDeduction\(\{[\s\S]*?amount: sellingPrice,[\s\S]*?idempotencyKey: billingReferenceId/u);
  assert.match(route, /if \(!imageBudgetState\.deduction\.success\)[\s\S]*?IMAGE_BILLING_RESERVATION_REJECTED/u);
  assert.match(route, /beforeSubmitOnce: reserveImageBudgetOnce/u);

  assert.match(exactStore, /claim_image_generation_request/u);
  assert.match(exactStore, /save_image_generation_request/u);
  assert.match(exactStore, /finalize_image_generation_delivery/u);
  assert.match(exactStore, /IMAGE_IDEMPOTENCY_FAIL_CLOSED/u);

  assert.match(migration, /UNIQUE \(user_id, client_idempotency_key\)/u);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /FOR UPDATE/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_image_generation_request/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.save_image_generation_request/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.finalize_image_generation_delivery/u);
  assert.match(migration, /delivery_state = 'delivered'/u);
  assert.match(migration, /INSERT INTO public\.user_files/u);
  assert.match(migration, /REVOKE ALL ON TABLE public\.image_generation_requests FROM PUBLIC, anon, authenticated/u);
  assert.doesNotMatch(migration, /\.rollback\.sql/u);

  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.finalize_image_generation_delivery/u);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.image_generation_requests/u);
  assert.doesNotMatch(rollback, /CASCADE/u);

  assert.match(bridge, /CANVAS_UPLOAD_BRIDGE_RETIRED/u);
  assert.match(bridge, /uploadEndpoint: "\/api\/storage\/upload"/u);
  assert.match(bridge, /billed: false/u);
  assert.match(bridge, /status: 410/u);
  assert.doesNotMatch(bridge, /\/api\/image\/generate|clientTraceId|clientIdempotencyKey/u);
}

async function main() {
  await verifyRuntimeContract();
  await verifySourceAndMigrationContract();
  console.log("verify-image-generation-db-idempotency: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
