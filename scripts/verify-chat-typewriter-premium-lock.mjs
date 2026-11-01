import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const appContext = read("src/contexts/app-context.tsx");
const messageContent = read("src/components/chat/message-content.tsx");
const globals = read("src/app/globals.css");
const markdown = read("src/app/markdown-body.css");

const numericConstant = (source, name) => {
  const match = source.match(new RegExp(`const ${name} = (\\d+);`, "u"));
  assert.ok(match, `${name}_MISSING`);
  return Number(match[1]);
};

const minStep = numericConstant(appContext, "TYPEWRITER_MIN_STEP");
const maxStep = numericConstant(appContext, "TYPEWRITER_MAX_STEP");

const settleFrameBudgetMs = numericConstant(appContext, "TYPEWRITER_SETTLE_FRAME_BUDGET_MS");
const settleSafetyFrames = numericConstant(appContext, "TYPEWRITER_SETTLE_SAFETY_FRAMES");
const settleMinWaitMs = numericConstant(appContext, "TYPEWRITER_SETTLE_MIN_WAIT_MS");
const settleMaxWaitMs = numericConstant(appContext, "TYPEWRITER_SETTLE_MAX_WAIT_MS");
const morphInterval = numericConstant(messageContent, "STREAM_MORPH_INTERVAL_MS");

assert.ok(minStep >= 1 && minStep <= 3, `TYPEWRITER_MIN_STEP_NOT_VISIBLE:${minStep}`);
assert.ok(maxStep >= 32 && maxStep <= 64, `TYPEWRITER_MAX_STEP_MUST_STAY_PROGRESSIVE:${maxStep}`);
assert.ok(settleFrameBudgetMs >= 32 && settleFrameBudgetMs <= 50, `TYPEWRITER_SETTLE_FRAME_BUDGET_UNSAFE:${settleFrameBudgetMs}`);
assert.ok(settleSafetyFrames >= 4 && settleSafetyFrames <= 10, `TYPEWRITER_SETTLE_SAFETY_MARGIN_UNSAFE:${settleSafetyFrames}`);
assert.ok(settleMinWaitMs >= 500 && settleMinWaitMs <= 1_500, `TYPEWRITER_SETTLE_MIN_WAIT_UNSAFE:${settleMinWaitMs}`);
assert.ok(settleMaxWaitMs >= 10_000 && settleMaxWaitMs <= 20_000, `TYPEWRITER_SETTLE_MAX_WAIT_UNSAFE:${settleMaxWaitMs}`);
assert.ok(morphInterval <= 16, `STREAM_MORPH_INTERVAL_TOO_SLOW:${morphInterval}`);

