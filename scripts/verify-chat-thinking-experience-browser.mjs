import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const targetAgentId = 'agent-1781753171961-mlipi7';
const targetName = '爆款文案重构师V3.3';
const viewport = Object.freeze({ width: 1440, height: 900 });
const outputDirectory = path.resolve('.codex-evidence/chat-thinking-experience-20261029/browser');
const scenarioIds = ['reasoning-to-body', 'unknown-after-reasoning', 'direct-body', 'blank-reasoning'];
const reasoningOne = '这是通道提供的可展示分析摘要。';
const reasoningTwo = '这是一段补充分析摘要。';
const reasoningLate = '这是正文开始后补到的摘要。';
const bodyOne = '正文第一句立即可见。';
const delta = value => ({ choices: [{ delta: value, finish_reason: null }] });

export async function main(args = []) {
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify({ mode: 'plan', executed: false, viewport, targetAgentId,
      scenarios: scenarioIds, auth: 'with-local-admin-session in-memory identity',
      fixture: 'Browser ReadableStream; only POST /api/llm is replaced, external and all other mutation requests are blocked or fulfilled locally.',
      providerCalls: 0, businessWrites: 0, outputDirectory }, null, 2));
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
  const report = { kind: 'real-chat-components-with-controlled-browser-stream', startedAt: new Date().toISOString(),
    viewport, targetAgentId, passed: false,
    evidenceBoundary: 'Real current local application components. Auth/me and model stream are synthetic in-memory fixtures; all writes are intercepted. No upstream speed, real model reasoning, recovery or billing acceptance is inferred.',
    providerCalls: 0, businessWrites: 0, actualMutationRequestsAllowed: 0,
    blockedExternalRequests: 0, interceptedMutations: 0, authSnapshotResponses: 0, browserErrors: 0,
    scenarios: [], adjacentPages: [] };
  const browser = await chromium.launch({ headless: true });
  try {
    async function fixtureContext(scenarioId) {
      const counters = { forbiddenLlmNetworkPosts: 0, readonlyHistoryLoads: 0 };
      const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce',
        locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
      await context.addInitScript(({ sessionToken, profile, agentId, fixtureEnabled }) => {
        localStorage.setItem('auth_token', sessionToken);
        localStorage.setItem('auth_user', JSON.stringify(profile));
        sessionStorage.setItem('entered_app', '1');
        const nativeFetch = window.fetch.bind(window);
        const encoder = new TextEncoder();
        let controller;
        const fixture = { submissions: 0, frames: 0, closed: false, cancelled: false, submittedAt: null,
          enqueue(value) {
            if (!controller || fixture.closed || fixture.cancelled) throw Error('FIXTURE_STREAM_NOT_OPEN');
            const encoded = typeof value === 'string' ? value : JSON.stringify(value);
            fixture.frames++;
            controller.enqueue(encoder.encode(`data: ${encoded}\n\n`));
          },
          close() {
            if (!controller || fixture.closed || fixture.cancelled) return;
            fixture.closed = true;
            controller.close();
          },
        };
        window.__thinkingFixture = fixture;
        window.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
          const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
          if (url.origin !== location.origin || url.pathname !== '/api/llm' || method !== 'POST') return nativeFetch(input, init);
          if (!fixtureEnabled) throw Error('ADJACENT_PAGE_MUST_NOT_GENERATE');
          fixture.submissions++;
          if (fixture.submissions !== 1) throw Error('FIXTURE_MUST_NOT_RESUBMIT');
          const rawBody = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
          const payload = JSON.parse(rawBody);
          if (payload.agentId !== agentId) throw Error('EXACT_TARGET_AGENT_REQUIRED');
          fixture.submittedAt = performance.now();
          const stream = new ReadableStream({
            start(value) { controller = value; },
            cancel() { fixture.cancelled = true; },
          });
          fixture.enqueue({ type: 'stream_delivery', mode: 'live' });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
        };
      }, { sessionToken: token, profile: identity.user, agentId: targetAgentId, fixtureEnabled: !!scenarioId });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== origin) { report.blockedExternalRequests++; return route.abort('blockedbyclient'); }
        if (url.pathname === '/api/auth/me' && method === 'GET') {
          report.authSnapshotResponses++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, user: identity.user }) });
        }
        if (url.pathname === '/api/llm' && method === 'POST') {
          counters.forbiddenLlmNetworkPosts++;
          return route.abort('blockedbyclient');
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
      return { page, context, counters };
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
    const enqueue = (page, value) => page.evaluate(payload => window.__thinkingFixture.enqueue(payload), value);
    // Streaming updates use RAF. Drain actual browser paints rather than
    // replacing clocks or reading implementation source to infer visibility.
    const drainPaints = page => page.evaluate(async () => {
      for (let index = 0; index < 4; index++) await new Promise(resolve => requestAnimationFrame(resolve));
    });
    async function assertExpanded(page, expected) {
      await page.waitForFunction(value => document.querySelector('[data-testid="chat-reasoning-toggle"]')?.getAttribute('aria-expanded') === String(value), expected);
      assert.equal(await page.getByTestId('chat-reasoning-content').count(), expected ? 1 : 0, 'REASONING_REGION_MATCHES_EXPANSION');
    }
    async function assertNoPanel(page) {
      await drainPaints(page);
      assert.equal(await page.getByTestId('chat-reasoning').count(), 0, 'NO_EMPTY_OR_INVENTED_REASONING_PANEL');
    }
    const screenshot = async (page, name) => {
      await page.screenshot({ path: path.join(outputDirectory, name) });
      return name;
    };
    async function finish(page) {
      await enqueue(page, { billing_complete: true });
      await enqueue(page, '[DONE]');
      await page.evaluate(() => window.__thinkingFixture.close());
      await page.getByTestId('chat-output-status').filter({ hasText: /^已完成$/u }).last().waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ state: 'visible' });
    }
    for (const id of scenarioIds) {
      const { page, context, counters } = await fixtureContext(id);
      const outcome = { id, passed: false, screenshots: [] };
      try {
        const input = await openTarget(page);
        await input.fill('A');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.waitForFunction(() => window.__thinkingFixture?.submissions === 1);
        await page.getByTestId('chat-output-status').filter({ hasText: /^智能体正在准备回复$/u }).last().waitFor({ state: 'visible' });
        await assertNoPanel(page);
        outcome.preparationWithoutInventedThinking = true;
        const toggle = page.getByTestId('chat-reasoning-toggle');
        if (id === 'reasoning-to-body' || id === 'unknown-after-reasoning') {
          const sentAt = await page.evaluate(() => performance.now());
          await enqueue(page, delta({ reasoning_content: reasoningOne }));
          await page.getByTestId('chat-reasoning-content').getByText(reasoningOne, { exact: false }).waitFor({ state: 'visible' });
          await assertExpanded(page, true);
          await page.getByTestId('chat-output-status').filter({ hasText: /^智能体正在思考$/u }).last().waitFor({ state: 'visible' });
          outcome.firstReasoningVisibleWhileStreamOpen = await page.evaluate(() => !window.__thinkingFixture.closed);
          assert.equal(outcome.firstReasoningVisibleWhileStreamOpen, true);
          outcome.fixtureReasoningToObservedPaintMs = await page.evaluate(start => performance.now() - start, sentAt);
          outcome.screenshots.push(await screenshot(page, `${id}-thinking-open.png`));
          if (id === 'reasoning-to-body') {
            await toggle.click();
            await assertExpanded(page, false);
            await enqueue(page, delta({ reasoning_content: reasoningTwo }));
            await drainPaints(page);
            await assertExpanded(page, false);
            outcome.manualCollapseSurvivesFurtherReasoning = true;
            await toggle.click();
            await assertExpanded(page, true);
            await page.getByTestId('chat-reasoning-content').getByText(reasoningTwo, { exact: false }).waitFor({ state: 'visible' });
            await enqueue(page, delta({ content: bodyOne }));
            await page.getByText(bodyOne, { exact: false }).last().waitFor({ state: 'visible' });
            await assertExpanded(page, false);
            await page.getByTestId('chat-output-status').filter({ hasText: /^智能体正在回复$/u }).last().waitFor({ state: 'visible' });
            assert.equal(await page.evaluate(() => window.__thinkingFixture.closed), false, 'FIRST_BODY_VISIBLE_BEFORE_DONE');
            outcome.bodyVisibleBeforeDoneAndAutoCollapsed = true;
            await enqueue(page, delta({ reasoning_content: reasoningLate }));
            await drainPaints(page);
            await assertExpanded(page, false);
            outcome.lateReasoningDoesNotReopen = true;
            outcome.screenshots.push(await screenshot(page, `${id}-body-before-done.png`));
            await finish(page);
            await toggle.click();
            await assertExpanded(page, true);
            await page.getByTestId('chat-reasoning-content').getByText(reasoningLate, { exact: false }).waitFor({ state: 'visible' });
            outcome.completedReasoningCanBeOpenedManually = true;
            outcome.screenshots.push(await screenshot(page, `${id}-completed-expanded.png`));
          } else {
            await enqueue(page, { error: 'synthetic connection uncertainty', code: 'LLM_UPSTREAM_RESULT_UNKNOWN' });
            await page.getByText('与模型通道的连接中断，最终结果暂未确认。原请求已保留，请先查看聊天记录，避免重复发送。', { exact: false }).first().waitFor({ state: 'visible' });
            await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ state: 'visible' });
            await assertExpanded(page, false);
            assert.equal((await toggle.innerText()).trim(), '思考内容', 'INTERRUPTED_REASONING_MUST_NOT_CLAIM_COMPLETION');
            await toggle.click();
            await page.getByTestId('chat-reasoning-content').getByText(reasoningOne, { exact: false }).waitFor({ state: 'visible' });
            for (const name of ['重新生成', '重新发送', '继续回复']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, 'UNKNOWN_MUST_NOT_OFFER_RESUBMISSION');
            assert.equal(await input.inputValue(), '', 'UNKNOWN_MUST_NOT_RESTORE_SUBMITTED_DRAFT');
            assert.equal(await page.getByText('正在改写这条消息，发送后会替换原消息', { exact: true }).count(), 0);
            outcome.unknownPreservesReasoningAndNeutralLabel = true;
            outcome.unknownResubmissionActionsAbsent = true;
            outcome.screenshots.push(await screenshot(page, `${id}-neutral-preserved.png`));
          }
        } else {
          if (id === 'blank-reasoning') {
            await enqueue(page, delta({ reasoning_content: '\n  \t' }));
            await assertNoPanel(page);
            await page.getByTestId('chat-output-status').filter({ hasText: /^智能体正在准备回复$/u }).last().waitFor({ state: 'visible' });
            outcome.blankReasoningDoesNotStartThinking = true;
          }
          await enqueue(page, delta({ content: bodyOne }));
          await page.getByText(bodyOne, { exact: false }).last().waitFor({ state: 'visible' });
          await assertNoPanel(page);
          assert.equal(await page.evaluate(() => window.__thinkingFixture.closed), false);
          await finish(page);
          await assertNoPanel(page);
          outcome.noEmptyReasoningPanelBeforeOrAfterDone = true;
          outcome.screenshots.push(await screenshot(page, `${id}-completed.png`));
        }
        const fixture = await page.evaluate(() => ({ submissions: window.__thinkingFixture.submissions, frames: window.__thinkingFixture.frames }));
        assert.equal(fixture.submissions, 1, 'EXACTLY_ONE_FIXTURE_SUBMISSION');
        assert.equal(counters.forbiddenLlmNetworkPosts, 0, 'MODEL_REQUEST_MUST_NEVER_REACH_SERVER');
        Object.assign(outcome, fixture, counters, { passed: true });
        report.scenarios.push(outcome);
      } catch (error) {
        outcome.screenshots.push(await screenshot(page, `${id}-failure.png`).catch(() => 'screenshot-unavailable'));
        report.scenarios.push(outcome);
        throw error;
      } finally { await context.close(); }
    }
    const { page, context, counters } = await fixtureContext();
    try {
      for (const [routePath, name] of [['/', 'adjacent-home.png'], ['/cover', 'adjacent-cover.png']]) {
        const response = await page.goto(origin + routePath, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        assert.equal(response?.status(), 200);
        if (routePath === '/') await page.locator(`[data-agent-card-id="${targetAgentId}"]`).waitFor({ state: 'attached' });
        else await page.getByRole('textbox', { name: '输入文案', exact: true }).waitFor({ state: 'visible' });
        const metrics = await page.evaluate(() => ({ textLength: document.body.innerText.length,
          horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          applicationError: document.body.innerText.includes('Application error') }));
        assert.ok(metrics.textLength > 100 && !metrics.applicationError);
        report.adjacentPages.push({ path: routePath, ...metrics, screenshot: await screenshot(page, name), passed: true });
      }
      assert.equal(counters.forbiddenLlmNetworkPosts, 0);
      assert.equal(await page.evaluate(() => window.__thinkingFixture.submissions), 0);
    } finally { await context.close(); }
    assert.equal(report.browserErrors, 0, 'APPLICATION_PAGE_ERRORS');
    report.passed = true;
  } catch (error) {
    report.failure = error instanceof assert.AssertionError ? 'BROWSER_ASSERTION_FAILED'
      : /^[A-Z][A-Z0-9_]+$/u.test(String(error?.message)) ? error.message : 'BROWSER_ACCEPTANCE_INCOMPLETE';
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await browser.close();
    console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length,
      adjacentPages: report.adjacentPages.length, providerCalls: 0, businessWrites: 0,
      report: path.join(outputDirectory, 'report.json') }, null, 2));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { console.error('CHAT_THINKING_EXPERIENCE_BROWSER_FAILED'); process.exitCode = 1; });
}
