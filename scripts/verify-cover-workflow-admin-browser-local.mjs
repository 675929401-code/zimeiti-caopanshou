import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

// Explicit local acceptance: real password step-up, temporary equivalent
// workflow publication and free prepare only. Never analyze or execute.
const origin = 'http://127.0.0.1:5000';
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || 'null');
const password = process.env.COVER_ADMIN_ACCEPTANCE_PASSWORD;
const credentialUser = process.env.COVER_ADMIN_ACCEPTANCE_USERNAME;
assert.ok(token && identity?.user?.id && password);
assert.equal(identity.user.username, credentialUser, 'Controlled password must match the existing administrator');
assert.ok(process.argv.includes('--execute-local-config'));
const directory = path.resolve(process.env.COVER_ADMIN_EVIDENCE_DIR || '');
assert.ok(process.env.COVER_ADMIN_EVIDENCE_DIR);
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(directory, 'submit-consumed.json'), JSON.stringify({ at: new Date().toISOString(), rule: 'Do not rerun this directory after an uncertain write; query original state.' }), { flag: 'wx' });
const report = { scope: 'current local administrator page, real configuration publication and free prepare; no analysis or media provider', checks: [], operations: [], screenshots: [], errors: [], blockedWrites: [], providerCalls: 0, passed: false };
const save = () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
const check = (name, passed, detail) => { report.checks.push({ name, passed, ...(detail ? { detail } : {}) }); assert.ok(passed, name); };
let step = '', browser, original, written = false, restorationVerified = false;
const headers = () => ({ Authorization: `Bearer ${token}`, ...(step ? { 'x-admin-step-up': step } : {}), 'Content-Type': 'application/json' });
async function get(route) { const response = await fetch(origin + route, { headers: headers(), cache: 'no-store', signal: AbortSignal.timeout(20000) }); assert.equal(response.status, 200, route); return response.json(); }
async function snap(page, name) { const file = path.join(directory, name + '.png'); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push({ name, file }); }
async function clickMutation(page, control, action) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/cover-styles'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.action === action);
  await control.click(); const response = await pending; const body = await response.json();
  report.operations.push({ action, status: response.status(), ok: body.ok, revision: body.revision, hash: body.hash, code: body.code });
  await save(); assert.equal(response.status(), 200, body.code || body.error); assert.equal(body.ok, true); return body;
}
try {
  report.runtime = await get('/api/version');
  const locked = await fetch(origin + '/api/admin/cover-styles', { headers: headers() });
  const lockedBody = await locked.json();
  check('existing administrator needs sensitive unlock', locked.status === 428 && lockedBody.code === 'ADMIN_STEP_UP_REQUIRED', { status: locked.status, code: lockedBody.code });
  const unlock = await fetch(origin + '/api/admin/access-control/unlock', { method: 'POST', headers: headers(),
    body: JSON.stringify({ password, mode: 'login', durationMinutes: 30 }), signal: AbortSignal.timeout(20000) });
  const unlockBody = await unlock.json();
  check('normal password step-up succeeds', unlock.status === 200 && unlockBody.success === true, { status: unlock.status, code: unlockBody.code });
  step = /zimeiti_admin_step_up=([^;]+)/u.exec(unlock.headers.get('set-cookie') || '')?.[1] || '';
  assert.ok(step); delete process.env.COVER_ADMIN_ACCEPTANCE_PASSWORD;
  original = await get('/api/admin/cover-styles?styleKey=cartoon');
  check('existing unsaved workflow draft is protected', !original.workflow.draft);
  report.baseline = { revision: original.revision, hash: original.hash, workflowReleaseId: original.workflow.current.releaseId,
    styleVersions: original.styles.map(row => [row.styleKey, row.currentVersion]) };
  const candidate = original.modelOptions.find(model => model.available);
  assert.ok(candidate, 'one currently eligible analysis model required');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: headers() });
  await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'zimeiti_admin_step_up', value: step, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  await context.addInitScript(({ token, user }) => { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); }, { token, user: identity.user });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname === '/api/auth/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(identity) });
    if (!['GET', 'HEAD'].includes(request.method())) {
      const body = request.postDataJSON();
      if (url.pathname === '/api/admin/cover-styles' && ['preview', 'workflow-draft', 'workflow-publish'].includes(body?.action)) {
        if (body.action !== 'preview') { written = true; report.operations.push({ phase: 'before-forward', action: body.action, expectedRevision: body.expectedRevision }); await save(); }
      } else if (url.pathname !== '/api/cover-workbench/prepare') {
        report.blockedWrites.push({ path: url.pathname, method: request.method() }); return route.abort('blockedbyclient');
      }
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message.slice(0, 300)));
  await page.goto(origin + '/admin?tab=cover-styles', { waitUntil: 'networkidle' });
  const panel = page.getByTestId('cover-styles-admin'); await panel.waitFor();
  const shared = panel.getByTestId('cover-workflow-shared-rules');
  await shared.waitFor(); await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="cover-workflow-shared-rules"]')?.value));
  check('full shared rules are visible', (await shared.inputValue()) === original.workflow.current.sharedRules);
  check('editor exposes complete legacy style rules', (await panel.getByTestId('cover-style-analysis-prompt').inputValue()).includes('无字静帧'));
  await snap(page, 'admin-management-default');
  // Navigation rejection must preserve the text. No browser storage is used.
  const originalText = await shared.inputValue(); await shared.fill(originalText + '\n未保存输入保护验收');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '读取最新状态', exact: true }).click();
  check('reload cancellation retains unsaved input', (await shared.inputValue()).endsWith('未保存输入保护验收'));
  await shared.fill(originalText);
  await panel.getByTestId('cover-workflow-text-model').selectOption(candidate.id);
  await panel.getByTestId('cover-preview-source').selectOption('editor');
  const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/cover-styles'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'preview');
  await panel.getByTestId('cover-workflow-preview').click();
  const preview = await (await previewResponse).json();
  check('free preview uses real compiled prompt and selected model', preview.ok && preview.preview.model.id === candidate.id
    && preview.preview.model.source === 'configured' && preview.preview.systemPrompt.includes(originalText));
  report.preview = { mode: preview.preview.mode, textUnits: preview.preview.textUnits,
    systemSha256: createHash('sha256').update(preview.preview.systemPrompt).digest('hex'), modelName: preview.preview.model.displayName };
  await snap(page, 'admin-compiled-preview');
  const draft = await clickMutation(page, panel.getByTestId('cover-workflow-save-draft'), 'workflow-draft');
  check('saving a draft does not publish', draft.workflow.current.releaseId === original.workflow.current.releaseId);
  page.once('dialog', dialog => dialog.accept());
  const published = await clickMutation(page, panel.getByTestId('cover-workflow-publish'), 'workflow-publish');
  check('publication moves effective workflow and pins chosen model', published.workflow.current.textModelId === candidate.id
    && published.workflow.current.releaseId === draft.workflow.draft.releaseId);
  const current = await get('/api/admin/cover-styles?styleKey=cartoon');
  check('published configuration reads back exactly', current.hash === published.hash);
  const publicStyles = await get('/api/cover-styles');
  check('public catalog has no private rules or raw analysis model binding', !JSON.stringify(publicStyles).includes('sharedRules') && !JSON.stringify(publicStyles).includes(candidate.id));
  await page.goto(origin + '/cover', { waitUntil: 'networkidle' });
  await page.locator('#cover-workbench-text').fill('后台管理免费准备验收：以前总拖延，现在每天先做十分钟。');
  const prepareResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/cover-workbench/prepare' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '下一步：拆解内容', exact: true }).click();
  const preparedResponse = await prepareResponse, prepared = await preparedResponse.json();
  check('real front-end free prepare succeeds', preparedResponse.status() === 200 && prepared.success !== false, { status: preparedResponse.status(), code: prepared.code });
  const serialized = JSON.stringify(prepared);
  check('free prepare shows configured analysis model without private prompt leakage', serialized.includes(candidate.displayName)
    && !serialized.includes('sharedRules') && !serialized.includes('frozenWorkflowRuntime') && !serialized.includes(candidate.id));
  report.freePrepare = { operationId: prepared.task?.operationId || prepared.operationId || prepared.operation?.id, state: prepared.task?.state || prepared.state, modelName: candidate.displayName };
  await snap(page, 'cover-free-prepare-configured-model');
  for (const route of ['/storyboard-workbench', '/image-workbench']) {
    await page.goto(origin + route, { waitUntil: 'networkidle' });
    check('neighbor page loads ' + route, await page.locator('body').innerText().then(text => text.length > 100));
    await snap(page, 'neighbor-' + route.slice(1));
  }
  await context.close();
  check('no browser JavaScript exception', report.errors.length === 0);
  report.passed = true;
} catch (error) { report.error = String(error.message).slice(0, 600); process.exitCode = 1; }
finally {
  if (written && original && step) {
    try {
      const current = await get('/api/admin/cover-styles');
      if (current.workflow.current.releaseId !== original.workflow.current.releaseId) {
        report.operations.push({ phase: 'before-forward', action: 'workflow-rollback', expectedRevision: current.revision }); await save();
        const response = await fetch(origin + '/api/admin/cover-styles', { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'workflow-rollback',
          releaseId: original.workflow.current.releaseId, expectedRevision: current.revision, expectedHash: current.hash }), signal: AbortSignal.timeout(20000) });
        const result = await response.json(); assert.equal(response.status, 200, result.code || result.error);
        report.operations.push({ action: 'workflow-rollback', status: response.status, revision: result.revision, hash: result.hash });
      }
      const restored = await get('/api/admin/cover-styles');
      restorationVerified = restored.workflow.current.releaseId === original.workflow.current.releaseId;
      check('original published workflow restored after acceptance', restorationVerified);
    } catch (error) { report.restorationError = String(error.message).slice(0, 400); report.passed = false; process.exitCode = 1; }
  }
  report.restorationVerified = restorationVerified;
  if (step) {
    const locked = await fetch(origin + '/api/admin/access-control/unlock', { method: 'DELETE', headers: headers() }).catch(() => null);
    report.stepUpRevoked = locked?.ok === true;
  }
  await browser?.close(); await save();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, restorationVerified, directory, error: report.error }));
}
