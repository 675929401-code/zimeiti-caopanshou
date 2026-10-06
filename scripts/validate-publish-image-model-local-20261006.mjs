#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || "";
const modelId = argument("--model-id");
const promptFile = argument("--prompt-file");
const outputArgument = argument("--output");
const requestedResolution = argument("--resolution");
const requestedAspectRatio = argument("--aspect-ratio") || "16:9";
const executePaidCanary = process.argv.includes("--execute-paid-canary");
const retestReason = argument("--retest-reason") || "图片协议修复后使用新验证键复测原模型";

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PORT_5000_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
assert.ok(stepUpToken, "LOCAL_ADMIN_STEP_UP_TOKEN_REQUIRED");
assert.match(modelId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u, "PRIVATE_IMAGE_MODEL_ID_REQUIRED");
assert.ok(!modelId.startsWith("pm_"), "PRIVATE_IMAGE_MODEL_ID_REQUIRED");
assert.ok(promptFile, "PROMPT_FILE_REQUIRED");
assert.ok(outputArgument, "IMMUTABLE_OUTPUT_REQUIRED");
assert.ok(!requestedResolution || ["1K", "2K", "4K"].includes(requestedResolution), "IMAGE_RESOLUTION_INVALID");
assert.ok(["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4"].includes(requestedAspectRatio), "IMAGE_ASPECT_RATIO_INVALID");

const output = path.resolve(outputArgument);
const evidenceRoot = `${path.resolve(".codex-evidence")}${path.sep}`;
assert.ok(output.startsWith(evidenceRoot), "OUTPUT_MUST_STAY_IN_EVIDENCE_ROOT");
await fs.access(output).then(() => assert.fail("OUTPUT_ALREADY_EXISTS"), () => undefined);
const prompt = (await fs.readFile(path.resolve(promptFile), "utf8")).trim();
assert.ok(prompt.length >= 20 && prompt.length <= 8_000, "PROMPT_LENGTH_INVALID");

const headers = {
  Authorization: `Bearer ${token}`,
  "x-admin-step-up": stepUpToken,
  "Content-Type": "application/json",
};
const report = {
  schema: "image_model_paid_validation_receipt.v1",
  checkedAt: new Date().toISOString(),
  origin,
  modelId,
  promptSource: path.relative(process.cwd(), path.resolve(promptFile)),
  promptSha256: createHash("sha256").update(prompt).digest("hex"),
  historySurface: "storyboard-workbench",
  aspectRatio: requestedAspectRatio,
  paidGenerationRequests: 0,
  providerRequestsExpected: 0,
  publicationRequests: 0,
};

async function requestJson(pathname, options = {}) {
  const startedAt = Date.now();
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    cache: "no-store",
    redirect: "error",
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body, elapsedMs: Date.now() - startedAt };
}

function proofFrom(context) {
  return {
    validationKey: context.validationKey,
    configurationHash: context.configurationHash,
    epoch: context.epoch,
    clientIdempotencyKey: context.validationKey,
    clientTraceId: context.validationKey,
  };
}

async function readContext(reason = "") {
  const query = new URLSearchParams({ modelId });
  if (reason) query.set("retestReason", reason);
  const result = await requestJson(`/api/admin/cover-models/validation?${query}`);
  assert.ok(result.response.ok, `IMAGE_VALIDATION_CONTEXT_FAILED:${result.response.status}:${String(result.body.code || "UNKNOWN")}`);
  return result.body;
}

