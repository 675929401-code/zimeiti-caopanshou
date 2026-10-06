#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const sourceUrl = "https://www.douyin.com/video/7679261842362944808";
const agentName = "3D故事导演｜高能版";
const imageModelNeedle = "GPT-Image-2.5 Sunburst";
const requestedResolution = "1K";
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9)
  || new Date().toISOString().replace(/[:.]/gu, "-");
const outputDir = path.resolve(".codex-evidence/story-director-ab-20261005", runId);
const execute = process.argv.includes("--execute");
const cliArgument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || "";
const resumePriorReportPath = cliArgument("--resume-prior-report");
const resumeClaudeEvidenceDir = cliArgument("--resume-claude-evidence");
assert.equal(Boolean(resumePriorReportPath), Boolean(resumeClaudeEvidenceDir), "RESUME_ARGUMENTS_MUST_BE_PAIRED");

const authHeaders = () => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = () => ({ ...authHeaders(), "Content-Type": "application/json" });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const round = (value) => Number(Number(value || 0).toFixed(6));

async function requestJson(pathname, timeoutMs = 30_000) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: authHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, body?.error || `${pathname} failed with ${response.status}`);
  return body;
}

async function billingSnapshot() {
  const [balance, transactions] = await Promise.all([
    requestJson("/api/cash/balance"),
    requestJson("/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=100"),
  ]);
  const cashRows = (transactions?.data?.transactions || []).filter((row) => row?.category === "cash");
  return {
    balance: Number(balance.balance),
    cashRows,
    cashIds: new Set(cashRows.map((row) => String(row.id))),
  };
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[\s._·—–-]+/gu, "");
}

function selectByName(models, needles) {
  return models.find((model) => needles.some((needle) => normalizeName(model.displayName || model.name).includes(normalizeName(needle))));
}

function formatPresetValue(field, rawValue) {
  let value = String(rawValue || "").trim();
  if (!value) return "";
  if (field.type === "textarea") value = value.replace(/^(\d+)\. /gmu, "$1\\. ");
  if (field.contentPrefix) {
    const separator = field.type === "textarea" && !String(field.contentPrefix).endsWith("\n") ? "\n" : "";
    return `${field.contentPrefix}${separator}${value}`;
  }
  if (field.sendLabel === false) return value;
  const label = field.sendText || field.label;
  return `${label}：${field.type === "textarea" ? "\n" : ""}${value}`;
}

function buildAgentInput(agent, segments) {
  const numbered = segments.map((segment, index) => `${index + 1}. ${segment}`).join("\n");
  const preferred = {
    segmented_copy: numbered,
    segment_duration: "8秒版：每段3个镜头",
    video_model_profile: "自动通用（分镜工作台再选择模型）",
    aspect_ratio: "16:9",
    special_notes: "本轮用于同一输入、同一参数的模型A/B；不得改变原文事实，不得添加健康疗效承诺。",
  };
  const fields = [...(agent.presetFields || agent.preset_fields || [])].sort((left, right) => Number(left.order) - Number(right.order));
  assert.ok(fields.length > 0, "HIGH_ENERGY_PRESET_FIELDS_MISSING");
  const values = {};
  const lines = [];
  for (const field of fields) {
    let value = preferred[field.id];
    if (!value) value = String(field.defaultValue || "").trim();
    if (!value && Array.isArray(field.options) && field.options.length > 0) value = String(field.options[0]);
    if (field.required) assert.ok(value, `REQUIRED_PRESET_VALUE_MISSING:${field.id}`);
    if (!value) continue;
    values[field.id] = value;
    lines.push(formatPresetValue(field, value));
  }
  assert.ok(values.segmented_copy, "SEGMENTED_COPY_PRESET_MISSING");
  assert.ok(values.segment_duration, "SEGMENT_DURATION_PRESET_MISSING");
  assert.ok(values.video_model_profile, "VIDEO_MODEL_PROFILE_PRESET_MISSING");
  return { values, message: lines.filter(Boolean).join("\n\n") };
}

