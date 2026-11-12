import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
const publicId = "pm_UDGvX0Ba6ijpTEZUitj0-C8l";
assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PREVIEW_REQUIRED");
assert.ok(token && stepUp, "LOCAL_ADMIN_AND_STEP_UP_REQUIRED");
assert.ok(process.argv.includes("--publish"), "Explicit --publish is required");
const headers = {
  Authorization: `Bearer ${token}`,
  "x-admin-step-up": stepUp,
  "Content-Type": "application/json",
};

async function api(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status} ${data.code || data.error || "UNKNOWN"}`);
  return { status: response.status, data };
}

const adminCatalog = await api("/api/admin/video-models");
const candidates = (adminCatalog.data.models || []).filter(row => /Omni/iu.test(String(row.name || ""))
  && /4\s*[-–—~至]\s*10\s*秒/u.test(String(row.name || ""))
  && Number(row.duration_seconds) === 4);
assert.equal(candidates.length, 1, "Expected exactly one evidenced Omni 4-10 second / fixed four-second row");
const model = candidates[0];
const previousName = String(model.name || "").trim();
const correctedName = previousName.replace(/4\s*[-–—~至]\s*10\s*秒/u, "4秒");
assert.notEqual(correctedName, previousName, "The evidenced 4-10 second label was not found; inspect instead of changing another field");
assert.equal(correctedName, "Omni · 4秒 · 720P · Secure Skill Flow 14");
const expectedPublicName = "Omni · 4秒 · 720P · Flow 14";
const publicBefore = await api("/api/video/models?surface=storyboard-workbench");
const before = (publicBefore.data.models || []).find(row => row.id === publicId);
assert.ok(before, "Target Omni model is not present in the public storyboard catalog");
assert.match(String(before.displayName || ""), /4\s*[-–—~至]\s*10\s*秒/u);
assert.deepEqual(before.capabilities.nativeDurations, [4]);
const beforePrice = before.publicPrice;
let releaseId = "";
let previewSha256 = "";
let releaseVersion = null;

const staged = await api("/api/admin/video-models", {
  method: "PUT",
  headers: { "Idempotency-Key": randomUUID() },
  body: JSON.stringify({ id: model.id, name: correctedName }),
});
assert.equal(staged.status, 202);
releaseId = String(staged.data.result?.release?.id || "");
assert.ok(releaseId, "Staged release id is missing");
const validated = await api("/api/admin/model-pool-releases", {
  method: "POST",
  body: JSON.stringify({ action: "validate", releaseId }),
});
assert.equal(validated.data.release?.status, "validated");
const preview = await api(`/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
previewSha256 = String(preview.data.preview?.previewSha256 || "");
assert.match(previewSha256, /^[a-f0-9]{64}$/u);
const published = await api("/api/admin/model-pool-releases", {
  method: "POST",
  body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
});
assert.equal(published.data.release?.status, "published");
releaseVersion = published.data.release?.release_version ?? null;

const publicAfter = await api("/api/video/models?surface=storyboard-workbench");
const after = (publicAfter.data.models || []).find(row => row.id === publicId);
assert.ok(after, "Corrected model disappeared from the public storyboard catalog");
assert.equal(after.displayName, expectedPublicName);
assert.deepEqual(after.capabilities.nativeDurations, [4]);
assert.equal(after.capabilities.defaultDuration, 4);
assert.equal(after.capabilities.minDuration, 4);
assert.equal(after.capabilities.maxDuration, 4);
assert.equal(after.publicPrice, beforePrice);
assert.equal(after.capabilities.available, true);
assert.equal(after.capabilities.generationReady, true);

const report = {
  passed: true,
  at: new Date().toISOString(),
  publicId,
  previousName,
  correctedName,
  fixedDurationSeconds: 4,
  publicPriceUnchanged: after.publicPrice,
  protocolBindingChanged: false,
  providerRequests: 0,
  paidGenerationRequests: 0,
  releaseId,
  previewSha256,
  releaseVersion,
  readback: {
    displayName: after.displayName,
    durationMode: after.capabilities.durationMode,
    nativeDurations: after.capabilities.nativeDurations,
    defaultDuration: after.capabilities.defaultDuration,
    available: after.capabilities.available,
    generationReady: after.capabilities.generationReady,
  },
};
const output = path.resolve(".codex-evidence", "storyboard-delivery-r1850", "omni-fixed-duration-label.json");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...report, evidence: output }));
