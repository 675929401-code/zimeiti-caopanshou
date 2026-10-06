import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = process.cwd();
const packagePath = name => {
  const entry = fs.readdirSync(path.join(root, 'node_modules/.pnpm')).find(value => value.startsWith(`${name}@`));
  assert.ok(entry, `${name} must be installed`);
  return path.join(root, 'node_modules/.pnpm', entry, 'node_modules', name);
};
const { build } = require(packagePath('esbuild'));
const ffmpeg = require(packagePath('ffmpeg-static'));
const output = path.resolve('.codex-evidence/media-history-native-preview-20260916');
fs.mkdirSync(output, { recursive: true });
const videoFile = path.join(output, 'fixture.mp4');
const generation = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoFile], { encoding: 'utf8' });
assert.equal(generation.status, 0, generation.stderr);
const video = fs.readFileSync(videoFile);
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MediaHistoryVideoPreview} from './src/components/media-history-video-preview';
    import {requestMediaHistoryVideoUrl} from './src/lib/media-history-video-preview';
    window.requestPreview = requestMediaHistoryVideoUrl;
    createRoot(document.getElementById('root')).render(<MediaHistoryVideoPreview previewPath="/api/video/storage/fixture-task" title="测试视频" token="fixture-account-token"/>);`,
    resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({ headless: true });
const origin = 'http://media-preview.test';
const requests = [], errors = [];
let ticketCount = 0;
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    assert.equal(url.origin, origin, 'external requests are forbidden');
    assert.equal(request.method(), 'GET', 'mutations are forbidden');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root" style="width:640px;height:360px"></div><style>video{width:640px;height:360px}button{padding:12px}</style><script src="/fixture.js"></script>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    const headers = await request.allHeaders();
    requests.push({ path: url.pathname, resourceType: request.resourceType(), range: headers.range || '', hasAccountTokenInUrl: url.href.includes('fixture-account-token') });
    if (url.pathname === '/api/video/access-ticket') {
      assert.equal(headers.authorization, 'Bearer fixture-account-token');
      assert.equal(url.searchParams.get('taskId'), 'fixture-task'); ticketCount++;
      const target = url.searchParams.get('scope') === 'download' ? '/api/video/proxy-download' : '/api/video/proxy';
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: `${target}?id=fixture-task&media_ticket=fixture-${ticketCount}` }) });
    }
    assert.equal(url.pathname, '/api/video/proxy');
    assert.equal(request.resourceType(), 'media', 'video bytes must be loaded by the native media element');
    assert.ok(!headers.authorization, 'account tokens must not accompany media URLs');
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.range || '');
    assert.ok(range, 'native metadata/seek must use Range');
    const start = Number(range[1]), end = Math.min(Number(range[2] || video.length - 1), video.length - 1);
    return route.fulfill({ status: 206, headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${video.length}`, 'Content-Length': String(end - start + 1) }, body: video.subarray(start, end + 1) });
  });
  await page.goto(origin);
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2 && v.videoWidth === 320 && v.currentTime > 0; });
  assert.equal(ticketCount, 1);
  assert.equal(await page.locator('video').getAttribute('preload'), 'metadata');
  assert.equal(await page.locator('video').getAttribute('autoplay'), null);
  await page.screenshot({ path: path.join(output, 'decoded-first-frame.png') });
  await page.locator('video').dispatchEvent('error');
  await page.getByRole('button', { name: '预览暂不可用，点击重试' }).click();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  assert.equal(ticketCount, 2, 'retry must refresh the short-lived ticket once');
  const downloadUrl = await page.evaluate(() => window.requestPreview('/api/video/storage/fixture-task', 'fixture-account-token', { download: true, filename: '测试.mp4' }));
  assert.ok(downloadUrl.startsWith('/api/video/proxy-download?'));
  const countBeforeInvalid = ticketCount;
  for (const [source, token] of [['https://untrusted.invalid/video', 'fixture-account-token'], ['/api/video/storage/fixture-task', null]]) {
    const rejected = await page.evaluate(async ([source, token]) => { try { await window.requestPreview(source, token); return false; } catch { return true; } }, [source, token]);
    assert.equal(rejected, true);
  }
  assert.equal(ticketCount, countBeforeInvalid);
  assert.ok(requests.some(value => value.resourceType === 'media' && value.range));
  assert.ok(requests.every(value => !value.hasAccountTokenInUrl));
  assert.deepEqual(errors, []);
  const report = { ok: true, mode: 'actual source bundled into isolated browser; every HTTP response is a fixture', checks: ['native decoded frame before play', 'metadata preload', 'no autoplay', 'Range media requests', 'no whole-file blob fetch', 'account token remains in ticket request header', 'retry refreshes ticket', 'download-scoped URL', 'invalid path/login rejected before request'], requests, pageErrors: errors, supplierRequests: 0, databaseWrites: 0, productBuilds: 0 };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
