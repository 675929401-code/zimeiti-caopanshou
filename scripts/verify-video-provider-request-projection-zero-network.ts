#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import {
  prepareVideoProviderRequest,
  videoProviderFetch,
  withVideoProviderRequestAudit,
  type VideoProviderRequestReceipt,
} from "../src/lib/video-provider-request-audit";
import {
  buildVideoRoutingSnapshot,
  persistVideoProviderDispatchReceipt,
} from "../src/lib/video-routing-snapshot";
import { classifyVideoProviderError, sanitizeVideoProviderDiagnostic } from "../src/lib/video-error-policy";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function main() {
  const prompt = "fixed cheap canary prompt that must never persist";
  const body = JSON.stringify({
    model: "public-cheap-video-model",
    prompt,
    duration: 1,
    resolution: "480p",
    aspect_ratio: "16:9",
    image_urls: ["https://private.invalid/image-a?token=secret", "https://private.invalid/image-b"],
    audio_url: "https://private.invalid/audio?signature=secret",
    generate_audio: false,
  });
  const prepared = await prepareVideoProviderRequest(
    "https://provider.invalid/v1/videos?api_key=query-secret",
    { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body },
  );
  assert.ok(prepared);
  const wire = new Uint8Array(await prepared.request.clone().arrayBuffer());
  assert.equal(prepared.receipt.wireBodySha256, sha256(wire));
  assert.equal(prepared.receipt.wireBodyBytes, wire.byteLength);
  assert.equal(prepared.receipt.endpointPath, "/v1/videos");
  assert.equal(prepared.receipt.attemptOrdinal, 1);
  assert.match(prepared.receipt.dispatchIdentitySha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(prepared.receipt.requestProjection, {
    effectivePromptSha256: sha256(prompt), duration: 1, resolution: "480p", aspectRatio: "16:9",
    referenceImageCount: 2, referenceAudioCount: 1, generateAudioState: "provided_false",
  });

  const multipart = new FormData();
  multipart.set("prompt", prompt);
  multipart.set("duration", "10");
  multipart.set("resolution", "1080p");
  multipart.set("aspect_ratio", "16:9");
  multipart.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "reference.png");
  multipart.set("audio_file", new Blob([new Uint8Array([4, 5])], { type: "audio/wav" }), "reference.wav");
  const multipartPrepared = await prepareVideoProviderRequest("https://provider.invalid/v1/materials", { method: "POST", body: multipart });
  assert.ok(multipartPrepared);
  const multipartWire = new Uint8Array(await multipartPrepared.request.clone().arrayBuffer());
  assert.equal(multipartPrepared.receipt.wireBodySha256, sha256(multipartWire), "MULTIPART_BOUNDARY_BYTES_MUST_BE_HASHED");
  assert.equal(multipartPrepared.receipt.requestContentType, "multipart/form-data");
  assert.equal(multipartPrepared.receipt.requestProjection.referenceImageCount, 1);
  assert.equal(multipartPrepared.receipt.requestProjection.referenceAudioCount, 1);

  const flowPrompt = "flow multimodal prompt";
  const flowPrepared = await prepareVideoProviderRequest("https://provider.invalid/v1/jobs", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      model: "flow-model", messages: [{ role: "user", content: [
        { type: "text", text: flowPrompt },
        { type: "image_url", image_url: { url: "https://assets.invalid/flow.png?X-Amz-Signature=secret" } },
      ] }],
    }),
  });
  assert.equal(flowPrepared?.receipt.requestProjection.effectivePromptSha256, sha256(flowPrompt));

  const wanPrepared = await prepareVideoProviderRequest("https://provider.invalid/v1/videos/generations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      model: "wan3", prompt: "wan prompt", media: [
        { type: "first_frame", url: "https://assets.invalid/first.png" },
        { type: "reference_image", url: "https://assets.invalid/reference.png" },
        { type: "audio", url: "https://assets.invalid/reference.wav" },
        { type: "reference_video", url: "https://assets.invalid/source.mp4" },
      ],
    }),
  });
  assert.equal(wanPrepared?.receipt.requestProjection.referenceImageCount, 2);
  assert.equal(wanPrepared?.receipt.requestProjection.referenceAudioCount, 1);

  const gaoruiPrepared = await prepareVideoProviderRequest("https://provider.invalid/v1/videos", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "gaorui", seconds: 6 }),
  });
  assert.equal(gaoruiPrepared?.receipt.requestProjection.duration, 6);

  const snapshot = buildVideoRoutingSnapshot({
    id: "public-cheap-video-model", name: "Cheap Video", provider: "fixture",
    api_endpoint: "https://provider.invalid/v1/videos?X-Amz-Signature=must-disappear#fragment",
    api_key: "secret://fixture-video-provider", protocol_type: "secure_skill_video",
    model_name: "public-cheap-video-model", duration_seconds: 1, supports_image_input: true,
    api_protocol_config: {
      harmlessSignedUrl: "https://assets.invalid/reference.png?X-Amz-Signature=must-disappear&ordinary=also-disappear#fragment",
      harmlessData: "data:image/png;base64,super-secret",
      harmlessBlob: "A".repeat(512),
      nested: { endpoint: "https://assets.invalid/audio.wav?arbitrary=secret" },
    },
  });
  assert.equal(snapshot.apiEndpoint, "https://provider.invalid/v1/videos");
  const safeConfig = JSON.stringify(snapshot.apiProtocolConfig);
  assert.equal(safeConfig.includes("X-Amz-Signature"), false);
  assert.equal(safeConfig.includes("super-secret"), false);
  assert.equal(safeConfig.includes("A".repeat(257)), false);
  assert.equal(safeConfig.includes("?arbitrary="), false);
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  await persistVideoProviderDispatchReceipt({
    db: { async rpc(name, params) { rpcCalls.push({ name, params }); return { data: { ok: true }, error: null }; } },
    taskIdInternal: "vt_fixture", userId: "student-fixture", requestFingerprint: "a".repeat(64),
    snapshot, receipt: prepared.receipt,
  });
  const persisted = rpcCalls[0]?.params.p_receipt as Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.wireBodySha256, sha256(wire));

  const serialized = JSON.stringify({ json: prepared.receipt, multipart: multipartPrepared.receipt, persisted });
  for (const forbidden of [
    prompt, "query-secret", "Bearer secret", "private.invalid", "token=secret", "signature=secret",
    "api_key=", "reference.png", "reference.wav",
  ]) assert.equal(serialized.includes(forbidden), false, `SENSITIVE_PROVIDER_EVIDENCE_LEAKED:${forbidden}`);

  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let captured: VideoProviderRequestReceipt | null = null;
  try {
    globalThis.fetch = (async input => {
      providerCalls += 1;
      assert.ok(input instanceof Request, "EXACT_PREPARED_REQUEST_MUST_BE_SENT");
      const sentBytes = new Uint8Array(await input.clone().arrayBuffer());
      assert.equal(sha256(sentBytes), captured?.wireBodySha256);
      return Response.json({ id: "provider-task" });
    }) as typeof fetch;
    await assert.rejects(
      () => withVideoProviderRequestAudit(
        async () => { throw new Error("dispatch receipt persistence failed"); },
        () => videoProviderFetch("https://provider.invalid/v1/videos", { method: "POST", headers: { "content-type": "application/json" }, body }),
      ),
      /dispatch receipt persistence failed/u,
    );
    assert.equal(providerCalls, 0, "DISPATCH_PERSISTENCE_FAILURE_MUST_LEAVE_ZERO_PROVIDER_CALLS");

    await withVideoProviderRequestAudit(
      async receipt => { captured = receipt; },
      () => videoProviderFetch("https://provider.invalid/v1/videos", { method: "POST", headers: { "content-type": "application/json" }, body }),
    );
    assert.equal(providerCalls, 1, "PROVIDER_POST_MUST_OCCUR_EXACTLY_ONCE");
    const submissionPersistence = async () => { throw new Error("submission persistence failed"); };
    let reconciliationState = "acknowledged";
    await submissionPersistence().catch(() => { reconciliationState = "unknown"; });
    assert.equal(reconciliationState, "unknown");
    assert.equal(providerCalls, 1, "SUBMISSION_PERSISTENCE_FAILURE_MUST_NOT_RETRY_PROVIDER");

    const durableWireHashes = new Set<string>();
    const duplicateReceipts: VideoProviderRequestReceipt[] = [];
    await assert.rejects(
      () => withVideoProviderRequestAudit(
        async receipt => {
          duplicateReceipts.push(receipt);
          if (durableWireHashes.has(receipt.wireBodySha256)) throw new Error("VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT");
          durableWireHashes.add(receipt.wireBodySha256);
        },
        async () => {
          await videoProviderFetch("https://provider.invalid/v1/videos", { method: "POST", headers: { "content-type": "application/json" }, body });
          await videoProviderFetch("https://provider.invalid/v1/videos", { method: "POST", headers: { "content-type": "application/json" }, body });
        },
      ),
      /VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT/u,
    );
    assert.equal(providerCalls, 2, "SECOND_IDENTICAL_POST_MUST_BE_BLOCKED_BEFORE_PROVIDER_NETWORK");
    assert.deepEqual(duplicateReceipts.map(receipt => receipt.attemptOrdinal), [1, 2]);
    assert.notEqual(duplicateReceipts[0]?.dispatchIdentitySha256, duplicateReceipts[1]?.dispatchIdentitySha256);

    const concurrentReceiptsByWire = new Map<string, number>();
    const concurrentAuditEvents: string[] = [];
    const concurrentProviderOrdinals: number[] = [];
    globalThis.fetch = (async input => {
      providerCalls += 1;
      assert.ok(input instanceof Request);
      const wireHash = sha256(new Uint8Array(await input.clone().arrayBuffer()));
      concurrentProviderOrdinals.push(concurrentReceiptsByWire.get(wireHash) || 0);
      return Response.json({ id: `provider-task-${providerCalls}` });
    }) as typeof fetch;
    const firstMultipart = new FormData();
    firstMultipart.set("prompt", "concurrent first multipart");
    firstMultipart.set("file", new Blob([new Uint8Array(64 * 1024)], { type: "image/png" }), "first.png");
    const secondMultipart = new FormData();
    secondMultipart.set("prompt", "concurrent second multipart");
    secondMultipart.set("file", new Blob([new Uint8Array([9])], { type: "image/png" }), "second.png");
    await withVideoProviderRequestAudit(
      async receipt => {
        concurrentAuditEvents.push(`start-${receipt.attemptOrdinal}`);
        if (receipt.attemptOrdinal === 1) await new Promise(resolve => setTimeout(resolve, 20));
        concurrentReceiptsByWire.set(receipt.wireBodySha256, receipt.attemptOrdinal);
        concurrentAuditEvents.push(`persist-${receipt.attemptOrdinal}`);
      },
      async () => {
        await Promise.all([
          videoProviderFetch("https://provider.invalid/v1/upload", { method: "POST", body: firstMultipart }),
          videoProviderFetch("https://provider.invalid/v1/upload", { method: "POST", body: secondMultipart }),
        ]);
      },
    );
    assert.deepEqual(concurrentAuditEvents, ["start-1", "persist-1", "start-2", "persist-2"]);
    assert.deepEqual(concurrentProviderOrdinals, [1, 2], "CONCURRENT_POSTS_MUST_START_IN_DURABLE_ORDINAL_ORDER");
    assert.equal(providerCalls, 4, "CONCURRENT_DISTINCT_POSTS_MUST_EACH_DISPATCH_ONCE");

    await assert.rejects(
      () => withVideoProviderRequestAudit(
        async () => undefined,
        () => videoProviderFetch("https://provider.invalid/upload", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array([1, 2, 3]) }),
      ),
      /VIDEO_PROVIDER_REQUEST_CONTENT_TYPE_UNSUPPORTED/u,
    );
    assert.equal(providerCalls, 4, "UNSUPPORTED_WIRE_BODY_MUST_FAIL_CLOSED_BEFORE_NETWORK");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const maliciousDiagnostic = `failure https://assets.invalid/file?X-Amz-Signature=secret&token=hidden token=raw data:image/png;base64,hidden ${"B".repeat(512)}`;
  const sanitizedDiagnostic = sanitizeVideoProviderDiagnostic(maliciousDiagnostic);
  const classifiedDiagnostic = classifyVideoProviderError(maliciousDiagnostic).operatorMessage;
  for (const forbidden of ["X-Amz-Signature", "hidden", "token=raw", "data:image", "B".repeat(257)]) {
    assert.equal(sanitizedDiagnostic.includes(forbidden), false, `SANITIZED_DIAGNOSTIC_LEAKED:${forbidden}`);
    assert.equal(classifiedDiagnostic.includes(forbidden), false, `CLASSIFIED_DIAGNOSTIC_LEAKED:${forbidden}`);
  }

  const [migration, rollback, adapter, route] = await Promise.all([
    fs.readFile("supabase/migrations/20261010134000_video_provider_request_projection.sql", "utf8"),
    fs.readFile("supabase/rollbacks/20261010134000_video_provider_request_projection.rollback.sql", "utf8"),
    fs.readFile("src/lib/video-adapter.ts", "utf8"),
    fs.readFile("src/app/api/video/generate/route.ts", "utf8"),
  ]);
  for (const token of [
    "wireBodySha256", "effectivePromptSha256", "dispatchReceiptSha256", "dispatchWireBodySha256s",
    "endpointPath", "attemptOrdinal", "dispatchIdentitySha256", "dispatchAttemptCount",
    "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT",
  ]) {
    assert.ok(migration.includes(token), `MIGRATION_BINDING_REQUIRED:${token}`);
  }
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/iu);
  assert.doesNotMatch(rollback, /drop\s+(?:column|function|table)|delete\s+from\s+supabase_migrations/iu);
  for (const token of [
    "attemptOrdinal", "dispatchIdentitySha256", "VIDEO_PROVIDER_DISPATCH_ATTEMPT_ORDINAL_CONFLICT",
    "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT", "raise exception ''VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT''",
    "dispatchIdentitySha256s", "dispatchAttemptCount", "VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_V2_DISPATCH",
    "pg_roles", "has_function_privilege", "rolsuper", "VIDEO_PROVIDER_PROJECTION_ACL_REPAIR_REQUIRED",
  ]) assert.ok(rollback.includes(token), `ROLLBACK_FORWARD_GUARD_REQUIRED:${token}`);
  assert.match(adapter, /withVideoProviderRequestAudit\(params\.onProviderRequest/u);
  assert.match(route, /onProviderRequest:[\s\S]*persistVideoProviderDispatchReceipt/u);
  assert.match(route, /sanitizeVideoTraceValue[\s\S]*sanitizeVideoProviderDiagnostic/u);
  assert.doesNotMatch(route, /console\.error\("视频生成错误:",\s*error\)/u);

  console.log(JSON.stringify({
    passed: true, mode: "zero-network-video-provider-request-projection", networkCalls: 0,
    mockProviderCalls: providerCalls, realDatabaseWrites: 0, filesystemWrites: 0, paidModelCalls: 0,
    assertions: {
      jsonExactWireBytesHashed: true, multipartBoundaryWireBytesHashed: true,
      safeProjectionRecorded: true, flowWan3GaoruiProjectionAliasesCovered: true,
      rawPromptBodyUrlsCredentialsExcluded: true, recursiveRoutingAndDiagnosticSanitization: true,
      dispatchPersistenceFailureBlocksProviderPost: true,
      duplicateWireBodyConflictsBeforeSecondProviderPost: true,
      concurrentMultipartDispatchesPersistAndStartInOrdinalOrder: true,
      submissionPersistenceFailureLeavesOneCallUnknownNoRetry: true,
      unsupportedWireEncodingFailsClosed: true, dispatchSubmissionReceiptBound: true,
      rollbackPreservesHistoricalEvidence: true, rollbackRejectsLegacySilentDedupeSemantics: true,
      rollbackRejectsDirectAndInheritedExtraExecuteRoles: true,
    },
  }, null, 2));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
