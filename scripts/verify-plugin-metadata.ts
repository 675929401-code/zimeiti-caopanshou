import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as metadata from "@/lib/plugin-metadata";
import * as display from "@/lib/display-normalization";

// Runs actual route handlers with an in-memory database. No runtime env, network or real writes.
type Row = Record<string, any>;
type Store = { rows: Row[]; writes: number; reads: number; failRead?: boolean };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const latin1 = (text: string) => String.fromCharCode(...new TextEncoder().encode(text));

function fakeDatabase(store: Store) {
  return {
    from(table: string) {
      assert.equal(table, "plugins");
      const filters: ((row: Row) => boolean)[] = [];
      let operation = "read";
      let payload: Row = {};
      let columns = "*";
      let limit = Infinity;
      const execute = (single = false) => {
        if (operation === "read") store.reads++;
        if (operation === "read" && store.failRead) return { data: null, error: { code: "FIXTURE_DB_READ_FAILURE" } };
        let rows = store.rows.filter((row) => filters.every((fn) => fn(row))).slice(0, limit);
        if (operation === "insert") {
          rows = [{ id: `fixture-${store.rows.length}`, ...clone(payload) }];
          store.rows.push(...rows);
          store.writes++;
        }
        if (operation === "update") {
          rows.forEach((row) => Object.assign(row, clone(payload)));
          store.writes++;
        }
        const result = rows.map((row) => columns === "*" ? clone(row)
          : Object.fromEntries(columns.split(",").map((column) => [column.trim(), row[column.trim()]])));
        return { data: single ? result[0] ?? null : result, error: null };
      };
      const query: any = {
        select(value = "*") { columns = value; return query; },
        eq(key: string, value: unknown) { filters.push((row) => row[key] === value); return query; },
        neq(key: string, value: unknown) { filters.push((row) => row[key] !== value); return query; },
        in(key: string, values: unknown[]) { filters.push((row) => values.includes(row[key])); return query; },
        order() { return query; },
        limit(value: number) { limit = value; return query; },
        insert(value: Row) { operation = "insert"; payload = value; return query; },
        update(value: Row) { operation = "update"; payload = value; return query; },
        single() { return Promise.resolve(execute(true)); },
        maybeSingle() { return Promise.resolve(execute(true)); },
        then(yes: (value: unknown) => unknown, no: (error: unknown) => unknown) { return Promise.resolve(execute()).then(yes, no); },
      };
      return query;
    },
  };
}

function loadRoute(relativePath: string, store: Store): Record<string, (request: Request) => Promise<Response>> {
  const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const fixtureModules: Record<string, unknown> = {
    "@/storage/database/supabase-client": { getSupabaseClient: () => fakeDatabase(store) },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/admin-auth": { verifyAdminToken: async (token: string) => token === "fixture-admin" ? { userId: "fixture-admin", role: "admin" } : null },
    "@/lib/plugin-metadata": metadata,
    "@/lib/display-normalization": display,
  };
  const exports: Record<string, (request: Request) => Promise<Response>> = {};
  runInNewContext(compiled, {
    exports, URL, Date,
    console: { error() { /* Expected errors must not log any request/config fixture. */ } },
    require: (id: string) => {
      if (!(id in fixtureModules)) throw new Error(`Unexpected dependency: ${id}`);
      return fixtureModules[id];
    },
  });
  return exports;
}

