#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("NETWORK_FORBIDDEN_IN_CHAT_STREAMING_EVIDENCE_GATE_TEST");
};
const verifierUrl = new URL("./verify-chat-streaming-experience-live.mjs", import.meta.url);
const { auditSseEvidence, buildPlanReport, parseSseReadEvidence, parseArgs, selectCases, CASES, caseCoverage, runSelectedCases, selectedExecutionPassed, comparePublishedPromptBinding, assertPublishedPromptPreflight, admitLlmRoute, validateHarnessQuoteReceipt, eligibleAcceptanceActor, acceptanceActorIdentity, assertAcceptanceAuthIdentity } = await import(verifierUrl.href);
const checks = [];
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks.push(name); }
const read = (ordinal, chars, terminal = false, failed = false) => ({
  atMs: ordinal * 60, ordinal, bytes: 24, gapMs: 60,
  cumulativeContentChars: chars, terminal, failed,
});
const incremental = auditSseEvidence([read(1, 4), read(2, 11), read(3, 29, true)]);
check("multiple preterminal content lengths accepted", incremental.passed, true);
check("network increment independently identified", incremental.networkIncrementalEvidence, true);
check("terminal read required", incremental.terminalReadAuditable, true);
check("intervals retained", incremental.chunkIntervalSampleCount, 2);
const fullThenHeartbeat = [read(1, 1000), read(2, 1000), read(3, 1000, true)];
check("full answer plus heartbeats fails long-answer streaming", auditSseEvidence(fullThenHeartbeat, 2).passed, false);
check("heartbeats never establish increment", auditSseEvidence(fullThenHeartbeat, 1).networkIncrementalEvidence, false);
check("short-answer one preterminal read satisfies its narrower threshold", auditSseEvidence(fullThenHeartbeat, 1).passed, true);
check("terminal-only content is not incremental", auditSseEvidence([read(1, 0), read(2, 100, true)], 1).passed, false);
check("single complete terminal read rejected", auditSseEvidence([read(1, 100, true)], 1).passed, false);
check("missing terminal rejected", auditSseEvidence([read(1, 4), read(2, 11)]).passed, false);
check("heartbeat-only rejected", auditSseEvidence([read(1, 0), read(2, 0, true)]).passed, false);
check("negative interval rejected", auditSseEvidence([read(1, 4), { ...read(2, 11), gapMs: -1 }, read(3, 11, true)]).passed, false);
check("reordered reads rejected", auditSseEvidence([read(2, 11), read(1, 4), read(3, 29, true)]).passed, false);
check("postterminal growth rejected", auditSseEvidence([read(1, 4), read(2, 11, true), read(3, 29)]).passed, false);
check("multiple terminal reads rejected", auditSseEvidence([read(1, 4), read(2, 11, true), read(3, 29, true)]).passed, false);
check("provider failure rejected", auditSseEvidence([read(1, 4), read(2, 11), read(3, 29, true, true)]).passed, false);
check("zero threshold rejected", auditSseEvidence(fullThenHeartbeat, 0).passed, false);
check("fractional threshold rejected", auditSseEvidence(fullThenHeartbeat, 1.5).passed, false);
check("numeric strings rejected", auditSseEvidence([read(1, 4), { ...read(2, 11), bytes: "24" }, read(3, 29, true)]).passed, false);
check("unstructured old samples rejected", auditSseEvidence([{ atMs: 1, ordinal: 1, bytes: 1, gapMs: 1, cumulativeContentChars: 1 }]).passed, false);
const event = { schemaVersion: 1, clientRequestId: "request_a", ...read(1, 7) };
const encoded = "[LLM_SSE_READ] " + JSON.stringify(event);
check("actual structured diagnostic parser", parseSseReadEvidence(encoded, "request_a", 90), { ...read(1, 7), atMs: 90 });
check("different request ignored", parseSseReadEvidence(encoded, "request_b", 90), null);
check("unbound request ignored", parseSseReadEvidence(encoded, "", 90), null);
check("malformed diagnostic ignored", parseSseReadEvidence("[LLM_SSE_READ] {", "request_a", 90), null);
check("old debug text cannot certify growth", parseSseReadEvidence("SSE chunk #1: 100bytes", "request_a", 90), null);
const plan = buildPlanReport({ execute: false, expectedSourceVersion: "R_TEST", expectedBuildId: "BUILD_TEST", userId: "", minimumCredits: 300 }, new Date("2026-10-10T00:00:00.000Z"));
check("static plan remains planned", plan.status, "planned");
check("current build gate remains mandatory", plan.runtimeGate.runningLatestRequiredAtExecution, true);
for (const name of ["actualLlmPosts", "providerCalls", "networkRequests", "fileWrites", "databaseWrites"]) check("plan " + name, plan.constraints[name], 0);
check("source pin preserved", plan.plan.command.includes("--expected-source-version=R_TEST"), true);
check("build pin preserved", plan.plan.command.includes("--expected-build-id=BUILD_TEST"), true);
const source = await readFile(verifierUrl, "utf8");
const mainIndex = source.indexOf("async function main()");
const earlyPlanIndex = source.indexOf("process.stdout.write(safeJson(buildPlanReport(options)))", mainIndex);
const firstEvidenceWriteIndex = source.indexOf("await fs.mkdir(outputDir", mainIndex);
const firstRuntimeReadIndex = source.indexOf("await fs.readFile(RUNTIME_PATH", mainIndex);
check("plan precedes runtime and evidence writes", mainIndex >= 0 && earlyPlanIndex > mainIndex && firstEvidenceWriteIndex > earlyPlanIndex && firstRuntimeReadIndex > earlyPlanIndex, true);
check("plan returns before writes", /return;/u.test(source.slice(earlyPlanIndex, firstEvidenceWriteIndex)), true);
check("DOM and network both gate success", /smoothness\.sampledNetworkHasContent && smoothness\.contentBearingSseSampleExists/u.test(source), true);
check("auditable intervals gate success", /smoothness\.chunkIntervalSamplesAuditable && smoothness\.sseEvidencePassed/u.test(source), true);
check("long cases require multiple content lengths", /testCase\.id === "short-answer" \? 1 : 2/u.test(source), true);
check("actual intake selector used", source.includes('getByTestId("agent-preset-intake")'), true);
check("base digest not reported as dispatch proof", source.includes("NOT_COLLECTED_BY_THIS_BROWSER_HARNESS"), true);

