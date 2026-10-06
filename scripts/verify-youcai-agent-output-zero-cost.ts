import assert from "node:assert/strict";
import { chromium, type Locator, type Page, type Route } from "playwright";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:5000";
const targetPath = "/youcai/tools/text/text-chat";
const targetURL = new URL(targetPath, baseURL).toString();
const conversationId = "verify_you_cai_agent_output_zero_cost";
const createdAt = "2026-08-24T00:00:00.000Z";

const assistantMarkdown = [
  "## 零付费输出验收",
  "",
  "- 第一项：剧情拆解",
  "- 第二项：镜头约束",
  "",
  "```json",
  "{",
  "  \"status\": \"ok\",",
  "  \"mode\": \"readonly\"",
  "}",
  "```",
].join("\n");

const mockUser = {
  id: "verify-zero-cost-user",
  username: "零付费验收用户",
  role: "user",
  themePreference: "coze",
};

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface StyleAudit {
  color: string;
  background: string;
  contrast: number;
  effectiveOpacity: number;
  nonNoneFilters: string[];
  width: number;
  height: number;
}

type Rgba = [number, number, number, number];

function parseRgba(value: string): Rgba | null {
  const match = value.match(/rgba?\((\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:[,\s/]+(\d*(?:\.\d+)?))?\)/i);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined || match[4] === "" ? 1 : Number(match[4]),
  ];
}

function blend(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha <= 0) return [255, 255, 255, 1];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function luminance(value: Rgba) {
  const channels = value.slice(0, 3).map((item) => {
    const normalized = item / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

async function auditStyle(locator: Locator): Promise<StyleAudit> {
  const raw = await locator.evaluate((element) => {
    const backgrounds: string[] = [];
    const opacities: number[] = [];
    const nonNoneFilters: string[] = [];
    let cursor: Element | null = element;
    while (cursor) {
      const current = getComputedStyle(cursor);
      backgrounds.unshift(current.backgroundColor);
      opacities.push(Number(current.opacity || "1"));
      if (current.filter && current.filter !== "none") nonNoneFilters.push(current.filter);
      cursor = cursor.parentElement;
    }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      color: style.color,
      backgrounds,
      opacities,
      nonNoneFilters,
      width: Number(rect.width.toFixed(1)),
      height: Number(rect.height.toFixed(1)),
    };
  });

  let background: Rgba = [255, 255, 255, 1];
  for (const value of raw.backgrounds) {
    const parsed = parseRgba(value);
    if (parsed && parsed[3] > 0) background = blend(parsed, background);
  }
  const foreground = parseRgba(raw.color) || [0, 0, 0, 1];
  const opaqueForeground = blend(foreground, background);
  const lighter = Math.max(luminance(opaqueForeground), luminance(background));
  const darker = Math.min(luminance(opaqueForeground), luminance(background));

  return {
    color: raw.color,
    background: `rgb(${Math.round(background[0])}, ${Math.round(background[1])}, ${Math.round(background[2])})`,
    contrast: Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2)),
    effectiveOpacity: Number(raw.opacities.reduce((result, opacity) => result * opacity, 1).toFixed(3)),
    nonNoneFilters: raw.nonNoneFilters,
    width: raw.width,
    height: raw.height,
  };
}

