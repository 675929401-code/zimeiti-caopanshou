import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { capture, project, routes, createPublishedReader, verifiedResponse, validateSnapshot } from "../src/lib/server/published-configuration-public.mjs";
import { createPublishedSnapshotStore, type PublishedSnapshot } from "../src/lib/server/published-configuration-snapshot";
import { createPublishedPreviewService, publishedPreviewRequestAllowed, PublishedPreviewUnavailable, publishedPreviewService } from "../src/lib/server/published-configuration-preview";
import { renderPublishedPage, renderPublishedUnavailable } from "../src/lib/server/published-configuration-view.mjs";
import { GET } from "../src/app/published-preview/route";

const local = {
  PORT: "5000", HOSTNAME: "127.0.0.1", LOCAL_RUNTIME_PROFILE: "local-acceptance", LOCAL_ACCEPTANCE_PREVIEW: "true",
  SHARED_CONFIGURATION_ID: "local-acceptance", SHARED_CONFIGURATION_ENABLED: "1",
  SHARED_CONFIGURATION_SUPABASE_URL: "http://127.0.0.1:54321", SHARED_CONFIGURATION_SERVICE_ROLE_KEY: "fixture",
  COZE_SUPABASE_URL: "http://127.0.0.1:54321", DATABASE_URL: "postgresql://127.0.0.1:54322/zimeiti_local",
};
const version = { sourceVersion: "R-fixture", buildId: "build", releaseId: "release-fixture", deployCommitSha: "a".repeat(40) };
const fixtures: Record<string, object> = {
  version, categories: { categories: [{ id: "c", name: "目录", is_active: true, visibility: "normal" }] },
  agents: { agents: [{ id: "agent-a", name: "演示 <script>", category: "目录", deleted_at: null, user_access: "available" }], navigationKeys: null },
  appearance: { authority: { authoritative: true }, settings: { theme: "soft-white" } },
  branding: { ok: true, branding: { source: "published", displayScope: "platform", revisionId: "r", brand: { name: "公开品牌" } } },
  layout: { layout: { card: {}, nav: {}, category: {} } }, navigation: { navItems: [] }, shortcuts: { shortcuts: [] },
  site: { success: true, data: {} }, voicePrices: { success: true, data: [] },
  settings: { settings: { theme: "soft-white", card_layout: "legacy-unreadable" }, authorities: { branding: { source: "published" }, general: { source: "platform_settings" } } },
  manju: { ok: true, state: "ready", environment: "production", etag: "v", domains: { content: { navigation: [] }, feature_flags: {}, media: {} } },
  help: { preview: false, articles: [], categories: [], media: [] }, chatModels: { models: [], unavailableModels: [] },
};
const fixtureRead = async (kind: string) => project(kind, structuredClone(fixtures[kind] ?? { models: [] }));
const sample = async () => await capture(fixtureRead) as PublishedSnapshot;
const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), "published-preview-test-"));
const request = (url = "http://127.0.0.1:5000/published-preview", headers: Record<string, string> = {}, method = "GET") => new Request(url, { method, headers: { host: new URL(url).host, ...headers } });
const nextRequest = (headers: Record<string, string> = {}) => new NextRequest("http://127.0.0.1:5000/published-preview", {
  headers: { host: "127.0.0.1:5000", "x-forwarded-host": "127.0.0.1:5000", "x-forwarded-port": "5000",
    "x-forwarded-proto": "http", "x-forwarded-for": "::ffff:127.0.0.1", ...headers },
});

test("installed NextRequest loopback normalization preserves the literal local Host and Origin boundary", () => {
  const normalized = nextRequest({ origin: "http://127.0.0.1:5000", "sec-fetch-site": "same-origin" });
  assert.equal(normalized.url, "http://localhost:5000/published-preview");
  assert.equal(publishedPreviewRequestAllowed(normalized, local), true);
  assert.equal(publishedPreviewRequestAllowed(nextRequest(), local), true);
  for (const headers of [
    { host: "localhost:5000" }, { origin: "http://localhost:5000" }, { origin: "https://zyuani8.com" },
    { "x-forwarded-host": "localhost:5000" }, { "x-forwarded-host": "127.0.0.1:5000,zyuani8.com" },
    { "x-forwarded-for": "127.0.0.1,192.0.2.10" }, { "x-forwarded-proto": "https" },
    { "x-forwarded-port": "5001" }, { forwarded: "host=127.0.0.1:5000" }, { "x-real-ip": "127.0.0.1" },
    { "sec-fetch-site": "cross-site" },
  ] as Record<string, string>[]) assert.equal(publishedPreviewRequestAllowed(nextRequest(headers), local), false);
  for (const env of [{}, { ...local, LOCAL_RUNTIME_PROFILE: "formal-local-shared" }, { ...local, PORT: "5001" }]) {
    assert.equal(publishedPreviewRequestAllowed(normalized, env), false);
  }
  assert.equal(publishedPreviewRequestAllowed(new NextRequest("http://zyuani8.com/published-preview", {
    headers: { host: "127.0.0.1:5000" },
  }), local), false);
});

