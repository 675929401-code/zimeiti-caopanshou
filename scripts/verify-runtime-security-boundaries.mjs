#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const parsedBase = new URL(baseUrl);
assert.ok(
  parsedBase.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsedBase.hostname),
  "runtime security verifier is restricted to a loopback preview",
);

const browserHeaders = {
  "user-agent": "Mozilla/5.0 CodexSecurityBoundaryVerifier",
  origin: baseUrl,
};

const protectedReads = [
  "/api/conversations/history",
  "/api/cover/history",
  "/api/digital-human/long-history",
  "/api/extract/history",
  "/api/formatter/history",
  "/api/media-history",
  "/api/media-history/content?id=fixture",
  "/api/segmenter/history",
  "/api/storage/files/fixture/content",
  "/api/video/history",
  "/api/voice/history",
  "/api/admin/users",
  "/api/admin/payment-orders",
  "/api/admin/security-events",
  "/api/admin/voice-studio/models",
  "/api/short-drama/projects",
  "/api/digital-human/long-download?jobId=fixture",
  "/api/extract/download?url=https%3A%2F%2Fv.douyin.com%2Ffixture",
];

const protectedWrites = [
  "/api/upload",
  "/api/storage/upload",
  "/api/voice/upload",
  "/api/video/reference-upload",
  "/api/bridge/upload",
  "/api/digital-human/upload",
  "/api/digital-human/upload-ticket",
  "/api/digital-human/upload-session",
  "/api/payment/refund",
];

async function request(pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    ...init,
    headers: { ...browserHeaders, ...(init.headers || {}) },
  });
  return {
    pathname,
    method: init.method || "GET",
    status: response.status,
    contentType: response.headers.get("content-type") || "",
  };
}

const results = [];
for (const pathname of protectedReads) results.push(await request(pathname));
for (const pathname of protectedWrites) {
  results.push(await request(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
}

const restore = await request("/api/restore/bootstrap?restore_token=fixture");
results.push(restore);
assert.equal(restore.status, 404, "legacy recovery endpoint must remain unavailable even with a query token");

const oversizedCallback = await request("/api/payment/notify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "x".repeat(64 * 1024 + 1),
});
results.push(oversizedCallback);
assert.equal(oversizedCallback.status, 413, "oversized payment callback must fail before signature or database work");

const unauthorized = new Set([401, 403, 404]);
const exposed = results.filter((entry) => (
  protectedReads.includes(entry.pathname) || protectedWrites.includes(entry.pathname)
) && !unauthorized.has(entry.status));
assert.deepEqual(exposed, [], `protected endpoints returned an unsafe anonymous status: ${JSON.stringify(exposed)}`);

const outputDirectory = path.join(process.cwd(), ".codex-evidence", "runtime-security-boundaries-20260904");
await fs.mkdir(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, "report.json");
await fs.writeFile(output, `${JSON.stringify({
  observedAt: new Date().toISOString(),
  baseUrl,
  protectedReadCount: protectedReads.length,
  protectedWriteCount: protectedWrites.length,
  upstreamProviderRequests: 0,
  paidTasksCreated: 0,
  authenticatedBusinessWrites: 0,
  results,
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  passed: true,
  protectedReads: protectedReads.length,
  protectedWrites: protectedWrites.length,
  restoreStatus: restore.status,
  oversizedCallbackStatus: oversizedCallback.status,
  output,
}, null, 2));
