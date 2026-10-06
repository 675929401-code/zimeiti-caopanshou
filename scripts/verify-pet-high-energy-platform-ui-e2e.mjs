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
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9);
const execute = process.argv.includes("--execute");
const requestedMaxImagePublicPrice = Number(process.argv.find((value) => value.startsWith("--max-image-public-price="))?.slice(25) || "0");
const sourceUrl = "https://www.douyin.com/video/7679059379622038835";
const agentId = "agent-1786843330392-emdjv2";
const agentName = "3D故事导演｜高能版";
const outputRoot = path.resolve(".codex-evidence/model-chain-audit-20261006/pet-high-energy-platform-ui-e2e");
const outputDir = path.join(outputRoot, runId || "invalid");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
assert.match(runId || "", /^[a-zA-Z0-9_-]{8,100}$/u, "UNIQUE_RUN_ID_REQUIRED");
assert.ok(Number.isFinite(requestedMaxImagePublicPrice) && requestedMaxImagePublicPrice >= 0, "IMAGE_PRICE_CAP_INVALID");

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

async function assertCurrentRuntime() {
  const version = await requestJson("/api/version");
  const diskBuildId = (await fs.readFile(path.resolve(".next/BUILD_ID"), "utf8")).trim();
  const source = JSON.parse(await fs.readFile(path.resolve("public/version.json"), "utf8"));
  assert.equal(version.buildId, diskBuildId, "CURRENT_RUNTIME_BUILD_ID_STALE");
  assert.equal(version.sourceVersion, source.sourceVersion, "CURRENT_RUNTIME_SOURCE_VERSION_STALE");
  const fingerprint = spawnSync(process.execPath, ["scripts/local-build-fingerprint.mjs", "verify", process.cwd()], { encoding: "utf8" });
  assert.equal(fingerprint.status, 0, `CURRENT_RUNTIME_SOURCE_FINGERPRINT_STALE:${fingerprint.stderr || fingerprint.stdout}`);
  return { sourceVersion: version.sourceVersion, buildId: version.buildId, runningLatest: true };
}

async function createAuthenticatedContext(browser, identity) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "marketplace");
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  return context;
}

async function dismissAnnouncement(page) {
  const close = page.getByRole("button", { name: "关闭", exact: true });
  if (await close.count()) await close.last().click().catch(() => undefined);
}

function priceFromModelText(text) {
  const match = String(text || "").match(/¥\s*([0-9]+(?:\.[0-9]+)?)/u);
  return match ? Number(match[1]) : Number.NaN;
}

async function readStoryboardCatalog(page) {
  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const buttons = page.locator(".sbw-image-model-list button[data-model-id]");
  await buttons.first().waitFor({ state: "visible", timeout: 45_000 });
  const models = await buttons.evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute("data-model-id") || "",
    text: (node.textContent || "").replace(/\s+/gu, " ").trim(),
    selectable: node.getAttribute("data-model-selectable") === "true",
    disabled: "disabled" in node ? Boolean(node.disabled) : false,
  })));
  const normalized = models.map((model) => ({ ...model, publicPrice: priceFromModelText(model.text) }));
  assert.equal(normalized.length, 8, `STORYBOARD_IMAGE_MODEL_COUNT_CHANGED:${normalized.length}`);
  assert.ok(normalized.every((model) => model.id && Number.isFinite(model.publicPrice) && model.publicPrice > 0), "MODEL_PRICE_OR_ID_MISSING");
  assert.ok(normalized.every((model) => model.selectable && !model.disabled), "STORYBOARD_IMAGE_MODEL_NOT_SELECTABLE");
  return {
    models: normalized,
    existingCardCount: await page.locator("article.sbw-shot-card").count(),
    canAddCard: await page.getByRole("button", { name: "添加镜头", exact: true }).isEnabled(),
  };
}

