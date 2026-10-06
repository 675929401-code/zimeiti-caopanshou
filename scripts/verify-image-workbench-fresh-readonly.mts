import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const origin = String(process.env.BASE_URL || process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ORIGIN_REQUIRED");

const root = process.cwd();
const require = createRequire(path.join(root, "package.json"));
const launcher = await import(pathToFileURL(path.join(root, "scripts/start-local-data-preview.mjs")).href);
const runtimeFile = JSON.parse(readFileSync(launcher.LOCAL_PREVIEW_RUNTIME_FILE, "utf8"));
const baseEnvironment = require("dotenv").parse(readFileSync(path.join(root, ".env.local"), "utf8"));
Object.assign(process.env, launcher.createLocalPreviewLaunchPlan(runtimeFile, baseEnvironment).env);
const { createToken } = await import("@/lib/auth");
const { BROWSER_IMAGE_ATTEMPT_TTL_MS } = await import("@/lib/image-workbench-attempt-guard");
const { getSupabaseClient } = await import("@/storage/database/supabase-client");

const db = getSupabaseClient();
const { data: admin, error } = await db.from("users")
  .select("id,username,display_name,credits,cash_balance")
  .eq("role", "admin").eq("is_active", true).limit(1).maybeSingle();
assert.ok(!error && admin?.id, error?.message || "ACTIVE_LOCAL_ADMIN_REQUIRED");
const user = {
  id: String(admin.id), username: String(admin.username), displayName: String(admin.display_name || "本地验收管理员"),
  role: "admin" as const, credits: Number(admin.credits || 0), cashBalance: Number(admin.cash_balance || 0),
};
const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim() || await createToken({
  userId: user.id,
  username: user.username,
  displayName: user.displayName,
  role: user.role,
  sessionId: `image-fresh-${randomUUID()}`,
});
const encodedUserId = encodeURIComponent(user.id);
const scopedJobsKey = `app_state_image_workbench_prompt_cards_v1:user:${encodedUserId}`;
const scopedHistoryKey = `image_workbench_history_v1:user:${encodedUserId}`;
const scopedExpiryKey = `image_workbench_draft_expiry_v1:user:${encodedUserId}`;
const retiredKeys = [
  scopedJobsKey, scopedHistoryKey, scopedExpiryKey,
  "image_workbench_prompt_cards_v1", "app_state_image_workbench_prompt_cards_v1",
  "image_workbench_history_v1", "image_workbench_draft_expiry_v1",
];
const staleDraftMarker = "CODEX_IMAGE_STALE_DRAFT_MUST_CLEAR";
const output = path.resolve(".codex-evidence", "image-workbench-fresh-readonly", new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(output, { recursive: true });

async function prepareContext(seed: "draft" | "unresolved") {
  const requests: Array<{ method: string; path: string }> = [];
  const blocked: Array<{ method: string; path: string }> = [];
  const external: string[] = [];
  const pageErrors: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ authToken, authUser, keys, jobsKey, historyKey, expiryKey, mode, attemptTtlMs }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify(authUser));
    sessionStorage.setItem("entered_app", "1");
    for (const key of keys) {
      localStorage.setItem(key, JSON.stringify([{ id: "retired", createdAt: 1, items: [] }]));
      sessionStorage.setItem(key, JSON.stringify([{ id: "retired", prompt: "CODEX_IMAGE_STALE_DRAFT_MUST_CLEAR", status: "idle" }]));
    }
    localStorage.setItem(historyKey, JSON.stringify([{ id: "retired-history", createdAt: 1, items: [] }]));
    sessionStorage.setItem(expiryKey, String(Date.now() + 600_000));
    sessionStorage.setItem(jobsKey, JSON.stringify(mode === "unresolved" ? [{
      schema: "image_workbench_attempt_reference.v1",
      id: "submitted-job",
      generationKey: "submitted-request-key",
      generationTraceId: "submitted-trace",
      expiresAt: Date.now() + attemptTtlMs,
    }] : [{ id: "ordinary-draft", prompt: "CODEX_IMAGE_STALE_DRAFT_MUST_CLEAR", status: "idle" }]));
  }, {
    authToken: token,
    authUser: user,
    keys: retiredKeys,
    jobsKey: scopedJobsKey,
    historyKey: scopedHistoryKey,
    expiryKey: scopedExpiryKey,
    mode: seed,
    attemptTtlMs: BROWSER_IMAGE_ATTEMPT_TTL_MS,
  });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort("blockedbyclient"); }
    requests.push({ method: request.method(), path: url.pathname });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      blocked.push({ method: request.method(), path: url.pathname });
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  return { context, requests, blocked, external, pageErrors };
}

