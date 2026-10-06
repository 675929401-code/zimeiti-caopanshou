#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDir = path.resolve(".codex-evidence", "member-operations-archive", "live");

function anonymousId(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function safePath(value) {
  try {
    return new URL(value).pathname
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ":id")
      .replace(/\d{9,}/gu, ":id");
  } catch {
    return "/unknown";
  }
}

async function jsonGet(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${pathname}:${payload?.error || response.status}`);
  return payload;
}

async function closeOptionalOverlays(page) {
  const announcement = page.getByTestId("announcement-reader");
  if (await announcement.isVisible().catch(() => false)) {
    const close = announcement.getByRole("button", { name: /关闭系统公告|稍后查看|知道了/u }).first();
    if (await close.count()) await close.click();
  }
  const account = page.getByTestId("account-notification-dialog");
  if (await account.isVisible().catch(() => false)) {
    const close = account.getByRole("button", { name: /稍后查看|关闭|知道了/u }).first();
    if (await close.count()) await close.click();
  }
}

async function selectTargetUser(users) {
  const normalUsers = users.filter((user) => user?.role !== "admin" && user?.accountKind !== "fixture");
  assert.ok(normalUsers.length > 0, "NORMAL_MEMBER_REQUIRED");

  const recentChats = await jsonGet("/api/admin/user-chats?page=1&pageSize=20");
  assert.ok(Array.isArray(recentChats.conversations), "GLOBAL_CHAT_LIST_INVALID");
  assert.ok(Array.isArray(recentChats.agentUsage), "GLOBAL_AGENT_USAGE_INVALID");

  const userWithConversation = recentChats.conversations
    .map((conversation) => normalUsers.find((user) => user.id === conversation.userId))
    .find(Boolean);
  return { targetUser: userWithConversation || normalUsers[0], recentChats };
}

async function findWorkingChatSearch(user) {
  const candidates = [user.name, user.displayName, user.email, user.phone, user.username]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  assert.ok(candidates.length > 0, "MEMBER_SEARCH_IDENTITY_REQUIRED");
  for (const candidate of [...new Set(candidates)]) {
    const payload = await jsonGet(`/api/admin/user-chats?page=1&pageSize=20&user_name=${encodeURIComponent(candidate)}`);
    if (payload.conversations?.some((conversation) => conversation.userId === user.id)) {
      return { search: candidate, payload };
    }
  }
  const fallback = candidates[0];
  return {
    search: fallback,
    payload: await jsonGet(`/api/admin/user-chats?page=1&pageSize=20&user_name=${encodeURIComponent(fallback)}`),
  };
}

async function snapshotBusinessRows(client) {
  const result = await client.query(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*)::integer FROM public.users),
      'creditTransactions', (SELECT count(*)::integer FROM public.credit_transactions),
      'cashTransactions', (SELECT count(*)::integer FROM public.cash_transactions),
      'revenueRecords', (SELECT count(*)::integer FROM public.revenue_records),
      'loginLogs', (SELECT count(*)::integer FROM public.login_logs),
      'conversations', (SELECT count(*)::integer FROM public.conversations),
      'conversationMessages', (SELECT count(*)::integer FROM public.conversation_messages),
      'activationEvents', (SELECT count(*)::integer FROM public.member_activation_events),
      'invitationRewardGrants', (SELECT count(*)::integer FROM public.invitation_reward_grants),
      'walletOperations', (SELECT count(*)::integer FROM public.wallet_operations),
      'notifications', (SELECT count(*)::integer FROM public.user_notifications),
      'offlineReceipts', (SELECT count(*)::integer FROM public.offline_payment_receipts)
    ) AS snapshot
  `);
  return result.rows[0].snapshot;
}

