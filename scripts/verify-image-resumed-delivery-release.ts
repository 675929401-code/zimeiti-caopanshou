import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const file = "src/app/api/image/generate/route.ts";
const source = readFileSync(file, "utf8");
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
let resume = "", release = "";
function walk(node: ts.Node) {
  if (ts.isIfStatement(node)) {
    if (node.expression.getText(tree) === "resumingImageDelivery") resume = node.getText(tree);
    if (node.expression.getText(tree) === "billingReservation") release = node.getText(tree);
  }
  ts.forEachChild(node, walk);
}
walk(tree);
assert.ok(resume && release);
class Rejected extends Error { }
class ExactlyOnce extends Error { constructor(public code: string, message: string) { super(message); } }
class Candidate extends Error { code = "unused"; }
const compile = (code: string, context: object) => vm.runInNewContext(ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { Error, console, ...context });
const checks: string[] = [];
async function main() {
  const binding = { userId: "owner", billingReferenceId: "image:original", generationIdempotencyKey: "original-key", traceId: "original-trace" };
  for (const snapshot of [{ billingExempt: false, quotedPriceYuan: 0.3 }, { billingExempt: true, quotedPriceYuan: 0 }]) {
    const state = { reservation: null as unknown };
    compile(`${resume}\nimageBudgetState;`, { ...binding, resumingImageDelivery: true, previousImageRequest: { requestSnapshot: snapshot },
      parseImageFailureRequestSnapshot: (value: unknown) => value, imageBudgetState: state, ImageExactlyOnceError: ExactlyOnce });
    if (snapshot.billingExempt) assert.equal(state.reservation, null);
    else assert.deepEqual(JSON.parse(JSON.stringify(state.reservation)), { userId: "owner", amount: 0.3, referenceId: "image:original",
      clientIdempotencyKey: "original-key", clientTraceId: "original-trace", requiresLedgerConfirmation: true });
  }
  checks.push("Recovery reconstructs only the original paid reservation; explicit exempt remains uncharged");
  assert.throws(() => compile(resume, { ...binding, resumingImageDelivery: true, previousImageRequest: {},
    parseImageFailureRequestSnapshot: () => null, ImageExactlyOnceError: ExactlyOnce }), /费用快照/);
  checks.push("Missing original billing snapshot stops delivery before claiming release");
  for (const scenario of ["released", "refund-failed", "readback-unknown", "ledger-unknown", "already-released", "durable-result"] as const) {
    let refunds = 0, marks = 0, reads = 0;
    const context = { ...binding, error: new Rejected("Wrong dimensions"), ImageRequestRejectedError: Rejected,
      ImageCandidateFailure: Candidate, hasImageProviderCheckpoint: () => false,
      imageExactlyOnceStore: { get: async () => ({ state: scenario === "durable-result" ? "completed" : "failed_unknown" }),
        markRejectionBillingRelease: async () => { marks++; } },
      readImageReservationBilling: async () => { reads++; return { state: scenario === "ledger-unknown" ? "unknown"
        : scenario === "already-released" ? "not_charged" : reads === 1 ? "charged"
          : scenario === "readback-unknown" ? "unknown" : "not_charged", chargedAmount: 0.3 }; },
      refundCash: async (owner: string, amount: number, _description: string, key: string) => {
        refunds++; assert.equal(owner, binding.userId); assert.equal(amount, 0.3); assert.equal(key, "image:original:release");
        return { success: scenario !== "refund-failed" };
      }, summarizeUpstreamImageError: () => "safe", NextResponse: { json: (body: unknown, options: unknown) => ({ body, options }) } };
    const result = await compile(`(async () => { let billingReservation = { userId: "owner", amount: 0.3, referenceId: "image:original",
      clientIdempotencyKey: "original-key", clientTraceId: "original-trace", requiresLedgerConfirmation: true }; let deductResult = null;
      ${release}\nreturn { cleared: billingReservation === null }; })()`, context);
    if (["released", "already-released"].includes(scenario)) { assert.equal(result.cleared, true); assert.equal(marks, 1); }
    else if (scenario === "durable-result") { assert.equal(result.cleared, false); assert.equal(marks, 0); }
    else { assert.equal(result.body.billingReleaseState, "pending"); assert.equal(result.body.canResubmit, false); assert.equal(marks, 0); }
    assert.equal(refunds, ["ledger-unknown", "already-released", "durable-result"].includes(scenario) ? 0 : 1);
    checks.push(`Original-key refund/readback: ${scenario}`);
  }
  const directory = ".codex-evidence/storyboard-delivery-audit-20261023/repair/root";
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/resumed-billing-tests.json`, JSON.stringify({ passed: true, count: checks.length, checks,
    source: file, sha256: createHash("sha256").update(source).digest("hex"), realDatabaseCalls: 0, providerCalls: 0 }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
