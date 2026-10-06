import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const args = process.argv.slice(2), execute = args.includes('--execute');
const recordId = 'bbce363d3017b896794e970dbf737cf329516a5d7d2485c60c7da100d0a1a4c6';
if (!execute) {
  console.log(JSON.stringify({ mode: 'plan', networkRequests: 0, command: 'node scripts/verify-toolbox-format-transfer-ui.mjs --execute --run-id=<unique-run>',
    scope: 'Restore this owner\'s already-succeeded text, consume send-to-segment once, verify refresh starts blank; one local formatter action/history save/copy/history restore. No extraction, semantic generation, history deletion, or provider request.', recordId }, null, 2)); process.exit(0);
}
const runId = args.find(value => value.startsWith('--run-id='))?.slice(9);
assert.ok(runId && /^[A-Za-z0-9][A-Za-z0-9_-]{5,80}$/u.test(runId));
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000'; assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin));
const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'NORMAL_ADMIN_SESSION_REQUIRED');
const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.supabaseUrl.replace(/\/$/u, ''), 'http://127.0.0.1:54321');
// Do not open the old GET implementation that deletes historical rows.
const historySource = await fs.readFile('src/app/api/formatter/history/route.ts', 'utf8');
assert.ok(!historySource.slice(historySource.indexOf('export async function GET'), historySource.indexOf('export async function POST')).includes('.delete()'), 'READ_ONLY_HISTORY_SOURCE_REQUIRED');
const out = path.resolve('.codex-evidence/toolbox-text-buttons-real-e2e-20260903', runId); await fs.mkdir(out, { recursive: true });
const reportPath = path.join(out, 'execute.json');
const report = { runId, origin, at: new Date().toISOString(), passed: false, generationRequests: 0, historyPosts: 0, historyDeletes: 0, pageErrors: [], blocked: [], stages: {},
  source: { recordId, origin: 'Owned succeeded exact-once response restored into this fresh browser only; no provider replay' } };
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clean = value => String(value || '').split(token).join('[redacted]').split(runtime.serviceRoleKey).join('[redacted]').replace(/https?:\/\/\S+/gu, '[url]').slice(0, 600);
const api = async pathname => { const response = await fetch(origin + pathname, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) }); return { status: response.status, body: await response.json() }; };
const rows = async (table, select, filters) => {
  const url = new URL(`${runtime.supabaseUrl}/rest/v1/${table}`); url.searchParams.set('select', select);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` }, signal: AbortSignal.timeout(15000) });
  const data = await response.json(); assert.ok(response.ok && Array.isArray(data), `LOCAL_READ_${table}_FAILED`); return data;
};
const input = `${runId}\n  清 晨 的 书 店 开 门 了。 \n\n\t读 者 走 进 店 里。  \n  把 今 天 的 灵 感 记 下 来。`;
const expected = `${runId}清晨的书店开门了。读者走进店里。把今天的灵感记下来。`;
let browser, page, fatal, mutation;
const wait = async (fn, label, timeout = 45000) => { const started = Date.now(); while (Date.now() - started < timeout) { if (fatal) throw fatal; if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 150)); } throw Error(`WAIT_FAILED_${label}`); };
try {
  const me = await api('/api/auth/me'); assert.ok(me.status === 200 && me.body.user?.role === 'admin'); const user = me.body.user;
  const [completed] = await rows('extraction_attempts', 'record_id,state,http_status,response,created_at', { record_id: `eq.${recordId}`, user_id: `eq.${user.id}`, limit: '1' });
  assert.ok(completed?.state === 'succeeded' && completed.http_status === 200);
  const textItem = completed.response?.texts?.find(item => item.success !== false && (item.corrected_content || item.content));
  const transcript = textItem?.corrected_content || textItem?.content; assert.ok(transcript?.length > 100, 'REAL_TRANSCRIPT_REQUIRED');
  report.source.textLength = transcript.length; report.source.textSha256 = sha(transcript);
  const oldRecords = await rows('formatter_history', 'id,original_text,result_text', { user_id: `eq.${user.id}`, order: 'id.asc', limit: '10000' });
  report.previousHistoryCount = oldRecords.length; report.previousHistoryDigest = sha(oldRecords);
  report.balanceBefore = (await rows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0];
  const recovery = { id: `completed-${recordId}`, url: 'https://v.douyin.com/h1wY2hTAbmM/', platform: '抖音', mode: 'text', timestamp: Date.parse(completed.created_at), status: 'success', result: completed.response };
  assert.ok(recovery.timestamp > Date.now() - 7 * 86400000);
  browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
  await context.addInitScript(({ origin, token, user, recovery, runId }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1');
    if (!sessionStorage.getItem(`toolbox-e2e-restored:${runId}`)) {
      localStorage.setItem('extract_page_state', JSON.stringify({ activeTab: 'text', textUrl: recovery.url, textResult: recovery }));
      localStorage.setItem('extract_history', JSON.stringify([recovery])); sessionStorage.setItem(`toolbox-e2e-restored:${runId}`, '1');
    }
  }, { origin, token, user, recovery, runId });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
    if (url.origin !== origin || url.pathname !== '/api/formatter/history' || method !== 'POST') {
      if (/generate|extract|semantic|chat|llm/u.test(url.pathname)) report.generationRequests++;
      if (method === 'DELETE') report.historyDeletes++;
      report.blocked.push({ method, path: url.origin === origin ? url.pathname : '[external]' }); fatal = Error('UNEXPECTED_WRITE_BLOCKED'); return route.abort();
    }
    try {
      assert.equal(report.historyPosts, 0, 'ONE_LOCAL_FORMAT_HISTORY_SAVE_ONLY'); const body = request.postDataJSON();
      assert.equal(body.original_text, input, 'ONLY_CURRENT_TEST_TEXT_ALLOWED'); assert.equal(request.headers().authorization, `Bearer ${token}`);
      report.historyPosts++; mutation = { at: new Date().toISOString(), state: 'dispatched', inputSha256: sha(input), outputSha256: sha(body.result_text) };
      await fs.writeFile(path.join(out, 'formatter-save.dispatch.json'), JSON.stringify(mutation, null, 2), { flag: 'wx' }); await save();
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 30000 }); const data = await response.json();
      Object.assign(mutation, { state: 'responded', status: response.status(), recordId: data.record?.id || null }); report.historyMutation = mutation;
      await fs.writeFile(path.join(out, 'formatter-save.dispatch.json'), JSON.stringify(mutation, null, 2)); await save(); await route.fulfill({ response });
    } catch (error) { fatal = Error(clean(error.message)); await route.abort().catch(() => undefined); }
  });
  page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push(clean(error.message)));
  await page.goto(origin + '/tools?tab=text', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const panel = page.locator('[role="tabpanel"]:visible');
  await panel.getByRole('button', { name: '送去分段', exact: true }).waitFor({ timeout: 45000 });
  assert.ok((await panel.innerText()).includes(transcript));
  await panel.getByRole('button', { name: '送去分段', exact: true }).click();
  const segmentInput = panel.locator('textarea');
  await wait(async () => (await segmentInput.count()) === 1 && await segmentInput.inputValue() === transcript, 'transferred-exact-text');
  assert.ok(page.url().includes('tab=segment')); assert.equal(report.generationRequests, 0);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await wait(async () => (await segmentInput.count()) === 1 && await segmentInput.inputValue() === '', 'transfer-consumed-refresh-blank');
  report.stages.transfer = { passed: true, exactText: true, refreshBlank: true, semanticPosts: 0 };
  await panel.screenshot({ path: path.join(out, 'transferred.png') }); await save();

  await page.getByRole('tab', { name: /文字排版/u }).click();
  const formatInput = panel.locator('textarea').first(); await formatInput.waitFor();
  await formatInput.fill(input); await wait(async () => await formatInput.inputValue() === input, 'format-input');
  await panel.getByRole('button', { name: '开始排版', exact: true }).click();
  await wait(() => mutation?.state === 'responded', 'history-save-receipt'); assert.equal(mutation.status, 200);
  const output = panel.locator('textarea[readonly]'); await output.waitFor(); const actual = await output.inputValue();
  report.stages.format = { passed: actual === expected, actual, expected, recordId: mutation.recordId, historyHttp: mutation.status };
  await panel.getByRole('button', { name: '一键复制', exact: true }).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), actual);
  report.stages.format.copied = true;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await wait(async () => await formatInput.inputValue() === '' && await output.count() === 0, 'formatted-refresh-blank'); report.stages.format.refreshedBlank = true;
  await panel.getByRole('button', { name: '历史记录', exact: true }).click();
  const historyResponse = await api('/api/formatter/history'); assert.equal(historyResponse.status, 200);
  const own = historyResponse.body.records.find(record => record.id === mutation.recordId); assert.ok(own && own.result_text === actual && own.original_text === input);
  await panel.getByText(own.title, { exact: true }).click();
  await wait(async () => await formatInput.inputValue() === input && await output.inputValue() === actual, 'history-restored'); report.stages.format.historyRestored = true;
  await panel.screenshot({ path: path.join(out, 'formatted.png') });
  const after = await rows('formatter_history', 'id,original_text,result_text', { user_id: `eq.${user.id}`, order: 'id.asc', limit: '10000' });
  assert.deepEqual(after.filter(record => record.id !== mutation.recordId), oldRecords, 'PREVIOUS_HISTORY_CHANGED');
  report.previousHistoryUnchanged = true;
  report.balanceAfter = (await rows('users', 'credits,cash_balance', { id: `eq.${user.id}`, limit: '1' }))[0]; assert.deepEqual(report.balanceAfter, report.balanceBefore);
  assert.equal(report.pageErrors.length, 0); assert.equal(report.generationRequests, 0); assert.equal(report.historyPosts, 1); assert.equal(report.historyDeletes, 0);
  assert.ok(report.stages.transfer.passed && report.stages.format.passed, 'FORMATTED_TEXT_DOES_NOT_MATCH_ENABLED_RULES'); report.passed = true;
} catch (error) {
  report.failure = clean(error.message); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => undefined);
} finally { if (browser) await browser.close(); await save(); }
console.log(JSON.stringify({ passed: report.passed, report: reportPath, historyPosts: report.historyPosts, generationRequests: report.generationRequests, failure: report.failure }));
