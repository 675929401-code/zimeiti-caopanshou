import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AUTODL_H3_SELFHOST_IMAGE_ENDPOINT,
  AUTODL_H3_SELFHOST_IMAGE_MODEL,
  isAmbiguousAutodlH3SelfhostTransportError,
  recoverAutodlH3SelfhostCompletedImageResultUrl,
} from "../src/lib/autodl-h3-selfhost";

function signedFixtureUrl(jobId: string, expiresOffsetSeconds = 600) {
  const expires = Math.floor(Date.now() / 1000) + expiresOffsetSeconds;
  return `http://127.0.0.1:16011/v1/files/${jobId}?expires=${expires}&sig=${"a".repeat(64)}`;
}

async function verifyRecoveryIsReadOnly() {
  const jobId = "h3_image_recovery_fixture_001";
  const initialUrl = signedFixtureUrl(jobId, 300);
  const refreshedUrl = signedFixtureUrl(jobId, 600);
  const calls: Array<{ url: string; method: string; hasBody: boolean }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = String(init?.method || "GET").toUpperCase();
    calls.push({ url: String(input), method, hasBody: init?.body != null });
    assert.equal(method, "GET", "recovery may only query an existing gateway job");
    assert.equal(init?.body, undefined, "recovery must never submit a prompt body");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-gateway-key");
    return Response.json({
      id: jobId,
      object: "image.generation",
      model: AUTODL_H3_SELFHOST_IMAGE_MODEL,
      status: "completed",
      data: [{ url: refreshedUrl }],
    });
  };

  const recovered = await recoverAutodlH3SelfhostCompletedImageResultUrl(
    initialUrl,
    AUTODL_H3_SELFHOST_IMAGE_ENDPOINT,
    "fixture-gateway-key",
    { fetchImpl },
  );

  assert.equal(recovered, refreshedUrl);
  assert.deepEqual(calls, [{
    url: `http://127.0.0.1:16011/v1/jobs/${jobId}`,
    method: "GET",
    hasBody: false,
  }]);
}

function verifyAmbiguousTransportClassification() {
  assert.equal(isAmbiguousAutodlH3SelfhostTransportError(
    Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
  ), true);
  assert.equal(isAmbiguousAutodlH3SelfhostTransportError(new Error("invalid PNG signature")), false);
}

function verifyRouteContract() {
  const routeSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/image/generate/route.ts"),
    "utf8",
  );
  assert.match(routeSource, /const AUTODL_H3_IMAGE_RESULT_TIMEOUT_MS = 120_000;/u);

  const h3PersistStart = routeSource.indexOf("for (let index = 0; index < candidates.length; index += 1)");
  const h3PersistEnd = routeSource.indexOf("idempotencyReplayed = exactResult.replayed", h3PersistStart);
  assert.ok(h3PersistStart > 0 && h3PersistEnd > h3PersistStart, "missing exactly-once candidate persistence block");
  const h3PersistBranch = routeSource.slice(h3PersistStart, h3PersistEnd);
  assert.match(h3PersistBranch, /candidate\.provider === AUTODL_H3_SELFHOST_PROVIDER/u);
  assert.match(h3PersistBranch, /imageExactlyOnceStore\.readProviderPersistenceBinding\(\{/u);
  assert.match(h3PersistBranch, /persistenceAttemptId: persistence\.persistenceAttemptId/u);
  assert.match(h3PersistBranch, /apiKey: resolveProviderSecret\(AUTODL_H3_SELFHOST_SECRET_REF\)/u);
  assert.match(h3PersistBranch, /ownedResultRecovery,/u);
  assert.match(h3PersistBranch, /providerUrl: "finalUrl" in imported \? imported\.finalUrl : providerUrl/u);
  assert.doesNotMatch(h3PersistBranch, /persistAutodlH3SelfhostImage\(\{/u);
  // Actual callback + DB-bound held checkpoint + real GET-only selfhost recovery,
  // including ten owner/lease/fingerprint/result negative fixtures. No real I/O.
  const behavior = spawnSync(process.execPath, ["scripts/verify-generated-media-direct-delivery-zero-network.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  assert.equal(behavior.status, 0, behavior.stderr || behavior.stdout);
  const report = JSON.parse(behavior.stdout);
  assert.ok(report.checks.includes("h3-held-checkpoint-get-only-recovery"));
  assert.ok(report.checks.includes("h3-held-checkpoint-owner-lease-fingerprint-negatives"));

  // The established timeout for every pre-existing image provider is unchanged.
  const upstreamFetchStart = routeSource.indexOf("async function fetchImageUpstream");
  const upstreamFetchEnd = routeSource.indexOf("async function loadReferenceImage", upstreamFetchStart);
  const upstreamFetchBlock = routeSource.slice(upstreamFetchStart, upstreamFetchEnd);
  assert.match(upstreamFetchBlock, /timeoutMs = 5 \* 60 \* 1000/u);
  assert.match(upstreamFetchBlock, /AbortSignal\.timeout\(timeoutMs\)/u);
}

function verifyGatewayReplayContract() {
  const gatewaySource = fs.readFileSync(path.resolve(
    process.cwd(),
    "..",
    "..",
    "应用仓库",
    "06_服务器部署",
    "minimax-h3-server-deployment",
    "gateway",
    "app.py",
  ), "utf8");

  const insertBlock = gatewaySource.slice(
    gatewaySource.indexOf("def insert_job("),
    gatewaySource.indexOf("def update_job("),
  );
  assert.match(insertBlock, /if existing:[\s\S]*?return item, False/u);
  assert.match(insertBlock, /request_hash[\s\S]*?status_code=409/u);

  const imageRouteBlock = gatewaySource.slice(
    gatewaySource.indexOf('@app.post("/v1/images/generations"'),
    gatewaySource.indexOf('@app.post("/v1/video/generations"'),
  );
  assert.match(imageRouteBlock, /job, created = insert_job\("image"/u);
  assert.match(imageRouteBlock, /if created:\s+schedule_job\(job\["id"\]\)/u);
  assert.match(imageRouteBlock, /current\["status"\] == "completed"[\s\S]*?return \{/u);
  assert.equal((imageRouteBlock.match(/schedule_job\(/gu) || []).length, 1);

  const getJobBlock = gatewaySource.slice(
    gatewaySource.indexOf('@app.get("/v1/jobs/{job_id}"'),
    gatewaySource.indexOf('@app.get("/v1/files/{job_id}"'),
  );
  assert.match(getJobBlock, /return public_job\(job\)/u);
  assert.doesNotMatch(getJobBlock, /schedule_job|comfy_post|\/prompt/u);
}

async function main() {
  await verifyRecoveryIsReadOnly();
  verifyAmbiguousTransportClassification();
  verifyRouteContract();
  verifyGatewayReplayContract();
  console.log("AutoDL H3 image timeout/replay recovery verification passed (zero network, zero generation, zero DB writes).\n");
}

void main();
