import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const runId = process.argv.find(value => value.startsWith('--run-id='))?.slice(9);
const requestedModelId = process.argv.find(value => value.startsWith('--model-id='))?.slice(11) || '';
const requestedModelLabel = process.argv.find(value => value.startsWith('--model-label='))?.slice(14) || '';
const execute = process.argv.includes('--execute');
assert.match(runId || '', /^[A-Za-z0-9_-]{6,100}$/u);
const out = path.resolve('.codex-evidence/agent-chat-live-ui-20260904', runId);
await fs.mkdir(out, { recursive: true });
if (!execute) {
  console.log(JSON.stringify({ mode: 'plan', providerPosts: 0, command: `node scripts/verify-agent-chat-live-ui.mjs --run-id=${runId} --execute` }));
  process.exit(0);
}

const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
assert.ok(token, 'A verified local administrator session is required');
const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
const identity = await identityResponse.json().catch(() => null);
assert.ok(identityResponse.ok && identity?.user?.role === 'admin', 'The local administrator session is invalid');
const session = { user: identity.user };
const marker = `AGENT_UI_${runId}_${randomUUID()}`;
const markerPath = path.join(out, 'dispatch.json');
await fs.writeFile(markerPath, JSON.stringify({ at: new Date().toISOString(), marker, providerPostLimit: 1 }) + '\n', { flag: 'wx' });

