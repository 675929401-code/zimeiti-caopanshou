#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9) || "";
const projectId = process.argv.find((value) => value.startsWith("--project-id="))?.slice(13) || "";
assert.equal(origin, "http://127.0.0.1:5000");
assert.match(runId, /^[A-Za-z0-9_-]{8,100}$/u);
assert.match(projectId, /^[A-Za-z0-9:_-]{8,160}$/u);
assert.ok(token);

const outputDir = path.resolve(".codex-evidence/storyboard-network-audit-20260920", runId);
await fs.mkdir(outputDir, { recursive: true });
const identityResponse = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
const identity = await identityResponse.json();
assert.ok(identityResponse.ok && identity.user?.role === "admin");
const projectResponse = await fetch(`${origin}/api/storyboard/projects?id=${encodeURIComponent(projectId)}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const projectPayload = await projectResponse.json();
assert.ok(projectResponse.ok && projectPayload?.project?.document?.cards?.[0]?.videoTaskId);
const taskId = projectPayload.project.document.cards[0].videoTaskId;
const ticketResponse = await fetch(`${origin}/api/video/access-ticket?${new URLSearchParams({ taskId, scope: "playback" })}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const ticketPayload = await ticketResponse.json();
assert.ok(ticketResponse.ok && ticketPayload?.url);
const playbackResponse = await fetch(new URL(ticketPayload.url, origin), {
  headers: { Range: "bytes=0-65535" },
  redirect: "manual",
  signal: AbortSignal.timeout(30_000),
});
const playbackProbe = {
  status: playbackResponse.status,
  contentType: playbackResponse.headers.get("content-type") || "",
  redirectHost: playbackResponse.headers.get("location")
    ? new URL(playbackResponse.headers.get("location"), origin).hostname
    : "",
  error: playbackResponse.status >= 400 ? String((await playbackResponse.json().catch(() => null))?.error || "") : "",
};

const browser = await chromium.launch({ headless: true });
const failures = [];
const requestFailures = [];
const consoleErrors = [];
const mediaRequests = [];
let blockedWrites = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.route("**/*", async (route) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(route.request().method())) {
      blockedWrites += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("request", (request) => {
    if (request.resourceType() !== "media") return;
    const url = new URL(request.url());
    mediaRequests.push({ origin: url.origin, path: url.pathname });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    failures.push({ status: response.status(), method: response.request().method(), origin: url.origin, path: url.pathname });
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    requestFailures.push({ method: request.method(), origin: url.origin, path: url.pathname, error: request.failure()?.errorText || "" });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    consoleErrors.push({ text: message.text().slice(0, 400), source: location.url ? new URL(location.url).pathname : "" });
  });
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const historyResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/video/history" && url.searchParams.get("surface") === "storyboard-workbench";
  }, { timeout: 45_000 });
  await page.getByRole("button", { name: "最近任务", exact: true }).first().click();
  await historyResponsePromise;
  const historyCards = page.locator("[data-video-history-task]");
  await historyCards.first().waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  const historyGallery = {
    cards: await historyCards.count(),
    playButtons: await page.getByRole("button", { name: /^播放 /u }).count(),
    mountedVideos: await historyCards.locator("video").count(),
    mediaRequestsBeforeProjectRestore: mediaRequests.length,
  };
  assert.ok(historyGallery.playButtons > 0, "completed history must expose click-to-play controls");
  assert.equal(historyGallery.mountedVideos, 0, "history drawer must not eagerly mount video players");
  assert.equal(historyGallery.mediaRequestsBeforeProjectRestore, 0, "opening history must not request video bytes");
  const project = page.locator(`[data-storyboard-project-id="${projectId}"]`);
  await project.waitFor({ state: "visible", timeout: 45_000 });
  await project.getByRole("button", { name: "打开任务", exact: true }).click();
  const card = page.locator("article.sbw-shot-card").first();
  await card.getByRole("img", { name: "镜头1故事板" }).waitFor({ state: "visible", timeout: 45_000 });
  await card.locator("video").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(8_000);
  const grouped = Object.values(failures.reduce((accumulator, failure) => {
    const key = `${failure.status} ${failure.method} ${failure.origin}${failure.path}`;
    accumulator[key] ||= { ...failure, count: 0 };
    accumulator[key].count += 1;
    return accumulator;
  }, {}));
  const report = { runId, checkedAt: new Date().toISOString(), projectId, taskId, playbackProbe, historyGallery, blockedWrites, failures: grouped, requestFailures, consoleErrors, mediaRequests };
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ runId, playbackProbe, historyGallery, blockedWrites, failures: grouped, requestFailures: requestFailures.length, report: path.join(outputDir, "report.json") }));
} finally {
  await browser.close();
}