async function assertRenderedOutput(page: Page) {
  const article = page.locator('article[data-role="assistant"][data-message-status="complete"]').filter({
    hasText: "零付费输出验收",
  });
  await article.waitFor({ state: "visible", timeout: 20_000 });

  const heading = article.getByRole("heading", { name: "零付费输出验收", level: 2, exact: true });
  const listItems = article.locator("li");
  const codeWrapper = article.locator(".code-block-wrapper");
  const codeBlock = article.locator("pre code");

  await heading.waitFor({ state: "visible" });
  assert.equal(await listItems.count(), 2, "assistant Markdown 应渲染两条列表项");
  assert.equal((await listItems.nth(0).innerText()).trim(), "第一项：剧情拆解");
  assert.equal((await listItems.nth(1).innerText()).trim(), "第二项：镜头约束");
  await codeWrapper.waitFor({ state: "visible" });
  await codeBlock.waitFor({ state: "visible" });
  assert.match(await codeBlock.innerText(), /"status"\s*:\s*"ok"/u);
  assert.match(await codeBlock.innerText(), /"mode"\s*:\s*"readonly"/u);

  assert.equal(
    await article.getByRole("button", { name: "发送", exact: true }).count(),
    0,
    "assistant 输出代码块不应出现官网非标准的“发送”按钮",
  );
  assert.equal(
    await article.getByRole("button", { name: "推送图片", exact: true }).count(),
    0,
    "assistant 输出代码块不应出现官网非标准的“推送图片”按钮",
  );

  const audits = {
    article: await auditStyle(article),
    heading: await auditStyle(heading),
    firstListItem: await auditStyle(listItems.nth(0)),
    codeWrapper: await auditStyle(codeWrapper),
    code: await auditStyle(codeBlock),
  };

  for (const [name, audit] of Object.entries(audits)) {
    assert.ok(audit.width > 0 && audit.height > 0, `${name} 必须有可见尺寸`);
    assert.ok(audit.effectiveOpacity >= 0.9, `${name} 有效 opacity 不应低于 0.9`);
    assert.deepEqual(audit.nonNoneFilters, [], `${name} 及祖先不应使用 filter 降低可读性`);
  }
  for (const name of ["heading", "firstListItem", "code"] as const) {
    assert.ok(audits[name].contrast >= 4.5, `${name} 对比度 ${audits[name].contrast} 未达到 4.5:1`);
  }

  return audits;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const writeAttempts: Array<{ method: string; url: string }> = [];
  const historyReads: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await context.addInitScript(({ activeId, user }) => {
    localStorage.setItem("auth_token", "zero-cost-readonly-token");
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_conversation_id", activeId);
    localStorage.setItem("active_view", "chat");
    localStorage.removeItem("conv_cache");
    localStorage.setItem("user_theme_preference", "coze");
  }, { activeId: conversationId, user: mockUser });

  await page.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());

    if (writeMethods.has(method)) {
      writeAttempts.push({ method, url: url.toString() });
      await route.abort("blockedbyclient");
      return;
    }

    if (url.origin === new URL(baseURL).origin && url.pathname === "/api/auth/me") {
      await json(route, { user: mockUser });
      return;
    }
    if (url.origin === new URL(baseURL).origin && url.pathname === "/api/settings") {
      await json(route, { settings: { theme: "coze" } });
      return;
    }
    if (url.origin === new URL(baseURL).origin && url.pathname === "/api/settings/layout") {
      await json(route, { layout: null });
      return;
    }
    if (url.origin === new URL(baseURL).origin && url.pathname === "/api/credits") {
      await json(route, { credits: 5000.5, cashBalance: 20 });
      return;
    }
    if (url.origin === new URL(baseURL).origin && url.pathname === "/api/bots") {
      await json(route, { agents: [] });
      return;
    }
    if (url.origin === new URL(baseURL).origin && url.pathname === "/api/youcai/chat-models") {
      await json(route, {
        models: [{ id: "mock-readonly-model", displayName: "只读验收模型" }],
        policy: { defaultModelId: "mock-readonly-model" },
      });
      return;
    }
    if (url.origin === new URL(baseURL).origin && url.pathname === "/api/conversations/history") {
      historyReads.push(url.pathname + url.search);
      if (url.searchParams.get("id") === conversationId) {
        await json(route, {
          conversation: {
            id: conversationId,
            agent_id: "__manga_workbench__",
            title: "零付费输出验收",
            last_message: "零付费输出验收",
            created_at: createdAt,
            updated_at: createdAt,
            messages: [{
              id: "assistant-zero-cost-fixture",
              role: "assistant",
              content: assistantMarkdown,
              created_at: createdAt,
            }],
          },
        });
      } else {
        await json(route, {
          conversations: [{
            id: conversationId,
            agent_id: "__manga_workbench__",
            title: "零付费输出验收",
            last_message: "零付费输出验收",
            created_at: createdAt,
            updated_at: createdAt,
          }],
        });
      }
      return;
    }

    await route.continue();
  });

  try {
    const response = await page.goto(targetURL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert.ok(response && response.ok(), `目标页响应异常：${response?.status() ?? "no response"}`);
    assert.equal(new URL(page.url()).pathname, targetPath, "首次渲染后路由发生变化");

    const firstAudit = await assertRenderedOutput(page);
    assert.equal(new URL(page.url()).pathname, targetPath, "输出渲染后路由发生变化");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    const refreshedAudit = await assertRenderedOutput(page);
    assert.equal(new URL(page.url()).pathname, targetPath, "刷新恢复历史后路由发生变化");

    assert.ok(historyReads.some((path) => path === "/api/conversations/history"), "未读取会话列表");
    assert.ok(
      historyReads.some((path) => path.includes(`id=${conversationId}`)),
      "未读取指定会话历史",
    );
    assert.deepEqual(writeAttempts, [], "零付费验收期间不应发起任何 POST/PUT/PATCH/DELETE");
    assert.deepEqual(pageErrors, [], `页面异常：${pageErrors.join(" | ")}`);

    const evidence = {
      ok: true,
      targetURL,
      finalURL: page.url(),
      fixture: {
        source: "read-only mocked conversation history",
        assistantMessageId: "assistant-zero-cost-fixture",
        heading: "零付费输出验收",
        listItems: 2,
        language: "json",
      },
      firstAudit,
      refreshedAudit,
      historyReads,
      forbiddenOutputButtons: { send: 0, pushImage: 0 },
      writeAttempts,
      modelRequests: 0,
      pageErrors,
      consoleErrors,
    };
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
