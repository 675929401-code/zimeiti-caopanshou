import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

export async function main(args = process.argv.slice(2)) {
  const overlongCheck = args.includes('--overlong-check');
  const execute = args.includes('--execute') || overlongCheck;
  const origin = process.env.LOCAL_NAV_ORIGIN;
  assert.equal(origin, 'http://127.0.0.1:5000');
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}');
  assert.ok(token && identity.user?.id);
  const runId = args.find(a => a.startsWith('--run-id='))?.slice(9) || 'preflight';
  assert.match(runId, /^[a-zA-Z0-9_-]{3,80}$/u);
  const out = path.resolve('.codex-evidence/storyboard-assets-order-intake', runId);
  await fs.mkdir(out, { recursive: true });
  const headers = { Authorization: `Bearer ${token}` };
  const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15000) });
  const version = await versionResponse.json();
  const baseline = JSON.parse(await fs.readFile('.codex-backups/storyboard-prompt-stage1-7526/baseline/high-energy-agent.json', 'utf8'));
  const fixtureCases = JSON.parse(await fs.readFile('scripts/storyboard-assets-order-ab-cases.json', 'utf8')).cases;
  const fixture = overlongCheck ? fixtureCases.find(item => item.expectedBehavior === 'length-gate') : fixtureCases[0];
  const copy = fixture.fields.segmented_copy;
  const values = { ...fixture.fields };
  // Reuse the explicitly approved synthetic text for the final real intake.
  // The selected 15-second setting also exercises the preserved 4–6-shot route.
  values.segment_duration = '15秒版：每段4-6个镜头';
  if (!overlongCheck) {
    values.video_model_profile = 'Grok Imagine（官方图生视频适配）';
    values.animation_style = '日系Q版电影级3D动画';
  }
  if (execute && !overlongCheck) {
    const review = JSON.parse(await fs.readFile('.codex-evidence/storyboard-assets-order-ab/quality-review.json', 'utf8'));
    assert.equal(review.activationAllowed, true, 'A_B_QUALITY_REVIEW_REQUIRED');
    assert.ok(review.selectedPromptSha256);
    await fs.writeFile(path.join(out, 'dispatch.json'), JSON.stringify({ at: new Date().toISOString(), runId, providerRequestLimit: 1, selectedPromptSha256: review.selectedPromptSha256 }) + '\n', { flag: 'wx' });
  }
  const executablePath = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
  const browser = await chromium.launch({ headless: true, executablePath });
  const report = { stage: overlongCheck ? 'runtime-overtime-gate' : execute ? 'real-main-site-intake' : 'intake-readonly-preflight', version, values, llmRequests: 0, providerRequests: 0, blockedWrites: [], errors: [], checks: {}, request: null, historyVerified: false };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem('entered_app', '1');
    }, { token, user: identity.user });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message.slice(0, 250)));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      if (execute && request.method() === 'POST' && url.pathname === '/api/conversations/history') return route.continue();
      if (execute && request.method() === 'POST' && url.pathname === '/api/llm' && report.llmRequests === 0) {
        report.llmRequests += 1;
        const body = request.postDataJSON();
        assert.equal(body.agentId, baseline.id);
        report.request = { agentId: body.agentId, conversationId: body.conversationId, clientRequestId: body.client_request_id, idempotencyKey: request.headers()['idempotency-key'], inputSha256: crypto.createHash('sha256').update(JSON.stringify(body.messages)).digest('hex') };
        return route.continue();
      }
      report.blockedWrites.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Acceptance write gate' }) });
    });
    await page.goto(origin, { waitUntil: 'networkidle', timeout: 60000 });
    const card = page.getByRole('button', { name: '打开智能体：3D故事导演｜高能版', exact: true });
    await card.waitFor({ state: 'visible', timeout: 30000 });
    await card.click();
    await page.locator('#preset-segmented_copy').waitFor({ state: 'visible', timeout: 15000 });
    for (const field of baseline.preset_fields) {
      const element = page.locator(`#preset-${field.id}`);
      assert.equal(await element.count(), 1, `EXISTING_PRESET_FIELD_MISSING_${field.id}`);
      if (field.type === 'select') await element.selectOption(values[field.id]);
      else await element.fill(values[field.id]);
    }
    await page.screenshot({ path: path.join(out, 'existing-intake.png') });
    report.checks.existingEightFields = true;
    report.checks.rawTextPreserved = (await page.locator('#preset-segmented_copy').inputValue()) === copy;
    if (execute) {
      // This agent's Start flow auto-sends after transferring the preset. Arm
      // the listener first and never click Send a second time.
      const responsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/llm' && r.request().method() === 'POST', { timeout: 60000 });
      await page.getByRole('button', { name: '开始', exact: true }).click();
      const response = await responsePromise;
      report.httpStatus = response.status();
      if (overlongCheck) {
        // The established chat guard is a normal assistant SSE response. Its
        // authoritative header distinguishes it from a paid provider response.
        // Reading the body again races the page's consumed/aborted SSE handle.
        assert.equal(response.status(), 200, 'OVERTIME_GUARD_HTTP_CONTRACT_CHANGED');
        assert.equal(response.headers()['x-llm-guarded'], 'true', 'OVERTIME_GATE_DID_NOT_BLOCK');
        const assistant = page.locator('[data-message-role="assistant"]').last();
        await assistant.getByText('生成门禁：口播超时', { exact: false }).waitFor({ timeout: 15000 });
        await assistant.getByText('不得删字、改写或截断', { exact: false }).waitFor({ timeout: 15000 });
        await assistant.locator('[data-testid="chat-output-status"][data-state="completed"]').waitFor({ timeout: 15000 });
        const message = await assistant.innerText();
        assert.ok(message.includes('重新分段') && message.includes('不得删字、改写或截断'));
        assert.ok(message.includes('上限90字'));
        report.gate = { guardedHeader: 'true', message };
        report.checks.providerBlockedBeforeDispatch = true;
        report.providerRequests = 0;
        await page.screenshot({ path: path.join(out, 'overtime-blocked.png'), fullPage: true });
        assert.equal(report.llmRequests, 1);
      } else {
      assert.equal(response.status(), 200, `LLM_HTTP_${response.status()}`);
      assert.notEqual(response.headers()['x-llm-guarded'], 'true', 'VALID_INTAKE_WAS_GUARDED');
      await page.locator('[data-message-role="assistant"] [data-testid="chat-output-status"][data-state="completed"]').last().waitFor({ timeout: 300000 });
      assert.equal(await page.locator('[data-testid="chat-message-status"]').count(), 0, 'MAIN_SITE_OUTPUT_FAILED');
      const assistant = page.locator('[data-message-role="assistant"]').last();
      report.checks.assetHeadingVisible = await assistant.getByText('全局视觉资产计划', { exact: false }).count() > 0;
      report.checks.codeBlocks = await assistant.locator('pre').count();
      await page.screenshot({ path: path.join(out, 'completed-output.png'), fullPage: true });
      await fs.writeFile(path.join(out, 'rendered-output.txt'), await assistant.innerText(), { flag: 'wx' });
      const historyResponse = await fetch(`${origin}/api/conversations/history?id=${encodeURIComponent(report.request.conversationId)}`, { headers, signal: AbortSignal.timeout(15000) });
      assert.ok(historyResponse.ok, 'HISTORY_READ_FAILED');
      const history = await historyResponse.json();
      await fs.writeFile(path.join(out, 'history.json'), JSON.stringify(history, null, 2) + '\n', { flag: 'wx' });
      report.historyVerified = JSON.stringify(history).includes('全局视觉资产计划');
      assert.ok(report.historyVerified, 'OUTPUT_NOT_PERSISTED');
      report.providerRequests = 1;
      assert.equal(report.llmRequests, 1);
      }
      // Inspect only this synthetic local request. Credentials remain in memory;
      // retain selected terminal and accounting fields, never the replay body.
      const dbOrigin = new URL(process.env.COZE_SUPABASE_URL).origin;
      assert.equal(dbOrigin, 'http://127.0.0.1:54321');
      const attemptUrl = new URL('/rest/v1/llm_request_attempts', dbOrigin);
      attemptUrl.searchParams.set('select', 'state,attempt_no,provider_call_started_at,http_status,response_body');
      attemptUrl.searchParams.set('client_request_id', `eq.${report.request.clientRequestId}`);
      attemptUrl.searchParams.set('user_id', `eq.${identity.user.id}`);
      let attempts = [];
      for (let read = 0; read < 10; read += 1) {
        const observed = await fetch(attemptUrl, { headers: { apikey: process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.COZE_SUPABASE_SERVICE_ROLE_KEY}` }, signal: AbortSignal.timeout(15000) });
        assert.ok(observed.ok, 'LOCAL_ATTEMPT_READ_FAILED');
        attempts = await observed.json();
        if (overlongCheck || attempts[0]?.state === 'succeeded') break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (overlongCheck) {
        assert.equal(attempts.length, 0, 'GUARDED_REQUEST_CREATED_PROVIDER_ATTEMPT');
        report.attempt = { count: 0, providerCallStarted: false };
      } else {
        assert.equal(attempts.length, 1, 'MAIN_SITE_ATTEMPT_COUNT_CHANGED');
        const attempt = attempts[0];
        assert.equal(attempt.state, 'succeeded');
        assert.equal(attempt.attempt_no, 1);
        assert.ok(attempt.provider_call_started_at);
        const frames = String(attempt.response_body || '').split('\n').filter(line => line.startsWith('data: ')).flatMap(line => { try { return [JSON.parse(line.slice(6))]; } catch { return []; } });
        const billing = frames.find(frame => frame.billing_complete === true);
        const usage = frames.filter(frame => frame.usage).at(-1)?.usage || null;
        report.attempt = { count: 1, state: attempt.state, attemptNo: attempt.attempt_no, providerCallStartedAt: attempt.provider_call_started_at, httpStatus: attempt.http_status, usage, billing: billing ? { complete: true, operationId: billing.operation_id, creditsCharged: billing.credits_charged, alreadyFulfilled: billing.already_fulfilled } : null };
        const runtimeLog = await fs.readFile(path.resolve(`../运行日志/提示词续接-20261015-7526/preview-r${version.revision}.stdout.log`), 'utf8');
        const authority = runtimeLog.split('\n').filter(line => line.includes('[LLM_PROMPT_AUTHORITY]')).flatMap(line => { try { return [JSON.parse(line.slice(line.indexOf('{')))]; } catch { return []; } }).find(entry => entry.requestId === report.request.clientRequestId);
        assert.ok(authority, 'MAIN_SITE_PROMPT_AUTHORITY_TRACE_MISSING');
        report.promptAuthority = authority;
        const review = JSON.parse(await fs.readFile('.codex-evidence/storyboard-assets-order-ab/quality-review.json', 'utf8'));
        assert.equal(authority.promptDigest, review.selectedPromptSha256, 'MAIN_SITE_CALLED_OLD_PROMPT');
      }
    }
    for (const route of ['/storyboard-workbench', '/video']) {
      await page.goto(`${origin}${route}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.screenshot({ path: path.join(out, route.slice(1) + '.png') });
      report.checks[route] = { title: await page.title(), horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2) };
    }
    assert.equal(report.errors.length, 0, 'BROWSER_PAGE_ERROR');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await browser.close();
  }
}
