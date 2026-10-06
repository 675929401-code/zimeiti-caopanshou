#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(new URL(pathname, origin), {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  return { response, body };
}

async function requiredJson(pathname, options = {}) {
  const result = await requestJson(pathname, options);
  assert.ok(result.response.ok, result.body?.error || result.body?.message || `${new URL(pathname, origin).pathname}:${result.response.status}`);
  return result.body;
}

async function billingSnapshot() {
  const [balance, transactions] = await Promise.all([
    requiredJson("/api/cash/balance"),
    requiredJson("/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=100"),
  ]);
  return {
    balance: Number(balance.balance),
    rows: (transactions?.data?.transactions || []).filter((row) => row?.category === "cash"),
  };
}

async function waitForActiveModel(button, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await button.getAttribute("class"))?.includes("is-active")) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function main() {
  const runId = argument("run-id");
  const taskId = argument("task-id");
  const modelId = argument("model-id");
  const projectId = argument("project-id") || `sbw-video-${runId}`;
  const timeoutMs = Number(argument("completion-timeout-ms") || "900000");
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  assert.match(runId, /^[A-Za-z0-9_-]{8,100}$/u, "ORIGINAL_RUN_ID_REQUIRED");
  assert.match(taskId, /^vt_[A-Za-z0-9_-]{20,100}$/u, "ORIGINAL_BUSINESS_TASK_ID_REQUIRED");
  assert.match(modelId, /^pm_[A-Za-z0-9_-]{20,100}$/u, "ORIGINAL_PUBLIC_MODEL_ID_REQUIRED");
  assert.match(projectId, /^[A-Za-z0-9_-]{8,160}$/u, "ORIGINAL_PROJECT_ID_REQUIRED");
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 1_800_000, "COMPLETION_TIMEOUT_INVALID");

  const outputDir = path.resolve(".codex-evidence/storyboard-video-platform-fix-20260920", runId);
  const dispatch = JSON.parse(await fs.readFile(path.join(outputDir, "dispatch.json"), "utf8"));
  assert.equal(dispatch.runId, runId, "DISPATCH_RUN_ID_MISMATCH");
  assert.equal(dispatch.selectedModelId, modelId, "DISPATCH_MODEL_ID_MISMATCH");
  assert.equal(dispatch.projectId, projectId, "DISPATCH_PROJECT_ID_MISMATCH");
  const report = {
    runId,
    taskId,
    modelId,
    projectId,
    startedAt: new Date().toISOString(),
    mode: "reconcile-original-task",
    newGenerationPosts: 0,
    automaticRetries: 0,
    balanceBefore: Number(dispatch.balanceBefore),
    observations: [],
  };
  const saveProgress = () => fs.writeFile(path.join(outputDir, "reconciliation-progress.json"), `${JSON.stringify(report, null, 2)}\n`);

  const identity = await requiredJson("/api/auth/me");
  assert.equal(identity?.user?.role, "admin", "ADMIN_ROLE_REQUIRED");
  const version = await requiredJson("/api/version");
  report.sourceVersion = version.sourceVersion;
  report.buildId = version.buildId;

  const terminalStates = new Set(["completed", "failed", "cancelled", "expired"]);
  const deadline = Date.now() + timeoutMs;
  let terminal = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const status = await requestJson(`/api/video/status?${new URLSearchParams({ taskId, modelId })}`,
      { signal: AbortSignal.timeout(90_000) });
    const state = String(status.body?.status || `http-${status.response.status}`);
    const observation = {
      at: new Date().toISOString(),
      attempt,
      http: status.response.status,
      status: state,
      progress: status.body?.progress ?? null,
      stage: status.body?.processingStage || null,
      billingState: status.body?.billingState || null,
      priceCharged: Number(status.body?.priceCharged || 0),
      errorCode: status.body?.errorCode || status.body?.error_code || null,
      message: String(status.body?.errorMessage || status.body?.message || "").slice(0, 300),
    };
    const previous = report.observations.at(-1);
    if (!previous || previous.status !== observation.status || previous.progress !== observation.progress || attempt % 6 === 0) {
      report.observations.push(observation);
      console.log(JSON.stringify(observation));
      await saveProgress();
    }
    if (terminalStates.has(state)) {
      terminal = { ...observation, videoUrl: status.body?.videoUrl || status.body?.storageUrl || "" };
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  assert.ok(terminal, "ORIGINAL_TASK_RECONCILIATION_TIMEOUT");
  report.terminal = terminal;
  assert.equal(terminal.status, "completed", terminal.message || `ORIGINAL_TASK_${terminal.status.toUpperCase()}`);

  const [history, project, billingAfter] = await Promise.all([
    requiredJson("/api/video/history?surface=storyboard-workbench&limit=200"),
    requiredJson(`/api/storyboard/projects?id=${encodeURIComponent(projectId)}`),
    billingSnapshot(),
  ]);
  const historyTask = history.tasks?.find((task) => task.id === taskId || task.taskIdExternal === taskId);
  assert.ok(historyTask, "STORYBOARD_VIDEO_HISTORY_MISSING");
  assert.equal(historyTask.status, "completed", "STORYBOARD_VIDEO_HISTORY_NOT_COMPLETED");
  assert.equal(historyTask.modelId, modelId, "STORYBOARD_VIDEO_HISTORY_MODEL_MISMATCH");
  const expectedCharge = Number(historyTask.priceCharged || terminal.priceCharged || 0);
  assert.ok(Number.isFinite(expectedCharge) && expectedCharge > 0, "STORYBOARD_VIDEO_CHARGE_MISSING");
  const balanceDelta = Number((report.balanceBefore - billingAfter.balance).toFixed(6));
  assert.ok(Math.abs(balanceDelta - expectedCharge) <= 0.000001,
    `VIDEO_BILLING_BALANCE_DELTA_MISMATCH:${balanceDelta}:${expectedCharge}`);
  const billingRow = billingAfter.rows.find((row) => String(row.referenceId || "") === `video-terminal:${taskId}`);
  assert.ok(billingRow, "VIDEO_BILLING_TRANSACTION_MISSING");
  assert.ok(Math.abs(Math.abs(Number(billingRow.amount)) - expectedCharge) <= 0.000001,
    "VIDEO_BILLING_TRANSACTION_AMOUNT_MISMATCH");

  const card = project?.project?.document?.cards?.find((item) => item.videoTaskId === taskId) || project?.project?.document?.cards?.[0];
  assert.equal(project?.project?.document?.videoModelId, modelId, "PROJECT_VIDEO_MODEL_NOT_PERSISTED");
  assert.equal(card?.videoStatus, "done", "PROJECT_VIDEO_STATUS_NOT_RECONCILED");
  assert.equal(card?.videoTaskId, taskId, "PROJECT_VIDEO_TASK_NOT_RECONCILED");

  const ticket = await requiredJson(`/api/video/access-ticket?${new URLSearchParams({ taskId, scope: "download", name: `${runId}.mp4` })}`);
  assert.ok(ticket.url, "STORYBOARD_VIDEO_DOWNLOAD_TICKET_MISSING");
  const media = await fetch(new URL(ticket.url, origin), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
  const mediaBytes = Buffer.from(await media.arrayBuffer());
  assert.ok(media.ok && mediaBytes.length > 1_024, "STORYBOARD_VIDEO_MEDIA_INVALID");
  assert.equal(mediaBytes.subarray(4, 8).toString("ascii"), "ftyp", "STORYBOARD_VIDEO_MP4_HEADER_INVALID");
  const mediaFile = path.join(outputDir, "generated-video.mp4");
  await fs.writeFile(mediaFile, mediaBytes);

  const browser = await chromium.launch({ headless: true });
  const browserEvidence = { generationPosts: 0, pageErrors: [], consoleErrors: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    page.on("pageerror", (error) => browserEvidence.pageErrors.push(error.message.slice(0, 400)));
    page.on("console", (message) => { if (message.type() === "error") browserEvidence.consoleErrors.push(message.text().slice(0, 400)); });
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/video/generate") browserEvidence.generationPosts += 1;
    });

    const restore = async () => {
      await page.getByRole("button", { name: "最近任务", exact: true }).first().click();
      const projectElement = page.locator(`[data-storyboard-project-id="${projectId}"]`);
      await projectElement.waitFor({ state: "visible", timeout: 45_000 });
      await projectElement.getByRole("button", { name: "打开任务", exact: true }).click();
      const currentCard = page.locator("article.sbw-shot-card").first();
      await currentCard.waitFor({ state: "visible", timeout: 45_000 });
      const selected = page.locator(`.sbw-video-model-list button[data-model-id="${modelId}"]`).first();
      await selected.waitFor({ state: "visible", timeout: 45_000 });
      assert.equal(await waitForActiveModel(selected), true, "VIDEO_MODEL_SELECTION_NOT_RESTORED");
      await currentCard.locator('[data-status="done"]').filter({ hasText: "视频完成" }).waitFor({ state: "visible", timeout: 60_000 });
      const video = currentCard.locator("video").first();
      await video.waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForFunction(() => {
        const element = document.querySelector("article.sbw-shot-card video");
        return element instanceof HTMLVideoElement && element.readyState >= 1 && element.videoWidth > 0 && element.videoHeight > 0;
      }, undefined, { timeout: 120_000 });
      return video.evaluate((element) => ({
        width: element.videoWidth,
        height: element.videoHeight,
        duration: element.duration,
        readyState: element.readyState,
      }));
    };

    await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const firstRender = await restore();
    await page.screenshot({ path: path.join(outputDir, "storyboard-video-reconciled.png"), fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    const secondRender = await restore();
    assert.equal(browserEvidence.generationPosts, 0, "RECONCILIATION_MUST_NOT_GENERATE_AGAIN");
    browserEvidence.firstRender = firstRender;
    browserEvidence.secondRender = secondRender;
    await context.close();
  } finally {
    await browser.close();
  }

  Object.assign(report, {
    completedAt: new Date().toISOString(),
    success: true,
    history: { status: historyTask.status, modelId: historyTask.modelId, priceCharged: expectedCharge },
    billing: {
      balanceAfter: billingAfter.balance,
      balanceDelta,
      referenceId: billingRow.referenceId,
      amount: Number(billingRow.amount),
    },
    project: { revision: project.project.revision, videoModelId: project.project.document.videoModelId, videoStatus: card.videoStatus },
    media: {
      bytes: mediaBytes.length,
      sha256: createHash("sha256").update(mediaBytes).digest("hex"),
      contentType: media.headers.get("content-type") || "",
      file: path.basename(mediaFile),
    },
    browser: browserEvidence,
    tokenPersisted: false,
  });
  const reportPath = path.join(outputDir, "reconciliation.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ success: true, runId, taskId, priceCharged: expectedCharge, balanceDelta,
    newGenerationPosts: 0, report: reportPath }));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await main().catch(async (error) => {
    const outputDir = path.resolve(".codex-evidence/storyboard-video-platform-fix-20260920", argument("run-id"));
    await fs.mkdir(outputDir, { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(outputDir, "reconciliation-failure.json"), `${JSON.stringify({
      failedAt: new Date().toISOString(),
      newGenerationPosts: 0,
      message: error instanceof Error ? error.message.slice(0, 1_200) : String(error).slice(0, 1_200),
    }, null, 2)}\n`).catch(() => {});
    throw error;
  });
}
