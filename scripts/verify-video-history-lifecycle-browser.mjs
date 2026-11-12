import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

// Current MediaHistoryWorkspace acceptance. All business responses and media
// bytes are isolated fixtures; only static application pages come from 5000.
const root = process.cwd();
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.equal(origin, 'http://127.0.0.1:5000');
const runFile = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const output = path.resolve(root, '../运行日志/视频历史闭环-20261018-a758', 'current-workspace-' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(output, { recursive: true });
const videoFile = path.join(output, 'fixture-16s.mp4');
const generated = await runFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12', '-t', '16', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoFile], { timeout: 45000, windowsHide: true });
assert.ok(generated.stderr === '');
const bytes = await fs.readFile(videoFile), mediaSha = sha(bytes);
const mainTask = 'fixture-main-0001', mainTitle = '16秒统一历史真实播放验收';
const token = 'history-lifecycle-fixture-token';
const user = { id: 'history-lifecycle-fixture-user', username: 'history_fixture', displayName: '历史闭环夹具', email: 'fixture@example.invalid', role: 'admin', status: 'active', is_active: true, credits: 1000 };
const now = Date.now();
const makeItem = (task, index) => ({
  id: `video:${task}`, kind: 'video', title: index === 0 ? mainTitle : `分页恢复作品 ${String(index).padStart(2, '0')}`,
  project: '统一历史隔离项目', segment: `分段 ${index + 1}`, source: '视频创作', sourcePath: '/video', retryPath: '',
  categoryKey: 'video-production', removable: true, status: 'completed',
  createdAt: new Date(now - (index + 1) * 60000).toISOString(), completedAt: new Date(now - (index + 1) * 60000 + 16000).toISOString(),
  publicModelName: '本地验收模型（未调用）', cost: null, costNote: '隔离夹具，无账单',
  previewPath: `/api/video/storage/${task}`, thumbnailPath: `/api/video/thumbnail/${task}`, downloadPath: `/api/video/storage/${task}`,
  errorMessage: '', aspectRatio: '16:9', durationSeconds: 16,
  expiresAt: new Date(now + 5 * 86400000).toISOString(), retentionSource: 'policy',
});
const items = [makeItem(mainTask, 0), ...Array.from({ length: 60 }, (_, index) => makeItem(`fixture-page-${String(index + 1).padStart(4, '0')}`, index + 1))];
const state = { historyReads: 0, tickets: [], mediaRequests: [], thumbnailRequests: 0, blockedWrites: [], externalRequests: [], generationRequests: [] };
const report = {
  passed: false, mode: 'current MediaHistoryWorkspace with isolated API and native H264 fixtures', origin,
  media: { bytes: bytes.length, sha256: mediaSha, seconds: 16, width: 320, height: 180 },
  checks: [], stages: [], screenshots: [], pageErrors: [], fixtureRequests: [],
  actualServerWrites: 0, actualProviderCalls: 0, paidCalls: 0, realPosts: 0,
  limitations: [
    '本用例覆盖当前统一作品历史的刷新恢复、分页、搜索、原生播放、暂停、seek 和下载 SHA；票据重试由 verify-media-history-native-preview.mjs 独立覆盖。',
    '旧 .sbh-panel 的清空历史、多 surface 自动刷新和“保存本机副本”按钮合同不直接套用到当前统一页面；离线副本恢复由独立离线专项覆盖。',
    '全部业务数据与媒体响应均为隔离夹具，不证明上游真实生成结果。',
  ],
};
const saveReport = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const check = (name, condition, detail) => { report.checks.push({ name, passed: Boolean(condition), ...(detail === undefined ? {} : { detail }) }); assert.ok(condition, name); };
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(data) });
const posterSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#173249"/><circle cx="160" cy="90" r="38" fill="#57d3c1"/></svg>';
let browser;
let page;

