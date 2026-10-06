import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const outputDir = path.resolve(
  ".codex-screenshots",
  `manga-agent-visual-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);

async function createLocalSession() {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("users")
    .select("id, username, display_name, credits, cash_balance")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) throw new Error(error?.message || "找不到本地验收账号");

  const user = {
    id: String(data.id),
    username: String(data.username),
    displayName: String(data.display_name || "本地验收"),
    role: "admin" as const,
    credits: Number(data.credits || 0),
    cashBalance: Number(data.cash_balance || 0),
  };
  const token = await createToken({
    userId: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    sessionId: `manga-agent-visual-${randomUUID()}`,
  });
  return { token, user };
}

async function inspectPage(page: Page, label: "desktop" | "mobile", navigate = true) {
  if (navigate) {
    await page.goto(`${baseUrl}/youcai/tools/text/text-chat`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }
  await page.waitForSelector('[data-testid="official-agent-page"]', { timeout: 30_000 });
  await page.waitForTimeout(900);

  const firstConversation = page
    .locator("button")
    .filter({ hasText: /新创作对话|漫剧创作|创作 Agent/ })
    .filter({ hasNotText: "新对话" })
    .first();
  if (await firstConversation.isVisible().catch(() => false)) {
    await firstConversation.click();
    await page.waitForTimeout(700);
  }

  const textarea = page.locator("form textarea").first();
  if (await textarea.isVisible().catch(() => false)) {
    await textarea.focus();
    await page.waitForTimeout(120);
  }

  const screenshot = path.join(outputDir, `${label}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });

  const metrics = await page.evaluate(() => {
    const selectors = {
      bubble: '[data-message-status] > div > div',
      assistantBubble: '[data-role="assistant"] > div > div',
      userBubble: '[data-role="user"] > div > div',
      markdown: '[data-message-status] .markdown-body',
      finalLayer: '[data-message-status] .render-layer-final',
      streamingLayer: '[data-message-status] .render-layer-streaming',
      composer: 'form textarea',
      composerShell: 'form',
    } as const;
    const styles: Record<string, unknown> = {};
    for (const [key, selector] of Object.entries(selectors)) {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        styles[key] = null;
        continue;
      }
      const style = getComputedStyle(element);
      styles[key] = {
        selector,
        color: style.color,
        background: style.backgroundColor,
        opacity: style.opacity,
        filter: style.filter,
        textShadow: style.textShadow,
        boxShadow: style.boxShadow,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        outline: `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
        outlineOffset: style.outlineOffset,
        rect: {
          width: Math.round(element.getBoundingClientRect().width),
          height: Math.round(element.getBoundingClientRect().height),
        },
      };
    }

    return {
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      bodyTextLength: document.body.innerText.length,
      messageBubbleCount: document.querySelectorAll('[data-message-status] .markdown-body').length,
      styles,
    };
  });

  return { label, screenshot, metrics };
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const session = await createLocalSession();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, session);
    const page = await context.newPage();
    const desktop = await inspectPage(page, "desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    const mobile = await inspectPage(page, "mobile", false);
    await context.close();

    const results = [desktop, mobile];
    const failures: string[] = [];
    for (const result of results) {
      const metrics = result.metrics as {
        horizontalOverflow: number;
        styles: Record<string, null | {
          opacity: string;
          filter: string;
          textShadow: string;
          boxShadow: string;
          outline: string;
        }>;
      };
      if (metrics.horizontalOverflow !== 0) failures.push(`${result.label}: 页面存在横向溢出`);

      const composer = metrics.styles.composer;
      if (!composer) failures.push(`${result.label}: 未找到输入框`);
      else {
        if (!composer.outline.startsWith("0px none")) failures.push(`${result.label}: 输入框仍有独立焦点描边`);
        if (composer.boxShadow !== "none") failures.push(`${result.label}: 输入框仍有独立焦点阴影`);
      }

      const assistant = metrics.styles.assistantBubble;
      if (assistant) {
        if (assistant.opacity !== "1") failures.push(`${result.label}: Agent 消息透明度不是 1`);
        if (assistant.filter !== "none") failures.push(`${result.label}: Agent 消息仍带滤镜`);
        if (assistant.textShadow !== "none") failures.push(`${result.label}: Agent 消息仍带文字阴影`);
        if (assistant.boxShadow !== "none") failures.push(`${result.label}: Agent 消息仍带外阴影`);
      }
    }

    const report = { ok: failures.length === 0, outputDir, failures, results };
    fs.writeFileSync(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