async function inspectHighEnergyPreset(page) {
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dismissAnnouncement(page);
  const card = page.locator(`[data-agent-card-id="${agentId}"]`);
  await card.waitFor({ state: "visible", timeout: 45_000 });
  await card.getByText(agentName, { exact: true }).click();
  const dialog = page.locator(".fixed.inset-0.z-50").filter({ hasText: agentName });
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  const fields = await dialog.locator("[id^=preset-]").evaluateAll((nodes) => nodes.map((node) => ({
    id: node.id,
    tag: node.tagName.toLowerCase(),
    value: "value" in node ? String(node.value || "") : "",
    options: node.tagName === "SELECT"
      ? Array.from(node.options).map((option) => ({ value: option.value, text: option.textContent || "" }))
      : [],
  })));
  assert.ok(fields.some((field) => field.id === "preset-segmented_copy"), "HIGH_ENERGY_SEGMENTED_COPY_FIELD_MISSING");
  assert.ok(fields.some((field) => field.id === "preset-segment_duration"), "HIGH_ENERGY_DURATION_FIELD_MISSING");
  assert.ok(fields.some((field) => field.id === "preset-video_model_profile"), "HIGH_ENERGY_VIDEO_PROFILE_FIELD_MISSING");
  assert.ok(fields.some((field) => field.id === "preset-video_ratio"), "HIGH_ENERGY_VIDEO_RATIO_FIELD_MISSING");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return fields;
}

async function extractAndSegmentThroughUi(page, report) {
  let extractionPosts = 0;
  let extractionRequest = null;
  const handler = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/extract") {
      extractionPosts += 1;
      extractionRequest = request.postDataJSON();
    }
  };
  page.on("request", handler);
  await page.goto(`${origin}/tools?tab=text`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const input = page.getByRole("textbox", { name: "文案分享文本或链接" });
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(sourceUrl);
  const extractionResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/extract", { timeout: 420_000 });
  await page.getByRole("button", { name: "提取文案", exact: true }).click();
  const extractionResponse = await extractionResponsePromise;
  const extractionBody = await extractionResponse.json().catch(() => ({}));
  assert.ok([200, 202].includes(extractionResponse.status()), `PLATFORM_EXTRACTION_HTTP_${extractionResponse.status()}:${extractionBody?.error || "unknown"}`);
  assert.ok(Array.isArray(extractionRequest?.links) && extractionRequest.links.includes(sourceUrl), "PLATFORM_EXTRACTION_SOURCE_MISMATCH");
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.includes("送去分段") || text.includes("提取失败") || text.includes("结果待确认");
  }, undefined, { timeout: 420_000 });
  assert.equal(extractionPosts, 1, `EXTRACTION_UI_POST_COUNT_INVALID:${extractionPosts}`);
  const handoff = page.getByRole("button", { name: "送去分段", exact: true });
  assert.equal(await handoff.isVisible().catch(() => false), true, "EXTRACTION_UI_DID_NOT_REACH_SUCCESS");
  await page.screenshot({ path: path.join(outputDir, "01-platform-extraction.png"), fullPage: true });
  await handoff.click();
  const segmentInput = page.getByRole("textbox", { name: "需要分段的文案" });
  await segmentInput.waitFor({ state: "visible", timeout: 20_000 });
  const transferredText = await segmentInput.inputValue();
  assert.ok(transferredText.trim().length > 20, "PLATFORM_EXTRACTION_TEXT_EMPTY");
  await page.getByRole("button", { name: "开始分段", exact: true }).click();
  await page.locator("[data-segmenter-result=true]").waitFor({ state: "visible", timeout: 30_000 });
  const segments = (await page.locator("[data-segment-index] p").allInnerTexts())
    .map((value) => value.trim().replace(/^【|】$/gu, "")).filter(Boolean);
  assert.ok(segments.length > 0, "PLATFORM_SEGMENTS_EMPTY");
  await page.screenshot({ path: path.join(outputDir, "02-platform-segmentation.png"), fullPage: true });
  page.off("request", handler);
  await fs.writeFile(path.join(outputDir, "platform-extracted-copy.txt"), `${transferredText.trim()}\n`, { flag: "wx" });
  await fs.writeFile(path.join(outputDir, "platform-segments.json"), `${JSON.stringify(segments, null, 2)}\n`, { flag: "wx" });
  report.extraction = {
    uiPosts: extractionPosts,
    httpStatus: extractionResponse.status(),
    responseState: extractionBody?.state || extractionBody?.status || null,
    extractedCharacters: transferredText.length,
    extractedSha256: sha256(transferredText),
    segmentCount: segments.length,
  };
  return segments;
}

