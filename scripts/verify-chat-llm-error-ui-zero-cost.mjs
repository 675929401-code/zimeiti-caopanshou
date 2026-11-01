import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const base = path.resolve('..', '运行日志', '三视觉资产十秒闭环-20261019');
const expectedVersion = process.argv.find(v => v.startsWith('--expected-version='))?.split('=')[1];
assert.ok(expectedVersion, 'Explicit expected current build version required');
const { openPlatformSession, origin } = await import(pathToFileURL(path.join(base, 'platform-session.mjs')).href);
const session = await openPlatformSession();
const { browser, context, rows, actorId, version } = session;
const out = path.join(base, `chat-error-ui-${new Date().toISOString().replaceAll(':', '-')}`);
await fs.mkdir(out, { recursive: false });
const report = { version, expectedVersion, zeroCostFixture: true, providerRequests: 0, blockedWrites: [], checks: [], pageErrors: [] };
const wallet = () => rows('users', { select: 'cash_balance,credits', id: `eq.${actorId}`, limit: '1' });
const [agent] = await rows('agents', { select: 'id,name,preset_fields', id: 'eq.agent-1786633444187-594spj', limit: '1' });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = text => frame({ choices: [{ delta: { content: text }, finish_reason: null }] });
const done = 'data: [DONE]\n\n';
const cases = [
  { name: 'explicit-timeout', body: frame({ error: 'timeout', code: 'LLM_UPSTREAM_TIMEOUT' }), state: 'failed' },
  { name: 'partial-unknown', body: delta('已经收到的正文。') + frame({ error: 'unknown', code: 'LLM_UPSTREAM_RESULT_UNKNOWN' }), state: 'unknown', retained: '已经收到的正文。' },
  { name: 'missing-terminal', body: delta('已收到但尚未确认完整的正文。'), state: 'unknown', retained: '已收到但尚未确认完整的正文。' },
  { name: 'success', body: delta('正常完成的测试正文。') + frame({ billing_complete: true, credits_charged: 0 }) + done, state: 'completed' },
  { name: 'ordinary-warning-text', body: delta('⚠ 这是正常讨论警告符号的内容。') + frame({ billing_complete: true, credits_charged: 0 }) + done, state: 'completed' },
];
let activeCase;
await context.route('**/api/**', async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === '/api/credits') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ credits: { total: 0, used: 0, remaining: 0 }, cashBalance: 0 }) });
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.continue();
  if (url.pathname === '/api/llm' && req.method() === 'POST') {
    assert.ok(activeCase);
    activeCase.submissions = (activeCase.submissions || 0) + 1;
    assert.equal(activeCase.submissions, 1);
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }, body: activeCase.body });
  }
  report.blockedWrites.push({ path: url.pathname, method: req.method() });
  // Metadata is acknowledged in memory only; never write fixture conversations.
  if (url.pathname === '/api/conversations/history') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  return route.abort();
});
try {
  assert.ok(JSON.stringify(version).includes(expectedVersion), 'Runtime version must match root-approved build');
  report.walletBefore = await wallet();
  for (const fixture of cases) {
    activeCase = fixture;
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle', timeout: 60000 });
    await page.getByRole('button', { name: `打开智能体：${agent.name}`, exact: true }).click();
    await page.locator('[data-testid="agent-preset-intake"]').waitFor();
    for (const field of agent.preset_fields) {
      const el = page.locator(`#preset-${field.id}`);
      if (['segmented_script', 'segmented_copy'].includes(field.id)) await el.fill('1.【狗狗来到新环境，先提供干净饮水，观察精神状态和进食情况，适应期间保持规律生活，如有异常请咨询兽医。】');
      else if (['target_duration_seconds', 'segment_duration'].includes(field.id)) await el.selectOption(field.options.find(v => v.startsWith('10秒')));
    }
    await page.getByRole('button', { name: '开始', exact: true }).click();
    const assistant = page.locator('[data-message-role="assistant"]').last();
    await assistant.locator(`[data-testid="chat-output-status"][data-state="${fixture.state}"]`).waitFor({ timeout: 30000 });
    const content = await assistant.innerText();
    if (fixture.retained) assert.ok(content.includes(fixture.retained));
    if (fixture.state !== 'completed') assert.ok(!content.includes('已完成'));
    if (fixture.state === 'unknown') assert.equal(await assistant.getByRole('button', { name: /重新生成/u }).count(), 0);
    assert.equal(fixture.submissions, 1);
    await page.screenshot({ path: path.join(out, `${fixture.name}.png`), fullPage: true });
    report.checks.push({ name: fixture.name, state: fixture.state, content, submissions: fixture.submissions });
    await page.close();
  }
  report.walletAfter = await wallet();
  assert.deepEqual(report.walletAfter, report.walletBefore);
  assert.equal(report.pageErrors.length, 0);
  report.status = 'passed_fixture_ui_only';
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ out, status: report.status, error: report.error, checks: report.checks.length }));
}
