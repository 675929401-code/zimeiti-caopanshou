import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve("");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const cache = new Map();
function load(relative) {
  const absolute = path.resolve(root, relative);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} };
  cache.set(absolute, module);
  let source = fs.readFileSync(absolute, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const customRequire = (specifier) => {
    if (specifier.startsWith("node:")) return require(specifier);
    if (specifier === "@/lib/model-activation-gate") return { PENDING_TEXT_USER_ACCESS: "pending_model_activation" };
    if (specifier === "@/lib/llm-context") return { prepareContext: (messages) => messages };
    if (specifier === "@/lib/llm-reply-limit") return { resolveChatReplyLimit: (agent, model) => Number(agent || model || 16384) };
    if (specifier === "@/lib/server/agent-chat-prompt-authority") return { resolveAuthoritativeAgentPrompt: ({ serverPrompt }) => String(serverPrompt || ""), clientChatHistory: (messages) => messages };
    if (specifier === "@/lib/agent-identity-envelope") return { wrapGlobalPresentationRules: () => "", applyAgentIdentityEnvelope: (value) => value };
    if (specifier === "@/lib/business-ip/catalog") return { bipStep: () => false, bipAllowsSkills: () => true };
    if (specifier === "@/lib/website-promoter-context") return { buildWebsitePromoterKnowledgeContext: () => "" };
    if (specifier === "@/lib/free-chat-runtime-policy") return { shouldAutoEnableWebSearch: () => false };
    if (specifier === "@/lib/billing") return { billingConfigFromSettingsRows: () => ({}) };
    if (specifier === "@/lib/llm-billing") return { buildSelectedModelBillingSnapshot: () => null };
    if (specifier === "@/lib/llm-credit-reservation") return { quoteLlmStreamReservation: () => null };
    if (specifier === "@/lib/server/storyboard-director-runtime-policy") return { resolveStoryboardDirectorAnthropicProfile: () => undefined, resolveStoryboardDirectorTextOnly: () => false };
    if (specifier === "@/lib/llm-reply-limit") return load("src/lib/llm-reply-limit.ts");
    let target = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(path.dirname(absolute), specifier);
    if (!path.extname(target)) target += ".ts";
    return load(path.relative(root, target));
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: customRequire, __dirname: path.dirname(absolute), console, process: { env: {} } }, { filename: absolute });
  return module.exports;
}

const core = load("src/lib/server/llm-standard-request-preparation.ts");
const agent = { id: "agent-fixture", model_id: "model-fixture", system_prompt: "fixture", timeout: 300, max_reply_tokens: 1200, max_context_rounds: 0, max_context_tokens: 0, deep_thinking_type: 0, deduct_deep_think: 1, enable_web_search: false, temperature: 0, response_format: "json_object" };
const model = { id: "model-fixture", model_name: "gpt-6.1-sol", timeout: 300, max_reply_tokens: 4000, max_context_rounds: 0, max_context_tokens: 0, deep_thinking_type: 0, deduct_deep_think: 1, enable_web_search: false, temperature: 0, response_format: "json_object" };
const body = { timeout: 300, deep_thinking_type: 0, deep_thinking_overridden: true, enable_web_search: false, enable_web_search_overridden: true, maxReplyTokens: 1000 };
const configured = core.resolveLinkedModelRuntime(body, agent, model);
assert.equal(configured.agentTimeout, 300, "trusted configured timeout must keep 300s");
const forged = core.resolveLinkedModelRuntime({ ...body, timeout: 300 }, { ...agent, timeout: null }, { ...model, timeout: null });
assert.equal(forged.agentTimeout, 120, "client timeout must remain 120s without server config");
const over = core.resolveLinkedModelRuntime({ ...body, timeout: 999 }, { ...agent, timeout: 999 }, { ...model, timeout: 999 });
assert.equal(over.agentTimeout, 300, "configured timeout must cap at 300s");
const routeSource = fs.readFileSync(path.join(root, "src/app/api/llm/route.ts"), "utf8");
assert.match(routeSource, /const requestRuntimeTimeoutCap = isCanvasInternalWorkflow \? 300 : 120;/u);
assert.match(routeSource, /const configuredRuntimeTimeoutCap = 300;/u);
assert.match(routeSource, /let agentTimeout = clampRequestRuntimeTimeout\(reqTimeout, 120\);/u);
assert.match(routeSource, /agentRow\.timeout[\s\S]*clampConfiguredRuntimeTimeout/u);
console.log(JSON.stringify({ schemaVersion: "llm_timeout_contract_zero_network.v1", passed: true, assertions: 7, providerCalls: 0, databaseWrites: 0, clientTimeoutCapSeconds: 120, configuredTimeoutCapSeconds: 300 }, null, 2));
