#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import {
  assertImageProviderDispatchReceipt,
  assertImageProviderSubmissionReceipt,
  createImageProviderSubmissionReceipt,
  imageProviderEvidenceProjection,
  prepareImageProviderRequest,
} from "../src/lib/image-provider-request-audit";
import {
  MemoryImageExactlyOnceStore,
  runImageExactlyOnce,
  strictImagePayloadFingerprint,
} from "../src/lib/image-exactly-once";

async function main() {

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const projection = {
  userPromptSha256: sha256("fixed prompt"),
  effectivePromptSha256: sha256("fixed prompt, output 16:9"),
  modelIdSha256: sha256("public-model"),
  aspectRatio: "16:9",
  resolution: "1K",
  imageCount: 1 as const,
  referenceCount: 0,
};

const jsonBody = JSON.stringify({ model: "internal-model", prompt: "fixed prompt", size: "1024x576" });
const jsonPrepared = await prepareImageProviderRequest({
  url: "https://provider.example/v1/images/generations?api_key=must-never-persist",
  init: { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: jsonBody },
  providerProtocol: "images_generations",
  projection,
  idempotencyKey: "image-idempotency-key",
});
const jsonWire = new Uint8Array(await jsonPrepared.request.clone().arrayBuffer());
assert.equal(jsonPrepared.receipt.actualPayloadSha256, sha256(jsonWire));
assert.equal(jsonPrepared.receipt.actualPayloadBytes, jsonWire.byteLength);
assert.equal(jsonPrepared.receipt.requestContentType, "application/json");
assert.doesNotThrow(() => assertImageProviderDispatchReceipt(jsonPrepared.receipt));
for (const tampered of [
  { ...jsonPrepared.receipt, recordedAt: "2026-10-10T00:00:00.000Z" },
  { ...jsonPrepared.receipt, endpointOriginSha256: sha256("https://other.invalid") },
  { ...jsonPrepared.receipt, requestProjection: { ...jsonPrepared.receipt.requestProjection, aspectRatio: "1:1" } },
]) {
  assert.throws(() => assertImageProviderDispatchReceipt(tampered), /HASH_INVALID/u);
}

const multipart = new FormData();
multipart.append("model", "internal-model");
multipart.append("prompt", "fixed prompt");
multipart.append("image", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }), "reference.png");
const multipartPrepared = await prepareImageProviderRequest({
  url: "https://provider.example/v1/images/edits?signature=must-never-persist",
  init: { method: "POST", headers: { authorization: "Bearer secret" }, body: multipart },
  providerProtocol: "images_edits",
  projection: { ...projection, referenceCount: 1 },
});
const multipartWire = new Uint8Array(await multipartPrepared.request.clone().arrayBuffer());
assert.equal(multipartPrepared.receipt.actualPayloadSha256, sha256(multipartWire));
assert.equal(multipartPrepared.receipt.actualPayloadBytes, multipartWire.byteLength);
assert.equal(multipartPrepared.receipt.requestContentType, "multipart/form-data");

const responseBody = new TextEncoder().encode(JSON.stringify({ task_id: "private-provider-task", data: [{ url: "https://signed.invalid/private?token=secret" }] }));
const submission = createImageProviderSubmissionReceipt({
  dispatchReceipt: jsonPrepared.receipt,
  transportState: "response_received",
  responseStatus: 200,
  responseContentType: "application/json; charset=utf-8",
  responseBody,
});
assert.equal(submission.responseBodySha256, sha256(responseBody));
assert.equal(submission.providerAcknowledgementField, "task_id");
assert.equal(submission.providerAcknowledgementSha256, sha256("private-provider-task"));
assert.doesNotThrow(() => assertImageProviderSubmissionReceipt(submission));
for (const tampered of [
  { ...submission, recordedAt: "2026-10-10T00:00:00.000Z" },
  { ...submission, responseContentType: "text/plain" },
  { ...submission, providerAcknowledgementField: "id" as const },
]) {
  assert.throws(() => assertImageProviderSubmissionReceipt(tampered), /HASH_INVALID/u);
}
const serializedEvidence = JSON.stringify({ dispatch: jsonPrepared.receipt, submission });
for (const forbidden of ["must-never-persist", "Bearer secret", "fixed prompt", "private-provider-task", "signed.invalid", "token=secret", "api_key="]) {
  assert.equal(serializedEvidence.includes(forbidden), false, `SENSITIVE_RECEIPT_VALUE_LEAKED:${forbidden}`);
}

