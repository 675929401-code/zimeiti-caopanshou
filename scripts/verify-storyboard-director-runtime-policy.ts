import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "../src/lib/story-director-overtime-gate";
import {
  STORYBOARD_HIGH_ENERGY_B_V6_PROMPT_SHA256,
  STORYBOARD_HIGH_ENERGY_B_V8_PROMPT_SHA256,
  STORYBOARD_HIGH_ENERGY_ULTRA_PROMPT_SHA256,
  STORYBOARD_NARRATIVE_UNIFIED_PROMPT_SHA256,
  resolveStoryboardDirectorTextOnly,
  STORYBOARD_HIGH_ENERGY_B_V6_MODEL_ID,
  resolveStoryboardDirectorAnthropicProfile,
} from "../src/lib/server/storyboard-director-runtime-policy";
import type { ChatRequest } from "../src/lib/llm-proxy/types";

type Core = typeof import("../src/lib/server/llm-standard-request-preparation");
type FixtureModule = { exports: Record<string, unknown> };

async function main(): Promise<void> {
  const root = path.resolve("");
  const require = createRequire(path.join(root, "package.json"));
  const effects = { database: 0, provider: 0 };
  const cache = new Map<string, FixtureModule>();
  const forbiddenDatabase = () => { effects.database += 1; throw new Error("OFFLINE_DATABASE_FORBIDDEN"); };
  const forbiddenProvider = () => { effects.provider += 1; throw new Error("OFFLINE_PROVIDER_FORBIDDEN"); };
  const load = (relative: string): Record<string, unknown> => {
    const absolute = path.resolve(root, relative);
    const cached = cache.get(absolute);
    if (cached) return cached.exports;
    if (absolute.endsWith(".json")) return JSON.parse(readFileSync(absolute, "utf8"));
    const fixtureModule: FixtureModule = { exports: {} };
    cache.set(absolute, fixtureModule);
    let source = readFileSync(absolute, "utf8");
    if (absolute === path.join(root, "src/lib/llm-proxy/proxy.ts")) {
      source += "\nexports.__buildClaudeMessagesBody = buildClaudeMessagesBody; exports.__buildOpenAiBody = buildOpenAiBody;";
    }
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const fixtureRequire = (specifier: string) => {
      if (specifier === "server-only") return {};
      if (specifier === "@/lib/server-runtime-env") return { ensureServerRuntimeEnvLoaded() {} };
      if (specifier === "@/storage/database/supabase-client") return { getSupabaseAdminClient: forbiddenDatabase, getSupabaseClient: forbiddenDatabase };
      if (specifier === "./db" && path.basename(absolute) === "billing.ts") return { getDb: forbiddenDatabase };
      if (specifier.startsWith("node:")) return require(specifier);
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return require(specifier);
      let target = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(path.dirname(absolute), specifier);
      if (!path.extname(target)) target += ".ts";
      return load(path.relative(root, target));
    };
    vm.runInNewContext(compiled, {
      module: fixtureModule, exports: fixtureModule.exports, require: fixtureRequire,
      __dirname: path.dirname(absolute), Buffer, URL, Response, Headers,
      console: { log() {}, warn() {} }, process: { argv: [], env: {} },
      fetch: forbiddenProvider, setTimeout, clearTimeout,
    }, { filename: absolute });
    return fixtureModule.exports;
  };
  const core = load("src/lib/server/llm-standard-request-preparation.ts") as unknown as Core;
  const prompt = readFileSync(path.join(root, "prompts/storyboard-high-energy-assets-order-B-v6.md"), "utf8");
  const b8Prompt = readFileSync(path.join(root, "prompts/storyboard-high-energy-assets-order-B-v8.md"), "utf8");
  const ultraPrompt = readFileSync(path.join(root, "prompts/storyboard-high-energy-assets-order-B-ultra-release.md"), "utf8");
  const narrativePrompt = readFileSync(path.join(root, "prompts/storyboard-narrative-unified-20261023.md"), "utf8");
  const legacyNarrativePrompt = readFileSync(path.join(root, "prompts/storyboard-voiceover-cinematic-v4.3.2.md"), "utf8");
  const previousB5Prompt = readFileSync(path.join(root, "prompts/storyboard-high-energy-assets-order-B-v5.md"), "utf8");
  const checks: string[] = [];
  const plain = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const check = (name: string, actual: unknown, ...expectedValues: unknown[]) => {
    const expected = expectedValues.length ? expectedValues[0] : true;
    assert.deepEqual(plain(actual), plain(expected), name);
    checks.push(name);
  };
  check("frozen B-v6 trim digest", createHash("sha256").update(prompt.trim(), "utf8").digest("hex"), STORYBOARD_HIGH_ENERGY_B_V6_PROMPT_SHA256);
  check("frozen B-v8 trim digest", createHash("sha256").update(b8Prompt.trim(), "utf8").digest("hex"), STORYBOARD_HIGH_ENERGY_B_V8_PROMPT_SHA256);
  check("frozen tested ultra trim digest", createHash("sha256").update(ultraPrompt.trim(), "utf8").digest("hex"), STORYBOARD_HIGH_ENERGY_ULTRA_PROMPT_SHA256);
  check("frozen narrative trim digest", createHash("sha256").update(narrativePrompt.trim(), "utf8").digest("hex"), STORYBOARD_NARRATIVE_UNIFIED_PROMPT_SHA256);
  const actorId = "offline-policy-actor";
  const agent = { id: STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, name: "3D故事导演｜高能版", source: "llm", is_active: true, deleted_at: null,
    model_id: STORYBOARD_HIGH_ENERGY_B_V6_MODEL_ID, model: "claude-opus-5-5", system_prompt: prompt, config_revision: 42, deep_thinking_type: 0,
    max_reply_tokens: 1200, max_context_rounds: 0, max_context_tokens: 0, temperature: 0.2 };
  const model = { id: STORYBOARD_HIGH_ENERGY_B_V6_MODEL_ID, name: "Offline Opus", model_name: "claude-opus-5-5", is_active: true, is_hidden: false,
    api_endpoint: "https://n.lconai.com", provider: "offline-fixture", api_protocol_config: { provider: "offline-fixture", protocol: "anthropic_messages" },
    deep_thinking_type: 2, deduct_deep_think: 1.5, max_reply_tokens: 4000, enable_web_search: false, token_billing_enabled: true,
    input_cost_per_million: 2, output_cost_per_million: 8, cached_cost_per_million: 0, profit_margin: 20, token_rounding_unit: 100 };
  const originalAgent = structuredClone(agent), originalModel = structuredClone(model);
  const body = { agentId: agent.id, messages: [{ role: "system", content: "Untrusted client prompt" }, { role: "user", content: "Compile a bounded scene." }],
    stream: true, maxReplyTokens: 10000, client_request_id: "offline-policy-request" };
  const expectedProfile = { id: "storyboard-high-energy-b-v6-adaptive-low-v1", thinkingMode: "adaptive", effort: "low" };
  const profileInput = { agentId: agent.id, serverPrompt: prompt, model };
  const ultraAgent = { ...agent, system_prompt: ultraPrompt, enable_web_search: true };
  check("ultra exact server identity grants text only", resolveStoryboardDirectorTextOnly({ agentId: agent.id, serverPrompt: ultraPrompt }), true);
  check("ultra changed SHA does not grant text only", resolveStoryboardDirectorTextOnly({ agentId: agent.id, serverPrompt: `${ultraPrompt.trim()}改` }), false);
  check("ultra other agent does not grant text only", resolveStoryboardDirectorTextOnly({ agentId: "other", serverPrompt: ultraPrompt }), false);
  check("ultra virtual compiler does not grant main agent policy", resolveStoryboardDirectorTextOnly({ agentId: "storyboard-compiler", serverPrompt: ultraPrompt }), false);
  check("narrative exact server identity grants text only", resolveStoryboardDirectorTextOnly({ agentId: STORY_DIRECTOR_MOVIE_AGENT_ID, serverPrompt: narrativePrompt }), true);
  check("narrative trimmed prompt keeps exact identity", resolveStoryboardDirectorTextOnly({ agentId: STORY_DIRECTOR_MOVIE_AGENT_ID, serverPrompt: `\n ${narrativePrompt.trim()} \n` }), true);
  for (const serverPrompt of [legacyNarrativePrompt, `${narrativePrompt.trim()}改`, ultraPrompt, "storyboard_director_contract.v2 storyboard_director_plan.v1 storyboard_performance.v1"]) {
    check("narrative unknown SHA retains defaults", resolveStoryboardDirectorTextOnly({ agentId: STORY_DIRECTOR_MOVIE_AGENT_ID, serverPrompt }), false);
  }
  for (const agentId of [STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, "other-agent", "叙事版", undefined]) {
    check("narrative SHA cannot authorize a different identity", resolveStoryboardDirectorTextOnly({ agentId, serverPrompt: narrativePrompt }), false);
  }
  for (const thinking of [0, 2]) {
    const ultraRuntime = core.resolveLinkedModelRuntime({ ...body, deepThinkingType: thinking, deepThinkingOverridden: true, enableWebSearch: true, enableWebSearchOverridden: true }, ultraAgent, model);
    check(`ultra thinking ${thinking} retained`, ultraRuntime.agentDeepThinkingType, thinking);
    check(`ultra thinking ${thinking} no forced low profile`, ultraRuntime.anthropic_thinking_profile, undefined);
    check(`ultra thinking ${thinking} search disabled`, ultraRuntime.agentEnableWebSearch, false);
    check(`ultra thinking ${thinking} trusted marker`, ultraRuntime.trustedTextOnly, true);
    const request = core.buildLlmChatRequest(model.model_name, [], ultraRuntime, true);
    check(`ultra thinking ${thinking} marker not provider payload`, Object.hasOwn(request, "trustedTextOnly"), false);
    check(`ultra thinking ${thinking} profile not provider payload`, Object.hasOwn(request, "anthropic_thinking_profile"), false);
  }
  const forgedRuntime = core.resolveLinkedModelRuntime({ ...body, trustedTextOnly: true }, { ...agent, system_prompt: "unknown" }, model);
  check("client cannot grant trusted text only", forgedRuntime.trustedTextOnly, undefined);
  const b8Profile = { id: "storyboard-high-energy-b-v8-adaptive-low-v1", thinkingMode: "adaptive", effort: "low" };
  const b8ProfileInput = { ...profileInput, serverPrompt: b8Prompt };
  check("exact B8 binding selects its own adaptive low profile", resolveStoryboardDirectorAnthropicProfile(b8ProfileInput), b8Profile);
  check("B8 unknown prompt digest fails closed", resolveStoryboardDirectorAnthropicProfile({ ...b8ProfileInput, serverPrompt: `${b8Prompt.trim()}修改` }), undefined);
  check("B8 different server agent fails closed", resolveStoryboardDirectorAnthropicProfile({ ...b8ProfileInput, agentId: "other-agent" }), undefined);
  check("B8 trimmed prompt identity", resolveStoryboardDirectorAnthropicProfile({ ...b8ProfileInput, serverPrompt: `\n ${b8Prompt.trim()} \n` }), b8Profile);
  check("exact trusted compiler model and transport select adaptive low", resolveStoryboardDirectorAnthropicProfile(profileInput), expectedProfile);
  check("previous B5 prompt is no longer eligible", resolveStoryboardDirectorAnthropicProfile({ ...profileInput, serverPrompt: previousB5Prompt }), undefined);
  check("previous B5 runtime has no version profile", core.resolveLinkedModelRuntime(body, { ...agent, system_prompt: previousB5Prompt }, model).anthropic_thinking_profile, undefined);
  check("trimmed prompt identity", resolveStoryboardDirectorAnthropicProfile({ ...profileInput, serverPrompt: `\n ${prompt.trim()} \n` }), expectedProfile);
  for (const unknownId of [undefined, null, STORY_DIRECTOR_MOVIE_AGENT_ID, "3D故事导演｜高能版", `${STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID}-alias`]) {
    check(`unknown identity ${String(unknownId)} gets no profile`, resolveStoryboardDirectorAnthropicProfile({ ...profileInput, agentId: unknownId }), undefined);
  }
  for (const unknownPrompt of [undefined, null, { sha256: STORYBOARD_HIGH_ENERGY_B_V6_PROMPT_SHA256 }, "Old prompt", `${prompt.trim()}修改`]) {
    check("nonmatching server prompt gets no profile", resolveStoryboardDirectorAnthropicProfile({ ...profileInput, serverPrompt: unknownPrompt }), undefined);
  }
  for (const [label, changedModel] of [
    ["different model ID", { ...model, id: "different-model" }],
    ["different model name", { ...model, model_name: "claude-sonnet-5-5" }],
    ["HTTP endpoint", { ...model, api_endpoint: "http://n.lconai.com" }],
    ["different host", { ...model, api_endpoint: "https://s.lconai.com" }],
    ["host suffix spoof", { ...model, api_endpoint: "https://n.lconai.com.example.test" }],
    ["nondefault port", { ...model, api_endpoint: "https://n.lconai.com:444" }],
    ["userinfo endpoint", { ...model, api_endpoint: "https://fixture@n.lconai.com" }],
    ["OpenAI protocol", { ...model, api_protocol_config: { provider: "offline-fixture", protocol: "openai_chat" } }],
    ["unknown protocol", { ...model, api_protocol_config: {} }],
  ] as const) {
    check(`${label} gets no profile`, resolveStoryboardDirectorAnthropicProfile({ ...profileInput, model: changedModel }), undefined);
    check(`B8 ${label} gets no profile`, resolveStoryboardDirectorAnthropicProfile({ ...b8ProfileInput, model: changedModel }), undefined);
    check(`${label} keeps linked thinking semantics`, core.resolveLinkedModelRuntime(body, agent, changedModel).agentDeepThinkingType, 2);
  }
  check("linked model native thinking remains enabled", core.resolveLinkedModelRuntime(body, agent, model).agentDeepThinkingType, 2);
  check("manual disable cannot misquote mandatory adaptive thinking", core.resolveLinkedModelRuntime({ ...body, deepThinkingType: 0, deepThinkingOverridden: true }, agent, model).agentDeepThinkingType, 2);
  check("legacy prompt model wins over agent zero", core.resolveLinkedModelRuntime(body, { ...agent, system_prompt: "Old prompt" }, model).agentDeepThinkingType, 2);
  check("legacy manual override retained", core.resolveLinkedModelRuntime({ ...body, deepThinkingType: 0, deepThinkingOverridden: true }, { ...agent, system_prompt: "Old prompt" }, model).agentDeepThinkingType, 0);
  check("client prompt and profile cannot substitute server prompt", core.resolveLinkedModelRuntime({ ...body, system_prompt: prompt, serverPrompt: prompt, anthropic_thinking_profile: expectedProfile }, { ...agent, system_prompt: "Old prompt" }, model).anthropic_thinking_profile, undefined);
  check("client target ID cannot substitute server row ID", core.resolveLinkedModelRuntime(body, { ...agent, id: "other-agent" }, model).anthropic_thinking_profile, undefined);
  check("missing server row ID fails closed", core.resolveLinkedModelRuntime(body, { ...agent, id: undefined }, model).anthropic_thinking_profile, undefined);
  const storySearchText = "很多人第一反应是上网搜攻略，结果越看越慌。";
  const searchRuntime = core.resolveLinkedModelRuntime({ ...body, enableWebSearch: true, enableWebSearchOverridden: true }, { ...agent, enable_web_search: true }, { ...model, enable_web_search: true });
  check("trusted text-only compiler disables configured and client search", searchRuntime.agentEnableWebSearch, false);
  check("source narrative never requests host search", core.shouldAutoEnableRuntimeWebSearch(storySearchText, searchRuntime.anthropic_thinking_profile), false);
  check("ordinary narrative search heuristic unchanged", core.shouldAutoEnableRuntimeWebSearch(storySearchText), true);
  check("ordinary explicit search unchanged", core.shouldAutoEnableRuntimeWebSearch("帮我联网查一下"), true);
  check("ordinary no-search unchanged", core.shouldAutoEnableRuntimeWebSearch("编写宠物故事"), false);
  const legacySearch = core.resolveLinkedModelRuntime({ ...body, anthropic_thinking_profile: expectedProfile }, { ...agent, system_prompt: previousB5Prompt }, { ...model, enable_web_search: true });
  check("client cannot grant text-only trusted profile", legacySearch.anthropic_thinking_profile, undefined);
  check("legacy model search configuration unchanged", legacySearch.agentEnableWebSearch, true);

  const snapshot = { agent, model, actor: { id: actorId, is_active: true, status: "active", role: "student" }, skills: [], readsVerified: true as const,
    settings: [{ setting_key: "credits_per_yuan", setting_value: "50" }, { setting_key: "global_system_prefix", setting_value: "Offline presentation." }] };
  const prepared = await core.prepareStandardLlmRequest(body, snapshot, actorId, "pm_offline_policy", { sourceVersion: "R_FIXTURE", buildId: "BUILD_FIXTURE" });
  const sourceStoryPrepared = await core.prepareStandardLlmRequest({ ...body, messages: [{ role: "user", content: storySearchText }] }, { ...snapshot, model: { ...model, enable_web_search: true } }, actorId, "pm_offline_policy", { sourceVersion: "R_FIXTURE", buildId: "BUILD_FIXTURE" });
  check("real story wording eligible for standard quote without search", sourceStoryPrepared.parameters.agentEnableWebSearch, false);
  check("text-only request carries no search tools", sourceStoryPrepared.chatRequest.tools || [], []);
  const parameters = core.resolveLinkedModelRuntime(body, agent, model);
  const ultraSnapshot = { ...snapshot, agent: ultraAgent };
  const ultraBody = { ...body, messages: [{ role: "user", content: storySearchText }], enableWebSearch: true, enableWebSearchOverridden: true };
  const ultraPrepared = await core.prepareStandardLlmRequest(ultraBody, ultraSnapshot, actorId, "pm_offline_policy", { sourceVersion: "R_FIXTURE", buildId: "BUILD_FIXTURE" });
  const ultraActualParameters = core.resolveLinkedModelRuntime(ultraBody, ultraAgent, model);
  const ultraActual = core.buildLlmChatRequest(model.model_name, ultraPrepared.chatRequest.messages, ultraActualParameters, true);
  check("ultra quote and actual same provider payload", ultraPrepared.chatRequest, ultraActual);
  check("ultra quote no explicit low profile", ultraPrepared.chatRequest.anthropic_thinking_profile, undefined);
  check("ultra quote no search tools", ultraPrepared.chatRequest.tools, undefined);
  const narrativeAgent = { ...ultraAgent, id: STORY_DIRECTOR_MOVIE_AGENT_ID, system_prompt: narrativePrompt, output_style: {
    production_contract_version: "storyboard_director_contract.v2", production_contract_activated_at: "2026-10-23T18:00:00Z",
    performance_contract: "storyboard_performance.v1", performance_contract_activated_at: "2026-10-23T18:00:00Z",
  } };
  for (const thinking of [0, 2]) {
    const narrativeBody = { ...ultraBody, agentId: STORY_DIRECTOR_MOVIE_AGENT_ID, deepThinkingType: thinking, deepThinkingOverridden: true };
    const runtime = core.resolveLinkedModelRuntime(narrativeBody, narrativeAgent, model);
    check(`narrative thinking ${thinking} retained`, runtime.agentDeepThinkingType, thinking);
    check(`narrative thinking ${thinking} has no forced Claude low profile`, runtime.anthropic_thinking_profile, undefined);
    check(`narrative thinking ${thinking} has exact text-only policy`, runtime.trustedTextOnly, true);
    check(`narrative thinking ${thinking} disables client and configured search`, runtime.agentEnableWebSearch, false);
    const quoted = await core.prepareStandardLlmRequest(narrativeBody, { ...snapshot, agent: narrativeAgent }, actorId, "pm_offline_policy", { sourceVersion: "R_FIXTURE", buildId: "BUILD_FIXTURE" });
    const actual = core.buildLlmChatRequest(model.model_name, quoted.chatRequest.messages, runtime, true);
    check(`narrative thinking ${thinking} quote and actual match`, quoted.chatRequest, actual);
    check(`narrative thinking ${thinking} has no provider search tools`, quoted.chatRequest.tools, undefined);
    check(`narrative thinking ${thinking} marker is not a provider field`, Object.hasOwn(quoted.chatRequest, "trustedTextOnly"), false);
  }
  const legacyNarrative = core.resolveLinkedModelRuntime({ ...ultraBody, agentId: STORY_DIRECTOR_MOVIE_AGENT_ID }, { ...narrativeAgent, system_prompt: legacyNarrativePrompt }, { ...model, enable_web_search: true });
  check("legacy cinematic keeps configured search behavior", legacyNarrative.agentEnableWebSearch, true);
  check("legacy cinematic gets no trusted text-only authority", legacyNarrative.trustedTextOnly, undefined);
  await assert.rejects(() => core.prepareStandardLlmRequest({ ...ultraBody, trustedTextOnly: true }, ultraSnapshot, actorId, "pm_offline_policy", { sourceVersion: "R_FIXTURE", buildId: "BUILD_FIXTURE" }));
  checks.push("quote rejects client trusted text-only marker");
  const composed = await core.composeLlmRequestMessages({ ...parameters, agentId: agent.id, agentName: agent.name, agentRow: agent,
    mangaSkillOrchestration: null, isCanvasInternalWorkflow: false, verifiedUserId: actorId, body, globalPrefix: "Offline presentation.", messages: body.messages,
    useModel: model.model_name, loadProfileContext: async () => "", loadSkills: async () => null });
  const actualRequest = core.buildLlmChatRequest(model.model_name, composed.finalMessages, { ...parameters, agentDeepThinkingType: composed.agentDeepThinkingType,
    agentMaxContextRounds: composed.agentMaxContextRounds, agentMaxContextTokens: composed.agentMaxContextTokens }, true);
  check("quote and actual use identical provider request", actualRequest, prepared.chatRequest);
  check("quote includes exact adaptive low profile", prepared.chatRequest.anthropic_thinking_profile, expectedProfile);
  check("actual includes exact adaptive low profile", actualRequest.anthropic_thinking_profile, expectedProfile);
  check("quote and actual retain native thinking", [prepared.chatRequest.enable_thinking, actualRequest.enable_thinking], [true, true]);
  check("quote retains existing reasoning output multiplier", prepared.reservation.outputBudget, 1800);
  check("quote pins trusted model metadata", ["api_endpoint", "provider", "api_protocol_config"].every(field => (core.STANDARD_MODEL_FIELDS as readonly string[]).includes(field)));
  check("input records not mutated", [agent, model], [originalAgent, originalModel]);
  await assert.rejects(() => core.prepareStandardLlmRequest({ ...body, model_overridden: true }, snapshot, actorId, "pm_offline_policy", { sourceVersion: "R_FIXTURE", buildId: "BUILD_FIXTURE" }));
  checks.push("model override remains outside standard quoted path");
  await assert.rejects(() => core.prepareStandardLlmRequest({ ...body, anthropic_thinking_profile: expectedProfile }, snapshot, actorId, "pm_offline_policy", { sourceVersion: "R_FIXTURE", buildId: "BUILD_FIXTURE" }));
  checks.push("quote rejects client-supplied profile field");

  const native = load("src/lib/llm-proxy/proxy.ts") as unknown as {
    __buildClaudeMessagesBody: (request: ChatRequest, apiBase: string, model: string, stream: boolean) => Record<string, unknown>;
    __buildOpenAiBody: (request: ChatRequest, apiBase: string, model: string, stream: boolean) => Record<string, unknown>;
  };
  const b8Agent = { ...agent, system_prompt: b8Prompt, enable_web_search: true };
  const b8Model = { ...model, enable_web_search: true };
  const b8Body = { ...body, messages: [{ role: "user", content: storySearchText }], enableWebSearch: true, enableWebSearchOverridden: true };
  const b8Prepared = await core.prepareStandardLlmRequest(b8Body, { ...snapshot, agent: b8Agent, model: b8Model }, actorId, "pm_offline_policy", { sourceVersion: "R_FIXTURE", buildId: "BUILD_FIXTURE" });
  const b8Parameters = core.resolveLinkedModelRuntime(b8Body, b8Agent, b8Model);
  const b8Composed = await core.composeLlmRequestMessages({ ...b8Parameters, agentId: b8Agent.id, agentName: b8Agent.name, agentRow: b8Agent,
    mangaSkillOrchestration: null, isCanvasInternalWorkflow: false, verifiedUserId: actorId, body: b8Body, globalPrefix: "Offline presentation.", messages: b8Body.messages,
    useModel: b8Model.model_name, loadProfileContext: async () => "", loadSkills: async () => null });
  const b8ActualRequest = core.buildLlmChatRequest(b8Model.model_name, b8Composed.finalMessages, { ...b8Parameters,
    agentDeepThinkingType: b8Composed.agentDeepThinkingType, agentMaxContextRounds: b8Composed.agentMaxContextRounds,
    agentMaxContextTokens: b8Composed.agentMaxContextTokens }, true);
  check("B8 quote and actual provider requests are identical", b8Prepared.chatRequest, b8ActualRequest);
  check("B8 quote and actual use exact B8 profile", [b8Prepared.chatRequest.anthropic_thinking_profile, b8ActualRequest.anthropic_thinking_profile], [b8Profile, b8Profile]);
  check("B8 quote and actual force configured/client search off", [b8Prepared.parameters.agentEnableWebSearch, b8Parameters.agentEnableWebSearch], [false, false]);
  check("B8 narrative search heuristic disabled", core.shouldAutoEnableRuntimeWebSearch(storySearchText, b8Parameters.anthropic_thinking_profile), false);
  check("B8 has no search tools", b8Prepared.chatRequest.tools || [], []);
  check("B8 unknown SHA retains search defaults", core.resolveLinkedModelRuntime(b8Body, { ...b8Agent, system_prompt: `${b8Prompt.trim()}修改` }, b8Model).agentEnableWebSearch, true);
  for (const stream of [false, true]) {
    const nativeB8 = native.__buildClaudeMessagesBody(b8ActualRequest, model.api_endpoint, model.model_name, stream);
    check(`B8 native stream=${stream} adaptive low body`, [nativeB8.thinking, nativeB8.output_config], [{ type: "adaptive" }, { effort: "low" }]);
    check(`B8 native stream=${stream} internal profile not sent`, Object.hasOwn(nativeB8, "anthropic_thinking_profile"), false);
  }
  check("B8 native wrong host gets no adaptive low body", native.__buildClaudeMessagesBody(b8ActualRequest, "https://other.example", model.model_name, true).thinking, undefined);
  for (const stream of [false, true]) {
    const nativeBody = native.__buildClaudeMessagesBody(actualRequest, model.api_endpoint, model.model_name, stream);
    check(`native stream=${stream} adaptive body`, nativeBody.thinking, { type: "adaptive" });
    check(`native stream=${stream} low effort body`, nativeBody.output_config, { effort: "low" });
    check(`native stream=${stream} bounded output`, nativeBody.max_tokens, 1200);
    check(`native stream=${stream} internal profile not sent`, Object.hasOwn(nativeBody, "anthropic_thinking_profile"), false);
  }
  const oldRequest = { ...actualRequest, anthropic_thinking_profile: undefined };
  check("ordinary native request preserves provider defaults", native.__buildClaudeMessagesBody(oldRequest, model.api_endpoint, model.model_name, false).thinking, undefined);
  check("wrong host native request gets no profile", native.__buildClaudeMessagesBody(actualRequest, "https://other.example", model.model_name, false).thinking, undefined);
  check("wrong model native request gets no profile", native.__buildClaudeMessagesBody(actualRequest, model.api_endpoint, "claude-sonnet-5-5", false).thinking, undefined);
  const openAiBody = native.__buildOpenAiBody(actualRequest, model.api_endpoint, model.model_name, false);
  check("OpenAI protocol gets no adaptive body", openAiBody.thinking, undefined);
  check("OpenAI protocol gets no low effort body", openAiBody.output_config, undefined);

  const routeSource = readFileSync(path.join(root, "src/app/api/llm/route.ts"), "utf8");
  assert.match(routeSource, /client\.from\("agents"\)\.select\("id, name, source,/u, "actual route must load trusted server row ID");
  checks.push("actual agent ID selected from server");
  const ast = ts.createSourceFile("route.ts", routeSource, ts.ScriptTarget.Latest, true);
  let linkedBranch = "";
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === "agentRow?.model_id && !model_overridden && !isVirtualAgent") linkedBranch = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(linkedBranch.includes("resolveLinkedModelRuntime(body,agentRow,linkedRow)"), "actual route must pass the server row to the shared resolver");
  checks.push("actual route uses shared resolver with server row");
  const branchScript = ts.transpileModule(`let agentDeepThinkingType = 2, agentDeductDeepThink, agentMaxContextRounds, agentMaxContextTokens,
    agentMaxReplyTokens, agentTimeout, agentEnableWebSearch, agentTemperature, agentResponseFormat, anthropic_thinking_profile, trustedTextOnly;
    ${linkedBranch}; ({type: agentDeepThinkingType, profile: anthropic_thinking_profile});`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const modelOverridden of [false, true]) {
    const actualType = vm.runInNewContext(branchScript, { agentRow: agent, model_overridden: modelOverridden, isVirtualAgent: false,
      modelPresetConfig: model, modelIdData: null, body, resolveLinkedModelRuntime: core.resolveLinkedModelRuntime,
      LlmQuotePreparationError: core.LlmQuotePreparationError });
    check(`actual route model_overridden=${modelOverridden}`, actualType, modelOverridden ? { type: 2 } : { type: 2, profile: expectedProfile });
  }
  const searchStart = routeSource.indexOf("    const semanticWebSearchRequested =");
  const searchEnd = routeSource.indexOf("    let billingModelRow =", searchStart);
  assert.ok(searchStart > 0 && searchEnd > searchStart);
  const searchBranch = routeSource.slice(searchStart, searchEnd);
  for (const [label, profile, trustedTextOnly, expected] of [["trusted B6", expectedProfile, false, false], ["trusted B8", b8Profile, false, false], ["trusted ultra", undefined, true, false], ["ordinary chat", undefined, false, true]] as const) {
    const actual = vm.runInNewContext(ts.transpileModule(`let agentEnableWebSearch=false; ${searchBranch}; agentEnableWebSearch;`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
      { lastUserInput: { content: storySearchText }, messageText: (value: string) => value, anthropic_thinking_profile: profile, trustedTextOnly,
        shouldAutoEnableRuntimeWebSearch: core.shouldAutoEnableRuntimeWebSearch });
    check(`actual route search branch ${label}`, actual, expected);
  }
  check("no provider or database effects", effects, { database: 0, provider: 0 });
  console.log(JSON.stringify({ passed: true, assertions: checks.length, promptTrimSha256: STORYBOARD_HIGH_ENERGY_B_V6_PROMPT_SHA256,
    exactAgentId: STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, exactModelId: STORYBOARD_HIGH_ENERGY_B_V6_MODEL_ID,
    anthropicThinkingProfile: expectedProfile, modelOverridePolicyApplied: false,
    quoteAndActualAdaptiveLow: true, nativeThinkingEnabled: true, effects, checks }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
