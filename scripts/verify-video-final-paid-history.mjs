import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const origin = process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000";
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const expectedBuild = process.argv.find((value) => value.startsWith("--build="))?.slice(8);
const runDir = path.resolve(process.argv.find((value) => value.startsWith("--run-dir="))?.slice(10) || "");
assert.equal(origin, "http://127.0.0.1:5000");
assert.ok(token, "A verified local administrator session is required");
assert.match(expectedBuild || "", /^[A-Za-z0-9_-]{10,100}$/u);
assert.ok(runDir && path.basename(runDir).startsWith("final-pgr-paid-"), "The frozen final paid run is required");

const headers = { Authorization: `Bearer ${token}` };
const json = async (pathname) => {
  const response = await fetch(`${origin}${pathname}`, { headers, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${pathname} returned HTTP ${response.status}`);
  return body;
};
const readMedia = async (url, label) => {
  const response = await fetch(new URL(url, origin), {
    headers: { ...headers, Range: "bytes=0-4095" },
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
  });
  assert.ok(response.ok || response.status === 206, `${label} returned HTTP ${response.status}`);
  assert.match(response.headers.get("content-type") || "", /video|octet-stream/iu, `${label} is not video`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length > 1_024, `${label} returned incomplete bytes`);
  return {
    http: response.status,
    contentType: response.headers.get("content-type") || "",
    bytes: bytes.length,
    attachment: /attachment/iu.test(response.headers.get("content-disposition") || ""),
  };
};

const version = await json("/api/version");
assert.equal(version.buildId, expectedBuild, "The local build changed after dispatch");
const resultFiles = (await fs.readdir(runDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(runDir, entry.name, "result.json"));
const results = [];
for (const file of resultFiles) {
  try { results.push(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}
assert.equal(results.length, 15, "Expected one frozen result for every originally public model");
assert.ok(results.every((entry) => entry.posts === 1), "A model was not submitted exactly once");
assert.ok(results.every((entry) => entry.routingVerified === true), "A provider routing receipt does not match the selected model");

const historyPayload = await json("/api/video/history?limit=200&offset=0");
const history = Array.isArray(historyPayload?.tasks) ? historyPayload.tasks : [];
const catalogPayload = await json("/api/video/models?surface=video-page");
const currentCatalogIds = new Set((catalogPayload?.models || []).map((model) => model.id));
const report = {
  at: new Date().toISOString(),
  buildId: version.buildId,
  frozenRun: path.relative(process.cwd(), runDir),
  providerPosts: results.reduce((total, entry) => total + Number(entry.posts || 0), 0),
  completed: 0,
  failed: 0,
  historyRecovered: 0,
  playbackVerified: 0,
  downloadVerified: 0,
  hiddenAfterTerminalProviderFailure: false,
  models: [],
  providerRequestsThisVerification: 0,
  databaseWritesThisVerification: 0,
};

for (const result of results) {
  const model = result.selectedModel;
  const row = history.find((entry) => entry.clientRequestId === result.clientRequestId);
  assert.ok(row, `History did not recover ${model.internalId}`);
  assert.equal(row.modelId, model.publicId, `History modelId changed for ${model.internalId}`);
  assert.equal(row.publicModelId, model.publicId, `History publicModelId changed for ${model.internalId}`);
  assert.equal(row.status, result.state, `History status differs for ${model.internalId}`);
  report.historyRecovered += 1;
  const item = {
    internalId: model.internalId,
    publicId: model.publicId,
    status: row.status,
    routingVerified: true,
    persistedPublicModelId: true,
    platformCharge: Number(row.priceCharged || 0),
  };
  assert.equal(item.platformCharge, 0, "The administrator canary unexpectedly charged the station wallet");
  if (row.status === "completed") {
    report.completed += 1;
    assert.ok(row.videoUrl, `Completed history is missing playback URL for ${model.internalId}`);
    item.playback = await readMedia(row.videoUrl, `${model.internalId} playback`);
    report.playbackVerified += 1;
    const ticket = await json(`/api/video/access-ticket?taskId=${encodeURIComponent(row.id)}&scope=download&name=${encodeURIComponent(`${model.internalId}.mp4`)}`);
    assert.ok(ticket?.url, `Download ticket is missing for ${model.internalId}`);
    item.download = await readMedia(ticket.url, `${model.internalId} download`);
    assert.equal(item.download.attachment, true, `Download is not an attachment for ${model.internalId}`);
    report.downloadVerified += 1;
  } else {
    report.failed += 1;
    assert.equal(model.internalId, "veo-3-1-fast-chC", "Unexpected final provider failure");
    assert.match(String(row.errorMessage || ""), /额度|渠道账户/u, "Provider quota failure lost its model-specific message");
    assert.doesNotMatch(String(row.errorMessage || ""), /本站余额|用户余额|充值/u, "Provider quota failure was mislabeled as user balance");
    assert.equal(currentCatalogIds.has(model.publicId), false, "Failed provider remained publicly selectable");
    report.hiddenAfterTerminalProviderFailure = true;
    item.errorCategory = "provider_account_quota";
    item.publiclySelectableAfterFailure = false;
  }
  report.models.push(item);
}

assert.equal(report.completed, 14);
assert.equal(report.failed, 1);
assert.equal(report.historyRecovered, 15);
assert.equal(report.playbackVerified, 14);
assert.equal(report.downloadVerified, 14);
assert.equal(report.hiddenAfterTerminalProviderFailure, true);
report.passed = true;
const output = path.join(runDir, "history-refresh-delivery.json");
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  passed: true,
  buildId: report.buildId,
  providerPosts: report.providerPosts,
  completed: report.completed,
  failed: report.failed,
  historyRecovered: report.historyRecovered,
  playbackVerified: report.playbackVerified,
  downloadVerified: report.downloadVerified,
  failedProviderHidden: report.hiddenAfterTerminalProviderFailure,
  evidence: output,
}));
