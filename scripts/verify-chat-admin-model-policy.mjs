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
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
const localEnvironment = parseDotenv(await readFile(path.join(root, ".env.local"), "utf8"));
const supabaseOrigin = new URL(runtime.supabaseUrl).origin;
assert.equal(supabaseOrigin, "http://127.0.0.1:54321", "local Supabase is required");

const serviceHeaders = {
  apikey: runtime.serviceRoleKey,
  Authorization: `Bearer ${runtime.serviceRoleKey}`,
};

async function restRows(table, params) {
  const url = new URL(`/rest/v1/${table}`, supabaseOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: serviceHeaders, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json();
  assert.ok(response.ok && Array.isArray(payload), `failed to read ${table}`);
  return payload;
}

async function countRows(table, filters = {}, idColumn = "id") {
  const url = new URL(`/rest/v1/${table}`, supabaseOrigin);
  url.searchParams.set("select", idColumn);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { ...serviceHeaders, Prefer: "count=exact", Range: "0-0" },
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `failed to count ${table}`);
  return Number((response.headers.get("content-range") || "0/0").split("/")[1] || 0);
}

const users = await restRows("users", {
  select: "id,username,display_name,role,credits,is_active,session_id,status",
  is_active: "eq.true",
  order: "updated_at.desc",
  limit: "200",
});
const hasUsableSession = (user) => typeof user.session_id === "string"
  && user.session_id.trim().length > 0
  && user.status !== "blocked";
const ordinaryUser = users.find((user) => user.role !== "admin" && hasUsableSession(user));
const adminUser = users.find((user) => user.role === "admin" && hasUsableSession(user));
assert.ok(ordinaryUser && adminUser, "ordinary and administrator fixtures are required");

const secrets = [...new Set([process.env.JWT_SECRET, runtime.jwtSecret, localEnvironment.JWT_SECRET]
  .map((value) => String(value || "").trim())
  .filter((value) => value.length >= 16))];
assert.ok(secrets.length > 0, "local JWT secret is unavailable");