test("17 public domains require two stable reads and preserve runtime and content hashes", async () => {
  const count: Record<string, number> = {};
  const snapshot = await capture(async (kind: string) => { count[kind] = (count[kind] ?? 0) + 1; return fixtureRead(kind); });
  assert.equal(Object.keys(snapshot.sections).length, 17);
  assert.ok(Object.keys(routes).every(kind => count[kind] === 2));
  assert.equal(snapshot.audience, "guest");
  assert.equal(validateSnapshot(JSON.parse(JSON.stringify(snapshot))).fingerprint, snapshot.fingerprint);
  assert.deepEqual(snapshot.sections.settings.unreadableStructuredSettings, ["card_layout"]);
  let number = 0;
  await assert.rejects(capture(async (kind: string) => kind === "version" && ++number === 2 ? { ...version, buildId: "changed" } : fixtureRead(kind)), /RELEASE_CHANGED/u);
});

test("loopback local profile, origin and forwarding boundaries reject before any capture", async () => {
  assert.equal(publishedPreviewRequestAllowed(request(), local), true);
  assert.equal(publishedPreviewRequestAllowed(request(undefined, { "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "127.0.0.1:5000", "x-forwarded-port": "5000", "x-forwarded-proto": "http" }), local), true);
  for (const [req, env] of [
    [request("http://zyuani8.com/published-preview"), local], [request(undefined, {}, "POST"), local],
    [request(undefined, { host: "localhost:5000" }), local], [request(undefined, { forwarded: "host=zyuani8.com" }), local],
    [request(undefined, { "x-forwarded-for": "192.0.2.10" }), local], [request(undefined, { origin: "https://example.org" }), local],
    [request(undefined, { "sec-fetch-site": "cross-site" }), local],
    [request(), { ...local, LOCAL_RUNTIME_PROFILE: "formal-local-shared" }],
    [request(), { ...local, DATABASE_URL: "postgresql://example.org/production" }],
    [request(), { ...local, NODE_TLS_REJECT_UNAUTHORIZED: "0" }],
  ] as const) assert.equal(publishedPreviewRequestAllowed(req, env), false);
  let captures = 0, saves = 0, reads = 0;
  const service = createPublishedPreviewService({ capture: async () => { captures++; return sample(); }, store: {
    read: async () => { reads++; return { state: "missing" }; }, save: async s => { saves++; return s; },
  } });
  for (const env of [{}, { ...local, PORT: "5001" }, { ...local, COZE_SUPABASE_URL: "https://example.org" }]) await assert.rejects(service.refresh(env), /LOCAL_ONLY/u);
  assert.deepEqual([captures, saves, reads], [0, 0, 0]);
});

test("transport has a fixed approved GET target and never accepts user URLs, headers or redirects", async () => {
  let calls = 0;
  const read = await createPublishedReader({ FORMAL_CATALOG_ORIGIN_IP: "8.8.8.8" }, { transport: async (url: URL, address: { address: string }, init: RequestInit) => {
    calls++; assert.equal(url.href, "https://zyuani8.com/api/version"); assert.equal(address.address, "8.8.8.8");
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    assert.deepEqual(Object.keys(init.headers ?? {}).sort(), ["Accept", "Cache-Control"]);
    return Response.json(version, { headers: { Date: new Date().toUTCString() } });
  } });
  assert.deepEqual(await read("version"), version);
  await assert.rejects(read("https://other.example/api/admin"), /UNAPPROVED/u); assert.equal(calls, 1);
  await assert.rejects(createPublishedReader({ FORMAL_CATALOG_ORIGIN_IP: "127.0.0.1" }), /PIN_INVALID/u);
  const redirect = await createPublishedReader({ FORMAL_CATALOG_ORIGIN_IP: "8.8.8.8" }, { transport: async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } }) });
  await assert.rejects(redirect("version"), /UNAVAILABLE/u);
});

test("stale, oversized, protected, internal or malformed public projections cannot become snapshots", async () => {
  const bytes = Buffer.from(JSON.stringify(version)), headers = { date: new Date().toUTCString(), "content-type": "application/json" };
  for (const [status, h, b] of [[302, headers, bytes], [200, { ...headers, date: new Date(0).toUTCString() }, bytes],
    [200, { ...headers, "content-type": "text/html" }, bytes], [200, headers, Buffer.alloc(2097153)]] as const) assert.throws(() => verifiedResponse("version", status, h, b));
  assert.throws(() => project("agents", { ...fixtures.agents, navigationKeys: ["owner"] }), /AUDIENCE/u);
  assert.throws(() => project("layout", { layout: { card: {}, nav: {}, category: {}, nested: { system_prompt: "fixture" } } }), /PROTECTED/u);
  assert.throws(() => project("site", { success: true, data: { text: "Bearer fake-fixture-value" } }), /PROTECTED/u);
  assert.throws(() => project("site", { success: true, data: { "api-key": "fixture" } }), /PROTECTED/u);
  assert.throws(() => project("site", { success: true, data: { image: "https://example.org/a.png?signature=fixture" } }), /CREDENTIAL_URL/u);
  const snapshot = await sample(); snapshot.sections.layout.changed = "tampered";
  assert.throws(() => validateSnapshot(snapshot), /DIGEST|PROJECTION/u);
});

test("successful refresh survives a new service/store instance and falls back offline without changing last success", async () => {
  const directory = await temporary(), store = createPublishedSnapshotStore(directory);
  const online = await createPublishedPreviewService({ store, capture: sample }).refresh(local);
  assert.equal(online.status, "online");
  const offline = await createPublishedPreviewService({ store: createPublishedSnapshotStore(directory), capture: async () => { throw Error("offline"); } }).refresh(local);
  assert.equal(offline.status, "offline"); assert.equal(offline.servedFrom, "disk");
  assert.equal(offline.lastSuccessfulAt, online.lastSuccessfulAt); assert.equal(offline.snapshot.fingerprint, online.snapshot.fingerprint);
  const html = renderPublishedPage(offline.snapshot, "/published-preview?format=json", offline);
  assert.match(html, /data-sync-status="offline"/u); assert.ok(html.includes(offline.lastSuccessfulAt));
  assert.match(html, /本地草稿管理/u); assert.doesNotMatch(html, /<script>/u);
  assert.equal((html.match(/data-configuration-section=/gu) ?? []).length, 17);
});

test("first visit offline and damaged cache remain explicit errors rather than empty catalogs", async () => {
  const directory = await temporary(), store = createPublishedSnapshotStore(directory);
  const service = createPublishedPreviewService({ store, capture: async () => { throw Error("upstream unavailable"); } });
  await assert.rejects(service.refresh(local), (error: unknown) => error instanceof PublishedPreviewUnavailable && error.cacheState === "missing");
  assert.match(renderPublishedUnavailable("missing"), /尚无成功保存/u);
  await store.save(await sample()); await fs.writeFile(path.join(directory, "last-success.v1.json"), "{broken");
  await assert.rejects(service.refresh(local), (error: unknown) => error instanceof PublishedPreviewUnavailable && error.cacheState === "corrupt");
  assert.match(renderPublishedUnavailable("corrupt"), /完整性检查/u);
  await createPublishedPreviewService({ store, capture: sample }).refresh(local);
  assert.equal((await store.read()).state, "valid");
});

test("parallel refreshes share one capture; independent stores serialize atomic newest-snapshot persistence", async () => {
  const directory = await temporary(); let captures = 0; let proceed!: () => void;
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  const service = createPublishedPreviewService({ store: createPublishedSnapshotStore(directory), capture: async () => { captures++; await gate; return sample(); } });
  const jobs = Array.from({ length: 12 }, () => service.refresh(local)); proceed();
  const results = await Promise.all(jobs); assert.equal(captures, 1); assert.ok(results.every(r => r.snapshot.fingerprint === results[0].snapshot.fingerprint));
  const parallelDirectory = await temporary();
  const base = await sample(); const snapshots = Array.from({ length: 10 }, (_, i) => ({ ...base, observedAt: new Date(Date.now() - 1000 + i).toISOString() }));
  await Promise.all(snapshots.reverse().map(s => createPublishedSnapshotStore(parallelDirectory).save(s)));
  const disk = await createPublishedSnapshotStore(parallelDirectory).read(); assert.equal(disk.state, "valid");
  if (disk.state === "valid") assert.equal(disk.snapshot.observedAt, snapshots[0].observedAt);
  assert.deepEqual((await fs.readdir(parallelDirectory)).sort(), ["last-success.v1.json"]);
});

test("two independent processes persist complete snapshots and a restarted offline process can read the last success", async () => {
  const directory = await temporary(), base = await sample();
  const storeUrl = pathToFileURL(path.resolve("src/lib/server/published-configuration-snapshot.ts")).href;
  const childCode = `import {createPublishedSnapshotStore} from ${JSON.stringify(storeUrl)};let input='';for await(const chunk of process.stdin)input+=chunk;const x=JSON.parse(input);const store=createPublishedSnapshotStore(x.directory);for(const snapshot of x.snapshots)await store.save(snapshot);console.log(JSON.stringify(await store.read()));`;
  function child(snapshots: PublishedSnapshot[]) {
    const processChild = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", childCode], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", errors = "";
    processChild.stdout.on("data", chunk => { output += chunk; }); processChild.stderr.on("data", chunk => { errors += chunk; });
    processChild.stdin.end(JSON.stringify({ directory, snapshots }));
    return new Promise<{ output: string; pid: number }>((resolve, reject) => {
      processChild.on("error", reject); processChild.on("close", code => code === 0 ? resolve({ output, pid: processChild.pid! }) : reject(Error(`CHILD_FAILED:${errors}`)));
    });
  }
  const time = Date.now() - 1000;
  const snapshots = Array.from({ length: 8 }, (_, index) => ({ ...base, observedAt: new Date(time + index).toISOString() }));
  const children = await Promise.all([child(snapshots.filter((_, i) => i % 2 === 0)), child(snapshots.filter((_, i) => i % 2 === 1))]);
  const restarted = await child([]); const disk = JSON.parse(restarted.output);
  assert.equal(disk.state, "valid"); assert.equal(disk.snapshot.observedAt, snapshots[7].observedAt);
  assert.equal(disk.snapshot.fingerprint, base.fingerprint);
  // A crashed process may leave its short lock. Only its proven dead PID can be reclaimed.
  const deadOwner = path.join(directory, ".dead-owner.tmp");
  await fs.writeFile(deadOwner, JSON.stringify({ pid: children[0].pid, startedAt: Date.now() - 2000 }));
  await fs.link(deadOwner, path.join(directory, "snapshot-write.lock"));
  await createPublishedSnapshotStore(directory).save(base);
  await fs.unlink(deadOwner);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["last-success.v1.json"]);
});

