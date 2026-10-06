import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";

const sourcePath = "src/app/api/image/generate/route.ts";
const source = fs.readFileSync(sourcePath, "utf8");
const before = fs.readFileSync(
  "任务快照/image-explicit-zero-price-20260903-012050/src/app/api/image/generate/route.ts",
  "utf8",
);
const report = {
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  actualRouteAst: true,
  actualBillingExecutor: true,
  realNetwork: 0,
  realDatabaseWrites: 0,
  localWrites: 0,
  cases: [],
};
const state = {};

function reset() {
  Object.assign(state, {
    walletCalls: [],
    wallet: new Map(),
    deliveries: [],
    assets: new Map(),
    walletFailure: false,
  });
}

function evaluate(text, extra = {}) {
  const compiledModule = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      module: compiledModule,
      exports: compiledModule.exports,
      console: { log() {}, error() {} },
      Date,
      Number,
      Error,
      String,
      Math,
      ...extra,
    },
  );
  return compiledModule.exports;
}

function parse(text) {
  const ast = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
  const post = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "POST",
  );
  assert.ok(post?.body, "image route POST body must exist");
  const tryStatement = post.body.statements.find(ts.isTryStatement);
  assert.ok(tryStatement, "image route POST try block must exist");
  return { ast, statements: tryStatement.tryBlock.statements };
}

function declares(node, ast, name) {
  return ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => item.name.getText(ast) === name);
}

const currentAst = parse(source).ast;
const priceHelper = currentAst.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "configuredImagePrice",
);
assert.ok(priceHelper, "configuredImagePrice must exist");
const { configuredImagePrice } = evaluate(`export ${priceHelper.getText(currentAst)}`);

const executorSource = fs.readFileSync("src/lib/billing-executor.ts", "utf8");
const executorAst = ts.createSourceFile(
  "billing-executor.ts",
  executorSource,
  ts.ScriptTarget.Latest,
  true,
);
const executorFunctions = executorAst.statements
  .filter(
    (node) => ts.isFunctionDeclaration(node)
      && ["validateMutationInput", "executeCashDeduction"].includes(node.name?.text),
  )
  .map((node) => node.getText(executorAst))
  .join("\n");
const actualDeduction = evaluate(executorFunctions, {
  applyAtomicWalletOperation: async (input) => {
    state.walletCalls.push(structuredClone(input));
    if (state.walletFailure) return { success: false, error: "fixture wallet unavailable" };
    if (state.wallet.has(input.idempotencyKey)) {
      return { ...state.wallet.get(input.idempotencyKey), alreadyFulfilled: true };
    }
    const result = {
      success: true,
      balanceAfter: 0.8,
      operationId: "fixture-wallet-operation",
      alreadyFulfilled: false,
    };
    state.wallet.set(input.idempotencyKey, result);
    return result;
  },
}).executeCashDeduction;

const runtime = {
  configuredImagePrice,
  executeCashDeduction: actualDeduction,
  NextResponse: { json: (body, init) => Response.json(body, init) },
  publicModelDisplayName: (row) => row.name,
  ImageRequestRejectedError: class ImageRequestRejectedError extends Error {
    constructor(rejection) {
      super(rejection.code);
      this.rejection = rejection;
    }
  },
  finalizeImageExactlyOnceDelivery: async (input) => {
    state.deliveries.push(structuredClone(input));
    if (!state.assets.has(input.recordId)) {
      state.assets.set(input.recordId, {
        assetId: "fixture-original-owned-image",
        input: structuredClone(input),
      });
    }
    return {
      assetId: state.assets.get(input.recordId).assetId,
      deliveryState: "delivered",
    };
  },
};

function compilePricing(text) {
  const { ast, statements } = parse(text);
  const start = statements.findIndex((node) => declares(node, ast, "costPrice"));
  assert.ok(start > 0, "price statements must exist");
  return evaluate(
    `export async function run(modelConfig, effectiveMode = "local", workflowCostPriceGlobal = Number.NaN, workflowSellingPriceGlobal = Number.NaN) {
      const resumeSnapshot = null, effectiveResolution = "1K";
      ${statements.slice(start, start + 3).map((node) => node.getText(ast)).join("\n")}
      return { costPrice, sellingPrice };
    }`,
    {
      ...runtime,
      resolveImageResolutionPrice(model, _resolution, kind) {
        return configuredImagePrice(kind === "cost" ? model.cost_price : model.selling_price);
      },
      NextResponse: { json: (body, init) => Response.json(body, init) },
    },
  ).run;
}