export async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");

  const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  const client = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-member-operations-archive-readonly",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await client.connect();

  const report = {
    checkedAt: new Date().toISOString(),
    source: "LIVE_LOCAL_REAL_MEMBER_APIS_BROWSER_AND_DOWNLOAD",
    target: {},
    api: {},
    browser: {},
    blockedWrites: [],
    suppressedDiagnostics: [],
    externalRequests: [],
    failedResponses: [],
    consoleErrors: [],
    pageErrors: [],
    businessDatabaseUnchanged: false,
    providerCalls: 0,
    paidCalls: 0,
  };

  let browser;
  try {
    const before = await snapshotBusinessRows(client);
    const usersPayload = await jsonGet("/api/admin/users?page_size=500");
    assert.ok(Array.isArray(usersPayload.users), "MEMBER_LIST_INVALID");
    const { targetUser, recentChats } = await selectTargetUser(usersPayload.users);
    const { search: chatSearch, payload: filteredChats } = await findWorkingChatSearch(targetUser);

    const [transactionPayload, loginPayload, memberChats, lifecyclePayload] = await Promise.all([
      jsonGet(`/api/admin/user-transactions?userId=${encodeURIComponent(targetUser.id)}`),
      jsonGet(`/api/admin/login-logs?userId=${encodeURIComponent(targetUser.id)}&pageSize=50`),
      jsonGet(`/api/admin/user-chats?user_id=${encodeURIComponent(targetUser.id)}&pageSize=20`),
      jsonGet(`/api/admin/users/lifecycle?userId=${encodeURIComponent(targetUser.id)}`),
    ]);
    assert.equal(transactionPayload.success, true, "MEMBER_TRANSACTIONS_FAILED");
    assert.ok(Array.isArray(transactionPayload.data?.transactions), "MEMBER_TRANSACTIONS_INVALID");
    assert.ok(Array.isArray(transactionPayload.data?.paymentOrders), "MEMBER_PAYMENT_ORDERS_INVALID");
    assert.ok(Array.isArray(transactionPayload.data?.videoTasks), "MEMBER_VIDEO_TASKS_INVALID");
    assert.ok(Array.isArray(transactionPayload.data?.revenueRecords), "MEMBER_REVENUE_RECORDS_INVALID");
    assert.ok(Array.isArray(transactionPayload.data?.dailyStats), "MEMBER_DAILY_STATS_INVALID");
    for (const key of ["totalCreditsRecharged", "totalCreditsConsumed", "totalCashRecharged", "totalCashConsumed", "totalVideoCount"]) {
      assert.equal(typeof transactionPayload.data.summary?.[key], "number", `MEMBER_SUMMARY_INVALID:${key}`);
    }
    assert.ok(Array.isArray(loginPayload.logs), "MEMBER_LOGIN_LOGS_INVALID");
    for (const key of ["total", "success", "failed", "today"]) {
      assert.equal(typeof loginPayload.summary?.[key], "number", `MEMBER_LOGIN_SUMMARY_INVALID:${key}`);
    }
    assert.equal(loginPayload.summary.total, loginPayload.summary.success + loginPayload.summary.failed, "LOGIN_SUMMARY_NOT_CLOSED");
    assert.ok(Array.isArray(memberChats.conversations), "MEMBER_CHAT_LIST_INVALID");
    assert.equal(typeof memberChats.total, "number", "MEMBER_CHAT_TOTAL_INVALID");
    assert.ok(Array.isArray(lifecyclePayload.events), "MEMBER_LIFECYCLE_INVALID");
    for (const key of ["invitationCount", "receivedRewardCount", "cardCount", "offlinePaymentCount"]) {
      assert.equal(typeof lifecyclePayload.summary?.[key], "number", `MEMBER_LIFECYCLE_SUMMARY_INVALID:${key}`);
    }

    const csvResponse = await fetch(`${origin}/api/admin/reconciliation/recharges?format=csv&userId=${encodeURIComponent(targetUser.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const csvBytes = Buffer.from(await csvResponse.arrayBuffer());
    const csvText = csvBytes.toString("utf8");
    assert.equal(csvResponse.status, 200, `MEMBER_RECONCILIATION_CSV_FAILED:${csvResponse.status}`);
    assert.match(String(csvResponse.headers.get("content-type") || ""), /^text\/csv/u, "MEMBER_RECONCILIATION_CSV_TYPE_INVALID");
    assert.equal(csvBytes.subarray(0, 3).toString("hex"), "efbbbf", "MEMBER_RECONCILIATION_CSV_BOM_MISSING");
    for (const header of ["线下收款凭证ID", "线下交易流水号", "付款方脱敏标识", "会员激活事件ID", "作废原因"]) {
      assert.ok(csvText.includes(header), `MEMBER_RECONCILIATION_HEADER_MISSING:${header}`);
    }

    report.target = {
      anonymousUserId: anonymousId(targetUser.id),
      selectedFromExistingConversation: recentChats.conversations.some((conversation) => conversation.userId === targetUser.id),
      searchFieldPresent: Boolean(chatSearch),
    };
    report.api = {
      transactionCount: transactionPayload.data.transactions.length,
      paymentOrderCount: transactionPayload.data.paymentOrders.length,
      videoTaskCount: transactionPayload.data.videoTasks.length,
      revenueRecordCount: transactionPayload.data.revenueRecords.length,
      dailyStatCount: transactionPayload.data.dailyStats.length,
      creditConsumed: transactionPayload.data.summary.totalCreditsConsumed,
      cashConsumed: transactionPayload.data.summary.totalCashConsumed,
      login: loginPayload.summary,
      loginLogCount: loginPayload.logs.length,
      memberConversationCount: memberChats.total,
      filteredConversationCount: filteredChats.total,
      filteredAgentUsageCount: filteredChats.agentUsage?.length || 0,
      lifecycleEventCount: lifecyclePayload.events.length,
      lifecycleSummary: lifecyclePayload.summary,
      reconciliationCsvBytes: csvBytes.length,
    };

    await fs.mkdir(evidenceDir, { recursive: true });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: true,
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        report.externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (/^\/api\/(?:commerce|admin\/manju)(?:\/|$)/u.test(url.pathname)) {
        await route.abort("blockedbyclient");
        return;
      }
      const nextDiagnostic = request.method() === "POST" && url.pathname === "/__nextjs_original-stack-frames";
      const operationDiagnostic = request.method() === "POST" && ["/api/operation-events", "/api/diagnostic-logs"].includes(url.pathname);
      if (operationDiagnostic) {
        report.suppressedDiagnostics.push(`${request.method()} ${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (request.method() !== "GET" && !nextDiagnostic) {
        report.blockedWrites.push(`${request.method()} ${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });

    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(String(error?.message || error).slice(0, 500)));
    page.on("console", (message) => {
      if (message.type() !== "error" || /ERR_BLOCKED_BY_CLIENT/u.test(message.text())) return;
      report.consoleErrors.push(message.text().replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer <redacted>").slice(0, 500));
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400) report.failedResponses.push(`${response.status()} ${safePath(response.url())}`);
    });

    await page.goto(`${origin}/admin?tab=users`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.getByRole("heading", { name: "学员与会员", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await closeOptionalOverlays(page);
    const memberSearch = page.getByPlaceholder("搜索姓名/手机/邮箱...");
    const cardSearch = String(targetUser.email || targetUser.phone || targetUser.name || targetUser.displayName || targetUser.username || "").trim();
    assert.ok(cardSearch, "MEMBER_CARD_SEARCH_VALUE_REQUIRED");
    await memberSearch.fill(cardSearch);
    const targetCard = page.getByTestId("admin-member-card").filter({ hasText: cardSearch }).first();
    await targetCard.waitFor({ state: "visible", timeout: 20_000 });

    await targetCard.getByRole("button", { name: "运营档案", exact: true }).click();
    const archiveHeading = page.getByRole("heading", { name: "学员 360° 运营档案", exact: true });
    await archiveHeading.waitFor({ state: "visible", timeout: 30_000 });
    const archive = page.locator("div.fixed.inset-0").filter({ has: archiveHeading }).first();
    for (const label of ["今日成功登录", "累计登录审计", "聊天档案", "累计实际消耗"]) {
      await archive.getByText(label, { exact: true }).waitFor({ state: "visible" });
    }
    await archive.getByText(`${loginPayload.summary.today}次`, { exact: true }).waitFor({ state: "visible" });
    await archive.getByText(`成功 ${loginPayload.summary.success} · 失败 ${loginPayload.summary.failed}`, { exact: true }).waitFor({ state: "visible" });
    await archive.getByText(`合计 ${loginPayload.summary.total} 次尝试`, { exact: true }).waitFor({ state: "visible" });
    await archive.getByText(`${memberChats.total}个会话`, { exact: true }).waitFor({ state: "visible" });
    await archive.getByText(`${Number(transactionPayload.data.summary.totalCreditsConsumed).toLocaleString()} 积分`, { exact: true }).waitFor({ state: "visible" });
    await archive.getByText(`¥${Number(transactionPayload.data.summary.totalCashConsumed).toFixed(2)} 现金`, { exact: true }).waitFor({ state: "visible" });

    for (const label of ["当前会员状态", "成功邀请人数", "已收邀请礼包", "关联会员卡", "确认线下收款"]) {
      await archive.getByText(label, { exact: true }).waitFor({ state: "visible" });
    }
    const tabs = ["生命周期", "全部记录", "积分记录", "现金记录", "消费明细", "视频明细", "每日统计", "登录记录"];
    for (const label of tabs) {
      await archive.getByRole("button", { name: label, exact: true }).click();
      await page.waitForTimeout(80);
    }
    await archive.getByText("IP地址", { exact: true }).waitFor({ state: "visible" });
    if (loginPayload.logs.length === 0) {
      await archive.getByText("暂无登录记录", { exact: true }).waitFor({ state: "visible" });
    } else {
      const statusLabel = loginPayload.logs[0].status === "success" ? "成功" : "失败";
      assert.ok(await archive.getByText(statusLabel, { exact: true }).count() >= 1, "LOGIN_ROW_STATUS_MISSING");
    }

    const browserDownload = page.waitForEvent("download", { timeout: 30_000 });
    await archive.getByRole("button", { name: "下载全部充值记录", exact: true }).click();
    const download = await browserDownload;
    const downloadPath = await download.path();
    assert.ok(downloadPath, "BROWSER_RECONCILIATION_DOWNLOAD_PATH_MISSING");
    const downloadedBytes = await fs.readFile(downloadPath);
    assert.equal(downloadedBytes.subarray(0, 3).toString("hex"), "efbbbf", "BROWSER_RECONCILIATION_CSV_BOM_MISSING");
    assert.ok(downloadedBytes.length === csvBytes.length, `BROWSER_RECONCILIATION_SIZE_MISMATCH:${downloadedBytes.length}:${csvBytes.length}`);
    await page.screenshot({ path: path.join(evidenceDir, "member-operations-archive.png"), fullPage: false });
    await archive.getByRole("button", { name: "关闭运营档案", exact: true }).click();

    await targetCard.getByRole("button", { name: "查看聊天", exact: true }).click();
    await page.getByRole("heading", { name: "聊天记录", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const chatInput = page.getByPlaceholder("搜索学员姓名/手机/邮箱");
    await chatInput.waitFor({ state: "visible" });
    const actualChatSearch = await chatInput.inputValue();
    assert.equal(actualChatSearch, String(targetUser.name || targetUser.displayName || targetUser.email || targetUser.phone || ""), "CHAT_SEARCH_CONTEXT_NOT_CARRIED");
    const expectedChatPayload = actualChatSearch === chatSearch
      ? filteredChats
      : await jsonGet(`/api/admin/user-chats?page=1&pageSize=20&user_name=${encodeURIComponent(actualChatSearch)}`);
    await page.getByText(`共 ${expectedChatPayload.total} 个会话`, { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    if ((expectedChatPayload.agentUsage || []).length > 0) {
      await page.getByRole("heading", { name: "智能体使用统计", exact: true }).waitFor({ state: "visible" });
    }
    if (expectedChatPayload.conversations.length > 0) {
      const firstConversation = expectedChatPayload.conversations[0];
      const messagesPayload = await jsonGet(`/api/admin/user-chats?conversation_id=${encodeURIComponent(firstConversation.id)}&messages=true`);
      assert.ok(Array.isArray(messagesPayload.messages), "CONVERSATION_MESSAGES_INVALID");
      await page.getByRole("button", { name: "查看", exact: true }).first().click();
      const chatDialog = page.locator("div.fixed.inset-0.z-\\[60\\]").first();
      await chatDialog.waitFor({ state: "visible", timeout: 20_000 });
      await chatDialog.getByText("加载中...", { exact: true }).waitFor({ state: "hidden", timeout: 20_000 });
      if (messagesPayload.messages.length === 0) {
        await chatDialog.getByText("暂无消息", { exact: true }).waitFor({ state: "visible" });
      } else {
        await chatDialog.locator("div.w-7.h-7").first().waitFor({ state: "visible", timeout: 20_000 });
        assert.equal(await chatDialog.locator("div.w-7.h-7").count(), messagesPayload.messages.length, "CHAT_MESSAGE_COUNT_MISMATCH");
      }
      report.api.openedConversationMessageCount = messagesPayload.messages.length;
      await chatDialog.getByRole("button").first().click();
    } else {
      await page.getByText("没有匹配的聊天记录", { exact: true }).waitFor({ state: "visible" });
    }
    await page.screenshot({ path: path.join(evidenceDir, "member-chat-archive.png"), fullPage: false });

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      applicationErrorVisible: /Application error: a client-side exception|Internal Server Error|应用程序错误/u.test(document.body.innerText),
    }));
    assert.ok(layout.horizontalOverflowPx <= 1, `MEMBER_ARCHIVE_HORIZONTAL_OVERFLOW:${layout.horizontalOverflowPx}`);
    assert.equal(layout.applicationErrorVisible, false, "MEMBER_ARCHIVE_APPLICATION_ERROR");
    report.browser = {
      viewport: { width: 1440, height: 900 },
      archiveSummaryMatchesApi: true,
      archiveTabs: tabs,
      chatSearchContextMatches: true,
      reconciliationDownloadBytes: downloadedBytes.length,
      layout,
    };
    await context.close();

    const after = await snapshotBusinessRows(client);
    assert.deepEqual(after, before, "READONLY_ACCEPTANCE_CHANGED_BUSINESS_ROWS");
    report.businessDatabaseUnchanged = true;
    assert.equal(report.blockedWrites.length, 0, `UNEXPECTED_BROWSER_WRITES:${report.blockedWrites.join(",")}`);
    assert.equal(report.externalRequests.length, 0, `EXTERNAL_REQUESTS_OBSERVED:${report.externalRequests.join(",")}`);
    assert.equal(report.failedResponses.length, 0, `HTTP_FAILURES:${report.failedResponses.join(",")}`);
    assert.equal(report.consoleErrors.length, 0, `CONSOLE_ERRORS:${report.consoleErrors.join(" | ")}`);
    assert.equal(report.pageErrors.length, 0, `PAGE_ERRORS:${report.pageErrors.join(" | ")}`);

    await fs.writeFile(path.join(evidenceDir, "live-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/gu, "/")}`) {
  await main();
}
