#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
const taskId = argument("task-id");
const modelId = argument("model-id");
const evidencePath = argument("evidence");
const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");

assert.match(taskId, /^vt_[a-zA-Z0-9]{8,100}$/u, "VIDEO_TASK_ID_REQUIRED");
assert.ok(modelId, "VIDEO_MODEL_ID_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
assert.ok(evidencePath, "EVIDENCE_PATH_REQUIRED");

const headers = { Authorization: `Bearer ${token}` };
const statusUrl = new URL("/api/video/status", origin);
statusUrl.searchParams.set("taskId", taskId);
statusUrl.searchParams.set("modelId", modelId);
const startedAt = Date.now();
const statusResponse = await fetch(statusUrl, {
  headers,
  cache: "no-store",
  signal: AbortSignal.timeout(90_000),
});
const statusBody = await statusResponse.json();
assert.ok(statusResponse.ok, `VIDEO_STATUS_HTTP_${statusResponse.status}`);
assert.equal(statusBody.status, "completed", "VIDEO_TASK_NOT_COMPLETED");
const playbackPath = String(statusBody.videoUrl || statusBody.storageUrl || "");
assert.ok(playbackPath, "VIDEO_PLAYBACK_URL_MISSING");

const playbackUrl = new URL(playbackPath, origin);
assert.ok(playbackUrl.origin === origin || playbackUrl.protocol === "https:", "VIDEO_PLAYBACK_URL_INVALID");
const playbackResponse = await fetch(playbackUrl, {
  headers: { ...(playbackUrl.origin === origin ? headers : {}), Range: "bytes=0-65535" },
  redirect: "manual",
  signal: AbortSignal.timeout(60_000),
});
const media = Buffer.from(await playbackResponse.arrayBuffer());
const contentType = String(playbackResponse.headers.get("content-type") || "");
const playbackError = playbackResponse.ok ? null : media.toString("utf8", 0, Math.min(media.length, 500))
  .replace(/https?:\/\/\S+/giu, "[url]")
  .replace(/[A-Za-z0-9_-]{40,}/gu, "[redacted]");

const report = {
  checkedAt: new Date().toISOString(),
  taskId,
  modelId,
  noProviderSubmission: true,
  statusHttp: statusResponse.status,
  status: statusBody.status,
  billingState: statusBody.billingState || null,
  priceCharged: Number(statusBody.priceCharged || 0),
  deliveryMode: playbackUrl.origin === origin ? "authenticated-platform-proxy" : "provider-https",
  playback: {
    http: playbackResponse.status,
    contentType,
    bytes: media.length,
    urlSha256: createHash("sha256").update(playbackPath).digest("hex"),
    error: playbackError,
  },
  elapsedMs: Date.now() - startedAt,
};
const absoluteEvidencePath = path.resolve(evidencePath);
await fs.mkdir(path.dirname(absoluteEvidencePath), { recursive: true });
await fs.writeFile(absoluteEvidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
assert.ok(playbackResponse.ok, `VIDEO_PLAYBACK_HTTP_${playbackResponse.status}`);
assert.ok(media.length > 1024, "VIDEO_PLAYBACK_BODY_TOO_SMALL");
assert.match(contentType, /video|octet-stream/iu, "VIDEO_PLAYBACK_CONTENT_TYPE_INVALID");
