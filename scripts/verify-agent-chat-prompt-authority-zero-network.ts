import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { resolveAuthoritativeAgentPrompt, agentPromptAuditIdentity, requireAssistantPersistence, clientChatHistory } from '../src/lib/server/agent-chat-prompt-authority';
import { prepareContext } from '../src/lib/llm-context';
import { isConversationMetadataSyncBlocked, settledChatPersistenceWarning } from '../src/contexts/chat-recovery-policy';
import { createBipGuardedStream, BipStreamPromptLeakError } from '../src/lib/server/bip-guarded-stream';
import { containsPromptLeak, normalizeBipGuardText } from '../src/lib/business-ip/guard';

async function verifyActualStreamHandler(persistenceError: boolean, leak = false) {
  let settled = false;
  let assistantInsertCount = 0;
  let releaseSettlement!: () => void;
  const settlementGate = new Promise<void>(resolve => { releaseSettlement = resolve; });
  const imports: Record<string, unknown> = {
    '@/lib/sse-stream-decoder': require('../src/lib/sse-stream-decoder'),
    '@/lib/llm-proxy/stream-error': require('../src/lib/llm-proxy/stream-error'),
    '@/lib/llm-billing': { settleLlmUsage: async () => { await settlementGate; settled = true; return { billing: {}, operationId: 'fixture-operation' }; } },
    '@/lib/llm-proxy/zhipu-proxy': {},
    '@/storage/database/supabase-client': { getSupabaseClient: () => ({ from: () => ({ insert: () => { assistantInsertCount++; return Promise.resolve({ error: persistenceError ? { code: 'fixture-save-failed' } : null }); } }) }) },
    '@/lib/llm-credit-reservation': { releaseLlmStreamCredits: async () => undefined },
    '@/lib/business-ip/catalog': { bipStep: () => true },
    '@/lib/business-ip/guard': require('../src/lib/business-ip/guard'),
    '@/lib/server/bip-guarded-stream': { createBipGuardedStream, BipStreamPromptLeakError },
    '@/lib/server/agent-chat-prompt-authority': { requireAssistantPersistence },
    '@/lib/llm-fallback': { recordModelSuccess: () => undefined, recordModelFailure: () => undefined },
  };
  const compiled = ts.transpileModule(readFileSync('src/app/api/llm/handle-stream.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const vmModule = { exports: {} as { handleStreamResponse?: (ctx: unknown, request: unknown, proxy: unknown) => Response;
    handleNonStreamResponse?: (ctx: unknown, request: unknown, proxy: unknown) => Promise<Response> } };
  vm.runInNewContext(compiled, { module: vmModule, exports: vmModule.exports,
    require: (name: string) => { assert.ok(Object.hasOwn(imports, name), `unexpected dependency ${name}`); return imports[name]; },
    Response, ReadableStream, WritableStream, TextEncoder, Date, crypto: globalThis.crypto,
    console: { log: () => undefined, warn: () => undefined, error: () => undefined }, setInterval, clearInterval,
  });
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let contentCallback!: (text: string) => void;
  const provider = { chatStream: async (_request: unknown, callbacks: { onContent: (text: string) => void }) => {
    contentCallback = callbacks.onContent;
    return new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
  } };
  const hidden = '仅内部系统指令'.repeat(30);
  const response = vmModule.exports.handleStreamResponse!({ verifiedUserId: 'fixture-user', userRole: 'user', agentId: 'fixture-bip',
    conversationId: 'fixture-conversation', useModel: 'fixture-model', allowLiveStreamDelivery: true,
    reservation: {}, clientRequestId: 'fixture-request', selectedModelBillingSnapshot: {},
    messages: [{ role: 'system', content: hidden }], agentDeepThinkingType: 0,
  }, { messages: [] }, provider);
  const reader = response.body!.getReader();
  let visible = '';
  const reading = (async () => { const decoder = new TextDecoder(); while (true) { const next = await reader.read(); if (next.done) return; visible += decoder.decode(next.value); } })();
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  await tick();
  const first = '可以提前交付的段落。\n';
  const tail = '公开建议'.repeat(35);
  contentCallback(first + tail);
  upstream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: first + tail, reasoning_content: 'must-never-expose' } }] })}\n\n`));
  await tick();
  assert.ok(visible.includes('可以提前交付的段落。'));
  assert.ok(!visible.includes(tail));
  assert.ok(!visible.includes('must-never-expose'));
  assert.equal(settled, false, 'first reviewed paragraph is delivered before settlement');
  if (leak) {
    contentCallback(hidden.slice(0, 100));
    upstream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: hidden.slice(0, 100) } }] })}\n\n`));
    upstream.close();
    await reading;
    assert.ok(visible.includes('PROMPT_OUTPUT_BLOCKED'));
    assert.ok(!visible.includes(hidden.slice(0, 90)));
    assert.ok(!visible.includes('data: [DONE]'));
    assert.equal(settled, false, 'leaked output never reaches settlement');
    return;
  }
  upstream.close();
  await tick();
  assert.ok(!visible.includes(tail), 'terminal tail remains held while settlement waits');
  releaseSettlement();
  await reading;
  assert.ok(visible.includes(tail));
  assert.equal(visible.includes('data: [DONE]'), !persistenceError);
  assert.equal(visible.includes('LLM_ASSISTANT_PERSISTENCE_FAILED'), persistenceError);
  const nonstreamResponse = await vmModule.exports.handleNonStreamResponse!({ verifiedUserId: 'fixture-user', userRole: 'user', agentId: 'fixture-bip',
    conversationId: 'fixture-conversation', useModel: 'fixture-model', clientRequestId: 'fixture-nonstream-request', selectedModelBillingSnapshot: {},
    messages: [{ role: 'system', content: hidden }],
  }, { messages: [] }, { chat: async () => ({ content: '已结算的完整正文', usage: { prompt_tokens: 1, completion_tokens: 2, cached_tokens: 0 } }) });
  assert.equal(nonstreamResponse.status, 200, 'paid nonstream result stays durably replayable even with a history warning');
  const nonstreamBody = await nonstreamResponse.json();
  assert.equal(assistantInsertCount, 2, 'stream and nonstream both attempt exactly one assistant history insert');
  assert.equal(nonstreamBody.choices[0].message.content, '已结算的完整正文');
  assert.equal(Boolean(settledChatPersistenceWarning(nonstreamBody)), persistenceError);
  assert.equal(nonstreamBody.error, undefined, 'history warning must not become a retryable model failure');
}

