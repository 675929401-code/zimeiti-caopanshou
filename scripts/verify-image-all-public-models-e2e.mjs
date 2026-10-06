import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const origin = (process.env.LOCAL_NAV_ORIGIN || process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "Local preview is required");
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9);
const requestedModelId = process.argv.find((value) => value.startsWith("--model-id="))?.slice(11) || "";
const requestedResolution = process.argv.find((value) => value.startsWith("--resolution="))?.slice(13).toUpperCase() || "";
const requestedAspectRatio = process.argv.find((value) => value.startsWith("--aspect-ratio="))?.slice(15) || "1:1";
const requestedPromptFile = process.argv.find((value) => value.startsWith("--prompt-file="))?.slice(14) || "";
const requestedSurface = process.argv.find((value) => value.startsWith("--surface="))?.slice(10) || "storyboard-workbench";
const requestedMaxTotalPublicPrice = Number(process.argv.find((value) => value.startsWith("--max-total-public-price="))?.slice(25) || "0");
assert.match(runId || "", /^[a-zA-Z0-9_-]{6,100}$/u, "A unique --run-id is required");
assert.ok(!requestedResolution || ["1K", "2K", "4K"].includes(requestedResolution), "Requested resolution is invalid");
assert.ok(["16:9", "9:16", "1:1", "4:3", "3:4"].includes(requestedAspectRatio), "Requested aspect ratio is invalid");
assert.ok(["storyboard-workbench", "image-workbench", "cover-studio"].includes(requestedSurface), "Requested image surface is invalid");
assert.ok(Number.isFinite(requestedMaxTotalPublicPrice) && requestedMaxTotalPublicPrice >= 0, "Requested price ceiling is invalid");
const execute = process.argv.includes("--execute");
const promptFilePath = requestedPromptFile ? path.resolve(requestedPromptFile) : "";
if (promptFilePath) {
  const repositoryRoot = `${path.resolve(".")}${path.sep}`;
  assert.ok(promptFilePath.startsWith(repositoryRoot), "Prompt file must stay inside the current repository");
}
const promptBase = promptFilePath
  ? (await fs.readFile(promptFilePath, "utf8")).trim()
  : "商业验收测试图：白色背景上的青色马克杯，画面简洁，无文字。";
assert.ok(promptBase.length >= 10 && promptBase.length <= 5_000, "Prompt file content length is invalid");
const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true);
assert.equal(new URL(runtime.supabaseUrl).hostname, "127.0.0.1");