function contentDelta(payload) {
  const first = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const delta = first?.delta?.content;
  const message = first?.message?.content;
  return typeof delta === "string" ? delta : typeof message === "string" ? message : "";
}

function summarizeSsePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const result = {};
  for (const key of ["code", "error", "done", "usage", "cash_charged", "credits_charged", "balance_after", "idempotency_replayed"]) {
    if (payload[key] !== undefined) result[key] = payload[key];
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function runLlm({ model, agent, input, label }) {
  const conversationId = `conv_ab_${label}_${randomUUID().replace(/-/gu, "")}`;
  const clientRequestId = `llm_ab_${label}_${randomUUID()}`;
  const startedAt = performance.now();
  const response = await fetch(`${origin}/api/llm`, {
    method: "POST",
    headers: { ...jsonHeaders(), "Idempotency-Key": clientRequestId },
    body: JSON.stringify({
      client_request_id: clientRequestId,
      messages: [{ role: "user", content: input }],
      stream: true,
      agentName: agent.name,
      agentId: agent.id,
      conversationId,
      modelId: model.id,
      model_overridden: true,
      deepThinkingType: 0,
      deepThinkingOverridden: true,
      deductDeepThink: 1,
      enableWebSearch: false,
      enableWebSearchOverridden: true,
      maxContextRounds: 0,
      maxContextTokens: Number(agent.maxContextTokens || agent.max_context_tokens || 0),
      maxReplyTokens: 4_000,
      timeout: Math.min(600, Number(agent.timeout || 600)),
      temperature: Number.isFinite(Number(agent.temperature)) ? Number(agent.temperature) : 0.2,
      responseFormat: agent.responseFormat || agent.response_format || "markdown",
    }),
    signal: AbortSignal.timeout(720_000),
  });
  const headersMs = performance.now() - startedAt;
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`${label}_LLM_HTTP_${response.status}:${text.slice(0, 500)}`);
  }
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/iu, `${label}_NOT_SSE`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let output = "";
  let firstBodyChunkMs = null;
  let firstContentDeltaMs = null;
  let contentEvents = 0;
  let bodyChunks = 0;
  let sawDone = false;
  const metadataEvents = [];
  const consume = (block) => {
    const data = block.split(/\r?\n/gu).filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/u, "")).join("\n").trim();
    if (!data) return;
    if (data === "[DONE]") { sawDone = true; return; }
    const payload = JSON.parse(data);
    const summary = summarizeSsePayload(payload);
    if (summary) metadataEvents.push(summary);
    const delta = contentDelta(payload);
    if (delta) {
      if (firstContentDeltaMs === null) firstContentDeltaMs = performance.now() - startedAt;
      output += delta;
      contentEvents += 1;
    }
    if (payload?.error) throw new Error(`${label}_LLM_SSE_ERROR:${String(payload.error).slice(0, 500)}`);
  };
  while (!sawDone) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstBodyChunkMs === null) firstBodyChunkMs = performance.now() - startedAt;
    bodyChunks += 1;
    pending += decoder.decode(value, { stream: true });
    const blocks = pending.split(/\r?\n\r?\n/gu);
    pending = blocks.pop() || "";
    for (const block of blocks) consume(block);
  }
  pending += decoder.decode();
  if (pending.trim()) consume(pending);
  const totalMs = performance.now() - startedAt;
  assert.equal(sawDone, true, `${label}_LLM_DONE_MISSING`);
  assert.ok(output.trim().length > 100, `${label}_LLM_OUTPUT_EMPTY`);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const history = await requestJson(`/api/conversations/history?id=${encodeURIComponent(conversationId)}`);
  const messages = history.conversation?.messages
    || history.data?.conversation?.messages
    || history.messages
    || history.data?.messages
    || [];
  assert.ok(messages.some((item) => item.role === "user"), `${label}_USER_HISTORY_MISSING`);
  assert.ok(messages.some((item) => item.role === "assistant"), `${label}_ASSISTANT_HISTORY_MISSING`);
  return {
    label,
    model: { id: model.id, displayName: model.displayName },
    conversationId,
    clientRequestId,
    output: output.trim(),
    outputSha256: sha256(output.trim()),
    historyMessageCount: messages.length,
    timings: {
      responseHeadersMs: round(headersMs),
      firstBodyChunkMs: firstBodyChunkMs === null ? null : round(firstBodyChunkMs),
      providerFirstContentMs: firstContentDeltaMs === null ? null : round(firstContentDeltaMs),
      totalMs: round(totalMs),
      localRenderDelayMs: null,
    },
    stream: { bodyChunks, contentEvents, outputCharacters: output.trim().length, sawDone },
    metadataEvents,
  };
}

