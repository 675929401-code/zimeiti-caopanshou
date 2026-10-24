#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";
import { SignJWT } from "jose";
import { parse as parseDotenv } from "dotenv";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const outputRoot = path.resolve(
  process.env.AGENT_PERMISSION_EVIDENCE_DIR || ".codex-evidence/agent-navigation-permissions-current",
);
const requestedRunId = process.env.AGENT_PERMISSION_EVIDENCE_RUN_ID?.trim();
const runId = requestedRunId || `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}-${randomBytes(4).toString("hex")}`;
assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, "INVALID_EVIDENCE_RUN_ID");
const outputDirectory = path.join(outputRoot, runId);
const stableKeys = ["bip:loop", "task:影像编导", "task:文案创作", "task:获客转化", "自用"];
const stableKeySet = new Set(stableKeys);
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;

function sorted(values) {
  return [...values].map(String).sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function safePath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return "/unknown";
  }
}

async function jsonResponse(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(adminToken, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
  const supabaseOrigin = new URL(runtime.supabaseUrl).origin;
  assert.equal(supabaseOrigin, "http://127.0.0.1:54321", "LOCAL_SUPABASE_REQUIRED");
  const serviceHeaders = {
    apikey: runtime.serviceRoleKey,
    Authorization: `Bearer ${runtime.serviceRoleKey}`,
  };

  async function restRows(table, params) {
    const url = new URL(`/rest/v1/${table}`, supabaseOrigin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const { response, body } = await jsonResponse(url, { headers: serviceHeaders });
    assert.ok(response.ok && Array.isArray(body), `READ_FAILED:${table}`);
    return body;
  }

  async function countRows(table, filters = {}, idColumn = "id") {
    const url = new URL(`/rest/v1/${table}`, supabaseOrigin);
    url.searchParams.set("select", idColumn);
    for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      headers: { ...serviceHeaders, Prefer: "count=exact", Range: "0-0" },
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(response.ok, `COUNT_FAILED:${table}`);
    return Number((response.headers.get("content-range") || "0/0").split("/")[1] || 0);
  }

  const [versionResult, adminUsersResult, camiResult, databaseUsers] = await Promise.all([
    jsonResponse(`${origin}/api/version`),
    jsonResponse(`${origin}/api/admin/users?page_size=500`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }),
    jsonResponse(`${origin}/api/admin/cami?page=1&size=100`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }),
    restRows("users", {
      select: "id,username,display_name,role,session_id,status,is_active,member_status,allowed_categories,credits,cash_balance",
      is_active: "eq.true",
      limit: "200",
    }),
  ]);
  assert.equal(versionResult.response.status, 200, "VERSION_READ_FAILED");
  assert.equal(adminUsersResult.response.status, 200, "ADMIN_USERS_READ_FAILED");
  assert.equal(camiResult.response.status, 200, "CAMI_READ_FAILED");

  const ordinaryAdminRows = (adminUsersResult.body.users || []).filter((user) => user.role !== "admin");
  const usableDatabaseUser = (adminRow) => databaseUsers.find((user) => (
    String(user.id) === String(adminRow.id)
    && user.role !== "admin"
    && typeof user.session_id === "string"
    && user.session_id.trim()
    && user.status !== "blocked"
  ));
  const usableMemberPairs = ordinaryAdminRows
    .map((admin) => ({ admin, database: usableDatabaseUser(admin) }))
    .filter((pair) => Boolean(pair.database));
  const fourGrantPair = usableMemberPairs.find((pair) => pair.admin.allowedNavigationKeys?.length === 4);
  const fiveGrantPair = usableMemberPairs.find((pair) => pair.admin.allowedNavigationKeys?.length === 5);
  assert.ok(fourGrantPair && fiveGrantPair, "USABLE_FOUR_AND_FIVE_GRANT_MEMBER_SESSIONS_REQUIRED");
  const fourGrantAdminRow = fourGrantPair.admin;
  const fiveGrantAdminRow = fiveGrantPair.admin;
  const fourGrantUser = fourGrantPair.database;
  const fiveGrantUser = fiveGrantPair.database;

  const authSessionBaseline = {
    fourGrant: await countRows("user_auth_sessions", { user_id: `eq.${fourGrantUser.id}`, revoked_at: "is.null", expires_at: `gt.${new Date().toISOString()}` }),
    fiveGrant: await countRows("user_auth_sessions", { user_id: `eq.${fiveGrantUser.id}`, revoked_at: "is.null", expires_at: `gt.${new Date().toISOString()}` }),
  };
  const temporarySessionIds = [];
  async function createTemporarySession(user) {
    const sessionId = `permission-${crypto.randomUUID()}`;
    const response = await fetch(new URL("/rest/v1/user_auth_sessions", supabaseOrigin), {
      method: "POST",
      headers: {
        ...serviceHeaders,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: user.id,
        session_id: sessionId,
        ip_hash: "local-permission-regression",
        user_agent_hash: "codex-readonly-browser",
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(response.ok, "TEMPORARY_AUTH_SESSION_CREATE_FAILED");
    temporarySessionIds.push(sessionId);
    user.session_id = sessionId;
  }
  async function cleanupTemporarySessions() {
    if (temporarySessionIds.length === 0) return;
    const url = new URL("/rest/v1/user_auth_sessions", supabaseOrigin);
    url.searchParams.set("session_id", `in.(${temporarySessionIds.join(",")})`);
    const response = await fetch(url, {
      method: "DELETE",
      headers: { ...serviceHeaders, Prefer: "return=minimal" },
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(response.ok, "TEMPORARY_AUTH_SESSION_CLEANUP_FAILED");
  }
  let temporarySessionsCleaned = false;
  try {
    await createTemporarySession(fourGrantUser);
    await createTemporarySession(fiveGrantUser);

  const localEnvironment = parseDotenv(await readFile(path.join(process.cwd(), ".env.local"), "utf8"));
  const jwtSecrets = [...new Set([runtime.jwtSecret, localEnvironment.JWT_SECRET, process.env.JWT_SECRET]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 16))];
  assert.ok(jwtSecrets.length > 0, "LOCAL_JWT_SECRET_REQUIRED");
  async function tokenFor(user) {
    for (const secret of jwtSecrets) {
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
      const check = await fetch(`${origin}/api/agent-favorites`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (check.status === 200) return token;
    }
    throw new Error("MEMBER_TOKEN_REJECTED");
  }

  const [fourToken, fiveToken] = await Promise.all([tokenFor(fourGrantUser), tokenFor(fiveGrantUser)]);
  async function memberReads(token) {
    const headers = { Authorization: `Bearer ${token}` };
    const [catalog, favorites] = await Promise.all([
      jsonResponse(`${origin}/api/bots?shape=agents`, { headers }),
      jsonResponse(`${origin}/api/agent-favorites`, { headers }),
    ]);
    assert.equal(catalog.response.status, 200, "MEMBER_CATALOG_FAILED");
    assert.equal(favorites.response.status, 200, "MEMBER_FAVORITES_FAILED");
    return { catalog: catalog.body, favorites: favorites.body };
  }

  const [fourReads, fiveReads] = await Promise.all([memberReads(fourToken), memberReads(fiveToken)]);
  assert.deepEqual(
    sorted(fourReads.catalog.navigationKeys || []),
    sorted(fourGrantAdminRow.allowedNavigationKeys),
    "FOUR_GRANT_API_MISMATCH",
  );
  assert.deepEqual(
    sorted(fiveReads.catalog.navigationKeys || []),
    sorted(fiveGrantAdminRow.allowedNavigationKeys),
    "FIVE_GRANT_API_MISMATCH",
  );
  assert.equal(fourReads.catalog.navigationKeys.includes("自用"), false, "UNCHECKED_INTERNAL_NAVIGATION_LEAKED");
  assert.equal(fiveReads.catalog.navigationKeys.includes("自用"), true, "CHECKED_INTERNAL_NAVIGATION_MISSING");
  assert.ok(fourReads.catalog.agents.length > 0, "FOUR_GRANT_CATALOG_EMPTY");
  assert.ok(fiveReads.catalog.agents.length > fourReads.catalog.agents.length, "MEMBER_CATALOG_DIFFERENCE_MISSING");

  const fourAgentIds = new Set(fourReads.catalog.agents.map((agent) => String(agent.id)));
  const fiveAgentIds = new Set(fiveReads.catalog.agents.map((agent) => String(agent.id)));
  const deniedAgents = fiveReads.catalog.agents.filter((agent) => !fourAgentIds.has(String(agent.id)));
  assert.ok(deniedAgents.length > 0, "DENIED_AGENT_FIXTURE_MISSING");
  assert.ok(deniedAgents.every((agent) => agent.category === "自用"), "UNEXPECTED_CATALOG_DIFFERENCE");
  const deniedAgent = deniedAgents[0];
  const fourFavorites = fourReads.favorites.favorites || [];
  assert.ok(fourFavorites.every((favorite) => fourAgentIds.has(String(favorite.agent_id))), "UNAUTHORIZED_FAVORITE_VISIBLE");

  const baseline = {
    attempts: await countRows("llm_request_attempts", { user_id: `eq.${fourGrantUser.id}` }, "record_id"),
    walletOperations: await countRows("wallet_operations", { user_id: `eq.${fourGrantUser.id}` }),
    favorites: await countRows("agent_favorites", { user_id: `eq.${fourGrantUser.id}` }),
    conversations: await countRows("conversations", { user_id: `eq.${fourGrantUser.id}` }),
    credits: Number(fourGrantUser.credits),
    cashBalance: Number(fourGrantUser.cash_balance),
  };

  const favoriteDenial = await jsonResponse(`${origin}/api/agent-favorites`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fourToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agent_id: deniedAgent.id }),
  });
  assert.equal(favoriteDenial.response.status, 404, "UNAUTHORIZED_FAVORITE_NOT_REJECTED");

  const requestId = `permission-check-${Date.now()}-${crypto.randomUUID()}`;
  const chatDenial = await jsonResponse(`${origin}/api/llm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fourToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": requestId,
    },
    body: JSON.stringify({
      agentId: deniedAgent.id,
      messages: [{ role: "user", content: "只执行权限检查，不调用模型。" }],
      stream: false,
      client_request_id: requestId,
    }),
  });
  assert.equal(chatDenial.response.status, 403, "UNAUTHORIZED_CHAT_NOT_REJECTED");
  assert.equal(chatDenial.body.code, "CATEGORY_ACCESS_DENIED", "UNAUTHORIZED_CHAT_WRONG_ERROR");

  const refreshedFourUser = (await restRows("users", {
    select: "credits,cash_balance",
    id: `eq.${fourGrantUser.id}`,
    limit: "1",
  }))[0];
  const afterDenials = {
    attempts: await countRows("llm_request_attempts", { user_id: `eq.${fourGrantUser.id}` }, "record_id"),
    walletOperations: await countRows("wallet_operations", { user_id: `eq.${fourGrantUser.id}` }),
    favorites: await countRows("agent_favorites", { user_id: `eq.${fourGrantUser.id}` }),
    conversations: await countRows("conversations", { user_id: `eq.${fourGrantUser.id}` }),
    credits: Number(refreshedFourUser.credits),
    cashBalance: Number(refreshedFourUser.cash_balance),
  };
  assert.deepEqual(afterDenials, baseline, "PERMISSION_DENIAL_CHANGED_BUSINESS_STATE");

  const camiCodes = camiResult.body.codes || [];
  const camiGrants = camiCodes.flatMap((code) => Array.isArray(code.allowed_categories) ? code.allowed_categories : []);
  assert.ok(camiCodes.length > 0, "CAMI_ROWS_REQUIRED");
  assert.equal(camiGrants.some((grant) => uuidPattern.test(String(grant))), false, "CAMI_EXPOSED_UUID");
  assert.equal(camiGrants.some((grant) => !stableKeySet.has(String(grant))), false, "CAMI_EXPOSED_UNKNOWN_PERMISSION");

  const browser = await chromium.launch({ headless: true });
  const browserResults = [];
  const pageErrors = [];
  const consoleErrors = [];
  const blockedWrites = [];
  try {
    async function verifyMemberPage({ user, token, catalog, expectedKeys, deniedId, label }) {
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
          credits: Number(user.credits),
          cashBalance: Number(user.cash_balance),
          memberStatus: user.member_status,
          isActive: user.is_active,
          allowedCategories: expectedKeys,
        },
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === "GET" || request.method() === "HEAD" || request.method() === "OPTIONS") {
          await route.continue();
          return;
        }
        if (url.origin === origin && ["/api/announcements/events", "/api/diagnostic-logs"].includes(url.pathname)) {
          await route.fulfill({ status: 200, contentType: "application/json", body: "{\"success\":true}" });
          return;
        }
        blockedWrites.push(`${label}:${request.method()} ${safePath(request.url())}`);
        await route.abort("blockedbyclient");
      });

      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(`${label}:${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/iu.test(message.text())) {
          consoleErrors.push(`${label}:${message.text().slice(0, 400)}`);
        }
      });
      const catalogResponse = page.waitForResponse((response) => (
        new URL(response.url()).pathname === "/api/bots"
        && response.request().method() === "GET"
        && response.status() === 200
      ), { timeout: 30_000 });
      await page.goto(`${origin}/?agentId=${encodeURIComponent(deniedId || "none")}`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await catalogResponse;
      await page.locator(".marketplace-category-bar").waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(() => document.querySelectorAll("[data-agent-card-id]").length > 0, undefined, { timeout: 30_000 });
      const announcementReader = page.getByTestId("announcement-reader");
      if (await announcementReader.isVisible().catch(() => false)) {
        await announcementReader.getByRole("button", { name: "关闭系统公告", exact: true }).click();
      }

      const visibleNavigationKeys = await page.locator("[data-agent-category]").evaluateAll((nodes) => (
        nodes.map((node) => node.getAttribute("data-agent-category") || "").filter(Boolean)
      ));
      for (const key of expectedKeys) assert.ok(visibleNavigationKeys.includes(key), `${label}:NAVIGATION_MISSING:${key}`);
      for (const key of stableKeys.filter((key) => !expectedKeys.includes(key))) {
        assert.equal(visibleNavigationKeys.includes(key), false, `${label}:UNCHECKED_NAVIGATION_VISIBLE:${key}`);
      }
      assert.equal(await page.locator(`[data-agent-card-id="${deniedId}"]`).count(), 0, `${label}:DIRECT_URL_EXPOSED_DENIED_AGENT`);

      const allVisibleCardIds = await page.locator("[data-agent-card-id]").evaluateAll((nodes) => (
        nodes.map((node) => node.getAttribute("data-agent-card-id") || "").filter(Boolean)
      ));
      const catalogIds = new Set(catalog.agents.map((agent) => String(agent.id)));
      assert.ok(allVisibleCardIds.every((id) => catalogIds.has(id)), `${label}:UI_CARD_OUTSIDE_API_CATALOG`);

      const favoritesTab = page.locator('[data-agent-category="favorites"]');
      await favoritesTab.click();
      await page.waitForTimeout(250);
      const favoriteCardIds = await page.locator("[data-agent-card-id]").evaluateAll((nodes) => (
        nodes.map((node) => node.getAttribute("data-agent-card-id") || "").filter(Boolean)
      ));
      assert.ok(favoriteCardIds.every((id) => catalogIds.has(id)), `${label}:FAVORITE_OUTSIDE_API_CATALOG`);

      let chatEntryVerified = false;
      if (label === "four-grant") {
        await page.locator('[data-agent-category="all"]').click();
        const favoriteIds = new Set((fourReads.favorites.favorites || []).map((entry) => String(entry.agent_id)));
        const candidate = catalog.agents.find((agent) => (
          !favoriteIds.has(String(agent.id))
          && agent.category !== "商业定位IP"
          && agent.is_active !== false
          && agent.user_access !== "view_only"
          && (!Array.isArray(agent.preset_fields) || agent.preset_fields.length === 0)
        ));
        assert.ok(candidate, "CHAT_ENTRY_CANDIDATE_REQUIRED");
        const card = page.locator(`[data-agent-card-id="${candidate.id}"]`);
        await card.waitFor({ state: "visible", timeout: 15_000 });
        await card.locator('[role="button"][aria-label^="打开智能体："]').click();
        await page.locator(".chat-stage").waitFor({ state: "visible", timeout: 15_000 });
        assert.ok(await page.getByRole("button", { name: "主页", exact: true }).isVisible(), "CHAT_HOME_ACTION_MISSING");
        chatEntryVerified = true;
      }

      const layout = await page.evaluate(() => ({
        horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        applicationError: /Application error|Internal Server Error|应用程序错误/iu.test(document.body.innerText),
      }));
      assert.ok(layout.horizontalOverflowPx <= 1, `${label}:HORIZONTAL_OVERFLOW`);
      assert.equal(layout.applicationError, false, `${label}:APPLICATION_ERROR`);
      await page.screenshot({ path: path.join(outputDirectory, `${label}-navigation-1440x900.png`), fullPage: false });
      await context.close();
      return {
        label,
        expectedNavigationKeys: expectedKeys,
        visibleNavigationKeys,
        apiAgentCount: catalog.agents.length,
        visibleCardCount: allVisibleCardIds.length,
        favoriteCardCount: favoriteCardIds.length,
        directUrlDenied: true,
        chatEntryVerified,
        layout,
      };
    }

    await mkdir(outputRoot, { recursive: true });
    try { await mkdir(outputDirectory); } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`EVIDENCE_RUN_DIRECTORY_EXISTS:${outputDirectory}`);
      throw error;
    }
    browserResults.push(await verifyMemberPage({
      user: fourGrantUser,
      token: fourToken,
      catalog: fourReads.catalog,
      expectedKeys: fourGrantAdminRow.allowedNavigationKeys,
      deniedId: deniedAgent.id,
      label: "four-grant",
    }));
    browserResults.push(await verifyMemberPage({
      user: fiveGrantUser,
      token: fiveToken,
      catalog: fiveReads.catalog,
      expectedKeys: fiveGrantAdminRow.allowedNavigationKeys,
      deniedId: "none",
      label: "five-grant",
    }));
  } finally {
    await browser.close();
  }

  assert.deepEqual(blockedWrites, [], "UNEXPECTED_BROWSER_WRITES");
  assert.deepEqual(pageErrors, [], "PERMISSION_BROWSER_PAGE_ERRORS");
  assert.deepEqual(consoleErrors, [], "PERMISSION_BROWSER_CONSOLE_ERRORS");

  await cleanupTemporarySessions();
  temporarySessionsCleaned = true;
  const authSessionAfter = {
    fourGrant: await countRows("user_auth_sessions", { user_id: `eq.${fourGrantUser.id}`, revoked_at: "is.null", expires_at: `gt.${new Date().toISOString()}` }),
    fiveGrant: await countRows("user_auth_sessions", { user_id: `eq.${fiveGrantUser.id}`, revoked_at: "is.null", expires_at: `gt.${new Date().toISOString()}` }),
  };
  assert.deepEqual(authSessionAfter, authSessionBaseline, "TEMPORARY_AUTH_SESSIONS_REMAIN");

  const report = {
    observedAt: new Date().toISOString(),
    runId,
    outputRoot,
    evidenceDirectory: outputDirectory,
    runtime: versionResult.body,
    passed: true,
    scope: "existing four-navigation and five-navigation local members; real local APIs and desktop UI",
    users: {
      ordinaryCount: ordinaryAdminRows.length,
      grantCounts: ordinaryAdminRows.map((user) => user.allowedNavigationKeys?.length ?? 0).sort((a, b) => a - b),
    },
    api: {
      fourGrantAgentCount: fourReads.catalog.agents.length,
      fiveGrantAgentCount: fiveReads.catalog.agents.length,
      deniedAgentCount: deniedAgents.length,
      deniedCategories: [...new Set(deniedAgents.map((agent) => agent.category))],
      favoriteDeniedStatus: favoriteDenial.response.status,
      chatDeniedStatus: chatDenial.response.status,
      chatDeniedCode: chatDenial.body.code,
    },
    cami: {
      count: camiCodes.length,
      rawUuidCount: camiGrants.filter((grant) => uuidPattern.test(String(grant))).length,
      unknownPermissionCount: camiGrants.filter((grant) => !stableKeySet.has(String(grant))).length,
    },
    browser: browserResults,
    stateBefore: baseline,
    stateAfter: afterDenials,
    temporaryAuthSessions: {
      inserted: 2,
      deleted: 2,
      activeBefore: authSessionBaseline,
      activeAfter: authSessionAfter,
    },
    providerCalls: 0,
    paidCalls: 0,
    businessWrites: 0,
    blockedWrites,
    pageErrors,
    consoleErrors,
  };
  const reportPath = path.join(outputDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({
    ok: true,
    sourceVersion: versionResult.body.sourceVersion,
    buildId: versionResult.body.buildId,
    grantCounts: report.users.grantCounts,
    agentCounts: [report.api.fourGrantAgentCount, report.api.fiveGrantAgentCount],
    deniedAgentCount: report.api.deniedAgentCount,
    favoriteDeniedStatus: report.api.favoriteDeniedStatus,
    chatDenied: `${report.api.chatDeniedStatus} ${report.api.chatDeniedCode}`,
    browserScenes: browserResults.length,
    providerCalls: 0,
    paidCalls: 0,
    businessWrites: 0,
    reportPath,
  }, null, 2));
  } finally {
    if (!temporarySessionsCleaned) await cleanupTemporarySessions();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) {
  await main();
}