const outputDir = path.resolve(".codex-evidence/image-all-models-20260904", runId);
await fs.mkdir(outputDir, { recursive: true });
const dispatchPath = path.join(outputDir, "dispatch.json");
const reportPath = path.join(outputDir, "report.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const dbHeaders = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 30_000) });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function rows(table, select, filters = {}) {
  const url = new URL(`${runtime.supabaseUrl.replace(/\/$/u, "")}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, String(value));
  const { response, body } = await json(url, { headers: dbHeaders });
  assert.ok(response.ok && Array.isArray(body), `Local database read failed for ${table}: ${response.status}`);
  return body;
}

const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.ok(token, "A verified local administrator session is required");
const session = await json(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
});
assert.ok(session.response.ok && session.body?.user?.role === "admin", "Local admin session required");
const userId = session.body.user.id;
const authHeaders = { Authorization: `Bearer ${token}` };
const catalogResult = await json(`${origin}/api/cover-models?surface=${encodeURIComponent(requestedSurface)}`, { headers: authHeaders });
assert.ok(catalogResult.response.ok && Array.isArray(catalogResult.body?.models));
const models = catalogResult.body.models;
assert.ok(models.length > 0, "No public image models");
const selectedModels = requestedModelId ? models.filter((model) => model.id === requestedModelId) : models;
assert.ok(selectedModels.length > 0, "Requested public image model is unavailable");

const existingDispatch = await fs.readFile(dispatchPath, "utf8").then(JSON.parse).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
const generatedPlan = selectedModels.map((model, index) => {
  const choices = Array.isArray(model.capabilities?.resolutionOptions) ? model.capabilities.resolutionOptions : [];
  const resolution = requestedResolution || (choices.includes("1K") ? "1K" : choices.includes("2K") ? "2K" : choices[0]);
  assert.ok(["1K", "2K", "4K"].includes(resolution), `No supported resolution for ${model.displayName}`);
  assert.ok(choices.includes(resolution), `${model.displayName} does not declare ${resolution}`);
  return {
    index,
    modelId: model.id,
    displayName: model.displayName,
    publicPrice: model.publicPrice,
    resolution,
    promptSha256: sha256(promptBase),
    clientRequestId: `image-all-${runId}-${index + 1}-${randomUUID()}`,
  };
});
const plan = existingDispatch?.items || generatedPlan;
assert.equal(plan.length, selectedModels.length, "Saved dispatch does not match the selected public catalog size");
for (const [index, item] of plan.entries()) {
  assert.equal(item.modelId, selectedModels[index].id, "Saved dispatch model no longer matches the public catalog");
}
const plannedPublicPriceTotal = Number(plan.reduce((sum, item) => sum + Number(item.publicPrice || 0), 0).toFixed(6));
if (execute) {
  assert.ok(requestedMaxTotalPublicPrice > 0, "A positive --max-total-public-price is required for paid execution");
  assert.ok(plannedPublicPriceTotal <= requestedMaxTotalPublicPrice,
    `Planned public price ${plannedPublicPriceTotal} exceeds ceiling ${requestedMaxTotalPublicPrice}`);
}

if (!execute) {
  console.log(JSON.stringify({ mode: "plan", runId, models: plan.map((item) => ({
    index: item.index,
    modelId: item.modelId,
    displayName: item.displayName,
    publicPrice: item.publicPrice,
    resolution: item.resolution,
    promptSha256: item.promptSha256,
  })), plannedPublicPriceTotal, networkPosts: 0 }, null, 2));
} else {
if (!existingDispatch) await fs.writeFile(dispatchPath, `${JSON.stringify({ runId, createdAt: new Date().toISOString(), items: plan.map((item) => ({
  ...item,
  state: "prepared",
})) }, null, 2)}\n`, { flag: "wx" });

const creditsBefore = await json(`${origin}/api/credits?user_id=${encodeURIComponent(userId)}`, { headers: authHeaders });
const savedReport = await fs.readFile(reportPath, "utf8").then(JSON.parse).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
const results = Array.isArray(savedReport?.results) ? savedReport.results : [];
let stopNewDispatches = false;
for (const item of plan) {
  if (results.some((result) => result.clientRequestId === item.clientRequestId)) continue;
  const payload = {
    // The idempotency/trace key is the non-visible correlation marker. Never append
    // test identifiers to the creative prompt because models may render them.
    prompt: promptBase,
    mode: "local",
    modelId: item.modelId,
    style: "",
    aspectRatio: requestedAspectRatio,
    resolution: item.resolution,
    coverText: "",
    clientTraceId: item.clientRequestId,
    clientIdempotencyKey: item.clientRequestId,
    historySurface: requestedSurface,
  };
  const startedAt = Date.now();
  const requestStartedAt = new Date(startedAt).toISOString();
  let response;
  let body;
  const priorAttempts = await rows("image_generation_requests", "record_id,state,response,delivery_state,delivery_asset_id", {
    user_id: `eq.${userId}`,
    client_idempotency_key: `eq.${item.clientRequestId}`,
    limit: 2,
  });
  if (priorAttempts.length > 1) throw new Error(`Duplicate image request records for ${item.displayName}`);
  const prior = priorAttempts[0];
  if (prior && !(prior.state === "completed" && prior.delivery_state === "delivered" && prior.delivery_asset_id)) {
    results.push({ ...item, ok: false, state: prior.state || "unknown", error: "EXISTING_NONTERMINAL_REQUEST_REQUIRES_RECONCILIATION", providerPosts: 1, runProviderPosts: 0 });
    stopNewDispatches = true;
    await fs.writeFile(reportPath, `${JSON.stringify({ runId, updatedAt: new Date().toISOString(), results }, null, 2)}\n`);
    continue;
  }
  if (stopNewDispatches) {
    results.push({ ...item, ok: false, state: "not-dispatched-after-unresolved-task", providerPosts: 0, runProviderPosts: 0 });
    continue;
  }
  try {
    if (prior) {
      response = { ok: true, status: 200 };
      body = {
        success: true,
        status: "completed",
        images: [{ assetId: prior.delivery_asset_id, url: `/api/storage/files/${prior.delivery_asset_id}/content` }],
        modelIdUsed: item.modelId,
        modelUsed: item.displayName,
        resolution: item.resolution,
        cashCharged: 0,
        idempotencyReplayed: true,
      };
    } else {
      ({ response, body } = await json(`${origin}/api/image/generate`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json", "Idempotency-Key": item.clientRequestId },
        body: JSON.stringify(payload),
        timeoutMs: 360_000,
      }));
    }
  } catch (error) {
    results.push({ ...item, ok: false, state: "unknown", requestStartedAt, responseReceivedAt: null, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.name : "REQUEST_ERROR", providerPosts: 1, runProviderPosts: prior ? 0 : 1 });
    stopNewDispatches = true;
    continue;
  }

  const responseReceivedAt = new Date().toISOString();
  const result = {
    ...item,
    ok: response.ok && body?.success === true && body?.status === "completed",
    state: body?.state || body?.status || (response.ok ? "unknown" : "failed"),
    status: response.status,
    code: body?.code || null,
    error: body?.error || null,
    requestStartedAt,
    responseReceivedAt,
    elapsedMs: Date.now() - startedAt,
    routeResponseMs: Date.now() - startedAt,
    providerPosts: 1,
    runProviderPosts: prior ? 0 : 1,
    modelIdUsed: body?.modelIdUsed || null,
    modelUsed: body?.modelUsed || null,
    resolutionUsed: body?.resolution || null,
    cashCharged: body?.cashCharged ?? null,
    idempotencyReplayed: body?.idempotencyReplayed ?? null,
    asset: null,
    database: null,
    platformReceipt: null,
  };

  const image = Array.isArray(body?.images) ? body.images[0] : null;
  if (result.ok && image?.url && image?.assetId) {
    const assetReadStartedAt = Date.now();
    const imageUrl = new URL(image.url, origin);
    const assetResponse = await fetch(imageUrl, { headers: imageUrl.origin === new URL(origin).origin ? authHeaders : {}, signal: AbortSignal.timeout(60_000) });
    const bytes = Buffer.from(await assetResponse.arrayBuffer());
    assert.ok(assetResponse.ok && bytes.length > 1000 && bytes.length <= 20 * 1024 * 1024, `Invalid image asset for ${item.displayName}`);
    const metadata = await sharp(bytes).metadata();
    assert.ok(metadata.width && metadata.height && metadata.format, `Image decode failed for ${item.displayName}`);
    const file = `image-${String(item.index + 1).padStart(2, "0")}.${metadata.format === "jpeg" ? "jpg" : metadata.format}`;
    await fs.writeFile(path.join(outputDir, file), bytes);
    result.asset = {
      id: image.assetId,
      file,
      bytes: bytes.length,
      sha256: sha256(bytes),
      contentType: assetResponse.headers.get("content-type"),
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    };
    const databaseReadStartedAt = Date.now();
    const attempts = await rows("image_generation_requests", "record_id,state,delivery_state,delivery_asset_id", {
      user_id: `eq.${userId}`,
      client_idempotency_key: `eq.${item.clientRequestId}`,
      limit: 2,
    });
    result.platformReceipt = {
      assetReadbackMs: databaseReadStartedAt - assetReadStartedAt,
      databaseReadbackMs: Date.now() - databaseReadStartedAt,
      verifiedAt: new Date().toISOString(),
    };
    result.database = attempts.length === 1 ? attempts[0] : { rowCount: attempts.length };
    result.ok = result.ok
      && attempts.length === 1
      && attempts[0].state === "completed"
      && attempts[0].delivery_state === "delivered"
      && attempts[0].delivery_asset_id === image.assetId;
  }
  results.push(result);
  await fs.writeFile(reportPath, `${JSON.stringify({ runId, updatedAt: new Date().toISOString(), results }, null, 2)}\n`);
}

const creditsAfter = await json(`${origin}/api/credits?user_id=${encodeURIComponent(userId)}`, { headers: authHeaders });
const report = {
  runId,
  checkedAt: new Date().toISOString(),
  publicModelCount: models.length,
  tested: results.length,
  passed: results.filter((item) => item.ok).length,
  failed: results.filter((item) => !item.ok).length,
  providerPosts: results.reduce((sum, item) => sum + item.providerPosts, 0),
  runProviderPosts: results.reduce((sum, item) => sum + (item.runProviderPosts || 0), 0),
  adminBalanceBefore: creditsBefore.body ? { credits: creditsBefore.body.credits, cashBalance: creditsBefore.body.cash_balance } : null,
  adminBalanceAfter: creditsAfter.body ? { credits: creditsAfter.body.credits, cashBalance: creditsAfter.body.cash_balance } : null,
  promptSource: promptFilePath ? path.relative(path.resolve("."), promptFilePath) : "built-in",
  promptSha256: sha256(promptBase),
  surface: requestedSurface,
  maxTotalPublicPrice: requestedMaxTotalPublicPrice,
  plannedPublicPriceTotal,
  visiblePromptTestMarkers: 0,
  results,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ runId, publicModelCount: report.publicModelCount, tested: report.tested, passed: report.passed, failed: report.failed, providerPosts: report.providerPosts, runProviderPosts: report.runProviderPosts, report: reportPath }));
if (report.failed) process.exitCode = 1;
}
