#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
const modelId = "pm_Stp5Ka3hsbnsvqOaqdB0TUl3";
const duration = 1;
const resolution = "480p";
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9) || "";
const execute = process.argv.includes("--execute");
const outputDir = path.resolve(`.codex-evidence/video-cheapest-canary-20260926/${runId}`);
const clientRequestId = `video-cheap-${runId}`;
const report = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  origin,
  modelId,
  duration,
  resolution,
  providerPosts: 0,
  automaticRetries: 0,
  observations: [],
};

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");
assert.match(runId, /^[a-z0-9-]{8,80}$/u, "UNIQUE_RUN_ID_REQUIRED");
await fs.mkdir(outputDir, { recursive: true });

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(240_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { invalidJson: true, preview: text.slice(0, 200) }; }
  return { response, body };
}

async function save(name = "report.json") {
  await fs.writeFile(path.join(outputDir, name), `${JSON.stringify(report, null, 2)}\n`);
}

try {
  const identity = await requestJson("/api/auth/me");
  assert.ok(identity.response.ok && identity.body?.user?.role === "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  report.userId = identity.body.user.id;

  const version = await requestJson("/api/version");
  assert.ok(version.response.ok, "VERSION_READ_FAILED");
  report.sourceVersion = version.body.sourceVersion;
  report.buildId = version.body.buildId;

  const catalog = await requestJson("/api/video/models?surface=video-page");
  assert.ok(catalog.response.ok, "VIDEO_CATALOG_READ_FAILED");
  const model = catalog.body?.models?.find((item) => item.id === modelId);
  assert.ok(model, "CHEAPEST_MODEL_MISSING");
  assert.equal(model.capabilities?.available, true, "CHEAPEST_MODEL_UNAVAILABLE");
  assert.equal(model.capabilities?.generationReady, true, `CHEAPEST_MODEL_NOT_READY:${model.capabilities?.readinessMessage || ""}`);
  assert.equal(model.capabilities?.requiresImage, false, "CHEAPEST_MODEL_MUST_BE_TEXT_TO_VIDEO");
  assert.ok(model.capabilities?.nativeDurations?.includes(duration), "ONE_SECOND_DURATION_NOT_SUPPORTED");
  assert.ok(model.capabilities?.resolutionOptions?.includes(resolution), "LOWEST_RESOLUTION_NOT_SUPPORTED");
  assert.ok(Number(model.publicPrice) > 0 && Number(model.publicPrice) <= 0.04, `PRICE_CEILING_EXCEEDED:${model.publicPrice}`);
  Object.assign(report, {
    modelName: model.displayName,
    publicPrice: Number(model.publicPrice),
    priceUnit: model.capabilities?.billingUnit,
    pricingMode: model.capabilities?.pricingMode,
    priceCeiling: 0.04,
  });

  if (!execute) {
    report.planOnly = true;
    report.success = true;
    await save();
    console.log(JSON.stringify({ success: true, planOnly: true, model: report.modelName, providerPosts: 0, priceCeiling: 0.04 }));
    process.exit(0);
  }

  const before = await requestJson("/api/cash/balance");
  assert.ok(before.response.ok && Number.isFinite(Number(before.body?.balance)), "BALANCE_BEFORE_INVALID");
  report.balanceBefore = Number(before.body.balance);

  const dispatch = {
    createdAt: new Date().toISOString(),
    clientRequestId,
    modelId,
    modelName: model.displayName,
    duration,
    resolution,
    priceCeiling: 0.04,
    providerPostLimit: 1,
    automaticRetries: 0,
  };
  await fs.writeFile(path.join(outputDir, "dispatch.json"), `${JSON.stringify(dispatch, null, 2)}\n`, { flag: "wx" });

  const payload = {
    model_id: modelId,
    prompt: "清晨的湖面上，一艘白色纸船缓慢向前漂动，固定镜头，柔和自然光，画面稳定，无文字，无水印。",
    duration,
    aspect_ratio: "16:9",
    resolution,
    resolution_tier: resolution,
    task_label: `最低价视频链路实测 ${runId}`,
    client_request_id: clientRequestId,
    surface: "video-page",
  };
  report.providerPosts = 1;
  const submitted = await requestJson("/api/video/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": clientRequestId,
      "X-Request-ID": clientRequestId,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(240_000),
  });
  report.submission = {
    http: submitted.response.status,
    taskId: submitted.body?.task_id || null,
    businessTaskId: submitted.body?.business_task_id || null,
    status: submitted.body?.status || null,
    errorCode: submitted.body?.error_code || null,
    message: submitted.body?.error || submitted.body?.message || null,
    taskSubmitted: submitted.body?.task_submitted ?? null,
    price: submitted.body?.price ?? null,
  };
  await save();

  const taskId = String(submitted.body?.business_task_id || submitted.body?.task_id || "");
  if (!taskId) {
    report.terminal = {
      status: "failed",
      errorCode: submitted.body?.error_code || "SUBMISSION_NO_TASK_RECEIPT",
      message: submitted.body?.error || submitted.body?.message || `HTTP ${submitted.response.status}`,
    };
  } else {
    const terminal = new Set(["completed", "failed", "cancelled", "expired"]);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await requestJson(`/api/video/status?${new URLSearchParams({ taskId, modelId })}`,
        { signal: AbortSignal.timeout(60_000) });
      const state = String(status.body?.status || `http-${status.response.status}`);
      const previous = report.observations.at(-1)?.status;
      if (state !== previous || attempt % 6 === 5) {
        const observation = {
          at: new Date().toISOString(),
          attempt: attempt + 1,
          http: status.response.status,
          status: state,
          stage: status.body?.processingStage || null,
          progress: status.body?.progress ?? null,
          errorCode: status.body?.errorCode || null,
          message: status.body?.errorMessage || status.body?.message || null,
        };
        report.observations.push(observation);
        console.log(JSON.stringify(observation));
        await save();
      }
      if (terminal.has(state)) {
        report.terminal = {
          status: state,
          taskId,
          priceCharged: Number(status.body?.priceCharged || 0),
          billingState: status.body?.billingState || null,
          errorCode: status.body?.errorCode || null,
          message: status.body?.errorMessage || "",
          videoUrlPresent: Boolean(status.body?.videoUrl),
        };
        if (state === "completed") {
          assert.ok(Number(status.body?.priceCharged) <= 0.04 + 1e-9, `CHARGE_CEILING_EXCEEDED:${status.body?.priceCharged}`);
          assert.ok(status.body?.videoUrl, "COMPLETED_VIDEO_URL_MISSING");
          const media = await fetch(new URL(status.body.videoUrl, origin), {
            headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-4095" },
            signal: AbortSignal.timeout(120_000),
          });
          const bytes = Buffer.from(await media.arrayBuffer());
          report.media = {
            http: media.status,
            bytes: bytes.length,
            contentType: media.headers.get("content-type") || "",
            mp4Header: bytes.length >= 8 ? bytes.subarray(4, 8).toString("ascii") : "",
          };
          assert.ok(media.ok && bytes.length > 8, "COMPLETED_VIDEO_MEDIA_UNREADABLE");
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    if (!report.terminal) report.terminal = { status: "processing_timeout", taskId };
  }

  const history = await requestJson("/api/video/history?surface=video-page&limit=100");
  const historyTask = history.body?.tasks?.find((task) => task.id === report.submission?.businessTaskId
    || task.id === report.terminal?.taskId
    || task.clientRequestId === clientRequestId);
  report.history = historyTask ? {
    found: true,
    id: historyTask.id,
    status: historyTask.status,
    modelId: historyTask.modelId,
    priceCharged: Number(historyTask.priceCharged || 0),
  } : { found: false };

  const after = await requestJson("/api/cash/balance");
  assert.ok(after.response.ok && Number.isFinite(Number(after.body?.balance)), "BALANCE_AFTER_INVALID");
  report.balanceAfter = Number(after.body.balance);
  report.balanceDelta = Number((report.balanceBefore - report.balanceAfter).toFixed(6));
  report.completedAt = new Date().toISOString();
  report.success = report.terminal?.status === "completed"
    && report.history?.found === true
    && report.providerPosts === 1
    && report.automaticRetries === 0;
  await save();
  console.log(JSON.stringify({
    success: report.success,
    model: report.modelName,
    taskId: report.terminal?.taskId || report.submission?.businessTaskId,
    terminal: report.terminal,
    history: report.history,
    providerPosts: report.providerPosts,
    automaticRetries: report.automaticRetries,
    balanceDelta: report.balanceDelta,
    report: path.join(outputDir, "report.json"),
  }));
} catch (error) {
  report.completedAt = new Date().toISOString();
  report.success = false;
  report.runnerError = error instanceof Error ? error.message : String(error);
  await save("failure.json");
  console.error(JSON.stringify({ success: false, runnerError: report.runnerError, report: path.join(outputDir, "failure.json") }));
  process.exitCode = 1;
}
