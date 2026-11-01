import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// Independent media-engine baseline: no account, provider, product API or network.
// Product generation/return/persistence acceptance must be reported separately.
const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require('playwright');
const sharp = require('sharp');
const ffmpeg = require('ffmpeg-static');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownedRoot = path.join(root, '.codex-evidence/storyboard-delivery-audit-20261023/browser-matrix');
const output = path.resolve(process.env.STORYBOARD_BROWSER_MATRIX_OUTPUT || ownedRoot);
const relative = path.relative(ownedRoot, output);
if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output must stay within owned browser-matrix directory');
await fs.mkdir(output, { recursive: true });
const media = new Map();
const fixtureErrors = [];
for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['avif', 'image/avif']]) {
  try {
    const body = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#1a9ead' } }).toFormat(format).toBuffer();
    media.set(format, { kind: 'image', mime, body });
  } catch (error) { fixtureErrors.push({ format, error: error.message }); }
}
for (const [format, codec, mux, mime, extra] of [
  ['mp4-h264-aac', 'libx264', 'mp4', 'video/mp4', ['-preset', 'ultrafast', '-movflags', 'frag_keyframe+empty_moov']],
  ['webm-vp8-opus', 'libvpx', 'webm', 'video/webm', ['-deadline', 'realtime', '-cpu-used', '8']],
  ['webm-vp9-opus', 'libvpx-vp9', 'webm', 'video/webm', ['-deadline', 'realtime', '-cpu-used', '8']],
  ['mov-h264-aac', 'libx264', 'mov', 'video/quicktime', ['-preset', 'ultrafast', '-movflags', 'frag_keyframe+empty_moov']],
  ['mp4-hevc-aac', 'libx265', 'mp4', 'video/mp4', ['-preset', 'ultrafast', '-tag:v', 'hvc1', '-movflags', 'frag_keyframe+empty_moov']],
]) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', codec, '-pix_fmt', 'yuv420p', '-g', '15', ...extra, '-c:a', mux === 'webm' ? 'libopus' : 'aac', '-b:a', '32k', '-f', mux, 'pipe:1'], { maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true });
  if (result.status === 0 && result.stdout.length) media.set(format, { kind: 'video', mime, body: result.stdout });
  else fixtureErrors.push({ format, error: result.error?.message || result.stderr?.toString().slice(-1500) });
}
const cache = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const availableExecutable = (type, fallback) => existsSync(type.executablePath()) ? type.executablePath() : path.join(cache, fallback);
const specs = [
  { name: 'Chrome', type: chromium, options: { channel: 'chrome' } },
  { name: 'Edge', type: chromium, options: { channel: 'msedge' } },
  { name: 'Firefox', type: firefox, options: { executablePath: availableExecutable(firefox, 'firefox-1532/firefox/firefox.exe') } },
  { name: 'WebKit-Windows', type: webkit, options: { executablePath: availableExecutable(webkit, 'webkit-2311/Playwright.exe') } },
];
const report = { scope: 'Independent browser media-engine baseline with synthetic in-memory media. Not product end-to-end acceptance.', generatedAt: new Date().toISOString(), os: { platform: os.platform(), release: os.release(), arch: os.arch() }, safari: 'Actual Safari on macOS/iOS was not tested; Windows Playwright WebKit is not Safari.', networkPolicy: 'All browser requests intercepted; only synthetic harness/media fulfilled. Other requests aborted. No product APIs, credentials, provider submission or writes.', fixtures: [...media].map(([format, m]) => ({ format, kind: m.kind, mime: m.mime, bytes: m.body.length })), fixtureErrors, browsers: [] };
for (const spec of specs) {
  const item = { name: spec.name, results: [], blockedRequests: [], mediaRequests: [] };
  report.browsers.push(item);
  let browser;
  try {
    try {
      browser = await spec.type.launch({ headless: true, ...spec.options });
    } catch (error) {
      if (spec.name !== 'Firefox') throw error;
      item.initialLaunchError = error.message;
      item.fallbackExecutable = path.join(cache, 'firefox-1532/firefox/firefox.exe');
      browser = await spec.type.launch({ headless: true, executablePath: item.fallbackExecutable });
    }
    item.version = browser.version();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://storyboard-media.invalid') { item.blockedRequests.push(url.origin + url.pathname); return route.abort(); }
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Independent synthetic media baseline</title><body style="background:#102436;color:white;font:20px sans-serif"><h1>Independent browser media-engine baseline</h1><p>Synthetic fixtures; no product API or provider calls.</p><main></main></body>' });
      const fixture = media.get(url.pathname.slice(1));
      if (!fixture) return route.abort();
      const range = route.request().headers().range;
      const headers = { 'content-type': fixture.mime, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
      const match = range?.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const start = Number(match[1]);
        const end = Math.min(match[2] ? Number(match[2]) : fixture.body.length - 1, fixture.body.length - 1);
        if (start > end) return route.fulfill({ status: 416, headers: { ...headers, 'content-range': `bytes */${fixture.body.length}` } });
        item.mediaRequests.push({ format: url.pathname.slice(1), status: 206, range });
        return route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${fixture.body.length}`, 'content-length': String(end - start + 1) }, body: fixture.body.subarray(start, end + 1) });
      }
      item.mediaRequests.push({ format: url.pathname.slice(1), status: 200 });
      return route.fulfill({ status: 200, headers, body: fixture.body });
    });
    const page = await context.newPage();
    await page.goto('https://storyboard-media.invalid/');
    item.userAgent = await page.evaluate(() => navigator.userAgent);
    for (const [format, fixture] of media) {
      const result = await page.evaluate(async ({ format, kind }) => {
        const host = document.querySelector('main');
        host.replaceChildren();
        const element = document.createElement(kind === 'image' ? 'img' : 'video');
        element.style.cssText = 'width:480px;max-height:300px';
        host.append(element);
        const wait = (event, timeout = 8000) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error(`${event} timeout`)); }, timeout);
          const done = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error(`media error ${element.error?.code || 'image'}`)); };
          const cleanup = () => { clearTimeout(timer); element.removeEventListener(event, done); element.removeEventListener('error', failed); };
          element.addEventListener(event, done, { once: true }); element.addEventListener('error', failed, { once: true });
        });
        try {
          if (kind === 'image') {
            const loaded = wait('load'); element.src = `/${format}`; await loaded;
            return { format, pass: element.naturalWidth === 160 && element.naturalHeight === 90, width: element.naturalWidth, height: element.naturalHeight };
          }
          element.muted = true; element.controls = true; element.playsInline = true; element.preload = 'auto';
          const loaded = wait('loadeddata'); element.src = `/${format}`; await loaded;
          await element.play(); const before = element.currentTime;
          await new Promise(resolve => setTimeout(resolve, 600)); const after = element.currentTime;
          element.pause(); const seeking = wait('seeked'); element.currentTime = 1.3; await seeking;
          return { format, pass: element.videoWidth === 160 && after > before + 0.15 && Math.abs(element.currentTime - 1.3) < 0.2, width: element.videoWidth, height: element.videoHeight, duration: element.duration, currentTimeBefore: before, currentTimeAfter: after, seekTime: element.currentTime, readyState: element.readyState };
        } catch (error) { return { format, pass: false, error: error.message, mediaError: element.error?.code, readyState: element.readyState }; }
      }, { format, kind: fixture.kind });
      item.results.push(result);
      console.log(`${spec.name} ${format}: ${result.pass ? 'PASS' : 'FAIL'}${result.error ? ` (${result.error})` : ''}`);
    }
    await page.screenshot({ path: path.join(output, `${spec.name}.png`) });
  } catch (error) { item.launchOrHarnessError = error.message; console.log(`${spec.name}: ${error.message.slice(0, 200)}`); }
  finally { if (browser) await browser.close(); }
}
await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
const formats = [...media.keys()];
const rows = report.browsers.map(b => `| ${b.name} ${b.version || '(unavailable)'} | ${formats.map(f => { const r = b.results.find(r => r.format === f); return r ? r.pass ? 'PASS' : 'FAIL' : 'NOT RUN'; }).join(' | ')} |`);
await fs.writeFile(path.join(output, 'README.md'), `# Synthetic media-engine baseline\n\n${report.scope}\n\nOS: ${report.os.platform} ${report.os.release} ${report.os.arch}. Generated: ${report.generatedAt}.\n\n| Browser | ${formats.join(' | ')} |\n| --- | ${formats.map(() => '---').join(' | ')} |\n${rows.join('\n')}\n\nImage PASS requires actual decoded natural dimensions. Video PASS requires loadeddata, real playback clock advancement, decoded dimensions, and seek to 1.3 seconds. Video fixtures contain audio; muted playback does not verify audible output. Every request is intercepted; media supports Range 206. This does not verify the deployed media proxy Range/Content-Type, user authorization, returned provider files, long-term persistence, or the real storyboard preview component.\n\n${report.safari}\n\nUnsupported formats remain compatibility findings; no transcode or browser fallback is implied. See results.json for exact codec/container combinations, launch failures and request status.\n`);
console.log(`Report: ${path.join(output, 'results.json')}`);
