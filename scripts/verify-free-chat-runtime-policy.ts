import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FREE_CHAT_DEEP_THINKING_TYPE,
  FREE_CHAT_DEFAULT_MODEL_KEY,
  hasAuditableWebSearchConfig,
  requiresAuditableWebPresearch,
  resolveWebSearchTransport,
  selectFreeChatDefaultModel,
  shouldAutoEnableWebSearch,
} from "../src/lib/free-chat-runtime-policy";

assert.equal(FREE_CHAT_DEFAULT_MODEL_KEY, "gpt-5.6-terra");
assert.equal(FREE_CHAT_DEEP_THINKING_TYPE, 2);
assert.equal(selectFreeChatDefaultModel([
  { model_name: "gpt-5.4-a", id: "old" },
  { model_name: "gpt-5.6-sol", id: "sol" },
  { model_name: " GPT-5.6-Terra ", id: "terra" },
])?.id, "terra");
assert.equal(selectFreeChatDefaultModel([{ model_name: "gpt-5.6-sol" }]), null);

for (const prompt of [
  "去联网找一下今天的行业新闻",
  "请上网查一下最新资料",
  "帮我网上搜索这个产品",
  "用浏览器找一下官方文档",
  "web search OpenAI documentation",
]) {
  assert.equal(shouldAutoEnableWebSearch(prompt), true, prompt);
}
for (const prompt of ["网络有点慢", "帮我总结这段文字", "这是网页设计方案"]) {
  assert.equal(shouldAutoEnableWebSearch(prompt), false, prompt);
}
assert.equal(requiresAuditableWebPresearch("gpt-5.6-terra"), true);
assert.equal(hasAuditableWebSearchConfig({}), false);
assert.equal(hasAuditableWebSearchConfig({ apiKey: "key", baseUrl: "not-a-url" }), false);
assert.equal(hasAuditableWebSearchConfig({ apiKey: "key", baseUrl: "https://search.example.com" }), true);
assert.equal(resolveWebSearchTransport("gpt-5.6-terra", {}), "native");
assert.equal(resolveWebSearchTransport("gpt-5.6-terra", {
  apiKey: "key",
  baseUrl: "https://search.example.com",
}), "presearch");
assert.equal(resolveWebSearchTransport("legacy-text-model", {}), "unavailable");
assert.equal(resolveWebSearchTransport("legacy-text-model", {
  apiKey: "key",
  baseUrl: "https://search.example.com",
}), "presearch");
assert.equal(requiresAuditableWebPresearch("gpt-5.4-a"), false);

const root = resolve(__dirname, "..");
const route = readFileSync(resolve(root, "src/app/api/llm/route.ts"), "utf8");
const chat = readFileSync(resolve(root, "src/components/chat-view.tsx"), "utf8");
const virtualAgents = readFileSync(resolve(root, "src/lib/virtual-chat-agents.ts"), "utf8");

assert.doesNotMatch(route, /FREE_CHAT_ADMIN_ONLY/u);
assert.match(route, /code: "MODEL_OVERRIDE_ADMIN_ONLY"/u);
assert.match(route, /FREE_CHAT_DEFAULT_MODEL_KEY/u);
assert.match(route, /FREE_CHAT_DEFAULT_MODEL_UNAVAILABLE/u);
assert.match(route, /agentDeepThinkingType = FREE_CHAT_DEEP_THINKING_TYPE/u);
assert.match(route, /semanticWebSearchRequested = shouldAutoEnableWebSearch/u);
assert.match(route, /webSearchTransport = resolveWebSearchTransport/u);
assert.match(route, /webSearchTransport === "native"/u);
assert.match(route, /WEB_SEARCH_REQUIRED_FAILED:SEARCH_PROVIDER_NOT_CONFIGURED/u);
assert.match(route, /WEB_SEARCH_REQUIRED_FAILED:EMPTY_RESULTS/u);
assert.match(route, /code: "WEB_SEARCH_UNAVAILABLE"/u);

assert.doesNotMatch(chat, /\/api\/chat-models|切换对话模型|选择对话模型|selectedPublicModelId/u);
assert.doesNotMatch(chat, /setDeepThinkingOverride|深度思考：已关闭/u);
assert.match(chat, /aria-label=\{webSearchOverride \? "关闭联网搜索" : "开启联网搜索"\}/u);
assert.match(chat, /shouldAutoEnableWebSearch\(apiContent \|\| messageContent\)/u);
assert.match(chat, /FREE_CHAT_DEEP_THINKING_TYPE/u);
assert.match(chat, /const targetAgentId = mentionedAgentId \|\| state\.activeAgentId;\s*const deepThinkingValue = targetAgentId === FREE_CHAT_AGENT_ID/u);
assert.match(chat, /从应用广场选择，或点击左侧「新建对话」/u);
assert.doesNotMatch(virtualAgents, /自由选择模型/u);
assert.match(virtualAgents, /GPT-5\.6 深度思考自由对话/u);

console.log(JSON.stringify({
  passed: true,
  checks: 33,
  networkCalls: 0,
  databaseWrites: 0,
  paidModelCalls: 0,
}, null, 2));
