/**
 * 重新生成 / 改写 · 单条用户消息验收（1440×900）
 *
 * 运行：
 * node ./scripts/with-local-admin-session.mjs scripts/verify-chat-regenerate-edit.mjs
 *
 * - 真实 127.0.0.1:5000 构建、真实聊天组件；
 * - /api/llm 全部拦截并回放 SSE/HTTP 夹具，不调用上游、不扣费；
 * - 覆盖：失败后重新生成、改写后替换原消息、成功后再次重新生成；
 * - 断言：用户消息只出现一次，旧分支不再显示，请求体带 persist_user_message / truncate_from。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const TOKEN = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
const OUTPUT_ROOT = path.resolve(process.env.CHAT_REGENERATE_EDIT_OUTPUT_DIR || ".codex-evidence/chat-regenerate-edit-20261022");
const requestedRunId = process.env.CHAT_REGENERATE_EDIT_RUN_ID?.trim();
const RUN_ID = requestedRunId || `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}-${randomBytes(4).toString("hex")}`;
assert.match(RUN_ID, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, "INVALID_EVIDENCE_RUN_ID");
const EVIDENCE_DIR = path.join(OUTPUT_ROOT, RUN_ID);
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };
const INPUT = 'textarea[aria-label^="向 "]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveScreenshot(page, name) {
  const target = path.join(EVIDENCE_DIR, name);
  await page.screenshot({ path: target, fullPage: false });
  return target;
}

function sse(content) {
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

function sseError(message) {
  return [
    `data: ${JSON.stringify({ error: message, code: "FIXTURE_FAILURE", done: false })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

async function userBubbleTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('article[data-message-role="user"]')]
    .map((element) => String(element.textContent || "").replace(/\s+/gu, " ").trim()));
}

async function assistantBubbleTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('article[data-message-role="assistant"]')]
    .map((element) => String(element.textContent || "").replace(/\s+/gu, " ").trim()));
}

async function waitForIdle(page) {
  await page.waitForFunction(
    () => !document.querySelector(".chat-canvas")?.classList.contains("chat-streaming"),
    { timeout: 25_000 },
  );
  await sleep(450);
}

async function fillAndSend(page, text) {
  const textarea = await page.waitForSelector(INPUT, { visible: true, timeout: 15_000 });
  await textarea.click();
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (text) await page.type(INPUT, text);
  await page.keyboard.press("Enter");
}

async function waitForRequest(page, requests, expectedCount) {
  const deadline = Date.now() + 20_000;
  while (requests.length < expectedCount && Date.now() < deadline) await sleep(100);
  assert.equal(requests.length, expectedCount, `应命中 ${expectedCount} 次 /api/llm，实际 ${requests.length}`);
}

async function startNewChat(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await page.evaluate(() => Boolean(document.querySelector("button.new-chat-btn")))) {
        await sleep(1_200);
        if (await page.evaluate(() => Boolean(document.querySelector("button.new-chat-btn")))) break;
      } else {
        await sleep(250);
      }
    }
    await page.evaluate(() => document.querySelector("button.new-chat-btn")?.click());
    try {
      await page.waitForSelector(INPUT, { visible: true, timeout: 10_000 });
      await sleep(600);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("新建对话未进入输入态");
}

export async function main() {
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  try {
    await fs.mkdir(EVIDENCE_DIR);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`EVIDENCE_RUN_DIRECTORY_EXISTS:${EVIDENCE_DIR}`);
    throw error;
  }
  assert.ok(TOKEN, "需要以 scripts/with-local-admin-session.mjs 启动，提供管理员会话");

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !/product-usage|Failed to load resource: the server responded with a status of 503|SSE流因error中断/iu.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));

  const llmRequests = [];
  const plan = [];
  let interceptionReady = false;

  try {
    await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate((token) => {
      localStorage.clear();
      localStorage.setItem("auth_token", token);
      localStorage.setItem("active_view", "chat");
      localStorage.setItem("sidebar_collapsed", "false");
      sessionStorage.setItem("entered_app", "1");
    }, TOKEN);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("button.new-chat-btn", { timeout: 60_000 });

    await page.setRequestInterception(true);
    interceptionReady = true;
    page.on("request", (request) => {
      const url = request.url();
      if (!url.includes("/api/llm") || request.method() !== "POST") {
        void request.continue().catch(() => undefined);
        return;
      }
      let body = null;
      try { body = JSON.parse(request.postData() || "{}"); } catch { body = {}; }
      llmRequests.push({ body, url });
      const next = plan.shift();
      if (!next) {
        void request.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture plan exhausted", code: "FIXTURE_PLAN_EXHAUSTED" }) }).catch(() => undefined);
        return;
      }
      if (next.error) {
        void request.respond({ status: 200, contentType: "text/event-stream; charset=utf-8", headers: { "Cache-Control": "no-cache" }, body: sseError(next.message) }).catch(() => undefined);
        return;
      }
      if (next.status === 500) {
        void request.respond({ status: 500, contentType: "application/json", body: JSON.stringify(next.body) }).catch(() => undefined);
      } else {
        void request.respond({ status: 200, contentType: "text/event-stream; charset=utf-8", headers: { "Cache-Control": "no-cache" }, body: sse(next.content) }).catch(() => undefined);
      }
    });

    // ── 场景 A：首条失败 → 点击“重新生成”，用户消息只能有一句 ──
    await startNewChat(page);
    plan.push({ error: true, message: "fixture failure" });
    await fillAndSend(page, "你好");
    await waitForRequest(page, llmRequests, 1);
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].some((button) => String(button.textContent || "").includes("重新生成")),
      { timeout: 20_000 },
    );
    await waitForIdle(page);
    assert.deepEqual(await userBubbleTexts(page), ["你好"], "首条失败后用户消息只能出现一次");
    await saveScreenshot(page, "01-failed-once.png");

    plan.push({ status: 200, content: "重新生成成功。" });
    const regenerateButton = await page.waitForSelector('article[data-message-role="assistant"] button[aria-label="重新生成"], button.chat-message-state-action', { visible: true, timeout: 10_000 });
    await regenerateButton.click();
    await waitForRequest(page, llmRequests, 2);
    await page.waitForFunction(() => String(document.body.textContent || "").includes("重新生成成功。"), { timeout: 20_000 });
    await waitForIdle(page);
    assert.deepEqual(await userBubbleTexts(page), ["你好"], "失败后重新生成不得追加第二个用户消息");
    const retryBody = llmRequests[1].body;
    assert.equal(retryBody.persist_user_message, false, "重新生成必须要求后端跳过用户消息落库");
    assert.ok(retryBody.truncate_from, "重新生成必须传 truncate_from");
    const retryUserMessages = (retryBody.messages || []).filter((message) => message.role === "user");
    assert.equal(retryUserMessages.length, 1, "重新生成的上下文里只能有一条用户消息");
    await saveScreenshot(page, "02-regenerated-once.png");

    // ── 场景 B：改写 → 发送后替换原消息，不追加第二句 ──
    await startNewChat(page);
    plan.push({ status: 200, content: "第一版回复。" });
    await fillAndSend(page, "你好");
    await waitForRequest(page, llmRequests, 3);
    await page.waitForFunction(() => String(document.body.textContent || "").includes("第一版回复。"), { timeout: 20_000 });
    await waitForIdle(page);

    await page.click('article[data-message-role="user"] button[aria-label="改写你的消息"]');
    const editingBanner = await page.waitForFunction(
      () => String(document.body.textContent || "").includes("正在改写这条消息，发送后会替换原消息"),
      { timeout: 5_000 },
    );
    assert.ok(editingBanner, "改写时应显示替换提示");
    const inputValue = await page.$eval(INPUT, (element) => element.value);
    assert.equal(inputValue, "你好", "改写应把原消息载入输入框");
    await saveScreenshot(page, "03-editing-banner.png");

    plan.push({ status: 200, content: "改写后的回复。" });
    await fillAndSend(page, "你好呀");
    await waitForRequest(page, llmRequests, 4);
    await page.waitForFunction(() => String(document.body.textContent || "").includes("改写后的回复。"), { timeout: 20_000 });
    await waitForIdle(page);
    assert.deepEqual(await userBubbleTexts(page), ["你好呀"], "改写后旧消息应被替换，只保留一句用户消息");
    assert.equal((await assistantBubbleTexts(page)).some((text) => text.includes("第一版回复。")), false, "改写后旧回复应被移除");
    const editBody = llmRequests[3].body;
    assert.ok(editBody.truncate_from, "改写必须传 truncate_from");
    assert.notEqual(editBody.persist_user_message, false, "改写需要落一条新的用户消息");
    const editMessages = editBody.messages || [];
    assert.equal(editMessages.filter((message) => message.role === "user").length, 1, "改写上下文里只能有一条用户消息");
    assert.equal(editMessages.some((message) => JSON.stringify(message).includes("第一版回复。")), false, "改写后旧回复不得进入上下文");
    await saveScreenshot(page, "04-edited-once.png");

    // ── 场景 C：成功后再次重新生成，仍然只有一句用户消息 ──
    plan.push({ status: 200, content: "重新生成后的回复。" });
    await page.click('article[data-message-role="assistant"] button[aria-label="重新生成"]');
    await waitForRequest(page, llmRequests, 5);
    await page.waitForFunction(() => String(document.body.textContent || "").includes("重新生成后的回复。"), { timeout: 20_000 });
    await waitForIdle(page);
    assert.deepEqual(await userBubbleTexts(page), ["你好呀"], "成功后重新生成不得追加用户消息");
    assert.equal((await assistantBubbleTexts(page)).some((text) => text.includes("改写后的回复。")), false, "重新生成应替换旧回复");
    const regenerateBody = llmRequests[4].body;
    assert.equal(regenerateBody.persist_user_message, false, "成功后重新生成也必须跳过用户消息落库");
    assert.ok(regenerateBody.truncate_from, "成功后重新生成必须传 truncate_from");
    await saveScreenshot(page, "05-regenerated-again.png");

    const report = {
      ok: true,
      runId: RUN_ID,
      outputRoot: OUTPUT_ROOT,
      evidenceDirectory: EVIDENCE_DIR,
      viewport: VIEWPORT,
      scenarios: ["failed-then-regenerate", "edit-replaces-original", "regenerate-after-success"],
      requestCount: llmRequests.length,
      userBubbles: await userBubbleTexts(page),
      assistantBubbles: await assistantBubbleTexts(page),
      requestPersistence: llmRequests.map((entry) => ({
        persistUserMessage: entry.body.persist_user_message,
        hasTruncateFrom: Boolean(entry.body.truncate_from),
        userMessages: (entry.body.messages || []).filter((message) => message.role === "user").length,
      })),
      consoleErrors,
      pageErrors,
      screenshots: [
        "01-failed-once.png",
        "02-regenerated-once.png",
        "03-editing-banner.png",
        "04-edited-once.png",
        "05-regenerated-again.png",
      ],
    };
    await fs.writeFile(path.join(EVIDENCE_DIR, "report.json"), JSON.stringify(report, null, 2), { encoding: "utf8", flag: "wx" });
    assert.deepEqual(pageErrors, [], "不应出现页面异常");
    assert.deepEqual(consoleErrors, [], `不应出现控制台错误：${consoleErrors.join(" | ")}`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (interceptionReady) await page.setRequestInterception(false).catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("verify-chat-regenerate-edit.mjs")) {
  main().catch((error) => {
    if (!String(error?.message || error).startsWith("EVIDENCE_RUN_DIRECTORY_EXISTS:")) {
      void fs.writeFile(
        path.join(EVIDENCE_DIR, "failure-report.json"),
        JSON.stringify({ ok: false, runId: RUN_ID, outputRoot: OUTPUT_ROOT, evidenceDirectory: EVIDENCE_DIR, error: String(error?.message || error) }, null, 2),
        { encoding: "utf8", flag: "wx" },
      ).catch(() => undefined);
    }
    console.error(error);
    process.exitCode = 1;
  });
}
