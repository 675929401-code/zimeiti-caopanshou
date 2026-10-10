#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const EXACT_ORIGIN = "http://127.0.0.1:5000";
const EXACT_PROJECT_ROOT = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本";
const EXACT_RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const DEFAULTS = Object.freeze({
  agentId: "agent-1786843330392-emdjv2",
  agentName: "3D故事导演｜高能版",
  expectedFromId: "3af4f2e6-a51f-44f6-ad17-9e6412147c81",
  targetId: "1cd040b5-c3ea-4217-bfe2-8c3f059554af",
});
const ALLOWED_ARGUMENT_PREFIXES = [
  "--agent-id=",
  "--agent-name=",
  "--expected-from-id=",
  "--target-id=",
];
const ALLOWED_ARGUMENTS = new Set(["--execute", "--rollback-reapply"]);
const TARGET_DATABASE_ALLOWED_CHANGES = new Set(["model", "model_id", "updated_at"]);
const TARGET_ADMIN_ALLOWED_CHANGES = new Set(["model", "model_id"]);
const TARGET_BOTS_ALLOWED_CHANGES = new Set(["model", "model_id", "model_public_id"]);
const SENSITIVE_KEY = /(?:^|_)(?:api_?key|authorization|cookie|credential|password|secret|token)(?:_|$)/iu;
const ANNOUNCEMENT_EVENT_TYPES = new Set(["impression", "read", "click", "close", "remind_later"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function normalizedPath(value) {
  return path.resolve(value).replaceAll("\\", "/").replace(/\/$/u, "");
}

function argumentValue(args, prefix, fallback) {
  const matches = args.filter((value) => value.startsWith(prefix));
  assert.ok(matches.length <= 1, `DUPLICATE_ARGUMENT:${prefix}`);
  const value = matches.length === 1 ? matches[0].slice(prefix.length).trim() : fallback;
  assert.ok(value, `EMPTY_ARGUMENT:${prefix}`);
  return value;
}

function parseArguments(args) {
  for (const value of args) {
    const known = ALLOWED_ARGUMENTS.has(value)
      || ALLOWED_ARGUMENT_PREFIXES.some((prefix) => value.startsWith(prefix));
    assert.ok(known, `UNKNOWN_ARGUMENT:${value}`);
  }
  const execute = args.includes("--execute");
  const rollbackReapply = args.includes("--rollback-reapply");
  assert.equal(execute, rollbackReapply, "WRITE_REQUIRES_EXECUTE_AND_ROLLBACK_REAPPLY");
  const parsed = {
    execute,
    agentId: argumentValue(args, "--agent-id=", DEFAULTS.agentId),
    agentName: argumentValue(args, "--agent-name=", DEFAULTS.agentName),
    expectedFromId: argumentValue(args, "--expected-from-id=", DEFAULTS.expectedFromId),
    targetId: argumentValue(args, "--target-id=", DEFAULTS.targetId),
  };
  assert.notEqual(parsed.expectedFromId, parsed.targetId, "SOURCE_AND_TARGET_MODEL_MUST_DIFFER");
  return parsed;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sorted(item)]));
}

function sortRows(rows) {
  return [...rows].sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")));
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => !isDeepStrictEqual(before?.[key], after?.[key])).sort();
}

function assertOnlyAllowedChanges(before, after, allowed, label, required = []) {
  const changes = changedKeys(before, after);
  for (const key of changes) assert.ok(allowed.has(key), `${label}:UNEXPECTED_CHANGE:${key}`);
  for (const key of required) assert.ok(changes.includes(key), `${label}:REQUIRED_CHANGE_MISSING:${key}`);
  return changes;
}

function rowsById(rows) {
  return new Map((rows || []).map((row) => [String(row.id), row]));
}

function assertNonTargetRowsUnchanged(beforeRows, afterRows, targetId, label) {
  const before = rowsById(beforeRows);
  const after = rowsById(afterRows);
  assert.equal(after.size, before.size, `${label}:ROW_COUNT_CHANGED`);
  for (const [id, row] of before) {
    assert.ok(after.has(id), `${label}:ROW_REMOVED:${id}`);
    if (id !== targetId) assert.deepEqual(after.get(id), row, `${label}:NON_TARGET_CHANGED:${id}`);
  }
}

function redactString(value, secrets) {
  let result = String(value);
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "<redacted>");
  }
  return result.replace(/Bearer\s+[^\s"']+/giu, "Bearer <redacted>");
}

function sanitize(value, secrets, key = "") {
  if (key !== "api_key_configured" && SENSITIVE_KEY.test(key)) return "<redacted>";
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
    childKey,
    sanitize(item, secrets, childKey),
  ]));
}

