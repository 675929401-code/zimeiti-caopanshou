import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readLocalPreviewLaunchPlan, LOCAL_PREVIEW_DATA_ROOT } from './start-local-data-preview.mjs';

// Administrative local batch. Warm only fixed public samples; no private voice,
// wallet change or user text. Re-running reuses complete cached samples.
if (!process.argv.includes('--confirm-provider-cost')) throw new Error('Pass --confirm-provider-cost to authorize uncached provider synthesis');
const plan = await readLocalPreviewLaunchPlan(5002);
Object.assign(process.env, plan.env, { NODE_ENV: 'production', LOCAL_ACCEPTANCE_PREVIEW: 'true', VOICE_SQLITE_PATH: path.join(LOCAL_PREVIEW_DATA_ROOT, 'voice', 'voice.db'), APP_DATA_DIR: path.join(plan.cwd, 'data') });
const require = createRequire(import.meta.url);
require('tsx/cjs');
const { cachedVoicePreview, voicePreviewProviderIdentity } = require('../src/lib/server/voice-preview-cache.ts');
const { synthesizeConfiguredVoicePreview, resolvePreviewApiKey } = require('../src/lib/server/voice-preview-synthesis.ts');
const { OFFICIAL_VOICES } = require('../src/lib/vs/voices-data.ts');
const apiKey = await resolvePreviewApiKey();
if (!apiKey) throw new Error('The configured speech provider is unavailable');
const output = path.join(plan.cwd, '.codex-evidence', 'voice-server-cache-20260903');
await fs.mkdir(output, { recursive: true });
const text = '你好，我是智音工坊的语音助手，希望能为你提供专业的配音服务。';
const selected = process.argv.find(arg => arg.startsWith('--speaker='))?.slice(10);
const voices = OFFICIAL_VOICES.filter(v => (/^zh/iu.test(v.language) || v.speakerId.includes('_zh_')) && (!selected || v.speakerId === selected));
if (!voices.length) throw new Error('No matching public Chinese voices');
const report = [];
const ffmpeg = require('ffmpeg-static');
const ffprobe = path.join(plan.cwd, 'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe');
for (const voice of voices) {
  const started = Date.now();
  const file = path.join(output, voice.speakerId + '.mp3');
  try {
    const result = await cachedVoicePreview({ speakerId: voice.speakerId, text, ownerId: null, providerIdentity: voicePreviewProviderIdentity(apiKey, voice.resourceId) }, async () => {
      const audio = await synthesizeConfiguredVoicePreview(voice.speakerId, text, apiKey);
      await fs.writeFile(file, Buffer.from(audio.audioUrl.slice(audio.audioUrl.indexOf(',') + 1), 'base64'));
      // Validate the complete media before admitting it to the persistent cache.
      execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { windowsHide: true, timeout: 20000, stdio: 'pipe' });
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_format', '-of', 'json', file], { windowsHide: true, timeout: 15000, encoding: 'utf8' }));
      const duration = Number(probe.format?.duration);
      if (!(duration > 0)) throw new Error('The completed sample has no duration');
      return { ...audio, duration };
    });
    // Cached entries are verified again on disk so the report is inspectable.
    if (result.cacheHit) await fs.writeFile(file, Buffer.from(result.audio.audioUrl.slice(result.audio.audioUrl.indexOf(',') + 1), 'base64'));
    report.push({ speakerId: voice.speakerId, name: voice.name, cacheHit: result.cacheHit, duration: result.audio.duration, bytes: (await fs.stat(file)).size, elapsedMs: Date.now() - started, status: 'ready' });
    await fs.writeFile(path.join(output, 'warm-report.json'), JSON.stringify({ completed: false, items: report }, null, 2));
    console.log(JSON.stringify({ index: report.length, total: voices.length, speakerId: voice.speakerId, cacheHit: result.cacheHit, status: 'ready' }));
  } catch {
    report.push({ speakerId: voice.speakerId, name: voice.name, status: 'failed' });
    await fs.writeFile(path.join(output, 'warm-report.json'), JSON.stringify({ completed: false, items: report }, null, 2));
    throw new Error('Preview warm-up stopped at ' + voice.speakerId + '; the failed provider call was not automatically replayed');
  }
  await new Promise(resolve => setTimeout(resolve, 300));
}
await fs.writeFile(path.join(output, 'warm-report.json'), JSON.stringify({ completed: true, checkedAt: new Date().toISOString(), items: report }, null, 2));