check("default parser selects all", selectCases(parseArgs([]).case).length, 3);
check("default actor remains student",parseArgs([]).actorRole,"student");
for(const args of [["--actor-role=admin"],["--actor-role=superadmin"],["--actor-role=admin","--actor-role=student","--user-id=fixture"]]) {
  assert.throws(()=>parseArgs(args)); checks.push("invalid explicit actor arguments reject before IO");
}
const adminOptions=parseArgs(["--actor-role=admin","--user-id=admin_fixture"]);
const adminActor={id:"admin_fixture",username:"fixture",role:"admin",is_active:true,status:"active",credits:500,credits_reserved:0};
check("explicit real admin eligibility",eligibleAcceptanceActor(adminActor,adminOptions),true);
check("admin actor must match exact id",eligibleAcceptanceActor({...adminActor,id:"another"},adminOptions),false);
check("role changed before credential setup rejected",eligibleAcceptanceActor({...adminActor,role:"student"},adminOptions),false);
check("student path does not inherit admin eligibility",eligibleAcceptanceActor({...adminActor,role:"student"},{...adminOptions,actorRole:"student"}),false);
check("student membership preserved",eligibleAcceptanceActor({...adminActor,role:"student",member_status:"active",allowed_categories:["task:影像编导"]},{...adminOptions,actorRole:"student"}),true);
const adminIdentity=acceptanceActorIdentity(adminActor,"admin");
check("JWT/browser identity retains true role",adminIdentity.role,"admin");
assert.throws(()=>acceptanceActorIdentity(adminActor,"student"));checks.push("credential cannot fake student role");
assertAcceptanceAuthIdentity({user:adminIdentity},adminActor,"admin");checks.push("actual auth identity admin accepted");
for(const user of [{...adminIdentity,role:"student"},{...adminIdentity,id:"another"}]) {assert.throws(()=>assertAcceptanceAuthIdentity({user},adminActor,"admin"));checks.push("auth identity drift stops before browser POST");}
check("admin report does not claim ordinary admission",buildPlanReport(adminOptions).constraints.ordinaryMemberAdmissionVerified,false);
for (const item of CASES) {
  const options = parseArgs(["--case=" + item.id]);
  check(item.id + " actual selector", selectCases(options.case).map((entry) => entry.id), [item.id]);
  const chosenPlan = buildPlanReport(options);
  check(item.id + " expected browser count", chosenPlan.constraints.expectedBrowserLlmPosts, 1);
  check(item.id + " plan roundtrip", parseArgs(chosenPlan.plan.command.split(" ").slice(2).filter((arg) => arg !== "--execute")).case, item.id);
  check(item.id + " omitted coverage", chosenPlan.coverage.omittedCaseIds.length, 2);
  check(item.id + " no invented provider ceiling", chosenPlan.constraints.providerDispatchCeiling, null);
}
for (const args of [["--case=unknown"], ["--case="], ["--case=all", "--case=long-list"], ["--case=long-list", "--case=long-list"]]) {
  assert.throws(() => parseArgs(args)); checks.push("actual parser rejects " + JSON.stringify(args));
}
const selected = selectCases("long-list");
const context = () => ({ selectedCases: selected, activeTurn: { caseId: "long-list", prompt: selected[0].prompt, request: null },
  llmPosts: 1, conversationIds: new Set(), clientRequestIds: new Set() });