function compileWorkflowPrice() {
  const { ast, statements } = parse(source);
  const workflowBranch = statements.find(
    (node) => ts.isIfStatement(node)
      && node.expression.getText(ast) === 'effectiveMode === "workflow"',
  );
  assert.ok(workflowBranch, "workflow pricing branch must exist");
  return evaluate(
    `export async function run(pluginData) {
      let workflowCostPriceGlobal = Number.NaN, workflowSellingPriceGlobal = Number.NaN;
      const workflowConfig = { apiUrl: "", appId: "", apiToken: "" };
      const dbClient = {
        from() {
          const query = {
            select() { return query; },
            eq() { return query; },
            limit() { return query; },
            maybeSingle: async () => ({ data: pluginData }),
          };
          return query;
        },
      };
      ${workflowBranch.thenStatement.getText(ast)}
      return { costPrice: workflowCostPriceGlobal, sellingPrice: workflowSellingPriceGlobal };
    }`,
    runtime,
  ).run;
}

function compileBillingLifecycle() {
  const { ast, statements } = parse(source);
  const label = statements.find((node) => declares(node, ast, "userVisibleModelLabel"));
  const reservation = statements.find((node) => declares(node, ast, "reserveImageBudgetOnce"));
  const delivery = statements.find((node) => declares(node, ast, "delivery"));
  assert.ok(label && reservation && delivery, "reservation and delivery statements must exist");
  return evaluate(
    `export async function run({ sellingPrice = 0, costPrice = 0.08, isAdmin = false } = {}) {
      const effectiveMode = "local";
      const publicModelLabel = "Fixture image";
      const modelConfig = { id: "fixture-model", name: "Fixture image" };
      const workflowConfig = { appId: "" };
      const userId = "fixture-user";
      const h3OperationId = "fixture-original-operation";
      const selectedBillingPublicModelId = "pm_fixture";
      const ratio = "1:1";
      const effectiveResolution = "1K";
      const generationIdempotencyKey = "fixture-client-request";
      const traceId = "fixture-original-trace";
      const imageBudgetState = { deduction: null, reservation: null };
      const billingReferenceId = \`image:\${h3OperationId}\`;
      ${label.getText(ast)}
      ${reservation.getText(ast)}
      await reserveImageBudgetOnce?.();
      const deductResult = imageBudgetState.deduction;
      const exactResult = { record: { recordId: "fixture-image-request" } };
      const autodlH3StoredObjectKey = "owned/original.png";
      const storedProvider = "fixture-object";
      const storedFileName = "original.png";
      const storedFileSize = 128;
      const storedContentType = "image/png";
      const storedSource = "image-generation";
      const selectedModelId = "fixture-model";
      ${delivery.getText(ast)}
      return { delivery, deductResult, reservation: imageBudgetState.reservation, isAdmin };
    }`,
    runtime,
  ).run;
}

const price = compilePricing(source);
const oldPrice = compilePricing(before);
const workflowPrice = compileWorkflowPrice();
const billing = compileBillingLifecycle();

