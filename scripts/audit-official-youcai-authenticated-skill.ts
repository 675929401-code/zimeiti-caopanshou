import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const outputDir = path.resolve(".codex-artifacts", "20260824-official-skill-system");
const cdpEndpoint = "http://127.0.0.1:9333";

function sanitizeUrl(value: string) {
  const url = new URL(value);
  for (const name of ["token", "ticket", "code", "state", "access_token", "refresh_token"]) {
    if (url.searchParams.has(name)) url.searchParams.set(name, "[redacted]");
  }
  return url.toString();
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0];
  assert.ok(context, "未连接到受控官网测试窗口");
  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url().includes("youcai.art")) ?? pages[0];
  assert.ok(page, "受控窗口没有可用页面");

  const events: Array<{
    phase: "request" | "response";
    method: string;
    url: string;
    status?: number;
    postDataKeys?: string[];
  }> = [];
  page.on("request", (event) => {
    if (!event.url().includes("youcai.art/api/")) return;
    let postDataKeys: string[] | undefined;
    try {
      const postData = event.postDataJSON() as unknown;
      if (postData && typeof postData === "object" && !Array.isArray(postData)) {
        postDataKeys = Object.keys(postData as Record<string, unknown>);
      }
    } catch {
      // Never record raw request bodies or credentials.
    }
    events.push({
      phase: "request",
      method: event.method(),
      url: sanitizeUrl(event.url()),
      postDataKeys,
    });
  });
  page.on("response", (event) => {
    if (!event.url().includes("youcai.art/api/")) return;
    events.push({
      phase: "response",
      method: event.request().method(),
      url: sanitizeUrl(event.url()),
      status: event.status(),
    });
  });

  await page.goto("https://youcai.art/skills", { waitUntil: "networkidle", timeout: 60_000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const signedInBody = (await page.locator("body").innerText()).replace(/\s+/gu, " ");
  assert.match(signedInBody, /我的 Skill/u, "受控窗口未处于登录态 Skill 页面");
  await page.screenshot({ path: path.join(outputDir, "authenticated-skills-before.png"), fullPage: false });

  await page.getByText("商业广告脚本", { exact: true }).click();
  const dialog = page
    .locator('[role="dialog"]:visible')
    .filter({ hasText: "商业广告脚本" })
    .filter({ hasText: "/ad-script-master" })
    .first();
  await dialog.waitFor({ state: "visible" });
  const detailText = (await dialog.innerText()).replace(/\s+/gu, " ").trim();
  await page.screenshot({ path: path.join(outputDir, "authenticated-skill-detail.png"), fullPage: false });

  await dialog.getByRole("button", { name: "在对话中创作" }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1_200);
  const targetUrl = sanitizeUrl(page.url());
  const targetBody = (await page.locator("body").innerText()).replace(/\s+/gu, " ");
  const composerCandidates = await page.locator("textarea, [contenteditable=true]").evaluateAll((elements) => (
    elements.map((element) => ({
      tag: element.tagName.toLowerCase(),
      ariaLabel: element.getAttribute("aria-label"),
      placeholder: element.getAttribute("placeholder"),
      value: element instanceof HTMLTextAreaElement
        ? element.value
        : element.textContent,
    }))
  ));
  await page.screenshot({ path: path.join(outputDir, "authenticated-skill-to-agent.png"), fullPage: false });

  const report = {
    ok: true,
    capturedAt: new Date().toISOString(),
    source: "official authenticated page in a controlled browser session",
    action: "商业广告脚本 -> 在对话中创作",
    detailText,
    targetUrl,
    targetMarkers: {
      hasAgentHeading: /创作 Agent/u.test(targetBody),
      hasSkillCommand: /\/ad-script-master/u.test(targetBody),
      hasConversationHistory: /新对话/u.test(targetBody),
    },
    composerCandidates,
    networkEvents: events,
    safety: {
      messageSent: false,
      mediaGenerated: false,
      creditsSpentByThisAudit: 0,
      credentialsRecorded: false,
      rawConversationContentRecorded: false,
    },
  };
  fs.writeFileSync(
    path.join(outputDir, "authenticated-skill-to-agent-report.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

void main();