test("unsafe snapshot links and failed reads cannot overwrite or invent a good persisted snapshot", async () => {
  const directory = await temporary(), store = createPublishedSnapshotStore(directory), snapshot = await sample();
  await store.save(snapshot);
  await assert.rejects(store.save({ ...snapshot, fingerprint: "0".repeat(64) }), /DIGEST/u);
  const disk = await store.read(); assert.equal(disk.state, "valid");
  if (disk.state === "valid") assert.equal(disk.snapshot.fingerprint, snapshot.fingerprint);
  const link = path.join(await temporary(), "linked"); await fs.symlink(directory, link, "junction");
  await assert.rejects(createPublishedSnapshotStore(link).save(snapshot), /UNSAFE/u);
});

test("actual route rejects writes/proxies/query injection and provides bounded HTML and JSON offline semantics", async () => {
  const previous = { ...process.env }, original = publishedPreviewService.refresh;
  Object.assign(process.env, local);
  try {
    publishedPreviewService.refresh = async () => { throw new PublishedPreviewUnavailable("missing"); };
    assert.equal((await GET(request())).status, 503);
    assert.equal((await GET(request(undefined, {}, "POST"))).status, 404);
    assert.equal((await GET(request(undefined, { "x-forwarded-host": "zyuani8.com" }))).status, 404);
    assert.equal((await GET(request("http://127.0.0.1:5000/published-preview?target=https://example.org"))).status, 400);
    const error = await GET(request("http://127.0.0.1:5000/published-preview?format=json"));
    assert.deepEqual(await error.json(), { code: "PUBLISHED_SOURCE_UNAVAILABLE", cacheState: "missing", lastSuccessfulAt: null });
    const snapshot = await sample();
    publishedPreviewService.refresh = async () => ({ schema: "published-configuration-preview.v1", status: "offline", lastSuccessfulAt: snapshot.observedAt, lastAttemptAt: new Date().toISOString(), servedFrom: "disk", snapshot });
    const page = await GET(request()); assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "private,no-store");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
    assert.match(await page.text(), /data-sync-status="offline"/u);
    const nextPage = await GET(nextRequest({ origin: "http://127.0.0.1:5000", "sec-fetch-site": "same-origin" }));
    assert.equal(nextPage.status, 200);
    assert.match(await nextPage.text(), /data-sync-status="offline"/u);
    assert.equal((await GET(nextRequest({ host: "localhost:5000" }))).status, 404);
    delete process.env.LOCAL_RUNTIME_PROFILE;
    assert.equal((await GET(request())).status, 404);
    let productionCaptureCalled = false;
    publishedPreviewService.refresh = async () => { productionCaptureCalled = true; throw Error("production capture forbidden"); };
    assert.equal((await GET(nextRequest())).status, 404);
    assert.equal(productionCaptureCalled, false);
  } finally {
    publishedPreviewService.refresh = original;
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
