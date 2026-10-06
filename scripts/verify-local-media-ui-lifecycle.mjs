import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('tsx'))('esbuild');
const before = path.resolve('.codex-backups/20260903-011400-toolbox-local-media-ui');
const fixtureRoot = path.resolve('.tmp-e2e/local-media-real-e2e/2026-09-02T05-30-25-701Z');
const video = await fs.readFile(path.join(fixtureRoot, 'input.mp4'));
const gif = await fs.readFile(path.join(fixtureRoot, 'gif.gif'));
const out = path.resolve('.codex-evidence/toolbox-local-media-real-e2e-20260903/lifecycle-fixture.json');
const cases = [];
const browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
async function fixture(kind, old) {
  const filename = kind === 'editor' ? 'local-video-editor.tsx' : 'subtitle-remover-workbench.tsx';
  const current = path.resolve('src/features/local-video-tools', filename);
  const source = await fs.readFile(old ? path.join(before, filename) : current, 'utf8');
  const component = kind === 'editor' ? 'LocalVideoEditor' : 'SubtitleRemoverWorkbench';
  const build = await esbuild.build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{${component}}from'fixture-component';globalThis.fixtureRoot=createRoot(document.getElementById('root'));globalThis.fixtureRoot.render(React.createElement(${component}));`, resolveDir: process.cwd(), sourcefile: 'media-fixture.tsx', loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent', plugins: [{ name: 'fixture-aliases', setup(build) {
      build.onResolve({ filter: /^fixture-component$/ }, () => ({ path: current, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: source, loader: 'tsx', resolveDir: path.dirname(current) }));
      build.onResolve({ filter: /^@\/components\/app-scoped-link$/ }, () => ({ path: 'link', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `import React from 'react';export const AppScopedLink=props=>React.createElement('a',props);`, loader: 'js', resolveDir: process.cwd() }));
      build.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'styles', namespace: 'styles' }));
      build.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: 'export default {}', loader: 'js' }));
    } }] });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    globalThis.createdBlobs = []; globalThis.revokedBlobs = []; globalThis.fixtureErrors = [];
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = blob => { const url = create(blob); globalThis.createdBlobs.push(url); return url; };
    URL.revokeObjectURL = url => { globalThis.revokedBlobs.push(url); revoke(url); };
  });
  const calls = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, 'http://local-media-fixture.test');
    if (url.pathname === '/api/video/local-media/process') {
      const form = await new Request(url, { method: 'POST', headers: { 'content-type': request.headers()['content-type'] }, body: request.postDataBuffer() }).formData();
      const action = form.get('action'); calls.push({ action, start: form.get('startSeconds'), end: form.get('endSeconds') });
      return route.fulfill({ status: 200, contentType: action === 'gif' ? 'image/gif' : 'video/mp4', body: action === 'gif' ? gif : video });
    }
    return route.fulfill(url.pathname === '/bundle.js' ? { status: 200, contentType: 'text/javascript', body: build.outputFiles[0].text } : { status: 200, contentType: 'text/html', body: '<!doctype html><div id="root"></div><script src="/bundle.js"></script>' });
  });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://local-media-fixture.test/');
  const pick = async () => { await page.locator('input[type="file"][accept^="video/"]').setInputFiles({ name: 'fixture.mp4', mimeType: 'video/mp4', buffer: video }); await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1); };
  const submit = async () => { await page.getByRole('button', { name: kind === 'editor' ? '裁剪并导出' : '🧹 开始去除固定区域字幕', exact: true }).click(); await page.getByRole('link', { name: kind === 'editor' ? '下载真实处理结果' : '下载处理后视频', exact: true }).waitFor(); await page.waitForTimeout(30); };
  const urls = () => page.evaluate(() => ({ source: document.querySelector('video')?.src, result: document.querySelector('a[download]')?.href, created: globalThis.createdBlobs, revoked: globalThis.revokedBlobs }));
  const readable = url => page.evaluate(async url => { try { return (await fetch(url)).ok; } catch { return false; } }, url);
  return { page, context, calls, errors, pick, process: submit, urls, readable };
}
try {
  for (const kind of ['editor', 'subtitle']) {
    const f = await fixture(kind, true); await f.pick(); await f.process(); const urls = await f.urls();
    assert.equal(await f.readable(urls.source), false); assert.equal(await f.readable(urls.result), true);
    cases.push(`before ${kind}: actual component revokes still-mounted source when result changes`); await f.context.close();
  }
  for (const kind of ['editor', 'subtitle']) {
    const f = await fixture(kind, false); await f.pick(); await f.process(); const first = await f.urls();
    assert.equal(await f.readable(first.source), true); assert.equal(await f.readable(first.result), true);
    await f.pick(); const picked = await f.urls();
    assert.equal(await f.readable(first.source), false); assert.equal(await f.readable(first.result), true); assert.equal(await f.readable(picked.source), true);
    cases.push(`after ${kind}: result keeps source alive; changing source revokes only replaced source`);
    await f.process(); await f.page.waitForFunction(previous => document.querySelector('a[download]')?.href !== previous, first.result); const second = await f.urls();
    assert.equal(await f.readable(first.result), false); assert.equal(await f.readable(second.source), true); assert.equal(await f.readable(second.result), true);
    await f.page.evaluate(() => globalThis.fixtureRoot.unmount()); await f.page.waitForTimeout(30);
    const state = await f.urls(); assert.ok(state.created.every(url => state.revoked.includes(url))); assert.equal(f.errors.length, 0);
    cases.push(`after ${kind}: replacing result revokes only old result; unmount cleans both URLs`); await f.context.close();
  }
  const f = await fixture('editor', false); await f.page.getByRole('button', { name: 'GIF', exact: true }).click(); await f.pick();
  await f.page.locator('input[type="number"]').nth(0).fill('0.2'); await f.page.locator('input[type="number"]').nth(1).fill('1.2');
  await f.page.getByRole('button', { name: 'GIF并导出', exact: true }).click(); await f.page.getByAltText('导出的动态 GIF').waitFor();
  assert.deepEqual(f.calls, [{ action: 'gif', start: '0.2', end: '1.2' }]);
  assert.equal(await f.page.getByRole('link', { name: '下载真实处理结果', exact: true }).getAttribute('download'), '动态封面.gif');
  assert.equal(await f.page.getByAltText('导出的动态 GIF').evaluate(element => element.complete && element.naturalWidth > 0), true);
  assert.equal(await f.readable((await f.urls()).source), true); assert.equal(f.errors.length, 0);
  cases.push('actual GIF click sends the existing action and selected time range, renders image and correct download extension');
  await f.context.close();
  const report = { passed: true, scenarios: cases.length, cases, actualComponents: true, mockedMediaResponse: true, externalRequests: 0, businessDatabaseWrites: 0 };
  await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
