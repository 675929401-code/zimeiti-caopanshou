import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const execute = process.argv.includes("--execute");
const confirmed = process.argv.includes("--confirm-paid-provider-calls");
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const outputDir = path.resolve(".codex-evidence", "gpt-image2-three-groups-live", runId);

const configuredModels = [
  {
    id: "pending-cover-model-gpt-image-2-image-2-1k",
    group: "image-2-1k",
    resolutions: ["1K"],
    expectedPrices: { "1K": 0.1 },
    prompt: "白色摄影棚背景，左侧只有一个红色立方体，右侧只有一个蓝色球体，中间留出明显空白，柔和自然阴影，干净的商业产品摄影，不要文字，不要水印",
  },
  {
    id: "pending-cover-model-gpt-image-2-official",
    group: "image2-官key",
    resolutions: ["1K", "2K", "4K"],
    expectedPrices: { "1K": 0.2, "2K": 0.2, "4K": 0.3 },
    prompt: "白色摄影棚背景，左侧只有一个黄色圆锥体，右侧只有一个绿色圆柱体，中间留出明显空白，柔和自然阴影，干净的商业产品摄影，不要文字，不要水印",
  },
  {
    id: "pending-cover-model-gpt-image-2-adobe-mid",
    group: "adobe-image2-mid",
    resolutions: ["1K", "2K"],
    expectedPrices: { "1K": 0.1, "2K": 0.1 },
    prompt: "白色摄影棚背景，左侧只有一个紫色三棱柱，右侧只有一个橙色圆环，中间留出明显空白，柔和自然阴影，干净的商业产品摄影，不要文字，不要水印",
  },
];