const requestBody = () => ({ agentId: "agent-1786843330392-emdjv2", agentName: "3D故事导演｜高能版",
  conversationId: "conversation_123", client_request_id: "request_123", messages: [{ role: "user", content: selected[0].prompt }] });
function routeSpy(body, key = body.client_request_id) {
  const calls = { continued: 0, aborted: 0 };
  return { calls, continuedOptions: null, request: () => ({ postDataJSON: () => body, headers: () => ({ "idempotency-key": key }) }),
    async continue(options) { this.continuedOptions = options; calls.continued += 1; }, abort: async () => { calls.aborted += 1; } };
}
const admitted = context(); const firstRoute = routeSpy(requestBody());
await admitLlmRoute(firstRoute, admitted);
check("actual route selected case admitted once", firstRoute.calls, { continued: 1, aborted: 0 });
check("actual route binds only request hash", typeof admitted.activeTurn.request.payloadFingerprint, "string");
const duplicateRoute = routeSpy(requestBody()); await admitLlmRoute(duplicateRoute, admitted);
check("duplicate active request blocked", duplicateRoute.calls, { continued: 0, aborted: 1 });
for (const [name, alter] of [
  ["second browser post", (c) => { c.llmPosts = 2; }],
  ["inactive case", (c) => { c.activeTurn.caseId = "short-answer"; }],
  ["no active case", (c) => { c.activeTurn = null; }],
]) { const c = context(); alter(c); const route = routeSpy(requestBody()); await admitLlmRoute(route, c);
  check(name + " blocked before continue", route.calls, { continued: 0, aborted: 1 }); }
for (const [name, alter] of [
  ["wrong agent", (b) => { b.agentId = "other"; }],
  ["model override", (b) => { b.modelId = "other"; }],
  ["override flag", (b) => { b.model_overridden = true; }],
  ["wrong prompt", (b) => { b.messages[0].content = "replacement"; }],
]) { const b = requestBody(); alter(b); const route = routeSpy(b); await assert.rejects(() => admitLlmRoute(route, context()));
  check(name + " never continued", route.calls.continued, 0); }
