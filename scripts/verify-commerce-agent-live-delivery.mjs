#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const terminalStatuses = new Set(["succeeded", "failed", "save_failed"]);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (value) => createHash("sha256").update(String(value || "")).digest("hex");

function option(args, name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function currentPublishedRoutes(overview) {
  const release = (overview.releases || []).find((value) => value.id === overview.current?.releaseId);
  assert.ok(release?.is_current === true && release?.status === "published", "CURRENT_COMMERCE_RELEASE_REQUIRED");
  const routeIds = new Set(Array.isArray(release.manifest?.operationRouteIds) ? release.manifest.operationRouteIds.map(String) : []);
  return (overview.routes || []).filter((route) => routeIds.has(String(route.id)));
}

function selectionDefaults(card) {
  const values = {};
  for (const field of card.inputFields || []) {
    if (["spokenLanguage", "scriptDuration", "generateAudio"].includes(field.id)) continue;
    if (field.defaultValue !== undefined) values[field.id] = field.defaultValue;
    else if (field.required && field.type === "select") values[field.id] = field.options?.[0] || "";
    else if (field.required && field.type === "number") values[field.id] = Number(field.validation?.min || 1);
    else if (field.required && field.type === "boolean") values[field.id] = false;
    else if (field.required) values[field.id] = "虚构商品测试";
  }
  return values;
}

async function main(args = process.argv.slice(2)) {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_MAIN_SITE_REQUIRED");
  assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");

  const runAgentCanary = args.includes("--agent-canary");
  const runDirectors = args.includes("--all-directors") || Number(option(args, "max-directors") || 0) > 0;
  const runVideoCanary = args.includes("--h3-video-canary");
  const paid = args.includes("--confirm-paid");
  const forceAgent = args.includes("--force-agent-canary");
  const forceVideo = args.includes("--force-video-canary");
  const recoverConversationId = String(option(args, "recover-conversation") || "").trim();
  const maxDirectors = Math.max(0, Number(option(args, "max-directors") || (args.includes("--all-directors") ? 100 : 0)));
  const maxQuotedTotal = Math.max(0, Number(option(args, "max-total") || 25));
  if (runAgentCanary || runDirectors || runVideoCanary) assert.equal(paid, true, "PAID_CONFIRMATION_FLAG_REQUIRED");

  const outputDir = path.resolve(option(args, "output") || `.codex-evidence/commerce-live-delivery-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  await mkdir(outputDir, { recursive: true });
  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    scope: { runAgentCanary, runDirectors, runVideoCanary, maxDirectors, maxQuotedTotal },
    session: null,
    configuration: null,
    assets: [],
    canaries: [],
    directors: [],
    totals: { quotedUserPrice: 0, estimatedProviderCost: 0, providerSubmissions: 0 },
    credentialsPersisted: false,
  };
  const persist = () => writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

  async function jsonRequest(pathname, { method = "GET", body, admin = false, form } = {}) {
    const headers = { Accept: "application/json", Origin: origin };
    if (admin) headers.Authorization = `Bearer ${token}`;
    if (!admin && commerceCookie) headers.Cookie = commerceCookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(form ? { body: form } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(300_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false || payload?.error) {
      const error = new Error(String(payload?.error || payload?.message || `HTTP_${response.status}`));
      error.status = response.status;
      error.code = payload?.code || null;
      throw error;
    }
    return { response, payload };
  }

  let commerceCookie = "";
  const bindResponse = await fetch(`${origin}/api/commerce/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Origin: origin },
    body: JSON.stringify({ action: "main-bind", mainToken: token }),
    signal: AbortSignal.timeout(30_000),
  });
  const bindPayload = await bindResponse.json().catch(() => ({}));
  assert.ok(bindResponse.ok && bindPayload?.user?.id, bindPayload?.error || "COMMERCE_SESSION_BIND_FAILED");
  commerceCookie = String(bindResponse.headers.get("set-cookie") || "").split(";", 1)[0];
  assert.ok(commerceCookie.includes("="), "COMMERCE_SESSION_COOKIE_REQUIRED");
  report.session = { userRole: bindPayload.user.role, workspaceStorage: bindPayload.workspaceStorage || null };

  const overview = (await jsonRequest("/api/admin/commerce", { admin: true })).payload;
  const routes = currentPublishedRoutes(overview);
  const currentRelease = (overview.releases || []).find((value) => value.id === overview.current?.releaseId);
  const currentCardIds = new Set(Array.isArray(currentRelease?.manifest?.cardVersionIds) ? currentRelease.manifest.cardVersionIds.map(String) : []);
  const modelById = new Map((overview.models || []).map((model) => [String(model.id), model]));
  const currentAgentRoute = routes.find((route) => route.model_kind === "agent");
  const h3Model = (overview.models || []).find((model) => model.kind === "video" && /MiniMax H3.*(?:电商|4-15)/iu.test(String(model.displayName || "")));
  const currentAgentModel = modelById.get(String(currentAgentRoute?.primary_model_id || ""));
  assert.ok(currentAgentModel, "CURRENT_AGENT_MODEL_REQUIRED");
  if (runVideoCanary) assert.ok(h3Model, "MINIMAX_H3_COMMERCE_MODEL_REQUIRED");
  report.configuration = {
    releaseId: overview.current.releaseId,
    releaseVersion: overview.current.releaseVersion,
    directorCards: (overview.cardVersions || []).filter((card) => currentCardIds.has(String(card.id)) && card.executor_type === "director").length,
    currentAgentModel: { id: currentAgentModel.id, displayName: currentAgentModel.displayName, verifiedAt: currentAgentModel.verifiedAt },
    h3VideoModel: h3Model ? { id: h3Model.id, displayName: h3Model.displayName, verifiedAt: h3Model.verifiedAt } : null,
  };
  await persist();

  let imageAssetId = "";
  async function ensureImageAsset() {
    if (imageAssetId) return imageAssetId;
    const fixturePath = path.resolve("public/short-drama/previews/inspiration-product-film-v1.webp");
    const bytes = await readFile(fixturePath);
    const form = new FormData();
    form.set("file", new File([bytes], "commerce-delivery-reference.webp", { type: "image/webp" }));
    const { payload } = await jsonRequest("/api/commerce/assets", { method: "POST", form });
    assert.ok(payload?.asset?.id, "REFERENCE_ASSET_UPLOAD_FAILED");
    imageAssetId = String(payload.asset.id);
    report.assets.push({ id: imageAssetId, type: payload.asset.type, size: payload.asset.size, sourceSha256: sha256(bytes) });
    await persist();
    return imageAssetId;
  }

  async function pollAdminCanary(jobId, timeoutMs) {
    const startedAt = Date.now();
    const timeline = [];
    let previous = "";
    while (Date.now() - startedAt < timeoutMs) {
      const job = (await jsonRequest(`/api/admin/commerce/models/canary?jobId=${encodeURIComponent(jobId)}`, { admin: true })).payload.job;
      if (job.status !== previous) {
        timeline.push({ status: job.status, elapsedMs: Date.now() - startedAt });
        previous = job.status;
      }
      if (terminalStatuses.has(job.status)) return { job, timeline, elapsedMs: Date.now() - startedAt };
      await sleep(4_000);
    }
    throw new Error(`CANARY_TIMEOUT_${jobId}`);
  }

  async function runCanary(kind, model, { referenceAssetIds = [], force = false } = {}) {
    if (model.verifiedAt && !force) {
      const result = { kind, modelId: model.id, displayName: model.displayName, skipped: true, reason: "CURRENT_CONFIG_ALREADY_ACCEPTED", verifiedAt: model.verifiedAt };
      report.canaries.push(result);
      await persist();
      return result;
    }
    const quoteBody = {
      action: "quote",
      kind,
      modelId: model.id,
      referenceAssetIds,
      ...(kind === "video" ? { duration: 4, aspectRatio: "9:16", resolution: "720p", generateAudio: false } : {}),
    };
    const quote = (await jsonRequest("/api/admin/commerce/models/canary", { method: "POST", admin: true, body: quoteBody })).payload.quote;
    report.totals.estimatedProviderCost += Number(quote.estimatedProviderCost || 0);
    const submitted = (await jsonRequest("/api/admin/commerce/models/canary", {
      method: "POST",
      admin: true,
      body: { action: "confirm", quoteId: quote.id, inputFingerprint: quote.inputFingerprint },
    })).payload.job;
    report.totals.providerSubmissions += 1;
    const settled = await pollAdminCanary(submitted.id, kind === "video" ? 20 * 60_000 : 6 * 60_000);
    const result = {
      kind,
      modelId: model.id,
      displayName: model.displayName,
      quote: {
        estimatedProviderCost: quote.estimatedProviderCost,
        ordinaryUserPrice: quote.ordinaryUserPrice,
        billingUnit: quote.billingUnit,
        quantity: quote.quantity,
      },
      jobId: submitted.id,
      status: settled.job.status,
      timeline: settled.timeline,
      elapsedMs: settled.elapsedMs,
      outputAssets: settled.job.assetIds?.length || 0,
      outputCharacters: String(settled.job.text || "").trim().length,
      billingStatus: settled.job.billing?.status || null,
      error: settled.job.error || null,
    };
    report.canaries.push(result);
    await persist();
    assert.equal(settled.job.status, "succeeded", `CANARY_FAILED_${model.displayName}: ${settled.job.error || "unknown"}`);
    const evidence = (await jsonRequest("/api/admin/commerce/models/canary", {
      method: "POST",
      admin: true,
      body: { action: "register", jobId: submitted.id },
    })).payload.evidence;
    result.registeredAt = evidence.verified_at;
    await persist();
    return result;
  }

  if (runAgentCanary) await runCanary("agent", currentAgentModel, { force: forceAgent });

  async function pollCommerceJob(jobId, timeoutMs = 6 * 60_000) {
    const startedAt = Date.now();
    const timeline = [];
    let previous = "";
    while (Date.now() - startedAt < timeoutMs) {
      const jobs = (await jsonRequest("/api/commerce/jobs")).payload.jobs || [];
      const job = jobs.find((value) => value.id === jobId);
      assert.ok(job, `COMMERCE_JOB_NOT_FOUND_${jobId}`);
      if (job.status !== previous) {
        timeline.push({ status: job.status, elapsedMs: Date.now() - startedAt });
        previous = job.status;
      }
      if (terminalStatuses.has(job.status)) return { job, timeline, elapsedMs: Date.now() - startedAt };
      await sleep(2_500);
    }
    throw new Error(`COMMERCE_JOB_TIMEOUT_${jobId}`);
  }

  if (recoverConversationId) {
    assert.match(recoverConversationId, /^[a-f0-9-]{36}$/iu, "RECOVERY_CONVERSATION_ID_INVALID");
    const before = (await jsonRequest(`/api/commerce/director-conversations?id=${encodeURIComponent(recoverConversationId)}`)).payload.conversation;
    const activeJobId = String(before.activeJobId || "");
    let settled = null;
    if (activeJobId) settled = await pollCommerceJob(activeJobId, 8 * 60_000);
    const after = (await jsonRequest(`/api/commerce/director-conversations?id=${encodeURIComponent(recoverConversationId)}`)).payload.conversation;
    const assistant = [...(after.messages || [])].reverse().find((value) => value.role === "assistant");
    report.recovery = {
      conversationId: recoverConversationId,
      recoveredOriginalJobOnly: true,
      activeBefore: activeJobId || null,
      status: settled?.job?.status || (assistant?.status === "completed" ? "succeeded" : assistant?.status || "idle"),
      timeline: settled?.timeline || [],
      outputCharacters: String(settled?.job?.text || assistant?.content || "").trim().length,
      businessState: assistant?.business?.state || null,
      readyForApplication: assistant?.business?.state === "ready" && Boolean(assistant?.business?.generationText),
      error: settled?.job?.error || assistant?.business?.error || null,
    };
    await persist();
  }

  async function runDirector(card, assetId) {
    const conversationId = randomUUID();
    const settings = {
      skillKey: card.key,
      selections: selectionDefaults(card),
      spokenLanguage: "中文",
      durationSeconds: 12,
      generateAudio: false,
    };
    const references = [];
    for (const slot of card.slots || []) {
      if (slot.min <= 0) continue;
      assert.ok(slot.kinds.includes("image"), `${card.key} requires unsupported paid-test media: ${slot.kinds.join(",")}`);
      for (let index = 0; index < slot.min; index += 1) {
        references.push({ id: assetId, slot: slot.key, instanceId: `${assetId}:${slot.key}:${index}` });
      }
    }
    await jsonRequest("/api/commerce/director-conversations", {
      method: "POST",
      body: { action: "open", id: conversationId, settings },
    });
    const operationId = randomUUID();
    const message = `请以“${card.name}”的方法，为一款虚构的便携保温杯制作12秒中文短视频脚本。突出便携、易清洁和日常通勤场景，不虚构价格、销量、认证或医疗功效。请严格按当前编导的结构化输出合同返回可直接应用的完整脚本。`;
    const quote = (await jsonRequest("/api/commerce/director-conversations", {
      method: "POST",
      body: { action: "quote", id: conversationId, operationId, message, expectedScriptMessageId: null, settings, references },
    })).payload.quote;
    const nextQuotedTotal = report.totals.quotedUserPrice + Number(quote.payableTotal || 0);
    assert.ok(nextQuotedTotal <= maxQuotedTotal, `MAX_QUOTED_TOTAL_EXCEEDED_${nextQuotedTotal}`);
    report.totals.quotedUserPrice = nextQuotedTotal;
    const submitted = (await jsonRequest("/api/commerce/jobs", {
      method: "POST",
      body: { quoteId: quote.id, clientRequestId: randomUUID(), inputFingerprint: quote.inputFingerprint },
    })).payload.job;
    report.totals.providerSubmissions += 1;
    const settled = await pollCommerceJob(submitted.id);
    const conversation = (await jsonRequest(`/api/commerce/director-conversations?id=${encodeURIComponent(conversationId)}`)).payload.conversation;
    const assistant = (conversation.messages || []).find((messageValue) => messageValue.jobId === submitted.id && messageValue.role === "assistant");
    return {
      key: card.key,
      name: card.name,
      conversationId,
      jobId: submitted.id,
      price: quote.payableTotal,
      model: quote.model?.displayName || null,
      status: settled.job.status,
      timeline: settled.timeline,
      elapsedMs: settled.elapsedMs,
      outputCharacters: String(settled.job.text || "").trim().length,
      outputSha256: sha256(settled.job.text || ""),
      businessState: assistant?.business?.state || null,
      readyForApplication: assistant?.business?.state === "ready" && Boolean(assistant?.business?.generationText),
      billingStatus: settled.job.billing?.status || null,
      error: settled.job.error || assistant?.business?.error || null,
    };
  }

  if (runDirectors) {
    const assetId = await ensureImageAsset();
    const directors = (await jsonRequest("/api/commerce/v1/director-catalog")).payload.directors || [];
    assert.equal(directors.length, 19, "NINETEEN_PUBLISHED_DIRECTORS_REQUIRED");
    let consecutiveFailures = 0;
    for (const card of directors.slice(0, maxDirectors)) {
      try {
        const result = await runDirector(card, assetId);
        report.directors.push(result);
        consecutiveFailures = result.status === "succeeded" && result.readyForApplication ? 0 : consecutiveFailures + 1;
      } catch (error) {
        report.directors.push({ key: card.key, name: card.name, status: "test_failed", error: error instanceof Error ? error.message : String(error) });
        consecutiveFailures += 1;
      }
      await persist();
      if (consecutiveFailures >= 2) break;
    }
  }

  if (runVideoCanary) {
    const assetId = await ensureImageAsset();
    await runCanary("video", h3Model, { referenceAssetIds: [assetId], force: forceVideo });
  }

  report.completedAt = new Date().toISOString();
  report.result = {
    canariesPassed: report.canaries.filter((value) => value.skipped || value.status === "succeeded").length,
    canariesRequested: report.canaries.length,
    directorsPassed: report.directors.filter((value) => value.status === "succeeded" && value.readyForApplication).length,
    directorsRequested: report.directors.length,
  };
  await persist();
  console.log(JSON.stringify({ evidence: outputDir, configuration: report.configuration, totals: report.totals, result: report.result }, null, 2));

  if (runDirectors) assert.equal(report.result.directorsPassed, Math.min(maxDirectors, 19), "DIRECTOR_LIVE_DELIVERY_INCOMPLETE");
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