function qualityScore(output) {
  const checks = {
    imagePrompt: /生图\s*Prompt|生图提示词/iu.test(output),
    videoPrompt: /视频\s*Prompt|视频提示词/iu.test(output),
    frame: /Frame\s*\d+/iu.test(output),
    timecode: /(?:\d+(?:\.\d+)?\s*(?:秒|s))|\[\d+\s*-\s*\d+s\]/iu.test(output),
    continuity: /连续|连贯|接力|一致性/iu.test(output),
    audioBoundary: /无对白|无旁白|No dialogue|No narration|声音/iu.test(output),
    modelRoute: /自动通用|MiniMax H3|Omni Flash|Grok Imagine/iu.test(output),
    storyboardDensity: (output.match(/Frame\s*\d+/giu) || []).length >= 3,
  };
  return { checks, score: Object.values(checks).filter(Boolean).length };
}

function imagePromptFromOutput(output) {
  const labelled = output.match(/生图\s*(?:Prompt|提示词)[^`]{0,300}```(?:[^\n]*)\n([\s\S]*?)```/iu);
  if (labelled?.[1]?.trim()) return labelled[1].trim().slice(0, 7_500);
  const fences = [...output.matchAll(/```(?:[^\n]*)\n([\s\S]*?)```/gu)].map((match) => match[1].trim());
  const candidate = fences.find((value) => /Frame\s*1|画面|构图|镜头/iu.test(value) && !/\[0[-–]?[1-9]s\]|No dialogue/iu.test(value));
  assert.ok(candidate, "IMAGE_PROMPT_NOT_FOUND_IN_MODEL_OUTPUT");
  return candidate.slice(0, 7_500);
}

function videoPromptFromOutput(output) {
  const labelled = output.match(/视频\s*(?:Prompt|提示词)[^`]{0,300}```(?:[^\n]*)\n([\s\S]*?)```/iu);
  if (labelled?.[1]?.trim()) return labelled[1].trim().slice(0, 7_500);
  const fences = [...output.matchAll(/```(?:[^\n]*)\n([\s\S]*?)```/gu)].map((match) => match[1].trim());
  const candidate = fences.find((value) => /(?:\d+(?:\.\d+)?\s*(?:秒|s)|运镜|动作|No dialogue|No narration)/iu.test(value));
  assert.ok(candidate, "VIDEO_PROMPT_NOT_FOUND_IN_MODEL_OUTPUT");
  return candidate.slice(0, 7_500);
}

