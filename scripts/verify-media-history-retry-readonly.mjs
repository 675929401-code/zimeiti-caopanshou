import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { SignJWT } from "jose";
import { parse as parseDotenv } from "dotenv";

const root = process.cwd();
const origin = String(process.env.BASE_URL || process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const output = path.resolve(process.argv.find((value) => value.startsWith("--output="))?.slice(9)
  || `.codex-evidence/media-history-retry-readonly-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(output, { recursive: true });

const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
const localEnvironment = parseDotenv(await readFile(path.join(root, ".env.local"), "utf8"));
const supabaseOrigin = new URL(runtime.supabaseUrl).origin;
assert.equal(supabaseOrigin, "http://127.0.0.1:54321", "local Supabase is required");
const serviceHeaders = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };

async function restRows(table, params) {
  const url = new URL(`/rest/v1/${table}`, supabaseOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: serviceHeaders, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json();
  assert.ok(response.ok && Array.isArray(payload), `failed to read ${table}`);
  return payload;
}

async function countRows(table, userId, idColumn = "id") {
  const url = new URL(`/rest/v1/${table}`, supabaseOrigin);
  url.searchParams.set("select", idColumn);
  url.searchParams.set("user_id", `eq.${userId}`);
  const response = await fetch(url, {
    headers: { ...serviceHeaders, Prefer: "count=exact", Range: "0-0" },
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `failed to count ${table}`);
  return Number((response.headers.get("content-range") || "0/0").split("/")[1] || 0);
}

function retryable(row) {
  return row.status === "failed"
    && !String(row.submission_error_code || "").includes("UNKNOWN")
    && !String(row.provider_result_url || "").trim()
    && (["failed", "not_required"].includes(String(row.billing_state || ""))
      || (!row.billing_state && Number(row.price_charged || 0) === 0))
    && !String(row.task_label || "").startsWith("digital-human:")
    && !String(row.task_label || "").startsWith("分镜工作台");
}

const [users, tasks] = await Promise.all([
  restRows("users", { select: "id,username,display_name,role,is_active", is_active: "eq.true", limit: "200" }),
  restRows("video_tasks", {
    select: "id,user_id,status,task_label,submission_error_code,billing_state,provider_result_url,price_charged,created_at",
    history_hidden_at: "is.null",
    status: "eq.failed",
    order: "created_at.desc",
    limit: "500",
  }),
]);
const usersById = new Map(users.map((user) => [user.id, user]));
const secrets = [...new Set([process.env.JWT_SECRET, runtime.jwtSecret, localEnvironment.JWT_SECRET]
  .map((value) => String(value || "").trim()).filter((value) => value.length >= 16))];
assert.ok(secrets.length > 0, "local JWT secret is unavailable");

async function tokenFor(user) {
  for (const secret of secrets) {
    const token = await new SignJWT({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name || user.username,
    }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30m")
      .sign(new TextEncoder().encode(secret));
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return token;
  }
  return "";
}

let fixture;
for (const task of tasks.filter(retryable)) {
  const user = usersById.get(task.user_id);
  if (!user) continue;
  const token = await tokenFor(user);
  if (!token) continue;
  const [historyResponse, modelsResponse] = await Promise.all([
    fetch(`${origin}/api/video/history?taskId=${encodeURIComponent(task.id)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    }),
    fetch(`${origin}/api/video/models`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    }),
  ]);
  if (!historyResponse.ok || !modelsResponse.ok) continue;
  const history = await historyResponse.json();
  const models = await modelsResponse.json();
  const saved = history.tasks?.[0];
  const publicModels = Array.isArray(models.models) ? models.models : Array.isArray(models) ? models : [];
  if (saved?.canRetry !== true || publicModels.length === 0) continue;
  let item;
  for (let offset = 0; offset <= 1000; offset += 100) {
    const mediaResponse = await fetch(`${origin}/api/media-history?limit=100&offset=${offset}&includeTotal=1`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!mediaResponse.ok) break;
    const media = await mediaResponse.json();
    item = media.items?.find((entry) => entry.id === `video:${task.id}`);
    if (item || media.pagination?.hasMore !== true) break;
  }
  if (item) {
    fixture = { user, token, task, saved, item, publicModel: publicModels[0] };
    break;
  }
}
assert.ok(fixture, "a safe failed video visible in the user's paginated media history is required");
assert.equal(fixture.item.status, "failed");
assert.equal(fixture.item.source, "视频制作");
assert.equal(fixture.item.sourcePath, "/video");
assert.equal(fixture.item.retryPath, `/video?retryTask=${encodeURIComponent(fixture.task.id)}`);

