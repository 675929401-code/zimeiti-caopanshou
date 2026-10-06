import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Browser contract fixture: no generation request leaves this isolated context.
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5002';
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin));
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
assert.ok(token, 'NORMAL_SESSION_REQUIRED');
const meResponse = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
const { user } = await meResponse.json();
assert.ok(meResponse.ok && user?.role === 'admin');
const out = '.codex-evidence/image-reference-rejection-20260903';
await mkdir(out, { recursive: true });
const report = { kind: 'browser-contract-fixture', origin, actualUpstreamRequests: 0, checks: [], interceptedRequests: [], passed: false };
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ sessionToken, account }) => {
    localStorage.setItem('auth_token', sessionToken);
    localStorage.setItem('auth_user', JSON.stringify(account));
  }, { sessionToken: token, account: user });
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/image/generate') {
      const body = request.postDataJSON();
      report.interceptedRequests.push({ key: body.clientIdempotencyKey, trace: body.clientTraceId, modelId: body.modelId });
      const response = report.interceptedRequests.length === 1
        ? { error: '测试拒绝：参考图未被受理', state: 'rejected', canResubmit: true, sameKeyCanResubmit: false, code: 'IMAGE_REQUEST_REJECTED' }
        : { error: '测试网络中断', state: 'unknown', canResubmit: false, code: 'IMAGE_UPSTREAM_ERROR' };
      return route.fulfill({ status: 502, json: response });
    }
    if (url.pathname === '/api/image/status') return route.fulfill({ status: 200, json: { state: 'unknown', canRecover: false, canResubmit: false, message: '测试原请求仍未确认' } });
    if (!['GET', 'HEAD'].includes(request.method())) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${origin}/image-workbench`);
  const prompt = page.locator('textarea').first();
  await prompt.waitFor();
  await prompt.fill('图片拒绝状态浏览器契约测试，不发送真实上游');
  const generate = page.getByRole('button', { name: /生成图片（\d+）/ });
  await generate.click();
  await page.getByText('测试拒绝：参考图未被受理', { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('生成图片（1）') && !button.disabled));
  assert.equal(report.interceptedRequests.length, 1);
  report.checks.push({ name: 'Confirmed rejection shown as actionable failure', passed: true });
  await generate.click();
  await page.getByText('测试原请求仍未确认', { exact: true }).waitFor();
  assert.equal(report.interceptedRequests.length, 2);
  assert.notEqual(report.interceptedRequests[0].key, report.interceptedRequests[1].key);
  assert.equal(report.interceptedRequests[0].modelId, report.interceptedRequests[1].modelId);
  assert.equal(await generate.isDisabled(), true);
  report.checks.push({ name: 'Explicit next click uses new key and the same selected model', passed: true });
  report.checks.push({ name: 'Unknown second request disables repeated generation', passed: true });
  await page.reload();
  await page.getByText(/安全追踪编号|结果待确认|原请求号已保留|测试原请求仍未确认/).first().waitFor();
  const persisted = await page.evaluate(id => JSON.parse(sessionStorage.getItem(`app_state_image_workbench_prompt_cards_v1:user:${id}`) || '[]'), user.id);
  const original = persisted.find(card => card.generationKey === report.interceptedRequests[1].key);
  assert.equal(original.generationKey, report.interceptedRequests[1].key);
  assert.equal(original.schema, 'image_workbench_attempt_reference.v1');
  assert.equal(Object.hasOwn(original, 'prompt'), false);
  assert.equal(Object.hasOwn(original, 'rejectedAttempts'), false);
  assert.equal(report.interceptedRequests.length, 2);
  report.checks.push({ name: 'Refresh retains only the opaque unknown identity without POST or prompt leakage', passed: true });
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message.replace(/https?:\/\/\S+/gu, '[url]').slice(0,500) : 'Unknown failure';
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(`${out}/ui-contract-${Date.now()}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