async function stage(name, action) {
  const started = Date.now();
  try {
    const detail = await action();
    report.stages.push({ name, passed: true, elapsedMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
    await saveReport();
  } catch (error) {
    report.stages.push({ name, passed: false, elapsedMs: Date.now() - started, error: error.message.slice(0, 1400) });
    if (page && !page.isClosed()) {
      const file = path.join(output, `failure-${report.stages.length}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      await fs.writeFile(path.join(output, `failure-${report.stages.length}.txt`), (await page.locator('body').innerText().catch(() => '')).slice(0, 16000));
    }
    throw error;
  }
}
async function snapshot(name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(file);
}
async function openHistory() {
  await page.goto(`${origin}/video`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '历史', exact: true }).waitFor({ timeout: 45000 });
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.locator('.media-history-page').waitFor({ timeout: 45000 });
  await page.getByRole('heading', { name: '作品历史', exact: true }).first().waitFor();
  await page.getByRole('button', { name: `预览${mainTitle}`, exact: true }).waitFor({ timeout: 45000 });
}
async function openPreview() {
  await page.getByRole('button', { name: `预览${mainTitle}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: mainTitle, exact: true });
  await dialog.waitFor();
  const video = dialog.locator('video[aria-label]');
  await video.waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector('dialog video');
    return video && video.readyState >= 2 && video.videoWidth === 320 && video.videoHeight === 180 && Math.abs(video.duration - 16) < 0.25;
  }, null, { timeout: 45000 });
  return { dialog, video };
}
async function mediaResponse(route, download) {
  const request = route.request(), url = new URL(request.url()), headers = await request.allHeaders();
  assert.equal(request.method(), 'GET');
  assert.ok(!headers.authorization, 'account token must not enter media requests');
  assert.ok(!url.href.includes(token), 'account token must not enter media URL');
  const range = /^bytes=(\d+)-(\d*)$/u.exec(headers.range || '');
  state.mediaRequests.push({ path: url.pathname, range: headers.range || null, download });
  if (download) {
    return route.fulfill({ status: 200, headers: {
      'content-type': 'video/mp4', 'content-length': String(bytes.length), 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="fixture-16s.mp4"`,
    }, body: bytes });
  }
  if (!range) return route.fulfill({ status: 200, headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(bytes.length), 'cache-control': 'no-store' }, body: bytes });
  const start = Number(range[1]), end = Math.min(Number(range[2] || bytes.length - 1), bytes.length - 1);
  assert.ok(start >= 0 && start <= end && end < bytes.length, 'valid media Range required');
  return route.fulfill({ status: 206, headers: {
    'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store',
    'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1),
  }, body: bytes.subarray(start, end + 1) });
}

try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
    sessionStorage.setItem('entered_app', '1');
  }, { token, user });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) { state.externalRequests.push({ method, url: url.href }); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(method)) { state.blockedWrites.push({ method, path: url.pathname }); return route.abort('blockedbyclient'); }
      return route.continue();
    }
    // Chromium cancels direct attachment navigations fulfilled through
    // Playwright route.fulfill. A scoped CDP responder below handles this one
    // endpoint at the network layer, preserving the production streaming UI.
    if (url.pathname === '/api/video/proxy-download') return route.continue();
    report.fixtureRequests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (/\/api\/video\/(generate|stream|submit|reference-upload)/u.test(url.pathname)) { state.generationRequests.push({ method, path: url.pathname }); return json(route, { error: 'Generation forbidden by acceptance' }, 409); }
    if (!['GET', 'HEAD'].includes(method)) { state.blockedWrites.push({ method, path: url.pathname }); return route.abort('blockedbyclient'); }
    if (url.pathname === '/api/auth/me') return json(route, { user });
    if (url.pathname === '/api/media-history') {
      state.historyReads++;
      assert.equal((await request.allHeaders()).authorization, `Bearer ${token}`);
      const category = url.searchParams.get('category') || 'all', kind = url.searchParams.get('kind') || 'all', q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 60);
      assert.equal(limit, 60); assert.ok(Number.isInteger(offset) && offset >= 0);
      const filtered = items.filter(item => (category === 'all' || item.categoryKey === category) && (kind === 'all' || item.kind === kind)
        && (!q || [item.id, item.title, item.project, item.segment, item.source, item.publicModelName].join(' ').toLowerCase().includes(q)));
      const pageItems = filtered.slice(offset, offset + limit), nextOffset = offset + pageItems.length < filtered.length ? offset + limit : null;
      return json(route, {
        items: pageItems, total: filtered.length, totalCount: filtered.length, nextOffset, serverTime: new Date().toISOString(), expiredCount: 0, sourceFailures: [],
        pagination: { total: filtered.length, limit, offset, nextOffset, hasMore: nextOffset !== null },
        facets: { categories: { all: filtered.length, 'video-production': filtered.length }, kinds: { all: filtered.length, video: filtered.length, image: 0 } },
      });
    }
    if (url.pathname === '/api/video/history') return json(route, { tasks: [], total: 0, nextOffset: null, retentionDays: 5, serverTime: new Date().toISOString() });
    if (url.pathname === '/api/video/access-ticket') {
      const headers = await request.allHeaders(), task = url.searchParams.get('taskId'), scope = url.searchParams.get('scope') || 'playback';
      assert.equal(headers.authorization, `Bearer ${token}`);
      assert.ok(items.some(item => item.id === `video:${task}`), 'ticket requested for a fixture task');
      assert.ok(['playback', 'download'].includes(scope));
      state.tickets.push({ task, scope });
      const target = scope === 'download' ? '/api/video/proxy-download' : '/api/video/proxy';
      return json(route, { url: `${target}?taskId=${encodeURIComponent(task)}&media_ticket=fixture-${state.tickets.length}` });
    }
    if (url.pathname === '/api/video/proxy' || url.pathname === '/api/video/proxy-download') return mediaResponse(route, url.pathname === '/api/video/proxy-download');
    if (url.pathname.startsWith('/api/video/thumbnail/')) {
      state.thumbnailRequests++;
      assert.ok(items.some(item => item.thumbnailPath === url.pathname));
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'cache-control': 'no-store' }, body: posterSvg });
    }
    if (['/api/settings/appearance', '/api/settings'].includes(url.pathname)) return json(route, { settings: { theme: 'soft-white', theme_mode: 'light' } });
    if (url.pathname === '/api/member-permissions') return json(route, { permission: { userId: user.id, role: 'admin', featureNavigationKeys: ['marketplace', 'toolbox', 'storyboard_workbench', 'image_workbench', 'create', 'voice', 'cover'], agentNavigationKeys: [], integrityValid: true, authorityStatus: 'admin', revision: 1 } });
    if (url.pathname === '/api/storyboard/projects') return json(route, { projects: [], nextOffset: null });
    if (url.pathname === '/api/video/active-tasks') return json(route, { activeTasks: [] });
    if (['/api/cash/balance', '/api/credits'].includes(url.pathname)) return json(route, { credits: 1000, cashBalance: 1000, balance: 1000, transactions: [] });
    if (url.pathname === '/api/announcements/inbox') return json(route, { announcements: [], cursor: '' });
    if (url.pathname === '/api/popup-pushes') return json(route, { success: true, popups: [] });
    return json(route, { settings: {}, tasks: [], records: [], projects: [], bots: [], agents: [], models: [], assets: [], items: [], notifications: [], unreadCount: 0, nextOffset: null });
  });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.pageErrors.push(error.message.slice(0, 1000)));
  const cdp = await context.newCDPSession(page);
  cdp.on('Fetch.requestPaused', async event => {
    const url = new URL(event.request.url);
    if (url.origin !== origin || url.pathname !== '/api/video/proxy-download') {
      await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' });
      return;
    }
    const headers = event.request.headers || {};
    assert.equal(event.request.method, 'GET');
    assert.ok(!headers.authorization && !headers.Authorization, 'account token must not enter attachment requests');
    assert.ok(url.searchParams.get('media_ticket'), 'download-scoped media ticket required');
    report.fixtureRequests.push({ method: 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), transport: 'cdp' });
    state.mediaRequests.push({ path: url.pathname, range: null, download: true, transport: 'cdp' });
    await cdp.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'content-type', value: 'video/mp4' },
        { name: 'content-length', value: String(bytes.length) },
        { name: 'cache-control', value: 'no-store' },
        { name: 'content-disposition', value: 'attachment; filename="fixture-16s.mp4"' },
      ],
      body: bytes.toString('base64'),
    });
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*\/api/video/proxy-download*' }] });

  await stage('runtime identity and source binding', async () => {
    const response = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    report.runtime = await response.json();
    report.sourceSha256 = Object.fromEntries(await Promise.all([
      'src/components/media-history-workspace.tsx', 'src/components/media-history-video-preview.tsx',
      'src/lib/media-history-video-preview.ts', 'scripts/verify-video-history-lifecycle-browser.mjs',
    ].map(async file => [file, sha(await fs.readFile(path.join(root, file)))])));
    return { buildId: report.runtime.buildId || report.runtime.build_id || report.runtime.version || null };
  });
  await stage('open current unified history and restore fixture items', async () => {
    await openHistory();
    check('current workspace root replaces retired sbh panel', await page.locator('.media-history-page').count() === 1 && await page.locator('.sbh-panel').count() === 0);
    check('completed item exposes preview action', await page.getByRole('button', { name: `预览${mainTitle}`, exact: true }).isVisible());
    check('history API uses current account token', state.historyReads > 0 && report.fixtureRequests.some(row => row.path === '/api/media-history'));
    await snapshot('current-history-first-page');
    return { historyReads: state.historyReads, firstPageItems: 60 };
  });
  await stage('pagination search empty state and manual refresh', async () => {
    const more = page.getByRole('button', { name: /加载更多/u });
    await more.waitFor(); await more.click();
    await page.getByRole('button', { name: '预览分页恢复作品 60', exact: true }).waitFor();
    check('second page appends the sixtieth additional record', state.historyReads >= 2 && await page.getByRole('button', { name: '预览分页恢复作品 60', exact: true }).count() === 1);
    const search = page.getByRole('textbox', { name: '搜索作品历史', exact: true });
    await search.fill('绝无匹配结果-EMPTY'); await page.getByRole('heading', { name: '没有匹配的作品', exact: true }).waitFor();
    check('unmatched search renders the real empty state', await page.getByRole('heading', { name: '没有匹配的作品', exact: true }).isVisible());
    await search.fill(mainTask);
    await page.waitForFunction(() => document.querySelectorAll('section[aria-label="作品历史列表"] article').length === 1);
    check('server-side search restores the matching record', await page.getByRole('button', { name: `预览${mainTitle}`, exact: true }).count() === 1);
    await search.fill(''); await page.getByRole('button', { name: `预览${mainTitle}`, exact: true }).waitFor();
    const before = state.historyReads;
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/media-history' && response.request().method() === 'GET', { timeout: 30000 });
    await page.getByRole('button', { name: '刷新', exact: true }).click(); await refreshed;
    await page.getByRole('button', { name: `预览${mainTitle}`, exact: true }).waitFor();
    check('manual refresh issues a new current-history read', state.historyReads > before);
    await snapshot('current-history-refreshed');
    return { historyReads: state.historyReads };
  });
  await stage('native H264 first frame play pause and seek', async () => {
    const { video } = await openPreview();
    check('native video decodes real H264 metadata', await video.evaluate(element => element.readyState >= 2 && element.videoWidth === 320 && element.videoHeight === 180));
    check('video uses metadata preload without autoplay', await video.getAttribute('preload') === 'metadata' && await video.getAttribute('autoplay') === null);
    check('native media uses Range and keeps account token out of URL', state.mediaRequests.some(row => row.range) && state.mediaRequests.every(row => !row.path.includes(token)));
    await video.evaluate(element => element.play());
    await page.waitForFunction(() => { const video = document.querySelector('dialog video'); return video && !video.paused && video.currentTime > 0.2; });
    await video.evaluate(element => element.pause());
    check('play and pause control the real media element', await video.evaluate(element => element.paused && element.currentTime > 0));
    await video.evaluate(element => { element.currentTime = 13; });
    await page.waitForFunction(() => { const video = document.querySelector('dialog video'); return video && video.currentTime >= 12.8 && video.seeking === false; });
    check('seek reaches the requested later frame', await video.evaluate(element => element.currentTime >= 12.8 && element.paused));
    await snapshot('current-history-native-preview');
    return { rangeRequests: state.mediaRequests.filter(row => row.range).length, tickets: state.tickets.length };
  });
  await stage('download original MP4 and verify SHA256', async () => {
    const dialog = page.getByRole('dialog', { name: mainTitle, exact: true });
    const pending = page.waitForEvent('download', { timeout: 45000 });
    await dialog.getByRole('button', { name: '下载到电脑', exact: true }).click();
    const download = await pending, target = path.join(output, 'downloaded-16s.mp4');
    const failure = await download.failure();
    report.downloadDebug = { url: download.url(), suggestedFilename: download.suggestedFilename(), failure };
    assert.equal(failure, null, `browser download failed before save: ${failure}`);
    await download.saveAs(target);
    const downloaded = await fs.readFile(target);
    check('download is a complete MP4 attachment', download.suggestedFilename().endsWith('.mp4') && downloaded.length === bytes.length);
    check('downloaded bytes match original SHA256', sha(downloaded) === mediaSha, { expected: mediaSha, actual: sha(downloaded) });
    check('download performs playback preflight and download-scoped ticket', state.tickets.some(row => row.scope === 'download') && state.mediaRequests.some(row => row.download));
    report.download = { file: target, bytes: downloaded.length, sha256: sha(downloaded), suggestedFilename: download.suggestedFilename() };
    await dialog.getByRole('button', { name: '关闭预览', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    return report.download;
  });
  await stage('reload restores current history from API and layout stays within viewport', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await page.getByRole('button', { name: `预览${mainTitle}`, exact: true }).waitFor({ timeout: 45000 });
    check('page reload restores the completed item through media-history', await page.getByRole('button', { name: `预览${mainTitle}`, exact: true }).isVisible());
    check('1440 desktop has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1920, height: 1080 });
    check('1920 desktop has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await snapshot('current-history-1920-restored');
    await page.getByRole('button', { name: /返回.*视频/u }).click();
    await page.locator('.media-history-page').waitFor({ state: 'hidden' });
    check('return control restores the video workbench', await page.locator('.media-history-page').count() === 0);
  });
  await stage('zero paid generation zero writes and no browser exceptions', async () => {
    check('no generation request was attempted', state.generationRequests.length === 0 && report.actualProviderCalls === 0 && report.paidCalls === 0);
    check('no API or non-API write was attempted', state.blockedWrites.length === 0 && report.actualServerWrites === 0);
    check('no uncaught browser exceptions', report.pageErrors.length === 0, report.pageErrors);
    check('all history preview and download responses were isolated fixtures', report.fixtureRequests.every(row => row.path.startsWith('/api/')));
    report.state = state;
    report.passed = report.stages.every(item => item.passed) && report.checks.every(item => item.passed);
  });
} catch (error) {
  report.error = String(error.stack || error.message).slice(0, 4000);
  report.state = state;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await saveReport();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, stages: report.stages.length, screenshots: report.screenshots.length, actualServerWrites: report.actualServerWrites, actualProviderCalls: report.actualProviderCalls, paidCalls: report.paidCalls, output, error: report.error?.split('\n')[0] }));
}
