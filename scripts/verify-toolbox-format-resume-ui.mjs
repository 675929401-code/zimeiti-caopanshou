import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
if (!args.includes('--execute')) {
  console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, command: 'node scripts/verify-toolbox-format-resume-ui.mjs --execute --run-id=toolbox-text-buttons-20260903-01', scope: 'Open the original owned failed formatter record in normal UI, reformat it once, verify refresh starts blank, then reopen the corrected result from history. One normal history append; original history and failure remain. No extraction or semantic calls, no delete or update.' }, null, 2));
  process.exit(0);
}
const runId = args.find(value => value.startsWith('--run-id='))?.slice(9);
assert.ok(runId && /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/u.test(runId), 'ORIGINAL_RUN_REQUIRED');
const out = path.resolve('.codex-evidence/toolbox-text-buttons-real-e2e-20260903', runId);
const oldBytes = await fs.readFile(path.join(out, 'execute.json'));
const prior = JSON.parse(oldBytes);
assert.equal(prior.runId, runId); assert.equal(prior.failure, 'FORMATTED_TEXT_DOES_NOT_MATCH_ENABLED_RULES');
assert.equal(prior.historyMutation?.state, 'responded'); assert.equal(prior.historyMutation.status, 200);
const oldRecordId = prior.historyMutation.recordId;
const expected = prior.stages.format.expected;
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'LOCAL_PREVIEW_ONLY');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'NORMAL_ADMIN_SESSION_REQUIRED');
const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.supabaseUrl.replace(/\/$/u, ''), 'http://127.0.0.1:54321');
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clean = value => String(value || '').split(token).join('[redacted]').split(runtime.serviceRoleKey).join('[redacted]').replace(/https?:\/\/\S+/gu, '[url]').slice(0, 600);
const reportPath = path.join(out, 'resume-format-1.json'), markerPath = path.join(out, 'formatter-fix.dispatch.json');
const report = { originalRun: runId, origin, at: new Date().toISOString(), passed: false, originalRecordId: oldRecordId, originalReportSha256: sha(oldBytes), historyPosts: 0, generationRequests: 0, historyDeletes: 0, pageErrors: [], blocked: [] };
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const api = async route => { const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) }); return { status: response.status, body: await response.json() }; };
const rows = async (table, select, filters) => {
  const url = new URL(`${runtime.supabaseUrl}/rest/v1/${table}`); url.searchParams.set('select', select);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` }, signal: AbortSignal.timeout(15000) });
  const body = await response.json(); assert.ok(response.ok && Array.isArray(body), `LOCAL_READ_${table}_FAILED`); return body;
};
let browser, page, fatal, marker;
const wait = async (callback, label, timeout = 45000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (fatal) throw fatal; if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 120)); } throw Error(`WAIT_FAILED_${label}`); };
const preview = value => { const clean = value.replace(/\n/g, ' ').trim(); return clean.length > 60 ? clean.slice(0, 60) + '...' : clean; };
try {
  try { await fs.access(markerPath); throw Error('EXISTING_FIX_MARKER_READ_ONLY_RECONCILE_REQUIRED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const me = await api('/api/auth/me'); assert.ok(me.status === 200 && me.body.user?.role === 'admin'); const user = me.body.user;
  const historyBefore = await rows('formatter_history', 'id,original_text,result_text', { user_id: `eq.${user.id}`, order: 'id.asc', limit: '10000' });
  const listed = await api('/api/formatter/history'); assert.equal(listed.status, 200);
  const original = listed.body.records.find(record => record.id === oldRecordId);
  assert.ok(original && original.result_text === prior.stages.format.actual, 'ORIGINAL_OWNED_RECORD_REQUIRED');
  assert.equal(sha(original.original_text), prior.historyMutation.inputSha256);
  report.previousHistoryCount = historyBefore.length; report.previousHistoryDigest = sha(historyBefore);
  report.balanceBefore = (await rows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0];
  browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
  await context.addInitScript(({ origin, token, user }) => { if (location.origin === origin) { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); } }, { origin, token, user });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
    try {
      assert.equal(url.origin, origin); assert.equal(url.pathname, '/api/formatter/history'); assert.equal(method, 'POST');
      assert.equal(report.historyPosts, 0, 'ONE_CORRECTED_HISTORY_SAVE_ONLY');
      assert.equal(request.headers().authorization, `Bearer ${token}`); const body = request.postDataJSON();
      assert.equal(body.original_text, original.original_text); assert.equal(body.result_text, expected, 'CORRECTED_RULES_REQUIRED_BEFORE_SAVE');
      assert.deepEqual(body.rules, original.rules, 'SAME_ENABLED_RULES_REQUIRED');
      report.historyPosts++;
      marker = { originalRun: runId, originalRecordId: oldRecordId, state: 'dispatched', at: new Date().toISOString(), inputSha256: sha(body.original_text), resultSha256: sha(body.result_text) };
      await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), { flag: 'wx' }); await save();
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 30000 }); const data = await response.json();
      Object.assign(marker, { state: 'responded', status: response.status(), recordId: data.record?.id || null }); report.mutation = marker;
      await fs.writeFile(markerPath, JSON.stringify(marker, null, 2)); await save(); return route.fulfill({ response });
    } catch (error) {
      if (/generate|extract|semantic|chat|llm/u.test(url.pathname)) report.generationRequests++;
      if (method === 'DELETE') report.historyDeletes++;
      report.blocked.push({ method, path: url.origin === origin ? url.pathname : '[external]' }); fatal = Error(clean(error.message)); return route.abort();
    }
  });
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(clean(error.message)));
  await page.goto(origin + '/tools?tab=format', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const panel = page.locator('[role="tabpanel"]:visible');
  await panel.getByRole('button', { name: '历史记录', exact: true }).click();
  await panel.getByText(preview(original.result_text), { exact: true }).click();
  const input = panel.locator('textarea:not([readonly])'), output = panel.locator('textarea[readonly]');
  await wait(async () => await input.inputValue() === original.original_text && await output.inputValue() === original.result_text, 'original-history-restore');
  report.originalRestored = true;
  await panel.getByRole('button', { name: '开始排版', exact: true }).click();
  await wait(() => marker?.state === 'responded', 'corrected-history-receipt'); assert.equal(marker.status, 200);
  assert.equal(await output.inputValue(), expected); report.outputMatchesExpected = true;
  await panel.getByRole('button', { name: '一键复制', exact: true }).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected); report.copied = true;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await wait(async () => await input.inputValue() === '' && await output.count() === 0, 'corrected-refresh-blank'); report.refreshedBlank = true;
  await panel.getByRole('button', { name: '历史记录', exact: true }).click();
  await panel.getByText(preview(expected), { exact: true }).click();
  await wait(async () => await input.inputValue() === original.original_text && await output.inputValue() === expected, 'corrected-history-restore'); report.historyRestored = true;
  const historyAfter = await rows('formatter_history', 'id,original_text,result_text', { user_id: `eq.${user.id}`, order: 'id.asc', limit: '10000' });
  const corrected = historyAfter.find(record => record.id === marker.recordId); assert.ok(corrected && corrected.original_text === original.original_text && corrected.result_text === expected);
  assert.deepEqual(historyAfter.filter(record => record.id !== marker.recordId), historyBefore); report.allPreviousHistoryUnchanged = true;
  assert.equal(sha(await fs.readFile(path.join(out, 'execute.json'))), report.originalReportSha256); report.originalFailurePreserved = true;
  report.balanceAfter = (await rows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0]; assert.deepEqual(report.balanceAfter, report.balanceBefore);
  assert.equal(report.historyPosts, 1); assert.equal(report.generationRequests, 0); assert.equal(report.historyDeletes, 0); assert.equal(report.pageErrors.length, 0);
  await panel.screenshot({ path: path.join(out, 'formatter-fixed.png') }); report.passed = true;
} catch (error) { report.failure = clean(error.message); process.exitCode = 1; if (page) await page.screenshot({ path: path.join(out, 'formatter-resume-failure.png'), fullPage: true }).catch(() => undefined); }
finally { if (browser) await browser.close(); await save(); }
console.log(JSON.stringify({ passed: report.passed, report: reportPath, historyPosts: report.historyPosts, generationRequests: report.generationRequests, failure: report.failure }));
