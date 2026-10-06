import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const read = (file) => fs.readFileSync(`${root}/${file}`, "utf8");

function loadTypeScript(file, modules = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    Response,
    Request,
    URL,
    Date,
    console,
    require(id) {
      assert.ok(Object.hasOwn(modules, id), `Unexpected module import: ${id}`);
      return modules[id];
    },
  }, { filename: file });
  return module.exports;
}

const network = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("REAL_NETWORK_FORBIDDEN");
};

try {
  const rejection = loadTypeScript("src/lib/image-request-rejection.ts");
  const recovery = loadTypeScript("src/lib/image-unresolved-requests.ts", {
    "@/lib/image-request-rejection": rejection,
  });
  const now = "2026-09-16T02:00:00.000Z";
  const base = {
    client_idempotency_key: "image_key_00000001",
    client_trace_id: "image_trace_000001",
    payload_fingerprint: "a".repeat(64),
    state: "intent",
    response: null,
    delivery_state: "held",
    delivery_asset_id: null,
    updated_at: now,
  };
  const rows = [
    base,
    { ...base, client_idempotency_key: "image_key_00000002", response: { schema: "image_provider_checkpoint.v1" } },
    { ...base, client_idempotency_key: "image_key_00000003", state: "failed_unknown" },
    { ...base, client_idempotency_key: "image_key_00000004", state: "completed", response: { imageStorageUri: "private" } },
    { ...base, client_idempotency_key: "image_key_00000005", state: "completed", delivery_state: "delivered", delivery_asset_id: "asset-owner-a" },
    { ...base, client_idempotency_key: "image_key_00000006", state: "failed_unknown", response: {
      schema: "image_request_rejection.v1",
      payloadFingerprint: "a".repeat(64),
      source: "provider",
      code: "IMAGE_UPSTREAM_REQUEST_REJECTED",
      upstreamStatus: 422,
    } },
  ];
  const mapped = rows.map(recovery.toImageUnresolvedRequestReference).filter(Boolean);
  assert.deepEqual(mapped.map((record) => record.state), [
    "processing",
    "provider_completed_pending_delivery",
    "unknown",
    "provider_completed_pending_delivery",
  ]);
  assert.equal(mapped.some((record) => record.generationKey === "image_key_00000005"), false, "delivered results are history, not unresolved work");
  assert.equal(mapped.some((record) => record.generationKey === "image_key_00000006"), false, "bound terminal rejection remains in failure history");
  assert.equal(JSON.stringify(mapped).includes("private"), false, "private provider response must never enter the DTO");
  assert.equal(recovery.toImageUnresolvedRequestReference({ ...base, client_idempotency_key: "short" }), null);
  assert.equal(recovery.parseImageUnresolvedRequestReferences([...mapped, mapped[0], { ...mapped[0], generationTraceId: "bad" }]).length, mapped.length);

  const queryCalls = [];
  let selectedTable = "";
  let queryError = null;
  const terminalRejection = {
    schema: "image_request_rejection.v1",
    payloadFingerprint: "a".repeat(64),
    source: "provider",
    code: "IMAGE_UPSTREAM_REQUEST_REJECTED",
    upstreamStatus: 422,
  };
  const oldUnknown = {
    ...base,
    client_idempotency_key: "image_old_unknown_0001",
    client_trace_id: "image_old_trace_0001",
    state: "failed_unknown",
    updated_at: "2026-09-15T01:00:00.000Z",
  };
  const routeRows = [
    ...Array.from({ length: 260 }, (_, index) => ({
      ...base,
      client_idempotency_key: `terminal_${String(index).padStart(8, "0")}`,
      client_trace_id: `terminal_trace_${String(index).padStart(8, "0")}`,
      state: "failed_unknown",
      response: terminalRejection,
      updated_at: new Date(Date.parse(now) + index * 1000).toISOString(),
    })),
    ...Array.from({ length: 101 }, (_, index) => ({
      ...base,
      client_idempotency_key: `delivered_${String(index).padStart(8, "0")}`,
      client_trace_id: `delivered_trace_${String(index).padStart(8, "0")}`,
      state: "completed",
      delivery_state: "delivered",
      delivery_asset_id: `asset-${index}`,
      updated_at: new Date(Date.parse(now) + index * 1000).toISOString(),
    })),
    ...rows,
    oldUnknown,
  ];
  const db = {
    from(table) {
      selectedTable = table;
      const filters = [];
      let range = [0, routeRows.length - 1];
      const execute = async () => {
        if (queryError) return { data: null, error: queryError };
        const data = routeRows
          .filter((row) => filters.every(([column, value]) => {
            if (column === "user_id" || column === "request_snapshot->>surface") return true;
            return row[column] === value;
          }))
          .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
          .slice(range[0], range[1] + 1);
        return { data, error: null };
      };
      const query = {
        select(columns) { queryCalls.push(["select", columns]); return query; },
        eq(column, value) { queryCalls.push(["eq", column, value]); filters.push([column, value]); return query; },
        order(column, value) { queryCalls.push(["order", column, value]); return query; },
        range(from, to) { queryCalls.push(["range", from, to]); range = [from, to]; return query; },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      return query;
    },
  };
  const owner = { id: "owner-a" };
  const route = loadTypeScript("src/app/api/image-workbench/unresolved/route.ts", {
    "@supabase/supabase-js": {},
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/api-middleware": { withAuth: async (request, handler) => handler(owner, db, request) },
    "@/lib/image-failure-history": { IMAGE_FAILURE_HISTORY_SURFACE: "image-workbench" },
    "@/lib/image-unresolved-requests": recovery,
  });
  const response = await route.GET(new Request("http://fixture.invalid/api/image-workbench/unresolved"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(selectedTable, "image_generation_requests");
  assert.ok(queryCalls.some((call) => call[0] === "eq" && call[1] === "user_id" && call[2] === owner.id));
  assert.ok(queryCalls.some((call) => call[0] === "eq" && call[1] === "request_snapshot->>surface" && call[2] === "image-workbench"));
  assert.ok(queryCalls.some((call) => call[0] === "eq" && call[1] === "state" && call[2] === "failed_unknown"));
  assert.ok(queryCalls.filter((call) => call[0] === "range").length >= 4, "terminal rows must be paged past instead of hiding an older unknown request");
  assert.ok(body.records.some((record) => record.generationKey === oldUnknown.client_idempotency_key), "older unresolved request must survive newer delivered/terminal rows");
  assert.equal(body.records.some((record) => record.generationKey.startsWith("delivered_")), false);
  assert.equal(body.records.some((record) => record.generationKey.startsWith("terminal_")), false);
  for (const privateField of ["prompt", "request_snapshot", "payload_fingerprint", "response", "user_id", "billing"]) {
    assert.equal(JSON.stringify(body).includes(privateField), false, `response leaked ${privateField}`);
  }
  queryError = { code: "PGRST204", message: "Could not find request_snapshot column in the schema cache" };
  const migrationPending = await route.GET(new Request("http://fixture.invalid/api/image-workbench/unresolved"));
  assert.equal(migrationPending.status, 200);
  const migrationBody = await migrationPending.json();
  assert.deepEqual(migrationBody.records, []);
  assert.equal(migrationBody.recoveryReady, false);
  assert.equal(migrationBody.code, "IMAGE_UNRESOLVED_RECOVERY_MIGRATION_NOT_READY");

  queryError = new Error("fixture database unavailable");
  const unavailable = await route.GET(new Request("http://fixture.invalid/api/image-workbench/unresolved"));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "IMAGE_UNRESOLVED_RECOVERY_UNAVAILABLE");

  const routeSource = read("src/app/api/image-workbench/unresolved/route.ts");
  assert.doesNotMatch(routeSource, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/u, "GET must stay read-only");
  const component = read("src/components/image-workbench.tsx");
  const start = component.indexOf("async function loadAccountUnresolvedImageAttempts");
  const end = component.indexOf("void loadAccountUnresolvedImageAttempts();", start);
  assert.ok(start > 0 && end > start, "startup recovery block missing");
  const startup = component.slice(start, end);
  assert.match(startup, /fetch\("\/api\/image-workbench\/unresolved"/u);
  assert.match(startup, /method: "GET"/u);
  assert.match(startup, /prompt: ""/u, "startup must reattach only an opaque request pointer");
  assert.doesNotMatch(startup, /\/api\/image\/generate|method: "POST"|generateAll/u, "startup must never submit generation");
  assert.match(component, /仅保留追踪编号，不加载旧提示词，也不会自动提交/u);

  const generation = read("src/app/api/image/generate/route.ts");
  assert.match(generation, /previousImageRequest && !resumingImageDelivery/u);
  assert.match(generation, /IMAGE_IDEMPOTENCY_FAIL_CLOSED/u);
  assert.match(generation, /executeCashDeduction\(/u);
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({
    ok: true,
    cases: 28,
    ownerScoped: true,
    readOnlyGet: true,
    promptDraftsRestored: false,
    automaticSubmissions: 0,
    providerCalls: 0,
    databaseWrites: 0,
    networkCalls,
  }));
} finally {
  globalThis.fetch = network;
}
