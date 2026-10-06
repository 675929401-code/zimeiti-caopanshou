import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as pricing from "../src/lib/extract-pricing";
import * as transcript from "../src/lib/extract-transcript";
import * as distinctLinks from "../src/lib/extract-distinct-links";
import {
  buildClientRequestFingerprint,
  clearBrowserClientAttempt,
  clearBrowserClientAttemptsById,
  readExtractionJsonResponse,
  resolveBrowserClientAttempt,
} from "../src/lib/extract-client-attempt";

// Route code runs in a VM with mandatory dependency stubs. No environment,
// database, provider, wallet, or network implementation is reachable here.
type Fixture = {
  kind: "single" | "coze";
  price: unknown;
  cash: number;
  response?: Record<string, unknown>;
  failProvider?: boolean;
  revenueFailure?: boolean;
  selectedRole?: string;
};

function loadRoute(fixture: Fixture) {
  const calls = { providers: 0, charges: [] as number[], revenue: 0 };
  const role = fixture.selectedRole || "coze_multifunction_extract";
  const plugin = {
    role, is_active: true, type: "third_party", price_per_use: fixture.price, cost_price: 0,
    config: { api_base_url: "https://provider.invalid/run", api_token: "fixture-placeholder", max_videos_per_batch: "30" },
  };
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const result = () => ({ data: table === "users" ? { cash_balance: fixture.cash }
        : table === "plugins" ? (!filters.role || filters.role === role ? [plugin] : []) : [], error: null });
      const query = {
        select() { return query; },
        eq(key: string, value: unknown) { filters[key] = value; return query; },
        in() { return query; }, limit() { return query; },
        single: async () => {
          const value = result();
          return { ...value, data: Array.isArray(value.data) ? value.data[0] ?? null : value.data };
        },
        maybeSingle: async () => {
          const value = result();
          return { ...value, data: Array.isArray(value.data) ? value.data[0] ?? null : value.data };
        },
        then: (resolveResult: (value: unknown) => unknown) => Promise.resolve(result()).then(resolveResult),
      };
      return query;
    },
  };
  const fakeFetch = async () => { throw new Error("fixture detected an unexpected direct provider request"); };
  class FixtureCozeWorkflowExecutionError extends Error {
    constructor(message: string, readonly terminal = false, readonly providerTaskId?: string) { super(message); }
  }
  const modules: Record<string, unknown> = {
    "@/storage/database/supabase-client": { getSupabaseClient: () => db, getSupabaseAdminClient: () => db },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/extraction-auth": { authorizeExtractionRequest: async () => ({ ok: true, userId: "fixture-user", role: "student" }) },
    "@/lib/coze-workflow-client": { runCozeCaptionWorkflow: async () => {
      calls.providers++;
      if (fixture.failProvider) throw new FixtureCozeWorkflowExecutionError("fixture upstream acknowledgement lost", false, "fixture-task");
      return fixture.response || {
        success: true,
        success_count: 1,
        provider_task_id: "fixture-task",
        captions: [{ url: "https://www.douyin.com/video/1234567890123456789", desc: "fixture", video_url: "https://media.invalid/video.mp4" }],
      };
    }, detectCozeCaptionMode: () => "single_video" },
    "@/lib/coze-extraction-result": {
      cozeCaptionResults: () => [], parseCozeWorkflowResult: () => ({}),
      CozeWorkflowExecutionError: FixtureCozeWorkflowExecutionError,
      cozeWorkflowFailure: () => ({ success: false, provider_call_started: true, retry_safe: false, charged: false, error: "fixture coze failure" }),
    },
    "@/lib/billing": { deductCash: async (_user: string, amount: number) => {
      calls.charges.push(amount); return { success: true, deductedAmount: amount };
    } },
    "@/lib/revenue": { recordRevenue: async () => {
      calls.revenue++; if (fixture.revenueFailure) throw new Error("fixture revenue failure");
    } },
    "@/lib/extract-pricing": pricing,
    "@/lib/extract-transcript": transcript,
    "@/lib/extract-distinct-links": distinctLinks,
    "@/lib/extract-provider-get-once": { ExtractionProviderGetError: class extends Error {}, fetchExtractionProviderGetOnce: fakeFetch },
    "@/lib/extraction-exactly-once": { withExtractionExactlyOnce: (_kind: string, handler: unknown) => handler, checkpointExtractionProviderTask: async () => undefined, checkpointExtractionProviderResult: async () => undefined },
    "@/lib/extraction-provider-error": { extractionProviderProblem: () => undefined },
    "coze-coding-dev-sdk": {},
    "@/lib/cyanlis-client": { getDouyinVideoDetail: async () => ({ success: false }), getDouyinVideoToText: async () => ({ success: false }) },
    "@/lib/extract-download-signature": {},
    "@/lib/extract-local-video-cache": {
      cacheExtractVideoForProvider: async () => null,
      cacheExtractVideoForTemporaryOwner: async () => ({ fileHash: "fixture", temporaryUrl: "/api/extract/local-video?fixture=1", expiresAt: Date.now() + 60_000 }),
    },
  };
  const path = fixture.kind === "coze" ? "src/app/api/extract/coze/route.ts" : "src/app/api/extract/route.ts";
  const compiled = ts.transpileModule(readFileSync(resolve(path), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const fixtureModule = { exports: {} as { POST: (request: Request) => Promise<Response> } };
  runInNewContext(compiled, {
    exports: fixtureModule.exports, module: fixtureModule,
    require: (id: string) => {
      assert.ok(id in modules, `fixture refuses unstubbed import: ${id}`);
      return modules[id];
    },
    fetch: fakeFetch, Request, Response, Headers, URL, URLSearchParams, AbortSignal,
    process: { env: {} }, console: { log() {}, error() {}, warn() {} },
    setTimeout: (callback: () => void) => { callback(); return 0; }, clearTimeout() {},
  });
  return { calls, post: async (body: Record<string, unknown>) => {
    const response = await fixtureModule.exports.POST(new Request("http://fixture.invalid/api/extract", {
      method: "POST", headers: { authorization: "Bearer fixture-placeholder", "Idempotency-Key": "fixture-extract-0001" },
      body: JSON.stringify({ ...body, client_request_id: "fixture-extract-0001" }),
    }));
    return { status: response.status, body: await response.json() };
  } };
}

async function main() {
  for (const zero of [0, "0", "0.00", " 0 "]) assert.equal(pricing.normalizePluginPrice(zero, 0.02), 0);
  for (const invalid of [undefined, null, "", " ", "oops", -1, "-1", NaN, Infinity, false, {}, []]) {
    assert.equal(pricing.normalizePluginPrice(invalid, 0.02), 0.02);
  }
  assert.equal(pricing.normalizePluginPrice("0.015", 0.02), 0.015);
  assert.equal(pricing.extractionTotalPrice(0.02, 3), 0.06);
  assert.equal(pricing.extractionTotalPrice(0.005, 1), 0.01);
  assert.equal(pricing.extractionTotalPrice(0.005, 3), 0.02);
  assert.equal(pricing.normalizeExtractionCount(-1, 10), 10);
  assert.equal(pricing.normalizeExtractionCount(100, 10), 30);

  // Node has no window/localStorage: this specifically exercises the memory fallback.
  const fingerprint = await buildClientRequestFingerprint({ links: ["fixture-a"] });
  const a = resolveBrowserClientAttempt({ storageKey: "fixture", fingerprint, prefix: "extract" });
  resolveBrowserClientAttempt({ storageKey: "fixture", fingerprint: "other-payload", prefix: "extract" });
  const retried = resolveBrowserClientAttempt({ storageKey: "fixture", fingerprint, prefix: "extract" });
  assert.equal(retried.clientRequestId, a.clientRequestId, "unknown A -> B -> A must retain A without localStorage");
  await assert.rejects(readExtractionJsonResponse(new Response("<html>proxy timeout</html>", { status: 200 })));
  await assert.rejects(readExtractionJsonResponse(Response.json(null)));
  assert.equal(resolveBrowserClientAttempt({ storageKey: "fixture", fingerprint, prefix: "extract" }).clientRequestId, a.clientRequestId, "HTTP 200 with invalid JSON must not discard request identity");
  clearBrowserClientAttempt("fixture", a.clientRequestId);
  assert.notEqual(resolveBrowserClientAttempt({ storageKey: "fixture", fingerprint, prefix: "extract" }).clientRequestId, a.clientRequestId);

  const itemFingerprint = await buildClientRequestFingerprint({ kind: "video-batch-item", url: "https://fixture.invalid/video" });
  const itemStorageKey = "extract:fixture-user:video:batch:" + itemFingerprint;
  const pendingItem = resolveBrowserClientAttempt({ storageKey: itemStorageKey, fingerprint: itemFingerprint, prefix: "extract-video" });
  clearBrowserClientAttemptsById("extract:fixture-user:video", pendingItem.clientRequestId);
  const nextItem = resolveBrowserClientAttempt({ storageKey: itemStorageKey, fingerprint: itemFingerprint, prefix: "extract-video" });
  assert.notEqual(nextItem.clientRequestId, pendingItem.clientRequestId, "terminal status must clear the exact per-item attempt before a new submit");

  const links = ["https://www.douyin.com/video/1234567890123456789"];
  const videoFree = loadRoute({ kind: "single", price: "0", cash: 0 });
  const freeResult = await videoFree.post({ links, extraction_mode: "video" });
  assert.equal(freeResult.status, 200);
  assert.equal(freeResult.body.charged, false);
  assert.equal(freeResult.body.price, 0);
  assert.equal(videoFree.calls.providers, 1);
  assert.equal(videoFree.calls.charges.length, 0);

  const videoPoor = loadRoute({ kind: "single", price: 0.02, cash: 0.01 });
  assert.equal((await videoPoor.post({ links, extraction_mode: "video" })).status, 402);
  assert.equal(videoPoor.calls.providers, 0, "preflight must cover the independently submitted link");
  const videoPaid = loadRoute({ kind: "single", price: 0.02, cash: 1 });
  assert.equal((await videoPaid.post({ links, extraction_mode: "video" })).status, 200);
  assert.deepEqual(videoPaid.calls.charges, [0.02]);
  const fractionalPoor = loadRoute({ kind: "single", price: 0.005, cash: 0.006 });
  assert.equal((await fractionalPoor.post({ links, extraction_mode: "video" })).status, 402);
  assert.equal(fractionalPoor.calls.providers, 0, "cent-rounded settlement amount must be used before supplier work");
  const fractionalPaid = loadRoute({ kind: "single", price: 0.005, cash: 0.01 });
  assert.equal((await fractionalPaid.post({ links, extraction_mode: "video" })).status, 200);
  assert.deepEqual(fractionalPaid.calls.charges, [0.01]);
  const videoAccountingUnknown = loadRoute({ kind: "single", price: 0.02, cash: 1, revenueFailure: true });
  const accountingResult = await videoAccountingUnknown.post({ links, extraction_mode: "video" });
  assert.equal(accountingResult.status, 503);
  assert.equal(accountingResult.body.retry_safe, false);
  assert.deepEqual(videoAccountingUnknown.calls.charges, [0.02]);
  assert.equal(videoAccountingUnknown.calls.providers, 1, "revenue failure after wallet charge must not submit another provider");

  console.log("[extract-phase1-zero-cost] PASS: price parsing, wallet cent precision, memory retry identity, per-link shared three-in-one pricing, cent-rounded balance preflight, and fail-closed revenue settlement. All providers/DB/wallets were fixtures; no real requests.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