assert.match(appContext, /requestAnimationFrame\(flushStreamingUpdate\)/u, "TYPEWRITER_MUST_USE_RAF");
assert.doesNotMatch(appContext, /setInterval\([^)]*typewriter/iu, "TYPEWRITER_MUST_NOT_USE_INTERVAL");
assert.match(appContext, /safeTypewriterBoundary/u, "UNICODE_GLYPH_BOUNDARY_GUARD_MISSING");
assert.match(appContext, /first === "\\u200d"/u, "ZWJ_SEQUENCE_GUARD_MISSING");
assert.match(appContext, /remaining -= typewriterStep\(remaining\)/u, "SETTLE_WAIT_MUST_USE_REAL_CADENCE");
assert.match(appContext, /setTimeout\(\(\) => \{[\s\S]{0,220}?finish\("settle-timeout"\);[\s\S]{0,80}?\}, settleWaitMs\);/u, "SETTLE_TIMEOUT_MUST_USE_DYNAMIC_BUDGET");
assert.doesNotMatch(appContext, /maxWaitMs = 2_000/u, "FIXED_TWO_SECOND_SETTLE_TIMEOUT_MUST_BE_REMOVED");
assert.match(messageContent, /useLayoutEffect[\s\S]*?morphdom\(/u, "PRE_PAINT_MORPHDOM_GUARD_MISSING");
assert.match(messageContent, /appendStreamingCaret/u, "STREAMING_CARET_INJECTION_MISSING");
assert.match(messageContent, /id="\$\{caretId\}" class="streaming-typewriter-caret" aria-hidden="true"/u, "KEYED_ACCESSIBLE_CARET_MISSING");
assert.match(globals, /\.render-layer-streaming-typewriter \.streaming-typewriter-caret/u, "CARET_STYLE_MISSING");
assert.match(globals, /\.render-layer-streaming-typewriter \.streaming-typewriter-caret[\s\S]{0,700}?opacity: \.88;[\s\S]{0,120}?animation: none;/u, "CARET_MUST_STAY_STEADY");
assert.doesNotMatch(globals, /@keyframes assistant-typewriter-caret/u, "CARET_MUST_NOT_BLINK");
assert.doesNotMatch(globals, /@keyframes assistant-stream-rail/u, "STREAM_RAIL_MUST_NOT_MOVE");
assert.match(globals, /\.render-layer-final\s*\{[\s\S]{0,160}?animation: none;[\s\S]{0,160}?opacity: 1;/u, "FINAL_LAYER_MUST_NOT_FADE");
assert.doesNotMatch(globals, /@keyframes render-fade-in/u, "FINAL_LAYER_FADE_MUST_BE_REMOVED");
assert.match(markdown, /\.markdown-body-generate > \.render-layer-streaming > \*\s*\{[\s\S]{0,260}?opacity: 1 !important;[\s\S]{0,120}?filter: none !important;/u, "STREAMED_GLYPHS_MUST_STAY_OPAQUE");
assert.match(markdown, /> :last-child::after\s*\{\s*content: none !important;/u, "PSEUDO_CARET_MUST_BE_DISABLED");
assert.doesNotMatch(markdown, /streaming-text-fade-in-fast|streaming-cursor-blink/u, "LEGACY_STREAM_FLASH_MUST_BE_REMOVED");
assert.match(globals, /prefers-reduced-motion:[\s\S]*?streaming-typewriter-caret[\s\S]*?animation: none/u, "CARET_REDUCED_MOTION_GUARD_MISSING");
const thinkingIndicator = messageContent.slice(
  messageContent.indexOf("function ThinkingIndicator"),
  messageContent.indexOf("/** Streaming content wrapper"),
);
assert.match(thinkingIndicator, /data-testid="chat-first-token-indicator"/u, "FIRST_TOKEN_INDICATOR_MISSING");
assert.doesNotMatch(thinkingIndicator, /Avatar|agentName|agentIconUrl/u, "FIRST_TOKEN_INDICATOR_MUST_NOT_DUPLICATE_IDENTITY");


// Execute the actual TS helpers and queue callbacks with a controlled RAF clock.
// This catches scheduling/prefix/terminal bugs that a copied formula cannot.
const helpers = appContext.slice(appContext.indexOf('const TYPEWRITER_MIN_STEP'), appContext.indexOf('type ChatStreamLifecyclePhase'));
const scheduler = appContext.slice(appContext.indexOf('  const streamingRafRef ='), appContext.indexOf('  // ── 生图意图交接'));
const stopCallback = appContext.slice(appContext.indexOf('  const abortCurrentStream ='), appContext.indexOf('  // ---- LLM (OpenAI-compatible) message sending ----'));
assert.equal([...appContext.matchAll(/await settleTypewriterUpdate\([^\n]+, controller\.signal\);/gu)].length, 3, 'ALL_THREE_STREAM_CALLERS_MUST_PASS_SIGNAL');
function harness() {
  let now = 0, id = 0;
  const raf = new Map(), timers = new Map(), paints = [], actions = [];
  const controllers = new Map();
  const state = { conversations: [], isStreaming: true };
  const context = vm.createContext({
    Intl, console, performance: { now: () => now },
    useRef: current => ({ current }), useCallback: callback => callback, useEffect: () => {},
    knownChatFailureMessage: () => null,
    abortControllerMap: { current: controllers }, userAbortedSet: { current: new Set() }, watchdogAbortedSet: { current: new Set() }, state,
    dispatch: action => { actions.push(action); if (action.type === 'UPDATE_MESSAGE') paints.push({ ...action.payload, at: now }); },
    requestAnimationFrame: callback => { raf.set(++id, callback); return id; },
    cancelAnimationFrame: handle => raf.delete(handle),
    setTimeout: (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; },
    clearTimeout: handle => timers.delete(handle),
  });
  const code = ts.transpileModule(helpers + scheduler + stopCallback + '\n globalThis.api = { throttledDispatchUpdate, settleTypewriterUpdate, resetTypewriterState, takeTypewriterSlice, estimateTypewriterDrainWaitMs, abortCurrentStream, queueSizes: () => [typewriterEntriesRef.current.size, typewriterDrainResolversRef.current.size, typewriterDisplayedRef.current.size] };', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInContext(code, context);
  const frame = () => { now += 1000 / 60; const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(callback => callback(now)); };
  const drain = () => { let frames = 0; while (raf.size && frames < 2000) { frame(); frames++; } assert.equal(raf.size, 0); return frames; };
  return { api: context.api, paints, actions, controllers, state, raf, timers, frame, drain, advanceTimeout: () => { for (const timer of [...timers.values()]) timer.callback(); } };
}
function trackedController() {
  const controller = new AbortController(), listeners = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, callback, options) => { if (type === 'abort') listeners.add(callback); add(type, callback, options); };
  controller.signal.removeEventListener = (type, callback, options) => { if (type === 'abort') listeners.delete(callback); remove(type, callback, options); };
  return { controller, listeners };
}
const payload = (content, messageId = 'a') => ({ conversationId: 'conv', messageId, content });
const sample = length => {
  const h = harness(), text = '中'.repeat(length);
  h.api.throttledDispatchUpdate(payload(text));
  assert.equal(h.paints[0].content, '中', 'IMMEDIATE_FIRST_GLYPH');
  const frames = h.drain();
  assert.equal(h.paints.at(-1).content, text);
  for (let i = 1; i < h.paints.length; i++) assert.ok(h.paints[i].content.startsWith(h.paints[i-1].content));
  const deadline = h.api.estimateTypewriterDrainWaitMs('中', text, '', '');
  assert.ok(frames * 1000 / 60 < deadline, 'NORMAL_QUEUE_MUST_DRAIN_BEFORE_FALLBACK');
  return { frames, durationMs: Math.round(frames * 1000 / 60), deadline };
};
const samples = Object.fromEntries([12, 40, 240, 960, 12000].map(length => [length, sample(length)]));
assert.ok(samples[40].frames >= 13 && samples[40].frames <= 21, 'ORDINARY_CJK_MUST_ADVANCE_TWO_TO_THREE_GLYPHS_PER_FRAME');
assert.ok(samples[240].durationMs > 100 && samples[240].durationMs <= 1500, 'COARSE_CHUNK_MUST_STAY_PROGRESSIVE_WITHOUT_A_SLOW_TAIL');
assert.ok(samples[12000].durationMs < 12000, 'LARGE_BACKLOG_MUST_HAVE_BOUNDED_TAIL');
const h = harness();
for (const text of ['中文🇨🇳👍🏽👩‍👩‍👧‍👦e\u0301क्ष', '😀中文']) {
  let current = '';
  const boundaries = new Set([0, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.index + part.segment.length)]);
  while (current !== text) { current = h.api.takeTypewriterSlice(current, text); assert.ok(boundaries.has(current.length), 'GRAPHEME_MUST_STAY_INTACT'); }
}
assert.equal(h.api.takeTypewriterSlice('旧稿', '更正'), '更正', 'NON_PREFIX_CORRECTION_ATOMIC');
const reasoning = harness();
reasoning.api.throttledDispatchUpdate({ ...payload('正文'.repeat(30)), reasoningContent: '推理'.repeat(50) });
assert.equal(reasoning.paints[0].content, '正'); assert.equal(reasoning.paints[0].reasoningContent, '推理'.repeat(50), 'RECEIVED_REASONING_MUST_NOT_DRAIN_ONE_GLYPH_AT_A_TIME');
reasoning.drain(); assert.equal(reasoning.paints.at(-1).reasoningContent, '推理'.repeat(50));
const reasoningOnly = harness();
reasoningOnly.api.throttledDispatchUpdate({ ...payload(''), reasoningContent: '收到的思考'.repeat(1000) });
assert.equal(reasoningOnly.paints[0].reasoningContent, '收到的思考'.repeat(1000));
assert.equal(reasoningOnly.raf.size, 0, 'REASONING_ONLY_MUST_NOT_LEAVE_AN_ANIMATION_BACKLOG');
assert.equal(reasoningOnly.api.estimateTypewriterDrainWaitMs('', '', '', '思考'.repeat(1000)), 0, 'REASONING_MUST_NOT_EXTEND_BODY_DRAIN_BUDGET');
reasoningOnly.api.throttledDispatchUpdate({ ...payload('正文开始'), reasoningContent: '收到的思考'.repeat(1000) });
assert.equal(reasoningOnly.paints.at(-1).content, '正', 'FIRST_BODY_GLYPH_AFTER_REASONING_MUST_PAINT_IMMEDIATELY');
assert.equal(reasoningOnly.raf.size, 1, 'FIRST_BODY_AFTER_REASONING_MUST_KEEP_ONE_RAF');
reasoningOnly.drain();
// Slow chunks keep their prefix and never restart a painted answer.
h.api.throttledDispatchUpdate(payload('中文')); h.drain();
h.api.throttledDispatchUpdate(payload('中文逐字')); h.frame();
assert.equal(h.paints.at(-1).content, '中文逐字'); h.drain();
// Concurrent streams own distinct queues; resetting one cannot cancel another.
h.api.throttledDispatchUpdate(payload('甲'.repeat(100), 'a'));
h.api.throttledDispatchUpdate(payload('乙'.repeat(100), 'b')); h.frame();
assert.ok(h.paints.some(paint => paint.messageId === 'b' && paint.content.startsWith('乙')));
h.api.resetTypewriterState(payload('', 'a')); const before = h.paints.filter(paint => paint.messageId === 'a').length;
h.drain(); assert.equal(h.paints.filter(paint => paint.messageId === 'a').length, before);
assert.equal(h.paints.at(-1).content, '乙'.repeat(100));
const coalesced = harness(); coalesced.api.throttledDispatchUpdate(payload('中'.repeat(240)));
coalesced.api.throttledDispatchUpdate(payload('中'.repeat(480)));
coalesced.api.throttledDispatchUpdate(payload('中'.repeat(960)));
assert.equal(coalesced.raf.size, 1, 'NEW_TARGETS_MUST_NOT_FORK_RAF_LOOPS');
coalesced.drain(); assert.equal(coalesced.paints.at(-1).content.length, 960);
// Terminal completion drains normally without falling back to a whole-block jump.
const terminal = harness(), terminalSignal = trackedController(); terminal.api.throttledDispatchUpdate(payload('中'.repeat(240)));
const done = terminal.api.settleTypewriterUpdate(payload('中'.repeat(240)), terminalSignal.controller.signal); terminal.drain(); await done;
assert.equal(terminal.timers.size, 0); assert.equal(terminal.paints.at(-1).content.length, 240); assert.equal(terminalSignal.listeners.size, 0);
// Background/suspended RAF has an explicit finite fallback and cleans handles.
const hidden = harness(), hiddenSignal = trackedController(); hidden.api.throttledDispatchUpdate(payload('中'.repeat(240)));
const hiddenDone = hidden.api.settleTypewriterUpdate(payload('中'.repeat(240)), hiddenSignal.controller.signal); hidden.advanceTimeout(); await hiddenDone;
assert.equal(hidden.raf.size, 0); assert.equal(hidden.paints.at(-1).content.length, 240); assert.equal(hiddenSignal.listeners.size, 0);
const cancelled = harness(), cancelledSignal = trackedController(); cancelled.api.throttledDispatchUpdate(payload('中'.repeat(240)));
const cancelDone = cancelled.api.settleTypewriterUpdate(payload('中'.repeat(240)), cancelledSignal.controller.signal); cancelled.api.resetTypewriterState(payload('')); await cancelDone;
assert.equal(cancelled.raf.size, 0); assert.equal(cancelled.timers.size, 0); assert.equal(cancelledSignal.listeners.size, 0);
// Execute the product Stop callback, not just the private queue reset helper.
const stopCases = [];
for (const { stopAll, paintFrame } of [{ stopAll: false, paintFrame: true }, { stopAll: true, paintFrame: true }, { stopAll: false, paintFrame: false }, { stopAll: true, paintFrame: false }]) {
  const stopped = harness(), first = trackedController(), second = trackedController();
  stopped.controllers.set('one', first.controller); stopped.controllers.set('two', second.controller);
  stopped.state.conversations.push(...['one', 'two'].map(id => ({ id, messages: [{ id: 'a', isStreaming: true }] })));
  const one = { ...payload('甲'.repeat(240)), conversationId: 'one' };
  const two = { ...payload('乙'.repeat(240)), conversationId: 'two' };
  stopped.api.throttledDispatchUpdate(one); stopped.api.throttledDispatchUpdate(two);
  let oneResolved = false, twoResolved = false;
  const oneDone = stopped.api.settleTypewriterUpdate(one, first.controller.signal).then(() => { oneResolved = true; });
  const twoDone = stopped.api.settleTypewriterUpdate(two, second.controller.signal).then(() => { twoResolved = true; });
  if (paintFrame) stopped.frame();
  const preStopPaints = stopped.paints.length;
  stopped.api.abortCurrentStream(stopAll ? undefined : 'one');
  await oneDone;
  assert.ok(oneResolved); assert.equal(first.listeners.size, 0);
  const immediateStopPaints = stopped.paints.slice(preStopPaints);
  assert.equal(immediateStopPaints.length, stopAll ? 2 : 1, 'STOP_MAY_ONLY_PAINT_RECEIVED_FINAL_TEXT_ONCE_PER_STREAM');
  assert.ok(immediateStopPaints.every(paint => paint.content.length === 240));
  const onePaintCount = stopped.paints.filter(paint => paint.conversationId === 'one').length;
  const totalAfterStop = stopped.paints.length;
  if (stopAll) { await twoDone; assert.ok(twoResolved); assert.equal(stopped.raf.size, 0); }
  else { assert.equal(second.controller.signal.aborted, false); assert.equal(twoResolved, false); }
  stopped.drain(); await twoDone;
  assert.equal(stopped.paints.filter(paint => paint.conversationId === 'one').length, onePaintCount, 'NO_PROGRESSIVE_PAINT_AFTER_STOP');
  if (stopAll) assert.equal(stopped.paints.length, totalAfterStop);
  assert.equal(stopped.paints.at(-1).content.length, 240);
  assert.equal(stopped.timers.size, 0); assert.equal(second.listeners.size, 0);
  assert.deepEqual(Array.from(stopped.api.queueSizes()), [0, 0, 0]);
  stopCases.push({ stopAll, suspendedRaf: !paintFrame, immediateFinalPaints: immediateStopPaints.length, postAbortProgressivePaints: 0, listenersRemaining: first.listeners.size + second.listeners.size, queuesRemaining: Array.from(stopped.api.queueSizes()) });
}
const alreadyStopped = harness(), already = trackedController(); already.controller.abort();
alreadyStopped.api.throttledDispatchUpdate(payload('中'.repeat(240)));
await alreadyStopped.api.settleTypewriterUpdate(payload('中'.repeat(240)), already.controller.signal);
assert.equal(alreadyStopped.paints.at(-1).content.length, 240);
assert.equal(alreadyStopped.raf.size, 0); assert.equal(alreadyStopped.timers.size, 0); assert.equal(already.listeners.size, 0);
assert.deepEqual(Array.from(alreadyStopped.api.queueSizes()), [0, 0, 0]);
console.log(JSON.stringify({ status: 'PASS', contract: 'chat-typewriter-premium-lock', cadence: { minStep, maxStep, morphInterval }, samples, stopCases,
  guards: ['actual-source-raf-scheduler', 'immediate-first-glyph', 'ordinary-cjk-two-to-three-glyphs', 'coarse-chunk-perceptible', 'reasoning-without-animation-backlog', 'unicode-graphemes', 'slow-prefix', 'concurrent-reset', 'terminal-drain', 'background-fallback', 'cancel-cleanup', 'actual-stop-one', 'actual-stop-all', 'already-aborted-settle', 'abort-listener-cleanup', 'all-three-caller-signals'], paidCalls: 0, productionWrites: 0 }, null, 2));