function publicAgentBindingSummary(agents) {
  return agents.map((agent) => ({
    id: String(agent.id),
    name: String(agent.name || ""),
    source: String(agent.source || ""),
    active: agent.is_active !== false,
    userAccess: String(agent.user_access || ""),
    modelId: agent.model_id == null ? null : String(agent.model_id),
    model: String(agent.model || ""),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

async function readJsonFile(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

function extractSingleStorageKey(source, property) {
  const pattern = new RegExp(`\\b${property}:\\s*"([^"]+)"`, "gu");
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `STORAGE_KEY_CONTRACT_NOT_UNIQUE:${property}`);
  return matches[0][1];
}

async function readBrowserStorageContract() {
  const storageKeysPath = path.resolve("src/lib/storage-keys.ts");
  const entryGuardPath = path.resolve("src/app/page.tsx");
  const [storageKeysSource, entryGuardSource] = await Promise.all([
    fs.readFile(storageKeysPath, "utf8"),
    fs.readFile(entryGuardPath, "utf8"),
  ]);
  const authToken = extractSingleStorageKey(storageKeysSource, "AUTH_TOKEN");
  const authUser = extractSingleStorageKey(storageKeysSource, "AUTH_USER");
  const entryMatches = [...entryGuardSource.matchAll(/sessionStorage\.getItem\("([^"]+)"\)\s*===\s*"1"/gu)];
  assert.equal(entryMatches.length, 1, "SESSION_ENTRY_GUARD_CONTRACT_NOT_UNIQUE");
  assert.notEqual(authToken, authUser, "AUTH_STORAGE_KEYS_MUST_DIFFER");
  return {
    authToken,
    authUser,
    enteredApp: entryMatches[0][1],
    sources: {
      storageKeys: "src/lib/storage-keys.ts",
      storageKeysSha256: createHash("sha256").update(storageKeysSource).digest("hex"),
      entryGuard: "src/app/page.tsx",
      entryGuardSha256: createHash("sha256").update(entryGuardSource).digest("hex"),
    },
  };
}

async function assertLocalEnvironment(origin) {
  assert.equal(normalizedPath(process.cwd()), normalizedPath(EXACT_PROJECT_ROOT), "EXACT_F_DRIVE_PROJECT_ROOT_REQUIRED");
  assert.equal(origin, EXACT_ORIGIN, "EXACT_LOCAL_RUNTIME_REQUIRED");
  const configuredRuntimePath = String(process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH || EXACT_RUNTIME_PATH).trim();
  assert.equal(normalizedPath(configuredRuntimePath), normalizedPath(EXACT_RUNTIME_PATH), "EXACT_LOCAL_RUNTIME_CONFIG_REQUIRED");
  const runtime = await readJsonFile(configuredRuntimePath);
  assert.equal(runtime.localOnly, true, "LOCAL_ONLY_RUNTIME_REQUIRED");
  assert.ok(String(runtime.instanceId || "").trim(), "LOCAL_INSTANCE_ID_REQUIRED");
  assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
  assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321", "EXACT_LOCAL_REST_REQUIRED");
  assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_RUNTIME_DATABASE_NAME_REQUIRED");
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  assert.equal(runtime.ownerConnection?.user, "zimeiti_owner", "LOCAL_DATABASE_OWNER_REQUIRED");
  if (process.env.COZE_SUPABASE_URL) {
    assert.equal(process.env.COZE_SUPABASE_URL.replace(/\/+$/u, ""), runtime.supabaseUrl, "ENV_LOCAL_REST_MISMATCH");
  }
  if (process.env.DATABASE_URL) {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    assert.equal(databaseUrl.hostname, "127.0.0.1", "ENV_DATABASE_HOST_MISMATCH");
    assert.equal(databaseUrl.port, "54322", "ENV_DATABASE_PORT_MISMATCH");
    assert.equal(databaseUrl.pathname.replace(/^\//u, ""), "zimeiti_local", "ENV_DATABASE_NAME_MISMATCH");
  }
  return runtime;
}

function apiClient(origin, token, stepUpToken, secrets) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-admin-step-up": stepUpToken,
    "Content-Type": "application/json",
  };
  return async function api(pathname, init = {}) {
    const response = await fetch(`${origin}${pathname}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const safeBody = redactString(JSON.stringify(sanitize(body, secrets)), secrets).slice(0, 1200);
      throw new Error(`${pathname}:HTTP_${response.status}:${safeBody}`);
    }
    return { status: response.status, body };
  };
}

async function readDatabaseIdentity(database, runtime) {
  const result = await database.query(`
    SELECT current_database() AS database_name,
           current_user AS database_user,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port
  `);
  const identity = result.rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_LOCAL_DATABASE_NAME_REQUIRED");
  assert.equal(identity.database_user, "zimeiti_owner", "LIVE_LOCAL_DATABASE_OWNER_REQUIRED");
  assert.equal(identity.server_address, "127.0.0.1", "LIVE_LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(identity.server_port), 54322, "LIVE_LOCAL_DATABASE_PORT_REQUIRED");
  return {
    instanceId: String(runtime.instanceId),
    databaseName: identity.database_name,
    databaseUser: identity.database_user,
    serverAddress: identity.server_address,
    serverPort: Number(identity.server_port),
  };
}

async function readDirectAgents(database) {
  const result = await database.query(`
    SELECT id::text AS id, to_jsonb(a) AS row
      FROM public.agents a
     WHERE deleted_at IS NULL
     ORDER BY id
  `);
  return result.rows.map((entry) => ({ id: entry.id, ...entry.row }));
}

async function assertRuntimeBuildIdentity(api) {
  const [{ body: served }, declared, diskBuildId] = await Promise.all([
    api("/api/version"),
    readJsonFile(path.resolve("public/version.json")),
    fs.readFile(path.resolve(".next/BUILD_ID"), "utf8").then((value) => value.trim()),
  ]);
  assert.ok(diskBuildId, "LOCAL_DISK_BUILD_ID_REQUIRED");
  assert.equal(served.buildId, diskBuildId, "SERVED_BUILD_ID_MISMATCH");
  assert.equal(served.sourceVersion, declared.sourceVersion, "SERVED_SOURCE_VERSION_MISMATCH");
  assert.equal(served.sourceDigest, declared.sourceDigest, "SERVED_SOURCE_DIGEST_MISMATCH");
  assert.equal(served.env, "PROD", "LOCAL_STANDALONE_ENVIRONMENT_REQUIRED");
  return {
    buildId: diskBuildId,
    sourceVersion: String(served.sourceVersion),
    sourceDigest: String(served.sourceDigest),
    environment: String(served.env),
  };
}

async function readState(api, database) {
  const [adminResult, botsResult, chatResult, modelsResult, directAgents] = await Promise.all([
    api("/api/admin/agents?include_internal=1&include_configuration=1"),
    api("/api/bots?shape=agents"),
    api("/api/chat-models"),
    api("/api/admin/models"),
    readDirectAgents(database),
  ]);
  return {
    adminAgents: sortRows(Array.isArray(adminResult.body.agents) ? adminResult.body.agents : []),
    bots: sortRows(Array.isArray(botsResult.body.agents) ? botsResult.body.agents : []),
    chatModels: sortRows(Array.isArray(chatResult.body.models) ? chatResult.body.models : []),
    unavailableChatModels: sortRows(Array.isArray(chatResult.body.unavailableModels) ? chatResult.body.unavailableModels : []),
    adminModels: sortRows(Array.isArray(modelsResult.body.models) ? modelsResult.body.models : []),
    directAgents: sortRows(directAgents),
    configurationDataSource: adminResult.body.dataSource || null,
  };
}

function requireUniqueRow(rows, id, label) {
  const matches = rows.filter((row) => String(row.id) === id);
  assert.equal(matches.length, 1, `${label}_MUST_BE_UNIQUE`);
  return matches[0];
}

function assertTextModel(state, id, label) {
  const model = requireUniqueRow(state.adminModels, id, label);
  assert.equal(model.model_type, "text", `${label}_MUST_BE_TEXT`);
  assert.ok(String(model.model_name || "").trim(), `${label}_MODEL_NAME_REQUIRED`);
  return model;
}

function assertModelReady(state, id, label) {
  const model = assertTextModel(state, id, label);
  assert.equal(model.is_active, true, `${label}_MUST_BE_ACTIVE`);
  assert.equal(model.is_hidden, false, `${label}_MUST_BE_VISIBLE`);
  assert.equal(model.user_access, "available", `${label}_MUST_BE_AVAILABLE`);
  assert.equal(model.api_key_configured, true, `${label}_MUST_BE_CONFIGURED`);
  return model;
}

function assertStateBinding(state, args, expectedModel, label, publicModelId = null) {
  const adminAgent = requireUniqueRow(state.adminAgents, args.agentId, `${label}_ADMIN_AGENT`);
  const directAgent = requireUniqueRow(state.directAgents, args.agentId, `${label}_DATABASE_AGENT`);
  const bot = requireUniqueRow(state.bots, args.agentId, `${label}_BOT_AGENT`);
  assert.equal(adminAgent.name, args.agentName, `${label}_ADMIN_AGENT_NAME_MISMATCH`);
  assert.equal(directAgent.name, args.agentName, `${label}_DATABASE_AGENT_NAME_MISMATCH`);
  assert.equal(bot.name, args.agentName, `${label}_BOT_AGENT_NAME_MISMATCH`);
  for (const [surface, row] of [["ADMIN", adminAgent], ["DATABASE", directAgent], ["BOTS", bot]]) {
    assert.equal(String(row.model_id), String(expectedModel.id), `${label}_${surface}_MODEL_ID_MISMATCH`);
    assert.equal(String(row.model), String(expectedModel.model_name), `${label}_${surface}_MODEL_NAME_MISMATCH`);
  }
  const nextPublicModelId = String(bot.model_public_id || "");
  assert.ok(nextPublicModelId, `${label}_BOT_PUBLIC_MODEL_ID_REQUIRED`);
  if (publicModelId) assert.equal(nextPublicModelId, publicModelId, `${label}_PUBLIC_MODEL_ID_DRIFT`);
  const published = state.chatModels.filter((model) => String(model.id) === nextPublicModelId);
  assert.equal(published.length, 1, `${label}_BOUND_MODEL_MUST_BE_UNIQUE_IN_CHAT_MODELS`);
  assert.equal(state.unavailableChatModels.some((model) => String(model.id) === nextPublicModelId), false,
    `${label}_BOUND_MODEL_MUST_NOT_BE_UNAVAILABLE`);
  return { adminAgent, directAgent, bot, publicModelId: nextPublicModelId };
}

function assertTransition(before, after, args, expectedModel, label, publicModelId = null) {
  assertNonTargetRowsUnchanged(before.directAgents, after.directAgents, args.agentId, `${label}:DATABASE`);
  assertNonTargetRowsUnchanged(before.adminAgents, after.adminAgents, args.agentId, `${label}:ADMIN`);
  assertNonTargetRowsUnchanged(before.bots, after.bots, args.agentId, `${label}:BOTS`);
  assert.deepEqual(after.adminModels, before.adminModels, `${label}:MODEL_CONFIGURATION_CHANGED`);
  assert.deepEqual(after.chatModels, before.chatModels, `${label}:CHAT_MODEL_CATALOG_CHANGED`);
  assert.deepEqual(after.unavailableChatModels, before.unavailableChatModels, `${label}:UNAVAILABLE_CATALOG_CHANGED`);
  const binding = assertStateBinding(after, args, expectedModel, label, publicModelId);
  const databaseChanges = assertOnlyAllowedChanges(
    requireUniqueRow(before.directAgents, args.agentId, `${label}_BEFORE_DATABASE_AGENT`),
    binding.directAgent,
    TARGET_DATABASE_ALLOWED_CHANGES,
    `${label}:DATABASE_TARGET`,
    ["model", "model_id", "updated_at"],
  );
  const adminChanges = assertOnlyAllowedChanges(
    requireUniqueRow(before.adminAgents, args.agentId, `${label}_BEFORE_ADMIN_AGENT`),
    binding.adminAgent,
    TARGET_ADMIN_ALLOWED_CHANGES,
    `${label}:ADMIN_TARGET`,
    ["model", "model_id"],
  );
  const botsChanges = assertOnlyAllowedChanges(
    requireUniqueRow(before.bots, args.agentId, `${label}_BEFORE_BOT_AGENT`),
    binding.bot,
    TARGET_BOTS_ALLOWED_CHANGES,
    `${label}:BOTS_TARGET`,
    ["model", "model_id", "model_public_id"],
  );
  return { binding, databaseChanges, adminChanges, botsChanges };
}

async function putBinding(api, agentId, modelId) {
  const result = await api("/api/admin/agents", {
    method: "PUT",
    body: JSON.stringify({ agentId, model_id: modelId }),
  });
  assert.equal(result.body.success, true, "MINIMAL_BINDING_UPDATE_NOT_ACKNOWLEDGED");
  return { status: result.status, success: true };
}

function announcementEventSummary(request, token, secrets) {
  try {
    const payload = JSON.parse(request.postData() || "{}");
    assert.ok(payload && typeof payload === "object" && !Array.isArray(payload), "ANNOUNCEMENT_EVENT_OBJECT_REQUIRED");
    assert.deepEqual(
      Object.keys(payload).sort(),
      ["event", "eventKey", "id", "pushRevision"],
      "ANNOUNCEMENT_EVENT_EXACT_FIELDS_REQUIRED",
    );
    assert.match(payload.id, UUID_PATTERN, "ANNOUNCEMENT_EVENT_ID_REQUIRED");
    assert.ok(ANNOUNCEMENT_EVENT_TYPES.has(payload.event), `ANNOUNCEMENT_EVENT_TYPE_REQUIRED:${payload.event}`);
    assert.ok(Number.isInteger(payload.pushRevision) && payload.pushRevision > 0, "ANNOUNCEMENT_EVENT_REVISION_REQUIRED");
    assert.equal(
      payload.eventKey,
      `announcement:${payload.id}:r${payload.pushRevision}:${payload.event}:v1`,
      "ANNOUNCEMENT_EVENT_KEY_CONTRACT_REQUIRED",
    );
    assert.match(request.headers()["content-type"] || "", /^application\/json(?:;|$)/iu,
      "ANNOUNCEMENT_EVENT_JSON_REQUIRED");
    assert.equal(request.headers().authorization, `Bearer ${token}`, "ANNOUNCEMENT_EVENT_AUTH_MISMATCH");
    return {
      id: payload.id,
      event: payload.event,
      revision: payload.pushRevision,
      eventKey: payload.eventKey,
      contractValid: true,
      intercepted: true,
      serverReached: false,
    };
  } catch (error) {
    return {
      contractValid: false,
      intercepted: true,
      serverReached: false,
      error: redactString(error instanceof Error ? `${error.name}:${error.message}` : String(error), secrets),
    };
  }
}

async function uiSelectorReadback({
  origin,
  token,
  stepUpToken,
  identity,
  storageContract,
  args,
  expectedModelId,
  screenshotPath,
  secrets,
}) {
  assert.ok(identity?.user?.id, "LOCAL_NAV_READONLY_IDENTITY_USER_REQUIRED");
  assert.ok(["admin", "super_admin"].includes(String(identity.user.role || "")),
    "LOCAL_NAV_READONLY_IDENTITY_ADMIN_REQUIRED");
  const report = {
    viewport: { width: 1440, height: 900 },
    selectedModelId: null,
    selectedModelLabel: null,
    pageUrl: null,
    screenshot: screenshotPath ? path.relative(process.cwd(), screenshotPath).replaceAll("\\", "/") : null,
    storageContract,
    blockedExternalRequests: 0,
    unexpectedWriteRequests: [],
    announcementEventTelemetry: {
      interceptedCount: 0,
      eventSummaries: [],
      serverReached: false,
    },
    pageErrors: [],
    consoleErrors: [],
    failedResponses: [],
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: report.viewport,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      serviceWorkers: "block",
      extraHTTPHeaders: { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUpToken },
    });
    await context.addInitScript(({ sessionToken, user, keys }) => {
      localStorage.setItem(keys.authToken, sessionToken);
      localStorage.setItem(keys.authUser, JSON.stringify(user));
      sessionStorage.setItem(keys.enteredApp, "1");
    }, { sessionToken: token, user: identity.user, keys: storageContract });
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch { await route.continue(); return; }
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
        report.blockedExternalRequests += 1;
        await route.abort("blockedbyclient");
        return;
      }
      if (url.origin === origin && request.method() === "POST" && url.pathname === "/api/announcements/events") {
        const summary = announcementEventSummary(request, token, secrets);
        report.announcementEventTelemetry.eventSummaries.push(summary);
        report.announcementEventTelemetry.interceptedCount += 1;
        await route.fulfill({
          status: summary.contractValid ? 200 : 400,
          contentType: "application/json",
          headers: {
            "Cache-Control": "no-store",
            "X-Codex-Announcement-Event-Intercepted": "true",
          },
          body: JSON.stringify(summary.contractValid
            ? { success: true, recorded: false, alreadyRecorded: true }
            : { success: false, code: "ANNOUNCEMENT_EVENT_CONTRACT_INVALID" }),
        });
        return;
      }
      if (url.origin === origin && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        report.unexpectedWriteRequests.push({ method: request.method(), pathname: url.pathname });
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400) {
        report.failedResponses.push({ status: response.status(), pathname: url.pathname });
      }
    });
    const response = await page.goto(`${origin}/admin?tab=agents&view=overview`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    assert.equal(response?.status(), 200, "ADMIN_AGENTS_PAGE_HTTP_200_REQUIRED");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    report.pageUrl = page.url();
    assert.equal(new URL(report.pageUrl).origin, origin, "ADMIN_PAGE_LEFT_LOCAL_RUNTIME");
    assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), report.viewport,
      "ADMIN_PAGE_1440X900_REQUIRED");
    const exactName = page.getByText(args.agentName, { exact: true });
    const rows = page.locator("tr").filter({ has: exactName });
    await rows.first().waitFor({ state: "visible", timeout: 25_000 });
    assert.equal(await rows.count(), 1, "UI_AGENT_ROW_NOT_UNIQUE");
    const editButtons = rows.getByRole("button", { name: "编辑", exact: true });
    assert.equal(await editButtons.count(), 1, "UI_AGENT_EDIT_BUTTON_NOT_UNIQUE");
    await editButtons.click();
    const selectors = page.locator('[data-testid="admin-agent-model-select"]');
    await selectors.first().waitFor({ state: "visible", timeout: 25_000 });
    assert.equal(await selectors.count(), 1, "UI_MODEL_SELECTOR_NOT_UNIQUE");
    const options = selectors.locator(`option[value="${expectedModelId}"]`);
    assert.equal(await options.count(), 1, "UI_EXPECTED_MODEL_OPTION_NOT_UNIQUE");
    report.selectedModelId = await selectors.inputValue();
    report.selectedModelLabel = String(await selectors.locator("option:checked").textContent() || "").trim();
    assert.equal(report.selectedModelId, expectedModelId, "UI_MODEL_SELECTOR_READBACK_MISMATCH");
    assert.ok(report.selectedModelLabel, "UI_MODEL_SELECTOR_LABEL_REQUIRED");
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
    assert.ok(report.announcementEventTelemetry.interceptedCount > 0,
      "ANNOUNCEMENT_EVENT_INTERCEPTION_EVIDENCE_REQUIRED");
    for (const [index, summary] of report.announcementEventTelemetry.eventSummaries.entries()) {
      assert.equal(summary.contractValid, true, `ANNOUNCEMENT_EVENT_CONTRACT_INVALID:${index}`);
      assert.equal(summary.intercepted, true, `ANNOUNCEMENT_EVENT_MUST_BE_INTERCEPTED:${index}`);
      assert.equal(summary.serverReached, false, `ANNOUNCEMENT_EVENT_SERVER_MUST_NOT_BE_REACHED:${index}`);
    }
    report.announcementEventTelemetry.serverReached = report.announcementEventTelemetry.eventSummaries
      .some((summary) => summary.serverReached !== false);
    assert.equal(report.announcementEventTelemetry.serverReached, false,
      "ANNOUNCEMENT_EVENT_SERVER_MUST_NOT_BE_REACHED");
    assert.deepEqual(report.unexpectedWriteRequests, [], "UI_READBACK_ATTEMPTED_WRITE");
    assert.deepEqual(report.pageErrors, [], "UI_PAGE_ERRORS_PRESENT");
    assert.deepEqual(report.consoleErrors, [], "UI_CONSOLE_ERRORS_PRESENT");
    assert.deepEqual(report.failedResponses, [], "UI_FAILED_RESPONSES_PRESENT");
    return report;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

async function writeEvidence(evidencePath, report, secrets) {
  const safeReport = sanitize(report, secrets);
  const serialized = `${JSON.stringify(safeReport, null, 2)}\n`;
  for (const secret of secrets) {
    assert.equal(secret ? serialized.includes(secret) : false, false, "EVIDENCE_CONTAINS_RUNTIME_SECRET");
  }
  await fs.writeFile(evidencePath, serialized, { flag: "wx" });
}

function phaseEvidence(label, state, agentId, transition = null) {
  return {
    label,
    bindingsSha256: sha256(publicAgentBindingSummary(state.adminAgents)),
    databaseRowsSha256: sha256(state.directAgents),
    botsSha256: sha256(state.bots),
    chatCatalogSha256: sha256({ models: state.chatModels, unavailableModels: state.unavailableChatModels }),
    targetAdminBinding: state.adminAgents.find((agent) => String(agent.id) === agentId)
      ? publicAgentBindingSummary(state.adminAgents.filter((agent) => String(agent.id) === agentId))[0]
      : null,
    ...(transition ? {
      changedKeys: {
        database: transition.databaseChanges,
        admin: transition.adminChanges,
        bots: transition.botsChanges,
      },
      nonTargetUnchanged: true,
    } : {}),
  };
}

async function main(rawArgs = process.argv.slice(2)) {
  const args = parseArguments(rawArgs);
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  const secrets = [token, stepUpToken].filter(Boolean);
  assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.ok(stepUpToken, "LOCAL_ADMIN_STEP_UP_TOKEN_REQUIRED");
  const identity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}"));
  const runtime = await assertLocalEnvironment(origin);
  const browserStorageContract = await readBrowserStorageContract();
  const api = apiClient(origin, token, stepUpToken, secrets);
  const database = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-rebind-single-agent-model-live",
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
  });
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(4).toString("hex")}`;
  const evidenceDir = path.resolve(".codex-evidence/agent-model-rebind", runId);
  const evidencePath = path.join(evidenceDir, "report.json");
  const screenshotPath = path.join(evidenceDir, "admin-agent-model-selector.png");
  const report = {
    schemaVersion: 1,
    mode: args.execute ? "execute-rollback-reapply" : "plan",
    passed: false,
    checkedAt: null,
    target: {
      agentId: args.agentId,
      agentName: args.agentName,
      expectedFromId: args.expectedFromId,
      targetId: args.targetId,
    },
    environment: null,
    runtimeBuild: null,
    browserStorageContract,
    allAgentBindingSummary: null,
    targetAgentFullConfiguration: null,
    targetModelFullConfiguration: null,
    phases: [],
    uiReadback: null,
    writes: { requested: args.execute, putCount: 0, payloadShape: ["agentId", "model_id"] },
    cleanup: { required: false, attempted: false, restored: null, readback: null, error: null },
    failure: null,
    evidencePath: args.execute ? path.relative(process.cwd(), evidencePath).replaceAll("\\", "/") : null,
  };
  let mutationAttempted = false;
  let complete = false;
  try {
    await database.connect();
    report.environment = await readDatabaseIdentity(database, runtime);
    report.runtimeBuild = await assertRuntimeBuildIdentity(api);
    const baseline = await readState(api, database);
    assert.ok(["local", "local-acceptance"].includes(baseline.configurationDataSource?.configuration),
      "ADMIN_CONFIGURATION_SOURCE_MUST_BE_LOCAL");
    assert.equal(baseline.configurationDataSource?.businessData, "local", "ADMIN_BUSINESS_DATA_SOURCE_MUST_BE_LOCAL");
    const expectedModel = assertTextModel(baseline, args.expectedFromId, "EXPECTED_FROM_MODEL");
    const targetModel = assertModelReady(baseline, args.targetId, "TARGET_MODEL");
    const baselineBinding = assertStateBinding(baseline, args, expectedModel, "BASELINE");
    assert.equal(baselineBinding.directAgent.model_id, args.expectedFromId, "EXPECTED_FROM_BINDING_REQUIRED");
    report.allAgentBindingSummary = publicAgentBindingSummary(baseline.adminAgents);
    report.targetAgentFullConfiguration = baselineBinding.adminAgent;
    report.targetModelFullConfiguration = targetModel;
    report.models = {
      expectedFrom: { id: expectedModel.id, name: expectedModel.name, modelName: expectedModel.model_name },
      target: { id: targetModel.id, name: targetModel.name, modelName: targetModel.model_name },
    };
    report.phases.push(phaseEvidence("baseline", baseline, args.agentId));

    if (!args.execute) {
      report.uiReadback = await uiSelectorReadback({
        origin, token, stepUpToken, identity, storageContract: browserStorageContract, args,
        expectedModelId: args.expectedFromId,
        screenshotPath: null,
        secrets,
      });
      report.plan = [
        "PUT target binding with minimal payload",
        "verify admin agents, bots, chat models, database diff, and non-target stability",
        "PUT original binding with minimal payload and verify rollback",
        "PUT target binding again and verify final state",
        "refresh 1440x900 admin agents page, isolate exact announcement telemetry, and read the exact model selector value",
        "on any post-mutation failure, best-effort restore the original binding and read it back",
      ];
      report.passed = true;
      report.checkedAt = new Date().toISOString();
      console.log(JSON.stringify(sanitize(report, secrets), null, 2));
      return;
    }

    await fs.mkdir(evidenceDir, { recursive: true });
    mutationAttempted = true;
    report.writes.putCount += 1;
    report.writes.applyTarget = await putBinding(api, args.agentId, args.targetId);
    const targetState = await readState(api, database);
    const targetTransition = assertTransition(baseline, targetState, args, targetModel, "APPLY_TARGET");
    report.phases.push(phaseEvidence("apply-target", targetState, args.agentId, targetTransition));

    report.writes.putCount += 1;
    report.writes.rollbackOriginal = await putBinding(api, args.agentId, args.expectedFromId);
    const rollbackState = await readState(api, database);
    const rollbackTransition = assertTransition(
      targetState,
      rollbackState,
      args,
      expectedModel,
      "ROLLBACK_ORIGINAL",
      baselineBinding.publicModelId,
    );
    assertNonTargetRowsUnchanged(baseline.directAgents, rollbackState.directAgents, args.agentId, "ROLLBACK_BASELINE_DATABASE");
    assert.deepEqual(
      Object.fromEntries(Object.entries(requireUniqueRow(rollbackState.directAgents, args.agentId, "ROLLBACK_DATABASE_AGENT"))
        .filter(([key]) => key !== "updated_at")),
      Object.fromEntries(Object.entries(baselineBinding.directAgent).filter(([key]) => key !== "updated_at")),
      "ROLLBACK_DID_NOT_RESTORE_ORIGINAL_CONFIGURATION",
    );
    report.phases.push(phaseEvidence("rollback-original", rollbackState, args.agentId, rollbackTransition));

    report.writes.putCount += 1;
    report.writes.reapplyTarget = await putBinding(api, args.agentId, args.targetId);
    const finalState = await readState(api, database);
    const finalTransition = assertTransition(rollbackState, finalState, args, targetModel, "REAPPLY_TARGET");
    assertNonTargetRowsUnchanged(baseline.directAgents, finalState.directAgents, args.agentId, "FINAL_BASELINE_DATABASE");
    assert.deepEqual(
      Object.fromEntries(Object.entries(requireUniqueRow(finalState.directAgents, args.agentId, "FINAL_DATABASE_AGENT"))
        .filter(([key]) => key !== "updated_at")),
      Object.fromEntries(Object.entries(targetTransition.binding.directAgent).filter(([key]) => key !== "updated_at")),
      "FINAL_TARGET_CONFIGURATION_DIFFERS_FROM_FIRST_TARGET_APPLICATION",
    );
    report.phases.push(phaseEvidence("reapply-target", finalState, args.agentId, finalTransition));
    report.uiReadback = await uiSelectorReadback({
      origin, token, stepUpToken, identity, storageContract: browserStorageContract, args,
      expectedModelId: args.targetId,
      screenshotPath,
      secrets,
    });
    report.passed = true;
    report.checkedAt = new Date().toISOString();
    await writeEvidence(evidencePath, report, secrets);
    complete = true;
  } catch (error) {
    report.failure = redactString(error instanceof Error ? `${error.name}:${error.message}` : String(error), secrets);
    throw error;
  } finally {
    if (args.execute && mutationAttempted && !complete) {
      report.cleanup.required = true;
      report.cleanup.attempted = true;
      try {
        report.writes.putCount += 1;
        await putBinding(api, args.agentId, args.expectedFromId);
        const restoredState = await readState(api, database);
        const restoredModel = assertTextModel(restoredState, args.expectedFromId, "CLEANUP_EXPECTED_MODEL");
        const restored = assertStateBinding(restoredState, args, restoredModel, "CLEANUP_READBACK");
        report.cleanup.restored = true;
        report.cleanup.readback = {
          agentId: restored.directAgent.id,
          name: restored.directAgent.name,
          modelId: restored.directAgent.model_id,
          model: restored.directAgent.model,
          publicModelId: restored.publicModelId,
        };
      } catch (cleanupError) {
        report.cleanup.restored = false;
        report.cleanup.error = redactString(
          cleanupError instanceof Error ? `${cleanupError.name}:${cleanupError.message}` : String(cleanupError),
          secrets,
        );
      }
    }
    await database.end().catch(() => undefined);
    if (args.execute && !complete) {
      report.checkedAt ||= new Date().toISOString();
      await fs.mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
      await writeEvidence(evidencePath, report, secrets).catch((evidenceError) => {
        process.stderr.write(`EVIDENCE_WRITE_FAILED:${redactString(evidenceError.message, secrets)}\n`);
      });
    }
  }
  console.log(JSON.stringify(sanitize(report, secrets), null, 2));
}

main().catch((error) => {
  const secrets = [process.env.LOCAL_NAV_ADMIN_TOKEN, process.env.LOCAL_ADMIN_STEP_UP_TOKEN].filter(Boolean);
  process.stderr.write(`${redactString(error instanceof Error ? `${error.name}:${error.message}` : String(error), secrets)}\n`);
  process.exitCode = 1;
});
