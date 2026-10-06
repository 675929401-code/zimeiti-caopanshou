#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice("--run-id=".length) || "";
const execute = process.argv.includes("--execute");
const promptPath = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/pet-high-energy-platform-ui-e2e/pet-high-energy-ui-execute-r851-20261006a/platform-high-energy-image-prompt.txt",
);
const expectedPromptSha256 = "f0539997ebef1b8d609962ba64c0db9af8d78c9591ea8d0bd6968d14580f49c5";
const outputDir = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/two-image-repairs-platform-ui",
  runId || "invalid",
);
const targets = [
  {
    position: 5,
    publicModelId: "pm_sHaGkgaNoH1ZgQzpHW2dEUyF",
    internalModelId: "gemini-3-1-flash-image-chA",
    displayNeedle: "Nano Banana 2",
    expectedResolution: "2K",
    expectedPrice: 0.14,
    fileBase: "image-05-nano-banana-2",
  },
  {
    position: 7,
    publicModelId: "pm_-WG0Q6J5X1cNAA2bnBaFGZc1",
    internalModelId: "gemini-3-0-pro-image-chA",
    displayNeedle: "Gemini 3.0 Pro Image",
    expectedResolution: "2K",
    expectedPrice: 0.15,
    fileBase: "image-07-gemini-3-0-pro-image",
  },
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token && identity?.user?.id, "LOCAL_ADMIN_SESSION_REQUIRED");
assert.match(runId, /^[a-zA-Z0-9_-]{8,100}$/u, "UNIQUE_RUN_ID_REQUIRED");
await fs.access(outputDir).then(() => assert.fail("OUTPUT_ALREADY_EXISTS"), () => undefined);
await fs.mkdir(outputDir, { recursive: true });

const authHeaders = { Authorization: `Bearer ${token}` };
async function requestJson(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: authHeaders,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, body?.error || `${pathname}:${response.status}`);
  return body;
}

async function currentRuntime() {
  const version = await requestJson("/api/version");
  const diskBuildId = (await fs.readFile(path.resolve(".next/BUILD_ID"), "utf8")).trim();
  const source = JSON.parse(await fs.readFile(path.resolve("public/version.json"), "utf8"));
  assert.equal(version.buildId, diskBuildId, "CURRENT_RUNTIME_BUILD_ID_STALE");
  assert.equal(version.sourceVersion, source.sourceVersion, "CURRENT_RUNTIME_SOURCE_VERSION_STALE");
  const fingerprint = spawnSync(process.execPath, ["scripts/local-build-fingerprint.mjs", "verify", process.cwd()], { encoding: "utf8" });
  assert.equal(fingerprint.status, 0, `CURRENT_RUNTIME_SOURCE_FINGERPRINT_STALE:${fingerprint.stderr || fingerprint.stdout}`);
  return { sourceVersion: version.sourceVersion, buildId: version.buildId, runningLatest: true };
}

function priceFromText(text) {
  const match = String(text || "").match(/¥\s*([0-9]+(?:\.[0-9]+)?)/u);
  return match ? Number(match[1]) : Number.NaN;
}