const keyConflict = routeSpy(requestBody(), "different_request"); await assert.rejects(() => admitLlmRoute(keyConflict, context()));
check("request key conflict never continued", keyConflict.calls.continued, 0);
const reused = context(); reused.clientRequestIds.add("request_123"); const reusedRoute = routeSpy(requestBody());
await assert.rejects(() => admitLlmRoute(reusedRoute, reused)); check("reused request never continued", reusedRoute.calls.continued, 0);
const expectedQuote = { schemaVersion: "llm_platform_reservation_expectation.v1", actorSha256: createHash("sha256").update("actor_fixture").digest("hex"),
  agentId: requestBody().agentId, sourceVersion: "R_FIXTURE", buildId: "BUILD_FIXTURE", platformReservationCredits: 12 };
const quotedContext = { ...context(), quoteExpectation: expectedQuote }; const quotedRoute = routeSpy(requestBody());
await admitLlmRoute(quotedRoute, quotedContext);
const injectedBody = JSON.parse(quotedRoute.continuedOptions.postData);
check("actual route injects expectation", injectedBody.quote_expectation, expectedQuote);
for (const key of ["client_request_id", "conversationId", "messages"]) check("injection preserves browser " + key, injectedBody[key], requestBody()[key]);
check("injection preserves header key", quotedContext.activeTurn.request.idempotencyKey, requestBody().client_request_id);
check("fingerprint includes injected expectation", quotedContext.activeTurn.request.payloadFingerprint !== admitted.activeTurn.request.payloadFingerprint, true);
const changedQuotedContext = { ...context(), quoteExpectation: { ...expectedQuote, platformReservationCredits: 13 } };
await admitLlmRoute(routeSpy(requestBody()), changedQuotedContext);
check("same browser key with changed expectation changes fingerprint", changedQuotedContext.activeTurn.request.payloadFingerprint !== quotedContext.activeTurn.request.payloadFingerprint, true);
const existingExpectationRoute = routeSpy({ ...requestBody(), quote_expectation: expectedQuote });
await assert.rejects(() => admitLlmRoute(existingExpectationRoute, context()));
check("existing browser expectation cannot be silently replaced", existingExpectationRoute.calls.continued, 0);
const receiptOptions = { quoteReceiptSha256: "", case: "long-list", userId: "actor_fixture", expectedSourceVersion: "R_FIXTURE", expectedBuildId: "BUILD_FIXTURE" };
const fixtureReceipt = { schemaVersion: "llm_platform_reservation_receipt.v1", kind: "readonly_platform_reservation", caseId: "long-list", quoteExpectation: expectedQuote };
function verifyReceipt(receipt, options = receiptOptions) { const bytes = Buffer.from(JSON.stringify(receipt)); return validateHarnessQuoteReceipt(bytes, { ...options, quoteReceiptSha256: createHash("sha256").update(bytes).digest("hex") }); }
check("actual receipt validator accepts bound metadata", verifyReceipt(fixtureReceipt), expectedQuote);
for (const [field, value] of [["case", "short-answer"], ["userId", "other_actor"], ["expectedSourceVersion", "other"], ["expectedBuildId", "other"]]) {
  assert.throws(() => verifyReceipt(fixtureReceipt, { ...receiptOptions, [field]: value })); checks.push("receipt rejects " + field + " drift");
}
assert.throws(() => verifyReceipt({ ...fixtureReceipt, quoteExpectation: { ...expectedQuote, platformReservationCredits: -1 } })); checks.push("receipt rejects negative reservation");
assert.throws(() => validateHarnessQuoteReceipt(Buffer.from(JSON.stringify(fixtureReceipt)), { ...receiptOptions, quoteReceiptSha256: "0".repeat(64) })); checks.push("receipt rejects external SHA drift");
for (const args of [["--case=long-list", "--quote-receipt=fixture"], ["--quote-receipt=fixture", "--quote-receipt-sha256=" + "a".repeat(64)]]) {
  assert.throws(() => parseArgs(args)); checks.push("quote parser rejects unbound or all-case receipt");
}
const visited = []; await runSelectedCases(selected, async (item) => visited.push(item.id));
check("actual loop visits only selection", visited, ["long-list"]);
const failedVisited = []; await assert.rejects(() => runSelectedCases(selectCases(), async (item) => {
  failedVisited.push(item.id); throw new Error("UNKNOWN_STOP"); }));
