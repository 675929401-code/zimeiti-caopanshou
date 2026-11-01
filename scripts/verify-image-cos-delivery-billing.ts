import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual delivery function against an in-memory database adapter.
// No product module initialization, credentials, network, RPC or wallet writes.
const source = readFileSync("src/lib/image-exactly-once.ts", "utf8");
const ast = ts.createSourceFile("image-exactly-once.ts", source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "finalizeImageExactlyOnceDelivery");
assert.ok(declaration, "delivery function missing");
const compiled = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.length || 0, 0);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const userId = "fixture-delivery-owner";
const key = "fixture-client-request";
const trace = "fixture-trace";
const referenceId = `image:h3_${sha256(`${userId}:${key}`).slice(0, 48)}`;
const original = () => ({
  row: { record_id: "fixture-record", user_id: userId, client_idempotency_key: key, client_trace_id: trace,
    state: "completed", response: { storageKey: "fixture/image.png", storageProvider: "tencent_cos" },
    request_snapshot: { quotedPriceYuan: 0.3, billingExempt: false } },
  operations: [{ id: "fixture-charge", user_id: userId, wallet: "cash", idempotency_key: referenceId,
    operation_kind: "cash_charge", amount: "0.300000", delta: "-0.300000", status: "completed" }],
  input: { recordId: "fixture-record", userId, storageKey: "fixture/image.png", storageProvider: "tencent_cos",
    fileName: "image.png", fileSize: 200, contentType: "image/png", source: "image-generation",
    meta: { billingReferenceId: referenceId, quotedPriceYuan: "0.3", billingOperationId: "untrusted-input-id" } },
  rowError: false, billingError: false,
});
type Fixture = ReturnType<typeof original>;
class TestDeliveryError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
async function execute(fixture: Fixture, repetitions = 1) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const db = {
    from(table: string) {
      assert.ok(["image_generation_requests", "wallet_operations"].includes(table));
      const read = { table, filters: [] as Array<[string, unknown]> }; reads.push(read);
      const result = () => table === "image_generation_requests"
        ? { data: fixture.row, error: fixture.rowError ? { code: "fixture-read-error" } : null }
        : { data: fixture.operations, error: fixture.billingError ? { code: "fixture-read-error" } : null };
      const query = {
        select() { return query; }, eq(field: string, value: unknown) { read.filters.push([field, value]); return query; },
        in(field: string, value: unknown) { read.filters.push([field, value]); return query; },
        abortSignal() { return query; }, maybeSingle: async () => result(),
        then(resolve: (value: ReturnType<typeof result>) => unknown) { return Promise.resolve(result()).then(resolve); },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "finalize_image_generation_delivery", "unexpected mutation/RPC");
      calls.push({ name, args });
      return { data: { deliveryAssetId: "fixture-asset", deliveryState: "delivered" }, error: null };
    },
  };
  const exports: { finalizeImageExactlyOnceDelivery?: (input: Fixture["input"]) => Promise<unknown> } = {};
  vm.runInNewContext(compiled.outputText, { exports, getSupabaseAdminClient: () => db, sha256,
    ImageExactlyOnceError: TestDeliveryError, databaseImageExactlyOnceError: (error: unknown) => { throw error; },
    AbortSignal, fetch: () => { throw new Error("NETWORK_FORBIDDEN"); } });
  let error: unknown;
  try { for (let index = 0; index < repetitions; index++) await exports.finalizeImageExactlyOnceDelivery!(fixture.input); }
  catch (caught) { error = caught; }
  for (const read of reads) assert.ok(read.filters.some(([field, value]) => field === "user_id" && value === userId));
  return { calls, reads, error };
}

async function main() {
  let checks = 0;
  const good = await execute(original(), 2);
  assert.equal(good.error, undefined); assert.equal(good.calls.length, 2);
  assert.equal((good.calls[0].args.p_meta as Record<string, unknown>).billingOperationId, "fixture-charge"); checks++;
  const rejected: Array<[string, (fixture: Fixture) => void]> = [
    ["missing charge", f => { f.operations = []; }],
    ["pending charge", f => { f.operations[0].status = "pending"; }],
    ["wrong amount", f => { f.operations[0].amount = "0.2"; }],
    ["wrong delta", f => { f.operations[0].delta = "0"; }],
    ["wrong wallet", f => { f.operations[0].wallet = "credits"; }],
    ["wrong key", f => { f.operations[0].idempotency_key = "different"; }],
    ["wrong owner", f => { f.row.user_id = "different"; }],
    ["wrong storage binding", f => { f.row.response.storageKey = "different"; }],
    ["caller price mismatch", f => { f.input.meta.quotedPriceYuan = "0.2"; }],
    ["caller key mismatch", f => { f.input.meta.billingReferenceId = "different"; }],
    ["request read unavailable", f => { f.rowError = true; }],
    ["wallet read unavailable", f => { f.billingError = true; }],
    ["duplicate charge evidence", f => { f.operations.push({ ...f.operations[0], id: "duplicate" }); }],
    ["zero without exemption", f => { f.row.request_snapshot.quotedPriceYuan = 0; f.input.meta.quotedPriceYuan = "0"; f.operations = []; }],
  ];
  for (const status of ["pending", "failed", "completed"]) for (const suffix of ["", ":release"]) {
    rejected.push([`refund ${status} ${suffix || "original-key"}`, f => {
      f.operations.push({ ...f.operations[0], id: "refund", operation_kind: "cash_refund", idempotency_key: referenceId + suffix, status });
    }]);
  }
  for (const [label, mutate] of rejected) {
    const fixture = original(); mutate(fixture); const result = await execute(fixture);
    assert.ok(result.error instanceof TestDeliveryError, label); assert.equal(result.calls.length, 0, label); checks++;
  }
  const free = original(); free.row.request_snapshot = { quotedPriceYuan: 0, billingExempt: true };
  free.input.meta.quotedPriceYuan = "0"; free.operations = [];
  const zero = await execute(free); assert.equal(zero.error, undefined); assert.equal(zero.calls.length, 1); checks++;
  const admin = original(); admin.row.client_idempotency_key = `admin_${sha256(trace).slice(0, 48)}`;
  admin.input.meta.billingReferenceId = `image:${trace}`; admin.operations[0].idempotency_key = `image:${trace}`;
  const legacy = await execute(admin); assert.equal(legacy.error, undefined); assert.equal(legacy.calls.length, 1); checks++;
  console.log(JSON.stringify({ passed: true, checks, networkCalls: 0, realDatabaseCalls: 0,
    limitation: "Read guard does not make legacy delivery RPC atomic with ledger changes." }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
