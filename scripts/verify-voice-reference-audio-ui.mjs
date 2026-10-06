import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [header, layout, css, workspace, imitate, voices, selector] = await Promise.all([
  fs.readFile('src/components/vs/Header.tsx', 'utf8'),
  fs.readFile('src/app/voice-studio/layout.tsx', 'utf8'),
  fs.readFile('src/app/voice-studio/voice-studio.css', 'utf8'),
  fs.readFile('src/app/voice-studio/workspace/page.tsx', 'utf8'),
  fs.readFile('src/app/voice-studio/imitate/page.tsx', 'utf8'),
  fs.readFile('src/app/voice-studio/voices/page.tsx', 'utf8'),
  fs.readFile('src/components/vs/ReferenceAudioSelector.tsx', 'utf8'),
]);

for (const label of ['语音合成', '音色模仿', '音色管理']) assert.match(header, new RegExp(`label: '${label}'`, 'u'));
assert.doesNotMatch(header, /mobileOpen|mobile-menu|mobile-toggle/u);
assert.match(header, /aria-current/u);
assert.doesNotMatch(layout, /GlobalTaskBar/u);
for (const contract of ['--vs-header-bg', '--vs-control-bg', '.vs-page-container', '.vs-page-title', '.vs-studio-footer', 'prefers-reduced-motion']) assert.ok(css.includes(contract), `theme CSS missing ${contract}`);
assert.match(css, /width: min\(var\(--vs-shell-width\), calc\(100vw - 48px\)\)/u);
assert.match(workspace, /className="vs-page-container"/u);
assert.match(imitate, /className="vs-page-container"/u);
assert.match(voices, /className="vs-page-container"/u);
assert.match(selector, /<AudioPlayer audioUrl=\{pendingAudio\.voice\.url\}/u);
assert.match(selector, /REFERENCE_AUDIO_DURATION_OPTIONS/u);

console.log(JSON.stringify({ verifier: 'voice-reference-audio-ui', passed: true, mode: 'source-only-desktop-contract', providerCalls: 0, paidRequests: 0, databaseMutations: 0 }, null, 2));
