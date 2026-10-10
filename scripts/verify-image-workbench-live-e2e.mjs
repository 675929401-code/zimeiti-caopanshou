#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const PROJECT_ROOT = process.cwd();
const SCRIPT_PATH = "scripts/verify-image-workbench-live-e2e.mjs";
const DEFAULT_ORIGIN = process.env.BASE_URL || process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000";
const DEFAULT_MODEL_NAME = "Nano Banana 2";
const DEFAULT_PROMPT = "白色背景上的青色马克杯，商品摄影，画面简洁，柔和棚拍光线，无文字。";
const SUPPORTED_RESOLUTION_ARGUMENTS = new Set(["1K", "2K", "4K"]);
const SUPPORTED_ASPECT_RATIO_ARGUMENTS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);
const RUN_ID = /^[a-zA-Z0-9_-]{6,100}$/u;
const SAFE_ID = /^[a-zA-Z0-9._:-]{4,180}$/u;
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5002",
  "http://127.0.0.1:5010",
]);
const LOCAL_DATABASE_TARGET = "127.0.0.1:54322/zimeiti_local";
const READINESS_CHECKERS = [
  "scripts/apply-image-request-snapshot-v2-local.mjs",
  "scripts/apply-image-rpc-owner-alignment-local.mjs",
  "scripts/apply-image-provider-receipts-local.mjs",
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const roundMoney = (value) => Number(Number(value).toFixed(6));

function argumentValue(args, prefix, fallback = "") {
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() || fallback;
}

function parseArgs(args) {
  const promptExplicit = args.some((value) => value.startsWith("--prompt="));
  const resolutionExplicit = args.some((value) => value.startsWith("--resolution="));
  const aspectRatioExplicit = args.some((value) => value.startsWith("--aspect-ratio="));
  const imageCountExplicit = args.some((value) => value.startsWith("--image-count="));
  const fixedInputArgumentCount = [promptExplicit, resolutionExplicit, aspectRatioExplicit, imageCountExplicit]
    .filter(Boolean).length;
  const options = {
    execute: false,
    runId: argumentValue(args, "--run-id="),
    origin: argumentValue(args, "--origin=", DEFAULT_ORIGIN).replace(/\/+$/u, ""),
    expectedSourceVersion: argumentValue(args, "--expected-source-version="),
    expectedBuildId: argumentValue(args, "--expected-build-id="),
    modelId: argumentValue(args, "--model-id="),
    modelName: argumentValue(args, "--model-name=", DEFAULT_MODEL_NAME),
    modelNameExplicit: args.some((value) => value.startsWith("--model-name=")),
    prompt: argumentValue(args, "--prompt=", DEFAULT_PROMPT),
    resolution: argumentValue(args, "--resolution="),
    aspectRatio: argumentValue(args, "--aspect-ratio="),
    imageCount: Number(argumentValue(args, "--image-count=", "1")),
    acceptanceProfile: fixedInputArgumentCount === 4 ? "fixed-prompt-adherence" : "smoke",
  };
  for (const argument of args) {
    if (argument === "--execute") options.execute = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (["--run-id=", "--origin=", "--expected-source-version=", "--expected-build-id=", "--model-id=", "--model-name=", "--prompt=", "--resolution=", "--aspect-ratio=", "--image-count="].some((prefix) => argument.startsWith(prefix))) continue;
    else throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
  }
  assert.match(options.runId, RUN_ID, "UNIQUE_RUN_ID_REQUIRED");
  assert.ok(ALLOWED_ORIGINS.has(options.origin), "LOCAL_ACCEPTANCE_ORIGIN_REQUIRED");
  if (options.expectedSourceVersion) assert.match(options.expectedSourceVersion, SAFE_ID, "INVALID_EXPECTED_SOURCE_VERSION");
  if (options.expectedBuildId) assert.match(options.expectedBuildId, SAFE_ID, "INVALID_EXPECTED_BUILD_ID");
  if (options.modelId) assert.match(options.modelId, SAFE_ID, "INVALID_MODEL_ID");
  assert.ok(options.modelName.length <= 200, "INVALID_MODEL_NAME");
  assert.equal(fixedInputArgumentCount === 0 || fixedInputArgumentCount === 4, true, "FIXED_PROMPT_REQUIRES_PROMPT_RESOLUTION_ASPECT_RATIO_AND_IMAGE_COUNT");
  assert.ok(options.prompt.length > 0 && options.prompt.length <= 4_000 && !options.prompt.includes("\u0000"), "INVALID_PROMPT");
  if (options.acceptanceProfile === "fixed-prompt-adherence") {
    assert.equal(SUPPORTED_RESOLUTION_ARGUMENTS.has(options.resolution), true, "INVALID_RESOLUTION");
    assert.equal(SUPPORTED_ASPECT_RATIO_ARGUMENTS.has(options.aspectRatio), true, "INVALID_ASPECT_RATIO");
    assert.equal(options.imageCount, 1, "IMAGE_WORKBENCH_FIXED_SUITE_REQUIRES_ONE_IMAGE");
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    `  node ${SCRIPT_PATH} --run-id=<unique-id>`,
    `  node scripts/with-local-customer-session.mjs ${SCRIPT_PATH} --run-id=<unique-id> --execute [options]`,
    "",
    "Default mode is a zero-network, zero-generation plan. --execute requires an ordinary local member session.",
    "Before browser creation, --execute requires fresh read-only 1300+1310+1330 local database readiness evidence.",
    "The one real generation POST is emitted only by clicking the AI生图工作台 page button; this verifier never submits it through fetch/API code.",
    "",
    "Options:",
    "  --expected-source-version=<value>  additionally lock the current sourceVersion",
    "  --expected-build-id=<value>        additionally lock the current Build ID",
    "  --model-id=<public-id>             choose one visible public image model",
    `  --model-name=<display-name>        fallback display-name match (default: ${DEFAULT_MODEL_NAME})`,
    "  --prompt=<exact-prompt>             fixed prompt-adherence prompt; requires the next three options",
    "  --resolution=<1K|2K|4K>            require an explicitly advertised resolution",
    "  --aspect-ratio=<ratio>              require an explicitly advertised aspect ratio",
    "  --image-count=1                     fixed image-workbench suite supports exactly one image",
    "",
    "The fixed prompt-adherence profile requires a ready 1330 receipt store before the browser click and",
    "then verifies the redacted actual provider request-body hash and provider submission receipt by status GET.",
  ].join("\n");
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function redactText(value, token = "") {
  let text = String(value || "");
  if (token) text = text.replaceAll(token, "[REDACTED_TOKEN]");
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_JWT]")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/giu, "$1?[REDACTED_QUERY]")
    .slice(0, 1200);
}

function pathnameOnly(url) {
  try { return new URL(url).pathname; } catch { return "invalid-url"; }
}

function securitySummary(value, tableOwner) {
  const executeGrantees = Array.isArray(value?.executeGrantees) ? value.executeGrantees.map(String) : [];
  const expectedGrantees = [String(tableOwner || ""), "service_role"].filter(Boolean).sort();
  return {
    owner: String(value?.owner || ""),
    ownerMatchesTable: Boolean(tableOwner) && value?.owner === tableOwner,
    securityDefiner: value?.securityDefiner === true,
    searchPathReady: Array.isArray(value?.searchPath)
      && value.searchPath.length === 1
      && value.searchPath[0] === "search_path=public, pg_temp",
    executeGrantees,
    executeAclExact: JSON.stringify([...executeGrantees].sort()) === JSON.stringify(expectedGrantees),
  };
}

function runReadinessChecker(script) {
  const startedAtMs = Date.now();
  const childEnvironment = { ...process.env };
  for (const key of [
    "R267_CUSTOMER_TOKEN",
    "LOCAL_NAV_READONLY_CUSTOMER",
    "LOCAL_NAV_ADMIN_TOKEN",
    "AUTH_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) delete childEnvironment[key];
  const result = spawnSync(process.execPath, [path.resolve(PROJECT_ROOT, script)], {
    cwd: PROJECT_ROOT,
    env: childEnvironment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const completedAtMs = Date.now();
  const body = parseJson(result.stdout, null);
  const checkedAtMs = Date.parse(String(body?.checkedAt || ""));
  return {
    script,
    exitCode: result.status,
    signal: result.signal || null,
    processError: result.error ? String(result.error.code || result.error.name || "checker-error") : null,
    fresh: Number.isFinite(checkedAtMs)
      && checkedAtMs >= startedAtMs - 1_000
      && checkedAtMs <= completedAtMs + 1_000,
    body,
  };
}

function localDatabaseReadiness() {
  const [snapshotResult, alignmentResult, receiptResult] = READINESS_CHECKERS.map(runReadinessChecker);
  const snapshot = snapshotResult.body;
  const alignment = alignmentResult.body;
  const receipt = receiptResult.body;
  const live = snapshot?.live;
  const snapshotSummary = {
    checker: snapshotResult.script,
    exitCode: snapshotResult.exitCode,
    signal: snapshotResult.signal,
    processError: snapshotResult.processError,
    checkedAt: snapshot?.checkedAt || null,
    fresh: snapshotResult.fresh,
    target: snapshot?.target || null,
    migration: {
      file: snapshot?.migration || null,
      sha256: snapshot?.migrationHash || null,
      ledgerPresent: snapshot?.ledgerPresent === true,
      ledgerHashMatches: snapshot?.ledgerHashMatches === true,
    },
    ownerAlignmentMigration: {
      file: snapshot?.ownerAlignment?.migration || null,
      sha256: snapshot?.ownerAlignment?.migrationHash || null,
      ledgerPresent: snapshot?.ownerAlignment?.ledgerPresent === true,
      ledgerHashMatches: snapshot?.ownerAlignment?.ledgerHashMatches === true,
    },
    liveSemantics: {
      acceptsV2: live?.acceptsV2 === true,
      acceptsHalfK: live?.acceptsHalfK === true,
      accepts3K: live?.accepts3K === true,
      validatesV2Integrity: live?.validatesV2Integrity === true,
      reconcilesV2: live?.reconcilesV2 === true,
    },
    claimFunction: securitySummary(live?.security, live?.tableOwner),
    reconciliationFunction: securitySummary(live?.reconciliationSecurity, live?.tableOwner),
    snapshotMigrationReady: snapshot?.snapshotMigrationReady === true,
    finalOwnerAlignmentReady: snapshot?.finalOwnerAlignmentReady === true,
    ready: snapshot?.ready === true,
  };
  const alignmentFunctions = Array.isArray(alignment?.live?.functions) ? alignment.live.functions : [];
  const alignmentSummary = {
    checker: alignmentResult.script,
    exitCode: alignmentResult.exitCode,
    signal: alignmentResult.signal,
    processError: alignmentResult.processError,
    checkedAt: alignment?.checkedAt || null,
    fresh: alignmentResult.fresh,
    target: alignment?.target || null,
    migration: {
      file: alignment?.migration || null,
      sha256: alignment?.migrationHash || null,
      ledgerPresent: alignment?.ledgerPresent === true,
      hashVerifiedByReadyResult: alignment?.ready === true,
    },
    functions: alignmentFunctions.map(item => ({
      signature: item.signature,
      ...securitySummary(item, alignment?.live?.tableOwner),
      privileges: item.privileges,
    })),
    ready: alignment?.ready === true,
  };
  const receiptFunctions = Array.isArray(receipt?.live?.functions) ? receipt.live.functions : [];
  const receiptSummary = {
    checker: receiptResult.script,
    exitCode: receiptResult.exitCode,
    signal: receiptResult.signal,
    processError: receiptResult.processError,
    checkedAt: receipt?.checkedAt || null,
    fresh: receiptResult.fresh,
    target: receipt?.target || null,
    migration: {
      file: receipt?.migration || null,
      sha256: receipt?.migrationHash || null,
      ledgerPresent: receipt?.ledgerPresent === true,
      ledgerHashMatches: receipt?.ledgerHashMatches === true,
    },
    columns: Array.isArray(receipt?.live?.columns) ? receipt.live.columns : [],
    receiptOrderConstraintValidated: receipt?.live?.receiptOrderConstraintValidated === true,
    functions: receiptFunctions.map(item => ({
      signature: item.signature,
      owner: item.owner,
      securityDefiner: item.securityDefiner === true,
      searchPath: item.searchPath,
      executeGrantees: item.executeGrantees,
      serviceRole: item.serviceRole === true,
      receiptAware: item.receiptAware === true,
      privileges: item.privileges,
    })),
    ready: receipt?.ready === true,
  };
  const ready = snapshotResult.exitCode === 0
    && alignmentResult.exitCode === 0
    && receiptResult.exitCode === 0
    && snapshotResult.fresh
    && alignmentResult.fresh
    && receiptResult.fresh
    && snapshot?.target === LOCAL_DATABASE_TARGET
    && alignment?.target === LOCAL_DATABASE_TARGET
    && receipt?.target === LOCAL_DATABASE_TARGET
    && snapshotSummary.migration.ledgerHashMatches
    && snapshotSummary.ownerAlignmentMigration.ledgerHashMatches
    && snapshotSummary.snapshotMigrationReady
    && snapshotSummary.finalOwnerAlignmentReady
    && snapshotSummary.ready
    && alignmentSummary.migration.ledgerPresent
    && alignmentSummary.ready
    && receiptSummary.migration.ledgerPresent
    && receiptSummary.migration.ledgerHashMatches
    && receiptSummary.ready;
  return {
    checkedImmediatelyBeforeBrowser: true,
    localTargetRequired: LOCAL_DATABASE_TARGET,
    snapshot: snapshotSummary,
    ownerAlignment: alignmentSummary,
    providerReceipts: receiptSummary,
    ready,
  };
}

function publicModelProjection(model) {
  const resolutionPrices = {};
  const rawResolutionPrices = model?.capabilities?.resolutionPrices;
  if (Array.isArray(rawResolutionPrices)) {
    for (const entry of rawResolutionPrices) {
      const match = String(entry || "").match(/^\s*(1K|2K|4K)\s*=\s*(\d+(?:\.\d+)?)\s*$/u);
      if (match) resolutionPrices[match[1]] = Number(match[2]);
    }
  } else if (rawResolutionPrices && typeof rawResolutionPrices === "object") {
    for (const [key, value] of Object.entries(rawResolutionPrices)) {
      if (["1K", "2K", "4K"].includes(key) && Number.isFinite(Number(value))) resolutionPrices[key] = Number(value);
    }
  }
  return {
    id: String(model?.id || ""),
    displayName: String(model?.displayName || ""),
    variantLabel: String(model?.variantLabel || ""),
    publicPrice: Number(model?.publicPrice),
    available: model?.capabilities?.available !== false,
    priceReady: model?.capabilities?.priceReady !== false,
    aspectRatios: Array.isArray(model?.capabilities?.aspectRatios) ? model.capabilities.aspectRatios : [],
    resolutionOptions: Array.isArray(model?.capabilities?.resolutionOptions) ? model.capabilities.resolutionOptions : [],
    defaultResolution: String(model?.capabilities?.defaultResolution || ""),
    resolutionPrices,
  };
}

function quotedModelPrice(model, resolution) {
  return Number(model?.resolutionPrices?.[resolution] ?? model?.publicPrice);
}

export function modelSupportsRequestedImageParameters(model, resolution, aspectRatio) {
  return Boolean(
    model?.id
    && model.available === true
    && model.priceReady === true
    && Array.isArray(model.resolutionOptions)
    && model.resolutionOptions.includes(resolution)
    && Array.isArray(model.aspectRatios)
    && model.aspectRatios.includes(aspectRatio)
    && Number.isFinite(quotedModelPrice(model, resolution))
    && quotedModelPrice(model, resolution) >= 0
  );
}

export function selectPublicImageModel(publicModels, options) {
  if (options.acceptanceProfile === "fixed-prompt-adherence") {
    const eligible = publicModels.filter((model) => modelSupportsRequestedImageParameters(
      model,
      options.resolution,
      options.aspectRatio,
    ));
    if (options.modelId) return eligible.find((model) => model.id === options.modelId) || null;
    if (options.modelNameExplicit) {
      return eligible.find((model) => model.displayName === options.modelName)
        || eligible.find((model) => model.displayName.includes(options.modelName))
        || null;
    }
    return eligible[0] || null;
  }
  return (options.modelId ? publicModels.find((model) => model.id === options.modelId) : null)
    || publicModels.find((model) => model.displayName === options.modelName)
    || publicModels.find((model) => model.displayName.includes(options.modelName))
    || publicModels.find((model) => model.available && model.priceReady)
    || null;
}

function providerEvidenceReadbackContract(receiptReadiness = null) {
  return {
    requiredFor: "fixed-prompt-adherence",
    ready: receiptReadiness?.ready === true,
    failClosedBeforeBrowserClick: true,
    missing: receiptReadiness?.ready === true ? [] : ["ready1330ReceiptStore"],
    inspectedReadbacks: {
      generationResponse: {
        available: ["providerProtocol", "payloadFingerprint"],
        insufficientBecause: "payloadFingerprint hashes the platform request contract and routing bindings, not the serialized provider request body",
      },
      imageStatus: {
        available: ["actualPayloadSha256", "dispatchReceiptId", "submissionReceiptId", "responseBodySha256", "hashedProviderAcknowledgement"],
        ownerScoped: true,
      },
      imageTrace: {
        available: ["phase", "traceId", "modelId", "promptHash", "outputObjectLocator"],
        insufficientBecause: "the redacted runtime trace contains neither the provider request-body hash nor a provider response receipt",
      },
      accountHistory: {
        insufficientBecause: "history records the user request and delivered asset, not the server-to-provider dispatch evidence",
      },
    },
    note: "The UI request hash remains distinct from the immutable hash of the final serialized provider wire body.",
  };
}

async function getJson(origin, pathname, token = "") {
  const response = await fetch(`${origin}${pathname}`, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `READ_ONLY_PREFLIGHT_FAILED:${pathname}:${response.status}`);
  return body;
}

async function runtimeIdentity(options) {
  const runtimeVersion = await getJson(options.origin, "/api/version");
  assert.ok(runtimeVersion?.sourceVersion && runtimeVersion?.buildId, "RUNTIME_IDENTITY_INCOMPLETE");
  const [diskVersionText, diskBuildId, receiptText] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "public/version.json"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, ".next", "BUILD_ID"), "utf8").then((value) => value.trim()),
    fs.readFile(path.join(PROJECT_ROOT, ".next", "local-source-fingerprint.v1.json"), "utf8"),
  ]);
  const diskVersion = JSON.parse(diskVersionText);
  const receipt = JSON.parse(receiptText);
  const fingerprint = computeLocalBuildFingerprint(PROJECT_ROOT);
  const runningLatest = runtimeVersion.sourceVersion === diskVersion.sourceVersion
    && runtimeVersion.buildId === diskBuildId
    && receipt.buildId === diskBuildId
    && receipt.fingerprint === fingerprint.fingerprint
    && receipt.fileCount === fingerprint.fileCount;
  assert.equal(runningLatest, true, "RUNTIME_NOT_LATEST");
  if (options.expectedSourceVersion) assert.equal(runtimeVersion.sourceVersion, options.expectedSourceVersion, "EXPECTED_SOURCE_VERSION_MISMATCH");
  if (options.expectedBuildId) assert.equal(runtimeVersion.buildId, options.expectedBuildId, "EXPECTED_BUILD_ID_MISMATCH");
  return {
    sourceVersion: runtimeVersion.sourceVersion,
    buildId: runtimeVersion.buildId,
    diskSourceVersion: diskVersion.sourceVersion,
    sourceFingerprint: fingerprint.fingerprint,
    sourceFingerprintCurrent: true,
    runningLatest,
  };
}

async function readBalances(origin, token, userId) {
  const [cash, credits] = await Promise.all([
    getJson(origin, "/api/cash/balance", token),
    getJson(origin, `/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`, token),
  ]);
  return {
    cash: Number(cash?.balance),
    credits: Number(credits?.credits),
    reservedCredits: Number(credits?.reservedCredits),
    memberStatus: String(credits?.memberStatus || ""),
  };
}

function walletTransactionProjection(row) {
  return {
    id: String(row?.id || ""),
    type: String(row?.type || ""),
    amount: Number(row?.amount),
    balanceAfter: Number(row?.balanceAfter),
    referenceId: row?.referenceId || null,
    createdAt: row?.createdAt || null,
  };
}

function assetProjection(file) {
  return {
    id: String(file?.id || ""),
    category: String(file?.file_category || ""),
    size: Number(file?.file_size),
    contentType: String(file?.content_type || ""),
    createdAt: file?.created_at || null,
  };
}

function historyProjection(history) {
  const records = Array.isArray(history?.records) ? history.records : [];
  return records.map((record) => ({
    id: String(record?.id || ""),
    createdAt: record?.createdAt ?? null,
    items: (Array.isArray(record?.items) ? record.items : []).map((item) => ({
      assetId: item?.assetId || null,
      historyRecordId: item?.historyRecordId || null,
      taskId: item?.taskId || null,
      operationId: item?.operationId || null,
      cashCharged: item?.cashCharged ?? null,
    })),
  }));
}

async function readAccountEvidence(origin, token, userId) {
  const [balances, transactions, assets, history] = await Promise.all([
    readBalances(origin, token, userId),
    getJson(origin, "/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=50", token),
    getJson(origin, "/api/storage/files?category=image&limit=100&offset=0", token),
    getJson(origin, "/api/image-workbench/history?page=1", token),
  ]);
  const walletTransactions = (transactions?.data?.transactions || [])
    .filter((row) => row?.category === "cash")
    .map(walletTransactionProjection);
  return {
    ...balances,
    walletTransactions,
    walletTransactionTotal: Number(transactions?.data?.pagination?.cashTotal),
    imageAssets: (assets?.files || []).map(assetProjection),
    imageAssetTotal: Number(assets?.pagination?.total),
    imageHistory: historyProjection(history),
  };
}

async function observeJson(origin, pathname, token) {
  try {
    const response = await fetch(`${origin}${pathname}`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    return {
      available: true,
      httpStatus: response.status,
      ok: response.ok,
      body: await response.json().catch(() => null),
    };
  } catch (error) {
    return {
      available: false,
      httpStatus: null,
      ok: false,
      error: redactText(error),
    };
  }
}

function observationProjection(observation) {
  return {
    available: observation?.available === true,
    httpStatus: observation?.httpStatus ?? null,
    ok: observation?.ok === true,
    error: observation?.error || observation?.body?.error || null,
  };
}

async function readFailureAccountEvidence(origin, token, userId) {
  const [cash, credits, transactions, assets, history] = await Promise.all([
    observeJson(origin, "/api/cash/balance", token),
    observeJson(origin, `/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`, token),
    observeJson(origin, "/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=50", token),
    observeJson(origin, "/api/storage/files?category=image&limit=100&offset=0", token),
    observeJson(origin, "/api/image-workbench/history?page=1", token),
  ]);
  const walletTransactions = transactions.ok
    ? (transactions.body?.data?.transactions || []).filter((row) => row?.category === "cash").map(walletTransactionProjection)
    : [];
  return {
    cash: cash.ok ? Number(cash.body?.balance) : null,
    credits: credits.ok ? Number(credits.body?.credits) : null,
    reservedCredits: credits.ok ? Number(credits.body?.reservedCredits) : null,
    memberStatus: credits.ok ? String(credits.body?.memberStatus || "") : null,
    walletTransactions,
    walletTransactionTotal: transactions.ok ? Number(transactions.body?.data?.pagination?.cashTotal) : null,
    imageAssets: assets.ok ? (assets.body?.files || []).map(assetProjection) : [],
    imageAssetTotal: assets.ok ? Number(assets.body?.pagination?.total) : null,
    imageHistory: history.ok ? historyProjection(history.body) : [],
    observations: {
      cash: observationProjection(cash),
      credits: observationProjection(credits),
      transactions: observationProjection(transactions),
      assets: observationProjection(assets),
      history: observationProjection(history),
    },
  };
}

function statusProjection(observation) {
  const body = observation?.body;
  return {
    available: observation?.available === true,
    httpStatus: observation?.httpStatus ?? null,
    ok: observation?.ok === true,
    state: body?.state || null,
    rejectionState: body?.rejectionState || null,
    code: body?.code || null,
    canRecover: body?.canRecover ?? null,
    canResubmit: body?.canResubmit ?? null,
    sameKeyCanResubmit: body?.sameKeyCanResubmit ?? null,
    billingHeld: body?.billingHeld ?? null,
    billingReleaseState: body?.billingReleaseState || null,
    billingReconciliation: body?.billingReconciliation || null,
    billingReferenceId: body?.billingReferenceId || null,
    assetId: body?.assetId || null,
    providerEvidence: body?.providerEvidence || null,
    updatedAt: body?.updatedAt || null,
    error: observation?.error || body?.error || null,
  };
}

function newRows(before, after, key = "id") {
  const known = new Set(before.map((row) => String(row?.[key] || "")).filter(Boolean));
  return after.filter((row) => {
    const value = String(row?.[key] || "");
    return value && !known.has(value);
  });
}

function sanitizedRequestProjection(body, rawBody) {
  return {
    bodySha256: sha256(rawBody || JSON.stringify(body || {})),
    prompt: String(body?.prompt || ""),
    promptSha256: sha256(String(body?.prompt || "")),
    promptCharacters: String(body?.prompt || "").length,
    mode: body?.mode || null,
    modelId: body?.modelId || null,
    aspectRatio: body?.aspectRatio || null,
    resolution: body?.resolution || null,
    historySurface: body?.historySurface || null,
    referenceImageCount: Array.isArray(body?.referenceImageUrls) ? body.referenceImageUrls.length : 0,
    clientTraceId: body?.clientTraceId || null,
    clientIdempotencyKey: body?.clientIdempotencyKey || null,
    resumeDeliveryOnly: body?.resumeDeliveryOnly === true,
  };
}

function sanitizedGenerationResponse(body, status) {
  return {
    httpStatus: status,
    success: body?.success === true,
    status: body?.status || body?.state || null,
    code: body?.code || null,
    taskId: body?.taskId || null,
    traceId: body?.traceId || null,
    operationId: body?.operationId || null,
    assetId: body?.images?.[0]?.assetId || null,
    modelIdUsed: body?.modelIdUsed || null,
    resolution: body?.resolution || null,
    outputPixelSize: body?.outputPixelSize || null,
    imageCount: body?.imageCount ?? null,
    providerProtocol: body?.providerProtocol || null,
    payloadFingerprint: body?.payloadFingerprint || null,
    idempotencyReplayed: body?.idempotencyReplayed ?? null,
    cashCharged: body?.cashCharged ?? null,
    cashRemaining: body?.cashRemaining ?? null,
    error: body?.error || null,
  };
}

async function saveRenderedImage(responseBody, origin, token, outputDir) {
  const source = String(responseBody?.images?.[0]?.url || "");
  assert.ok(source, "GENERATED_IMAGE_URL_MISSING");
  const target = new URL(source, origin);
  const originUrl = new URL(origin);
  const response = await fetch(target, {
    method: "GET",
    headers: target.origin === originUrl.origin ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(90_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(response.ok && bytes.length > 1000, `GENERATED_IMAGE_READ_FAILED:${response.status}`);
  const metadata = await sharp(bytes).metadata();
  assert.ok(metadata.width && metadata.height && metadata.format, "GENERATED_IMAGE_DECODE_FAILED");
  const extension = metadata.format === "jpeg" ? "jpg" : metadata.format;
  const file = `generated-image.${extension}`;
  await fs.writeFile(path.join(outputDir, file), bytes, { flag: "wx" });
  return {
    file,
    bytes: bytes.length,
    sha256: sha256(bytes),
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
  };
}

async function runExecute(options) {
  const token = String(process.env.R267_CUSTOMER_TOKEN || "").trim();
  const wrapperCustomer = parseJson(process.env.LOCAL_NAV_READONLY_CUSTOMER, null);
  assert.ok(token, "ORDINARY_CUSTOMER_TOKEN_REQUIRED_USE_WITH_LOCAL_CUSTOMER_SESSION");
  assert.ok(wrapperCustomer?.id && wrapperCustomer?.role === "student", "LOCAL_READONLY_CUSTOMER_IDENTITY_REQUIRED");

  const outputDir = path.resolve(".codex-evidence/image-workbench-live-ui-only", options.runId);
  await fs.access(outputDir).then(() => assert.fail("OUTPUT_ALREADY_EXISTS"), () => undefined);
  await fs.mkdir(outputDir, { recursive: true });

  const report = {
    schema: "image_workbench_live_ui_only_e2e.v2",
    runId: options.runId,
    mode: "execute",
    acceptanceProfile: options.acceptanceProfile,
    startedAt: new Date().toISOString(),
    status: "running",
    requestedInputs: {
      prompt: options.acceptanceProfile === "fixed-prompt-adherence" ? options.prompt : null,
      promptSha256: sha256(options.prompt),
      resolution: options.resolution || null,
      aspectRatio: options.aspectRatio || null,
      imageCount: options.imageCount,
    },
    policy: {
      ordinaryMemberOnly: true,
      adminExemptionUsed: false,
      directGenerationApiCallsByHarness: 0,
      generationPostLimit: 1,
      automaticRetries: 0,
      observedAdditionalGenerationAttempts: 0,
      failureStatusReadMayReconcileStaleIntent: true,
      tokenPersisted: false,
      fullSensitiveUrlsPersisted: false,
    },
    diagnostics: {
      consoleErrors: [], pageErrors: [], networkErrors: [], nonGenerationMutations: [], uiObstructions: [],
      generationPostAttempts: 0, generationPostsContinued: 0, duplicateGenerationPostsBlocked: 0,
    },
    cleanup: { contextClosed: false, browserClosed: false, generatedRecordsDeleted: false, note: "Generated evidence is retained in the ordinary member account history." },
  };
  let browser;
  let context;
  let failure;
  try {
    report.localDatabaseReadiness = localDatabaseReadiness();
    assert.equal(report.localDatabaseReadiness.ready, true, "LOCAL_IMAGE_DATABASE_COMBINED_READINESS_REQUIRED");
    report.providerEvidence = providerEvidenceReadbackContract(report.localDatabaseReadiness.providerReceipts);
    report.runtime = await runtimeIdentity(options);
    const identity = await getJson(options.origin, "/api/auth/me", token);
    assert.equal(identity?.user?.role, "student", "ORDINARY_MEMBER_ROLE_REQUIRED_ADMIN_EVIDENCE_FORBIDDEN");
    assert.equal(String(identity?.user?.id || ""), String(wrapperCustomer.id), "CUSTOMER_IDENTITY_MISMATCH");
    report.actor = { userId: identity.user.id, role: identity.user.role };

    const catalog = await getJson(options.origin, "/api/cover-models?surface=image-workbench", token);
    const publicModels = Array.isArray(catalog?.models) ? catalog.models.map(publicModelProjection) : [];
    const selected = selectPublicImageModel(publicModels, options);
    assert.ok(selected?.id && selected.available && selected.priceReady, "VISIBLE_AVAILABLE_PUBLIC_IMAGE_MODEL_REQUIRED");
    assert.ok(Number.isFinite(selected.publicPrice) && selected.publicPrice >= 0, "PUBLIC_IMAGE_PRICE_REQUIRED");
    const resolution = options.acceptanceProfile === "fixed-prompt-adherence"
      ? options.resolution
      : selected.resolutionOptions.includes(selected.defaultResolution)
        ? selected.defaultResolution : selected.resolutionOptions[0] || "2K";
    const aspectRatio = options.acceptanceProfile === "fixed-prompt-adherence"
      ? options.aspectRatio
      : selected.aspectRatios.includes("1:1") ? "1:1" : selected.aspectRatios[0] || "1:1";
    if (options.acceptanceProfile === "fixed-prompt-adherence") {
      assert.equal(
        modelSupportsRequestedImageParameters(selected, resolution, aspectRatio),
        true,
        "NO_AVAILABLE_PUBLIC_IMAGE_MODEL_SUPPORTS_REQUESTED_PARAMETERS",
      );
    }
    const quotedPrice = quotedModelPrice(selected, resolution);
    assert.ok(Number.isFinite(quotedPrice) && quotedPrice >= 0, "SELECTED_RESOLUTION_PRICE_REQUIRED");
    report.model = { ...selected, selectedResolution: resolution, selectedAspectRatio: aspectRatio, quotedPrice };

    if (options.acceptanceProfile === "fixed-prompt-adherence") {
      assert.equal(
        report.providerEvidence.ready,
        true,
        `FIXED_PROMPT_PROVIDER_EVIDENCE_UNAVAILABLE:${report.providerEvidence.missing.join(",")}`,
      );
    }

    const before = await readAccountEvidence(options.origin, token, identity.user.id);
    assert.ok(Number.isFinite(before.cash) && before.cash >= quotedPrice, "ORDINARY_MEMBER_CASH_BALANCE_INSUFFICIENT_FOR_ONE_IMAGE");
    report.billing = { before, quotedPrice, after: null, cashDelta: null, creditsDelta: null };
    const marker = `IMAGE_UI_ONLY_${options.runId}_${randomUUID()}`;
    const prompt = options.acceptanceProfile === "fixed-prompt-adherence"
      ? options.prompt
      : `${options.prompt} 验收标记：${marker}`;
    report.pageInput = {
      acceptanceProfile: options.acceptanceProfile,
      mode: "文生图",
      modelId: selected.id,
      modelDisplayName: selected.displayName,
      resolution,
      aspectRatio,
      prompt,
      promptSha256: sha256(prompt),
      promptCharacters: prompt.length,
      expectedCardCount: options.imageCount,
    };
    await fs.writeFile(path.join(outputDir, "dispatch.json"), `${JSON.stringify({
      schema: "image_workbench_ui_dispatch.v2",
      createdAt: new Date().toISOString(),
      runId: options.runId,
      runtime: report.runtime,
      ordinaryMemberRole: "student",
      selectedPublicModelId: selected.id,
      acceptanceProfile: options.acceptanceProfile,
      resolution,
      aspectRatio,
      imageCount: options.imageCount,
      promptSha256: report.pageInput.promptSha256,
      generationPostLimit: 1,
      automaticRetries: 0,
      submissionAuthority: "browser-page-click-only",
    }, null, 2)}\n`, { flag: "wx" });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: "block" });
    await context.addInitScript(({ authToken, authUser }) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.setItem("auth_user", JSON.stringify(authUser));
      sessionStorage.setItem("entered_app", "1");
    }, { authToken: token, authUser: identity.user });
    await context.addCookies([{ name: "auth_token", value: token, url: options.origin, httpOnly: true, sameSite: "Lax" }]);

    let clickArmed = false;
    const generationRequests = [];
    const postReceiptPromises = [];
    await context.route("**/api/image/generate", async (route) => {
      report.diagnostics.generationPostAttempts += 1;
      if (!clickArmed || report.diagnostics.generationPostsContinued >= 1) {
        report.diagnostics.duplicateGenerationPostsBlocked += 1;
        await route.abort("blockedbyclient");
        return;
      }
      report.diagnostics.generationPostsContinued += 1;
      await route.continue();
    });

    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) {
        report.diagnostics.consoleErrors.push(redactText(message.text(), token));
      }
    });
    page.on("pageerror", (error) => report.diagnostics.pageErrors.push(redactText(error.message, token)));
    page.on("requestfailed", (request) => {
      if (pathnameOnly(request.url()) === "/api/image/generate" && report.diagnostics.duplicateGenerationPostsBlocked > 0) return;
      report.diagnostics.networkErrors.push({ method: request.method(), path: pathnameOnly(request.url()), failure: redactText(request.failure()?.errorText, token) });
    });
    page.on("response", (response) => {
      const request = response.request();
      const pathname = pathnameOnly(response.url());
      if (response.status() >= 400) report.diagnostics.networkErrors.push({ method: request.method(), path: pathname, status: response.status() });
      if (request.method() === "POST" && ["/api/image-workbench/persist", "/api/image-workbench/history"].includes(pathname)) {
        postReceiptPromises.push(response.json().then((body) => ({ path: pathname, status: response.status(), body })).catch(() => ({ path: pathname, status: response.status(), body: null })));
      }
    });
    page.on("request", (request) => {
      const method = request.method().toUpperCase();
      const pathname = pathnameOnly(request.url());
      if (!["GET", "HEAD", "OPTIONS"].includes(method) && pathname !== "/api/image/generate") {
        report.diagnostics.nonGenerationMutations.push({ method, path: pathname });
      }
      if (method !== "POST" || pathname !== "/api/image/generate") return;
      const rawBody = request.postData() || "";
      const body = parseJson(rawBody, {});
      generationRequests.push(sanitizedRequestProjection(body, rawBody));
    });

    const navigation = await page.goto(`${options.origin}/image-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.ok(navigation?.ok(), "IMAGE_WORKBENCH_NAVIGATION_FAILED");
    await page.locator("#image-workbench-model").waitFor({ state: "attached", timeout: 45_000 });
    const announcementClose = page.locator('button[aria-label="关闭系统公告"]');
    if (await announcementClose.isVisible().catch(() => false)) {
      await announcementClose.click();
      await announcementClose.waitFor({ state: "hidden", timeout: 10_000 });
      report.diagnostics.uiObstructions.push({
        type: "announcement-reader",
        action: "closed-through-page-ui-without-marking-read",
        generationPostsBeforeClose: report.diagnostics.generationPostAttempts,
      });
    }
    await page.locator("#image-workbench-model").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "文生图", exact: true }).click();
    await page.locator("#image-workbench-model").selectOption(selected.id);
    await page.getByRole("button", { name: resolution, exact: true }).click();
    await page.getByRole("button", { name: aspectRatio, exact: true }).click();
    while (await page.getByRole("button", { name: "删除生图卡片", exact: true }).count() > 1) {
      await page.getByRole("button", { name: "删除生图卡片", exact: true }).last().click();
    }
    assert.equal(
      await page.getByLabel(/第 \d+ 张图片提示词/u).count(),
      options.imageCount,
      "PAGE_IMAGE_CARD_COUNT_MISMATCH",
    );
    const promptInput = page.getByLabel("第 1 张图片提示词", { exact: true });
    await promptInput.fill(prompt);
    assert.equal(await promptInput.inputValue(), prompt, "PAGE_PROMPT_INPUT_MISMATCH");
    assert.equal(await page.locator("#image-workbench-model").inputValue(), selected.id, "PAGE_MODEL_INPUT_MISMATCH");
    await page.screenshot({ path: path.join(outputDir, "image-workbench-before-submit.png"), fullPage: true });
    const generateButton = page.getByRole("button", { name: /生成图片（1）/u });
    await generateButton.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await generateButton.isEnabled(), true, "PAGE_GENERATE_BUTTON_DISABLED");

    const generationResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
      && pathnameOnly(response.url()) === "/api/image/generate", { timeout: 720_000 });
    report.submission = { clickedAt: new Date().toISOString(), trigger: `page-button:生成图片（${options.imageCount}）`, uiOnly: true };
    clickArmed = true;
    await generateButton.click();
    const generationResponse = await generationResponsePromise;
    const generationBody = await generationResponse.json().catch(() => null);
    report.generation = sanitizedGenerationResponse(generationBody, generationResponse.status());
    assert.equal(report.diagnostics.generationPostAttempts, 1, "GENERATION_POST_ATTEMPT_COUNT_MUST_BE_EXACTLY_ONE");
    assert.equal(report.diagnostics.generationPostsContinued, 1, "GENERATION_POST_NETWORK_COUNT_MUST_BE_EXACTLY_ONE");
    assert.equal(report.diagnostics.duplicateGenerationPostsBlocked, 0, "DUPLICATE_GENERATION_POST_DETECTED");
    assert.equal(generationRequests.length, 1, "GENERATION_REQUEST_CAPTURE_COUNT_INVALID");
    report.request = generationRequests[0];
    assert.equal(report.request.prompt, prompt, "REQUEST_PROMPT_MISMATCH");
    assert.equal(report.request.modelId, selected.id, "REQUEST_MODEL_MISMATCH");
    assert.equal(report.request.aspectRatio, aspectRatio, "REQUEST_ASPECT_RATIO_MISMATCH");
    assert.equal(report.request.resolution, resolution, "REQUEST_RESOLUTION_MISMATCH");
    assert.equal(report.request.historySurface, "image-workbench", "REQUEST_HISTORY_SURFACE_MISMATCH");
    assert.equal(report.request.resumeDeliveryOnly, false, "UNEXPECTED_DELIVERY_RESUME_SUBMISSION");
    assert.ok(report.request.clientTraceId && report.request.clientIdempotencyKey, "REQUEST_TRACE_AND_IDEMPOTENCY_REQUIRED");
    if (!generationResponse.ok()) {
      const statusQuery = new URLSearchParams({
        clientIdempotencyKey: report.request.clientIdempotencyKey,
        clientTraceId: report.request.clientTraceId,
      });
      const [after, statusObservation] = await Promise.all([
        readFailureAccountEvidence(options.origin, token, identity.user.id),
        observeJson(options.origin, `/api/image/status?${statusQuery}`, token),
      ]);
      const newWalletTransactions = newRows(before.walletTransactions, after.walletTransactions);
      const newAssets = newRows(before.imageAssets, after.imageAssets);
      const newHistoryRecords = newRows(before.imageHistory, after.imageHistory);
      const historyItems = newHistoryRecords.flatMap((record) => record.items || []);
      const status = statusProjection(statusObservation);
      const taskId = report.generation.taskId || historyItems.find((item) => item.taskId)?.taskId || null;
      const traceId = report.generation.traceId || report.request.clientTraceId || null;
      const operationId = report.generation.operationId || historyItems.find((item) => item.operationId)?.operationId || null;
      const assetId = report.generation.assetId || status.assetId || historyItems.find((item) => item.assetId)?.assetId || null;
      report.billing.after = after;
      report.billing.cashDelta = Number.isFinite(after.cash) ? roundMoney(before.cash - after.cash) : null;
      report.billing.creditsDelta = Number.isFinite(after.credits) ? roundMoney(before.credits - after.credits) : null;
      report.failureReadback = {
        capturedAt: new Date().toISOString(),
        generationHttpStatus: generationResponse.status(),
        method: "account GETs plus image status GET; status may reconcile a stale intent after the server threshold but cannot submit a provider generation",
        imageStatus: status,
        task: {
          taskId,
          traceId,
          state: status.state || report.generation.status || "http-rejected",
          zeroResidual: !taskId && !traceId && status.state === "not_found",
        },
        operation: {
          operationId,
          billingReferenceId: status.billingReferenceId,
          state: status.billingReleaseState || status.billingReconciliation
            || (newWalletTransactions.length > 0 ? "wallet-transaction-observed" : "no-wallet-operation-observed"),
          newHistoryOperationIds: historyItems.map((item) => item.operationId).filter(Boolean),
          zeroResidual: !operationId && !status.billingReferenceId && newWalletTransactions.length === 0,
        },
        asset: {
          assetId,
          totalBefore: before.imageAssetTotal,
          totalAfter: after.imageAssetTotal,
          totalDelta: Number.isFinite(after.imageAssetTotal) ? after.imageAssetTotal - before.imageAssetTotal : null,
          newAssets,
          newHistoryRecords,
          zeroResidual: after.observations.assets.ok && after.observations.history.ok
            && newAssets.length === 0 && newHistoryRecords.length === 0
            && after.imageAssetTotal === before.imageAssetTotal,
        },
        wallet: {
          cashBefore: before.cash,
          cashAfter: after.cash,
          cashDelta: report.billing.cashDelta,
          creditsBefore: before.credits,
          creditsAfter: after.credits,
          creditsDelta: report.billing.creditsDelta,
          transactionTotalBefore: before.walletTransactionTotal,
          transactionTotalAfter: after.walletTransactionTotal,
          transactionTotalDelta: Number.isFinite(after.walletTransactionTotal)
            ? after.walletTransactionTotal - before.walletTransactionTotal : null,
          newTransactions: newWalletTransactions,
          zeroResidual: after.observations.cash.ok && after.observations.credits.ok && after.observations.transactions.ok
            && newWalletTransactions.length === 0
            && after.walletTransactionTotal === before.walletTransactionTotal
            && report.billing.cashDelta === 0
            && report.billing.creditsDelta === 0,
        },
      };
      report.policy.observedAdditionalGenerationAttempts = Math.max(
        0,
        report.diagnostics.generationPostAttempts - 1,
      );
      assert.equal(report.diagnostics.generationPostAttempts, 1, "DELAYED_DUPLICATE_GENERATION_ATTEMPT_DETECTED");
      assert.equal(report.diagnostics.generationPostsContinued, 1, "DELAYED_GENERATION_POST_CONTINUATION_INVALID");
      assert.equal(report.diagnostics.duplicateGenerationPostsBlocked, 0, "DELAYED_DUPLICATE_GENERATION_POST_BLOCKED");
      throw new Error(`GENERATION_HTTP_${generationResponse.status()}`);
    }
    assert.equal(generationResponse.status(), 200, `GENERATION_HTTP_${generationResponse.status()}`);
    assert.equal(generationBody?.success, true, "GENERATION_NOT_SUCCESSFUL");
    assert.equal(generationBody?.status, "completed", "GENERATION_NOT_TERMINAL_COMPLETED");
    assert.equal(generationBody?.idempotencyReplayed, false, "GENERATION_MUST_NOT_BE_AN_IDEMPOTENT_REPLAY");
    assert.equal(generationBody?.traceId, report.request.clientTraceId, "TRACE_ID_MISMATCH");
    assert.equal(generationBody?.modelIdUsed, selected.id, "RESPONSE_MODEL_MISMATCH");
    assert.equal(generationBody?.resolution, resolution, "RESPONSE_RESOLUTION_MISMATCH");
    assert.equal(generationBody?.imageCount, options.imageCount, "RESPONSE_IMAGE_COUNT_MISMATCH");

    const resultImage = page.locator("article").filter({ has: page.getByLabel("第 1 张图片提示词", { exact: true }) }).locator("img").first();
    await resultImage.waitFor({ state: "visible", timeout: 120_000 });
    const rendered = await resultImage.evaluate((image) => ({
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    assert.ok(rendered.complete && rendered.width > 0 && rendered.height > 0, "GENERATED_IMAGE_NOT_RENDERED_IN_PAGE");
    report.rendered = rendered;
    await page.screenshot({ path: path.join(outputDir, "image-workbench-result.png"), fullPage: true });
    report.asset = await saveRenderedImage(generationBody, options.origin, token, outputDir);

    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("button", { name: "一键下载", exact: true }).click();
    const download = await downloadPromise;
    const suggested = path.basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/gu, "_") || "image-workbench-download.zip";
    const downloadPath = path.join(outputDir, suggested);
    await download.saveAs(downloadPath);
    const downloadFailure = await download.failure();
    assert.equal(downloadFailure, null, `PAGE_DOWNLOAD_FAILED:${downloadFailure}`);
    const downloadBytes = await fs.readFile(downloadPath);
    assert.ok(downloadBytes.length > 1000, "PAGE_DOWNLOAD_EMPTY");
    report.pageDownload = { file: suggested, bytes: downloadBytes.length, sha256: sha256(downloadBytes) };

    await page.getByRole("button", { name: "历史", exact: true }).click();
    const historyDialog = page.getByRole("dialog", { name: "生成历史" });
    await historyDialog.waitFor({ state: "visible", timeout: 45_000 });
    await historyDialog.getByText(prompt, { exact: true }).waitFor({ state: "visible", timeout: 45_000 });
    await page.screenshot({ path: path.join(outputDir, "image-workbench-history.png"), fullPage: true });

    const receipts = await Promise.all(postReceiptPromises);
    const persistReceipt = receipts.find((item) => item.path === "/api/image-workbench/persist");
    const historyWriteReceipt = receipts.find((item) => item.path === "/api/image-workbench/history");
    assert.ok(persistReceipt?.status === 200 && persistReceipt.body?.assetId && persistReceipt.body?.historyRecordId, "IMAGE_PERSIST_RECEIPT_MISSING");
    assert.ok(historyWriteReceipt?.status === 200 && historyWriteReceipt.body?.saved?.[0]?.id, "IMAGE_HISTORY_WRITE_RECEIPT_MISSING");
    const history = await getJson(options.origin, "/api/image-workbench/history?page=1", token);
    const persisted = history?.records?.find((record) => record?.items?.some((item) => item?.assetId === generationBody.images[0].assetId));
    assert.ok(persisted, "GENERATED_IMAGE_NOT_FOUND_IN_ACCOUNT_HISTORY");
    const persistedItem = persisted.items.find((item) => item.assetId === generationBody.images[0].assetId);
    assert.equal(persistedItem.prompt, prompt, "ACCOUNT_HISTORY_PROMPT_MISMATCH");
    const status = await getJson(options.origin, `/api/image/status?clientIdempotencyKey=${encodeURIComponent(report.request.clientIdempotencyKey)}&clientTraceId=${encodeURIComponent(report.request.clientTraceId)}`, token);
    assert.equal(status?.state, "completed", "IMAGE_REQUEST_RECORD_NOT_COMPLETED");
    assert.equal(status?.assetId, generationBody.images[0].assetId, "IMAGE_REQUEST_RECORD_ASSET_MISMATCH");
    const providerEvidence = status?.providerEvidence;
    assert.equal(providerEvidence?.ready, true, "IMAGE_PROVIDER_EVIDENCE_READBACK_REQUIRED");
    assert.match(String(providerEvidence?.actualPayloadSha256 || ""), /^[a-f0-9]{64}$/u, "IMAGE_PROVIDER_WIRE_HASH_INVALID");
    assert.match(String(providerEvidence?.dispatchReceiptId || ""), /^[A-Za-z0-9_-]{8,128}$/u, "IMAGE_PROVIDER_DISPATCH_RECEIPT_ID_INVALID");
    assert.match(String(providerEvidence?.submissionReceiptId || ""), /^[A-Za-z0-9_-]{8,128}$/u, "IMAGE_PROVIDER_SUBMISSION_RECEIPT_ID_INVALID");
    assert.match(String(providerEvidence?.dispatchReceiptSha256 || ""), /^[a-f0-9]{64}$/u, "IMAGE_PROVIDER_DISPATCH_RECEIPT_HASH_INVALID");
    assert.match(String(providerEvidence?.submissionReceiptSha256 || ""), /^[a-f0-9]{64}$/u, "IMAGE_PROVIDER_SUBMISSION_RECEIPT_HASH_INVALID");
    assert.equal(providerEvidence?.transportState, "response_received", "IMAGE_PROVIDER_TRANSPORT_RECEIPT_NOT_CONFIRMED");
    assert.equal(providerEvidence?.providerProtocol, report.generation.providerProtocol, "IMAGE_PROVIDER_PROTOCOL_RECEIPT_MISMATCH");
    assert.ok(Number(providerEvidence?.actualPayloadBytes) > 0, "IMAGE_PROVIDER_WIRE_BYTES_INVALID");
    assert.ok(Number(providerEvidence?.responseStatus) >= 200 && Number(providerEvidence?.responseStatus) < 300, "IMAGE_PROVIDER_RESPONSE_STATUS_INVALID");
    assert.match(String(providerEvidence?.responseBodySha256 || ""), /^[a-f0-9]{64}$/u, "IMAGE_PROVIDER_RESPONSE_HASH_INVALID");
    assert.equal(providerEvidence?.requestProjection?.userPromptSha256, sha256(prompt), "IMAGE_PROVIDER_USER_PROMPT_HASH_MISMATCH");
    assert.equal(providerEvidence?.requestProjection?.aspectRatio, aspectRatio, "IMAGE_PROVIDER_ASPECT_RATIO_RECEIPT_MISMATCH");
    assert.equal(providerEvidence?.requestProjection?.resolution, resolution, "IMAGE_PROVIDER_RESOLUTION_RECEIPT_MISMATCH");
    assert.equal(providerEvidence?.requestProjection?.imageCount, options.imageCount, "IMAGE_PROVIDER_IMAGE_COUNT_RECEIPT_MISMATCH");
    report.providerEvidence.readback = providerEvidence;
    report.records = {
      taskId: generationBody.taskId || null,
      traceId: generationBody.traceId || null,
      clientIdempotencyKey: report.request.clientIdempotencyKey,
      operationId: generationBody.operationId || null,
      imageAssetId: generationBody.images[0].assetId,
      conversationHistoryRecordId: persistReceipt.body.historyRecordId,
      imageWorkbenchHistoryId: persisted.id,
      historyWriteId: historyWriteReceipt.body.saved[0].id,
      requestState: status.state,
      deliveryReady: status.deliveryReady === true,
      idempotencyReplayed: generationBody.idempotencyReplayed,
    };

    const after = await readAccountEvidence(options.origin, token, identity.user.id);
    report.billing.after = after;
    report.billing.cashDelta = roundMoney(before.cash - after.cash);
    report.billing.creditsDelta = roundMoney(before.credits - after.credits);
    report.billing.responseCashCharged = Number(generationBody.cashCharged);
    report.billing.historyCashCharged = Number(persistedItem.cashCharged);
    report.billing.balanceMatchesResponse = report.billing.cashDelta === roundMoney(Number(generationBody.cashCharged));
    report.billing.historyMatchesResponse = roundMoney(Number(persistedItem.cashCharged)) === roundMoney(Number(generationBody.cashCharged));
    assert.equal(report.billing.balanceMatchesResponse, true, "CASH_BALANCE_DELTA_MISMATCH");
    assert.equal(report.billing.historyMatchesResponse, true, "HISTORY_BILLING_MISMATCH");
    assert.equal(report.billing.creditsDelta, 0, "IMAGE_GENERATION_MUST_NOT_CONSUME_CREDITS");
    assert.equal(report.diagnostics.pageErrors.length, 0, "PAGE_ERRORS_DETECTED");
    report.status = report.diagnostics.consoleErrors.length || report.diagnostics.networkErrors.length
      ? "passed-with-recorded-diagnostics" : "passed";
    report.completedAt = new Date().toISOString();
  } catch (error) {
    failure = error;
    report.status = "failed-stopped-no-retry";
    report.failedAt = new Date().toISOString();
    report.error = redactText(error instanceof Error ? error.stack || error.message : String(error), token);
  } finally {
    if (context) {
      await context.close().then(() => { report.cleanup.contextClosed = true; }, (error) => {
        report.cleanup.contextCloseError = redactText(error, token);
      });
    }
    if (browser) {
      await browser.close().then(() => { report.cleanup.browserClosed = true; }, (error) => {
        report.cleanup.browserCloseError = redactText(error, token);
      });
    }
    report.policy.tokenPersisted = false;
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  if (failure) throw failure;
  console.log(JSON.stringify({
    status: report.status,
    runtime: report.runtime,
    ordinaryMemberRole: report.actor.role,
    generationPosts: report.diagnostics.generationPostsContinued,
    automaticRetries: report.policy.automaticRetries,
    cashCharged: report.generation.cashCharged,
    historyRestored: Boolean(report.records.imageWorkbenchHistoryId),
    report: path.join(outputDir, "report.json"),
  }, null, 2));
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.execute) {
    const executeArguments = [
      `--run-id=${options.runId}`,
      ...(options.expectedSourceVersion ? [`--expected-source-version=${options.expectedSourceVersion}`] : []),
      ...(options.expectedBuildId ? [`--expected-build-id=${options.expectedBuildId}`] : []),
      ...(options.modelId ? [`--model-id=${options.modelId}`] : []),
      ...(!options.modelId && options.modelNameExplicit ? [`--model-name=${JSON.stringify(options.modelName)}`] : []),
      ...(options.acceptanceProfile === "fixed-prompt-adherence" ? [
        `--prompt=${JSON.stringify(options.prompt)}`,
        `--resolution=${options.resolution}`,
        `--aspect-ratio=${options.aspectRatio}`,
        `--image-count=${options.imageCount}`,
      ] : []),
      "--execute",
    ];
    const providerEvidence = providerEvidenceReadbackContract();
    console.log(JSON.stringify({
      mode: "plan",
      runId: options.runId,
      acceptanceProfile: options.acceptanceProfile,
      networkCalls: 0,
      databaseCalls: 0,
      generationPosts: 0,
      providerCalls: 0,
      paidCalls: 0,
      filesystemWrites: 0,
      requiredRole: "student",
      adminExemptionAccepted: false,
      automaticRetries: 0,
      runtimeLock: options.expectedSourceVersion || options.expectedBuildId ? "explicit-and-runningLatest" : "runningLatest",
      executePreflight: "fresh local read-only 1300+1310+1330 ledger/hash/semantics/owner/ACL readiness before browser creation",
      requestedInputs: {
        prompt: options.acceptanceProfile === "fixed-prompt-adherence" ? options.prompt : null,
        promptSha256: sha256(options.prompt),
        resolution: options.resolution || null,
        aspectRatio: options.aspectRatio || null,
        imageCount: options.imageCount,
      },
      modelSelection: options.acceptanceProfile === "fixed-prompt-adherence"
        ? "dynamic public catalog selection; available+priceReady+exact advertised resolution+exact advertised aspect ratio"
        : "existing smoke selection behavior",
      providerEvidence: options.acceptanceProfile === "fixed-prompt-adherence" ? providerEvidence : {
        requiredFor: providerEvidence.requiredFor,
        ready: providerEvidence.ready,
        enforcedForThisProfile: false,
      },
      executeWillFailClosedBeforeBrowserClick: options.acceptanceProfile === "fixed-prompt-adherence"
        ? "unless fresh 1330 readiness succeeds" : false,
      executeCommand: `node scripts/with-local-customer-session.mjs ${SCRIPT_PATH} ${executeArguments.join(" ")}`,
    }, null, 2));
    return;
  }
  await runExecute(options);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await main();