const browser = await chromium.launch({ headless: true });
let llmPosts = 0;
let requestBody = null;
let responseStatus = null;
let responseContentType = null;
const consoleErrors = [];
const pageErrors = [];
const streamConsole = [];
const samples = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
    localStorage.setItem('debug_stream', '1');
  }, { token, user: session.user });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on('console', message => {
    const text = message.text();
    if (message.type() === 'error') consoleErrors.push(text.slice(0, 300));
    if (text.includes('[stream-perf]')) streamConsole.push(text.slice(0, 300));
  });
  page.on('pageerror', error => pageErrors.push(error.message.slice(0, 300)));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/llm') {
      llmPosts += 1;
      requestBody = request.postDataJSON();
    }
  });
  page.on('response', response => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/llm') {
      responseStatus = response.status();
      responseContentType = response.headers()['content-type'] || '';
    }
  });

  await page.goto(`${origin}/tools/text/text-chat`, { waitUntil: 'networkidle', timeout: 60_000 });
  const modelSelect = page.getByLabel('选择创作模型');
  await modelSelect.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const select = document.querySelector('select[aria-label="选择创作模型"]');
    return select instanceof HTMLSelectElement && !select.disabled && select.options.length > 0 && Boolean(select.value);
  }, undefined, { timeout: 30_000 });
  if (requestedModelId) {
    await modelSelect.selectOption(requestedModelId);
  } else if (requestedModelLabel) {
    const option = await modelSelect.locator('option').evaluateAll((options, expected) => {
      const match = options.find(candidate => (candidate.textContent || '').includes(expected));
      return match instanceof HTMLOptionElement ? { value: match.value, label: match.textContent || '' } : null;
    }, requestedModelLabel);
    assert.ok(option?.value, `Requested model option is unavailable: ${requestedModelLabel}`);
    await modelSelect.selectOption(option.value);
  }
  const selectedModelId = await modelSelect.inputValue();
  const selectedModelLabel = await modelSelect.locator('option:checked').innerText();
  const prompt = `请只回复“本地对话验收通过”，不要调用图片、音频或视频工具。${marker}`;
  await page.getByRole('textbox', { name: '创作需求', exact: true }).fill(prompt);
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/llm', { timeout: 60_000 }).catch(error => error);
  const start = Date.now();
  await page.getByLabel('发送创作需求').click();
  const response = await responsePromise;
  if (response instanceof Error) throw response;
  const headersAt = Date.now();
  await fs.writeFile(path.join(out, 'response-headers.json'), JSON.stringify({
    at: new Date().toISOString(),
    llmPosts,
    responseStatus,
    responseContentType,
    selectedModelId,
    conversationId: requestBody?.conversationId || null,
  }, null, 2) + '\n');
  const sampler = setInterval(async () => {
    try {
      const text = await page.getByTestId('agent-message-list').innerText();
      samples.push({ ms: Date.now() - start, length: text.length });
    } catch {}
  }, 50);
  try {
    await page.waitForFunction(() => {
      const completedAssistant = [...document.querySelectorAll('[data-testid="agent-message-list"] article')]
        .some(article => article.getAttribute('data-role') === 'assistant'
          && article.getAttribute('data-message-status') === 'complete');
      const failed = document.querySelector('[data-testid="agent-message-list"] article[data-message-status="failed"]');
      const button = document.querySelector('button[aria-label="发送创作需求"]');
      const stillSpinning = button?.querySelector('svg')?.getAttribute('class')?.includes('spin') === true;
      return Boolean(failed) || (completedAssistant && !stillSpinning);
    }, undefined, { timeout: 180_000 });
    assert.equal(await page.locator('[data-testid="agent-message-list"] article[data-message-status="failed"]').count(), 0, 'The actual assistant reply failed; stop this canary without replay');
  } catch (error) {
    const domState = await page.evaluate(() => ({
      button: (() => {
        const element = document.querySelector('button[aria-label="发送创作需求"]');
        return element ? { disabled: element instanceof HTMLButtonElement ? element.disabled : null, html: element.outerHTML.slice(0, 500) } : null;
      })(),
      messages: [...document.querySelectorAll('[data-testid="agent-message-list"] article')].map(article => ({
        role: article.getAttribute('data-role'),
        status: article.getAttribute('data-message-status'),
        text: (article.textContent || '').slice(0, 500),
      })),
    }));
    await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      llmPosts,
      responseStatus,
      responseContentType,
      requestModelId: requestBody?.model || null,
      conversationId: requestBody?.conversationId || null,
      streamConsole,
      consoleErrors,
      pageErrors,
      samples,
      domState,
    }, null, 2) + '\n');
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true, timeout: 8_000 }).catch(() => {});
    throw error;
  } finally {
    clearInterval(sampler);
  }
  // Playwright's response.finished() can remain pending for a completed SSE
  // response even after the page has consumed [DONE]. The enabled send button
  // is the user-visible completion boundary; bound the transport check so the
  // verifier itself cannot hang after a successful, persisted model call.
  const transportFinished = await Promise.race([
    response.finished().then(() => true).catch(() => false),
    page.waitForTimeout(5_000).then(() => false),
  ]);
  await page.waitForTimeout(800);
  const messageText = await page.getByTestId('agent-message-list').innerText();
  const completedAssistant = page.locator(
    '[data-testid="agent-message-list"] article[data-role="assistant"][data-message-status="complete"]',
  ).last();
  const assistantText = await completedAssistant.innerText();
  assert.equal(llmPosts, 1);
  assert.equal(responseStatus, 200);
  assert.match(responseContentType || '', /text\/event-stream/iu);
  assert.equal(requestBody?.modelId, selectedModelId);
  assert.ok(typeof requestBody?.conversationId === 'string' && requestBody.conversationId.length > 5);
  assert.ok(messageText.includes(marker));
  assert.match(assistantText, /本地对话验收通过/u);
  const uniquePositiveLengths = [...new Set(samples.map(sample => sample.length).filter(length => length > prompt.length))];
  assert.ok(streamConsole.some(line => line.includes('first-paint')) || uniquePositiveLengths.length >= 2, 'No progressive render evidence');

  let historyResponse;
  let history;
  let messages = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    historyResponse = await context.request.get(`${origin}/api/conversations/history?id=${encodeURIComponent(requestBody.conversationId)}`, { headers: { Authorization: `Bearer ${token}` } });
    history = await historyResponse.json();
    assert.ok(historyResponse.ok());
    messages = history?.conversation?.messages || [];
    if (messages.some(message => message.role === 'assistant' && String(message.content).includes('本地对话验收通过'))) break;
    await page.waitForTimeout(250);
  }
  assert.ok(messages.some(message => message.role === 'user' && String(message.content).includes(marker)));
  assert.ok(messages.some(message => message.role === 'assistant' && String(message.content).includes('本地对话验收通过')));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(700);
  const restored = (await page.locator('body').innerText()).includes(marker);
  assert.equal(restored, true);
  const report = {
    at: new Date().toISOString(), runId, selectedModelId, selectedModelLabel, requestModelId: requestBody.modelId,
    conversationId: requestBody.conversationId, llmPosts, responseStatus, responseContentType,
    headersMs: headersAt - start, transportFinished, progressivePaint: true, uniqueProgressiveLengths: uniquePositiveLengths.length,
    historyUserSaved: true, historyAssistantSaved: true, refreshRestored: true, overflow,
    adminChargeExpected: 0, consoleErrors, pageErrors, credentialsPersisted: false,
  };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await page.screenshot({ path: path.join(out, 'restored.png'), fullPage: true });
  console.log(JSON.stringify({ success: true, llmPosts, selectedModelLabel, headersMs: report.headersMs, progressivePaint: true, historySaved: true, refreshRestored: true, report: path.join(out, 'report.json') }));
} finally {
  await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 5_000))]);
}