function chooseSelectOption(options, needle, field) {
  const option = options.find((item) => String(item.text || item.value).includes(needle));
  assert.ok(option?.value, `${field}_OPTION_MISSING:${needle}`);
  return option.value;
}

function annotationChecks(prompt) {
  const frames = [1, 2, 3, 4].map((index) => ({
    index,
    descriptive: new RegExp(`Frame\\s*${index}\\s*:\\s*[A-Za-z][^\\n]{12,}`, "iu").test(prompt),
  }));
  return {
    fourOrFivePanel: /(?:2\s*[x×]\s*2|四格|五格)/iu.test(prompt),
    frameDescriptionBar: /(?:Frame.*说明条|英文.*说明条|细窄白色.*Frame|每格.*Frame)/iu.test(prompt),
    frames,
    allFourDescriptive: frames.every((frame) => frame.descriptive),
  };
}

function messageText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => typeof part === "string" ? part : String(part?.text || "")).join("\n");
}

async function runHighEnergyAgentThroughUi(page, segments, presetFields, report) {
  let llmPosts = 0;
  let llmRequest = null;
  const handler = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/llm") {
      llmPosts += 1;
      llmRequest = request.postDataJSON();
    }
  };
  page.on("request", handler);
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dismissAnnouncement(page);
  const card = page.locator(`[data-agent-card-id="${agentId}"]`);
  await card.waitFor({ state: "visible", timeout: 45_000 });
  await card.getByText(agentName, { exact: true }).click();
  const dialog = page.locator(".fixed.inset-0.z-50").filter({ hasText: agentName });
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  const numbered = segments.slice(0, 3).map((segment, index) => `${index + 1}. ${segment}`).join("\n");
  await dialog.locator("#preset-segmented_copy").fill(numbered);
  const byId = new Map(presetFields.map((field) => [field.id, field]));
  await dialog.locator("#preset-segment_duration").selectOption(chooseSelectOption(byId.get("preset-segment_duration")?.options || [], "8秒版：每段3个镜头", "DURATION"));
  await dialog.locator("#preset-video_model_profile").selectOption(chooseSelectOption(byId.get("preset-video_model_profile")?.options || [], "自动通用", "VIDEO_PROFILE"));
  await dialog.locator("#preset-video_ratio").selectOption(chooseSelectOption(byId.get("preset-video_ratio")?.options || [], "16:9", "VIDEO_RATIO"));
  const visibleInput = {
    segmentedCopy: numbered,
    segmentDuration: await dialog.locator("#preset-segment_duration").inputValue(),
    videoModelProfile: await dialog.locator("#preset-video_model_profile").inputValue(),
    videoRatio: await dialog.locator("#preset-video_ratio").inputValue(),
    animationStyle: await dialog.locator("#preset-animation_style").inputValue(),
    ownerGender: await dialog.locator("#preset-owner_gender").inputValue(),
    dogBreed: await dialog.locator("#preset-dog_breed").inputValue(),
    specialNotes: await dialog.locator("#preset-special_notes").count()
      ? await dialog.locator("#preset-special_notes").inputValue()
      : "",
  };
  await fs.writeFile(path.join(outputDir, "platform-agent-visible-input.json"), `${JSON.stringify(visibleInput, null, 2)}\n`, { flag: "wx" });
  const llmResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/llm", { timeout: 120_000 });
  await dialog.getByRole("button", { name: "开始", exact: true }).click();
  const llmResponse = await llmResponsePromise;
  assert.equal(llmResponse.status(), 200, `PLATFORM_AGENT_HTTP_${llmResponse.status()}`);
  const visibleSourceNeedle = segments[0].slice(0, 16);
  await page.locator('[data-message-role="user"]').last().filter({ hasText: visibleSourceNeedle }).waitFor({ state: "visible", timeout: 120_000 });
  await page.locator('[data-message-role="assistant"]').last().waitFor({ state: "visible", timeout: 120_000 });
  await page.getByRole("button", { name: "停止接收", exact: true }).waitFor({ state: "hidden", timeout: 720_000 }).catch(() => undefined);
  await page.waitForFunction((sourceNeedle) => {
    const users = [...document.querySelectorAll('[data-message-role="user"]')];
    const messages = [...document.querySelectorAll('[data-message-role="assistant"]')];
    const last = messages.at(-1);
    const currentUser = users.at(-1);
    return Boolean(currentUser && (currentUser.textContent || "").includes(sourceNeedle)
      && last && (last.textContent || "").trim().length > 500
      && !document.querySelector('button[aria-label="停止接收"]'));
  }, visibleSourceNeedle, { timeout: 720_000 });
  assert.equal(llmPosts, 1, `PLATFORM_AGENT_UI_POST_COUNT_INVALID:${llmPosts}`);
  assert.equal(llmRequest?.agentId, agentId, "PLATFORM_AGENT_ID_MISMATCH");
  assert.equal(llmRequest?.model_overridden, false, "PLATFORM_AGENT_MODEL_WAS_OVERRIDDEN");
  assert.equal(llmRequest?.modelId, undefined, "PLATFORM_AGENT_REQUEST_SHOULD_USE_SAVED_BINDING");
  const requestUserMessage = [...(Array.isArray(llmRequest?.messages) ? llmRequest.messages : [])].reverse().find((message) => message?.role === "user");
  const requestUserText = messageText(requestUserMessage);
  assert.ok(requestUserText.includes(visibleSourceNeedle), "PLATFORM_AGENT_REQUEST_DID_NOT_INCLUDE_VISIBLE_SOURCE");
  assert.ok(requestUserText.includes(visibleInput.segmentDuration), "PLATFORM_AGENT_REQUEST_DID_NOT_INCLUDE_VISIBLE_DURATION");
  assert.ok(requestUserText.includes(visibleInput.videoRatio), "PLATFORM_AGENT_REQUEST_DID_NOT_INCLUDE_VISIBLE_RATIO");
  const assistant = page.locator('[data-message-role="assistant"]').last();
  const output = (await assistant.innerText()).trim();
  const codeBlocks = (await assistant.locator("pre").allInnerTexts()).map((value) => value.trim()).filter(Boolean);
  const imagePrompt = codeBlocks.find((value) => /Frame\s*1\s*:/iu.test(value)
    && /(?:2\s*[x×]\s*2|四格|五格)/iu.test(value)
    && !/(?:0\s*[-—]\s*\d+(?:\.\d+)?\s*秒|No dialogue|No narration)/iu.test(value));
  assert.ok(imagePrompt, "VISIBLE_HIGH_ENERGY_IMAGE_PROMPT_NOT_FOUND");
  const annotations = annotationChecks(imagePrompt);
  assert.equal(annotations.fourOrFivePanel, true, "VISIBLE_HIGH_ENERGY_PANEL_LAYOUT_MISSING");
  assert.equal(annotations.frameDescriptionBar, true, "VISIBLE_HIGH_ENERGY_FRAME_BAR_MISSING");
  assert.equal(annotations.allFourDescriptive, true, "VISIBLE_HIGH_ENERGY_DESCRIPTIVE_ANNOTATIONS_MISSING");
  await fs.writeFile(path.join(outputDir, "platform-high-energy-visible-output.txt"), `${output}\n`, { flag: "wx" });
  await fs.writeFile(path.join(outputDir, "platform-high-energy-image-prompt.txt"), `${imagePrompt}\n`, { flag: "wx" });
  await page.screenshot({ path: path.join(outputDir, "03-platform-high-energy-output.png"), fullPage: true });
  page.off("request", handler);
  report.agentRun = {
    uiPosts: llmPosts,
    request: {
      agentId: llmRequest.agentId,
      agentName: llmRequest.agentName,
      modelOverridden: llmRequest.model_overridden,
      modelIdPresent: Object.hasOwn(llmRequest, "modelId"),
      conversationId: llmRequest.conversationId,
      clientRequestId: llmRequest.client_request_id,
      userInputCharacters: requestUserText.length,
      userInputSha256: sha256(requestUserText),
    },
    visibleOutputCharacters: output.length,
    visibleOutputSha256: sha256(output),
    visibleCodeBlockCount: codeBlocks.length,
    imagePromptCharacters: imagePrompt.length,
    imagePromptSha256: sha256(imagePrompt),
    annotations,
  };
  return imagePrompt;
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
  return { file, bytes: bytes.length, sha256: sha256(bytes), width: metadata.width, height: metadata.height, format: metadata.format };
}

