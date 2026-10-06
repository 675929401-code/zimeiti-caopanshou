import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LLMProxy } from '../src/lib/llm-proxy/proxy';
import type { ChatRequest } from '../src/lib/llm-proxy/types';

// Execute actual dispatch, replacing fetch so no real provider/credential is used.
const originalFetch = globalThis.fetch;
const cases: string[] = [];
let captured: { url: string; body: Record<string, any> } | undefined;
globalThis.fetch = async (url, init) => {
  captured = { url: String(url), body: JSON.parse(String(init?.body)) };
  if (captured.body.stream) {
    const native = captured.url.endsWith('/messages');
    const text = native
      ? [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":1}}}',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
          'data: {"type":"message_delta","usage":{"output_tokens":9}}',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n\n')
      : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  return Response.json(captured.url.endsWith('/messages')
    ? {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 9 },
      }
    : { choices: [{ message: { content: 'ok' } }] });
};

async function main() {
try {
  const runtimeRoute = fs.readFileSync('src/app/api/llm/route.ts', 'utf8');
  assert.match(runtimeRoute, /import \{ resolveProviderSecret \} from "@\/lib\/provider-secret"/u,
    'runtime LLM requests must use the shared server-only credential resolver');
  assert.match(runtimeRoute, /const configuredApiKey = effectiveApiKey \|\| agentApiKey \|\| LLM_API_KEY;[\s\S]*?useApiKey = resolveProviderSecret\(configuredApiKey\)\.trim\(\)/u,
    'runtime LLM requests must resolve stored secret references before provider dispatch');
  assert.match(runtimeRoute, /code: "MODEL_RUNTIME_CREDENTIAL_UNAVAILABLE"/u,
    'unresolved runtime credentials must fail closed before provider dispatch');
  cases.push('runtime provider credential secret-reference resolution');
  for (const stream of [false, true]) {
    for (const route of ['openai', 'gpt61-lconai-primary', 'gpt61-lconai-backup', 'claude-native', 'claude-lconai-primary', 'claude-lconai-sonnet55', 'claude-lconai-backup', 'claude-openai-relay', 'deepseek'] as const) {
      const apiBase = route === 'claude-native' ? 'https://api.anthropic.com/v1'
        : route === 'gpt61-lconai-primary' ? 'https://n.lconai.com'
        : route === 'gpt61-lconai-backup' ? 'https://s.lconai.com'
        : route === 'claude-lconai-primary' || route === 'claude-lconai-sonnet55' ? 'https://n.lconai.com/v1'
        : route === 'claude-lconai-backup' ? 'https://s.lconai.com/v1'
        : route === 'claude-openai-relay' ? 'https://openai-relay.fixture.invalid/v1'
        : route === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://fixture.invalid/v1';
      const model = route === 'claude-lconai-sonnet55' ? 'claude-sonnet-5-5'
        : route.startsWith('claude') ? 'claude-opus-4-6'
        : route.startsWith('gpt61-') ? 'gpt-6.1-sol'
        : route === 'deepseek' ? 'deepseek-v4-flash' : 'gpt-5.6-sol';
      const messages = [{ role: 'system', content: 'PRIVATE_SYSTEM_FIXTURE' }, { role: 'user', content: 'hello' }];
      if (route === 'openai') messages.splice(1, 0, { role: 'developer', content: 'DEVELOPER_FIXTURE' });
      const request: ChatRequest = { model, messages, max_tokens: 100, temperature: 0,
        enable_thinking: route.startsWith('gpt61-'), response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'fixture', parameters: { type: 'object', properties: {} } } }],
        tool_choice: 'none' };
      const nativeClaude = ['claude-native', 'claude-lconai-primary', 'claude-lconai-sonnet55'].includes(route);
      const proxy = new LLMProxy({
        apiBase,
        apiKey: 'fixture-key',
        retryCount: 0,
        includeUsage: true,
        provider: route,
        protocol: nativeClaude ? 'anthropic_messages' : 'openai_chat',
        authScheme: route === 'claude-native' ? 'x-api-key' : 'bearer',
        ...(nativeClaude ? { protocolVersion: '2023-06-01' } : {}),
      });
      let observedUsage: { prompt_tokens: number; completion_tokens: number; cached_tokens: number } | undefined;
      if (stream) {
        await new Response(await proxy.chatStream(request, { onUsage: usage => { observedUsage = usage; } })).text();
      } else {
        observedUsage = (await proxy.chat(request)).usage;
      }
      assert.ok(captured);
      const { body, url } = captured;
      assert.equal(body.model, model);
      assert.equal(body.stream, stream);
      if (route.startsWith('gpt61-')) assert.match(url, /^https:\/\/[ns]\.lconai\.com\/v1\/chat\/completions$/u);
      const modernGpt = route === 'openai' || route.startsWith('gpt61-');
      assert.equal(body.max_completion_tokens, modernGpt ? 100 : undefined);
      assert.equal(body.max_tokens, modernGpt ? undefined : 100);
      if (route.startsWith('claude')) {
        assert.equal(body.system, nativeClaude ? 'PRIVATE_SYSTEM_FIXTURE' : undefined);
        assert.equal(body.messages.some((m: any) => m.role === 'system'), !nativeClaude);
        assert.equal(url.endsWith(nativeClaude ? '/messages' : '/chat/completions'), true, `${route}:${url}`);
        assert.equal(body.temperature, undefined);
        assert.deepEqual(body.thinking, nativeClaude && route !== 'claude-lconai-sonnet55' ? { type: 'disabled' } : undefined);
        if (nativeClaude) {
          assert.deepEqual(observedUsage, { prompt_tokens: 150, completion_tokens: 9, cached_tokens: 20 });
        }
      } else {
        assert.deepEqual(body.messages, messages);
        assert.equal(body.system, undefined);
        assert.equal(body.temperature, 0);
        assert.deepEqual(body.response_format, request.response_format);
        assert.deepEqual(body.tools, request.tools);
        assert.equal(body.tool_choice, 'none');
        assert.deepEqual(body.stream_options, stream ? { include_usage: true } : undefined);
        if (route.startsWith('gpt61-')) assert.equal(body.enable_thinking, undefined);
        if (route === 'deepseek') assert.deepEqual(body.thinking, { type: 'disabled' });
      }
      cases.push(`${route} ${stream ? 'stream' : 'nonstream'} request contract`);
    }
  }
  console.log(JSON.stringify({ passed: true, networkCalls: 0, cases }, null, 2));
} finally { globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
