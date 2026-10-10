import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLIENT_BOOTSTRAP_CACHE_TTL_MS,
  ClientBootstrapRequestInvalidatedError,
  getClientBootstrapAgentCatalog,
  getClientBootstrapAuthMe,
  getClientBootstrapLayout,
  getClientBootstrapSettings,
  invalidateClientBootstrapAuthMe,
  invalidateClientBootstrapAgentCatalog,
  invalidateClientBootstrapCache,
  invalidateClientBootstrapLayout,
} from "../src/lib/client-bootstrap-cache";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function bearerToken(init?: RequestInit): string | null {
  const value = new Headers(init?.headers).get("authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : null;
}

function installFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = handler as typeof fetch;
}

async function verifySettingsSingleFlightAndTtl(advanceNow: (amount: number) => void): Promise<number> {
  invalidateClientBootstrapCache();
  const firstResponse = deferred<Response>();
  let calls = 0;

  installFetch(async (input) => {
    assert.equal(requestUrl(input), "/api/settings");
    calls += 1;
    if (calls === 1) return firstResponse.promise;
    return jsonResponse({ settings: { theme: `settings-${calls}` } });
  });

  const first = getClientBootstrapSettings();
  const second = getClientBootstrapSettings();
  const forcedWhilePending = getClientBootstrapSettings({ force: true });
  assert.equal(calls, 1, "settings concurrent/bootstrap force callers must share one in-flight fetch");

  // TTL must begin when the response completes, not when its slow request starts.
  advanceNow(20_000);
  firstResponse.resolve(jsonResponse({ settings: { theme: "settings-1" } }));
  const firstBodies = await Promise.all([
    first.then((response) => response.json()),
    second.then((response) => response.json()),
    forcedWhilePending.then((response) => response.json()),
  ]);
  assert.deepEqual(
    firstBodies.map((body) => body.settings.theme),
    ["settings-1", "settings-1", "settings-1"],
    "each settings consumer must receive an independently readable response clone",
  );

  await getClientBootstrapSettings();
  assert.equal(calls, 1, "settings must hit the short settled cache inside the TTL");
  advanceNow(CLIENT_BOOTSTRAP_CACHE_TTL_MS - 1);
  await getClientBootstrapSettings();
  assert.equal(calls, 1, "settings cache must remain valid until completion time plus TTL");

  advanceNow(2);
  const expired = await getClientBootstrapSettings();
  assert.equal((await expired.json()).settings.theme, "settings-2");
  assert.equal(calls, 2, "expired settings must fetch again");

  const forced = await getClientBootstrapSettings({ force: true });
  assert.equal((await forced.json()).settings.theme, "settings-3");
  assert.equal(calls, 3, "explicit settings refresh must bypass a settled TTL value");

  const forceOne = getClientBootstrapSettings({ force: true });
  const forceTwo = getClientBootstrapSettings({ force: true });
  await Promise.all([forceOne, forceTwo]);
  assert.equal(calls, 4, "simultaneous explicit settings refreshes must remain single-flight");
  return 9;
}