function request(path: string, method = "GET", body?: Row, authenticated = true) {
  return new Request(`http://fixture.invalid${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer fixture-admin" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function main() {
  const fixture = {
    id: "fixture-video", name: latin1("PPT6视频解析"), description: latin1("提取视频下载链接"),
    type: "third_party", role: "extract_video", subtype: "video_download", is_active: true,
    price_per_use: "0", cost_price: "0", price_unit: latin1("次"),
    config: {
      provider: "ppt6", api_base_url: "https://fixture.invalid/api", site_name: latin1("测试站点"),
      client_secret_key: "fixture-secret-not-real", api_key: "xy",
      headers: { Authorization: "fixture-auth-not-real" },
      connections: [{ api_token: "fixture-array-token-not-real" }],
    },
  };
  const normalized = metadata.normalizePluginMetadata(fixture);
  assert.equal(normalized.name, "PPT6视频解析");
  assert.equal(normalized.description, "提取视频下载链接");
  assert.equal(normalized.price_unit, "次");
  assert.equal(normalized.price_per_use, 0);
  assert.equal(normalized.config?.site_name, "测试站点");
  assert.equal(fixture.name, latin1("PPT6视频解析"), "read normalization must not mutate the source record");
  assert.equal(metadata.normalizePluginMetadata({ name: "Already valid 中文", price_per_use: 0 }).name, "Already valid 中文");
  assert.equal(metadata.normalizePluginMetadata({ role: "extract_video", price_per_use: null }).price_per_use, 0.02);
  assert.deepEqual(metadata.normalizePluginMetadata({ price_per_use: null }).metadata_warnings, ["PRICE_NOT_CONFIGURED"]);

  const masked = metadata.maskPluginConfig(fixture.config);
  assert.equal(masked.client_secret_key, "********");
  assert.equal(masked.api_key, "********", "short credentials must also be masked");
  assert.equal((masked.headers as Row).Authorization, "********");
  assert.deepEqual(metadata.mergePluginConfigSecrets(masked, fixture.config), fixture.config);
  for (const value of [undefined, "", null, "abcd****wxyz", "********"]) {
    assert.equal(metadata.mergePluginConfigSecrets({ client_secret_key: value }, fixture.config).client_secret_key, fixture.config.client_secret_key);
  }
  assert.equal(metadata.mergePluginConfigSecrets({ api_key: "fixture-replacement" }, fixture.config).api_key, "fixture-replacement");
  assert.equal(metadata.mergePluginConfigSecrets({ api_key: "********" }, {}).api_key, undefined);
  for (const value of [-1, "-0.01", null, "", "bad", true, [], {}, Infinity]) {
    assert.ok(metadata.validatePluginMetadataInput({ price_per_use: value }));
  }
  for (const value of [0, "0", 0.01, "0.02"]) {
    assert.equal(metadata.validatePluginMetadataInput({ price_per_use: value, cost_price: value }), null);
  }

  const store: Store = { rows: [clone(fixture)], reads: 0, writes: 0 };
  const admin = loadRoute("src/app/api/admin/plugins/route.ts", store);
  const active = loadRoute("src/app/api/plugins/active/route.ts", store);
  const anonymous = await admin.GET(request("/api/admin/plugins", "GET", undefined, false));
  assert.equal(anonymous.status, 401);
  assert.equal(store.reads, 0);
  const list = await (await admin.GET(request("/api/admin/plugins"))).json();
  const detail = await (await admin.GET(request("/api/admin/plugins?id=fixture-video"))).json();
  const publicRead = await (await active.GET(request("/api/plugins/active?role=extract_video"))).json();
  for (const plugin of [list.plugins[0], detail.plugin, publicRead.plugin]) {
    assert.equal(plugin.name, "PPT6视频解析");
    assert.equal(plugin.price_per_use, 0);
    assert.equal(plugin.price_unit, "次");
  }
  assert.deepEqual(detail.plugin.config, list.plugins[0].config);
  assert.equal(publicRead.plugin.config, undefined);
  assert.equal(publicRead.plugin.cost_price, undefined);
  assert.equal(store.writes, 0);

  const saved = await admin.PUT(request("/api/admin/plugins", "PUT", {
    id: fixture.id, name: latin1("免费解析插件"), price_per_use: "0", cost_price: 0,
    config: detail.plugin.config,
  }));
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(store.rows[0].name, "免费解析插件");
  assert.equal(store.rows[0].price_per_use, 0);
  assert.equal(store.rows[0].config.client_secret_key, fixture.config.client_secret_key);
  assert.equal(savedBody.plugin.config.client_secret_key, "********");
  assert.equal(savedBody.plugin.config.headers.Authorization, "********");
  const publicAfterSave = await (await active.GET(request("/api/plugins/active?role=extract_video"))).json();
  assert.equal(publicAfterSave.plugin.price_per_use, savedBody.plugin.price_per_use);

  const beforeInvalid = store.writes;
  for (const body of [{ price_per_use: -1 }, { cost_price: "oops" }, { config: [] }, { role: "乱码角色" }]) {
    const response = await admin.PUT(request("/api/admin/plugins", "PUT", { id: fixture.id, is_active: true, ...body }));
    assert.equal(response.status, 400);
  }
  assert.equal(store.writes, beforeInvalid, "invalid edits must not deactivate siblings or write data");

  store.failRead = true;
  const failedRead = await admin.PUT(request("/api/admin/plugins", "PUT", { id: fixture.id, config: masked }));
  assert.equal(failedRead.status, 500);
  assert.equal(store.writes, beforeInvalid, "a failed source read must not write masks over credentials");
  store.failRead = false;

  const createResponse = await admin.POST(request("/api/admin/plugins", "POST", {
    name: latin1("测试插件"), type: "third_party", role: "extract_video", is_active: false,
    price_per_use: 0, cost_price: "0", config: fixture.config,
  }));
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.plugin.price_per_use, 0);
  assert.equal(created.plugin.name, "测试插件");
  assert.equal(created.plugin.config.client_secret_key, "********");
  const activeBeforeEdit = store.rows[0].is_active;
  await admin.PUT(request("/api/admin/plugins", "PUT", { id: created.plugin.id, role: "extract_video", description: "修改未启用插件" }));
  assert.equal(store.rows[0].is_active, activeBeforeEdit, "editing an inactive plugin must not disable the active plugin");

  console.log(JSON.stringify({
    ok: true, mode: "in-memory-route-fixtures", networkRequests: 0, realDatabaseWrites: 0,
    checked: ["latin1-display-repair", "valid-text-preserved", "raw-record-preserved", "free-price-preserved",
      "missing-price-distinguished", "all-admin-responses-masked", "nested-and-short-credentials-masked",
      "masked-credentials-preserved-on-edit", "admin-public-price-consistency", "invalid-price-rejected-before-write",
      "source-read-failure-prevents-write", "inactive-plugin-edit-keeps-active-sibling", "admin-auth-required", "public-fields-only"],
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Plugin verification failed");
  process.exitCode = 1;
});