const requestedIds = new Set(String(process.argv.find((value) => value.startsWith("--models=")) || "")
  .slice("--models=".length)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const models = requestedIds.size > 0
  ? configuredModels.filter((model) => requestedIds.has(model.id))
  : configuredModels;
const retestRejected = process.argv.includes("--retest-rejected");
const requestedRetestReason = String(process.argv.find((value) => value.startsWith("--retest-reason=")) || "")
  .slice("--retest-reason=".length)
  .trim();

function safeMessage(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/giu, "[url-redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "[credential-redacted]")
    .replace(/\bBearer\s+\S+/giu, "[credential-redacted]")
    .slice(0, 500);
}

async function request(pathname, options = {}, timeoutMs = 240_000) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function requiredJson(pathname, options, timeoutMs) {
  const result = await request(pathname, options, timeoutMs);
  assert.ok(result.response.ok, safeMessage(result.body.error || `${pathname} returned ${result.response.status}`));
  return result.body;
}

function validationProof(context) {
  assert.match(String(context.validationKey || ""), /^iav_[a-f0-9]{64}$/u, "IMAGE_VALIDATION_KEY_MISSING");
  assert.match(String(context.configurationHash || ""), /^[a-f0-9]{64}$/u, "IMAGE_CONFIGURATION_HASH_MISSING");
  assert.ok(Number.isSafeInteger(context.epoch) && context.epoch >= 0, "IMAGE_VALIDATION_EPOCH_INVALID");
  assert.equal(context.clientIdempotencyKey, context.validationKey);
  assert.equal(context.clientTraceId, context.validationKey);
  return {
    validationKey: context.validationKey,
    configurationHash: context.configurationHash,
    epoch: context.epoch,
    clientIdempotencyKey: context.validationKey,
    clientTraceId: context.validationKey,
  };
}

function priceMap(publicModel) {
  return Object.fromEntries((publicModel?.capabilities?.resolutionPrices || []).map((entry) => {
    const [resolution, price] = String(entry).split("=", 2);
    return [resolution.trim().toUpperCase(), Number(price)];
  }));
}

async function saveOwnedImage(assetId, fileBase) {
  assert.match(String(assetId || ""), /^[A-Za-z0-9_-]{1,160}$/u, "IMAGE_ASSET_ID_INVALID");
  const response = await fetch(`${origin}/api/storage/files/${encodeURIComponent(assetId)}/content?download=1`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  assert.ok(response.ok && ["image/png", "image/jpeg", "image/webp"].includes(contentType), `IMAGE_ASSET_READ_FAILED_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 10_000 && bytes.length <= 30 * 1024 * 1024, "IMAGE_ASSET_SIZE_INVALID");
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice(6);
  const file = path.join(outputDir, `${fileBase}.${extension}`);
  await writeFile(file, bytes);
  return { file, contentType, bytes: bytes.length };
}

async function publicReadback(expected) {
  const [storyboard, imageWorkbench] = await Promise.all([
    requiredJson("/api/cover-models?surface=storyboard-workbench"),
    requiredJson("/api/cover-models?surface=image-workbench"),
  ]);
  const storyboardModel = storyboard.models?.find((entry) => entry.id === expected.publicId);
  const imageWorkbenchModel = imageWorkbench.models?.find((entry) => entry.id === expected.publicId);
  assert.ok(storyboardModel && imageWorkbenchModel, `MODEL_NOT_PUBLIC_ON_BOTH_WORKBENCHES:${expected.id}`);
  assert.equal(storyboardModel.capabilities?.available, true, `MODEL_NOT_GENERATION_READY:${expected.id}`);
  assert.deepEqual(priceMap(storyboardModel), expected.expectedPrices, `PUBLIC_PRICE_TIERS_MISMATCH:${expected.id}`);
  return {
    publicId: expected.publicId,
    storyboardVisible: true,
    imageWorkbenchVisible: true,
    displayName: storyboardModel.displayName,
    prices: priceMap(storyboardModel),
  };
}

async function validateAndPublish(model) {
  let context = await requiredJson(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(model.id)}`);
  assert.equal(context.success, true);
  assert.equal(context.modelId, model.id);
  assert.equal(context.modelName, "gpt-image-2");
  assert.equal(context.credentialReady, true, `CREDENTIAL_NOT_READY:${model.id}`);
  assert.equal(context.priceReady, true, `PRICE_NOT_READY:${model.id}`);
  assert.deepEqual(context.capabilities?.resolutionOptions, model.resolutions);
  let retestReason = "";
  if (context.existingAttempt?.state === "rejected" && retestRejected) {
    retestReason = requestedRetestReason || "响应协议修复后复测原明确拒绝的生成配置";
    assert.ok(retestReason.length >= 8 && retestReason.length <= 300, "RETEST_REASON_LENGTH_INVALID");
    context = await requiredJson(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(model.id)}&retestReason=${encodeURIComponent(retestReason)}`);
    assert.equal(context.success, true);
    assert.equal(context.epoch > 0, true, `RETEST_EPOCH_NOT_ADVANCED:${model.id}`);
  }
  const expected = { ...model, publicId: context.publicModelId };
  let generationPosts = 0;
  let reusedExistingAttempt = false;
  let resultAssetId = String(context.existingAttempt?.assetId || "");
  let imageRecordId = String(context.existingAttempt?.imageRecordId || "");
  let adminCashCharged = 0;

  if (context.acceptance !== "published" || context.active !== true || context.hidden !== false) {
    const proof = validationProof(context);
    if (context.busy && !context.existingAttempt) throw new Error(`UNRESOLVED_VALIDATION_OWNED_ELSEWHERE:${model.id}`);
    if (!context.existingAttempt) {
      const body = {
        prompt: model.prompt,
        modelId: model.id,
        mode: "local",
        style: "",
        coverText: "",
        aspectRatio: "1:1",
        resolution: "1K",
        referenceImageUrls: [],
        clientIdempotencyKey: proof.validationKey,
        clientTraceId: proof.validationKey,
        noRetry: true,
        strictSingleSubmit: true,
        adminValidation: { confirmation: context.confirmation, ...proof, ...(retestReason ? { retestReason } : {}) },
      };
      generationPosts += 1;
      const generated = await request("/api/image/generate", { method: "POST", body: JSON.stringify(body) }, 210_000);
      if (!generated.response.ok) {
        throw new Error(`CANARY_FAILED_${generated.response.status}:${safeMessage(generated.body.error || generated.body.code)}`);
      }
      assert.equal(generated.body.status, "completed", `CANARY_NOT_TERMINAL:${model.id}`);
      adminCashCharged = Number(generated.body.cashCharged);
      assert.equal(adminCashCharged, model.expectedPrices["1K"], `ADMIN_CANARY_CHARGE_MISMATCH:${model.id}`);
      assert.equal(generated.body.resolution, "1K");
      resultAssetId = String(generated.body.images?.[0]?.assetId || "");
    } else if (context.existingAttempt.state === "rejected") {
      throw new Error(`PREVIOUS_CANARY_REJECTED_NO_AUTOMATIC_RETRY:${model.id}`);
    } else {
      reusedExistingAttempt = true;
    }

    context = await requiredJson(`/api/admin/cover-models/validation?modelId=${encodeURIComponent(model.id)}`);
    imageRecordId = String(context.existingAttempt?.imageRecordId || imageRecordId);
    resultAssetId = String(context.existingAttempt?.assetId || resultAssetId);
    assert.match(imageRecordId, /^[a-f0-9]{64}$/u, `CANARY_RECORD_ID_MISSING:${model.id}`);
    assert.ok(["completed", "published"].includes(String(context.existingAttempt?.state || "")), `CANARY_EVIDENCE_NOT_COMPLETE:${model.id}`);
    assert.ok(resultAssetId, `CANARY_ASSET_MISSING:${model.id}`);

    const published = await requiredJson("/api/admin/cover-models/validation/publish", {
      method: "POST",
      body: JSON.stringify({
        modelId: model.id,
        imageRecordId,
        proof,
        confirmation: "PUBLISH_VALIDATED_IMAGE_MODEL",
      }),
    }, 90_000);
    assert.equal(published.success, true, `PUBLICATION_FAILED:${model.id}`);
  } else {
    // A previously published group still receives one fresh strict request for
    // this run. It uses a unique key and cannot silently retry upstream.
    const requestKey = `gpt2check_${randomUUID().replaceAll("-", "")}`;
    generationPosts += 1;
    const generated = await request("/api/image/generate", {
      method: "POST",
      body: JSON.stringify({
        prompt: model.prompt,
        modelId: context.publicModelId,
        mode: "local",
        style: "",
        coverText: "",
        aspectRatio: "1:1",
        resolution: "1K",
        referenceImageUrls: [],
        clientIdempotencyKey: requestKey,
        clientTraceId: requestKey,
        noRetry: true,
        strictSingleSubmit: true,
        historySurface: "storyboard-workbench",
      }),
    }, 210_000);
    if (!generated.response.ok) throw new Error(`PUBLIC_CANARY_FAILED_${generated.response.status}:${safeMessage(generated.body.error || generated.body.code)}`);
    assert.equal(generated.body.status, "completed");
    adminCashCharged = Number(generated.body.cashCharged);
    assert.equal(adminCashCharged, model.expectedPrices["1K"], `ADMIN_PUBLIC_CANARY_CHARGE_MISMATCH:${model.id}`);
    resultAssetId = String(generated.body.images?.[0]?.assetId || "");
  }

  assert.ok(generationPosts === 1 || (generationPosts === 0 && reusedExistingAttempt),
    `AT_MOST_ONE_GENERATION_POST_REQUIRED:${model.id}`);
  const asset = await saveOwnedImage(resultAssetId, model.group.replace(/[^a-z0-9_-]/giu, "-"));
  const publishedState = await publicReadback(expected);
  return {
    id: model.id,
    group: model.group,
    publicId: context.publicModelId,
    generationPosts,
    reusedExistingAttempt,
    maximumUpstreamSubmissions: 1,
    adminCashCharged,
    imageRecordId: imageRecordId || null,
    assetId: resultAssetId,
    asset,
    publishedState,
  };
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PORT_5000_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  assert.ok(models.length > 0, "NO_MATCHING_GPT_IMAGE2_GROUPS");
  assert.equal(models.length, requestedIds.size > 0 ? requestedIds.size : configuredModels.length,
    "UNKNOWN_GPT_IMAGE2_GROUP_REQUESTED");
  await mkdir(outputDir, { recursive: true });
  const identity = await requiredJson("/api/auth/me");
  assert.equal(identity.user?.role, "admin", "LOCAL_ADMIN_REQUIRED");

  const plan = {
    runId,
    origin,
    modelIds: models.map((model) => model.id),
    maximumGenerationPosts: models.length,
    maximumSupplierCostYuan: 0.25,
    localAdminExpectedChargeYuan: Number(models.reduce((sum, model) => sum + Number(model.expectedPrices["1K"] || 0), 0).toFixed(2)),
    automaticRetries: 0,
    execute,
    confirmed,
  };
  await writeFile(path.join(outputDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  if (!execute) {
    console.log(JSON.stringify({ ...plan, result: "PLAN_ONLY", providerRequests: 0, databaseWrites: 0 }, null, 2));
    return;
  }
  assert.equal(confirmed, true, "PAID_PROVIDER_CALL_CONFIRMATION_REQUIRED");

  const report = { ...plan, startedAt: new Date().toISOString(), groups: [], failures: [] };
  for (const model of models) {
    try {
      report.groups.push(await validateAndPublish(model));
    } catch (error) {
      report.failures.push({ id: model.id, group: model.group, error: safeMessage(error instanceof Error ? error.message : error) });
    }
  }
  const final = {
    ...report,
    finishedAt: new Date().toISOString(),
    result: report.failures.length === 0 && report.groups.length === models.length ? "PASS" : "FAIL",
    successfulGroups: report.groups.length,
    failedGroups: report.failures.length,
    generationPosts: report.groups.reduce((sum, item) => sum + item.generationPosts, 0),
  };
  await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(final, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(final, null, 2));
  if (final.result !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    const failure = { runId, result: "FAIL", error: safeMessage(error instanceof Error ? error.message : error) };
    await mkdir(outputDir, { recursive: true }).catch(() => {});
    await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => {});
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  });
}
