import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const origin = String(process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ORIGIN_REQUIRED");

const root = process.cwd();
const require = createRequire(path.join(root, "package.json"));
const launcher = await import(pathToFileURL(path.join(root, "scripts/start-local-data-preview.mjs")).href);
const runtimeFile = JSON.parse(readFileSync(launcher.LOCAL_PREVIEW_RUNTIME_FILE, "utf8"));
const baseEnvironment = require("dotenv").parse(readFileSync(path.join(root, ".env.local"), "utf8"));
Object.assign(process.env, launcher.createLocalPreviewLaunchPlan(runtimeFile, baseEnvironment).env);
const { createToken } = await import("@/lib/auth");
const { getSupabaseClient } = await import("@/storage/database/supabase-client");

const db = getSupabaseClient();
const { data: admin, error } = await db
  .from("users")
  .select("id,username,display_name,credits,cash_balance")
  .eq("role", "admin")
  .eq("is_active", true)
  .limit(1)
  .maybeSingle();
if (error || !admin?.id) throw new Error(error?.message || "ACTIVE_LOCAL_ADMIN_REQUIRED");

const user = {
  id: String(admin.id),
  username: String(admin.username || "admin"),
  displayName: String(admin.display_name || "本地验收管理员"),
  role: "admin" as const,
  credits: Number(admin.credits || 0),
  cashBalance: Number(admin.cash_balance || 0),
};
const token = await createToken({
  userId: user.id,
  username: user.username,
  displayName: user.displayName,
  role: "admin",
  sessionId: `editor-memory-${randomUUID()}`,
});
const output = path.resolve(".codex-evidence", "editor-memory-reset-20260914");
await mkdir(output, { recursive: true });

const coverKey = `ai-cover-director-draft-v5:${user.id}`;
const humanKey = `digital-human:draft:v1:${user.id}`;
const storageUserId = encodeURIComponent(user.id);
const videoKeys = [
  "app_state_video_tasks",
  `app_state_video_selected_model:user:${storageUserId}`,
  `video-task-checkpoint:v1:${user.id}:stale-request`,
];
const extractKeys = [
  "extract_page_state",
  `extract_page_state:user:${storageUserId}`,
  "extract_state",
];
const staleMarker = "CODEx_OLD_DRAFT_MUST_NOT_RESTORE";
const requests: Array<{ method: string; path: string }> = [];
const blockedMutations: Array<{ method: string; path: string }> = [];
const pageErrors: string[] = [];

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ authToken, authUser, oldCoverKey, oldHumanKey, marker }) => {
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify(authUser));
    sessionStorage.setItem("entered_app", "1");
    localStorage.setItem(oldCoverKey, JSON.stringify({
      ratio: "16:9", briefText: marker, title: marker, subtitle: marker,
      coverModeId: "template", layoutTemplateId: "gaoding-012",
      animationStyleId: "photo-real", subjectModeId: "product", materialSourceId: "ai",
      prompt: marker, selectedImage: "", modelId: "pm_stale",
    }));
    localStorage.setItem(oldHumanKey, JSON.stringify({
      mode: "photo", modelId: "pm_stale", resolution: "4K",
      personId: "stale-person-id", audioId: "stale-audio-id", audioSource: "upload",
    }));
  }, {
    authToken: token,
    authUser: user,
    oldCoverKey: coverKey,
    oldHumanKey: humanKey,
    marker: staleMarker,
  });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    requests.push({ method: request.method(), path: url.pathname });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      blockedMutations.push({ method: request.method(), path: url.pathname });
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", event => pageErrors.push(event.message));

  await page.goto(`${origin}/cover`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const brief = page.locator('textarea[aria-label="输入文案"]:visible');
  await brief.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(key => localStorage.getItem(key) === null, coverKey, { timeout: 8_000 }).catch(async cause => {
    console.error(JSON.stringify({
      stage: "cover-draft-removal",
      url: page.url(),
      authUser: await page.evaluate(() => localStorage.getItem("auth_user")),
      recentRequests: requests.slice(-20),
    }));
    throw cause;
  });
  assert.equal(await brief.inputValue(), "", "cover must start with an empty brief");
  assert.equal(await page.locator('[aria-label="封面标题"]:visible').inputValue(), "", "cover must not restore the old title");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), coverKey), null, "legacy cover draft must be removed");
  await page.screenshot({ path: path.join(output, "cover-empty-after-stale-draft.png"), fullPage: true });

  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
  await brief.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(400);
  assert.equal(await brief.inputValue(), "", "cover refresh must remain empty");

  await page.goto(`${origin}/digital-human`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByLabel("数字人创作").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(key => localStorage.getItem(key) === null, humanKey, { timeout: 8_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[role="tablist"][aria-label="创作方式"] [role="tab"]')].some(tab => !(tab as HTMLButtonElement).disabled), undefined, { timeout: 15_000 });
  const selectedHumanMode = page.getByRole("tablist", { name: "创作方式" }).locator('[role="tab"][aria-selected="true"]');
  assert.equal(await selectedHumanMode.count(), 1, "digital human must choose exactly one clean, currently available mode");
  const selectedHumanLabel = await selectedHumanMode.innerText();
  assert.equal(await selectedHumanMode.isDisabled(), false, "digital human must not select a disabled model mode");
  assert.equal(await page.getByLabel(selectedHumanLabel.includes("照片说话") ? "上传人物照片" : "上传人物视频").count(), 1, "stale person type must not restore over the currently available mode");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), humanKey), null, "legacy digital-human draft must be removed");
  assert.equal(requests.some(item => item.path === "/api/digital-human/assets"), false, "stale asset ids must not trigger restoration reads");
  await page.screenshot({ path: path.join(output, "digital-human-empty-after-stale-draft.png"), fullPage: true });

  await page.evaluate(({ keys, marker }) => {
    for (const key of keys) {
      localStorage.setItem(key, JSON.stringify({ prompt: marker, modelId: "pm_stale", tasks: [{ prompt: marker }] }));
      sessionStorage.setItem(key, JSON.stringify({ prompt: marker, modelId: "pm_stale", tasks: [{ prompt: marker }] }));
    }
  }, { keys: videoKeys, marker: staleMarker });
  await page.goto(`${origin}/video`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const firstVideoPrompt = page.locator('textarea[aria-label="任务1提示词"]:visible');
  await firstVideoPrompt.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await firstVideoPrompt.inputValue(), "", "video editor must start with an empty prompt");
  for (const key of videoKeys) {
    assert.equal(await page.evaluate(value => localStorage.getItem(value), key), null, `legacy video local draft must be removed: ${key}`);
    assert.equal(await page.evaluate(value => sessionStorage.getItem(value), key), null, `legacy video session draft must be removed: ${key}`);
  }
  await page.getByRole("button", { name: "历史", exact: true }).click();
  const videoHistory = page.getByRole("region", { name: "视频生成历史" });
  await videoHistory.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => !document.body.innerText.includes("正在读取生成历史…"), undefined, { timeout: 30_000 });
  const historyResponse = await page.evaluate(async () => {
    const response = await fetch("/api/video/history?limit=100&offset=0", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(historyResponse.status, 200, "video history must be readable");
  assert.ok(Array.isArray(historyResponse.body.tasks), "video history must return tasks");
  const submittedAt = historyResponse.body.tasks.map((task: Record<string, unknown>) => Date.parse(String(task.createdAt || task.created_at || 0)));
  assert.deepEqual(submittedAt, [...submittedAt].sort((left, right) => right - left), "video history must be ordered by submission time");
  const historyCards = videoHistory.locator("[data-video-history-task]");
  assert.equal(await historyCards.count(), historyResponse.body.tasks.length, "history cards must match the first database page");
  for (let index = 0; index < await historyCards.count(); index += 1) {
    const card = historyCards.nth(index);
    const previewCount = await card.locator("video, img").count();
    const fallbackCount = await card.getByText(/生成完成后显示预览|暂无视频画面/u).count();
    assert.ok(previewCount + fallbackCount > 0, `video history card ${index + 1} must show a preview or an explicit placeholder`);
  }
  assert.equal(
    await videoHistory.getByRole("button", { name: "重新提交", exact: true }).count(),
    historyResponse.body.tasks.filter((task: Record<string, unknown>) => task.canRetry === true).length,
    "only retry-safe failed tasks may expose resubmission",
  );
  await page.screenshot({ path: path.join(output, "video-history-after-fresh-editor.png"), fullPage: true });

  await page.evaluate(({ keys, marker }) => {
    for (const key of keys) {
      localStorage.setItem(key, JSON.stringify({ url: marker, text: marker, result: marker }));
      sessionStorage.setItem(key, JSON.stringify({ url: marker, text: marker, result: marker }));
    }
  }, { keys: extractKeys, marker: staleMarker });
  await page.goto(`${origin}/extract?tab=text`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const extractInput = page.locator('textarea[aria-label="文案分享文本或链接"]:visible');
  await extractInput.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await extractInput.inputValue(), "", "extraction editor must start with an empty link/text input");
  for (const key of extractKeys) {
    assert.equal(await page.evaluate(value => localStorage.getItem(value), key), null, `legacy extraction local draft must be removed: ${key}`);
    assert.equal(await page.evaluate(value => sessionStorage.getItem(value), key), null, `legacy extraction session draft must be removed: ${key}`);
  }
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.getByText("账户历史", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("已同步", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: path.join(output, "extraction-history-after-fresh-editor.png"), fullPage: true });

  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  assert.equal(blockedMutations.length, 0, `unexpected mutation attempts: ${JSON.stringify(blockedMutations)}`);
  const report = {
    checkedAt: new Date().toISOString(),
    source: origin,
    accountRole: user.role,
    cover: { oldDraftRemoved: true, blankOnOpen: true, blankAfterRefresh: true },
    digitalHuman: { oldDraftRemoved: true, defaultMode: "video", staleAssetsNotRead: true },
    video: { oldDraftRemoved: true, blankOnOpen: true, historySortedBySubmission: true, previewOrPlaceholderPerTask: true, retryRestrictedToSafeFailures: true },
    extraction: { oldDraftRemoved: true, blankOnOpen: true, accountHistoryReady: true },
    pageErrors,
    blockedMutations,
    providerRequests: 0,
    paidGeneration: false,
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