async function extractAndSegment(page) {
  let extractionPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/extract") extractionPosts += 1;
  });
  await page.goto(`${origin}/tools?tab=text`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const input = page.getByRole("textbox", { name: "文案分享文本或链接" });
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(sourceUrl);
  await page.getByRole("button", { name: "提取文案", exact: true }).click();
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.includes("送去分段") || text.includes("提取失败") || text.includes("结果待确认");
  }, undefined, { timeout: 420_000 });
  assert.equal(extractionPosts, 1, `EXTRACTION_POST_COUNT_INVALID:${extractionPosts}`);
  const handoff = page.getByRole("button", { name: "送去分段", exact: true });
  assert.equal(await handoff.isVisible().catch(() => false), true, "EXTRACTION_DID_NOT_REACH_SUCCESS");
  const resultBlock = page.locator(".toolbox-results-block").filter({ has: handoff });
  const extractionText = await resultBlock.innerText();
  await page.screenshot({ path: path.join(outputDir, "01-extraction-success.png"), fullPage: true });
  await handoff.click();
  const segmentInput = page.getByRole("textbox", { name: "需要分段的文案" });
  await segmentInput.waitFor({ state: "visible", timeout: 20_000 });
  const transferredText = await segmentInput.inputValue();
  assert.ok(transferredText.trim().length > 20, "EXTRACTION_HANDOFF_TEXT_EMPTY");
  await page.getByRole("button", { name: "开始分段", exact: true }).click();
  await page.locator("[data-segmenter-result=true]").waitFor({ state: "visible", timeout: 30_000 });
  const segments = (await page.locator("[data-segment-index] p").allInnerTexts())
    .map((value) => value.trim().replace(/^【|】$/gu, "")).filter(Boolean);
  assert.ok(segments.length > 0, "SEGMENT_RESULTS_EMPTY");
  await page.screenshot({ path: path.join(outputDir, "02-segmented-copy.png"), fullPage: true });
  return {
    extractionPosts,
    extractionText,
    transferredText,
    segments,
    segmentDurationSeconds: 8,
  };
}