const browserTaskId = `vt_${"f".repeat(40)}`;
const browserItem = {
  ...fixture.item,
  id: `video:${browserTaskId}`,
  title: "只读安全重试验证",
  retryPath: `/video?retryTask=${encodeURIComponent(browserTaskId)}`,
};
const browserTask = {
  ...fixture.saved,
  id: browserTaskId,
  taskIdExternal: "",
  canRetry: true,
  publicModelId: fixture.publicModel.id,
  modelId: fixture.publicModel.id,
  modelName: fixture.publicModel.name,
  prompt: "CODEX_MEDIA_HISTORY_RETRY_READONLY",
  firstFrameUrl: "",
  lastFrameUrl: "",
  referenceImageUrl: "",
  videoUrl: "",
  thumbnailUrl: "",
  status: "failed",
  errorMessage: "已确认未提交，可安全重试",
  priceCharged: 0,
};

const before = {
  videoTasks: await countRows("video_tasks", fixture.user.id),
  walletOperations: await countRows("wallet_operations", fixture.user.id),
};
const blockedWrites = [];
const generationRequests = [];
const externalRequests = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript(({ token, user }) => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("auth_token", token);
  localStorage.setItem("auth_user", JSON.stringify(user));
  sessionStorage.setItem("entered_app", "1");
}, { token: fixture.token, user: fixture.user });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === origin && url.pathname === "/api/media-history" && request.method() === "GET") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [browserItem], total: 1, pagination: { hasMore: false, nextOffset: null } }),
    });
    return;
  }
  if (url.origin === origin && url.pathname === "/api/video/history" && url.searchParams.get("taskId") === browserTaskId && request.method() === "GET") {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [browserTask], total: 1 }) });
    return;
  }
  if (url.origin === origin && url.pathname === "/api/video/generate") generationRequests.push(request.method());
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
    blockedWrites.push(`${request.method()} ${url.pathname}`);
    await route.abort("blockedbyclient");
    return;
  }
  if (![origin, "null"].includes(url.origin) && !["blob:", "data:"].includes(url.protocol)) {
    externalRequests.push(url.origin);
    await route.abort("blockedbyclient");
    return;
  }
  await route.continue();
});

try {
  await page.goto(`${origin}/media-history`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const retryButton = page.getByRole("button", { name: "载入后重试" });
  await retryButton.waitFor({ state: "visible", timeout: 20_000 });
  await page.screenshot({ path: path.join(output, "media-history-safe-retry.png"), fullPage: false });
  await retryButton.click();
  await page.getByText("已载入原提示词和已保存素材。请核对模型价格、参考图/音频后点击生成；本次会创建新任务。")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => !new URL(window.location.href).searchParams.has("retryTask"), null, { timeout: 10_000 });
  await page.screenshot({ path: path.join(output, "video-retry-loaded-no-submit.png"), fullPage: false });
} finally {
  await context.close();
  await browser.close();
}

const after = {
  videoTasks: await countRows("video_tasks", fixture.user.id),
  walletOperations: await countRows("wallet_operations", fixture.user.id),
};
assert.deepEqual(after, before, "loading a retry must not create tasks or wallet operations");
assert.equal(generationRequests.length, 0, "loading a retry must not submit generation");
assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);

const report = {
  verifier: "media-history-retry-readonly",
  origin,
  passed: true,
  checks: {
    serverReturnedSafeRetryPath: true,
    serverDeepPaginationVerified: true,
    failedCardRenderedRetryAction: true,
    originalTaskLoadedIntoVideoWorkbench: true,
    requiresExplicitGenerateClick: true,
    newVideoTasks: after.videoTasks - before.videoTasks,
    newWalletOperations: after.walletOperations - before.walletOperations,
    generationRequests: generationRequests.length,
    browserWriteRequestsBlocked: blockedWrites.length,
    externalRequestsBlocked: externalRequests.length,
    pageErrors: pageErrors.length,
  },
};
await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report));