const browser = await chromium.launch({ headless: true });
const report = {
  origin,
  draft: {} as Record<string, unknown>,
  unresolved: {} as Record<string, unknown>,
  providerRequests: 0,
  databaseWrites: 0,
  paidGeneration: false,
  passed: false,
};
try {
  {
    const run = await prepareContext("draft");
    const page = await run.context.newPage();
    page.on("pageerror", event => run.pageErrors.push(event.message));
    await page.goto(`${origin}/image-workbench`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const prompts = page.locator('textarea[aria-label^="第 "][aria-label$="张图片提示词"]:visible');
    await prompts.first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => document.body.innerText.includes("AI生图工作台"), undefined, { timeout: 20_000 });
    assert.equal(await prompts.count(), 4, "fresh editor must start with the default four cards");
    const openedValues = await prompts.evaluateAll(elements => elements.map(element => (element as HTMLTextAreaElement).value));
    assert.ok(openedValues.every(value => value === ""), "ordinary image drafts must not restore");
    assert.doesNotMatch(await page.locator("body").innerText(), new RegExp(staleDraftMarker), "stale draft leaked into UI");
    for (const key of retiredKeys) {
      assert.equal(await page.evaluate(value => localStorage.getItem(value), key), null, `retired local key survived: ${key}`);
      assert.equal(await page.evaluate(value => sessionStorage.getItem(value), key), null, `retired session key survived: ${key}`);
    }
    await prompts.first().fill("本次只测试刷新清空，不提交生成");
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), scopedJobsKey), null, "ordinary prompt must not be persisted");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    await prompts.first().waitFor({ state: "visible", timeout: 30_000 });
    const refreshedValues = await prompts.evaluateAll(elements => elements.map(element => (element as HTMLTextAreaElement).value));
    assert.ok(refreshedValues.every(value => value === ""), "image editor must reopen blank after refresh");
    assert.equal(run.blocked.length, 0, `opening/refreshing image workbench attempted writes: ${JSON.stringify(run.blocked)}`);
    assert.equal(run.external.length, 0, `opening/refreshing image workbench made external requests: ${JSON.stringify(run.external)}`);
    assert.equal(run.pageErrors.length, 0, run.pageErrors.join("\n"));
    report.draft = { oldDraftRemoved: true, oldHistoryCacheRemoved: true, blankOnOpen: true, noPromptPersistence: true, blankAfterRefresh: true, writeAttempts: 0, pageErrors: 0 };
    await page.screenshot({ path: path.join(output, "fresh-editor.png"), fullPage: false });
    await run.context.close();
  }
  {
    const run = await prepareContext("unresolved");
    const page = await run.context.newPage();
    page.on("pageerror", event => run.pageErrors.push(event.message));
    await page.goto(`${origin}/image-workbench`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const prompt = page.locator('textarea[aria-label="第 1 张图片提示词"]:visible');
    await prompt.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await prompt.inputValue(), "", "opaque attempt reference must never restore the original prompt");
    const stored = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || "[]"), scopedJobsKey) as Array<Record<string, unknown>>;
    assert.equal(stored.length, 1, "only the unresolved opaque attempt reference may remain in session storage");
    assert.deepEqual(
      Object.keys(stored[0] || {}).sort(),
      ["expiresAt", "generationKey", "generationTraceId", "id", "schema"],
      "browser attempt reference must contain only opaque reconciliation fields",
    );
    assert.equal(stored[0]?.schema, "image_workbench_attempt_reference.v1");
    assert.equal(stored[0]?.id, "submitted-job");
    assert.equal(stored[0]?.generationKey, "submitted-request-key");
    assert.equal(stored[0]?.generationTraceId, "submitted-trace");
    assert.ok(Number(stored[0]?.expiresAt) > Date.now(), "opaque attempt reference must retain a future expiry");
    const bodyText = await page.locator("body").innerText();
    assert.match(bodyText, /安全追踪编号|结果待确认/u, "unknown attempt must show an explicit reconciliation warning");
    assert.doesNotMatch(bodyText, /CODEX_IMAGE_SUBMITTED_RESULT_MUST_RECONCILE/u, "retired full prompt must not leak into the UI");
    assert.equal(run.requests.some(request => request.method === "POST" && request.path === "/api/image/generate"), false, "unknown attempt must not be submitted automatically");
    assert.equal(run.blocked.length, 0, `unresolved recovery view attempted writes: ${JSON.stringify(run.blocked)}`);
    assert.equal(run.external.length, 0, `unresolved recovery view made external requests: ${JSON.stringify(run.external)}`);
    assert.equal(run.pageErrors.length, 0, run.pageErrors.join("\n"));
    report.unresolved = { opaquePointerRetained: true, promptRestored: false, unknownWarningVisible: true, onlyOpaqueReferencePersisted: true, automaticResubmission: false, writeAttempts: 0, pageErrors: 0 };
    await page.screenshot({ path: path.join(output, "unresolved-reconciliation.png"), fullPage: false });
    await run.context.close();
  }
  report.passed = true;
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidenceDir: output }));
} finally {
  await browser.close();
}