async function downloadRenderedAsset(src, fileBase) {
  const target = new URL(src, origin);
  const response = await fetch(target, {
    headers: target.origin === new URL(origin).origin ? authHeaders : {},
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(response.ok && bytes.length > 1000, `RENDERED_ASSET_READ_FAILED:${response.status}`);
  const metadata = await sharp(bytes).metadata();
  assert.ok(metadata.width && metadata.height && metadata.format, "RENDERED_ASSET_DECODE_FAILED");
  const extension = metadata.format === "jpeg" ? "jpg" : metadata.format;
  const file = `${fileBase}.${extension}`;
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

function createImageResponseWaiter(page, timeoutMs) {
  let settled = false;
  let timer;
  let resolveWaiter;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    page.off("response", handler);
    resolveWaiter(value);
  };
  const handler = (response) => {
    if (response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/image/generate") {
      finish({ response, error: null });
    }
  };
  const promise = new Promise((resolve) => {
    resolveWaiter = resolve;
    page.on("response", handler);
    timer = setTimeout(() => finish({ response: null, error: `IMAGE_RESPONSE_TIMEOUT_${timeoutMs}` }), timeoutMs);
  });
  return {
    promise,
    cancel: (reason) => finish({ response: null, error: reason || "IMAGE_RESPONSE_WAIT_CANCELLED" }),
  };
}

const prompt = (await fs.readFile(promptPath, "utf8")).trim();
assert.equal(sha256(prompt), expectedPromptSha256, "PLATFORM_HIGH_ENERGY_PROMPT_CHANGED");
const runtime = await currentRuntime();
const report = {
  schema: "two_repaired_image_models_platform_ui_e2e.v1",
  runId,
  startedAt: new Date().toISOString(),
  mode: execute ? "execute" : "plan",
  status: "running",
  runtime,
  prompt: {
    source: path.relative(process.cwd(), promptPath).replaceAll("\\", "/"),
    sha256: sha256(prompt),
    characters: prompt.length,
    sourceWasVisiblePlatformAgentOutput: true,
  },
  directGenerationApiCallsByHarness: 0,
  targets,
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const modelButtons = page.locator(".sbw-image-model-list button[data-model-id]");
  await modelButtons.first().waitFor({ state: "visible", timeout: 45_000 });
  const discovered = await modelButtons.evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute("data-model-id") || "",
    text: (node.textContent || "").replace(/\s+/gu, " ").trim(),
    selectable: node.getAttribute("data-model-selectable") === "true",
    disabled: "disabled" in node ? Boolean(node.disabled) : false,
  })));
  for (const target of targets) {
    const model = discovered.find((item) => item.id === target.publicModelId);
    assert.ok(model, `${target.displayNeedle}:MODEL_NOT_VISIBLE`);
    assert.equal(model.selectable && !model.disabled, true, `${target.displayNeedle}:MODEL_NOT_SELECTABLE`);
    assert.ok(model.text.includes(target.displayNeedle), `${target.displayNeedle}:DISPLAY_NAME_MISMATCH`);
    assert.equal(priceFromText(model.text), target.expectedPrice, `${target.displayNeedle}:DISPLAY_PRICE_MISMATCH`);
  }

  report.plan = {
    visibleImageModelCount: discovered.length,
    targetCount: targets.length,
    plannedUiImagePosts: execute ? targets.length : 0,
    plannedMaximumPublicPrice: targets.reduce((sum, target) => sum + target.expectedPrice, 0),
  };
  if (!execute) {
    report.status = "planned-zero-generation";
  } else {
    const creditsPath = `/api/credits?user_id=${encodeURIComponent(String(identity.user.id))}`;
    const [cashBefore, creditsBefore] = await Promise.all([requestJson("/api/cash/balance"), requestJson(creditsPath)]);
    const controls = page.locator(".sbw-control-group.is-image");
    await controls.getByRole("button", { name: "16:9", exact: true }).click();
    const cards = page.locator("article.sbw-shot-card");
    const addCard = page.getByRole("button", { name: "添加镜头", exact: true });
    assert.equal(await addCard.isEnabled(), true, "STORYBOARD_CARD_CAPACITY_EXHAUSTED");
    let persistedProjectId = "";
    const projectSaveHandler = async (response) => {
      if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/storyboard/projects") return;
      if (!response.ok()) return;
      const body = await response.json().catch(() => ({}));
      if (body?.project?.id) persistedProjectId = String(body.project.id);
    };
    page.on("response", projectSaveHandler);
    const results = [];
    for (const target of targets) {
      const cardCountBefore = await cards.count();
      assert.equal(await addCard.isEnabled(), true, `${target.displayNeedle}:STORYBOARD_CARD_CAPACITY_EXHAUSTED`);
      await addCard.click();
      await page.waitForFunction((expected) => document.querySelectorAll("article.sbw-shot-card").length === expected, cardCountBefore + 1);
      const card = cards.last();
      const promptInput = card.locator('textarea[aria-label$="生图提示词"]');
      await promptInput.fill(prompt);
      const button = page.locator(`.sbw-image-model-list button[data-model-id="${target.publicModelId}"]`).first();
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await page.waitForFunction((modelId) => document.querySelector(`.sbw-image-model-list button[data-model-id="${modelId}"]`)?.classList.contains("is-active"), target.publicModelId);
      assert.equal(await promptInput.inputValue(), prompt, `${target.displayNeedle}:PROMPT_CHANGED`);
      let uiPosts = 0;
      let requestBody = null;
      const requestHandler = (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/image/generate") {
          uiPosts += 1;
          requestBody = request.postDataJSON();
        }
      };
      page.on("request", requestHandler);
      const previousImage = card.locator(".sbw-image-frame img").first();
      const previousSrc = await previousImage.count() ? await previousImage.evaluate((node) => node.currentSrc || node.src) : "";
      const clickedAt = new Date().toISOString();
      const startedAt = Date.now();
      const responseWaiter = createImageResponseWaiter(page, 720_000);
      let clickError = null;
      try {
        await card.locator("button.is-image-command").click();
      } catch (error) {
        clickError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        responseWaiter.cancel(clickError);
      }
      const waited = await responseWaiter.promise;
      const response = waited.response;
      if (!response) {
        page.off("request", requestHandler);
        const failedResult = {
          ...target,
          ok: false,
          state: "unknown_no_retry",
          clickedAt,
          elapsedMs: Date.now() - startedAt,
          uiPosts,
          error: clickError || waited.error,
          freshCard: true,
        };
        failedResult.visibleCardText = (await card.innerText().catch(() => "")).slice(0, 2000);
        await card.screenshot({ path: path.join(outputDir, `${target.fileBase}-ui.png`) }).catch(() => undefined);
        results.push(failedResult);
        continue;
      }
      const body = await response.json().catch(() => ({}));
      page.off("request", requestHandler);
      assert.equal(uiPosts, 1, `${target.displayNeedle}:UI_POST_COUNT_INVALID`);
      assert.equal(requestBody?.modelId, target.publicModelId, `${target.displayNeedle}:REQUEST_MODEL_MISMATCH`);
      assert.equal(requestBody?.prompt, prompt, `${target.displayNeedle}:REQUEST_PROMPT_MISMATCH`);
      assert.equal(requestBody?.historySurface, "storyboard-workbench", `${target.displayNeedle}:REQUEST_SURFACE_MISMATCH`);
      assert.equal(requestBody?.resolution, target.expectedResolution, `${target.displayNeedle}:REQUEST_RESOLUTION_MISMATCH`);
      const result = {
        ...target,
        ok: response.status() === 200 && body?.success === true && body?.status === "completed",
        clickedAt,
        routeCompletedAt: new Date().toISOString(),
        routeElapsedMs: Date.now() - startedAt,
        uiPosts,
        httpStatus: response.status(),
        state: body?.state || body?.status || (response.ok() ? "unknown" : "failed"),
        code: body?.code || null,
        error: body?.error || null,
        request: {
          clientTraceId: requestBody?.clientTraceId || null,
          clientIdempotencyKey: requestBody?.clientIdempotencyKey || null,
          aspectRatio: requestBody?.aspectRatio || null,
          resolution: requestBody?.resolution || null,
        },
        response: {
          assetId: body?.images?.[0]?.assetId || null,
          modelIdUsed: body?.modelIdUsed || null,
          modelUsed: body?.modelUsed || null,
          cashCharged: body?.cashCharged ?? null,
          idempotencyReplayed: body?.idempotencyReplayed ?? null,
        },
        asset: null,
        freshCard: true,
      };
      if (result.ok) {
        const expectedSrc = String(body?.images?.[0]?.url || "");
        assert.ok(expectedSrc, `${target.displayNeedle}:IMAGE_RESPONSE_URL_MISSING`);
        await page.waitForFunction(({ before, expected }) => {
          const nodes = [...document.querySelectorAll("article.sbw-shot-card")];
          const image = nodes.at(-1)?.querySelector(".sbw-image-frame img");
          if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return false;
          const current = image.currentSrc || image.src;
          return current !== before && new URL(current, location.origin).href === new URL(expected, location.origin).href;
        }, { before: previousSrc, expected: expectedSrc }, { timeout: 90_000 });
        const rendered = await card.locator(".sbw-image-frame img").first().evaluate((node) => ({
          src: node.currentSrc || node.src,
          complete: node.complete,
          width: node.naturalWidth,
          height: node.naturalHeight,
        }));
        assert.ok(rendered.complete && rendered.width > 0 && rendered.height > 0, `${target.displayNeedle}:IMAGE_NOT_RENDERED`);
        result.asset = await downloadRenderedAsset(rendered.src, target.fileBase);
        result.platformRenderedAt = new Date().toISOString();
      } else {
        await card.locator('[data-status="failed"]').waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
      }
      result.visibleCardText = (await card.innerText()).slice(0, 2000);
      await card.screenshot({ path: path.join(outputDir, `${target.fileBase}-ui.png`) });
      results.push(result);
    }

    await page.waitForTimeout(1800);
    const saveConfirmed = await page.waitForFunction(
      () => document.querySelector("[data-storyboard-save-status]")?.textContent?.includes("任务已保存"),
      undefined,
      { timeout: 45_000 },
    ).then(() => true, () => false);
    const [cashAfter, creditsAfter] = await Promise.all([requestJson("/api/cash/balance"), requestJson(creditsPath)]);
    report.imageRun = {
      uiPosts: results.reduce((sum, result) => sum + result.uiPosts, 0),
      retryCount: 0,
      cardsAddedThroughUi: results.length,
      freshCardPerTarget: true,
      projectSaveConfirmed: saveConfirmed,
      persistedProjectId: persistedProjectId || null,
      results,
    };
    report.billing = {
      cashBefore: Number(cashBefore.balance),
      cashAfter: Number(cashAfter.balance),
      cashDelta: Number((Number(cashBefore.balance) - Number(cashAfter.balance)).toFixed(6)),
      creditsBefore: Number(creditsBefore.credits),
      creditsAfter: Number(creditsAfter.credits),
      creditsDelta: Number((Number(creditsBefore.credits) - Number(creditsAfter.credits)).toFixed(6)),
    };
    report.status = results.length === targets.length && results.every((result) => result.ok)
      ? "passed"
      : "completed-with-failures-no-retry";
    page.off("response", projectSaveHandler);
  }
  report.completedAt = new Date().toISOString();
  await context.close();
} catch (error) {
  report.status = "failed-stopped-no-retry";
  report.failedAt = new Date().toISOString();
  report.error = error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200);
  throw error;
} finally {
  await browser.close();
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}

console.log(JSON.stringify({
  status: report.status,
  runtime: report.runtime,
  results: report.imageRun?.results?.map((result) => ({
    position: result.position,
    model: result.displayNeedle,
    ok: result.ok,
    httpStatus: result.httpStatus,
    elapsedMs: result.routeElapsedMs,
    asset: result.asset?.file || null,
  })) || [],
  report: path.join(outputDir, "report.json"),
}, null, 2));
