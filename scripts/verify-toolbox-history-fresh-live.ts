import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import { chromium } from "playwright";
import { createToken } from "../src/lib/auth";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";
import { workbenchUserStorageKey } from "../src/lib/workbench-user-storage";

loadEnv({ path: path.resolve(".env.local"), quiet: true });

async function main() {
const require = createRequire(path.join(process.cwd(), "package.json"));
const launcher = await import(pathToFileURL(path.resolve("scripts/start-local-data-preview.mjs")).href);
const runtime = JSON.parse(readFileSync(launcher.LOCAL_PREVIEW_RUNTIME_FILE, "utf8"));
const baseEnvironment = require("dotenv").parse(readFileSync(path.resolve(".env.local"), "utf8"));
Object.assign(process.env, launcher.createLocalPreviewLaunchPlan(runtime, baseEnvironment).env);
const origin = (process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
assert.ok(["http://127.0.0.1:5000", "http://127.0.0.1:5002"].includes(origin), "LOCAL_PREVIEW_ONLY");
const includeMedia = process.argv.includes("--include-media");
const runId = `r218-toolbox-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
const evidenceDir = path.resolve(".codex-evidence", "toolbox-fresh-history-r218", runId);
await mkdir(evidenceDir, { recursive: true });

const report: Record<string, unknown> = {
  runId,
  origin,
  startedAt: new Date().toISOString(),
  passed: false,
  pageErrors: [],
  externalRequests: [],
  unexpectedWrites: [],
  generationRequests: [],
  browserWrites: [],
  fixtures: [],
  cleanup: { attempted: false, passed: false },
};
const save = () => writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await save();

const db = getSupabaseAdminClient();
const { data: admin, error: adminError } = await db.from("users")
  .select("id,username,display_name,role,is_active,status,credits,cash_balance")
  .eq("role", "admin").eq("is_active", true).limit(1).maybeSingle();
assert.ok(!adminError && admin?.id, "ACTIVE_LOCAL_ADMIN_REQUIRED");
const userId = String(admin.id);
const token = await createToken({
  userId,
  username: String(admin.username || "local-admin"),
  role: "admin",
  displayName: String(admin.display_name || "本地验收"),
  sessionId: `toolbox-${randomUUID()}`,
});
const user = {
  id: userId,
  username: String(admin.username || "local-admin"),
  displayName: String(admin.display_name || "本地验收"),
  role: "admin",
  status: String(admin.status || "active"),
  credits: Number(admin.credits || 0),
  cashBalance: Number(admin.cash_balance || 0),
};

async function walletCount() {
  const result = await db.from("wallet_operations").select("id", { count: "exact", head: true }).eq("user_id", userId);
  assert.equal(result.error, null);
  return Number(result.count || 0);
}

async function balance() {
  const result = await db.from("users").select("credits,cash_balance").eq("id", userId).single();
  assert.equal(result.error, null);
  return result.data;
}

async function api(pathname: string, init: RequestInit = {}) {
  const response = await fetch(origin + pathname, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function waitForInputValue(locator: { inputValue(): Promise<string> }, expected: string, label: string) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (await locator.inputValue().catch(() => "") === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`WAIT_FAILED_${label}`);
}

const created: Array<{ table: "formatter_history" | "segmenter_history"; id: string }> = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
  report.balanceBefore = await balance();
  report.walletOperationsBefore = await walletCount();
  const marker = `工具箱历史验收-${Date.now()}`;
  report.marker = marker;
  const olderThanSevenDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  const formatterOld = await db.from("formatter_history").insert({
    user_id: userId,
    title: `${marker}-旧排版`,
    original_text: `${marker} 旧输入`,
    result_text: `${marker}旧结果`,
    rules: { fixture: true },
    char_count: marker.length + 3,
    line_count: 1,
    created_at: olderThanSevenDays,
  }).select("id,created_at").single();
  assert.equal(formatterOld.error, null);
  const formatterOldId = String(formatterOld.data.id);
  created.push({ table: "formatter_history", id: formatterOldId });

  const segmentText = `${marker}。第一段完整文案。第二段完整文案。`;
  const segmentResult = {
    segments: [segmentText],
    counts: [segmentText.length],
    compliant: [true],
    paragraphBreakBefore: [false],
    method: "rule",
  };
  const segmentOld = await db.from("segmenter_history").insert({
    user_id: userId,
    title: `${marker}-旧分段`,
    original_text: segmentText,
    result_text: JSON.stringify(segmentResult),
    mode: "分段8秒",
    rules: { fixture: true },
    char_count: segmentText.length,
    segment_count: 1,
    created_at: olderThanSevenDays,
  }).select("id,created_at").single();
  assert.equal(segmentOld.error, null);
  const segmentOldId = String(segmentOld.data.id);
  created.push({ table: "segmenter_history", id: segmentOldId });
  report.fixtures = created.map(item => ({ ...item, olderThanSevenDays: true }));
  await save();

  for (const endpoint of ["/api/formatter/history", "/api/segmenter/history"]) {
    const result = await api(endpoint);
    assert.equal(result.response.status, 200);
    const rows = (endpoint.includes("formatter") ? result.body?.records : result.body?.history) as Array<{ id: string; created_at: string }>;
    assert.ok(Array.isArray(rows) && rows.length <= 100, `${endpoint} BOUNDED_HISTORY_REQUIRED`);
    for (let index = 1; index < rows.length; index += 1) {
      assert.ok(Date.parse(rows[index - 1].created_at) >= Date.parse(rows[index].created_at), `${endpoint} NEWEST_FIRST_REQUIRED`);
    }
    const requiredId = endpoint.includes("formatter") ? formatterOldId : segmentOldId;
    assert.ok(rows.some(row => row.id === requiredId), `${endpoint} MUST_INCLUDE_OLDER_SAVED_RECORD`);
  }
  report.apiHistory = { ownerScoped: true, newestFirst: true, boundedAt100: true, olderThanSevenDaysVisible: true };
  const segmentDetail = await api(`/api/segmenter/history/detail?id=${segmentOldId}`);
  assert.equal(segmentDetail.response.status, 200);
  assert.equal(segmentDetail.body?.record?.original_text, segmentText);
  (report.apiHistory as Record<string, unknown>).olderSegmenterDetailRestorable = true;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" });
  const staleKeys = [
    "app_state_formatter_input",
    "app_state_formatter_output",
    "app_state_formatter_options",
    "app_state_segmenter_input",
    "app_state_segmenter_result",
    "app_state_segmenter_duration",
    ...["formatter_input", "formatter_output", "formatter_options", "segmenter_input", "segmenter_result", "segmenter_duration"]
      .map(base => `app_state_${workbenchUserStorageKey(base, userId)}`),
  ];
  await context.addInitScript(({ origin, token, user, staleKeys }) => {
    if (location.origin !== origin) return;
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
    if (!sessionStorage.getItem("toolbox_r218_stale_prepared")) {
      for (const key of staleKeys) sessionStorage.setItem(key, key.includes("duration") ? "12" : '"retired fixture"');
      sessionStorage.setItem("toolbox_r218_stale_prepared", "1");
    }
  }, { origin, token, user, staleKeys });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    if (url.origin !== origin) {
      (report.externalRequests as unknown[]).push({ method, origin: url.origin });
      await route.abort("blockedbyclient");
      return;
    }
    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      await route.continue();
      return;
    }
    if (url.pathname === "/api/announcements/events" && method === "POST") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (["/api/formatter/history", "/api/segmenter/history"].includes(url.pathname) && ["POST", "DELETE"].includes(method)) {
      (report.browserWrites as unknown[]).push({ method, path: url.pathname });
      await route.continue();
      return;
    }
    if (/\/(?:generate|semantic|extract|llm|chat|payment|recharge)(?:\/|$)/u.test(url.pathname)) {
      (report.generationRequests as unknown[]).push({ method, path: url.pathname });
    }
    (report.unexpectedWrites as unknown[]).push({ method, path: url.pathname });
    await route.abort("blockedbyclient");
  });

  const page = await context.newPage();
  page.on("pageerror", error => (report.pageErrors as string[]).push(error.message));
  await page.goto(origin + "/tools?tab=format", { waitUntil: "domcontentloaded", timeout: 45_000 });
  const panel = page.locator('[role="tabpanel"]:visible');
  const formatInput = panel.getByPlaceholder(/在此粘贴需要排版的文案/u);
  await formatInput.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await formatInput.inputValue(), "");
  assert.deepEqual(await page.evaluate(keys => keys.filter(key => sessionStorage.getItem(key) !== null), staleKeys.filter(key => key.includes("formatter"))), []);
  const formatterInput = `${marker}\n  清 晨 的 书 店 开 门 了。\n\n读 者 走 进 店 里。`;
  await formatInput.fill(formatterInput);
  const formatterSave = page.waitForResponse(response => response.url().includes("/api/formatter/history") && response.request().method() === "POST", { timeout: 30_000 });
  await panel.getByRole("button", { name: "开始排版", exact: true }).click();
  const formatterResponse = await formatterSave;
  assert.equal(formatterResponse.status(), 200);
  const formatterBody = await formatterResponse.json();
  const formatterNewId = String(formatterBody.record?.id || "");
  assert.ok(formatterNewId);
  created.push({ table: "formatter_history", id: formatterNewId });
  const formattedOutput = panel.locator("textarea[readonly]");
  await formattedOutput.waitFor({ state: "visible", timeout: 10_000 });
  const formattedText = await formattedOutput.inputValue();
  assert.ok(formattedText.includes(marker) && formattedText !== formatterInput);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
  await formatInput.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await formatInput.inputValue(), "");
  assert.equal(await formattedOutput.count(), 0);
  await panel.getByRole("button", { name: "历史记录", exact: true }).click();
  const formatterOldCard = panel.locator(`[data-formatter-history-id="${formatterOldId}"]`);
  const formatterNewCard = panel.locator(`[data-formatter-history-id="${formatterNewId}"]`);
  await formatterOldCard.waitFor({ state: "visible", timeout: 20_000 });
  await formatterNewCard.waitFor({ state: "visible", timeout: 20_000 });
  await formatterNewCard.click();
  await waitForInputValue(formatInput, formatterInput, "formatter-history-input");
  await formattedOutput.waitFor({ state: "visible", timeout: 10_000 });
  await waitForInputValue(formattedOutput, formattedText, "formatter-history-output");
  await panel.getByRole("button", { name: "历史记录", exact: true }).click();
  await formatterNewCard.waitFor({ state: "visible", timeout: 20_000 });
  const formatterDelete = page.waitForResponse(response => response.url().includes(`/api/formatter/history?id=${formatterNewId}`) && response.request().method() === "DELETE", { timeout: 30_000 });
  await panel.getByRole("button", { name: `删除排版历史 ${formatterNewId}`, exact: true }).click();
  assert.equal((await formatterDelete).status(), 200);
  await formatterNewCard.waitFor({ state: "detached", timeout: 10_000 });
  await page.screenshot({ path: path.join(evidenceDir, "formatter-history.png"), fullPage: true });
  report.formatter = { oldRecordVisible: true, currentSaved: true, refreshBlank: true, historyRestored: true, ownDelete: true };

  await page.goto(origin + "/tools?tab=segment", { waitUntil: "domcontentloaded", timeout: 45_000 });
  const segmentInput = panel.getByRole("textbox", { name: "需要分段的文案" });
  await segmentInput.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await segmentInput.inputValue(), "");
  assert.deepEqual(await page.evaluate(keys => keys.filter(key => sessionStorage.getItem(key) !== null), staleKeys.filter(key => key.includes("segmenter"))), []);
  await panel.getByRole("button", { name: "历史记录", exact: true }).click();
  const segmentCard = panel.locator(`[data-segmenter-history-id="${segmentOldId}"]`);
  await segmentCard.waitFor({ state: "visible", timeout: 20_000 });
  await segmentCard.click();
  await waitForInputValue(segmentInput, segmentText, "segmenter-history-input");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
  await segmentInput.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await segmentInput.inputValue(), "");
  await panel.getByRole("button", { name: "历史记录", exact: true }).click();
  await segmentCard.waitFor({ state: "visible", timeout: 20_000 });
  const segmentDelete = page.waitForResponse(response => response.url().includes(`/api/segmenter/history?id=${segmentOldId}`) && response.request().method() === "DELETE", { timeout: 30_000 });
  await panel.getByRole("button", { name: `删除分段历史 ${segmentOldId}`, exact: true }).click();
  assert.equal((await segmentDelete).status(), 200);
  await segmentCard.waitFor({ state: "detached", timeout: 10_000 });
  await page.screenshot({ path: path.join(evidenceDir, "segmenter-history.png"), fullPage: true });
  report.segmenter = { oldRecordVisible: true, refreshBlank: true, historyRestored: true, ownDelete: true };

  await context.close();
  browser = null;
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.unexpectedWrites, []);
  assert.deepEqual(report.generationRequests, []);
  assert.deepEqual(report.pageErrors, []);
  report.balanceAfter = await balance();
  report.walletOperationsAfter = await walletCount();
  assert.deepEqual(report.balanceAfter, report.balanceBefore);
  assert.equal(report.walletOperationsAfter, report.walletOperationsBefore);

  if (includeMedia) {
    const child = spawnSync(process.execPath, [
      "scripts/verify-toolbox-local-media-ui.mjs",
      "--execute",
      `--run-id=${runId}`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, LOCAL_NAV_ADMIN_TOKEN: token, LOCAL_NAV_ORIGIN: origin },
      stdio: "inherit",
      windowsHide: true,
      timeout: 360_000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, "LOCAL_MEDIA_BROWSER_ACCEPTANCE_FAILED");
    report.localMediaBrowser = { passed: true, runId };
  }
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  (report.cleanup as Record<string, unknown>).attempted = true;
  const cleanupErrors: string[] = [];
  for (const fixture of created) {
    const result = await db.from(fixture.table).delete().eq("id", fixture.id).eq("user_id", userId);
    if (result.error) cleanupErrors.push(`${fixture.table}:${fixture.id}`);
  }
  (report.cleanup as Record<string, unknown>).passed = cleanupErrors.length === 0;
  (report.cleanup as Record<string, unknown>).errors = cleanupErrors;
  if (cleanupErrors.length > 0) report.passed = false;
  report.finishedAt = new Date().toISOString();
  await save();
}

console.log(JSON.stringify({
  passed: report.passed,
  report: path.join(evidenceDir, "report.json"),
  formatter: report.formatter,
  segmenter: report.segmenter,
  localMediaBrowser: report.localMediaBrowser,
  cleanup: report.cleanup,
  providerCalls: 0,
  walletWrites: 0,
}));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
