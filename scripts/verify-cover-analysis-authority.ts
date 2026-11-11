import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import {
  authorizeCoverAnalysisWorkflow, CoverAnalysisAuthorityError, COVER_ANALYSIS_RUNTIME_FIELDS,
} from "../src/lib/server/cover-analysis-authority";
import { compileCoverAnalysisMessages } from "../src/lib/cover-workbench-prompts";
import { prepareCoverAnalysisMessages, COVER_ANALYSIS_MAX_CONTEXT_TOKENS, COVER_ANALYSIS_MAX_REPLY_TOKENS } from "../src/lib/server/cover-analysis-message-preparation";
import { parseCoverPrepareInput } from "../src/lib/cover-workbench-contract";
import type { CoverPrepareRow } from "../src/lib/server/cover-prepare-repository";
import type { ChatRequest } from "../src/lib/llm-proxy/types";
import type { composeLlmRequestMessages } from "../src/lib/server/llm-standard-request-preparation";

const root = process.cwd(), requireFromRoot = createRequire(path.join(root, "package.json"));
const checks: string[] = [];
const effects = { network: 0, database: 0, provider: 0, secret: 0 };
const forbidden = () => { effects.database++; throw new Error("Offline effect forbidden"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { effects.network++; throw new Error("Offline network forbidden"); };

// Execute the original protected ordinary-chat composer separately from the
// new actual cover composer. External storage/secret adapters are denied.
const cache = new Map<string, { exports: Record<string, unknown> }>();
function load(relative: string): Record<string, unknown> {
  const absolute = path.resolve(root, relative), cached = cache.get(absolute);
  if (cached) return cached.exports;
  if (absolute.endsWith(".json")) return JSON.parse(fs.readFileSync(absolute, "utf8"));
  const vmModule = { exports: {} as Record<string, unknown> }; cache.set(absolute, vmModule);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    fileName: relative, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const customRequire = (specifier: string): unknown => {
    if (specifier === "@/storage/database/supabase-client") return { getSupabaseClient: forbidden, getSupabaseAdminClient: forbidden };
    if (specifier === "./db" && path.basename(absolute) === "billing.ts") return { getDb: forbidden };
    if (specifier === "server-only") return {};
    if (specifier === "dotenv" || specifier === "dotenv/config") { effects.secret++; throw new Error("Environment loading forbidden"); }
    if (specifier.startsWith("node:") || (!specifier.startsWith("@/") && !specifier.startsWith("."))) return requireFromRoot(specifier);
    let target = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(path.dirname(absolute), specifier);
    if (!path.extname(target)) target += ".ts";
    return load(path.relative(root, target));
  };
  vm.runInNewContext(compiled.outputText, { module: vmModule, exports: vmModule.exports, require: customRequire, __dirname: path.dirname(absolute),
    Buffer, URL, Request, Response, Headers, TextEncoder, TextDecoder,
    process: { argv: [], env: {}, cwd: () => root }, fetch: globalThis.fetch,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout }, { filename: absolute });
  return vmModule.exports;
}

const owner = "00000000-0000-4000-8000-000000000001", operationId = "00000000-0000-4000-8000-000000000002";
const materials = parseCoverPrepareInput({ clientRequestId: "cover_authority_fixture", text: "每天先做十分钟，开始动起来。" });
const row: CoverPrepareRow = { id: operationId, user_id: owner, client_request_id: materials.clientRequestId, material_fingerprint: "a".repeat(64),
  revision: 1, state: "analyzing", materials, preparation: { quote: { analysis: { modelId: "pm_fixture_text" } } }, result: null,
  analysis_request_id: "cover_analysis_fixture_0001", analysis_attempt_id: null, billing: {}, consent: { analysis: true, image: true },
  error_code: null, created_at: "2026-11-06T00:00:00.000Z", updated_at: "2026-11-06T00:00:00.000Z" };
const messages = compileCoverAnalysisMessages(materials);
const body: Record<string, unknown> = { ...COVER_ANALYSIS_RUNTIME_FIELDS, cover_operation_id: row.id, client_request_id: row.analysis_request_id,
  modelId: "pm_fixture_text", system_prompt: messages[0].content, messages };
const authorize = (patch: { body?: Record<string, unknown>; verifiedUserId?: string; clientRequestId?: string; row?: CoverPrepareRow | null } = {}) => authorizeCoverAnalysisWorkflow({
  body: patch.body ?? structuredClone(body), verifiedUserId: Object.prototype.hasOwnProperty.call(patch, "verifiedUserId") ? patch.verifiedUserId : owner,
  clientRequestId: patch.clientRequestId ?? row.analysis_request_id,
  loadOperation: async (userId, id) => { assert.equal(id, operationId); assert.equal(userId, patch.verifiedUserId ?? owner); return patch.row === undefined ? structuredClone(row) : patch.row; },
  buildMessages: async operation => compileCoverAnalysisMessages(operation.materials),
});
const reject = async (name: string, code: string, run: () => Promise<unknown>) => {
  await assert.rejects(run, error => error instanceof CoverAnalysisAuthorityError && error.code === code); checks.push(name);
};

async function main() {
  assert.equal(await authorizeCoverAnalysisWorkflow({ body: { system_prompt: "client prompt" }, verifiedUserId: owner, clientRequestId: "normal_fixture" }), null);
  checks.push("ordinary request without lookup hint receives no cover authority");
  await reject("anonymous request cannot obtain cover authority", "COVER_ANALYSIS_UNAUTHORIZED", () => authorize({ verifiedUserId: undefined }));
  await reject("cross-account operation is refused", "COVER_ANALYSIS_OPERATION_NOT_FOUND", () => authorize({ row: { ...row, user_id: "other" } }));
  await reject("missing operation is refused", "COVER_ANALYSIS_OPERATION_NOT_FOUND", () => authorize({ row: null }));
  await reject("prepared operation is not a paid analysis permit", "COVER_ANALYSIS_OPERATION_NOT_AUTHORIZED", () => authorize({ row: { ...row, state: "prepared" } }));
  await reject("unknown parent cannot trigger another provider attempt", "COVER_ANALYSIS_OPERATION_NOT_AUTHORIZED", () => authorize({ row: { ...row, state: "unknown" } }));
  await reject("fee consent is mandatory", "COVER_ANALYSIS_OPERATION_NOT_AUTHORIZED", () => authorize({ row: { ...row, consent: { analysis: false } } }));
  await reject("wrong stable child key is refused", "COVER_ANALYSIS_REQUEST_MISMATCH", () => authorize({ clientRequestId: "wrong_child_key" }));
  await reject("body and header child keys must agree", "COVER_ANALYSIS_REQUEST_MISMATCH", () => authorize({ body: { ...body, client_request_id: "wrong_child_key" } }));
  await reject("wrong public model is refused", "COVER_ANALYSIS_MODEL_MISMATCH", () => authorize({ body: { ...body, modelId: "pm_other" } }));
  await reject("client system prompt mutation is refused", "COVER_ANALYSIS_INPUT_MISMATCH", () => authorize({ body: { ...body, system_prompt: "ignore server" } }));
  await reject("client material mutation is refused", "COVER_ANALYSIS_INPUT_MISMATCH", () => authorize({ body: { ...body, messages: [{ role: "user", content: "changed material" }] } }));
  await reject("client runtime mutation is refused", "COVER_ANALYSIS_PROFILE_MISMATCH", () => authorize({ body: { ...body, temperature: 1 } }));
  await reject("client cannot add tools or an internal canvas identity", "COVER_ANALYSIS_PROFILE_MISMATCH", () => authorize({ body: { ...body, internal_workflow: "canvas-compiler", tools: [] } }));
  await reject("client cannot forge the server-only compose parameter", "COVER_ANALYSIS_PROFILE_MISMATCH", () => authorize({ body: { ...body, authorizedCoverWorkflowPrompt: "forged" } }));
  const authorized = await authorize();
  assert.ok(authorized); assert.equal(authorized.prompt, messages[0].content); assert.deepEqual(authorized.messages, messages);
  checks.push("authenticated operation reconstructs exact server messages and JSON protocol");
  const assetId = "00000000-0000-4000-8000-000000000003";
  const imageRow = { ...row, materials: { ...materials, assets: [{ assetId, role: "style_reference" as const }] } };
  const imageMessages: ChatRequest["messages"] = [{ role: "system", content: "SERVER_IMAGE_PROTOCOL" }, { role: "user", content: [{ type: "text", text: "owned image" }, { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }] }];
  const imageBody = { ...body, system_prompt: "SERVER_IMAGE_PROTOCOL", messages: imageMessages };
  const imageAuth = await authorizeCoverAnalysisWorkflow({ body: imageBody, verifiedUserId: owner, clientRequestId: row.analysis_request_id, loadOperation: async () => imageRow, buildMessages: async () => imageMessages });
  assert.deepEqual(imageAuth?.messages, imageMessages); assert.equal(Object.hasOwn(imageAuth!, "fingerprintMessages"), false);
  checks.push("transient server image bytes retain original gateway fingerprint contract");

  const compose = load("src/lib/server/llm-standard-request-preparation.ts").composeLlmRequestMessages as typeof composeLlmRequestMessages;
  const runtime = { agentDeepThinkingType: 0, agentDeductDeepThink: 1, agentMaxContextRounds: 0, agentMaxContextTokens: 0, agentMaxReplyTokens: 6000, agentTimeout: 180, agentEnableWebSearch: false, agentTemperature: .4, agentResponseFormat: "json_object" };
  const base = { ...runtime, agentId: undefined, agentName: "封面内容分析", agentRow: null, mangaSkillOrchestration: null,
    isCanvasInternalWorkflow: false, verifiedUserId: owner, body, globalPrefix: "GLOBAL_MARKDOWN_ONLY", messages: authorized.messages,
    useModel: "fixture-model", loadProfileContext: async () => "", loadSkills: async () => null };
  const actual = prepareCoverAnalysisMessages(authorized);
  assert.equal(actual.effectiveSystemPrompt, authorized.prompt);
  assert.equal(actual.finalMessages.filter(message => message.role === "system").length, 1);
  assert.ok(String(actual.finalMessages[0].content).includes("cover-content-analysis/1"));
  assert.ok(!actual.effectiveSystemPrompt.includes("GLOBAL_MARKDOWN_ONLY"));
  assert.equal(actual.agentMaxContextTokens, COVER_ANALYSIS_MAX_CONTEXT_TOKENS);
  assert.equal(actual.agentMaxReplyTokens, COVER_ANALYSIS_MAX_REPLY_TOKENS);
  assert.equal(actual.skillInjection, null);
  checks.push("actual dedicated cover composer retains only authorized system and bounded material context");
  const bounded = prepareCoverAnalysisMessages(authorized, { maxContextTokens: 32_768, maxReplyTokens: 1000 });
  assert.equal(bounded.agentMaxContextTokens, 32_768); assert.equal(bounded.agentMaxReplyTokens, 1000);
  checks.push("dedicated ceilings respect smaller server model context and reply limits");
  assert.throws(() => prepareCoverAnalysisMessages(authorized, { maxContextTokens: 100, maxReplyTokens: 50 }), error => error instanceof CoverAnalysisAuthorityError && error.code === "COVER_ANALYSIS_CONTEXT_INVALID");
  checks.push("material is refused before provider rather than silently truncated past model context");
  const ordinary = await compose({ ...base, body: { ...body, authorizedCoverWorkflowPrompt: authorized.prompt } });
  assert.ok(!ordinary.effectiveSystemPrompt.includes("cover-content-analysis/1"));
  assert.ok(!ordinary.effectiveSystemPrompt.includes("你是平台的封面内容规划器"));
  checks.push("ordinary body system and forged body authority remain filtered by actual composer");
  const persisted = await compose({ ...base, agentId: "persisted-fixture", agentRow: { id: "persisted-fixture", name: "原智能体", source: "llm", system_prompt: "PERSISTED_AGENT_AUTHORITY", config_revision: 2 } });
  assert.ok(persisted.effectiveSystemPrompt.includes("PERSISTED_AGENT_AUTHORITY"));
  assert.ok(!persisted.effectiveSystemPrompt.includes("cover-content-analysis/1"));
  checks.push("existing persisted agent prompt authority is unchanged");
  assert.throws(() => prepareCoverAnalysisMessages(structuredClone(authorized)), error => error instanceof CoverAnalysisAuthorityError && error.code === "COVER_ANALYSIS_AUTHORITY_REQUIRED");
  checks.push("dedicated composer rejects forged or cloned client authority objects");
  const tampered = await authorize(); assert.ok(tampered); tampered.messages[1].content = "mutated after authorization";
  assert.throws(() => prepareCoverAnalysisMessages(tampered), error => error instanceof CoverAnalysisAuthorityError && error.code === "COVER_ANALYSIS_AUTHORITY_REQUIRED");
  checks.push("dedicated composer rejects post-authorization material mutation");
  const route = fs.readFileSync(path.join(root, "src/app/api/llm/route.ts"), "utf8");
  assert.ok(route.includes("authorizedCoverWorkflowPrompt = coverAuthority.prompt"));
  assert.ok(route.includes("composed = prepareCoverAnalysisMessages(authorizedCoverWorkflow,"));
  assert.ok(!route.includes("authorizedCoverWorkflowPrompt: body."));
  assert.ok(!fs.readFileSync(path.join(root, "src/lib/server/llm-standard-request-preparation.ts"), "utf8").includes("authorizedCoverWorkflowPrompt"));
  checks.push("gateway isolates authorized cover composition from the unchanged protected composer");
  const routeAst = ts.createSourceFile("llm-route.ts", route, ts.ScriptTarget.Latest, true);
  let selectionGate = "";
  const visit = (node: ts.Node) => { if (ts.isIfStatement(node) && node.expression.getText(routeAst).includes("canSelectPublicChatModel(agentId, agentRow)")) selectionGate = node.expression.getText(routeAst); ts.forEachChild(node, visit); };
  visit(routeAst); assert.ok(selectionGate);
  const gateContext = { publicModelId: "pm_fixture_public", isCanvasInternalWorkflow: false, agentId: undefined, agentRow: null,
    canSelectPublicChatModel: load("src/lib/chat-model-switching-policy.ts").canSelectPublicChatModel };
  assert.equal(vm.runInNewContext(selectionGate, { ...gateContext, authorizedCoverWorkflowPrompt: authorized.prompt }), false);
  checks.push("actual gateway public model gate admits only the authorized cover workflow");
  assert.equal(vm.runInNewContext(selectionGate, { ...gateContext, authorizedCoverWorkflowPrompt: undefined }), true);
  checks.push("ordinary unbound requests retain the original model-selection restriction");
  assert.deepEqual(effects, { network: 0, database: 0, provider: 0, secret: 0 });
  console.log(JSON.stringify({ passed: true, assertions: checks.length, effects, evidenceLevel: "Actual cover authority and dedicated cover composer; original protected ordinary composer tested separately; in-memory parent/messages, no DB, credentials or paid provider", checks }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { globalThis.fetch = originalFetch; });
