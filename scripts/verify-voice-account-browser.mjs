import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!args.includes('--execute')) {
  console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, command: 'node scripts/verify-voice-account-browser.mjs --execute --run-id=<unique>',
    environment: 'LOCAL_NAV_ORIGIN=127.0.0.1:5000 or 5002; LOCAL_NAV_ACCOUNT_A_TOKEN / LOCAL_NAV_ACCOUNT_B_TOKEN (normal existing sessions only)',
    checks: 'Real local page and normal read-only APIs; cross-tab A/B/logout; ephemeral drafts/favorite cache/task-bar fixtures; late original A favorite GET released after B; no generation, preview, favorites mutation or server logout.' }, null, 2));
  process.exit(0);
}
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'LOCAL_PREVIEW_ONLY');
const tokenA = process.env.LOCAL_NAV_ACCOUNT_A_TOKEN || process.env.LOCAL_NAV_ADMIN_TOKEN;
const tokenB = process.env.LOCAL_NAV_ACCOUNT_B_TOKEN || process.env.LOCAL_NAV_USER_TOKEN;
assert.ok(tokenA && tokenB && tokenA !== tokenB, 'TWO_DIFFERENT_NORMAL_SESSIONS_REQUIRED');
const runId = arg('run-id'); assert.ok(runId && /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/u.test(runId), 'UNIQUE_RUN_ID_REQUIRED');
const out = path.resolve('.codex-evidence/voice-account-scope-20260903', runId); await fs.mkdir(out, { recursive: true });
const reportPath = path.join(out, 'execute.json');
const report = { runId, origin, at: new Date().toISOString(), passed: false, stages: [], generationRequests: 0, blockedWrites: [], pageErrors: [], ownerApiReads: { A: {}, B: {} }, ephemeralStorageOnly: true };
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const clean = value => String(value || '').split(tokenA).join('[redacted]').split(tokenB).join('[redacted]').replace(/https?:\/\/\S+/gu, '[url]').slice(0, 500);
const api = async (pathname, token) => {
  const response = await fetch(origin + pathname, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `NORMAL_READ_${pathname}_REQUIRED`); return response.json();
};
const ordered = values => [...values].sort();
let browser, context, page, control, fatal, releaseA, delayedAReady = false, delayedAReleased = false;
const wait = async (check, label, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (fatal) throw fatal; if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error(`WAIT_FAILED_${label}`); };
const stage = async (name, detail) => { report.stages.push({ name, ...detail }); await save(); };
try {
  const [a, b, favoritesA, favoritesB] = await Promise.all([api('/api/auth/me', tokenA), api('/api/auth/me', tokenB), api('/api/voice/favorites', tokenA), api('/api/voice/favorites', tokenB)]);
  assert.ok(a.user?.id && b.user?.id && a.user.id !== b.user.id, 'DISTINCT_CURRENT_DATABASE_ACCOUNTS_REQUIRED');
  const idsA = (favoritesA.favorites || []).map(row => row.voice_id), idsB = (favoritesB.favorites || []).map(row => row.voice_id);
  report.normalAccounts = { bothVerified: true, differentUsers: true, accountAAdmin: a.user.role === 'admin', accountBAdmin: b.user.role === 'admin' };
  const ownerKey = (base, userId) => `${base}:user:${encodeURIComponent(userId.trim())}`;
  const keys = { favoritesA: ownerKey('vs_favorites', a.user.id), favoritesB: ownerKey('vs_favorites', b.user.id), taskA: ownerKey('tts_running_task', a.user.id), taskB: ownerKey('tts_running_task', b.user.id),
    pendingA: `production-client-attempt:v1:${ownerKey('voice-workspace:single', a.user.id)}`, pendingB: `production-client-attempt:v1:${ownerKey('voice-workspace:single', b.user.id)}` };
  const textA = 'ACCOUNT_A_VOICE_TEXT_SHOULD_NOT_LEAK', textB = 'ACCOUNT_B_OWN_VOICE_DRAFT';
  const taskA = { ownerUserId: a.user.id, taskId: `ephemeral-A-${runId}`, text: 'VOICE_A_TASK_SENTINEL', speaker: '本地 A 归属探针', startTime: Date.now(), page: '/voice-studio/workspace' };
  const taskB = { ownerUserId: b.user.id, taskId: `ephemeral-B-${runId}`, text: 'VOICE_B_TASK_SENTINEL', speaker: '本地 B 归属探针', startTime: Date.now(), page: '/voice-studio/workspace' };
  browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  await context.addInitScript(({ origin, token, user, keys, idsA, idsB, taskA }) => {
    if (location.origin !== origin || localStorage.getItem('__voice_account_readonly_fixture')) return;
    localStorage.setItem('__voice_account_readonly_fixture', '1'); localStorage.setItem('auth_user', JSON.stringify(user)); localStorage.setItem('auth_token', token); sessionStorage.setItem('entered_app', '1');
    localStorage.setItem(keys.favoritesA, JSON.stringify(idsA)); localStorage.setItem(keys.favoritesB, JSON.stringify(idsB)); localStorage.setItem('vs_favorites', '["UNOWNED_LEGACY_FAVORITE"]');
    localStorage.setItem(keys.taskA, JSON.stringify(taskA)); localStorage.setItem('tts_running_task', JSON.stringify({ ...taskA, ownerUserId: undefined, text: 'UNOWNED_LEGACY_TASK' }));
    localStorage.setItem(keys.pendingA, 'EPHEMERAL_UNRESOLVED_A_BYTES'); localStorage.setItem(keys.pendingB, 'EPHEMERAL_UNRESOLVED_B_BYTES');
  }, { origin, token: tokenA, user: a.user, keys, idsA, idsB, taskA });
  const delayedA = new Promise(resolve => { releaseA = resolve; }); let heldOnce = false;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && url.pathname === '/__codex_voice_account_control__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Temporary same-origin storage controller</title>' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      if (/\/api\/(?:voice\/tts|voice\/preview|.*generate)/u.test(url.pathname)) report.generationRequests++;
      report.blockedWrites.push({ method: request.method(), path: url.origin === origin ? url.pathname : '[external]' }); fatal = Error('READ_ONLY_ACCOUNT_RUNNER_BLOCKED_WRITE'); await save(); return route.abort();
    }
    if (!heldOnce && url.origin === origin && url.pathname === '/api/voice/favorites' && request.headers().authorization === `Bearer ${tokenA}`) {
      heldOnce = true;
      try { const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 30000 }); assert.equal(response.status(), 200); delayedAReady = true; await delayedA;
        await route.fulfill({ response }); delayedAReleased = true; return;
      } catch (error) { fatal = Error(clean(error.message)); return route.abort().catch(() => undefined); }
    }
    return route.continue();
  });
  context.on('response', response => {
    const request = response.request(), url = new URL(request.url());
    if (url.origin !== origin || !['/api/auth/me', '/api/voice/history', '/api/voice/favorites'].includes(url.pathname)) return;
    const auth = request.headers().authorization, owner = auth === `Bearer ${tokenA}` ? 'A' : auth === `Bearer ${tokenB}` ? 'B' : null;
    if (owner) { const entry = report.ownerApiReads[owner][url.pathname] || { count: 0, statuses: [] }; entry.count++; if (!entry.statuses.includes(response.status())) entry.statuses.push(response.status()); report.ownerApiReads[owner][url.pathname] = entry; }
  });
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(clean(error.message)));
  await page.goto(origin + '/voice-studio/workspace', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const input = () => page.getByPlaceholder('输入要合成的文本内容...');
  await input().waitFor({ timeout: 45000 }); await wait(() => delayedAReady, 'original-A-favorite-GET-held');
  await input().fill(textA); await wait(async () => (await page.locator('body').innerText()).includes(taskA.text), 'A-task-bar');
  assert.ok(!(await page.locator('body').innerText()).includes('UNOWNED_LEGACY_TASK'));
  await page.getByRole('button', { name: '生成历史', exact: true }).click();
  await wait(() => report.ownerApiReads.A['/api/voice/history']?.statuses.includes(200), 'A-normal-history-read');
  await page.getByRole('button', { name: '收起生成历史', exact: true }).click();
  await page.locator('.secondary-workbench').screenshot({ path: path.join(out, 'account-a-draft.png') });
  await stage('account-A', { ownDraft: true, ownTaskBar: true, legacyTaskHidden: true, originalFavoritesGetHeldForLateResponse: true });
  control = await context.newPage(); await control.goto(origin + '/__codex_voice_account_control__', { waitUntil: 'domcontentloaded' });
  const switchAccount = async (token, user) => control.evaluate(({ token, user }) => { if (token) { localStorage.setItem('auth_user', JSON.stringify(user)); localStorage.setItem('auth_token', token); } else { localStorage.removeItem('auth_user'); localStorage.removeItem('auth_token'); } }, { token, user });
  await switchAccount(tokenB, b.user);
  await input().waitFor({ timeout: 45000 }); await wait(async () => await input().inputValue() === '', 'A-draft-cleared-for-B');
  await page.getByRole('button', { name: '生成历史', exact: true }).click();
  await wait(() => report.ownerApiReads.B['/api/voice/history']?.statuses.includes(200), 'B-normal-history-read');
  await page.getByRole('button', { name: '收起生成历史', exact: true }).click();
  assert.ok(!(await page.locator('body').innerText()).includes(taskA.text));
  await wait(async () => ordered(JSON.parse(await page.evaluate(key => localStorage.getItem(key), keys.favoritesB) || '[]')).join('\0') === ordered(idsB).join('\0'), 'B-own-favorite-cache');
  await input().fill(textB);
  await control.evaluate(({ key, task }) => localStorage.setItem(key, JSON.stringify(task)), { key: keys.taskB, task: taskB });
  await wait(async () => (await page.locator('body').innerText()).includes(taskB.text), 'B-own-task-bar');
  await stage('switch-to-B', { normalHistoryUsesB: true, previousDraftCleared: true, BOwnDraftEntered: true, previousTaskHidden: true, ownTaskShown: true, ownFavoritesMatchNormalAPI: true, favoriteCount: idsB.length });
  await control.evaluate(({ keys, task }) => { localStorage.setItem(keys.favoritesA, '["LATE_A_CACHE_SENTINEL"]'); localStorage.setItem(keys.taskA, JSON.stringify({ ...task, text: 'LATE_A_TASK_EVENT' })); }, { keys, task: taskA });
  await page.evaluate(() => window.dispatchEvent(new Event('tts_task_update')));
  releaseA(); await wait(() => delayedAReleased, 'A-delayed-GET-release');
  await wait(async () => ordered(JSON.parse(await page.evaluate(key => localStorage.getItem(key), keys.favoritesA) || '[]')).join('\0') === ordered(idsA).join('\0'), 'A-late-response-only-writes-A-cache');
  assert.equal(await input().inputValue(), textB); const afterLate = await page.locator('body').innerText();
  assert.ok(afterLate.includes(taskB.text) && !afterLate.includes('LATE_A_TASK_EVENT'));
  assert.deepEqual(ordered(JSON.parse(await page.evaluate(key => localStorage.getItem(key), keys.favoritesB) || '[]')), ordered(idsB));
  const pending = await page.evaluate(keys => ({ a: localStorage.getItem(keys.pendingA), b: localStorage.getItem(keys.pendingB) }), keys);
  assert.deepEqual(pending, { a: 'EPHEMERAL_UNRESOLVED_A_BYTES', b: 'EPHEMERAL_UNRESOLVED_B_BYTES' });
  await stage('late-A-events', { realOriginalReadResponseReleasedAfterB: true, BTextUnchanged: true, BFavoriteCacheUnchanged: true, lateATaskHidden: true, ownerAttemptBytesRetained: true, generationWasNotStarted: true });
  await page.getByRole('button', { name: 'seed-audio 1.0', exact: true }).click();
  assert.equal(await page.getByLabel('模型版本', { exact: true }).inputValue(), 'seed-audio-1.0');
  assert.equal(await page.getByLabel('选择音色搜索', { exact: true }).count(), 0); assert.equal(await page.locator('input[type="range"]').count(), 0); assert.equal(await page.locator('input[type="checkbox"]').count(), 0);
  assert.deepEqual(await page.locator('.secondary-workbench select').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['模型版本', '音频格式', '采样率']);
  await page.locator('.secondary-workbench').screenshot({ path: path.join(out, 'account-b-audio-controls.png') });
  await page.getByRole('button', { name: 'Doubao-TTS 2.0', exact: true }).click(); assert.equal(await input().inputValue(), textB);
  await stage('B-audio-mode', { noInertTTSPicker: true, noInertTTSSliders: true, noInertTTSCheckboxes: true, onlyActualModelFormatSampleRate: true, ownTTSDraftPreservedAcrossModes: true });
  const aReadsBefore = report.ownerApiReads.A['/api/voice/history']?.count || 0;
  await switchAccount(tokenA, a.user);
  await input().waitFor({ timeout: 45000 }); await wait(async () => await input().inputValue() === '', 'B-draft-not-read-by-returning-A');
  await page.getByRole('button', { name: '生成历史', exact: true }).click();
  await wait(() => (report.ownerApiReads.A['/api/voice/history']?.count || 0) > aReadsBefore, 'return-A-normal-history-read');
  await page.getByRole('button', { name: '收起生成历史', exact: true }).click();
  await wait(async () => (await page.locator('body').innerText()).includes('LATE_A_TASK_EVENT'), 'A-owner-task-restored');
  assert.ok(!(await page.locator('body').innerText()).includes(taskB.text));
  await stage('return-to-A', { normalOwnerReadRestored: true, BTextNotVisible: true, BTaskNotVisible: true, AOwnedTaskVisible: true, draftPolicy: 'Owner change clears in-memory text; no cross-account restoration.' });
  await switchAccount(null, null); await page.getByText('请登录后使用智音工坊', { exact: true }).waitFor({ timeout: 45000 });
  assert.equal(await page.locator('textarea').count(), 0); const loggedOut = await page.locator('body').innerText();
  assert.ok(!loggedOut.includes('LATE_A_TASK_EVENT') && !loggedOut.includes(taskB.text) && !loggedOut.includes('UNOWNED_LEGACY_TASK'));
  assert.deepEqual(await page.evaluate(keys => ({ a: localStorage.getItem(keys.pendingA), b: localStorage.getItem(keys.pendingB) }), keys), pending);
  await stage('logout', { workspacePrivateInputsHidden: true, allTaskBarsHidden: true, unresolvedOwnerBytesRetained: true, serverLogoutNotCalled: true });
  assert.equal(report.generationRequests, 0); assert.equal(report.blockedWrites.length, 0); assert.equal(report.pageErrors.length, 0); report.passed = true;
} catch (error) { report.failure = clean(error.message); process.exitCode = 1; }
finally { releaseA?.(); if (browser) await browser.close(); await save(); }
console.log(JSON.stringify({ passed: report.passed, report: reportPath, stages: report.stages.length, generationRequests: report.generationRequests, failure: report.failure }));
