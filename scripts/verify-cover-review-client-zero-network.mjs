#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

// Run the owning hook's real handlers, not a second flow implementation.
// React renders and same-origin responses are fixtures. No browser, DB, model,
// billing or persistence acceptance is implied by this zero-network test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientPath = "src/components/cover-workbench-client.ts";
const reviewPath = "src/components/cover-plan-review.tsx";
const workbenchPath = "src/components/cover-workbench.tsx";
const workbenchSource = readFileSync(path.join(root, workbenchPath), "utf8");
const workbenchAst = ts.createSourceFile(workbenchPath, workbenchSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const contractPath = "src/lib/cover-review-contract.ts";
const clientSource = readFileSync(path.join(root, clientPath), "utf8");
const reviewSource = readFileSync(path.join(root, reviewPath), "utf8");
const contractSource = readFileSync(path.join(root, contractPath), "utf8");
const clientAst = ts.createSourceFile(clientPath, clientSource, ts.ScriptTarget.Latest, true);
const reviewAst = ts.createSourceFile(reviewPath, reviewSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hook = clientAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useCoverWorkbench");
assert.ok(hook?.body, "The actual useCoverWorkbench declaration must exist");
const hash = value => createHash("sha256").update(value).digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));
function declaration(statements, name, ast) {
  const functions = statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const variables = statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
    .filter(node => ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(functions.length + variables.length, 1, `Expected one real declaration for ${name}`);
  return (functions.length ? functions[0].getText(ast) : `const ${variables[0].getText(ast)};`).replace(/^export /u, "");
}
const realHandlers = ["adoptTask", "receiveState", "makeSnapshot", "prepareRequest", "applyPrepared", "reviewRequest",
  "changeReviewDraft", "receiveReviewExecution", "confirmAndGenerate", "primaryAction", "recover", "restorePrepared"];
const realValues = ["fingerprint", "originalMaterial", "originalLayout", "referenceCount", "freshBinding", "originalOrderDisplay", "currentOwner", "persistPending"];
const helpers = ["message", "uuid", "isRecord", "canonicalCoverValue", "isSavedCoverTask", "inferCoverScenario", "coverOriginalOrderDisplay"];
const extracted = [
  ...helpers.map(name => declaration(clientAst.statements, name, clientAst)),
  declaration(reviewAst.statements, "reviewDraftFromAnalysis", reviewAst),
  ...realValues.map(name => declaration(hook.body.statements, name, clientAst)),
  ...realHandlers.map(name => declaration(hook.body.statements, name, clientAst)),
].join("\n\n");
const setters = ["results", "selected", "notice", "uncertain", "pending", "binding", "analysisBinding", "title", "titleStyle",
  "error", "busy", "recoveryIssue", "reviewDraft", "confirmed", "recoverable", "text", "materials", "styleKey", "ratio", "modelId",
  "resolution", "preserveLegacyContentKind", "manualTitle", "materialRevision"];
const setterNames = setters.map(key => `set${key[0].toUpperCase()}${key.slice(1)}`);
const source = `module.exports.createRender = function createRender(state, refs, environment) {
  const { text, materials, styleKey, ratio, modelId, resolution, title, manualTitle, titleStyle, scenario,
    materialRevision, binding, busy, uncertain, pending, customComposition, preserveLegacyContentKind,
    reviewDraft, confirmed, recoverable, selected } = state;
  const { titleRevision, titleStyleTouched, editorRevision, manualTitleRef, fingerprintRef, requestGate,
    currentRequest, submissionBindings, storage, active, owner, confirmationRequest, nextImageNumber } = refs;
  const { identity, sessionKey, localStorage, crypto, fetch, runCoverGeneration, saveOrDownload, refreshHistory,
    authFetch, ownedUrl, setScenarioState, setImageModeState, ${setterNames.join(", ")} } = environment;
  const useMemo = calculate => calculate();
  ${extracted}
  return { primaryAction, confirmAndGenerate, changeReviewDraft, recover, restorePrepared,
    applyPrepared, makeSnapshot, fingerprint, freshBinding, originalOrderDisplay, coverOriginalOrderDisplay };
};`;
const compiled = ts.transpileModule(source, { fileName: "cover-review-client-extracted.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls += 1; throw new Error("Unplanned external I/O is forbidden"); };
// Compile the complete real contract with the installed Zod. Type-only imports
// disappear; every unexpected runtime dependency is forbidden. Never replace
// this parser/mapper with a fixture implementation.
const contractCompiled = ts.transpileModule(contractSource, { fileName: contractPath, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
assert.deepEqual((contractCompiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
const contractModule = { exports: {} };
vm.runInNewContext(contractCompiled.outputText, { module: contractModule, exports: contractModule.exports, Error,
  require: name => name === "zod" ? { z } : forbidden(), fetch: forbidden }, { filename: contractPath, timeout: 5_000 });
assert.equal(typeof contractModule.exports.coverReviewPlanFromAnalysis, "function");
const compositionPath = "src/lib/cover-composition.ts";
const compositionSource = readFileSync(path.join(root, compositionPath), "utf8");
const compositionModule = { exports: {} };
const compositionCompiled = ts.transpileModule(compositionSource, { fileName: compositionPath,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
vm.runInNewContext(compositionCompiled.outputText, { module: compositionModule, exports: compositionModule.exports,
  require: forbidden, fetch: forbidden }, { filename: compositionPath });
const module = { exports: {} };
vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Error, console, URLSearchParams,
  coverReviewPlanFromAnalysis: contractModule.exports.coverReviewPlanFromAnalysis,
  coverOutputSizes: compositionModule.exports.COVER_OUTPUT_SPECS,
  coverTextRendering: compositionModule.exports.coverTextRendering,
  require: forbidden, fetch: forbidden, window: { setTimeout: forbidden } },
{ filename: "cover-review-client-extracted.js", timeout: 5_000 });
const { createRender } = module.exports;
// Render the ACTUAL owning JSX with local hook/JSX ports. This checks visible
// readonly values and footer wiring, without claiming browser/CSS acceptance.
const viewSource = `module.exports.render = function render(workbench) {
  const useCoverWorkbench = () => workbench;
  const useRef = () => ({current: null}), useEffect = () => {}, useState = value => [value, () => {}];
  ${["ratios", "scenarios", "hasSavedCover", "coverProgressFor", "AccountCoverWorkbench"].map(name => declaration(workbenchAst.statements, name, workbenchAst)).join("\n")}
  return AccountCoverWorkbench({ identity: {userId: "fixture", token: "fixture"} });
};`;
const viewCompiled = ts.transpileModule(viewSource, { fileName: "actual-cover-workbench-view.tsx",
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
assert.deepEqual((viewCompiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
const jsx = (type, props) => ({ type, props: props || {} });
const viewGlobals = Object.fromEntries(["SubPageHeader", "Check", "Download", "FileText", "History", "ImagePlus", "Images", "Loader2", "RefreshCw", "Save", "ShoppingBag", "Sparkles", "X", "AppScopedLink", "UserThemeSwitcher", "CoverStylePicker", "CoverPlanReview"].map(name => [name, name]));
const metadataModule = { exports: {} };
const metadataSource = ["COVER_CREATION_SCENARIOS", "coverMaterialLabels", "isSavedCoverTask"].map(name => declaration(clientAst.statements, name, clientAst)).join("\n")
  + "\nmodule.exports={COVER_CREATION_SCENARIOS,coverMaterialLabels,isSavedCoverTask};";
vm.runInNewContext(ts.transpileModule(metadataSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { module: metadataModule, exports: metadataModule.exports }, { filename: "actual-cover-display-metadata.js" });
// Use the production scenario/role labels and saved-task predicate, not a
// parallel UI implementation. The fixture renders JSX; it does not run effects.
const renderView = workbench => {
  const display = workbench.originalOrderDisplay;
  const context = { module: { exports: {} }, exports: {}, ...viewGlobals, ...metadataModule.exports,
    coverOutputSizes: compositionModule.exports.COVER_OUTPUT_SPECS,
    styles: new Proxy({}, { get: (_target, key) => String(key) }),
    require: id => id === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "fragment" } : forbidden() };
  vm.runInNewContext(viewCompiled.outputText, context, { filename: "actual-cover-workbench-view.js" });
  assert.ok(display);
  return context.module.exports.render(workbench);
};
function viewNodes(node) {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(viewNodes);
  if (typeof node !== "object") return [node];
  return [node, ...viewNodes(node.props?.children)];
}
const ownerId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000003";
const childId = "00000000-0000-4000-8000-000000000004";
const analysisHash = "a".repeat(64), quoteHash = "b".repeat(64);
const checks = [];
const analysis = {
  schemaVersion: "cover-content-analysis/1", status: "ready", topic: "先行动，再找状态", primaryTitle: "先做十分钟", secondaryTitle: null,
  visualBrief: { subject: "一个人", action: "坐到桌前开始动手", scene: "日常书桌", emotion: "从犹豫到行动" },
  titleCandidates: [{ id: "t1", text: "先做十分钟", evidenceRefs: ["e1"] }],
  evidence: [{ id: "e1", source: "text", quote: "先做十分钟", fields: ["primaryTitle"] }],
  contentBreakdown: { summary: { text: "小行动帮助开始", evidenceRefs: ["e1"] }, keyPoints: [{ text: "先做十分钟", evidenceRefs: ["e1"] }],
    logic: { text: "先开始再进入状态", evidenceRefs: ["e1"] }, coverFocus: { text: "动手的瞬间", evidenceRefs: ["e1"] } },
  layoutIntent: { structure: "single", focus: "action", evidenceRefs: ["e1"] }, missingInformation: [],
};

function fixture(overrides = {}) {
  const state = { text: "做事总想等状态好，先做十分钟就能开始。", materials: [], styleKey: "cartoon", ratio: "3:4",
    modelId: "pm_fixture_image", resolution: "2K", title: "", manualTitle: false,
    titleStyle: { x: .08, y: .07, width: .84, scale: 1, color: "#583A27" }, scenario: "script",
    materialRevision: 1, binding: null, analysisBinding: null, busy: null, uncertain: false, pending: null,
    selected: null, results: [], notice: "", error: "", reviewDraft: null, confirmed: null, recoverable: null,
    customComposition: false, preserveLegacyContentKind: false, ...overrides };
  const identity = { userId: ownerId, token: "fixture-not-a-real-token" };
  const values = new Map();
  const memory = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const refs = { titleRevision: { current: 0 }, titleStyleTouched: { current: false }, editorRevision: { current: 0 },
    manualTitleRef: { current: state.manualTitle }, fingerprintRef: { current: "" }, requestGate: { current: false },
    currentRequest: { current: null }, confirmationRequest: { current: null }, submissionBindings: { current: new Map() },
    storage: { current: memory }, active: { current: true }, owner: { current: `${identity.userId}\0${identity.token}` }, nextImageNumber: { current: 1 } };
  const requests = [], queue = [], faults = [], assetReads = [];
  let sequence = 0, historyReads = 0;
  const environment = { identity, sessionKey: `fixture:${ownerId}`, localStorage: memory,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence + 100).padStart(12, "0")}` },
    fetch: async (url, options = {}) => {
      const method = options.method || "GET", body = options.body === undefined ? undefined : JSON.parse(options.body);
      const request = { url, method, ...(body === undefined ? {} : { body }), authorization: options.headers?.Authorization };
      requests.push(request);
      const next = queue.shift();
      if (!next || url !== next.url || method !== next.method || request.authorization !== `Bearer ${identity.token}`) {
        faults.push(request); throw new Error("Unplanned or unauthenticated fixture request");
      }
      next.inspect?.(request);
      if (next.wait) await next.wait;
      if (next.throw) throw next.throw;
      return Response.json(typeof next.response === "function" ? next.response(body) : next.response, { status: next.status || 200 });
    },
    runCoverGeneration: forbidden, saveOrDownload: forbidden,
    refreshHistory: async () => { historyReads += 1; },
    authFetch: async assetId => { assetReads.push({ method: "GET", assetId }); return { assetId }; },
    ownedUrl: value => `blob:fixture/${value.assetId}`,
    setScenarioState: value => { state.scenario = value; }, setImageModeState: value => { state.imageMode = value; },
  };
  for (const key of setters) environment[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => {
    state[key] = typeof value === "function" ? value(state[key]) : value;
  };
  function render() {
    const result = createRender(state, refs, environment);
    refs.fingerprintRef.current = result.fingerprint;
    refs.manualTitleRef.current = state.manualTitle;
    return result;
  }
  function enqueue(endpoint, response, extras = {}) { queue.push({ url: `/api/cover-workbench/${endpoint}`, method: "POST", response, ...extras }); }
  async function invoke(name, ...args) { await render()[name](...args); render(); }
  function verifyIdle() {
    assert.deepEqual(faults, [], "All requests must consume an explicitly planned fixture");
    assert.equal(queue.length, 0); assert.equal(refs.requestGate.current, false); assert.equal(state.busy, null);
  }
  return { state, refs, requests, queue, assetReads, memory, render, enqueue, invoke, verifyIdle, historyReads: () => historyReads };
}
function prepared(materials) {
  return { success: true, workflowVersion: 3, kind: "analysis", operationId, status: "prepared", materials,
    quote: { imageQuoteHash: quoteHash, analysis: { amount: null, unit: "credits", policy: "actual_usage" },
      image: { modelId: materials.modelId, amount: .1, unit: "yuan", resolution: "2K", ready: true } } };
}
function reviewReady(materials, outputAnalysis = analysis) { return { ...prepared(materials), status: "review_ready", analysisHash, analysis: plain(outputAnalysis) }; }
function confirmed(parent, edits) {
  return { success: true, workflowVersion: 3, kind: "confirmation", operationId: childId, confirmationId: childId,
    originalAnalysisOperationId: parent.operationId, status: "confirmed", confirmedPlan: plain(edits), quote: parent.quote };
}
function completed(edits) {
  return { success: true, confirmationId: childId, status: "completed", canPoll: false,
    task: { id: `cover-workbench-${childId}`, prepareOperationId: childId, title: edits.primaryTitle, subtitle: edits.secondaryTitle || "",
      ratio: "3:4", prompt: "", imageOrigin: "generated", source: "生成", status: "done", cloudStored: true,
      assetId: "fixture-output", historyRecordId: "fixture-history", url: "/api/fixture/owned-output" } };
}
async function reachReview(test, outputAnalysis = analysis) {
  test.enqueue("prepare", body => prepared(body.materials));
  await test.invoke("primaryAction");
  const materials = plain(test.requests[0].body.materials);
  assert.deepEqual(Object.keys(test.requests[0].body), ["materials"]);
  assert.equal(test.state.binding.result.status, "prepared");
  const parent = reviewReady(materials, outputAnalysis);
  test.enqueue("analyze", parent);
  await test.invoke("primaryAction");
  assert.deepEqual(test.requests[1].body, { operationId, consent: { analysis: true } });
  assert.equal(test.state.binding.result.status, "review_ready");
  assert.equal(test.state.pending.phase, "review");
  assert.equal(test.state.confirmed, null);
  assert.equal(test.requests.length, 2, "Analysis must stop before confirmation or image submission");
  assert.equal(test.state.reviewDraft.primaryTitle, outputAnalysis.primaryTitle);
  return parent;
}

{
  const test = fixture();
  await reachReview(test);
  const initial = plain(test.state.binding.result.analysis);
  await test.invoke("primaryAction");
  assert.equal(test.requests.length, 2, "Repeated primary action at review_ready must not auto-confirm");
  assert.deepEqual(plain(test.state.binding.result.analysis), initial);
  assert.match(test.state.notice, /确认/u);
  test.verifyIdle();
  checks.push("real primaryAction prepares, analyzes with analysis-only consent, and stops at review_ready");
}
{
  const test = fixture();
  const parent = await reachReview(test), originalAnalysis = plain(parent.analysis);
  const edited = { ...plain(test.state.reviewDraft), primaryTitle: "先行动\n不用等状态", visualBrief: { ...test.state.reviewDraft.visualBrief, action: "右手放下手机，左手翻开笔记" } };
  await test.invoke("changeReviewDraft", edited);
  assert.deepEqual(plain(test.state.binding.result.analysis), originalAnalysis, "Editing must not mutate paid analysis");
  const cached = JSON.parse(test.memory.getItem(`cover-review:${ownerId}:${operationId}`));
  assert.equal(cached.analysisHash, analysisHash); assert.deepEqual(cached.draft, edited);
  test.enqueue("confirm", confirmed(parent, edited)); test.enqueue("execute", completed(edited));
  await test.invoke("confirmAndGenerate");
  const request = test.requests[2].body;
  assert.deepEqual(Object.keys(request).sort(), ["clientRequestId", "consent", "edits", "expectedAnalysisHash", "expectedImageQuoteHash", "operationId"].sort());
  assert.equal(request.operationId, operationId); assert.equal(request.expectedAnalysisHash, analysisHash);
  assert.equal(request.expectedImageQuoteHash, quoteHash); assert.deepEqual(request.edits, edited); assert.deepEqual(request.consent, { image: true });
  assert.match(request.clientRequestId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(test.requests[3].body, { confirmationId: childId }, "Browser must not supply prompt, model, price or generation input");
  assert.equal(test.state.selected.title, edited.primaryTitle); assert.equal(test.state.pending, null); assert.equal(test.historyReads(), 1);
  test.verifyIdle();
  checks.push("manual review edits bind the original analysis/quote hashes; execute accepts only the persisted confirmation ID");
}
{
  const test = fixture();
  const legacyAnalysis = plain(analysis);
  delete legacyAnalysis.contentBreakdown; delete legacyAnalysis.layoutIntent;
  legacyAnalysis.visualBrief.action = "";
  const parent = await reachReview(test, legacyAnalysis);
  const draft = plain(test.state.reviewDraft);
  assert.deepEqual(draft.contentBreakdown, { summary: legacyAnalysis.topic, keyPoints: [legacyAnalysis.topic],
    logic: "原分析未提供独立逻辑拆解，请确认或编辑。", coverFocus: legacyAnalysis.visualBrief.subject });
  assert.deepEqual(draft.layoutIntent, { structure: "single", focus: "object" });
  assert.equal(parent.analysis.contentBreakdown, undefined, "Fallback belongs only to the review plan, not the original analysis");
  assert.equal(parent.analysis.layoutIntent, undefined);
  assert.equal(test.requests.length, 2); test.verifyIdle();
  checks.push("the real shared contract supplies legacy review fallbacks without inventing original analysis evidence");
}
for (const count of [1, 2, 3]) {
  const imageNumbers = [7, 1, 3].slice(0, count);
  const materials = imageNumbers.map((imageNumber, index) => ({ id: `local-${imageNumber}`,
    assetId: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`, imageNumber,
    role: ["identity_subject", "background_canvas", "style_reference"][index], status: "ready", name: `图${imageNumber}` }));
  const outputAnalysis = { ...plain(analysis), materialUsage: materials.map(({ assetId, imageNumber, role }) => ({
    assetId, imageNumber, role, source: "explicit_user", evidenceRefs: ["e1"] })) };
  const test = fixture({ scenario: "reference", customComposition: true, materials });
  const parent = await reachReview(test, outputAnalysis), originalUsage = plain(parent.analysis.materialUsage);
  assert.deepEqual(plain(test.state.reviewDraft.materialUsage), materials.map(({ assetId, imageNumber, role }) => ({ assetId, imageNumber, role })),
    "Actual contract must retain source order/asset numbering but not promote source or evidence into editable authority");
  const edited = plain(test.state.reviewDraft);
  edited.materialUsage[0].role = "style_reference";
  await test.invoke("changeReviewDraft", edited);
  assert.deepEqual(plain(parent.analysis.materialUsage), originalUsage);
  test.enqueue("confirm", confirmed(parent, edited));
  test.enqueue("execute", { confirmationId: childId, status: "unknown", canPoll: false });
  await test.invoke("confirmAndGenerate");
  assert.deepEqual(test.requests[2].body.edits.materialUsage, edited.materialUsage);
  assert.deepEqual(test.requests[2].body.edits.materialUsage.map(item => item.imageNumber), imageNumbers);
  assert.deepEqual(test.requests[3].body, { confirmationId: childId });
  assert.equal(test.state.pending.operationId, childId); test.verifyIdle();
  checks.push(`real shared mapper and confirmation preserve ${count} image asset bindings/order while allowing user role edits separately from original evidence`);
}
{
  const test = fixture();
  const parent = await reachReview(test), edited = plain(test.state.reviewDraft);
  test.enqueue("confirm", undefined, { throw: new Error("fixture confirmation timeout") });
  await test.invoke("confirmAndGenerate");
  const pending = plain(test.state.pending), key = test.requests[2].body.clientRequestId;
  assert.equal(test.state.uncertain, true); assert.equal(pending.phase, "confirmation"); assert.equal(pending.clientRequestId, key);
  assert.equal(pending.operationId, undefined, "A timeout must not invent the missing child ID");
  await test.invoke("confirmAndGenerate"); await test.invoke("primaryAction");
  assert.equal(test.requests.length, 3, "Unknown confirmation must not automatically resend");
  const child = confirmed(parent, edited);
  test.enqueue(`operations?clientRequestId=${key}`, child, { method: "GET" });
  test.enqueue(`execute?confirmationId=${childId}`, { confirmationId: childId, status: "confirmed", canPoll: false }, { method: "GET" });
  await test.invoke("recover");
  assert.equal(test.state.uncertain, false); assert.equal(test.state.recoverable.operationId, childId);
  assert.deepEqual(test.requests.slice(3).map(item => item.method), ["GET", "GET"]);
  test.enqueue(`operations?operationId=${operationId}`, parent, { method: "GET" });
  await test.invoke("restorePrepared");
  assert.equal(test.state.confirmed.operationId, childId); assert.deepEqual(plain(test.state.reviewDraft), edited);
  assert.equal(test.requests.at(-1).method, "GET");
  test.enqueue("execute", completed(edited));
  await test.invoke("confirmAndGenerate");
  assert.deepEqual(test.requests.at(-1).body, { confirmationId: childId });
  assert.equal(test.requests.filter(item => item.url.endsWith("/confirm")).length, 1, "Explicit continuation reuses the recovered child");
  test.verifyIdle();
  checks.push("confirmation timeout retains its request key, uses GET-only recovery and restore, then explicitly continues the same child");
}
{
  const test = fixture();
  const parent = await reachReview(test), edited = plain(test.state.reviewDraft);
  const child = confirmed(parent, edited);
  const claimed = { success: true, confirmationId: childId, status: "claimed", canPoll: false,
    task: { ...completed(edited).task, status: "running", cloudStored: false, assetId: undefined, historyRecordId: undefined, url: undefined },
    issue: { code: "COVER_RENDER_NOT_READY", message: "封面保存服务尚未就绪，本次未提交生图", action: "query_original" } };
  test.enqueue("confirm", child); test.enqueue("execute", claimed);
  await test.invoke("confirmAndGenerate");
  assert.equal(test.state.confirmed.operationId, childId); assert.equal(test.state.pending.operationId, childId);
  assert.equal(test.state.selected, null, "An unpaid claim must not appear as an image already running");
  assert.equal(test.state.uncertain, false, "A verified unpaid claim remains available for explicit continuation");
  assert.equal(test.requests.length, 4, "An unpaid claimed response must not automatically dispatch again or poll");
  test.enqueue(`operations?operationId=${childId}`, child, { method: "GET" });
  test.enqueue(`execute?confirmationId=${childId}`, claimed, { method: "GET" });
  await test.invoke("recover");
  assert.equal(test.state.uncertain, false, "A confirmed claimed/not-dispatched receipt permits explicit restoration");
  assert.equal(test.state.recoverable.operationId, childId);
  assert.equal(test.state.pending.operationId, childId);
  assert.deepEqual(test.requests.slice(4).map(item => item.method), ["GET", "GET"], "Readiness recovery itself must be GET-only");
  test.enqueue(`operations?operationId=${operationId}`, parent, { method: "GET" });
  await test.invoke("restorePrepared");
  assert.equal(test.state.confirmed.operationId, childId); assert.deepEqual(plain(test.state.reviewDraft), edited);
  assert.equal(test.requests.at(-1).method, "GET");
  assert.equal(test.requests.filter(item => item.url.endsWith("/execute") && item.method === "POST").length, 1,
    "Restoration must not submit the unpaid claimed image");
  test.enqueue("execute", completed(edited));
  await test.invoke("confirmAndGenerate");
  assert.deepEqual(test.requests.at(-1).body, { confirmationId: childId });
  assert.deepEqual(test.requests.filter(item => item.url.endsWith("/execute") && item.method === "POST").map(item => item.body),
    [{ confirmationId: childId }, { confirmationId: childId }], "Explicit continuation must reuse the exact claimed confirmation");
  assert.equal(test.requests.filter(item => item.url.endsWith("/confirm")).length, 1);
  assert.equal(test.requests.filter(item => item.url.endsWith("/analyze")).length, 1);
  assert.equal(test.state.pending, null); test.verifyIdle();
  checks.push("claimed readiness failure recovers with GET only and resumes the same child only after explicit user continuation");
}
for (const status of [400, 409, 422]) {
  const test = fixture();
  const parent = await reachReview(test), edited = plain(test.state.reviewDraft);
  test.enqueue("confirm", confirmed(parent, edited));
  test.enqueue("execute", { error: "fixture execution rejection", code: "FIXTURE_EXECUTION_REJECTED" }, { status });
  await test.invoke("confirmAndGenerate");
  assert.equal(test.state.confirmed.operationId, childId); assert.equal(test.state.pending.operationId, childId);
  assert.equal(test.state.pending.phase, "generation"); assert.equal(test.state.uncertain, true);
  const pending = plain(test.state.pending);
  await test.invoke("confirmAndGenerate"); await test.invoke("primaryAction");
  assert.equal(test.requests.length, 4); assert.deepEqual(plain(test.state.pending), pending);
  test.enqueue(`operations?operationId=${childId}`, confirmed(parent, edited), { method: "GET" });
  test.enqueue(`execute?confirmationId=${childId}`, { confirmationId: childId, status: "unknown", canPoll: false }, { method: "GET" });
  await test.invoke("recover");
  assert.deepEqual(test.requests.slice(4).map(item => item.method), ["GET", "GET"]);
  assert.equal(test.state.pending.operationId, childId); assert.equal(test.state.uncertain, true);
  test.verifyIdle();
  checks.push(`execute HTTP ${status} preserves the child/pending handle and never treats rejection as safe to resubmit`);
}
{
  const test = fixture();
  const parent = await reachReview(test), previousKey = test.refs.currentRequest.current.clientRequestId;
  test.state.pending = { workflowVersion: 3, operationId, clientRequestId: previousKey, phase: "analysis", materialRevision: 1 };
  test.state.uncertain = true; test.state.binding = null; test.state.text = "尚未恢复的当前草稿";
  test.enqueue(`operations?operationId=${operationId}`, parent, { method: "GET" });
  await test.invoke("recover");
  assert.equal(test.state.text, "尚未恢复的当前草稿", "Query alone must not overwrite current inputs");
  const before = test.requests.length;
  await test.invoke("restorePrepared");
  assert.equal(test.requests.length, before, "Restoring a loaded text analysis must not submit anything");
  assert.equal(test.state.text, parent.materials.text); assert.equal(test.state.binding.result.operationId, operationId);
  assert.equal(test.state.binding.result.status, "review_ready"); assert.equal(test.state.confirmed, null);
  await test.invoke("primaryAction"); assert.equal(test.requests.length, before);
  test.verifyIdle();
  checks.push("GET recovery preserves current inputs until explicit restore; restored analysis remains editable without reanalysis or generation");
}
{
  const test = fixture();
  const parent = await reachReview(test), edited = plain(test.state.reviewDraft);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  test.enqueue("confirm", confirmed(parent, edited), { wait });
  test.enqueue("execute", { confirmationId: childId, status: "unknown", canPoll: false });
  const handler = test.render().confirmAndGenerate;
  const first = handler();
  await handler();
  assert.equal(test.requests.filter(item => item.url.endsWith("/confirm")).length, 1);
  release(); await first; test.render();
  assert.equal(test.state.uncertain, true); assert.equal(test.state.pending.operationId, childId);
  await test.invoke("confirmAndGenerate");
  assert.equal(test.requests.filter(item => item.url.endsWith("/execute")).length, 1);
  test.verifyIdle();
  checks.push("the synchronous request gate stops double confirmation; unknown execution never auto-resends");
}
{
  for (const status of ["failed", "unknown"]) {
    const test = fixture();
    const parent = await reachReview(test), edited = plain(test.state.reviewDraft);
    const task = { ...completed(edited).task, status, cloudStored: false, assetId: undefined, historyRecordId: undefined, url: undefined };
    test.enqueue("confirm", confirmed(parent, edited));
    test.enqueue("execute", { success: true, confirmationId: childId, status, canPoll: false, task });
    await test.invoke("confirmAndGenerate");
    assert.equal(test.requests.length, 4, "A terminal/unknown result must not automatically submit another version");
    assert.equal(test.state.selected.status, status); assert.equal(test.state.results[0].status, status);
    const next = { ...edited, primaryTitle: "用户修改后的新标题" };
    if (status === "failed") {
      assert.equal(test.state.confirmed, null); assert.equal(test.refs.confirmationRequest.current, null);
      assert.equal(test.state.uncertain, false); assert.equal(test.state.pending.phase, "review");
      assert.equal(test.state.pending.operationId, operationId);
      assert.equal(test.state.pending.clientRequestId, parent.materials.clientRequestId);
      await test.invoke("changeReviewDraft", next);
      assert.equal(test.state.reviewDraft.primaryTitle, next.primaryTitle, "Known terminal failure unlocks the original paid review draft");
      assert.deepEqual(plain(test.state.binding.result.analysis), parent.analysis);
      await test.invoke("primaryAction");
    } else {
      const key = test.refs.confirmationRequest.current.key;
      assert.equal(test.state.confirmed.operationId, childId); assert.equal(test.state.uncertain, true);
      assert.equal(test.state.pending.operationId, childId); assert.equal(test.state.pending.phase, "generation");
      await test.invoke("changeReviewDraft", next); await test.invoke("primaryAction"); await test.invoke("confirmAndGenerate");
      assert.equal(test.state.reviewDraft.primaryTitle, edited.primaryTitle);
      assert.equal(test.refs.confirmationRequest.current.key, key, "Unknown must retain the existing confirmation request identity");
    }
    assert.equal(test.requests.length, 4); test.verifyIdle();
  }
  checks.push("known failed execution retains its history and unlocks the original review without POST; unknown keeps the exact child locked");
}
{
  const original = fixture();
  const parent = await reachReview(original), edited = plain(original.state.reviewDraft);
  const child = { ...confirmed(parent, edited), materials: parent.materials };
  const pending = { workflowVersion: 3, operationId: childId, clientRequestId: "00000000-0000-4000-8000-000000000090",
    phase: "generation", materialRevision: parent.materials.materialRevision };
  const failedTask = { ...completed(edited).task, status: "failed", cloudStored: false,
    assetId: undefined, historyRecordId: undefined, url: undefined };
  const test = fixture({ text: "刷新后保留的当前草稿", pending, uncertain: true });
  test.enqueue(`operations?operationId=${childId}`, child, { method: "GET" });
  test.enqueue(`execute?confirmationId=${childId}`, { confirmationId: childId, status: "failed", canPoll: false, task: failedTask }, { method: "GET" });
  test.enqueue(`operations?operationId=${operationId}`, parent, { method: "GET" });
  await test.invoke("recover");
  assert.deepEqual(test.requests.map(item => item.method), ["GET", "GET", "GET"], "Failed-child recovery must only read the original records");
  assert.equal(test.state.text, "刷新后保留的当前草稿", "Query must preserve the current text until explicit restore");
  assert.equal(test.state.binding, null); assert.equal(test.state.reviewDraft, null);
  assert.equal(test.state.confirmed, null); assert.equal(test.state.uncertain, false);
  assert.equal(test.state.selected.status, "failed"); assert.equal(test.state.results[0].status, "failed", "Keep the failed execution in the visible history");
  assert.equal(test.state.recoverable.operationId, operationId, "Reloaded failure must keep an explicit restore handle to the paid parent analysis");
  assert.equal(test.state.pending.operationId, operationId); assert.equal(test.state.pending.phase, "review");
  assert.equal(test.state.pending.clientRequestId, parent.materials.clientRequestId);
  const beforeRestore = test.requests.length;
  await test.invoke("restorePrepared");
  assert.equal(test.requests.length, beforeRestore, "Restoring the already read parent cannot reanalyze or execute the failed child");
  assert.equal(test.state.text, parent.materials.text); assert.equal(test.state.binding.result.operationId, operationId);
  assert.equal(test.state.binding.result.status, "review_ready"); assert.equal(test.state.confirmed, null);
  const next = { ...plain(test.state.reviewDraft), primaryTitle: "恢复原分析后修改的标题" };
  await test.invoke("changeReviewDraft", next);
  assert.equal(test.state.reviewDraft.primaryTitle, next.primaryTitle, "Explicitly restored parent review is editable after a failed child");
  assert.deepEqual(plain(test.state.binding.result.analysis), parent.analysis, "Paid source analysis is unchanged");
  await test.invoke("primaryAction");
  assert.equal(test.requests.length, beforeRestore, "The restored review cannot silently buy another analysis or submit a replacement image");
  test.verifyIdle();
  checks.push("refresh with no binding recovers a failed child's original paid analysis through GET-only reads, retains failed history, and explicitly restores editable review");
}
{
  const original = fixture();
  const parent = await reachReview(original), edited = plain(original.state.reviewDraft);
  const child = { ...confirmed(parent, edited), materials: parent.materials };
  const pending = { workflowVersion: 3, operationId: childId, clientRequestId: "00000000-0000-4000-8000-000000000091",
    phase: "generation", materialRevision: parent.materials.materialRevision };
  const test = fixture({ pending: plain(pending), uncertain: true });
  test.enqueue(`operations?operationId=${childId}`, child, { method: "GET" });
  test.enqueue(`execute?confirmationId=${childId}`, { confirmationId: childId, status: "failed", canPoll: false,
    task: { ...completed(edited).task, status: "failed", cloudStored: false, assetId: undefined, historyRecordId: undefined } }, { method: "GET" });
  test.enqueue(`operations?operationId=${operationId}`, { success: false, error: "原分析暂时无法读取" }, { method: "GET", status: 503 });
  await test.invoke("recover");
  assert.deepEqual(test.requests.map(item => item.method), ["GET", "GET", "GET"]);
  assert.deepEqual(plain(test.state.pending), pending, "An unavailable parent must not discard the exact child handle");
  assert.equal(test.state.uncertain, true); assert.equal(test.state.binding, null); assert.equal(test.state.recoverable, null);
  await test.invoke("primaryAction"); await test.invoke("confirmAndGenerate");
  assert.equal(test.requests.length, 3, "Failed parent lookup cannot unlock another analysis or generation");
  test.verifyIdle();
  checks.push("refresh recovery preserves the original failed child and blocks new writes when its parent analysis GET is unavailable");
}
{
  const test = fixture();
  await reachReview(test);
  test.state.binding.result.quote.imageQuoteHash = undefined;
  await test.invoke("confirmAndGenerate");
  assert.equal(test.requests.length, 2); assert.equal(test.state.confirmed, null);
  assert.match(test.state.error, /确认依据/u);
  test.verifyIdle();
  checks.push("missing quote binding blocks confirmation before any write request");
}
{
  for (const originalModelInCatalog of [true, false]) {
    const pending = { workflowVersion: 3, operationId: childId, clientRequestId: "original_confirmation_key", phase: "generation", materialRevision: 1 };
    const test = fixture({ text: "当前未提交草稿保持原样", modelId: "pm_default_a", ratio: "16:9", resolution: "4K", uncertain: true, pending: plain(pending) });
    test.memory.setItem(`fixture:${ownerId}`, JSON.stringify(pending));
    const saved = { schemaVersion: "cover-prepare/1", clientRequestId: "original_analysis_key", materialRevision: 1,
      text: "原单口播：放下手机，回应身边的人与宠物。", assets: [], styleKey: "cartoon", outputRatio: "3:4", modelId: "pm_original_b", resolution: "2K" };
    const parent = reviewReady(saved), child = { ...confirmed(parent, contractModule.exports.coverReviewPlanFromAnalysis(analysis)), materials: saved,
      route: "new_visual", style: { styleKey: "cartoon", version: "1.0.0", displayName: "暖光故事" },
      originalAnalysisBilling: { operationId, creditsCharged: 5.33, chargedAgain: false },
      quote: { analysis: { amount: 0, unit: "credits", policy: "original_analysis" },
        image: { modelId: "pm_original_b", modelName: "原单 GPT Image2 低成本", amount: .1, unit: "yuan", resolution: "2K", ready: true } } };
    const task = { ...completed(child.confirmedPlan).task, status: "unknown", cloudStored: false, assetId: undefined,
      historyRecordId: undefined, url: undefined, briefText: saved.text, publicModelId: "pm_original_b" };
    test.refs.currentRequest.current = { fingerprint: "unsubmitted-draft", clientRequestId: "unsubmitted_draft_key" };
    const previousRequest = plain(test.refs.currentRequest.current), previousDraft = { text: test.state.text, modelId: test.state.modelId, ratio: test.state.ratio, resolution: test.state.resolution };
    test.enqueue(`operations?operationId=${childId}`, child, { method: "GET" });
    test.enqueue(`execute?confirmationId=${childId}`, { confirmationId: childId, status: "unknown", canPoll: true, task }, { method: "GET" });
    await test.invoke("recover");
    assert.deepEqual(test.requests.map(item => item.method), ["GET", "GET"]);
    assert.deepEqual({ text: test.state.text, modelId: test.state.modelId, ratio: test.state.ratio, resolution: test.state.resolution }, previousDraft);
    assert.deepEqual(plain(test.refs.currentRequest.current), previousRequest);
    assert.deepEqual(plain(test.state.pending), pending); assert.deepEqual(JSON.parse(test.memory.getItem(`fixture:${ownerId}`)), pending);
    assert.equal(test.state.binding, null); assert.equal(test.state.uncertain, true); assert.equal(test.assetReads.length, 0);
    const display = test.render().originalOrderDisplay;
    assert.equal(display.text, saved.text); assert.equal(display.modelId, "pm_original_b"); assert.equal(display.modelName, "原单 GPT Image2 低成本");
    assert.equal(display.imageFeeText, "¥0.10"); assert.equal(display.ratio, "3:4"); assert.equal(display.resolution, "2K");
    assert.match(display.analysisFeeText, /已计费 5.33 积分/u); assert.equal(display.analysisFeeText.includes("无需付费"), false);
    const defaultModel = { id: "pm_default_a", name: "默认 Sunburst A", resolutions: ["2K", "4K"], available: true, priceReady: true, prices: { "4K": .9 } };
    const view = renderView({ ...test.state, ...test.render(),
      models: originalModelInCatalog ? [defaultModel, { ...defaultModel, id: "pm_original_b", name: "当前目录改名也不能覆盖原单" }] : [defaultModel],
      modelsState: "ready", activeModel: defaultModel, draftReady: true, historyOpen: false, styleChoices: [], historyBusy: false,
      originalLayout: false, originalMaterial: undefined, analysis: null, reviewReady: false, feeText: "错误的当前草稿价格 ¥0.90", analysisFeeText: "本次无需付费分析" });
    const nodes = viewNodes(view), text = nodes.filter(item => typeof item === "string").join(" ");
    assert.match(text, /原单生图模型：原单 GPT Image2 低成本/u); assert.match(text, /原单图片报价/u); assert.match(text, /¥0.10/u);
    assert.equal(text.includes("默认 Sunburst A"), false); assert.equal(text.includes("当前目录改名"), false); assert.equal(text.includes("¥0.90"), false);
    assert.equal(text.includes("本次无需付费分析"), false); assert.equal(text.includes("确认分析费用后开始拆解"), false);
    const textarea = nodes.find(node => node?.props?.id === "cover-original-text");
    assert.equal(textarea.props.value, saved.text); assert.equal(textarea.props.readOnly, true); assert.equal(textarea.props.onChange, undefined);
    assert.equal(nodes.some(node => node?.props?.id === "cover-workbench-model"), false, "Current default model selector must not be mixed into the readonly original order");
    assert.equal(nodes.find(node => node?.type === "button" && node.props.className === "primary").props.disabled, true);
    assert.equal(text.includes("原模型当前不在目录中"), !originalModelInCatalog);
    const requests = test.requests.length;
    await test.invoke("primaryAction"); await test.invoke("confirmAndGenerate"); await test.invoke("changeReviewDraft", { ...child.confirmedPlan, primaryTitle: "不可覆盖未知原单" });
    assert.equal(test.requests.length, requests); assert.deepEqual(plain(test.state.pending), pending);
    test.verifyIdle();
  }
  checks.push("unknown confirmation refresh shows frozen original text/model/size/quote in actual readonly JSX and footer, including a retired model, while preserving the draft/pending key and performing GET-only recovery with zero POST");
}
{
  const test = fixture();
  const child = { operationId: childId, confirmationId: childId, kind: "confirmation", status: "confirmed",
    originalAnalysisBilling: { operationId, creditsCharged: null, chargedAgain: false },
    quote: { image: { amount: null, modelId: "pm_retired", unit: "yuan", ready: false }, analysis: { amount: 0, unit: "credits" } } };
  const unrelatedTask = { ...completed({ primaryTitle: "别的作品", secondaryTitle: null }).task, prepareOperationId: operationId, briefText: "别的作品文案" };
  const before = plain(child), display = test.render().coverOriginalOrderDisplay(child, unrelatedTask);
  assert.equal(display.modelName, "原单模型名称尚未读取"); assert.equal(display.imageFeeText, "原单报价待查询");
  assert.equal(display.text, ""); assert.equal(display.title, ""); assert.equal(display.analysisFeeText.includes("无需付费"), false);
  assert.deepEqual(child, before); assert.equal(test.requests.length, 0);
  checks.push("missing original metadata stays explicitly unread/unknown without borrowing current catalog price, free-child analysis quote, unrelated selected task or draft fields");
}
function selectedEditorProjection(state, originalOrderDisplay = null) {
  const names = ["nativeSelected", "editableSelected", "generatedOverlayLayout", "outputSpec", "plan", "dirty", "previewSourceAssetId"];
  const code = declaration(clientAst.statements, "canonicalCoverValue", clientAst) + "\n"
    + names.map(name => declaration(hook.body.statements, name, clientAst)).join("\n")
    + "\nresult = { editableSelected, dirty, plan, previewSourceAssetId };";
  const compiledProjection = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { automaticLayoutTaskId: "", ...state, originalOrderDisplay, originalLayout: state.scenario === "background", originalMaterial: state.materials[0],
    coverGeneratedOverlayPolicy: compositionModule.exports.coverGeneratedOverlayPolicy, coverGeneratedOverlayTitleStyle: compositionModule.exports.coverGeneratedOverlayTitleStyle,
    coverTextRendering: compositionModule.exports.coverTextRendering, coverOutputSizes: compositionModule.exports.COVER_OUTPUT_SPECS, result: null };
  vm.runInNewContext(compiledProjection, context);
  return context.result;
}
function savedOverlay(edits) {
  const execution = completed(edits);
  execution.task.ratio = "4:3";
  execution.task.backgroundAssetId = "fixture-background";
  execution.task.renderPlan = { title: edits.primaryTitle, subtitle: edits.secondaryTitle || "", aspectRatio: "4:3",
    layoutTemplateId: "gaoding-cover-workbench", animationStyleId: "pixar-3d", coverModeId: "cartoon", materialSourceId: "upload",
    subjectModeId: "semantic", planVersion: 2,
    outputSpec: { aspectRatio: "4:3", width: 1440, height: 1080, format: "png", fit: "contain" },
    titleStyle: { x: .08, y: .07, width: .84, scale: 1, color: "#FFF1B8", colorMode: "single" },
    textRendering: { mode: "overlay", version: "cover-text-rendering/1" } };
  return execution;
}
{
  const test = fixture({ scenario: "background", ratio: "4:3", materials: [{ id: "fixture-local", assetId: "fixture-background", role: "background_canvas", imageNumber: 1, status: "ready" }] });
  const parent = await reachReview(test), draft = plain(test.state.reviewDraft), execution = savedOverlay(draft);
  assert.equal(test.state.title, "");
  const originalFingerprint = test.render().fingerprint;
  test.enqueue("confirm", confirmed(parent, draft)); test.enqueue("execute", execution);
  await test.invoke("confirmAndGenerate");
  assert.equal(test.state.title, execution.task.renderPlan.title);
  assert.deepEqual(plain(test.state.titleStyle), execution.task.renderPlan.titleStyle);
  assert.equal(test.state.manualTitle, false, "Adopting a saved automatic title is not a new manual-title input");
  assert.equal(test.render().fingerprint, originalFingerprint);
  assert.equal(selectedEditorProjection(test.state).dirty, false, "A newly saved overlay must display/download its exact saved version");
  assert.equal(test.requests.filter(request => request.url.endsWith("/execute")).length, 1);
  test.verifyIdle();
  checks.push("completed original overlay adopts frozen title/style only for its matching submission and starts clean without a second render or generation");
}
{
  const test = fixture(), parent = await reachReview(test), draft = plain(test.state.reviewDraft), execution = savedOverlay(draft);
  test.enqueue("confirm", confirmed(parent, draft));
  test.enqueue("execute", execution, { inspect() {
    test.state.title = "期间改动的草稿标题"; test.state.titleStyle = { ...test.state.titleStyle, color: "#112233" };
    test.refs.editorRevision.current += 1;
  } });
  await test.invoke("confirmAndGenerate");
  assert.equal(test.state.title, "期间改动的草稿标题"); assert.equal(test.state.titleStyle.color, "#112233");
  assert.equal(test.state.selected, null); assert.equal(test.state.results[0].assetId, execution.task.assetId);
  assert.match(test.state.notice, /草稿保留/u); test.verifyIdle();
  checks.push("an overlay completing after an editor revision change retains the saved result in history without replacing unsaved draft values or selecting it");
}
{
  const task = savedOverlay({ primaryTitle: "已保存标题", secondaryTitle: null }).task;
  const state = fixture({ selected: task, title: "当前不同的草稿", ratio: "16:9", scenario: "background" }).state;
  const projection = selectedEditorProjection(state, { confirmationId: childId });
  assert.equal(projection.editableSelected, false); assert.equal(projection.dirty, false);
  assert.equal(projection.previewSourceAssetId, undefined, "Readonly recovery must not preview or save an unbound draft over the original photo");
  assert.equal(state.title, "当前不同的草稿");
  checks.push("readonly restored completed overlay stays a saved download with no editable preview while the independent draft remains untouched");
}
for (const conflictAt of ["confirm", "execute"]) {
  const test = fixture();
  const parent = await reachReview(test);
  const edited = { ...plain(test.state.reviewDraft), primaryTitle: "保留这份新方案草稿" };
  await test.invoke("changeReviewDraft", edited);
  const before = JSON.stringify({ text: test.state.text, materials: test.state.materials, draft: test.state.reviewDraft });
  const originalId = "00000000-0000-4000-8000-0000000000ab";
  const conflict = { success: false, code: "COVER_CONFIRMATION_QUERY_ORIGINAL", action: "query_original",
    originalConfirmationId: originalId, error: "原确认订单结果尚未确定，请查询原单" };
  if (conflictAt === "execute") test.enqueue("confirm", confirmed(parent, edited));
  test.enqueue(conflictAt, conflict, { status: 409 });
  await test.invoke("confirmAndGenerate");
  assert.equal(test.state.pending.operationId, originalId); assert.equal(test.state.pending.phase, "generation");
  assert.equal(test.state.uncertain, true); assert.equal(test.state.confirmed, null);
  assert.equal(test.refs.confirmationRequest.current, null);
  assert.equal(JSON.stringify({ text: test.state.text, materials: test.state.materials, draft: test.state.reviewDraft }), before);
  const rejectedCount = test.requests.length;
  await test.invoke("confirmAndGenerate"); await test.invoke("primaryAction");
  assert.equal(test.requests.length, rejectedCount, "A typed original-order conflict cannot auto-resubmit or auto-query");
  if (conflictAt === "confirm") assert.equal(test.requests.some(item => item.url.endsWith("/execute")), false);
  const original = { ...confirmed(parent, { ...edited, primaryTitle: "原已确认订单标题" }), operationId: originalId, confirmationId: originalId,
    materials: plain(parent.materials), originalAnalysisBilling: { creditsCharged: .66 },
    quote: { ...parent.quote, image: { ...parent.quote.image, modelName: "原订单冻结模型" } } };
  test.enqueue(`operations?operationId=${originalId}`, original, { method: "GET" });
  test.enqueue(`execute?confirmationId=${originalId}`, { confirmationId: originalId, status: "unknown", canPoll: true,
    task: { ...completed(edited).task, id: `original-${originalId}`, prepareOperationId: originalId, status: "unknown", assetId: undefined,
      historyRecordId: undefined, cloudStored: false, url: undefined }, issue: { message: "原图片订单仍待确认" } }, { method: "GET" });
  await test.invoke("recover");
  assert.deepEqual(test.requests.slice(rejectedCount).map(item => item.method), ["GET", "GET"]);
  assert.equal(test.state.pending.operationId, originalId); assert.equal(test.state.uncertain, true);
  assert.equal(test.render().originalOrderDisplay.confirmationId, originalId);
  assert.equal(test.render().originalOrderDisplay.modelName, "原订单冻结模型");
  assert.equal(test.render().originalOrderDisplay.title, "原已确认订单标题");
  assert.equal(JSON.stringify({ text: test.state.text, materials: test.state.materials, draft: test.state.reviewDraft }), before);
  test.verifyIdle();
}
checks.push("typed confirm/execute sibling-order conflicts preserve the edited draft, stop every automatic write, and bind explicit GET-only recovery to the original child with frozen readonly title/model metadata");
for (const invalid of [
  { status: 409, code: "COVER_CONFIRMATION_QUERY_ORIGINAL", action: "query_original", originalConfirmationId: "not-a-uuid" },
  { status: 409, code: "COVER_CONFIRMATION_KEY_CONFLICT", action: "query_original", originalConfirmationId: childId },
  { status: 409, code: "COVER_CONFIRMATION_QUERY_ORIGINAL", action: "edit_materials", originalConfirmationId: childId },
  { status: 404, code: "COVER_OPERATION_NOT_FOUND", action: "query_original", originalConfirmationId: childId },
  { status: 503, code: "COVER_CONFIRMATION_QUERY_ORIGINAL", action: "query_original", originalConfirmationId: childId },
]) {
  const test = fixture(); await reachReview(test);
  const { status, ...body } = invalid;
  test.enqueue("confirm", { ...body, error: "fixture rejected" }, { status });
  await test.invoke("confirmAndGenerate");
  assert.notEqual(test.state.pending?.operationId, invalid.originalConfirmationId);
  assert.equal(test.requests.filter(item => item.method === "GET").length, 0);
  assert.equal(test.requests.some(item => item.url.endsWith("/execute")), false);
  test.verifyIdle();
}
checks.push("malformed IDs, wrong conflict/action types, cross-account not-found and storage failures cannot replace the local pending reference with an unverified original order");
assert.equal(forbiddenCalls, 0);
assert.equal(readFileSync(path.join(root, clientPath), "utf8"), clientSource, "Hook source changed during verification; rerun against the final source");
assert.equal(readFileSync(path.join(root, reviewPath), "utf8"), reviewSource, "Review source changed during verification; rerun against the final source");
assert.equal(readFileSync(path.join(root, contractPath), "utf8"), contractSource, "Shared contract changed during verification; rerun against the final source");
assert.equal(readFileSync(path.join(root, workbenchPath), "utf8"), workbenchSource, "Owning workbench view changed during verification; rerun against the final source");
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: forbiddenCalls, providerCalls: 0, liveDatabaseCalls: 0,
  sources: [{ path: clientPath, sha256: hash(clientSource) }, { path: workbenchPath, sha256: hash(workbenchSource) }, { path: reviewPath, sha256: hash(reviewSource) }, { path: contractPath, sha256: hash(contractSource) }],
  extractedHandlersSha256: hash(extracted), actualHandlers: realHandlers,
  evidence: "Actual AST-extracted review hook handlers and draft wrapper call the complete real shared contract with installed Zod. React state, same-origin responses, owned asset reads and history refresh are fixtures; no live billing, storage, provider or browser acceptance.",
  cases: checks }, null, 2));
