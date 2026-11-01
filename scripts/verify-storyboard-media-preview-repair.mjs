import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

// Isolated current-component tests, with no product build, listening port or forwarded request.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild');
const output = path.resolve('.codex-evidence/storyboard-delivery-audit-20261023/repair/media');
fs.mkdirSync(output, { recursive: true });
const files = ['src/components/storyboard-media-preview.tsx', 'src/lib/storyboard-video-access.ts'];
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const bundle = await build({ stdin: { contents: `
  import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
  import {TicketedVideo,MediaLightbox} from './src/components/storyboard-media-preview';
  import {requestVideoAccessUrl} from './src/lib/storyboard-video-access';
  window.requestVideoAccessUrl=requestVideoAccessUrl;
  function App(){const [media,setMedia]=useState(null);window.setPreviewMedia=setMedia;
    return <main className="sbw-root"><div style={{width:640,height:360}}>
      <TicketedVideo url="/media.mp4?initial=1" taskId="fixture-owned-task" token="synthetic-token"
        onExpand={(url,currentTime)=>{window.expandedAt=currentTime;setMedia({url,currentTime,type:'video',taskId:'fixture-owned-task',token:'synthetic-token'});}} />
      </div>{media&&<MediaLightbox media={media} onClose={()=>{window.closedPreviewVideo=document.querySelector('.sbw-lightbox video');setMedia(null);}} />}</main>;
  } createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'isolated-media-preview-fixture.tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"test"' },
  tsconfig: path.resolve('tsconfig.json'), logLevel: 'silent' });
const synthetic = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { maxBuffer: 10 * 1024 * 1024, windowsHide: true });
assert.equal(synthetic.status, 0, synthetic.stderr.toString());
const media = synthetic.stdout;
const css = fs.readFileSync('src/app/storyboard-workbench/storyboard-workbench.css', 'utf8');
const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#0b1522;color:white}' + css + '</style></head><body><div id="root"></div><script>' + bundle.outputFiles[0].text.replaceAll('</script', '<\\/script') + '</script></body></html>';
const report = { checks: [], sourceHashes, productBuilds: 0, productPorts: 0, forwardedRequests: 0, databaseCalls: 0, generationCalls: 0,
  scope: 'Actual current React components in an isolated browser fixture. All HTTP is intercepted in RAM. This is not served-product UI acceptance.' };
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const open = [];
async function fixture() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); open.push(context);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const state = { tickets: [], mediaRequests: 0, failTickets: false, badMedia: false, oneBadMedia: false, delayTickets: false, waiting: [], errors: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => { window.unhandled = []; window.addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason))); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://preview.storyboard.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/api/video/access-ticket') {
      state.tickets.push({ query: Object.fromEntries(url.searchParams), authorization: request.headers().authorization });
      if (state.delayTickets) await new Promise(resolve => state.waiting.push(resolve));
      return route.fulfill({ status: state.failTickets ? 503 : 200, contentType: 'application/json', body: JSON.stringify(state.failTickets ? { error: '合成票据服务暂不可用，请重试' } : { url: '/media.mp4?ticket=' + state.tickets.length }) }).catch(() => {});
    }
    if (url.pathname === '/media.mp4') {
      state.mediaRequests++;
      if (state.badMedia || state.oneBadMedia) { state.oneBadMedia = false; return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Synthetic expired ticket"}' }); }
      const headers = { 'content-type': 'video/mp4', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
      const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers().range || '');
      if (match) {
        const start = Number(match[1]), end = Math.min(Number(match[2] || media.length - 1), media.length - 1);
        if (start >= media.length) return route.fulfill({ status: 416, headers: { ...headers, 'content-range': `bytes */${media.length}` }, body: '' });
        return route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${media.length}`, 'content-length': String(end - start + 1) }, body: media.subarray(start, end + 1) });
      }
      return route.fulfill({ status: 200, headers, body: media });
    }
    return route.abort();
  });
  await page.goto('https://preview.storyboard.test');
  await page.waitForFunction(() => document.querySelector('.sbw-ticketed-video video')?.readyState >= 2);
  return { context, page, state };
}
async function check(name, test) { await test(); report.checks.push({ name, passed: true }); console.log('PASS ' + name); }
async function openPlaying(f, position = 3.5) {
  await f.page.locator('.sbw-ticketed-video video').evaluate(async (video, time) => { video.currentTime = time; await video.play(); }, position);
  await f.page.getByRole('button', { name: '放大播放视频' }).click();
}
try {
  await check('ticket helper keeps scope, origin, filename and bearer identity', async () => {
    const f = await fixture();
    await f.page.evaluate(() => window.requestVideoAccessUrl('fixture-owned-task', 'synthetic-token', { scope: 'download', source: 'origin', filename: '分镜 1.webm' }));
    assert.deepEqual(f.state.tickets.at(-1), { query: { taskId: 'fixture-owned-task', scope: 'download', name: '分镜 1.webm', source: 'origin' }, authorization: 'Bearer synthetic-token' });
    await f.context.close();
  });
  await check('invalid ticket options fail before any network request', async () => {
    const f = await fixture(), before = f.state.tickets.length;
    const messages = await f.page.evaluate(async () => {
      const messages = [];
      for (const [id, token, options] of [['', 'token', {}], ['id', '', {}], ['id', 'token', { scope: 'other' }], ['id', 'token', { source: 'other' }], ['id', 'token', { filename: 'bad\nname' }]]) {
        try { await window.requestVideoAccessUrl(id, token, options); messages.push('unexpected success'); } catch (error) { messages.push(error.message); }
      } return messages;
    });
    assert.equal(messages.length, 5); assert.ok(messages.every(message => message !== 'unexpected success')); assert.equal(f.state.tickets.length, before);
    await f.context.close();
  });
  await check('null JSON and invalid URL become visible controlled errors', async () => {
    const f = await fixture();
    for (const body of ['null', '{"url":"javascript:alert(1)"}', '{"url":7}', 'not-json']) {
      await f.page.route('**/api/video/access-ticket**', route => route.fulfill({ contentType: 'application/json', body }));
      const message = await f.page.evaluate(() => window.requestVideoAccessUrl('id', 'token').then(() => 'unexpected success', error => error.message));
      assert.match(message, /播放地址无效/u); await f.page.unroute('**/api/video/access-ticket**');
    }
    await f.context.close();
  });
  await check('expand pauses the card, carries current time and has no recursive expand button', async () => {
    const f = await fixture(); await openPlaying(f);
    await f.page.waitForFunction(() => { const video = document.querySelector('.sbw-lightbox video'); return video && !video.paused && video.currentTime >= 3.5; });
    assert.equal(await f.page.locator('.sbw-ticketed-video video').evaluate(video => video.paused), true);
    assert.equal(await f.page.locator('.sbw-lightbox .sbw-video-expand').count(), 0);
    assert.ok(await f.page.evaluate(() => window.expandedAt >= 3.5));
    await f.page.screenshot({ path: path.join(output, 'playing-lightbox.png') }); await f.context.close();
  });
  await check('expired lightbox URL refreshes its own ticket and resumes the playback position', async () => {
    const f = await fixture(); f.state.oneBadMedia = true; await openPlaying(f, 4);
    await f.page.waitForFunction(() => { const video = document.querySelector('.sbw-lightbox video'); return video && !video.paused && video.currentTime >= 4; });
    assert.ok(f.state.tickets.length >= 3); assert.equal(await f.page.locator('.sbw-ticketed-video video').evaluate(video => video.paused), true);
    assert.ok(f.state.tickets.every(ticket => ticket.query.taskId === 'fixture-owned-task'));
    await f.context.close();
  });
  await check('repeated media errors stop after two automatic refreshes and manual retry recovers', async () => {
    const f = await fixture(); f.state.badMedia = true; await openPlaying(f);
    await f.page.getByRole('button', { name: '刷新播放地址' }).waitFor();
    assert.equal(f.state.tickets.length, 4); assert.equal(f.state.tickets.at(-1).query.source, 'origin');
    await f.page.waitForTimeout(300); assert.equal(f.state.tickets.length, 4);
    assert.match(await f.page.locator('.sbw-lightbox [role="alert"]').innerText(), /视频暂时无法播放/u);
    await f.page.screenshot({ path: path.join(output, 'bounded-playback-error.png') });
    f.state.badMedia = false; await f.page.getByRole('button', { name: '刷新播放地址' }).click();
    await f.page.waitForFunction(() => document.querySelector('.sbw-lightbox video')?.readyState >= 2);
    assert.equal(f.state.tickets.length, 5); await f.context.close();
  });
  await check('ticket 503 shows a retryable message without unhandled rejection', async () => {
    const f = await fixture(); f.state.failTickets = true; await openPlaying(f);
    await f.page.getByRole('button', { name: '刷新播放地址' }).waitFor();
    assert.match(await f.page.locator('.sbw-lightbox [role="alert"]').innerText(), /票据服务暂不可用/u);
    assert.deepEqual(await f.page.evaluate(() => window.unhandled), []); assert.deepEqual(f.state.errors, []);
    f.state.failTickets = false; await f.page.getByRole('button', { name: '刷新播放地址' }).click();
    await f.page.waitForFunction(() => document.querySelector('.sbw-lightbox video')?.readyState >= 2); await f.context.close();
  });
  await check('close immediately pauses lightbox media and restores focus and scrolling', async () => {
    const f = await fixture(); await openPlaying(f);
    await f.page.waitForFunction(() => { const video = document.querySelector('.sbw-lightbox video'); return video && !video.paused; });
    await f.page.getByRole('button', { name: '关闭预览' }).click();
    assert.equal(await f.page.locator('.sbw-lightbox').count(), 0);
    assert.equal(await f.page.evaluate(() => window.closedPreviewVideo.paused), true);
    assert.equal(await f.page.evaluate(() => document.body.style.overflow), '');
    assert.equal(await f.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '放大播放视频');
    assert.equal(await f.page.locator('.sbw-ticketed-video video').evaluate(video => video.paused), true); await f.context.close();
  });
  await check('Escape cancels an in-flight modal ticket and late responses cannot reopen it', async () => {
    const f = await fixture(); f.state.delayTickets = true; await openPlaying(f);
    await f.page.locator('.sbw-lightbox').getByText('正在加载视频…', { exact: true }).waitFor();
    await f.page.keyboard.press('Escape'); f.state.delayTickets = false; f.state.waiting.splice(0).forEach(resolve => resolve());
    await f.page.waitForTimeout(100); assert.equal(await f.page.locator('.sbw-lightbox').count(), 0);
    assert.deepEqual(await f.page.evaluate(() => window.unhandled), []); await f.context.close();
  });
  await check('image preview retains zoom bounds and Escape closing', async () => {
    const f = await fixture();
    await f.page.evaluate(() => window.setPreviewMedia({ type: 'image', url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="teal"/></svg>') }));
    for (let index = 0; index < 4; index++) await f.page.getByRole('button', { name: '放大预览', exact: true }).click();
    assert.equal(await f.page.getByLabel('当前缩放比例').innerText(), '140%'); assert.equal(await f.page.getByRole('button', { name: '放大预览', exact: true }).isDisabled(), true);
    for (let index = 0; index < 7; index++) await f.page.getByRole('button', { name: '缩小预览', exact: true }).click();
    assert.equal(await f.page.getByLabel('当前缩放比例').innerText(), '70%'); await f.page.keyboard.press('Escape');
    assert.equal(await f.page.locator('.sbw-lightbox').count(), 0); await f.context.close();
  });
  await check('changing media identity ignores a stale ticket and starts the new position', async () => {
    const f = await fixture(); f.state.delayTickets = true; await openPlaying(f);
    await f.page.locator('.sbw-lightbox').getByText('正在加载视频…', { exact: true }).waitFor();
    f.state.delayTickets = false;
    await f.page.evaluate(() => window.setPreviewMedia({ type: 'video', url: '/media.mp4?replacement=1', taskId: 'replacement-task', token: 'synthetic-token', currentTime: 6 }));
    f.state.waiting.splice(0).forEach(resolve => resolve());
    await f.page.waitForFunction(() => { const video = document.querySelector('.sbw-lightbox video'); return video && video.currentTime >= 6; });
    assert.equal(f.state.tickets.at(-1).query.taskId, 'replacement-task'); assert.deepEqual(f.state.errors, []); await f.context.close();
  });
  await check('fullscreen entry and close stop the player before leaving fullscreen', async () => {
    const f = await fixture(); await openPlaying(f);
    await f.page.waitForFunction(() => document.querySelector('.sbw-lightbox video')?.readyState >= 2);
    await f.page.getByRole('button', { name: '进入全屏', exact: true }).click();
    await f.page.waitForFunction(() => document.fullscreenElement?.classList.contains('sbw-lightbox'));
    await f.page.getByRole('button', { name: '关闭预览' }).click();
    await f.page.waitForFunction(() => !document.fullscreenElement && !document.querySelector('.sbw-lightbox'));
    assert.equal(await f.page.evaluate(() => window.closedPreviewVideo.paused), true); await f.context.close();
  });
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; throw error; }
finally {
  for (const context of open) await context.close().catch(() => {});
  await browser.close();
  report.sourceUnchanged = files.every(file => sourceHashes[file] === createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  fs.writeFileSync(path.join(output, 'tests.json'), JSON.stringify(report, null, 2) + '\n');
}