async function verifyRetryAfterTransportFailure(): Promise<number> {
  invalidateClientBootstrapCache();
  let calls = 0;
  let shouldFail = true;
  installFetch(async () => {
    calls += 1;
    if (shouldFail) throw new Error("offline transport fixture");
    return jsonResponse({ settings: { theme: "recovered" } });
  });

  const outcomes = await Promise.allSettled([
    getClientBootstrapSettings(),
    getClientBootstrapSettings(),
  ]);
  assert.deepEqual(outcomes.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(calls, 1, "concurrent transport failures must still use one request");

  shouldFail = false;
  const recovered = await getClientBootstrapSettings();
  assert.equal((await recovered.json()).settings.theme, "recovered");
  assert.equal(calls, 2, "a transport rejection must not poison the retry cache");

  invalidateClientBootstrapCache();
  let httpCalls = 0;
  installFetch(async () => {
    httpCalls += 1;
    return httpCalls === 1
      ? jsonResponse({ error: "temporary" }, 503)
      : jsonResponse({ settings: { theme: "http-recovered" } });
  });
  assert.equal((await getClientBootstrapSettings()).status, 503);
  assert.equal((await (await getClientBootstrapSettings()).json()).settings.theme, "http-recovered");
  assert.equal(httpCalls, 2, "a non-2xx response must be shared only in flight and remain immediately retryable");
  return 7;
}

async function verifyAuthTokenIsolation(): Promise<number> {
  invalidateClientBootstrapCache();
  const calls: string[] = [];
  installFetch(async (input, init) => {
    assert.equal(requestUrl(input), "/api/auth/me");
    const token = bearerToken(init);
    assert.ok(token, "auth bootstrap request must carry its Bearer token");
    calls.push(token);
    return jsonResponse({ user: { id: `user-for-${token}` } });
  });

  const tokenAOne = getClientBootstrapAuthMe("token-a");
  const tokenATwo = getClientBootstrapAuthMe("token-a", { force: true });
  const tokenABodies = await Promise.all([
    tokenAOne.then((response) => response.json()),
    tokenATwo.then((response) => response.json()),
  ]);
  assert.equal(calls.length, 1, "same-token auth callers must share one in-flight request");
  assert.deepEqual(tokenABodies.map((body) => body.user.id), ["user-for-token-a", "user-for-token-a"]);

  await getClientBootstrapAuthMe("token-a");
  assert.equal(calls.length, 1, "same-token ordinary bootstrap read must hit the short cache");
  await getClientBootstrapAuthMe("token-a", { force: true });
  assert.equal(calls.length, 2, "explicit auth check must bypass a settled cache");

  const tokenB = await getClientBootstrapAuthMe("token-b");
  assert.equal((await tokenB.json()).user.id, "user-for-token-b");
  assert.equal(calls.length, 3, "changing token must create a new auth request");

  const tokenAAgain = await getClientBootstrapAuthMe("token-a");
  assert.equal((await tokenAAgain.json()).user.id, "user-for-token-a");
  assert.equal(calls.length, 4, "switching back must not resurrect the previous user's cached response");

  invalidateClientBootstrapAuthMe();
  await getClientBootstrapAuthMe("token-a");
  assert.equal(calls.length, 5, "logout/auth invalidation must evict even the same token scope");
  return 8;
}

async function verifyLateAuthResponseCannotCrossToken(): Promise<number> {
  invalidateClientBootstrapCache();
  const tokenAResponse = deferred<Response>();
  const tokenBResponse = deferred<Response>();
  let calls = 0;

  installFetch(async (_input, init) => {
    calls += 1;
    const token = bearerToken(init);
    if (token === "token-a") return tokenAResponse.promise;
    if (token === "token-b") return tokenBResponse.promise;
    throw new Error("unexpected auth token fixture");
  });

  const staleTokenA = getClientBootstrapAuthMe("token-a");
  const currentTokenB = getClientBootstrapAuthMe("token-b");
  const staleAssertion = assert.rejects(
    staleTokenA,
    (error: unknown) => error instanceof ClientBootstrapRequestInvalidatedError,
    "a late response for the previous token must be rejected as stale",
  );

  tokenBResponse.resolve(jsonResponse({ user: { id: "user-b" } }));
  assert.equal((await (await currentTokenB).json()).user.id, "user-b");
  tokenAResponse.resolve(jsonResponse({ user: { id: "user-a" } }));
  await staleAssertion;

  const cachedTokenB = await getClientBootstrapAuthMe("token-b");
  assert.equal((await cachedTokenB.json()).user.id, "user-b");
  assert.equal(calls, 2, "late token A completion must not overwrite or evict token B's slot");
  return 4;
}

async function verifyLayoutFreshnessContract(): Promise<number> {
  invalidateClientBootstrapCache();
  let calls = 0;
  installFetch(async (input) => {
    assert.equal(requestUrl(input), "/api/settings/layout");
    calls += 1;
    return jsonResponse({ layout: { revision: calls } });
  });

  const first = getClientBootstrapLayout();
  const second = getClientBootstrapLayout();
  const initialBodies = await Promise.all([
    first.then((response) => response.json()),
    second.then((response) => response.json()),
  ]);
  assert.deepEqual(initialBodies.map((body) => body.layout.revision), [1, 1]);
  assert.equal(calls, 1, "layout Strict Mode/bootstrap callers must share one request");

  await getClientBootstrapLayout();
  assert.equal(calls, 1, "layout mount remount may reuse the short bootstrap value");
  const refreshed = await getClientBootstrapLayout({ force: true });
  assert.equal((await refreshed.json()).layout.revision, 2);
  assert.equal(calls, 2, "visibility/interval/public layout refresh must bypass settled cache");

  invalidateClientBootstrapLayout();
  const afterSave = await getClientBootstrapLayout();
  assert.equal((await afterSave.json()).layout.revision, 3);
  assert.equal(calls, 3, "layout save/reset invalidation must force a subsequent fresh read");
  return 6;
}

async function verifyAgentCatalogCoalescing(): Promise<number> {
  invalidateClientBootstrapCache();
  const calls: Array<string | null> = [];
  installFetch(async (input, init) => {
    assert.equal(requestUrl(input), "/api/bots?shape=agents");
    calls.push(bearerToken(init));
    return jsonResponse({ agents: [{ id: calls.at(-1) || "guest" }] });
  });

  const [first, second] = await Promise.all([
    getClientBootstrapAgentCatalog("token-a"),
    getClientBootstrapAgentCatalog("token-a"),
  ]);
  assert.deepEqual(
    await Promise.all([first.json(), second.json()]),
    [{ agents: [{ id: "token-a" }] }, { agents: [{ id: "token-a" }] }],
  );
  assert.equal(calls.length, 1, "catalog consumers for one token must share one request");

  await getClientBootstrapAgentCatalog("token-a");
  assert.equal(calls.length, 1, "catalog remount must reuse the short token-scoped value");
  await getClientBootstrapAgentCatalog("token-b");
  assert.deepEqual(calls, ["token-a", "token-b"], "a token switch must fetch an isolated catalog");
  await getClientBootstrapAgentCatalog(null);
  assert.deepEqual(calls, ["token-a", "token-b", null], "guest catalog must use its own scope");
  invalidateClientBootstrapAgentCatalog();
  await getClientBootstrapAgentCatalog(null);
  assert.equal(calls.length, 4, "catalog invalidation must force a fresh request");
  return 7;
}

function verifySourceWiring(): number {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const readSource = (relativePath: string) => readFileSync(`${projectRoot}/${relativePath}`, "utf8");
  const themeInit = readSource("src/components/theme-init.tsx");
  const appContext = readSource("src/contexts/app-context.tsx");
  const adminPage = readSource("src/app/admin/page.tsx");
  const marketplace = readSource("src/components/agent-marketplace.tsx");
  const cacheModule = readSource("src/lib/client-bootstrap-cache.ts");

  assert.match(themeInit, /from "@\/lib\/client-bootstrap-cache"/, "ThemeInit must use the shared module");
  assert.match(themeInit, /getClientBootstrapAppearance\(\{ force \}\)/, "ThemeInit must route appearance through the shared helper");
  assert.match(themeInit, /handleThemeUpdated[\s\S]{0,240}syncThemeColors\(true\)/, "ThemeInit must join the fresh event read");
  assert.doesNotMatch(themeInit, /invalidateClientBootstrapAppearance/, "ThemeInit must not invalidate the shared event request");
  assert.doesNotMatch(themeInit, /fetch\(\s*["']\/api\/settings\/appearance["']/, "ThemeInit must not directly fetch appearance");
  assert.match(themeInit, /if \(!cancelled\) \{[\s\S]{0,100}applyThemeColorSettings/, "ThemeInit must retain its unmount guard");

  assert.match(appContext, /getClientBootstrapAppearance\(\{ force \}\)/, "AppProvider theme bootstrap must share appearance");
  assert.match(appContext, /getClientBootstrapAuthMe\(token\)/, "AppProvider theme bootstrap must share auth/me");
  assert.match(
    appContext,
    /const meData = await meRes\.json\(\);[\s\S]{0,120}safeGet\(STORAGE_KEYS\.AUTH_TOKEN\) !== token/,
    "theme bootstrap must re-check the token after parsing auth/me and before storing a preference",
  );
  assert.match(appContext, /getClientBootstrapAuthMe\(token, \{ force \}\)/, "checkAuth must use the shared auth helper");
  assert.match(appContext, /checkAuthInFlightRef/, "the complete auth plus credits workflow must be single-flight");
  assert.match(
    appContext,
    /checkAuthInFlightRef\.current\?\.token === requestToken/,
    "the complete checkAuth workflow must only join an in-flight request for the same token",
  );
  assert.match(appContext, /checkAuth\(\{ force: false \}\)/, "mount auth check must join the bootstrap request");
  assert.match(appContext, /getClientBootstrapAuthMe\(token, \{ force: true \}\)/, "30-second auth checks must remain fresh");
  assert.match(appContext, /persistStoredAuthSession[\s\S]*invalidateClientBootstrapAuthMe\(\)/, "token writes must invalidate prior auth data");
  assert.match(appContext, /clearStoredAuthSession[\s\S]*invalidateClientBootstrapAuthMe\(\)/, "logout and auth failures must invalidate auth data");
  assert.doesNotMatch(appContext, /safeRemove\(["']auth_(?:token|user)["']\)/, "auth removal must not bypass the invalidating helper");
  assert.match(
    appContext,
    /handleAuthStorageChange[\s\S]{0,400}clearConversationCache\(\);[\s\S]{0,120}dispatch\(\{ type: "LOGOUT" \}\)/,
    "cross-tab token changes must clear the previous user's in-memory state before re-authentication",
  );
  assert.match(
    appContext,
    /res\.status === 401 \|\| res\.status === 403 \|\| res\.status === 404[\s\S]{0,180}clearStoredAuthSession\(\)/,
    "terminal auth failures must still clear the stored session",
  );
  assert.match(appContext, /res\.status >= 500 && cachedUser/, "transient auth 5xx must preserve the cached-user fallback");
  assert.doesNotMatch(appContext, /fetch\(\s*["']\/api\/settings\/appearance["']/, "AppProvider must not directly GET appearance");
  assert.match(appContext, /handleThemeUpdate[\s\S]{0,240}fetchTheme\(true\)/, "AppProvider must force the post-publication shared read");
  assert.doesNotMatch(appContext, /invalidateClientBootstrapAppearance/, "AppProvider must not invalidate the shared event request");
  assert.equal(
    adminPage.match(/invalidateClientBootstrapAppearance\(\);\s*window\.dispatchEvent\(new Event\("theme-updated"\)\);/gu)?.length,
    2,
    "each admin theme publication path must invalidate exactly once before broadcasting",
  );

  const directAuthFetches = appContext.match(/fetch\(\s*["']\/api\/auth\/me["']/g) ?? [];
  assert.equal(directAuthFetches.length, 1, "only the explicit auth/me PUT may remain a direct fetch");
  assert.match(
    appContext,
    /fetch\("\/api\/auth\/me", \{[\s\S]{0,120}method: "PUT"/,
    "saving a user theme must remain an explicit auth/me PUT",
  );
  assert.match(appContext, /fetch\(`\/api\/credits\?user_id=/, "credits must remain a fresh dedicated request");
  assert.match(appContext, /getClientBootstrapAgentCatalog\(token \|\| null\)/, "Agent catalog bootstrap must use the shared token-scoped helper");
  assert.match(marketplace, /getClientBootstrapAgentCatalog\(auth\.token\)/, "marketplace permissions must share the Agent catalog request");
  assert.doesNotMatch(marketplace, /fetch\(\s*["']\/api\/bots/, "marketplace must not duplicate the Agent catalog request");

  assert.match(appContext, /getClientBootstrapLayout\(\{ force \}\)/, "layout mount helper must support explicit freshness");
  assert.match(appContext, /fetchLayoutConfig\(true\)/, "layout visibility/interval refresh must force a fresh value");
  assert.match(appContext, /getClientBootstrapLayout\(\{ force: true \}\)/, "public layout refresh must bypass settled cache");
  assert.match(appContext, /method: "PUT"/, "layout save semantics must remain present");
  assert.match(appContext, /method: "DELETE"/, "layout reset semantics must remain present");

  assert.match(cacheModule, /^"use client";/, "the auth-scoped module must be client-only");
  assert.match(cacheModule, /generation/, "cache invalidation must guard against late response writeback");
  assert.match(cacheModule, /response\.clone\(\)/, "each consumer must receive an independently readable response");
  assert.ok(
    CLIENT_BOOTSTRAP_CACHE_TTL_MS > 0 && CLIENT_BOOTSTRAP_CACHE_TTL_MS <= 2_000,
    "bootstrap cache must stay positive and no longer than two seconds",
  );
  return 34;
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let now = Date.UTC(2026, 7, 29, 12, 0, 0);
  Date.now = () => now;

  let assertions = 0;
  try {
    assertions += await verifySettingsSingleFlightAndTtl((amount) => { now += amount; });
    assertions += await verifyRetryAfterTransportFailure();
    assertions += await verifyAuthTokenIsolation();
    assertions += await verifyLateAuthResponseCannotCrossToken();
    assertions += await verifyLayoutFreshnessContract();
    assertions += await verifyAgentCatalogCoalescing();
    assertions += verifySourceWiring();
  } finally {
    invalidateClientBootstrapCache();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  }

  console.log(`PASS client bootstrap cache contract: ${assertions} grouped assertions`);
  console.log("root request contract: appearance 2->1, auth/me 2->1, Agent catalog 3->1, credits 1->1, layout 1->1");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
