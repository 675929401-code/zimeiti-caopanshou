import assert from "node:assert/strict";
import { test } from "node:test";
import Module from "node:module";
import { NextRequest } from "next/server";
import { formalCatalogPreviewEnabled, readFormalCatalogPreview } from "../src/lib/server/formal-catalog-preview";

const env = {
  PORT: "5000", HOSTNAME: "127.0.0.1", LOCAL_RUNTIME_PROFILE: "local-acceptance", LOCAL_ACCEPTANCE_PREVIEW: "true",
  SHARED_CONFIGURATION_ID: "local-acceptance", SHARED_CONFIGURATION_ENABLED: "1",
  SHARED_CONFIGURATION_SUPABASE_URL: "http://127.0.0.1:54321", SHARED_CONFIGURATION_SERVICE_ROLE_KEY: "fixture",
  COZE_SUPABASE_URL: "http://127.0.0.1:54321", DATABASE_URL: "postgresql://127.0.0.1:54322/zimeiti_local",
};
const category = { id: "category-1", name: "营销策略", visibility: "normal", user_can_use: true, is_active: true, sort_order: 1 };
const agent = { id: "agent-a", name: "影像导演", category: category.name, is_active: true, user_access: "available", deleted_at: null,
  guide_message: "public text retained only as a digest", non_public_test_field: "never project this" };
const json = (body: unknown, date = new Date().toUTCString()) => Response.json(body, { headers: { Date: date } });
const fixture = (url: URL) => url.pathname === "/api/categories" ? { categories: [category] }
  : { navigationKeys: null, agents: [agent] };

test("reads only the two fixed paths anonymously at each source and compares stable display groups", async () => {
  const requests: string[] = [];
  const preview = await readFormalCatalogPreview(env, async (url, options) => {
    requests.push(url.href);
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.deepEqual([...new Headers(options.headers).keys()].sort(), ["accept", "cache-control"]);
    const payload = fixture(url);
    if (url.origin.startsWith("https:") && payload.agents) {
      payload.agents = [
        { ...agent, guide_message: "updated official public text" },
        { ...agent, id: "agent-b", name: "文案提炼" },
      ];
    }
    return json(payload);
  });
  assert.deepEqual(requests.sort(), [
    "http://127.0.0.1:5000/api/bots?shape=agents", "http://127.0.0.1:5000/api/categories",
    "https://zyuani8.com/api/bots?shape=agents", "https://zyuani8.com/api/categories",
  ]);
  assert.equal(preview.digestKind, "observed-public-projection-sha256");
  assert.equal(preview.local.groupCounts["task:影像编导"], 1);
  assert.equal(preview.official.groupCounts["task:文案创作"], 1);
  assert.deepEqual(preview.diff.onlyOfficial, ["agent-b"]);
  assert.deepEqual(preview.diff.changed, [{ id: "agent-a", fields: ["guide_message"] }]);
  assert.equal(preview.diff.same, false);
  assert.doesNotMatch(JSON.stringify(preview), /public text|never project this|non_public_test_field/u);
});

test("empty, well-formed guest catalogs remain valid; categories are compared independently of agent changes", async () => {
  const preview = await readFormalCatalogPreview(env, async url => json(url.pathname === "/api/categories"
    ? { categories: [{ ...category, sort_order: url.protocol === "http:" ? 1 : 2 }] }
    : { navigationKeys: null, agents: [] }));
  assert.equal(preview.local.count, 0);
  assert.deepEqual(preview.diff.changed, []);
  assert.deepEqual(preview.diff.categories.changed, [{ id: category.id, fields: ["sortOrder"] }]);
  assert.equal(preview.diff.same, false);
});