check("first unknown stops without replacement", failedVisited, ["short-answer"]);
const passingAudit = { actualLlmPosts: 1, knownClientRequestIds: 1, attemptRows: 1, providerStartedEvents: 1, billingTransactions: 1 };
check("actual final single verdict", selectedExecutionPassed(selected, [{ caseId: "long-list", passed: true }], passingAudit), true);
check("omitted case cannot count as passed", selectedExecutionPassed(selected, [{ caseId: "short-answer", passed: true }], passingAudit), false);
check("missing case cannot pass", selectedExecutionPassed(selected, [], passingAudit), false);
for (const field of Object.keys(passingAudit)) check("final count drift " + field,
  selectedExecutionPassed(selected, [{ caseId: "long-list", passed: true }], { ...passingAudit, [field]: 2 }), false);
const prompt = "RAM-only controlled fixture"; const hash = createHash("sha256").update(prompt).digest("hex");
const baseline = { sha256: hash, revision: 3 };
check("actual final prompt match", comparePublishedPromptBinding(baseline, { system_prompt: prompt, config_revision: 3 }).passed, true);
for (const final of [{ system_prompt: "drift", config_revision: 3 }, { system_prompt: prompt, config_revision: 4 },
  { config_revision: 3 }, { system_prompt: prompt }]) check("missing or drift prompt rejected " + checks.length,
  comparePublishedPromptBinding(baseline, final).passed, false);
check("prompt text not retained", JSON.stringify(comparePublishedPromptBinding(baseline, { system_prompt: prompt, config_revision: 3 })).includes(prompt), false);
check("multiturn explicitly not tested", caseCoverage(selected).sameConversationMultiTurn, "NOT_TESTED");
check("reload explicitly not tested", caseCoverage(selected).reloadHistoryRecovery, "NOT_TESTED");


const explicitArgs = ["--execute", "--user-id=ordinary_fixture", "--expected-source-version=R_FIXTURE", "--expected-build-id=BUILD_FIXTURE"];
check("explicit execute parser positive", parseArgs(explicitArgs).execute, true);
for (const prefix of ["--user-id=", "--expected-source-version=", "--expected-build-id="]) {
  assert.throws(() => parseArgs(explicitArgs.filter((arg) => !arg.startsWith(prefix)))); checks.push("execute missing rejects " + prefix);
  assert.throws(() => parseArgs(explicitArgs.map((arg) => arg.startsWith(prefix) ? prefix + "   " : arg))); checks.push("execute whitespace rejects " + prefix);
}
check("help stays static without execute pins", parseArgs(["--help"]).help, true);
check("default plan names missing arguments", buildPlanReport(parseArgs([])).plan.unmetArgumentPrerequisites.length, 3);
check("plan never grants spend", buildPlanReport(parseArgs([])).plan.spendingAuthorized, false);
const returnedFailure = []; await assert.rejects(() => runSelectedCases(selectCases(), async (item) => { returnedFailure.push(item.id); return { passed: false }; }));
check("failed final sample verdict stops later submission", returnedFailure, ["short-answer"]);

let postPreflightEffects = 0;
for (const revision of [undefined, null, 0, -1, "invalid", 1.5]) {
  assert.throws(() => { assertPublishedPromptPreflight({ public: { agent: { publishedBasePrompt: { sha256: hash, revision } } },
    agent: { system_prompt: prompt, config_revision: revision } }); postPreflightEffects += 1; });
  checks.push("preflight invalid revision stops effects " + String(revision));
}
assertPublishedPromptPreflight({ public: { agent: { publishedBasePrompt: baseline } }, agent: { system_prompt: prompt, config_revision: 3 } });
check("actual prompt preflight invalid identity effect count", postPreflightEffects, 0);
check("zero network calls", networkCalls, 0);
process.stdout.write(JSON.stringify({ passed: checks.length, failed: 0, checks, networkCalls, paidCalls: 0, databaseWrites: 0, productFileWrites: 0 }, null, 2) + "\n");
