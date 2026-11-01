import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const targetAgentId = 'agent-1781753171961-mlipi7';
const targetName = '爆款文案重构师V3.3';
const outputDirectory = path.resolve('.codex-evidence/chat-reliability-20261029/browser');
const scenarios = [
  { id: 'relay-balance', code: 'LLM_UPSTREAM_BALANCE', status: 200,
    expected: '模型中转账户余额或额度不足，请管理员补充额度后再发起新请求。' },
  { id: 'site-credits', code: 'INSUFFICIENT_CREDITS', status: 402,
    expected: '站内积分不足，当前无法发起这次回复。请补充站内积分后再试。' },
  { id: 'unknown-result', code: 'LLM_UPSTREAM_RESULT_UNKNOWN', status: 200,
    expected: '与模型通道的连接中断，最终结果暂未确认。原请求已保留，请先查看聊天记录，避免重复发送。', unknown: true },
];

export async function main(args = []) {
  if (args.includes('--plan')) {
    console.log(JSON.stringify({ mode: 'plan', viewport: { width: 1440, height: 900 },
      scenarios: scenarios.map(({ id, code }) => ({ id, code })), targetAgentId,
      auth: 'in-memory wrapper identity only', providerCalls: 0, databaseWrites: 0,
      outputDirectory, executed: false }, null, 2));
    return;
  }
  assert.ok(args.every(value => /^--origin=http:\/\/127\.0\.0\.1:5000\/?$/u.test(value)), 'UNSUPPORTED_BROWSER_ARGUMENT');
  const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
  assert.equal(origin, 'http://127.0.0.1:5000', 'CURRENT_LOCAL_PREVIEW_REQUIRED');
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.ok(token, 'LOCAL_ADMIN_WRAPPER_REQUIRED');
  let identity;
  try { identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}'); }
  catch { throw Error('LOCAL_READONLY_IDENTITY_INVALID'); }
  assert.ok(identity?.user?.id && identity.user.role === 'admin', 'LOCAL_READONLY_ADMIN_IDENTITY_REQUIRED');
  await fs.mkdir(outputDirectory, { recursive: true });
  const report = { kind: 'current-app-ui-with-in-memory-error-fixtures', startedAt: new Date().toISOString(),
    viewport: { width: 1440, height: 900 }, targetAgentId,
    evidenceBoundary: 'Real locally served application UI and read-only directory; synthetic auth/me and failure responses. No real model recovery or billing acceptance is inferred.',
    providerCalls: 0, businessWrites: 0, actualMutationRequestsAllowed: 0, scenarios: [], adjacentPages: [],
    blockedExternalRequests: 0, interceptedMutations: 0, authSnapshotResponses: 0, browserErrors: 0, passed: false };
  const browser = await chromium.launch({ headless: true });
  let currentPage;
  try {
    async function fixtureContext(scenario) {
      const counters = { llmSubmissions: 0, readonlyHistoryLoads: 0, siteRechargeEvents: 0 };
      const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: 'block',
        reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
      await context.addInitScript(({ sessionToken, profile }) => {
        localStorage.setItem('auth_token', sessionToken);
        localStorage.setItem('auth_user', JSON.stringify(profile));
        sessionStorage.setItem('entered_app', '1');
        window.__chatFixtureRechargeEvents = 0;
        window.addEventListener('insufficient-balance', () => { window.__chatFixtureRechargeEvents++; });
      }, { sessionToken: token, profile: identity.user });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== origin) { report.blockedExternalRequests++; return route.abort('blockedbyclient'); }
        if (url.pathname === '/api/auth/me' && method === 'GET') {
          report.authSnapshotResponses++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, user: identity.user }) });
        }
        if (method === 'POST' && url.pathname === '/api/llm') {
          counters.llmSubmissions++;
          assert.equal(counters.llmSubmissions, 1, 'FIXTURE_MUST_NOT_RESUBMIT');
          assert.ok(scenario, 'ADJACENT_PAGE_MUST_NOT_GENERATE');
          const payload = request.postDataJSON();
          assert.equal(payload.agentId, targetAgentId, 'EXACT_TARGET_AGENT_REQUIRED');
          report.interceptedMutations++;
          const failure = { error: scenario.unknown ? '连接中断，balance 未确认' : 'synthetic fixture refusal', code: scenario.code };
          if (scenario.status !== 200) return route.fulfill({ status: scenario.status, contentType: 'application/json', body: JSON.stringify(failure) });
          return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(failure)}\n\n` });
        }
        if (!['GET', 'HEAD'].includes(method)) {
          report.interceptedMutations++;
          if (url.pathname.startsWith('/api/conversations')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"fixtureOnly":true}' });
          if (['/api/operation-events', '/api/announcements/events', '/api/diagnostic-logs'].includes(url.pathname)) return route.fulfill({ status: 202, contentType: 'application/json', body: '{"accepted":true,"fixtureOnly":true}' });
          return route.abort('blockedbyclient');
        }
        if (url.pathname === '/api/conversations/history') counters.readonlyHistoryLoads++;
        if (/^\/api\/(llm|chat|generate|payment)(\/|$)/u.test(url.pathname)) return route.abort('blockedbyclient');
        return route.continue({ headers: { ...request.headers(), authorization: `Bearer ${token}` } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      page.on('pageerror', () => { report.browserErrors++; });
      currentPage = page;
      return { context, page, counters };
    }
    async function openTarget(page) {
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const card = page.locator(`[data-agent-card-id="${targetAgentId}"]`);
      await card.waitFor({ state: 'attached' });
      await card.scrollIntoViewIfNeeded();
      await card.getByRole('button', { name: `打开智能体：${targetName}`, exact: true }).click();
      const skip = page.getByRole('button', { name: '跳过', exact: true });
      await page.getByTestId('chat-agent-name').filter({ hasText: targetName }).or(skip).first().waitFor({ state: 'visible' });
      if (await skip.isVisible().catch(() => false)) await skip.click();
      await page.getByTestId('chat-agent-name').filter({ hasText: targetName }).waitFor({ state: 'visible' });
      return page.getByRole('textbox', { name: `向 ${targetName} 发送消息`, exact: true });
    }
    for (const scenario of scenarios) {
      const { page, context, counters } = await fixtureContext(scenario);
      try {
        const input = await openTarget(page);
        await input.fill('A');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByText(scenario.expected, { exact: false }).first().waitFor({ state: 'visible' });
        await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ state: 'visible' });
        assert.equal(counters.llmSubmissions, 1, 'EXACTLY_ONE_FIXTURE_POST');
        counters.siteRechargeEvents = await page.evaluate(() => window.__chatFixtureRechargeEvents);
        if (scenario.unknown) {
          assert.equal(await input.inputValue(), '', 'UNKNOWN_MUST_NOT_RESTORE_SUBMITTED_DRAFT');
          assert.equal(await page.getByText('正在改写这条消息，发送后会替换原消息', { exact: true }).count(), 0, 'UNKNOWN_MUST_NOT_RESTORE_EDIT');
          assert.equal(await page.getByRole('button', { name: '重新生成', exact: true }).count(), 0, 'UNKNOWN_MUST_NOT_REGENERATE');
          assert.equal(await page.getByRole('button', { name: '重新发送', exact: true }).count(), 0, 'UNKNOWN_MUST_NOT_RESEND');
          assert.equal(await page.getByRole('button', { name: '继续回复', exact: true }).count(), 0, 'UNKNOWN_MUST_NOT_CONTINUE');
          await page.getByRole('button', { name: '查看聊天记录', exact: true }).first().waitFor({ state: 'visible' });
        }
        assert.equal(counters.siteRechargeEvents, scenario.id === 'site-credits' ? 1 : 0, 'ONLY_SITE_CREDITS_OPENS_SITE_RECHARGE');
        const screenshot = `${scenario.id}.png`;
        await page.screenshot({ path: path.join(outputDirectory, screenshot) });
        report.scenarios.push({ id: scenario.id, code: scenario.code, expectedCopyVisible: true,
          unknownActionsBlocked: !!scenario.unknown, draftRestored: (await input.inputValue()) !== '',
          ...counters, screenshot, passed: true });
      } catch (error) {
        await page.screenshot({ path: path.join(outputDirectory, `${scenario.id}-failure.png`) }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
    const { context, page, counters } = await fixtureContext();
    try {
      for (const [routePath, screenshot] of [['/', 'adjacent-home.png'], ['/cover', 'adjacent-cover.png']]) {
        const response = await page.goto(origin + routePath, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        assert.equal(response?.status(), 200, 'ADJACENT_PAGE_HTTP_200_REQUIRED');
        if (routePath === '/') await page.locator(`[data-agent-card-id="${targetAgentId}"]`).waitFor({ state: 'attached' });
        else await page.getByRole('textbox', { name: '输入文案', exact: true }).waitFor({ state: 'visible' });
        const metrics = await page.evaluate(() => ({ textLength: document.body.innerText.length,
          horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          applicationError: document.body.innerText.includes('Application error') }));
        assert.ok(metrics.textLength > 100 && !metrics.applicationError, 'ADJACENT_PAGE_CONTENT_REQUIRED');
        await page.screenshot({ path: path.join(outputDirectory, screenshot) });
        report.adjacentPages.push({ path: routePath, ...metrics, screenshot, passed: true });
      }
      assert.equal(counters.llmSubmissions, 0, 'ADJACENT_PAGES_MUST_NOT_SUBMIT');
    } finally { await context.close(); }
    assert.equal(report.browserErrors, 0, 'APPLICATION_PAGE_ERRORS');
    report.passed = true;
  } catch (error) {
    report.failure = error instanceof assert.AssertionError ? 'BROWSER_ASSERTION_FAILED'
      : /^[A-Z][A-Z0-9_]+$/u.test(String(error?.message)) ? error.message : 'BROWSER_ACCEPTANCE_INCOMPLETE';
    await currentPage?.screenshot({ path: path.join(outputDirectory, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await browser.close();
    console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length, adjacentPages: report.adjacentPages.length,
      providerCalls: 0, businessWrites: 0, report: path.join(outputDirectory, 'report.json') }, null, 2));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { console.error('CHAT_RELIABILITY_BROWSER_FAILED'); process.exitCode = 1; });
}