async function generateAllImagesThroughUi(page, models, prompt, report) {
  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  let persistedProjectId = "";
  let projectSaveResponses = 0;
  const projectSaveHandler = async (response) => {
    const request = response.request();
    if (request.method() !== "POST" || new URL(response.url()).pathname !== "/api/storyboard/projects") return;
    projectSaveResponses += 1;
    if (!response.ok()) return;
    const body = await response.json().catch(() => ({}));
    if (body?.project?.id) persistedProjectId = String(body.project.id);
  };
  page.on("response", projectSaveHandler);
  const modelButtons = page.locator(".sbw-image-model-list button[data-model-id]");
  await modelButtons.first().waitFor({ state: "visible", timeout: 45_000 });
  const controls = page.locator(".sbw-control-group.is-image");
  await controls.getByRole("button", { name: "16:9", exact: true }).click();
  const cards = page.locator("article.sbw-shot-card");
  const cardCountBefore = await cards.count();
  const addCard = page.getByRole("button", { name: "添加镜头", exact: true });
  assert.equal(await addCard.isEnabled(), true, "STORYBOARD_CARD_CAPACITY_EXHAUSTED");
  await addCard.click();
  await page.waitForFunction((expected) => document.querySelectorAll("article.sbw-shot-card").length === expected, cardCountBefore + 1);
  const card = cards.last();
  const promptInput = card.locator('textarea[aria-label$="生图提示词"]');
  await promptInput.fill(prompt);
  const results = [];
  let totalUiPosts = 0;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const button = page.locator(`.sbw-image-model-list button[data-model-id="${model.id}"]`).first();
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await page.waitForFunction((modelId) => document.querySelector(`.sbw-image-model-list button[data-model-id="${modelId}"]`)?.classList.contains("is-active"), model.id);
    assert.equal(await promptInput.inputValue(), prompt, `PROMPT_CHANGED_AFTER_MODEL_SELECTION:${model.id}`);
    let postCount = 0;
    let requestBody = null;
    const handler = (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/image/generate") {
        postCount += 1;
        totalUiPosts += 1;
        requestBody = request.postDataJSON();
      }
    };
    page.on("request", handler);
    const startedAt = Date.now();
    const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/image/generate", { timeout: 420_000 });
    const imageBefore = card.locator(".sbw-image-frame img").first();
    const previousRenderedSrc = await imageBefore.count()
      ? await imageBefore.evaluate((image) => image.currentSrc || image.src)
      : "";
    await card.locator("button.is-image-command").click();
    let response;
    try {
      response = await responsePromise;
    } catch (error) {
      page.off("request", handler);
      results.push({ index: index + 1, ...model, ok: false, state: "unknown_no_retry", elapsedMs: Date.now() - startedAt, uiPosts: postCount, error: error instanceof Error ? error.name : "UI_RESPONSE_UNKNOWN" });
      break;
    }
    const body = await response.json().catch(() => ({}));
    page.off("request", handler);
    assert.equal(postCount, 1, `IMAGE_UI_POST_COUNT_INVALID:${model.id}:${postCount}`);
    assert.equal(requestBody?.modelId, model.id, `IMAGE_UI_MODEL_MISMATCH:${model.id}`);
    assert.equal(requestBody?.prompt, prompt, `IMAGE_UI_PROMPT_MISMATCH:${model.id}`);
    assert.equal(requestBody?.historySurface, "storyboard-workbench", `IMAGE_UI_SURFACE_MISMATCH:${model.id}`);
    const result = {
      index: index + 1,
      ...model,
      ok: response.status() === 200 && body?.success === true && body?.status === "completed",
      httpStatus: response.status(),
      state: body?.state || body?.status || (response.ok() ? "unknown" : "failed"),
      code: body?.code || null,
      error: body?.error || null,
      elapsedMs: Date.now() - startedAt,
      uiPosts: postCount,
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
    };
    if (result.ok) {
      const generatedImage = card.locator(".sbw-image-frame img").first();
      const expectedRenderedSrc = String(body?.images?.[0]?.url || "");
      assert.ok(expectedRenderedSrc, `IMAGE_RESPONSE_URL_MISSING:${model.id}`);
      await page.waitForFunction(({ previousSrc, expectedSrc }) => {
        const cardNodes = [...document.querySelectorAll("article.sbw-shot-card")];
        const image = cardNodes.at(-1)?.querySelector(".sbw-image-frame img");
        if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return false;
        const current = image.currentSrc || image.src;
        return current !== previousSrc && new URL(current, location.origin).href === new URL(expectedSrc, location.origin).href;
      }, { previousSrc: previousRenderedSrc, expectedSrc: expectedRenderedSrc }, { timeout: 60_000 });
      const rendered = await generatedImage.evaluate((image) => ({ src: image.currentSrc || image.src, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }));
      assert.ok(rendered.complete && rendered.width > 0 && rendered.height > 0, `IMAGE_UI_NOT_RENDERED:${model.id}`);
      result.asset = await downloadRenderedAsset(rendered.src, `image-${String(index + 1).padStart(2, "0")}`);
    } else {
      await card.locator('[data-status="failed"]').waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    }
    await card.screenshot({ path: path.join(outputDir, `ui-result-${String(index + 1).padStart(2, "0")}.png`) });
    result.visibleCardText = (await card.innerText()).slice(0, 2000);
    results.push(result);
  }
  await page.waitForTimeout(1_800);
  await page.waitForFunction(() => document.querySelector("[data-storyboard-save-status]")?.textContent?.includes("任务已保存"), undefined, { timeout: 45_000 });
  assert.ok(persistedProjectId, "STORYBOARD_PROJECT_ID_NOT_OBSERVED_FROM_UI_SAVE");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("button", { name: "最近任务", exact: true }).first().click();
  const savedProject = page.locator(`[data-storyboard-project-id="${persistedProjectId}"]`);
  await savedProject.waitFor({ state: "visible", timeout: 45_000 });
  page.once("dialog", (dialog) => dialog.accept());
  await savedProject.getByRole("button", { name: "打开任务", exact: true }).click();
  const reloadedCards = page.locator("article.sbw-shot-card");
  await page.waitForFunction((expectedMinimum) => document.querySelectorAll("article.sbw-shot-card").length >= expectedMinimum, cardCountBefore + 1, { timeout: 45_000 });
  const reloadedCard = reloadedCards.last();
  const reloadedPrompt = await reloadedCard.locator('textarea[aria-label$="生图提示词"]').inputValue();
  assert.equal(reloadedPrompt, prompt, "STORYBOARD_PROMPT_REFRESH_READBACK_MISMATCH");
  const finalResult = results.at(-1);
  const expectedFinalState = finalResult?.ok ? "done" : "failed";
  await page.waitForFunction((expectedState) => {
    const cardNodes = [...document.querySelectorAll("article.sbw-shot-card")];
    return cardNodes.at(-1)?.getAttribute("data-card-state") === expectedState;
  }, expectedFinalState, { timeout: 60_000 });
  const readback = {
    cardCount: await reloadedCards.count(),
    promptCharacters: reloadedPrompt.length,
    promptSha256: sha256(reloadedPrompt),
    state: await reloadedCard.getAttribute("data-card-state"),
    renderedAsset: null,
  };
  if (finalResult?.ok) {
    const image = reloadedCard.locator(".sbw-image-frame img").first();
    await image.waitFor({ state: "visible", timeout: 60_000 });
    readback.renderedAsset = await image.evaluate((node) => ({
      complete: node.complete,
      width: node.naturalWidth,
      height: node.naturalHeight,
      srcPresent: Boolean(node.currentSrc || node.src),
    }));
    assert.ok(readback.renderedAsset.complete && readback.renderedAsset.width > 0 && readback.renderedAsset.height > 0 && readback.renderedAsset.srcPresent, "STORYBOARD_IMAGE_REFRESH_READBACK_FAILED");
  }
  await reloadedCard.screenshot({ path: path.join(outputDir, "ui-final-refresh-readback.png") });
  page.off("response", projectSaveHandler);
  report.imageRun = {
    expectedModels: models.length,
    attemptedModels: results.length,
    uiPosts: totalUiPosts,
    retryCount: 0,
    existingCardsPreserved: cardCountBefore,
    cardsAddedThroughUi: (await cards.count()) - cardCountBefore,
    persistedProjectId,
    projectSaveResponses,
    refreshReadback: readback,
    results,
  };
  assert.equal(results.length, models.length, "IMAGE_UI_RUN_STOPPED_BEFORE_ALL_MODELS");
  assert.equal(totalUiPosts, models.length, "IMAGE_UI_TOTAL_POST_COUNT_INVALID");
  return results;
}