async function test(name, fn) {
  reset();
  await fn();
  report.cases.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

async function rejected(value, status, code) {
  assert.equal(value.status, status);
  assert.equal((await value.json()).code, code);
}

await test("old real price branch rejects configured zero", async () => {
  await rejected(
    await oldPrice({ cost_price: 0.08, selling_price: 0 }),
    503,
    "IMAGE_PRICE_NOT_CONFIGURED",
  );
});

await test("configured numeric and numeric-string zero retain the real cost", async () => {
  for (const zero of [0, "0", "0.00"]) {
    const result = await price({ cost_price: "0.08", selling_price: zero });
    assert.equal(result.sellingPrice, 0);
    assert.equal(result.costPrice, 0.08);
  }
});

await test("explicit zero cost is valid independently of positive or zero sale price", async () => {
  for (const sale of [0, 0.2]) {
    const result = await price({ cost_price: 0, selling_price: sale });
    assert.equal(result.costPrice, 0);
    assert.equal(result.sellingPrice, sale);
  }
});

await test("missing blank nonnumeric negative and nonfinite values never become free", async () => {
  const invalidValues = [
    null,
    undefined,
    "",
    "   ",
    false,
    true,
    [],
    {},
    "invalid",
    -0.01,
    "-0.01",
    Infinity,
    Number.NaN,
  ];
  for (const invalid of invalidValues) {
    for (const field of ["cost_price", "selling_price"]) {
      await rejected(
        await price({ cost_price: 0.08, selling_price: 0.2, [field]: invalid }),
        503,
        "IMAGE_PRICE_NOT_CONFIGURED",
      );
    }
  }
});

await test("workflow reads configured zero without a default price and rejects missing cost", async () => {
  const result = await workflowPrice({ config: {}, cost_price: 0.08, price_per_use: 0 });
  assert.equal(result.costPrice, 0.08);
  assert.equal(result.sellingPrice, 0);
  await rejected(
    await workflowPrice({ config: {}, cost_price: null, price_per_use: 0 }),
    503,
    "IMAGE_PRICE_NOT_CONFIGURED",
  );
});

await test("zero price skips wallet reservation and delivers with an explicit zero-price exemption", async () => {
  const ordinary = await billing();
  const admin = await billing({ isAdmin: true });
  assert.equal(state.walletCalls.length, 0);
  assert.equal(state.assets.size, 1);
  assert.equal(ordinary.reservation, null);
  assert.equal(admin.reservation, null);
  for (const input of state.deliveries) {
    assert.equal(input.meta.quotedPriceYuan, "0");
    assert.equal(input.meta.actualCostPriceYuan, "0.08");
    assert.equal(input.meta.billingExempt, "true");
    assert.equal(input.meta.billingExemptionReason, "zero_price");
    assert.equal(input.meta.billingOperationId, "");
  }
});

await test("positive quotes reserve once per idempotency key for ordinary and admin users", async () => {
  const ordinary = await billing({ sellingPrice: 0.2 });
  const admin = await billing({ sellingPrice: 0.2, isAdmin: true });
  assert.equal(state.wallet.size, 1);
  assert.equal(state.walletCalls.length, 2);
  assert.equal(state.walletCalls[0].amount, 0.2);
  assert.equal(state.walletCalls[0].idempotencyKey, state.walletCalls[1].idempotencyKey);
  assert.equal(state.walletCalls[0].metadata.phase, "image_provider_reservation");
  assert.equal(ordinary.reservation.referenceId, "image:fixture-original-operation");
  assert.equal(admin.reservation.referenceId, "image:fixture-original-operation");
  for (const input of state.deliveries) {
    assert.equal(input.meta.billingExempt, "false");
    assert.equal(input.meta.billingExemptionReason, "none");
    assert.equal(input.meta.billingOperationId, "fixture-wallet-operation");
  }
});

await test("failed positive wallet reservation never delivers an asset", async () => {
  state.walletFailure = true;
  await assert.rejects(
    () => billing({ sellingPrice: 0.2 }),
    (error) => error?.rejection?.code === "IMAGE_BILLING_RESERVATION_REJECTED",
  );
  assert.equal(state.assets.size, 0);
  assert.equal(state.deliveries.length, 0);
});

await test("membership readiness and paid debt gates precede the durable provider lifecycle", async () => {
  const membership = source.indexOf("if (!isAdmin && !resumeDeliveryOnly)");
  const readiness = source.indexOf("const prerequisites = await probeImageGenerationReadiness");
  const paidPrecheck = source.indexOf("if (sellingPrice > 0)", readiness);
  const lifecycle = source.indexOf("const exactResult = await runImageExactlyOnce");
  assert.ok(membership >= 0 && membership < readiness);
  assert.ok(readiness < paidPrecheck && paidPrecheck < lifecycle);
  assert.match(source, /if \(sellingPrice > 0\)[\s\S]*?checkAndCollectDebt\(userId\)/u);
  assert.match(source, /billingExempt: String\(sellingPrice === 0\)/u);
  assert.doesNotMatch(source, /billingExemptionReason:\s*isAdmin/u);
});

report.passed = report.cases.length;
console.log(JSON.stringify(report, null, 2));
