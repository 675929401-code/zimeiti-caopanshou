#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env.EXTRACTION_BASE_URL || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const outputDir = path.resolve(process.env.EXTRACTION_E2E_OUTPUT_DIR || ".codex-evidence/extraction-ui-zero-cost");
const sourceOnly = process.argv.includes("--source-only");
const marker = `零费用提取浏览器验收-${Date.now()}`;

async function closeWithTimeout(closeable, label, timeoutMs = 3_000) {
  let timer;
  await Promise.race([
    closeable.close().catch((error) => {
      console.error(`[extraction-ui-zero-cost] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.error(`[extraction-ui-zero-cost] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function verifySourceContracts() {
  const source = await readFile(path.resolve("src/app/extract/page.tsx"), "utf8");
  const statusHook = await readFile(path.resolve("src/hooks/use-extraction-attempt-status.ts"), "utf8");
  const statusRoute = await readFile(path.resolve("src/app/api/extract/status/route.ts"), "utf8");
  const videoStart = source.indexOf("function VideoExtractTab");
  const textStart = source.indexOf("function TextExtractTab");
  const batchStart = source.indexOf("function BatchExtractTab");
  assert.ok(videoStart >= 0 && textStart > videoStart && batchStart > textStart, "无法定位提取页三个工作区组件");

  const videoSource = source.slice(videoStart, textStart);
  const textSource = source.slice(textStart, batchStart);
  for (const [name, component] of [["video", videoSource], ["text", textSource]]) {
    assert.match(component, /const extractInFlightRef = useRef\(false\)/u, `${name} 缺少同步重复提交门闩`);
    assert.match(component, /if \(extractInFlightRef\.current\) return/u, `${name} 缺少同步重入检查`);
    assert.match(component, /extractInFlightRef\.current = true/u, `${name} 未在请求前占用门闩`);
    assert.match(component, /finally \{[\s\S]*?extractInFlightRef\.current = false/u, `${name} 未在 finally 中释放门闩`);
    assert.ok(
      component.indexOf("extractInFlightRef.current = true") < component.indexOf("callExtractAPI("),
      `${name} 必须在调用提取 API 前占用门闩`,
    );
  }

  assert.match(source, /"Idempotency-Key": attempt\.clientRequestId/u);
  assert.match(source, /client_request_id: attempt\.clientRequestId/u);
  assert.match(source, /requestExtractDownloadTicket/u);
  assert.match(source, /downloadExtractMedia/u);
  assert.doesNotMatch(source, /fetch\(videoItem\.download_url\)/u, "下载不得绕开安全票据代理");
  assert.match(source, /mode === "video" \? 210_000 : 30_000/u, "文案请求必须在短时前台等待后转为原请求状态跟踪");
  assert.match(source, /PendingExtractionRequestError/u);
  assert.match(source, /attempt\.data\?\.state === 'failed'[\s\S]*?pending: false[\s\S]*?没有取得可交付的视频/u,
    "已失败但无响应正文的任务必须退出待确认状态");
  assert.match(source, /attempt\.data\?\.state === 'succeeded'[\s\S]*?结果记录中没有可交付的视频/u,
    "已成功但无响应正文的任务必须显示终态缺结果");
  assert.match(textSource, /if \(embedded\) toolboxHost\?\.onTabChange\?\.\("segment"\)/u, "嵌入工具箱送去分段必须原地切换 tab");
  assert.match(textSource, /else router\.push\("\/segmenter"\)/u, "独立提取页送去分段必须进入独立分段页");
  assert.doesNotMatch(textSource, /router\.push\(embedded \? "\/tools\?tab=segment"/u, "嵌入工具箱不得触发 Next 路由卸载");
  assert.match(textSource, /const pendingAttempt = useExtractionAttemptStatus/u, "文案待确认结果必须持续读取原请求状态");
  assert.match(textSource, /正在后台处理原请求/u, "文案待确认结果必须提供明确后台反馈");
  assert.match(textSource, /result\?\.status === "error" && !result\.pending/u, "待确认时不得出现可重复提交的失败入口");
  assert.match(source, /通道已配置/u);
  assert.doesNotMatch(source, /服务状态：可用/u);
  assert.match(statusHook, /client_request_id/u);
  assert.match(statusHook, /value\.state === 'running'/u);
  assert.doesNotMatch(statusHook, /method:\s*['"]POST['"]/u, "状态恢复绝不能重新提交提取 POST");
  assert.match(statusRoute, /\.eq\('user_id', user\.id\)/u);
  assert.match(statusRoute, /\.eq\('client_request_id', clientRequestId\)/u);
  return {
    synchronousDoubleSubmitGuard: true,
    stableHeaderAndBodyIdentity: true,
    signedPlaybackAndDownloadTickets: true,
    clientRequestStatusPollingOnly: true,
  };
}

async function verifyBrowser(context, sourceChecks) {
  const externalRequests = [];
  const paidRequests = [];
  const extractRequests = [];
  const ticketRequests = [];
  const telemetryRequests = [];
  const unexpectedWrites = [];
  const browserErrors = [];
  const terminalNullAttemptId = "d".repeat(64);
  let terminalClientRequestId = "";
  let terminalStatusReads = 0;
  const textPendingAttemptId = "e".repeat(64);
  let textPendingClientRequestId = "";
  let textPendingStatusReads = 0;
  let textPendingPosts = 0;

  await context.addInitScript(() => {
    sessionStorage.setItem("entered_app", "1");
    if (!sessionStorage.getItem("extraction_zero_cost_initialized")) {
      localStorage.clear();
      localStorage.setItem("auth_token", "fixture-token-zero-cost");
      localStorage.setItem("auth_user", JSON.stringify({
        id: "fixture-user-zero-cost",
        username: "fixture-user",
        email: "fixture@example.invalid",
        role: "user",
        credits: 0,
        status: "active",
      }));
      sessionStorage.setItem("extraction_zero_cost_initialized", "1");
    }
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    if (url.origin !== baseUrl) {
      externalRequests.push(`${method} ${url.href}`);
      await route.abort("blockedbyclient");
      return;
    }
    if ([
      "/api/llm",
      "/api/image/generate",
      "/api/video/generate",
      "/api/voice/generate",
      "/api/payment",
      "/api/recharge",
    ].some((prefix) => url.pathname.startsWith(prefix))) {
      paidRequests.push(`${method} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname === "/api/auth/me" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "fixture-user-zero-cost",
            username: "fixture-user",
            email: "fixture@example.invalid",
            role: "user",
            credits: 0,
            status: "active",
          },
        }),
      });
      return;
    }
    if (url.pathname === "/api/member-permissions" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "private, no-store, max-age=0" },
        body: JSON.stringify({
          permission: {
            userId: "fixture-user-zero-cost",
            role: "user",
            featureNavigationKeys: ["toolbox"],
            agentNavigationKeys: [],
            revision: 1,
            checksum: "fixture-extraction-zero-cost",
            sourceProfileKey: null,
            sourceProfileVersion: null,
            updatedAt: new Date().toISOString(),
            updatedBy: "fixture-user-zero-cost",
            reason: "zero-cost extraction browser fixture",
            integrityValid: true,
            authorityStatus: "ready",
          },
        }),
      });
      return;
    }
    if (url.pathname === "/api/credits" && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ credits: 0, cashBalance: 0 }) });
      return;
    }
    if (url.pathname === "/api/tools/runtime-catalog" && method === "GET") {
      const availableQuote = (provider, model) => ({
        available: true,
        pricingReady: true,
        provider,
        model,
        unitPrice: 0.01,
        currency: "CNY",
        unit: "条",
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "private, no-store" },
        body: JSON.stringify({
          items: {
            video: availableQuote("零费用视频提取 fixture", "严格价格视频工作流"),
            text: availableQuote("零费用文案提取 fixture", "严格价格文案工作流"),
            batch: availableQuote("零费用批量提取 fixture", "严格价格批量工作流"),
            search: availableQuote("零费用搜索提取 fixture", "严格价格搜索工作流"),
            formatter: { available: true, provider: "浏览器本地规则", model: "固定规则引擎", unitPrice: 0, currency: "CNY", unit: "次" },
            semantic: { available: false, provider: "语义模型", model: "未配置", unitPrice: null, currency: "credits", unit: "Token" },
          },
          adminExempt: false,
        }),
      });
      return;
    }
    if (url.pathname === "/api/extract/status" && method === "GET" && terminalClientRequestId) {
      const matchesTerminal = url.searchParams.get("attempt_id") === terminalNullAttemptId
        || url.searchParams.get("client_request_id") === terminalClientRequestId;
      if (matchesTerminal) {
        terminalStatusReads += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            attemptId: terminalNullAttemptId,
            clientRequestId: terminalClientRequestId,
            state: "failed",
            netCharged: 0,
            billingMessage: "状态已确认，本次未扣费。",
            checkedAt: new Date().toISOString(),
            response: null,
          }),
        });
        return;
      }
    }
    if (url.pathname === "/api/extract/status" && method === "GET" && textPendingClientRequestId
      && (url.searchParams.get("attempt_id") === textPendingAttemptId
        || url.searchParams.get("client_request_id") === textPendingClientRequestId)) {
      textPendingStatusReads += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          attemptId: textPendingAttemptId,
          clientRequestId: textPendingClientRequestId,
          state: textPendingStatusReads === 1 ? "running" : "succeeded",
          netCharged: textPendingStatusReads === 1 ? 0 : 0.02,
          billingMessage: textPendingStatusReads === 1 ? "目前未扣费" : "已扣费 ¥0.02",
          checkedAt: new Date().toISOString(),
          ...(textPendingStatusReads > 1 ? { response: {
            success: true,
            videos: [],
            texts: [{ success: true, platform: "抖音", content: `${marker}-后台回填文案`, corrected_content: `${marker}-后台回填文案`, source: "asr_llm" }],
            summary: "后台原请求已完成",
          } } : {}),
        }),
      });
      return;
    }
    if (url.pathname === "/api/extract" && method === "POST") {
      const body = request.postDataJSON();
      const isTerminalNullFixture = Array.isArray(body.links)
        && body.links.some((value) => String(value).includes("fixture-terminal-null"));
      if (isTerminalNullFixture) {
        terminalClientRequestId = body.client_request_id;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "结果暂未确认",
            recovery_pending: true,
            attempt_id: terminalNullAttemptId,
            client_request_id: terminalClientRequestId,
          }),
        });
        return;
      }
      const isTextPendingFixture = Array.isArray(body.links)
        && body.links.some((value) => String(value).includes("fixture-text-pending"));
      if (isTextPendingFixture) {
        textPendingPosts += 1;
        textPendingClientRequestId = body.client_request_id;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: "结果暂未确认",
            recovery_pending: true,
            retry_safe: false,
            provider_call_started: true,
            attempt_id: textPendingAttemptId,
            client_request_id: textPendingClientRequestId,
          }),
        });
        return;
      }
      extractRequests.push({
        mode: body.extraction_mode,
        headerId: request.headers()["idempotency-key"],
        bodyId: body.client_request_id,
        markerPresent: JSON.stringify(body).includes(marker),
      });
      // Keep the request in flight long enough for a same-tick second click to
      // expose a missing synchronous UI guard without ever reaching a provider.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          message: "fixture 提取成功",
          videos: [{
            row: 1,
            platform: "抖音",
            success: true,
            asset_id: "fixture-owned-video-asset",
            title: `${marker}-视频`,
          }],
          texts: [{
            row: 1,
            platform: "抖音",
            success: true,
            content: `${marker}-口播文案`,
            corrected_content: `${marker}-口播文案`,
            title: `${marker}-标题`,
            source: "asr_llm",
          }],
          summary: `${marker}-fixture`,
        }),
      });
      return;
    }
    if (url.pathname === "/api/extract/download-ticket" && method === "POST") {
      const body = request.postDataJSON();
      ticketRequests.push({ mode: body.mode, url: body.url, filename: body.filename });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ download_url: "data:video/mp4;base64,AAAA", expires_at: Date.now() + 60_000 }),
      });
      return;
    }
    if (url.pathname === "/api/announcements/events" && method === "POST") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (["/api/product-usage/events", "/api/operation-events"].includes(url.pathname) && method === "POST") {
      const rawBody = request.postData() || "";
      telemetryRequests.push({
        path: url.pathname,
        containsExtractedContent: rawBody.includes(marker)
          || rawBody.includes("fixture-text")
          || rawBody.includes("fixture-video")
          || rawBody.includes("fixture-terminal-null"),
      });
      await route.fulfill({
        status: url.pathname === "/api/product-usage/events" ? 202 : 201,
        contentType: "application/json",
        body: JSON.stringify(url.pathname === "/api/product-usage/events"
          ? { ok: true, code: "PRODUCT_USAGE_ACCEPTED", receivedCount: 1 }
          : { accepted: true, duplicate: false }),
      });
      return;
    }
    if (url.pathname.startsWith("/api/") && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      unexpectedWrites.push(`${method} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.on("console", (message) => {
    const expectedTerminalFixture503 = Boolean(
      (terminalClientRequestId || textPendingClientRequestId)
      && /503 \(Service Unavailable\)/u.test(message.text())
      && message.location().url.includes("/api/extract"),
    );
    if (message.type() === "error" && !expectedTerminalFixture503 && !/media|decode|ERR_ABORTED/iu.test(message.text())) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(`${baseUrl}/tools?tab=text`, { waitUntil: "networkidle", timeout: 60_000 });
  const textInput = page.getByRole("textbox", { name: "文案分享文本或链接" });
  await textInput.waitFor({ state: "visible" });
  const textValue = `${marker} https://v.douyin.com/fixture-text/`;
  await textInput.fill(textValue);
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("extract_page_state")),
    null,
    "文案输入不应写入已退役的本地草稿缓存",
  );
  await page.getByRole("button", { name: "提取文案", exact: true }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.locator(".toolbox-results-block").filter({ hasText: `${marker}-口播文案` })
    .waitFor({ state: "visible", timeout: 15_000 });
  assert.ok(await page.getByRole("button", { name: "重新提取", exact: true }).isVisible(), "文案结果缺少重新提取入口");
  await page.getByRole("button", { name: "送去分段", exact: true }).click();
  const segmentInput = page.getByRole("textbox", { name: "需要分段的文案" });
  await segmentInput.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await segmentInput.inputValue(), `${marker}-口播文案`, "提取结果没有准确传入分段工具");
  assert.deepEqual(
    await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.includes("segmenter_")).sort()),
    [],
    "一次性分段传递在读取后应立即清除",
  );
  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
  await segmentInput.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await segmentInput.inputValue(), "", "分段输入在刷新后应为空");

  await page.goto(`${baseUrl}/tools?tab=text`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByRole("textbox", { name: "文案分享文本或链接" }).fill("https://v.douyin.com/fixture-text-pending/");
  await page.getByRole("button", { name: "提取文案", exact: true }).click();
  await page.getByText("正在后台处理原请求", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.getByRole("button", { name: "重新提取", exact: true }).count(), 0, "原请求待确认时不得出现重复提取入口");
  await page.getByText(`${marker}-后台回填文案`, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(textPendingPosts, 1, "后台跟踪场景必须只提交一次原请求");
  assert.ok(textPendingStatusReads >= 2, "后台跟踪场景没有从 running 自动过渡到 succeeded");

  await page.goto(`${baseUrl}/tools?tab=video`, { waitUntil: "networkidle", timeout: 60_000 });
  const videoInput = page.getByRole("textbox", { name: "视频分享文本或链接" });
  await videoInput.waitFor({ state: "visible" });
  const videoValue = `${marker} https://v.douyin.com/fixture-video/`;
  await videoInput.fill(videoValue);
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("extract_page_state")),
    null,
    "视频输入不应写入已退役的本地草稿缓存",
  );
  await page.getByRole("button", { name: "开始提取", exact: true }).evaluate((button) => {
    button.click();
    button.click();
  });
  const videoResult = page.locator(".toolbox-results-block").filter({ hasText: `${marker}-视频` });
  await videoResult.waitFor({ state: "visible", timeout: 15_000 }).catch(async () => {
    const videoBodyText = await page.locator("body").innerText();
    const videoMarkerLines = videoBodyText.split("\n").filter((line) => line.includes(marker));
    const resultTexts = await page.locator(".toolbox-results-block").allInnerTexts();
    throw new Error(`本轮视频结果卡未出现；标记文本=${JSON.stringify(videoMarkerLines)}；结果块=${JSON.stringify(resultTexts)}；提取请求=${JSON.stringify(extractRequests)}`);
  });
  const downloadButton = videoResult.getByRole("button", { name: "下载视频", exact: true }).first();
  const playButton = videoResult.getByRole("button", { name: "播放", exact: true }).first();
  await downloadButton.waitFor({ state: "visible", timeout: 15_000 });
  await playButton.waitFor({ state: "visible", timeout: 15_000 });
  await playButton.click();
  await page.waitForFunction(() => (
    Boolean(document.querySelector("video"))
    || document.body.innerText.includes("当前视频格式浏览器暂不支持直接播放")
    || document.body.innerText.includes("播放凭证不可用，请重新登录或尝试下载")
    || document.body.innerText.includes("浏览器无法播放当前视频，可下载后查看")
    || document.body.innerText.includes("视频加载中断，请检查连接后重试")
    || document.body.innerText.includes("视频暂时无法播放，请重试")
  ));
  await downloadButton.click();
  await page.waitForTimeout(250);
  assert.ok(ticketRequests.some((request) => request.mode === "play"), "播放入口没有换取安全票据");
  assert.ok(ticketRequests.some((request) => request.mode === "download"), "下载入口没有换取安全票据");

  await page.goto(`${baseUrl}/tools?tab=text`, { waitUntil: "networkidle", timeout: 60_000 });
  assert.equal(await page.getByRole("textbox", { name: "文案分享文本或链接" }).inputValue(), "", "文案输入在重新进入页面后应为空");
  await page.goto(`${baseUrl}/tools?tab=video`, { waitUntil: "networkidle", timeout: 60_000 });
  assert.equal(await page.getByRole("textbox", { name: "视频分享文本或链接" }).inputValue(), "", "视频输入在重新进入页面后应为空");

  await page.getByRole("textbox", { name: "视频分享文本或链接" }).fill("https://v.douyin.com/fixture-terminal-null/");
  await page.getByRole("button", { name: "开始提取", exact: true }).click();
  await page.getByText("提取失败", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.getByText("结果待确认", { exact: true }).count(), 0, "failed/null 终态仍显示结果待确认");
  assert.ok(terminalStatusReads >= 1, "failed/null 终态夹具没有经过状态查询");
  await page.screenshot({ path: path.join(outputDir, "formal-toolbox-extraction-fixture.png"), fullPage: true });

  assert.ok(extractRequests.length >= 2, "文案与视频 fixture 请求未完整发出");
  for (const request of extractRequests) {
    if (request.mode === "text") assert.ok(request.markerPresent, "文案 fixture marker 未传到提取请求");
    assert.equal(request.headerId, request.bodyId, "Idempotency-Key 与 body client_request_id 不一致");
  }
  const requestsByMode = Object.fromEntries(
    ["text", "video"].map((mode) => [mode, extractRequests.filter((request) => request.mode === mode)]),
  );
  for (const [mode, requests] of Object.entries(requestsByMode)) {
    assert.ok(requests.length >= 1 && requests.length <= 2, `${mode} 双击产生了异常请求数量 ${requests.length}`);
    assert.equal(new Set(requests.map((request) => request.bodyId)).size, 1, `${mode} 重复提交没有复用稳定请求标识`);
  }
  assert.deepEqual(paidRequests, [], "提取 UI 不应访问付费生成端点");
  assert.deepEqual(externalRequests, [], "提取 UI 不应直接访问第三方地址");
  assert.ok(telemetryRequests.length >= 1, "提取 UI 缺少预期的匿名化运行遥测");
  assert.ok(telemetryRequests.every((request) => !request.containsExtractedContent), "运行遥测不得包含用户输入或提取结果正文");
  assert.deepEqual(unexpectedWrites, [], "提取 UI 出现未拦截写请求");
  assert.deepEqual(browserErrors, [], "提取 UI 出现浏览器错误");

  return {
    passed: Object.values(requestsByMode).every((requests) => requests.length === 1),
    checkedAt: new Date().toISOString(),
    baseUrl,
    scope: "fixture-only extraction UI; all provider, wallet, external, and unrelated write requests blocked",
    sourceChecks,
    retiredDraftStorageAbsent: true,
    oneTimeSegmentHandoff: true,
    segmentInputClearedAfterRefresh: true,
    textInputClearedAfterNavigation: true,
    videoInputClearedAfterNavigation: true,
    terminalNullFailureStopsPending: terminalStatusReads >= 1,
    textPendingAutoRecovered: textPendingPosts === 1 && textPendingStatusReads >= 2,
    extractRequests,
    stableIdsByMode: Object.fromEntries(
      ["text", "video"].map((mode) => [
        mode,
        [...new Set(extractRequests.filter((request) => request.mode === mode).map((request) => request.bodyId))],
      ]),
    ),
    ticketModes: ticketRequests.map((request) => request.mode),
    telemetryRequests,
    paidRequests,
    externalRequests,
    unexpectedWrites,
    browserErrors,
    screenshot: path.join(outputDir, "formal-toolbox-extraction-fixture.png"),
  };
}

async function main() {
  const sourceChecks = await verifySourceContracts();
  if (sourceOnly) {
    console.log(JSON.stringify({ passed: true, mode: "source-only", sourceChecks }, null, 2));
    return;
  }

  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  let report;
  try {
    report = await verifyBrowser(context, sourceChecks);
    await writeFile(path.join(outputDir, "formal-result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await closeWithTimeout(context, "context.close");
    await closeWithTimeout(browser, "browser.close");
  }
  assert.ok(report?.passed, `重复提交门禁未在当前运行包激活；证据：${path.join(outputDir, "formal-result.json")}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
