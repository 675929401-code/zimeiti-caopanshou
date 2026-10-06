#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.R267_CUSTOMER_TOKEN || "").trim();
const passiveTelemetryPaths = new Set(["/api/announcements/events", "/api/diagnostic-logs"]);
const outputArgument = process.argv.find((value) => value.startsWith("--output="));
const output = outputArgument ? path.resolve(process.cwd(), outputArgument.slice("--output=".length)) : "";

const routes = [
  { path: "/", label: "应用广场", texts: ["应用广场", "工具箱", "视频制作", "分镜工作台", "AI生图工作台", "智音工坊", "封面制作", "带货 Agent"] },
  { path: "/tools", label: "工具箱", texts: ["短视频内容工具", "文案提取", "视频提取", "文字排版", "智能分段"] },
  { path: "/video", label: "视频制作", texts: ["视频模型"], productionControl: "select,button[role='combobox']" },
  { path: "/storyboard-workbench", label: "分镜工作台", texts: ["分镜工作台"], productionControl: ".sbw-image-model-list button,.sbw-video-model-list button" },
  { path: "/image-workbench", label: "AI生图工作台", texts: ["AI生图工作台"], productionControl: "#image-workbench-model" },
  { path: "/voice-studio/workspace", label: "智音工坊", texts: ["智音工坊"], productionControl: "select,button[role='combobox']" },
  { path: "/cover", label: "封面制作", texts: ["封面制作"], productionControl: "select,button[role='combobox']" },
];

export async function main() {
  assert.ok(token, "R267_CUSTOMER_TOKEN is required");
  const identityResponse = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const identity = await identityResponse.json();
  assert.equal(identityResponse.status, 200, "Customer identity must be available");
  assert.equal(identity?.user?.role, "student", "Acceptance must use an ordinary customer");

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    origin,
    userRole: "student",
    policy: { nonGetBlocked: true, passiveTelemetryBlocked: true, providerCalls: 0, paidCalls: 0, businessWrites: 0 },
    pages: [],
    pageErrors: [],
    consoleErrors: [],
    httpErrors: [],
    blockedRequests: [],
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    await context.addInitScript(({ authToken, authUser }) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.setItem("auth_user", JSON.stringify(authUser));
      sessionStorage.setItem("entered_app", "1");
    }, { authToken: token, authUser: identity.user });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const diagnostic = request.method() === "POST" && requestUrl.pathname === "/__nextjs_original-stack-frames";
      if (request.method() !== "GET" && !diagnostic) {
        evidence.blockedRequests.push({
          method: request.method(),
          path: requestUrl.pathname,
          classification: passiveTelemetryPaths.has(requestUrl.pathname) ? "passive_telemetry" : "business_write",
        });
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();
    page.on("pageerror", (error) => evidence.pageErrors.push({ page: new URL(page.url()).pathname, name: error.name }));
    page.on("response", (response) => {
      if (response.status() >= 400) evidence.httpErrors.push({
        page: new URL(page.url()).pathname,
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
    });
    page.on("console", (message) => {
      if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) {
        evidence.consoleErrors.push({ page: new URL(page.url()).pathname, text: message.text().slice(0, 300) });
      }
    });

    for (const item of routes) {
      const response = await page.goto(`${origin}${item.path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.ok(response?.ok(), `${item.label} page must return HTTP 2xx`);
      await page.waitForFunction((requiredTexts) => requiredTexts.every((text) => document.body.innerText.includes(text)), item.texts, { timeout: 30_000 });
      if (item.productionControl) {
        await page.locator(item.productionControl).first().waitFor({ state: "visible", timeout: 30_000 });
      }
      const result = await page.evaluate(({ expectedTexts, productionControl }) => {
        const body = document.body.innerText;
        const controls = productionControl ? [...document.querySelectorAll(productionControl)] : [];
        return {
          currentPath: window.location.pathname,
          textChecks: Object.fromEntries(expectedTexts.map((text) => [text, body.includes(text)])),
          applicationErrorVisible: /Application error: a client-side exception|Internal Server Error|应用程序错误/u.test(body),
          accessDeniedVisible: /无权访问|仅管理员可访问/u.test(body),
          horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          productionControlCount: productionControl ? controls.filter((control) => !control.hasAttribute("disabled") && control.getAttribute("data-disabled") === null).length : undefined,
        };
      }, { expectedTexts: item.texts, productionControl: item.productionControl || "" });
      assert.equal(result.applicationErrorVisible, false, `${item.label} must not show an application error`);
      assert.equal(result.accessDeniedVisible, false, `${item.label} must be accessible to an ordinary customer`);
      assert.equal(result.horizontalOverflowPx, 0, `${item.label} must not overflow horizontally at 1440px`);
      if (item.productionControl) assert.ok(result.productionControlCount > 0, `${item.label} must expose an enabled model or production control`);
      evidence.pages.push({ label: item.label, path: item.path, ...result });
    }

    assert.equal(evidence.pageErrors.length, 0, "Stage-one pages must not emit page errors");
    const businessWrites = evidence.blockedRequests.filter((request) => request.classification === "business_write");
    assert.deepEqual(businessWrites, [], `Read-only traversal attempted business writes: ${JSON.stringify(businessWrites)}`);
    evidence.ok = true;
  } finally {
    await browser.close();
  }

  if (output) {
    const evidenceRoot = `${path.resolve(process.cwd(), ".codex-evidence")}${path.sep}`;
    assert.ok(output.startsWith(evidenceRoot), "Output must stay in .codex-evidence");
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  }
  console.log(JSON.stringify(evidence, null, 2));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