test("production profiles, changed data targets, unsafe pins and insecure TLS never contact a source", async () => {
  assert.equal(formalCatalogPreviewEnabled(env), true);
  let calls = 0;
  const read = async () => { calls++; return json({}); };
  for (const overrides of [
    { PORT: "5002" }, { HOSTNAME: "0.0.0.0" }, { LOCAL_RUNTIME_PROFILE: "formal-local-shared" },
    { SHARED_CONFIGURATION_SUPABASE_URL: "https://example.org" }, { DATABASE_URL: "postgres://example.org/db" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { FORMAL_CATALOG_ORIGIN_IP: "127.0.0.1" },
    { FORMAL_CATALOG_ORIGIN_IP: "198.18.1.2" }, { FORMAL_CATALOG_ORIGIN_IP: "host.test" },
  ]) {
    await assert.rejects(readFormalCatalogPreview({ ...env, ...overrides }, read), /FORMAL_CATALOG_(?:LOCAL_ONLY|ORIGIN_PIN_INVALID)/u);
  }
  assert.equal(calls, 0);
});

test("failure at either source, stale data, internal categories, duplicate and orphaned IDs all fail closed", async () => {
  for (const badResponse of [
    () => new Response(null, { status: 302, headers: { Location: "https://other.example/" } }),
    () => json(fixture(new URL("https://zyuani8.com/api/categories")), "Mon, 01 Jan 2024 00:00:00 GMT"),
    () => json({ categories: [{ ...category, name: "自用", visibility: "view_only", user_can_use: false }] }),
    () => json({ categories: [category, category] }),
    () => json({ categories: [] }),
  ]) {
    await assert.rejects(readFormalCatalogPreview(env, async url => url.protocol === "https:" && url.pathname === "/api/categories"
      ? badResponse() : json(fixture(url))), /FORMAL_CATALOG_/u);
  }
  for (const bots of [
    { agents: [agent], navigationKeys: ["task:影像编导"] }, { agents: [agent, agent], navigationKeys: null },
    { agents: [{ ...agent, user_access: "hidden" }], navigationKeys: null },
  ]) {
    await assert.rejects(readFormalCatalogPreview(env, async url => json(url.pathname === "/api/bots" ? bots : fixture(url))), /FORMAL_CATALOG_INVALID/u);
  }
});

test("the route checks the local runtime and verified owner before contacting either source", async () => {
  const authPath = require.resolve("../src/lib/server/admin-governance-authority");
  const readerPath = require.resolve("../src/lib/server/formal-catalog-preview");
  const routePath = require.resolve("../src/app/api/admin/formal-catalog-preview/route");
  const original = [authPath, readerPath, routePath].map(key => [key, require.cache[key]] as const);
  const routeUrl = "http://127.0.0.1:5000/api/admin/formal-catalog-preview";
  let local = false;
  let authorized = false;
  let access = { adminLevel: "admin", profileActive: true, revision: 1, checksum: "fixture-checksum" };
  let authCalls = 0;
  let sourceCalls = 0;
  function replace(path: string, exports: object) {
    const module = new Module(path);
    module.exports = exports;
    module.loaded = true;
    require.cache[path] = module;
  }
  try {
    replace(authPath, { authorizeAdminCapability: async (_request: Request, capability: string) => {
      authCalls++;
      assert.equal(capability, "agents.view");
      return authorized ? { ok: true, access } : { ok: false, response: Response.json({ code: "AUTH_REQUIRED", error: "请先登录" }, { status: 401 }) };
    } });
    replace(readerPath, {
      formalCatalogPreviewEnabled: () => local,
      readFormalCatalogPreview: async () => { sourceCalls++; return { ok: true }; },
    });
    delete require.cache[routePath];
    const { GET } = require(routePath) as typeof import("../src/app/api/admin/formal-catalog-preview/route");
    async function status(query = "") { return (await GET(new NextRequest(routeUrl + query))).status; }
    assert.equal(await status(), 403);
    assert.equal(authCalls, 0);
    local = true;
    assert.equal((await GET(new NextRequest(routeUrl, { method: "HEAD" }))).status, 405);
    assert.equal(await status(), 401);
    authorized = true;
    assert.equal(await status(), 403);
    access = { ...access, adminLevel: "super_admin", checksum: "legacy-schema-absent" };
    assert.equal(await status(), 403);
    access = { ...access, checksum: "verified", revision: Number.NaN };
    assert.equal(await status(), 403);
    access = { ...access, revision: 1 };
    assert.equal(await status("?url=https://other.example"), 400);
    assert.equal(sourceCalls, 0);
    const response = await GET(new NextRequest(routeUrl));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") || "", /private, no-store/u);
    assert.equal(sourceCalls, 1);
  } finally {
    for (const [path, cached] of original) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
});