const store = new MemoryImageExactlyOnceStore();
let providerPosts = 0;
const common = {
  store,
  userId: "receipt-test-user",
  clientIdempotencyKey: "receipt_test_idempotency_001",
  clientTraceId: "receipt_test_trace_001",
  payloadFingerprint: strictImagePayloadFingerprint({ prompt: "fixed prompt", ratio: "16:9" }),
};
const first = await runImageExactlyOnce({
  ...common,
  submitOnce: async receiptContext => {
    await receiptContext.recordProviderDispatchReceipt(jsonPrepared.receipt);
    providerPosts += 1;
    await receiptContext.recordProviderSubmissionReceipt(submission);
    return { delivered: true };
  },
});
assert.equal(first.replayed, false);
assert.equal(providerPosts, 1);
assert.equal(imageProviderEvidenceProjection(first.record).ready, true);
const replay = await runImageExactlyOnce({
  ...common,
  submitOnce: async () => {
    providerPosts += 1;
    return { delivered: false };
  },
});
assert.equal(replay.replayed, true);
assert.equal(providerPosts, 1, "IDEMPOTENT_REPLAY_MUST_NOT_POST_PROVIDER");

class FailingDispatchStore extends MemoryImageExactlyOnceStore {
  override async recordProviderDispatchReceipt(): Promise<null> { return null; }
}
let blockedProviderPosts = 0;
await assert.rejects(() => runImageExactlyOnce({
  store: new FailingDispatchStore(),
  userId: "receipt-test-user-fail",
  clientIdempotencyKey: "receipt_test_idempotency_002",
  clientTraceId: "receipt_test_trace_002",
  payloadFingerprint: sha256("failure-payload"),
  submitOnce: async receiptContext => {
    await receiptContext.recordProviderDispatchReceipt(jsonPrepared.receipt);
    blockedProviderPosts += 1;
    return { impossible: true };
  },
}), /供应商派发回执未确认/u);
assert.equal(blockedProviderPosts, 0, "DISPATCH_RECEIPT_FAILURE_MUST_PREVENT_PROVIDER_POST");

class FailingSubmissionStore extends MemoryImageExactlyOnceStore {
  override async recordProviderSubmissionReceipt(): Promise<null> { return null; }
}
const failingSubmissionStore = new FailingSubmissionStore();
let uncertainProviderPosts = 0;
const uncertainRequest = {
  store: failingSubmissionStore,
  userId: "receipt-test-user-uncertain",
  clientIdempotencyKey: "receipt_test_idempotency_003",
  clientTraceId: "receipt_test_trace_003",
  payloadFingerprint: sha256("uncertain-payload"),
  submitOnce: async (receiptContext: Parameters<Parameters<typeof runImageExactlyOnce>[0]["submitOnce"]>[0]) => {
    await receiptContext.recordProviderDispatchReceipt(jsonPrepared.receipt);
    uncertainProviderPosts += 1;
    await receiptContext.recordProviderSubmissionReceipt(submission);
    return { impossible: true };
  },
};
await assert.rejects(() => runImageExactlyOnce(uncertainRequest), /供应商响应回执未确认/u);
await assert.rejects(() => runImageExactlyOnce(uncertainRequest), /暂未取得可确认的图片结果/u);
assert.equal(uncertainProviderPosts, 1, "SUBMISSION_RECEIPT_FAILURE_MUST_LOCK_REPLAY_WITHOUT_A_SECOND_POST");

