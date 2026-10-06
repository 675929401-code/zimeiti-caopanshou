import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const sourcePath = path.join(root, "src/lib/revenue.ts");
const source = fs.readFileSync(sourcePath, "utf8");

const state = {
  insertResult: { error: null },
  inserted: [],
  existing: null,
  readError: null,
};

const database = {
  from(table) {
    assert.equal(table, "revenue_records");
    return {
      async insert(payload) {
        state.inserted.push(structuredClone(payload));
        return state.insertResult;
      },
      select(columns) {
        assert.match(columns, /\bprofit\b/u);
        return {
          eq() { return this; },
          limit() { return this; },
          async maybeSingle() {
            return { data: state.existing, error: state.readError };
          },
        };
      },
    };
  },
};

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText;

const compiledModule = { exports: {} };
vm.runInNewContext(compiled, {
  module: compiledModule,
  exports: compiledModule.exports,
  require(specifier) {
    if (specifier === "@/storage/database/supabase-client") {
      return { getSupabaseAdminClient: () => database };
    }
    throw new Error(`Unexpected import: ${specifier}`);
  },
  console,
  Number,
  Object,
  Error,
}, { filename: sourcePath });

const { calculateRevenueProfitYuan, recordRevenue } = compiledModule.exports;

assert.equal(calculateRevenueProfitYuan(0.004896, 0.004406), 0.00049);
assert.equal(calculateRevenueProfitYuan(0.3, 0.1), 0.2);
assert.equal(calculateRevenueProfitYuan(0, 0), 0);
assert.equal(Object.is(calculateRevenueProfitYuan(0, 0), -0), false);

const input = {
  userId: "fixture-user",
  userRole: "student",
  modelId: "llm:fixture-model",
  taskId: "fixture-request",
  costPrice: 0.004406,
  sellingPrice: 0.004896,
  recordType: "chat",
  creditsCharged: 0.25,
  cashCharged: 0,
};

await recordRevenue(input);
assert.equal(state.inserted.length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(state.inserted[0])),
  {
    user_id: "fixture-user",
    model_id: "llm:fixture-model",
    task_id: "fixture-request",
    cost_price: 0.004406,
    selling_price: 0.004896,
    profit: 0.00049,
    is_admin: false,
    record_type: "chat",
    credits_charged: 0.25,
    cash_charged: 0,
    billing_exempt: false,
  },
);

state.insertResult = { error: { code: "23505", message: "duplicate" } };
state.existing = structuredClone(state.inserted[0]);
await recordRevenue(input);

state.existing = { ...state.existing, profit: null };
await assert.rejects(
  recordRevenue(input),
  /收益幂等键 fixture-request 已被不同账务快照占用/u,
);

console.log("PASS verify-revenue-profit-zero-cost: RMB profit is persisted and checked during idempotent replay; no network or database writes were made.");