async function saveVisualAsset(imageUrl) {
  if (!imageUrl) return null;
  let parsed;
  try { parsed = new URL(imageUrl, origin); } catch { return { saved: false, code: "INVALID_ASSET_URL" }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { saved: false, code: "INVALID_ASSET_PROTOCOL" };
  const assetResponse = await fetch(parsed, {
    headers: parsed.origin === origin ? { Authorization: `Bearer ${token}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!assetResponse.ok) return { saved: false, code: `ASSET_HTTP_${assetResponse.status}` };
  const contentType = String(assetResponse.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const extension = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : contentType === "image/jpeg" ? ".jpg" : "";
  if (!extension) return { saved: false, code: "ASSET_CONTENT_TYPE_INVALID" };
  const bytes = Buffer.from(await assetResponse.arrayBuffer());
  if (bytes.length <= 0 || bytes.length > 25 * 1024 * 1024) return { saved: false, code: "ASSET_SIZE_INVALID" };
  const assetPath = output.replace(/\.json$/u, extension);
  assert.notEqual(assetPath, output, "OUTPUT_JSON_EXTENSION_REQUIRED");
  await fs.writeFile(assetPath, bytes, { flag: "wx" });
  return {
    saved: true,
    file: path.relative(process.cwd(), assetPath),
    contentType,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

let context = await readContext();
report.preflight = {
  publicModelId: context.publicModelId || null,
  name: context.name || null,
  modelName: context.modelName || null,
  active: context.active === true,
  hidden: context.hidden === true,
  credentialReady: context.credentialReady === true,
  priceReady: context.priceReady === true,
  acceptance: context.acceptance || null,
  quotedPriceYuan: Number(context.quotedPriceYuan),
  costPriceYuan: Number(context.costPriceYuan),
  epoch: Number(context.epoch),
  busy: context.busy === true,
  existingAttempt: context.existingAttempt || null,
  capabilities: context.capabilities || null,
};
assert.equal(context.credentialReady, true, "IMAGE_MODEL_CREDENTIAL_NOT_READY");
assert.equal(context.priceReady, true, "IMAGE_MODEL_PRICE_NOT_READY");

let proof = proofFrom(context);
const resolution = requestedResolution || context.capabilities?.defaultResolution || "1K";
report.resolution = resolution;
assert.ok((context.capabilities?.resolutionOptions || []).includes(resolution), "IMAGE_RESOLUTION_NOT_ADVERTISED");
let imageRecordId = String(context.existingAttempt?.imageRecordId || "");
const alreadyCompleted = context.existingAttempt?.state === "completed"
  && context.existingAttempt?.requestState === "completed"
  && context.existingAttempt?.deliveryState === "delivered"
  && imageRecordId;

if (!alreadyCompleted) {
  assert.equal(context.busy, false, "IMAGE_VALIDATION_BUSY_DO_NOT_RESUBMIT");
  if (context.canRequestRetest === true) {
    context = await readContext(retestReason);
    proof = proofFrom(context);
    report.retestReason = retestReason;
  }
  assert.equal(executePaidCanary, true, "PAID_CANARY_CONFIRMATION_REQUIRED");
  assert.match(String(context.validationKey || ""), /^iav_[a-f0-9]{64}$/u, "IMAGE_VALIDATION_KEY_REQUIRED");

  report.paidGenerationRequests = 1;
  report.providerRequestsExpected = 1;
  const generationStartedAt = new Date().toISOString();
  const generated = await requestJson("/api/image/generate", {
    method: "POST",
    body: JSON.stringify({
      mode: "local",
      modelId,
      prompt,
      aspectRatio: requestedAspectRatio,
      resolution,
      style: "",
      coverText: "",
      historySurface: "storyboard-workbench",
      noRetry: true,
      strictSingleSubmit: true,
      clientIdempotencyKey: context.validationKey,
      clientTraceId: context.validationKey,
      adminValidation: {
        confirmation: context.confirmation || "RUN_SINGLE_REAL_IMAGE_VALIDATION",
        ...proof,
        ...(report.retestReason ? { retestReason: report.retestReason } : {}),
      },
    }),
    signal: AbortSignal.timeout(13 * 60_000),
  });
  report.generation = {
    startedAt: generationStartedAt,
    completedAt: new Date().toISOString(),
    routeResponseMs: generated.elapsedMs,
    httpStatus: generated.response.status,
    success: generated.body.success === true,
    state: generated.body.status || generated.body.state || null,
    code: generated.body.code || null,
    error: generated.body.error ? String(generated.body.error).slice(0, 240) : null,
    traceIdMatchesValidationKey: generated.body.traceId === context.validationKey,
    modelUsed: generated.body.modelUsed || null,
    resolution: generated.body.resolution || null,
    cashCharged: Number.isFinite(Number(generated.body.cashCharged)) ? Number(generated.body.cashCharged) : null,
    idempotencyReplayed: generated.body.idempotencyReplayed === true,
    assetId: generated.body.images?.[0]?.assetId || null,
    width: Number(generated.body.images?.[0]?.width) || null,
    height: Number(generated.body.images?.[0]?.height) || null,
    dimensionsVerified: generated.body.images?.[0]?.dimensionsVerified === true,
  };
  report.visualAsset = generated.response.ok && generated.body.success === true
    ? await saveVisualAsset(generated.body.images?.[0]?.url)
    : null;
  if (!generated.response.ok || generated.body.success !== true) {
    const failedContext = await readContext();
    report.afterGeneration = {
      acceptance: failedContext.acceptance || null,
      busy: failedContext.busy === true,
      existingAttempt: failedContext.existingAttempt || null,
    };
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    throw new Error(`IMAGE_PAID_VALIDATION_FAILED:${generated.response.status}:${String(generated.body.code || "UNKNOWN")}`);
  }
  const completedContext = await readContext();
  imageRecordId = String(completedContext.existingAttempt?.imageRecordId || "");
  report.afterGeneration = {
    acceptance: completedContext.acceptance || null,
    busy: completedContext.busy === true,
    existingAttempt: completedContext.existingAttempt || null,
  };
  assert.equal(completedContext.existingAttempt?.state, "completed", "IMAGE_VALIDATION_NOT_COMPLETED");
  assert.equal(completedContext.existingAttempt?.deliveryState, "delivered", "IMAGE_VALIDATION_NOT_DELIVERED");
  assert.match(imageRecordId, /^[a-f0-9]{64}$/u, "IMAGE_VALIDATION_RECORD_ID_REQUIRED");
}

report.publicationRequests = 1;
const published = await requestJson("/api/admin/cover-models/validation/publish", {
  method: "POST",
  body: JSON.stringify({
    modelId,
    imageRecordId,
    proof,
    confirmation: "PUBLISH_VALIDATED_IMAGE_MODEL",
  }),
  signal: AbortSignal.timeout(120_000),
});
report.publication = {
  httpStatus: published.response.status,
  elapsedMs: published.elapsedMs,
  success: published.body.success === true,
  alreadyPublished: published.body.alreadyPublished === true,
  modelId: published.body.modelId || null,
  imageRecordId: published.body.imageRecordId || null,
  assetId: published.body.assetId || null,
  code: published.body.code || null,
  error: published.body.error ? String(published.body.error).slice(0, 240) : null,
};
assert.ok(published.response.ok && published.body.success === true, `IMAGE_PUBLICATION_FAILED:${published.response.status}:${String(published.body.code || "UNKNOWN")}`);

const finalContext = await readContext();
report.final = {
  acceptance: finalContext.acceptance || null,
  active: finalContext.active === true,
  hidden: finalContext.hidden === true,
  busy: finalContext.busy === true,
  existingAttempt: finalContext.existingAttempt || null,
};
assert.equal(finalContext.acceptance, "published", "IMAGE_MODEL_NOT_PUBLISHED");

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({
  modelId,
  publicModelId: report.preflight.publicModelId,
  generated: report.generation?.success ?? false,
  routeResponseMs: report.generation?.routeResponseMs ?? 0,
  cashCharged: report.generation?.cashCharged ?? 0,
  published: report.publication.success,
  visualAsset: report.visualAsset?.file || null,
  output,
}));