const [routeSource, statusSource, migrationSource, rollbackSource] = await Promise.all([
  fs.readFile("src/app/api/image/generate/route.ts", "utf8"),
  fs.readFile("src/app/api/image/status/route.ts", "utf8"),
  fs.readFile("supabase/migrations/20261010133000_image_provider_dispatch_receipts.sql", "utf8"),
  fs.readFile("supabase/rollbacks/20261010133000_image_provider_dispatch_receipts.rollback.sql", "utf8"),
]);
assert.match(routeSource, /fetchAuditedImageProviderPost\(\{/u);
assert.ok((routeSource.match(/fetchAuditedImageProviderPost\(\{/gu) || []).length >= 2, "LOCAL_AND_WORKFLOW_POSTS_MUST_BE_AUDITED");
assert.match(routeSource, /recordProviderDispatchReceipt\(prepared\.receipt\)[\s\S]*fetchImageUpstream/u);
assert.match(routeSource, /requestProtocol === "images_edits" && references\.length === 0[\s\S]*IMAGE_REFERENCE_REQUIRED/u);
assert.ok(routeSource.indexOf('requestProtocol === "images_edits" && references.length === 0')
  < routeSource.indexOf("resolveProviderSecret(model.api_key)"), "EDITS_REFERENCE_GUARD_MUST_PRECEDE_SECRET_AND_PROVIDER_POST");
assert.match(routeSource, /candidates\.some\(candidate => resolveImageProviderContract\(candidate\)\.requestProtocol === "images_edits"\)[\s\S]*IMAGE_REFERENCE_REQUIRED/u);
assert.ok(routeSource.indexOf("candidates.some(candidate => resolveImageProviderContract(candidate).requestProtocol")
  < routeSource.indexOf("const reserveImageBudgetOnce"), "EDITS_REFERENCE_GUARD_MUST_PRECEDE_BILLING_RESERVATION");
assert.match(routeSource, /const detail = summarizeUpstreamImageError\(JSON\.stringify\(apiData\.error\)\)/u);
assert.match(routeSource, /detail: summarizeUpstreamImageError\(error instanceof Error \? error\.message/u);
assert.doesNotMatch(routeSource, /detail: error instanceof Error \? error\.message/u);
assert.ok(statusSource.indexOf("withAuth(request") < statusSource.indexOf("imageProviderEvidenceProjection(record)"), "PROVIDER_EVIDENCE_STATUS_MUST_BE_AUTHENTICATED");
assert.match(statusSource, /userId:\s*user\.id[\s\S]*clientIdempotencyKey[\s\S]*clientTraceId/u, "PROVIDER_EVIDENCE_STATUS_MUST_BE_OWNER_SCOPED");
assert.match(migrationSource, /provider_evidence_present/u);
assert.match(migrationSource, /security definer[\s\S]*set search_path = public, pg_temp/iu);
assert.match(migrationSource, /revoke all[\s\S]*grant execute[\s\S]*service_role/iu);
assert.match(migrationSource, /requestProjection\.referenceCount=/u);
assert.match(migrationSource, /providerAcknowledgementField=/u);
assert.match(migrationSource, /not physical immutability/iu);
assert.doesNotMatch(rollbackSource, /drop\s+(?:column|function|table)|delete\s+from\s+supabase_migrations/iu);

console.log(JSON.stringify({
  passed: true,
  mode: "zero-network-image-provider-receipts",
  networkCalls: 0,
  databaseCalls: 0,
  filesystemWrites: 0,
  assertions: {
    jsonWireBytesHashed: true,
    multipartBoundaryWireBytesHashed: true,
    secretsQueriesRawBodiesExcluded: true,
    dispatchFailureBlocksProviderPost: true,
    submissionReceiptFailureLocksReplay: true,
    replayDoesNotPostProvider: true,
    responseBytesAndHashedAcknowledgementRecorded: true,
    completeRedactedReceiptHashesTamperEvident: true,
    editsWithoutReferenceFailClosedBeforeProviderPost: true,
    upstreamErrorPathsUseSafeSummary: true,
    routeLocalAndWorkflowPostsAudited: true,
    statusReadbackAuthenticatedAndOwnerScoped: true,
    rollbackPreservesEvidence: true,
  },
}, null, 2));
}

void main();
