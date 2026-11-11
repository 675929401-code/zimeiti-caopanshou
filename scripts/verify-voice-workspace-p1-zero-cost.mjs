#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const containsAll = (source, snippets, label) => {
  for (const snippet of snippets) assert.ok(source.includes(snippet), `${label} missing: ${snippet}`);
};

const layout = read('src/app/voice-studio/layout.tsx');
const css = read('src/app/voice-studio/voice-studio.css');
const workspace = read('src/app/voice-studio/workspace/page.tsx');
const imitate = read('src/app/voice-studio/imitate/page.tsx');
const voices = read('src/app/voice-studio/voices/page.tsx');
const history = read('src/components/vs/VoiceGenerationHistory.tsx');
const extraction = read('src/lib/vs/reference-audio-extraction.ts');
const extractionGate = read('src/components/vs/ReferenceAudioExtractionGate.tsx');
const ttsRoute = read('src/app/api/voice/tts/route.ts');
const imitationQuoteRoute = read('src/app/api/voice/imitation-quote/route.ts');
const voiceListRoute = read('src/app/api/voice/list/route.ts');
const extractionRoute = read('src/app/api/voice/link-clone/extract-audio/route.ts');

containsAll(layout, ['voice-studio-root vs-studio-shell', 'vs-studio-main'], 'voice shell');
containsAll(css, [
  '.voice-studio-root.vs-studio-shell',
  'height: 100dvh;',
  'overflow-y: auto;',
  'overscroll-behavior-y: contain;',
  '.voice-studio-root .vs-page-container',
  'padding-top: 20px;',
], 'desktop scroll ownership');

containsAll(workspace, [
  'data-voice-workspace="synthesis"',
  'data-voice-workspace-intro',
  'className="vs-history-flyout"',
  'data-voice-editor',
  'vs-text-input-card',
  'vs-text-input-control flex-1 w-full',
  'data-voice-output-region',
  'className="vs-compose-panel"',
  'aria-describedby="voice-synthesis-fee"',
  '{result && (',
  'data-voice-output-card="ready"',
], 'workspace composition');
assert.ok(!workspace.includes('第3行左：空白占位'), 'workspace still carries a meaningless empty grid placeholder');
assert.ok(workspace.indexOf('{result && (') < workspace.indexOf('data-voice-output-card="ready"'), 'result card is not guarded by the durable result state');
containsAll(css, [
  '.voice-studio-root .vs-history-flyout',
  'width: 44px;',
  '.voice-studio-root .vs-history-flyout:has(button[aria-expanded="true"])',
  '.voice-studio-root .vs-text-input-card',
  '.voice-studio-root .vs-output-card',
], 'compact history and editor styling');
containsAll(history, ['aria-expanded={open}', 'aria-controls="voice-generation-history-content"'], 'history disclosure');

for (const selector of [
  'html[data-theme="lattice"][data-mode="dark"] .voice-studio-root',
  'html[data-theme="soft-white"][data-mode="light"] .voice-studio-root',
  'html[data-theme="crystal-aurora"][data-mode="dark"] .voice-studio-root',
]) assert.ok(css.includes(selector), `missing theme scope: ${selector}`);

containsAll(workspace, [
  "fetch('/api/voice/tts'",
  "method: 'POST'",
  "'Idempotency-Key': attempt.clientRequestId",
  "operation: 'quote'",
  "submitVoiceRequest('single'",
  "submitVoiceRequest('dual'",
  "submitVoiceRequest('long-text'",
  "submitVoiceRequest('mix'",
  "submitVoiceRequest('seed-audio'",
  "mode === 'single' ? handleSynthesize",
  'disabled={synthesizing || !quoteReady',
], 'TTS and explicit button dispatch');
const selectionHandlers = workspace.slice(
  workspace.indexOf('const handleSynthesisModelChange'),
  workspace.indexOf('// -------- 主渲染 --------'),
);
assert.ok(selectionHandlers.length > 0, 'model selection handlers missing');
assert.ok(!selectionHandlers.includes('fetch('), 'model or mode selection must not submit a request');
assert.ok(!selectionHandlers.includes('submitVoiceRequest('), 'model or mode selection must not trigger generation');

containsAll(imitate, [
  "fetch('/api/voice/imitation-quote'",
  "fetch('/api/voice/status?provider=volcano'",
  "fetch('/api/voice/tts'",
  "'Idempotency-Key': attempt.clientRequestId",
  'if (ref.assetId) return { assetId: ref.assetId }',
  'disabled={providerStatus !== \'available\'',
], 'voice imitation chain');
containsAll(voices, [
  "fetch('/api/voice/list?page=1&limit=500'",
  'router.push(`/voice-studio/workspace?speaker=${encodeURIComponent(voice.speakerId)}&preload=true`)',
  'aria-pressed={isActive}',
], 'voice library chain');
containsAll(extractionGate, ['useToolRuntimeCatalog(token)', 'quote?.available', '取消不会提交请求或产生扣费'], 'extraction readiness gate');
containsAll(extraction, [
  "fetch('/api/extract'",
  "'Idempotency-Key': attempt.clientRequestId",
  "fetch('/api/voice/link-clone/extract-audio'",
  'temporaryVideoUrl: video.temporary_url',
  'assetId: String(voice.id)',
], 'two-stage audio extraction');

for (const [label, routeSource] of [
  ['TTS route', ttsRoute],
  ['imitation quote route', imitationQuoteRoute],
  ['voice list route', voiceListRoute],
  ['audio extraction route', extractionRoute],
]) assert.match(routeSource, /export async function (?:GET|POST)/u, `${label} is not callable`);
containsAll(ttsRoute, ['withAuth(req', 'rejectUnauthorizedSpeakers', 'clientRequestId'], 'TTS server authorization and durability');
containsAll(extractionRoute, ['withAuth(req', 'verifyExtractTemporaryVideoSignature'], 'audio extraction ownership');

console.log(JSON.stringify({
  verifier: 'voice-workspace-p1-zero-cost',
  passed: true,
  checks: {
    desktopScroll: true,
    compactHistory: true,
    fullTrackTextInput: true,
    conditionalOutputCard: true,
    themes: ['lattice', 'crystal-aurora', 'soft-white'],
    chains: ['tts', 'voice-imitation', 'voice-library', 'reference-audio-extraction', 'explicit-submit-buttons'],
  },
  providerCalls: 0,
  paidRequests: 0,
  databaseMutations: 0,
  networkRequests: 0,
}, null, 2));