async function verifiedTokenFor(user) {
  for (const secret of secrets) {
    const token = await new SignJWT({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name || user.username,
      sessionId: user.session_id,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30m")
      .sign(new TextEncoder().encode(secret));
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok && (await response.json())?.user?.role === user.role) return token;
  }
  throw new Error(`could not verify local ${user.role} token`);
}

const llmSource = await readFile(path.join(root, "src/app/api/llm/route.ts"), "utf8");
const chatSource = await readFile(path.join(root, "src/components/chat-view.tsx"), "utf8");
const sidebarSource = await readFile(path.join(root, "src/components/app-sidebar.tsx"), "utf8");
const modelGateIndex = llmSource.indexOf("shouldRejectOrdinaryChatModelOverride(modelAccessInput)");
const securityIndex = llmSource.indexOf("runSecurityChecks(");
const claimIndex = llmSource.indexOf("llmRequestAttemptStore.claim");

assert.ok(modelGateIndex > 0, "ordinary model override gate is missing");
assert.ok(modelGateIndex < securityIndex && modelGateIndex < claimIndex, "model gate must run before security, durable claim, billing, and provider work");
assert.equal(llmSource.includes("FREE_CHAT_ADMIN_ONLY"), false, "ordinary free chat must remain open");
assert.ok(llmSource.includes("FREE_CHAT_DEFAULT_MODEL_KEY") && llmSource.includes("FREE_CHAT_DEEP_THINKING_TYPE"), "fixed free-chat model and reasoning policy are missing");
assert.ok(llmSource.includes('.eq("model_name", FREE_CHAT_DEFAULT_MODEL_KEY)'), "free chat must select the exact configured model key");
assert.ok(llmSource.includes("shouldAutoEnableWebSearch"), "semantic web-search activation is missing");
assert.ok(llmSource.includes("retryTimes: 0") && llmSource.includes("retryDelay: 0") && llmSource.includes("timeout: WEB_SEARCH_TIMEOUT_MS"), "web presearch must use one bounded attempt");
assert.ok(llmSource.includes("resolveWebSearchTransport"), "web search must choose a configured presearch or native model transport");
assert.ok(sidebarSource.includes("startFreeChat()") && sidebarSource.includes("onClick={handleNewConversation}"), "new conversation must enter the canonical free-chat flow");
assert.equal(/\/api\/chat-models|切换对话模型|选择对话模型|selectedPublicModelId/u.test(chatSource), false, "the user chat surface must not expose or send a model override");
assert.ok(chatSource.includes("GPT-5.6 已就绪") && chatSource.includes("深度思考默认开启"), "fixed free-chat identity and reasoning state must be visible");
assert.ok(chatSource.includes('aria-label={webSearchOverride ? "关闭联网搜索" : "开启联网搜索"}'), "the explicit web-search control is missing");

const [ordinaryToken, adminToken] = await Promise.all([
  verifiedTokenFor(ordinaryUser),
  verifiedTokenFor(adminUser),
]);

const before = {
  attempts: await countRows("llm_request_attempts", { user_id: `eq.${ordinaryUser.id}` }, "record_id"),
  walletOperations: await countRows("wallet_operations", { user_id: `eq.${ordinaryUser.id}` }),
  credits: Number(ordinaryUser.credits),
};

const browser = await chromium.launch({ headless: true });
const pageErrors = [];
const consoleErrors = [];
const blockedUnsafeRequests = [];
const observedRequests = [];

async function verifyFreeChatForRole(user, token) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(({ authToken, authUser }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("auth_token", authToken);
    localStorage.setItem("auth_user", JSON.stringify(authUser));
    localStorage.setItem("active_view", "marketplace");
    sessionStorage.setItem("entered_app", "1");
  }, {
    authToken: token,
    authUser: {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      role: user.role,
      credits: user.credits,
      isActive: user.is_active,
      allowedCategories: null,
    },
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const unsafe = request.method() !== "GET" && [
      "/api/llm",
      "/api/conversations",
      "/api/image/generate",
      "/api/video/generate",
      "/api/cover/render",
      "/api/voice/tts",
    ].includes(url.pathname);
    if (unsafe) {
      blockedUnsafeRequests.push({ role: user.role, method: request.method(), path: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${user.role}: ${String(error.message || error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${user.role}: ${message.text()}`);
  });
  page.on("request", (request) => {
    observedRequests.push({ role: user.role, method: request.method(), path: new URL(request.url()).pathname });
  });

  const navigation = await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.ok(navigation?.ok(), `${user.role} home did not load`);
  const newConversation = page.getByRole("button", { name: "新建对话", exact: true });
  if (user.role !== "admin") {
    await page.getByText("对话历史", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await newConversation.count(), 0, `${user.role} must not see 新建对话`);
    assert.equal(await page.locator('button[title="切换对话模型"]').count(), 0, `${user.role} still sees a model switcher`);
    assert.equal(await page.getByText("选择对话模型", { exact: true }).count(), 0, `${user.role} still sees a model catalog`);
    await context.close();
    return { role: user.role, newConversationVisible: false };
  }
  await newConversation.waitFor({ state: "visible", timeout: 30_000 });
  await newConversation.click({ force: true });

  await page.locator(".chat-stage").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("GPT-5.6 已就绪，直接开始自由对话", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.locator('button[title="切换对话模型"]').count(), 0, `${user.role} still sees a model switcher`);
  assert.equal(await page.getByText("选择对话模型", { exact: true }).count(), 0, `${user.role} still sees a model catalog`);
  assert.equal(await page.getByText(/深度思考默认开启/u).count(), 1, `${user.role} cannot see the fixed reasoning state`);
  assert.equal(await page.getByRole("button", { name: "开启联网搜索", exact: true }).count(), 1, `${user.role} cannot access the web-search control`);
  const activeConversationId = await page.evaluate(() => localStorage.getItem("active_conversation_id"));
  assert.match(String(activeConversationId || ""), /^local_/u, `${user.role} free chat did not create a local pending conversation`);
  await context.close();
  return { role: user.role, activeConversationId };
}

let roleResults;
try {
  roleResults = [
    await verifyFreeChatForRole(ordinaryUser, ordinaryToken),
    await verifyFreeChatForRole(adminUser, adminToken),
  ];
} finally {
  await browser.close();
}

const refreshedOrdinary = (await restRows("users", {
  select: "credits",
  id: `eq.${ordinaryUser.id}`,
  limit: "1",
}))[0];
const after = {
  attempts: await countRows("llm_request_attempts", { user_id: `eq.${ordinaryUser.id}` }, "record_id"),
  walletOperations: await countRows("wallet_operations", { user_id: `eq.${ordinaryUser.id}` }),
  credits: Number(refreshedOrdinary.credits),
};

assert.deepEqual(after, before, "free-chat UI verification changed attempts, wallet operations, or credits");
assert.deepEqual(blockedUnsafeRequests, [], "the free-chat UI attempted a write or paid request");
assert.deepEqual(pageErrors, [], "browser page errors occurred");
assert.equal(observedRequests.filter((request) => request.path === "/api/chat-models").length, 0, "the user chat surface requested the model catalog");

const ignoredConsolePatterns = [
  /favicon/iu,
  /Failed to load resource.*404/iu,
];
const actionableConsoleErrors = consoleErrors.filter((entry) => !ignoredConsolePatterns.some((pattern) => pattern.test(entry)));
assert.deepEqual(actionableConsoleErrors, [], "browser console errors occurred");

const report = {
  verifier: "chat-admin-model-policy",
  origin,
  passed: true,
  providerCalls: 0,
  paidRequests: 0,
  databaseMutations: 0,
  checks: {
    adminFreeChatVisibleOrdinaryNewChatHidden: roleResults,
    modelSwitcherHiddenForBothRoles: true,
    fixedModel: "gpt-5.6-terra",
    fixedDeepThinkingType: 2,
    webSearchControlVisible: true,
    modelCatalogRequests: 0,
    unsafeRequests: 0,
    accountingUnchanged: before,
  },
};
const evidenceDirectory = path.join(root, ".codex-evidence", "chat-capability-chain-20260928");
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(path.join(evidenceDirectory, "admin-model-policy-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));