await fs.mkdir(outputRoot, { recursive: true });
await fs.mkdir(outputDir, { recursive: false });
const runtime = await assertCurrentRuntime();
const identity = await requestJson("/api/auth/me");
assert.equal(identity.user?.role, "admin", "LOCAL_ADMIN_REQUIRED");
assert.ok(String(identity.user?.id || "").trim(), "LOCAL_ADMIN_USER_ID_REQUIRED");
const creditsPath = `/api/credits?user_id=${encodeURIComponent(String(identity.user.id || ""))}`;
const browser = await chromium.launch({ headless: true });
const report = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  mode: execute ? "execute" : "plan",
  status: "running",
  runtime,
  source: { url: sourceUrl },
  requiredUserPath: ["platform-extract", "platform-segment", "marketplace-agent-card", "preset-dialog", "visible-agent-reply", "storyboard-model-select", "storyboard-generate-button", "visible-result"],
  directGenerationApiCallsByHarness: 0,
};

try {
  const context = await createAuthenticatedContext(browser, identity);
  const page = await context.newPage();
  const presetFields = await inspectHighEnergyPreset(page);
  const storyboard = await readStoryboardCatalog(page);
  const models = storyboard.models;
  const plannedImagePublicPrice = Number(models.reduce((sum, model) => sum + model.publicPrice, 0).toFixed(6));
  report.plan = {
    agent: { id: agentId, name: agentName, presetFields },
    models,
    modelCount: models.length,
    existingCardCount: storyboard.existingCardCount,
    canAddOneEvidenceCard: storyboard.canAddCard,
    plannedImagePublicPrice,
    maxImagePublicPrice: requestedMaxImagePublicPrice,
    generationWrites: execute ? { extractionUiPosts: 1, llmUiPosts: 1, imageUiPosts: 8 } : { extractionUiPosts: 0, llmUiPosts: 0, imageUiPosts: 0 },
  };
  assert.ok(requestedMaxImagePublicPrice > 0, "POSITIVE_IMAGE_PRICE_CAP_REQUIRED");
  assert.ok(plannedImagePublicPrice <= requestedMaxImagePublicPrice + 0.000001, `PLANNED_IMAGE_PRICE_EXCEEDS_CAP:${plannedImagePublicPrice}`);
  assert.equal(storyboard.canAddCard, true, "STORYBOARD_CARD_CAPACITY_EXHAUSTED");
  if (!execute) {
    report.status = "planned-zero-generation";
  } else {
    const [cashBefore, creditsBefore] = await Promise.all([requestJson("/api/cash/balance"), requestJson(creditsPath)]);
    const segments = await extractAndSegmentThroughUi(page, report);
    const imagePrompt = await runHighEnergyAgentThroughUi(page, segments, presetFields, report);
    const results = await generateAllImagesThroughUi(page, models, imagePrompt, report);
    const [cashAfter, creditsAfter] = await Promise.all([requestJson("/api/cash/balance"), requestJson(creditsPath)]);
    report.billing = {
      cashBefore: Number(cashBefore.balance),
      cashAfter: Number(cashAfter.balance),
      cashDelta: Number((Number(cashBefore.balance) - Number(cashAfter.balance)).toFixed(6)),
      creditsBefore: Number(creditsBefore.credits),
      creditsAfter: Number(creditsAfter.credits),
      creditsDelta: Number((Number(creditsBefore.credits) - Number(creditsAfter.credits)).toFixed(6)),
    };
    report.summary = {
      modelCount: models.length,
      attempted: results.length,
      completed: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      uiImagePosts: results.reduce((sum, result) => sum + result.uiPosts, 0),
      llmUiPosts: report.agentRun.uiPosts,
      extractionUiPosts: report.extraction.uiPosts,
      agentPromptWasVisiblePlatformOutput: true,
      modelBindingOverridden: false,
    };
    report.status = "passed-with-recorded-model-outcomes";
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
  success: report.status !== "failed-stopped-no-retry",
  mode: report.mode,
  status: report.status,
  runtime: report.runtime,
  plan: { modelCount: report.plan.modelCount, plannedImagePublicPrice: report.plan.plannedImagePublicPrice },
  summary: report.summary || null,
  report: path.join(outputDir, "report.json"),
}, null, 2));
