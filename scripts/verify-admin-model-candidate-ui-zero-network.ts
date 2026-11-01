import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { readModelCandidateReceipt, modelCandidateRequestUncertain, modelCandidateSaveMessage } from "../src/components/admin/model-candidate-receipt";
import { modelMutationAttempt } from "../src/components/admin/model-mutation-request";

const tabFile = "src/components/unified-models-tab.tsx";
const tabSource = fs.readFileSync(tabFile, "utf8");
const tabAst = ts.createSourceFile(tabFile, tabSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const expressions = new Map<string, ts.Expression>();
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) expressions.set(node.name.text, node.initializer);
  ts.forEachChild(node, collect);
}
collect(tabAst);
const receiptBody = { staged: true, published: false, result: { release: { id: "fixture-release-105", release_version: 105 } } };
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

function harness(fetcher: (url: string, init?: RequestInit) => unknown) {
  const state = { requests: [] as Array<{ url: string; method: string }>, closed: 0, refreshes: 0, notices: [] as Array<Record<string, unknown>>, alerts: [] as string[], focus: "", saves: [] as boolean[], draft: null as Record<string, unknown> | null };
  const context = vm.createContext({ URLSearchParams, token: "fixture-only", canManageModels: true, candidateUncertain: false,
    candidateWriteLock: { current: false }, saveAttempt: { current: null }, modelMutationAttempt, editingModel: null, authHeaders: {},
    quickAddText: "https://fixture.invalid/v1 fixture-model 售价1.2", quickAddBusy: false,
    pendingOrderType: "video", pendingOrders: [{ id: "video-fixture", sort_order: 10 }], orderSaveState: "dirty",
    readModelCandidateReceipt, modelCandidateRequestUncertain, modelCandidateSaveMessage, withoutModelSecret: (value: unknown) => value,
    fetch: (url: string, init?: RequestInit) => { state.requests.push({ url, method: init?.method || "GET" }); return fetcher(url, init); },
    checkBillingChange: () => ({ changed: false }), confirm: () => true,
    setShowDialog: (value: boolean) => { if (!value) state.closed++; }, setEditingModel() {},
    setModelPoolReleaseRefreshKey: () => { state.refreshes++; }, loadModels: async () => {}, onModelsChange() {},
    setFocusReleaseId: (id: string) => { state.focus = id; }, alert: (value: string) => state.alerts.push(value),
    setCandidateSaving: (value: boolean) => state.saves.push(value), setModelSaveError() {},
    setCandidateNotice: (value: Record<string, unknown>) => state.notices.push(value),
    setCandidateUncertain: (value: boolean) => { context.candidateUncertain = value; },
    setQuickAddBusy() {}, setQuickAddMsg() {}, setDialogModelType() {}, setModelDraft: (value: Record<string, unknown>) => { state.draft = value; },
    setModels() {}, setPendingOrderType() {}, setPendingOrders() {}, setOrderSaveState() {}, setTimeout() {},
  });
  for (const name of ["handleSave", "handleDelete", "handleQuickAdd", "savePendingOrder"]) {
    const expression = expressions.get(name);
    assert.ok(expression, `${name}:PRODUCTION_HANDLER_REQUIRED`);
    const arrow = ts.isCallExpression(expression) ? expression.arguments[0] : expression;
    const js = ts.transpileModule(`globalThis.${name} = ${arrow.getText(tabAst)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInContext(js, context);
  }
  return { context, state };
}

async function main() {
  const checks: string[] = [];
  assert.deepEqual(readModelCandidateReceipt(receiptBody), { id: "fixture-release-105", version: 105 });
  for (const invalid of [{}, { success: true, model: { id: "legacy-success" } }, { ...receiptBody, published: true }, { ...receiptBody, result: { release: {} } }]) {
    assert.throws(() => readModelCandidateReceipt(invalid));
  }
  checks.push("candidate-receipt-required-not-http-success");
  let releaseFetch: ((value: unknown) => void) | undefined;
  const concurrent = harness(() => new Promise(resolve => { releaseFetch = resolve; }));
  const first = concurrent.context.handleSave({ model_type: "text" });
  const second = concurrent.context.handleSave({ model_type: "text" });
  assert.equal(concurrent.state.requests.length, 1, "SYNCHRONOUS_DOUBLE_CLICK_MUST_NOT_CREATE_TWO_CANDIDATES");
  assert.deepEqual(concurrent.state.saves, [true]);
  releaseFetch!(response(202, receiptBody));
  await Promise.all([first, second]);
  assert.equal(concurrent.state.closed, 1);
  assert.equal(concurrent.state.focus, "fixture-release-105");
  assert.equal(concurrent.state.notices.at(-1)?.kind, "staged");
  assert.deepEqual(concurrent.state.saves, [true, false]);
  checks.push("single-dispatch-pending-lock-valid-staged-receipt-focus");

  for (const [name, result] of [["empty-success", () => response(200, {})], ["server-error", () => response(503, { error: "fixture-service-error" })], ["network-unknown", () => Promise.reject(new Error("fixture-network-error"))]] as const) {
    const sample = harness(result);
    await sample.context.handleSave({ model_type: "video" });
    assert.equal(sample.state.closed, 0);
    assert.equal(sample.context.candidateUncertain, true);
    assert.equal(sample.state.notices.at(-1)?.kind, "unknown");
    await sample.context.handleSave({ model_type: "video" });
    assert.equal(sample.state.requests.length, 1, `${name}:NO_BLIND_RESUBMISSION`);
    checks.push(`${name}-preserved-form-and-no-blind-retry`);
  }
  const rejected = harness(() => response(400, { error: "fixture-invalid-input" }));
  await rejected.context.handleSave({ model_type: "text" });
  assert.equal(rejected.context.candidateUncertain, false);
  assert.equal(rejected.state.notices.at(-1)?.kind, "rejected");
  assert.equal(rejected.state.closed, 0);
  checks.push("explicit-input-rejection-remains-editable");

  const refresh = harness(() => response(202, receiptBody));
  refresh.context.loadModels = async () => { throw new Error("fixture-readback-network-error"); };
  await refresh.context.handleSave({ model_type: "drawing" });
  assert.equal(refresh.state.notices.at(-1)?.kind, "staged");
  assert.equal((refresh.state.notices.at(-1)?.receipt as { id: string }).id, "fixture-release-105");
  assert.equal(refresh.context.candidateUncertain, false);
  checks.push("known-saved-candidate-survives-directory-refresh-error");

  const retired = harness(() => response(202, { ...receiptBody, retiredCandidate: true, deleted: false }));
  await retired.context.handleDelete({ id: "video-fixture", model_type: "video", name: "fixture video" });
  assert.equal(retired.state.requests[0].method, "DELETE");
  assert.equal(retired.state.focus, "fixture-release-105");
  assert.match(String(retired.state.notices.at(-1)?.message), /当前运行模型未删除/u);
  checks.push("retirement-candidate-not-false-deletion-and-focus");
  const retiredRefresh = harness(() => response(202, receiptBody));
  retiredRefresh.context.loadModels = async () => { throw new Error("fixture-retirement-readback-error"); };
  await retiredRefresh.context.handleDelete({ id: "video-fixture", model_type: "video", name: "fixture video" });
  assert.equal(retiredRefresh.state.notices.at(-1)?.kind, "staged");
  assert.equal((retiredRefresh.state.notices.at(-1)?.receipt as { id: string }).id, "fixture-release-105");
  checks.push("known-retirement-candidate-survives-refresh-error");

  const parsed = harness((_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body), ["text"], "QUICK_PARSE_MUST_NOT_SUBMIT_CREDENTIALS");
    return response(422, { requiresDetails: true, code: "DETAIL_CONFIGURATION_REQUIRED", parsed: { base: "https://fixture.invalid", model: "fixture-video", price: 1.2 } });
  });
  await parsed.context.handleQuickAdd();
  assert.equal(parsed.state.draft?.model_name, "fixture-video");
  assert.equal(parsed.state.draft?.api_endpoint, "https://fixture.invalid/v1");
  assert.equal(parsed.state.draft?.cost_per_use, 1.2);
  assert.equal(parsed.state.notices.length, 0, "PARSED_INPUT_MUST_NOT_CLAIM_SAVED_CANDIDATE");
  assert.equal(parsed.state.refreshes, 0);
  checks.push("quick-parse-requires-details-no-credential-no-persistence-claim");

  const sort = harness((_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "PATCH") return response(202, receiptBody);
    if (body.action === "validate") return response(200, { ok: true });
    if (body.action === "publish") throw new Error("fixture-lost-publish-response");
    return response(200, { preview: { previewSha256: "a".repeat(64) } });
  });
  await sort.context.savePendingOrder();
  assert.equal(sort.context.candidateUncertain, true);
  assert.equal(sort.state.notices.at(-1)?.kind, "unknown");
  assert.equal((sort.state.notices.at(-1)?.receipt as { id: string }).id, "fixture-release-105");
  assert.match(String(sort.state.notices.at(-1)?.message), /勿重复保存/u);
  checks.push("sort-unknown-publish-retains-candidate-and-no-false-rollback");
  const malformedSort = harness(() => response(202, {}));
  await malformedSort.context.savePendingOrder();
  assert.equal(malformedSort.context.candidateUncertain, true);
  assert.equal(malformedSort.state.notices.at(-1)?.kind, "unknown");
  checks.push("sort-missing-receipt-blocks-blind-retry");

  const dialogFile = "src/components/unified-model-dialog.tsx";
  const dialogSource = fs.readFileSync(dialogFile, "utf8");
  const ast = ts.createSourceFile(dialogFile, dialogSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let saveExpression: ts.ArrowFunction | undefined;
  let initialForm: ts.Expression | undefined;
  function inspect(node: ts.Node) {
    if (ts.isArrowFunction(node) && node.body.getText(ast).includes('const endpoint = form.model_type === "text"')) saveExpression = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "[form, setForm]" && node.initializer && ts.isCallExpression(node.initializer)) initialForm = node.initializer.arguments[0];
    ts.forEachChild(node, inspect);
  }
  inspect(ast);
  assert.ok(saveExpression && initialForm);
  const alerts: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const dialogContext = vm.createContext({ modelType: "video", BILLING_MODES: { video: [{ value: "per_use" }] }, saving: false, saveBlocked: false,
    modelEndpointError: () => null, isEdit: false, apiKeyConfigured: false, model: null, alert: (text: string) => alerts.push(text), onSave: (value: Record<string, unknown>) => payloads.push(value) });
  vm.runInContext(ts.transpileModule(`globalThis.form = ${initialForm.getText(ast)}; globalThis.save = ${saveExpression.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, dialogContext);
  Object.assign(dialogContext.form, { api_endpoint: "https://fixture.invalid/v1", model_name: "fixture-video", name: "Fixture", api_key: "not-a-real-key", provider: "fixture", protocol_type: "openai_compatible" });
  dialogContext.save();
  assert.equal(payloads.length, 0);
  assert.match(alerts.at(-1)!, /未知成本不能用0代替/u);
  Object.assign(dialogContext.form, { cost_price: 0, cost_per_use: 0, provider: "", protocol_type: "" });
  dialogContext.save();
  assert.equal(payloads.length, 0);
  assert.match(alerts.at(-1)!, /主动选择/u);
  Object.assign(dialogContext.form, { provider: "fixture", protocol_type: "openai_compatible" });
  dialogContext.save();
  assert.equal(payloads.length, 1, "EXPLICIT_CONFIRMED_ZERO_REMAINS_VALID");
  assert.equal(payloads[0].cost_price, 0);
  assert.doesNotMatch(dialogSource, /保存后自动启用/u);
  checks.push("unknown-cost-empty-explicit-zero-and-protocol-choice-contract");
  const report = { passed: true, actualProductionHandlers: true, checks, providerCalls: 0, databaseWrites: 0, networkCalls: 0 };
  fs.mkdirSync(".codex-evidence/admin-full-acceptance-20261030-9592a6d0/models", { recursive: true });
  fs.writeFileSync(".codex-evidence/admin-full-acceptance-20261030-9592a6d0/models/zero-network.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