async function generateStoryboardImage(page, selectedModel, prompt, billingBefore, label) {
  let generationPosts = 0;
  let requestBody = null;
  const onRequest = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/image/generate") {
      generationPosts += 1;
      requestBody = request.postDataJSON();
    }
  };
  page.on("request", onRequest);
  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const modelButton = page.locator(`.sbw-image-model-list button[data-model-id="${selectedModel.id}"]`).first();
  await modelButton.waitFor({ state: "visible", timeout: 45_000 });
  await modelButton.click();
  const removeButtons = page.getByTitle("删除镜头", { exact: true });
  while (await removeButtons.count() > 1) await removeButtons.last().click();
  const controls = page.locator(".sbw-control-group.is-image");
  await controls.getByRole("button", { name: "16:9", exact: true }).click();
  const resolution = controls.getByRole("combobox", { name: "图片分辨率" });
  if (await resolution.count()) await resolution.selectOption({ label: requestedResolution });
  const card = page.locator("article.sbw-shot-card").first();
  await card.getByRole("textbox", { name: "镜头1生图提示词" }).fill(prompt);
  const generationResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/image/generate", { timeout: 420_000 });
  await card.locator("button.is-image-command").click();
  const generationResponse = await generationResponsePromise;
  const responseBody = await generationResponse.json().catch(() => ({}));
  assert.equal(generationPosts, 1, `IMAGE_GENERATION_POST_COUNT_INVALID:${generationPosts}`);
  assert.equal(generationResponse.status(), 200, responseBody?.error || "STORYBOARD_IMAGE_GENERATION_FAILED");
  assert.equal(responseBody.success, true, "STORYBOARD_IMAGE_RESPONSE_NOT_SUCCESS");
  assert.equal(requestBody?.modelId, selectedModel.id, "STORYBOARD_IMAGE_MODEL_MISMATCH");
  assert.equal(requestBody?.historySurface, "storyboard-workbench", "STORYBOARD_HISTORY_SURFACE_MISMATCH");
  const generatedImage = card.locator(".sbw-image-frame img").first();
  await generatedImage.waitFor({ state: "visible", timeout: 60_000 });
  const rendered = await generatedImage.evaluate((image) => ({
    src: image.currentSrc || image.src,
    width: image.naturalWidth,
    height: image.naturalHeight,
    complete: image.complete,
  }));
  assert.ok(rendered.complete && rendered.width > 0 && rendered.height > 0, "STORYBOARD_IMAGE_NOT_RENDERED");
  const assetResponse = await fetch(rendered.src, { headers: rendered.src.startsWith(origin) ? authHeaders() : {}, signal: AbortSignal.timeout(60_000) });
  const assetBytes = Buffer.from(await assetResponse.arrayBuffer());
  const metadata = await sharp(assetBytes).metadata();
  assert.ok(assetResponse.ok && assetBytes.length > 1_000 && metadata.width && metadata.height, "STORYBOARD_IMAGE_ASSET_INVALID");
  const extension = metadata.format === "jpeg" ? "jpg" : (metadata.format || "bin");
  const assetFile = `${label}-storyboard.${extension}`;
  await fs.writeFile(path.join(outputDir, assetFile), assetBytes, { flag: "wx" });
  await page.screenshot({ path: path.join(outputDir, `03-${label}-storyboard-image-success.png`), fullPage: true });
  let billingAfter = await billingSnapshot();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (billingAfter.cashRows.some((row) => !billingBefore.cashIds.has(String(row.id)))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
    billingAfter = await billingSnapshot();
  }
  const newRows = billingAfter.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
  const expectedCharge = Number(responseBody.cashCharged);
  const balanceDelta = round(billingBefore.balance - billingAfter.balance);
  assert.ok(expectedCharge > 0, "IMAGE_CASH_CHARGE_MISSING");
  assert.ok(Math.abs(balanceDelta - expectedCharge) <= 0.000001, "IMAGE_BALANCE_DELTA_MISMATCH");
  assert.equal(newRows.length, 1, `IMAGE_TRANSACTION_COUNT_MISMATCH:${newRows.length}`);
  page.off("request", onRequest);
  return {
    label,
    selectedModel: { id: selectedModel.id, displayName: selectedModel.displayName },
    generationPosts,
    request: { traceId: requestBody.clientTraceId, aspectRatio: requestBody.aspectRatio, resolution: requestBody.resolution },
    response: { assetId: responseBody.images?.[0]?.assetId, modelIdUsed: responseBody.modelIdUsed, cashCharged: expectedCharge },
    billing: { balanceBefore: billingBefore.balance, balanceAfter: billingAfter.balance, balanceDelta, transactionId: newRows[0].id },
    asset: { file: assetFile, bytes: assetBytes.length, sha256: sha256(assetBytes), width: metadata.width, height: metadata.height, format: metadata.format },
  };
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.match(runId, /^[a-zA-Z0-9_-]{8,100}$/u, "RUN_ID_INVALID");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  await fs.mkdir(outputDir, { recursive: true });
  if (!execute) {
    console.log(JSON.stringify({
      mode: "plan",
      sourceUrl,
      llmPosts: resumePriorReportPath ? 1 : 2,
      extractionPosts: resumePriorReportPath ? 0 : 1,
      imagePosts: 2,
      retryCount: 0,
      resumesClaudeWithoutProviderCall: Boolean(resumePriorReportPath),
      outputDir,
    }));
    return;
  }
  const version = await requestJson("/api/version");
  const diskBuildId = (await fs.readFile(path.resolve(".next/BUILD_ID"), "utf8")).trim();
  const diskSourceVersion = JSON.parse(await fs.readFile(path.resolve("public/version.json"), "utf8")).sourceVersion;
  assert.equal(version.buildId, diskBuildId, "CURRENT_RUNTIME_BUILD_ID_STALE");
  assert.equal(version.sourceVersion, diskSourceVersion, "CURRENT_RUNTIME_SOURCE_VERSION_STALE");
  const fingerprint = spawnSync(process.execPath, ["scripts/local-build-fingerprint.mjs", "verify", process.cwd()], { encoding: "utf8" });
  assert.equal(fingerprint.status, 0, `CURRENT_RUNTIME_SOURCE_FINGERPRINT_STALE:${fingerprint.stderr || fingerprint.stdout}`);
  const identity = await requestJson("/api/auth/me");
  assert.equal(identity.user?.role, "admin", "LOCAL_ADMIN_REQUIRED");
  const [agentsPayload, chatPayload, imagePayload] = await Promise.all([
    requestJson("/api/bots?shape=agents"),
    requestJson("/api/chat-models"),
    requestJson("/api/cover-models?surface=storyboard-workbench"),
  ]);
  const agent = (agentsPayload.agents || []).find((item) => item.name === agentName);
  assert.ok(agent?.id, "HIGH_ENERGY_AGENT_NOT_FOUND");
  const opus = selectByName(chatPayload.models || [], ["Claude Opus 5.5", "Claude Opus5.5"]);
  const gpt = selectByName(chatPayload.models || [], ["GPT-6.1 Sol", "GPT6.1Sol", "GPT-6.1"]);
  assert.ok(opus?.id, "CLAUDE_OPUS_55_MODEL_NOT_FOUND");
  assert.ok(gpt?.id, "GPT_61_MODEL_NOT_FOUND");
  assert.notEqual(opus.id, gpt.id, "AB_MODELS_MUST_DIFFER");
  const imageModel = selectByName(imagePayload.models || [], [imageModelNeedle]);
  assert.ok(imageModel?.id && imageModel.capabilities?.available !== false, "GPT_IMAGE_25_SUNBURST_NOT_AVAILABLE");
  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  const pageErrors = [];
  const report = {
    schemaVersion: 1,
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
    source: { url: sourceUrl, publicEvidence: "抖音公开页面；热度数字在外部检索证据中留存" },
    providerPostLimits: {
      extraction: resumePriorReportPath ? 0 : 1,
      claudeOpus55: resumePriorReportPath ? 0 : 1,
      gpt61: 1,
      gptImage25: 2,
      retryCount: 0,
    },
    runtime: { sourceVersion: version.sourceVersion, buildId: version.buildId, sourceFingerprintCurrent: true, runningLatest: true },
  };
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500)); });
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 500)));
    let preset;
    let opusResult;
    if (resumePriorReportPath) {
      const priorReport = JSON.parse(await fs.readFile(path.resolve(resumePriorReportPath), "utf8"));
      const recoveryDir = path.resolve(resumeClaudeEvidenceDir);
      const recovery = JSON.parse(await fs.readFile(path.join(recoveryDir, "recovery.json"), "utf8"));
      const recoveredInput = (await fs.readFile(path.join(recoveryDir, "user-input.txt"), "utf8")).trimEnd();
      const recoveredOutput = (await fs.readFile(path.join(recoveryDir, "claude-opus-55-output.md"), "utf8")).trimEnd();
      assert.equal(sha256(recoveredInput), priorReport.agent?.inputSha256, "RECOVERED_INPUT_SHA_MISMATCH");
      assert.equal(sha256(recoveredInput), recovery.user?.sha256, "RECOVERY_USER_SHA_MISMATCH");
      assert.equal(sha256(recoveredOutput), recovery.assistant?.sha256, "RECOVERY_ASSISTANT_SHA_MISMATCH");
      assert.equal(priorReport.agent?.id, agent.id, "RECOVERED_AGENT_CHANGED");
      preset = { values: priorReport.agent.presetValues, message: recoveredInput };
      report.extraction = { ...priorReport.extraction, posts: 0, recoveredFromRunId: priorReport.runId };
      report.agent = { ...priorReport.agent, recoveredInput: true };
      report.resume = {
        priorRunId: priorReport.runId,
        recoveredConversationId: recovery.conversationId,
        claudeProviderRequestsThisRun: 0,
        extractionProviderRequestsThisRun: 0,
      };
      opusResult = {
        label: "claude-opus-55",
        model: { id: opus.id, displayName: opus.displayName },
        conversationId: recovery.conversationId,
        clientRequestId: null,
        output: recoveredOutput,
        outputSha256: recovery.assistant.sha256,
        historyMessageCount: recovery.messageCount,
        timings: null,
        metadataEvents: [],
        stream: null,
        recoveredWithoutProviderCall: true,
      };
    } else {
      const extraction = await extractAndSegment(page);
      const scopedSegments = extraction.segments.slice(0, 3);
      preset = buildAgentInput(agent, scopedSegments);
      report.extraction = {
        posts: extraction.extractionPosts,
        extractedCharacters: extraction.transferredText.length,
        extractedSha256: sha256(extraction.transferredText),
        segmentCount: extraction.segments.length,
        abSegmentCount: scopedSegments.length,
        segmentDurationSeconds: extraction.segmentDurationSeconds,
      };
      report.agent = { id: agent.id, name: agent.name, presetValues: preset.values, inputSha256: sha256(preset.message), inputCharacters: preset.message.length };
      opusResult = await runLlm({ model: opus, agent, input: preset.message, label: "claude-opus-55" });
    }
    await fs.writeFile(path.join(outputDir, "claude-opus-55-output.md"), `${opusResult.output}\n`, { flag: "wx" });
    const gptResult = await runLlm({ model: gpt, agent, input: preset.message, label: "gpt-61-sol" });
    await fs.writeFile(path.join(outputDir, "gpt-61-sol-output.md"), `${gptResult.output}\n`, { flag: "wx" });
    const opusQuality = qualityScore(opusResult.output);
    const gptQuality = qualityScore(gptResult.output);
    const promptLeader = gptQuality.score > opusQuality.score ? gptResult : opusResult;
    const promptLeaderQuality = promptLeader === gptResult ? gptQuality : opusQuality;
    const opusImagePrompt = imagePromptFromOutput(opusResult.output);
    const gptImagePrompt = imagePromptFromOutput(gptResult.output);
    const opusVideoPrompt = videoPromptFromOutput(opusResult.output);
    const gptVideoPrompt = videoPromptFromOutput(gptResult.output);
    await fs.writeFile(path.join(outputDir, "claude-opus-55-image-prompt.txt"), `${opusImagePrompt}\n`, { flag: "wx" });
    await fs.writeFile(path.join(outputDir, "gpt-61-sol-image-prompt.txt"), `${gptImagePrompt}\n`, { flag: "wx" });
    await fs.writeFile(path.join(outputDir, "claude-opus-55-video-prompt.txt"), `${opusVideoPrompt}\n`, { flag: "wx" });
    await fs.writeFile(path.join(outputDir, "gpt-61-sol-video-prompt.txt"), `${gptVideoPrompt}\n`, { flag: "wx" });
    report.ab = {
      sameInput: report.agent.inputSha256 === sha256(preset.message)
        && (opusResult.recoveredWithoutProviderCall === true || opusResult.clientRequestId !== gptResult.clientRequestId),
      claude: { ...opusResult, output: undefined, quality: opusQuality },
      gpt: { ...gptResult, output: undefined, quality: gptQuality },
      promptLeader: { label: promptLeader.label, model: promptLeader.model, reason: `结构质检得分 ${promptLeaderQuality.score}/8；这只是提示词阶段的临时领先，最终结论必须加入同生图模型和同视频模型结果。` },
      promptFiles: {
        claudeImage: "claude-opus-55-image-prompt.txt",
        gptImage: "gpt-61-sol-image-prompt.txt",
        claudeVideo: "claude-opus-55-video-prompt.txt",
        gptVideo: "gpt-61-sol-video-prompt.txt",
      },
      providerTtftDefinition: "从本地 /api/llm 提交开始，到浏览器收到首个非空模型内容增量；响应头与首字节另行记录。",
      localRenderDelayAvailable: false,
    };
    const billingBeforeClaudeImage = await billingSnapshot();
    const claudeImage = await generateStoryboardImage(page, imageModel, opusImagePrompt, billingBeforeClaudeImage, "claude-opus-55");
    const billingBeforeGptImage = await billingSnapshot();
    const gptImage = await generateStoryboardImage(page, imageModel, gptImagePrompt, billingBeforeGptImage, "gpt-61-sol");
    report.storyboardImages = {
      sameModel: claudeImage.selectedModel.id === gptImage.selectedModel.id,
      sameAspectRatio: claudeImage.request.aspectRatio === gptImage.request.aspectRatio,
      sameResolution: claudeImage.request.resolution === gptImage.request.resolution,
      claude: claudeImage,
      gpt: gptImage,
    };
    report.completedAt = new Date().toISOString();
    report.status = "passed";
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.tokenPersisted = false;
    await context.close();
  } catch (error) {
    report.status = "failed-stopped-no-retry";
    report.failedAt = new Date().toISOString();
    report.error = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    throw error;
  } finally {
    await browser.close();
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({ success: true, runId, status: report.status, report: path.join(outputDir, "report.json"), promptLeader: report.ab.promptLeader, storyboardImages: report.storyboardImages }, null, 2));
}