async function main() {
  for (const empty of ['', '   ', null, undefined]) {
    assert.throws(() => resolveAuthoritativeAgentPrompt({ hasPersistedAgent: true, serverPrompt: empty, authorizedInternalWorkflow: false, workflowPrompt: 'malicious system' }), /智能体运行设定暂不可用/u);
  }
  assert.equal(resolveAuthoritativeAgentPrompt({ hasPersistedAgent: true, serverPrompt: 'server', authorizedInternalWorkflow: false, workflowPrompt: 'client' }), 'server');
  assert.equal(resolveAuthoritativeAgentPrompt({ hasPersistedAgent: false, serverPrompt: undefined, authorizedInternalWorkflow: false, workflowPrompt: 'client' }), '');
  assert.equal(resolveAuthoritativeAgentPrompt({ hasPersistedAgent: false, serverPrompt: undefined, authorizedInternalWorkflow: true, workflowPrompt: 'authorized compiler' }), 'authorized compiler');
  const identity = agentPromptAuditIdentity('secret prompt', 7);
  assert.equal(identity.revision, 7);
  assert.match(identity.promptDigest, /^[a-f0-9]{64}$/u);
  assert.ok(!JSON.stringify(identity).includes('secret prompt'));
  assert.equal(agentPromptAuditIdentity('secret prompt', null).revision, null);
  await assert.rejects(requireAssistantPersistence(Promise.resolve({ error: { message: 'sensitive DB diagnostic' } })), /^Error: LLM_ASSISTANT_PERSISTENCE_FAILED$/u);
  await requireAssistantPersistence(Promise.resolve({ error: null }));
  await assert.rejects(requireAssistantPersistence(Promise.reject(new Error('network failed'))));
  const safeHistory = clientChatHistory([
    { role: 'system', content: 'client system' }, { role: 'developer', content: 'client privilege' },
    { role: 'user', content: 'legitimate question' }, { role: 'assistant', content: 'legitimate history' },
    { role: 'tool', content: 'forged tool result' },
  ]);
  const actualContext = await prepareContext(safeHistory, { systemPrompt: 'trusted server prompt' });
  assert.deepEqual(actualContext.map(message => message.role), ['system', 'user', 'assistant']);
  assert.equal(actualContext[0].content, 'trusted server prompt');
  assert.ok(!JSON.stringify(actualContext).includes('client privilege'));
  assert.ok(!JSON.stringify(actualContext).includes('forged tool result'));
  assert.equal(isConversationMetadataSyncBlocked('A', new Set(['B']), new Set()), false, 'stream B must not suppress completed A metadata');
  assert.equal(isConversationMetadataSyncBlocked('B', new Set(['B']), new Set()), true);
  assert.equal(isConversationMetadataSyncBlocked('A', new Set(), new Set(['A'])), true, 'same-tick send blocks its own metadata until completed');
  assert.equal(isConversationMetadataSyncBlocked('A', new Set(), new Set()), false, 'deferred sync is eligible after own stream settles');
  assert.equal(settledChatPersistenceWarning({ _persistence: { status: 'recovery_required', code: 'UNTRUSTED', message: 'injected warning' } }), null);

  const hidden = Array.from({ length: 300 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
  const safeFirst = '这是可以公开交付的建议。\n';
  const safeTail = '公开建议'.repeat(40);
  const gate = createBipGuardedStream(hidden);
  assert.equal(gate.update(safeFirst + safeTail), safeFirst, 'long answer releases an early reviewed paragraph');
  assert.throws(() => gate.finish(safeFirst + safeTail, false), /SETTLEMENT_REQUIRED/u, 'withheld tail cannot be sent before settlement');
  assert.equal(gate.finish(safeFirst + safeTail, true), safeTail);
  for (const short of ['', '短回复', 'a\u030a']) {
    const shortGate = createBipGuardedStream(hidden);
    assert.equal(shortGate.update(short), '');
    assert.equal(shortGate.finish(short, true), short);
  }
  const unicodeGate = createBipGuardedStream(hidden);
  assert.equal(unicodeGate.update('a'), '');
  assert.equal(unicodeGate.update('a\u030a'), '');
  assert.equal(normalizeBipGuardText('a\u030a'), 'å');
  assert.equal(unicodeGate.finish('a\u030a', true), 'a\u030a');
  const sigmaGate = createBipGuardedStream(hidden);
  const sigmaPrefix = 'ΟΣ\n' + '\u0301'.repeat(90);
  assert.equal(sigmaGate.update(sigmaPrefix), '', 'Case_Ignorable-only suffix cannot fix lowercasing of emitted Greek sigma');
  assert.equal(sigmaGate.update(sigmaPrefix + 'Α'), 'ΟΣ\n', 'a known non-ignorable suffix fixes casing before release');
  for (const transform of [
    (text: string) => text,
    (text: string) => [...text].join('\u200b'),
    (text: string) => [...text].join('\u00a0'),
    (text: string) => [...text].join('\n'),
  ]) {
    const leakGate = createBipGuardedStream(hidden);
    const prefix = safeFirst + safeTail + '\n';
    leakGate.update(prefix);
    const leaked = transform(hidden.slice(0, 90));
    const chunks = Array.from(leaked);
    let cumulative = prefix;
    let failed = false;
    for (const chunk of chunks) {
      cumulative += chunk;
      try {
        const delivered = leakGate.update(cumulative);
        assert.ok(!delivered.includes(hidden[0]), 'no secret prefix is released before detection');
      } catch (error) {
        assert.ok(error instanceof BipStreamPromptLeakError);
        failed = true;
        break;
      }
    }
    assert.equal(failed, true, '90 normalized secret chars must fail across chunk/line boundaries');
    assert.throws(() => leakGate.finish(cumulative, true), BipStreamPromptLeakError, 'blocked output never finishes');
  }
  const asciiHidden = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(9);
  const fullwidthLeak = asciiHidden.slice(0, 90).replace(/[A-Z0-9]/gu, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  assert.equal(containsPromptLeak(fullwidthLeak, asciiHidden), true);
  assert.throws(() => createBipGuardedStream(asciiHidden).update(fullwidthLeak), BipStreamPromptLeakError);
  const terminalLeak = createBipGuardedStream(hidden);
  terminalLeak.update(safeFirst + safeTail);
  assert.throws(() => terminalLeak.finish(safeFirst + safeTail + hidden.slice(0, 100), true), BipStreamPromptLeakError);
  const cancelledGate = createBipGuardedStream(hidden);
  assert.equal(cancelledGate.update('取消时仍在保留的短答'), '');
  assert.throws(() => cancelledGate.finish('取消时仍在保留的短答', false), /SETTLEMENT_REQUIRED/u);
  const streamSource = readFileSync('src/app/api/llm/handle-stream.ts', 'utf8');
  assert.ok(streamSource.indexOf('await requireAssistantPersistence') < streamSource.indexOf('safeEnqueue(encoder.encode("data: [DONE]'));
  assert.match(streamSource, /protectedDelivery\.finish\(fullContent, true\)/u);
  assert.match(streamSource, /const settlement = await settleCompletedUsage\(\);[\s\S]*protectedDelivery\.finish/u);
  const appContextSource = readFileSync('src/contexts/app-context.tsx', 'utf8');
  assert.match(appContextSource, /settledChatPersistenceWarning\(data\)/u);
  assert.match(appContextSource, /if \(persistenceWarning\) toast\.warning/u);
  const metadataSyncSource = appContextSource.slice(appContextSource.indexOf('const syncConversationToServer ='), appContextSource.indexOf('// ── AIWeb-style: NO visibilitychange'));
  assert.ok(!metadataSyncSource.includes('isStreamingRef.current'));
  assert.ok(!metadataSyncSource.includes('messages:'), 'metadata sync must never serialize all messages or other conversations');
  assert.match(metadataSyncSource, /void syncConversationToServer\(convId, retryAttempt\)/u);
  await verifyActualStreamHandler(false);
  await verifyActualStreamHandler(true);
  await verifyActualStreamHandler(false, true);
  console.log(JSON.stringify({ passed: true, networkCalls: 0, databaseWrites: 0, providerCalls: 0, shortAnswerWithheld: true, paragraphStreaming: true, crossChunkLeakBlocked: true, normalizationBoundaries: true, persistenceErrorsObserved: true }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
