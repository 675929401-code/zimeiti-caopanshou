import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from 'playwright';

const origin = process.env.LOCAL_NAV_ORIGIN?.trim() || 'http://127.0.0.1:5000';
if (origin !== 'http://127.0.0.1:5000' && origin !== 'http://127.0.0.1:5002') throw new Error('LOCAL_NAV_ORIGIN_MUST_BE_LOOPBACK_PREVIEW');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
const output = process.argv[2];
if (!token || !output) throw new Error('NORMAL_SESSION_AND_NEW_OUTPUT_REQUIRED');
const resume = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
if (resume && !/^e2e-plugin-\d+-[a-z0-9]+$/u.test(resume.marker)) throw new Error('OWN_PLUGIN_EVIDENCE_REQUIRED');
const marker = resume?.marker || `e2e-plugin-${Date.now()}-${randomUUID().slice(0, 8)}`;
const endpoint = '/api/admin/plugins';
const headers = { Authorization: `Bearer ${token}` };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (value, reason) => { if (!value) throw new Error(reason); };
const report = { observedAt: new Date().toISOString(), origin, authentication: 'normal-login-token-verified-via-auth-me', marker, realBrowser: true, responseFixtures: false, upstreamRequests: 0, secretsSaved: false, steps: [], httpErrors: [], pageErrors: [], requestFailures: [], blocked: [], documentEvents: [], hotReloadEvents: [] };
report.pluginRequests = [];
const advancing = new Set(['/api/video/status', '/api/video/poll', '/api/video/stream', '/api/image/status', '/api/admin/voice-studio/voices/sync']);
let browser; let page; let ownId = ''; let cleaned = false; let stage = 'authenticate';
let lastDocumentChange = Date.now();
let expectedMutationMethod = '';
const checkpointPath = output + '.checkpoint.json';
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(checkpointPath, JSON.stringify({ marker, stage, startedAt: report.observedAt, mutationDispatched: false }) + '\n', { flag: 'wx' });
const safePath = (value) => { const url = new URL(value, origin); return url.origin === origin ? url.pathname : 'external-resource'; };
async function api(url, options = {}) {
  const response = await fetch(origin + url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30000) });
  const body = await response.json(); check(response.ok, `API_${response.status}`); return body;
}
async function mutation(action, method) {
  const deadline = Date.now() + 20000;
  while (Date.now() - lastDocumentChange < 2500) {
    check(Date.now() < deadline, 'DEVELOPMENT_DOCUMENT_UNSTABLE');
    await page.waitForTimeout(500);
  }
  fs.writeFileSync(checkpointPath, JSON.stringify({ marker, stage, method, mutationAttempted: true, pluginId: ownId || null }) + '\n');
  expectedMutationMethod = method;
  let response;
  try {
    [response] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.request().method() === method, { timeout: 30000 }),
      Promise.resolve().then(action),
    ]);
  } finally { expectedMutationMethod = ''; }
  const body = await response.json();
  report.steps.push({ stage, http: response.status() }); check(response.ok(), `SAVE_${response.status()}`); return body;
}
try {
  const auth = await api('/api/auth/me'); check(auth.user?.username === '18685178259' && auth.user?.role === 'admin', 'EXPECTED_ADMIN_REQUIRED');
  const initial = await api(endpoint); report.originalPluginCount = initial.plugins.length;
  if (resume) {
    const matches = initial.plugins.filter((plugin) => [marker, marker + '-edited'].includes(plugin.name));
    check(matches.length === 1 && matches[0].is_active === false && matches[0].role === '' && matches[0].config.api_base_url === 'https://example.com/no-upstream-call', 'UNRESOLVED_CREATE_REQUIRES_READBACK');
    ownId = matches[0].id; report.pluginId = ownId;
    report.steps.push({ stage: 'reconcile-own-create', matchedExistingRecord: true, creationResubmitted: false });
  }
  const originalRegistry = initial.plugins.filter((plugin) => plugin.id !== ownId);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1100 }, serviceWorkers: 'block' });
  await context.addInitScript(({ tokenValue, user, expectedOrigin }) => { if (location.origin !== expectedOrigin) return; localStorage.setItem('auth_token', tokenValue); localStorage.setItem('auth_user', JSON.stringify(user)); }, { tokenValue: token, user: auth.user, expectedOrigin: origin });
  await context.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    let allowed = method === 'GET' && !(url.origin === origin && advancing.has(url.pathname));
    if (url.origin === origin && url.pathname === '/__nextjs_original-stack-frames' && method === 'POST') allowed = true;
    if (url.origin === origin && url.pathname === endpoint) {
      if (method === 'POST' || method === 'PUT') {
        try { const body = JSON.parse(request.postData() || '{}'); allowed = method === 'POST' ? !resume && body.name === marker && body.is_active === false && body.role === '' : Boolean(ownId) && body.id === ownId; report.pluginRequests.push({ stage, at: new Date().toISOString(), method, ownPayloadMatched: allowed, runnerActionStarted: expectedMutationMethod === method }); } catch { allowed = false; }
      }
      if (method === 'DELETE') allowed = Boolean(ownId) && url.searchParams.get('id') === ownId;
    }
    if (allowed) await route.continue(); else { report.blocked.push({ path: safePath(url.href), method }); await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) { lastDocumentChange = Date.now(); report.documentEvents.push({ stage, at: new Date().toISOString(), path: safePath(frame.url()), cssRecovery: new URL(frame.url(), origin).searchParams.has('_nocache') }); } });
  page.on('console', (message) => { const text = message.text(); if (/\[Fast Refresh\]|\[HMR\]|\[FormGuard\]|CSS健康检测/u.test(text)) { lastDocumentChange = Date.now(); report.hotReloadEvents.push({ stage, at: new Date().toISOString(), event: /CSS健康检测/u.test(text) ? 'css-recovery' : /\[FormGuard\]/u.test(text) ? 'form-fallback' : /rebuilding/u.test(text) ? 'rebuilding' : /done/u.test(text) ? 'done' : 'hmr-event' }); } });
  page.on('dialog', (dialog) => stage === 'plugin-delete' && dialog.type() === 'confirm' ? dialog.accept() : dialog.dismiss());
  page.on('pageerror', (error) => report.pageErrors.push({ stage, name: error.name }));
  page.on('response', (response) => { if (response.status() >= 400) report.httpErrors.push({ stage, path: safePath(response.url()), status: response.status() }); });
  page.on('requestfailed', (request) => report.requestFailures.push({ stage, path: safePath(request.url()), reason: request.failure()?.errorText.match(/(?:net::)?ERR_[A-Z_]+/u)?.[0] || 'REQUEST_FAILED' }));
  stage = 'plugin-navigation'; await page.goto(origin + '/admin?tab=plugins', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const panel = page.locator('[data-admin-section="plugin-management"]');
  await panel.getByRole('button', { name: '添加插件', exact: true }).waitFor({ state: 'visible', timeout: 45000 });
  report.steps.push({ stage, panelVisible: true, navigationEntryCount: await page.getByRole('button', { name: '插件管理', exact: true }).count() });
  const form = panel.getByRole('form');
  if (!resume) {
  await panel.getByRole('button', { name: '添加插件', exact: true }).click();
  await form.getByLabel('插件名称', { exact: true }).fill(marker);
  await form.getByLabel('API 地址', { exact: true }).fill('https://example.com/no-upstream-call');
  await form.getByLabel('API Token', { exact: true }).fill('e2e-placeholder-not-a-real-provider-credential');
  await form.getByLabel('售价（元）', { exact: true }).fill('0');
  check(!await form.getByLabel('启用插件', { exact: true }).isChecked(), 'NEW_PLUGIN_MUST_START_INACTIVE');
  stage = 'plugin-create'; const created = await mutation(() => form.getByRole('button', { name: '保存插件', exact: true }).click(), 'POST');
  ownId = created.plugin?.id || ''; check(ownId && !initial.plugins.some((plugin) => plugin.id === ownId), 'OWN_NEW_PLUGIN_REQUIRED'); report.pluginId = ownId;
  }
  let stored = (await api(`${endpoint}?id=${encodeURIComponent(ownId)}`)).plugin;
  check([marker, marker + '-edited'].includes(stored.name) && stored.price_per_use === 0 && stored.is_active === false, 'CREATE_READBACK_FAILED');
  const placeholderPresent = stored.config.api_token === '********';
  check(resume || placeholderPresent, 'CREATE_CREDENTIAL_READBACK_FAILED');
  report.steps.push({ stage: 'plugin-create-readback', inactive: true, zeroPrice: true, maskedCredential: placeholderPresent });
  const card = panel.locator(`[data-plugin-id="${ownId}"]`);
  await card.getByRole('button', { name: '编辑插件', exact: true }).click();
  check(await form.getByLabel('API Token', { exact: true }).inputValue() === '', 'CREDENTIAL_INPUT_MUST_BE_BLANK');
  await form.getByLabel('插件名称', { exact: true }).fill(marker + '-edited');
  await form.getByLabel('排序', { exact: true }).fill('7');
  stage = 'plugin-edit'; await mutation(() => form.getByRole('button', { name: '保存插件', exact: true }).click(), 'PUT');
  stored = (await api(`${endpoint}?id=${encodeURIComponent(ownId)}`)).plugin;
  check(stored.name === marker + '-edited' && stored.sort_order === 7 && (stored.config.api_token === '********') === placeholderPresent && stored.price_per_use === 0 && stored.is_active === false, 'EDIT_READBACK_FAILED');
  report.steps.push({ stage: 'plugin-edit-readback', titleMatched: true, sortMatched: true, blankCredentialPreserved: true, zeroPrice: true });
  stage = 'plugin-reload'; await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await card.getByText(marker + '-edited', { exact: true }).waitFor({ state: 'visible', timeout: 45000 });
  report.steps.push({ stage, sameRecordVisible: true });
  if (placeholderPresent) {
  await card.getByRole('button', { name: '编辑插件', exact: true }).click();
  await form.getByLabel('清除 api_token 凭据', { exact: true }).check();
  stage = 'plugin-clear-own-placeholder'; await mutation(() => form.getByRole('button', { name: '保存插件', exact: true }).click(), 'PUT');
  stored = (await api(`${endpoint}?id=${encodeURIComponent(ownId)}`)).plugin; check(!Object.hasOwn(stored.config, 'api_token'), 'EXPLICIT_CLEAR_READBACK_FAILED');
  report.steps.push({ stage: 'plugin-clear-readback', ownPlaceholderRemoved: true });
  }
  stage = 'plugin-delete'; await mutation(() => card.getByRole('button', { name: '删除插件', exact: true }).click(), 'DELETE');
  const finalList = await api(endpoint); check(!finalList.plugins.some((plugin) => plugin.id === ownId), 'DELETE_READBACK_FAILED'); cleaned = true;
  check(hash(finalList.plugins) === hash(originalRegistry), 'ORIGINAL_PLUGINS_CHANGED');
  report.steps.push({ stage: 'plugin-cleanup-readback', ownRecordAbsent: true, originalRegistryUnchanged: true });
  stage = 'model-link-regression'; await page.goto(origin + '/admin?tab=models', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByRole('button', { name: /文案提取/u }).first().click();
  await page.getByRole('link', { name: '添加与管理插件', exact: true }).waitFor({ state: 'visible' });
  report.steps.push({ stage, pluginManagementLinkVisible: true });
  stage = 'manju-navigation-regression'; await page.goto(origin + '/admin?tab=manju-workbench', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('[data-admin-section="manju-showcase-catalog"]').waitFor({ state: 'visible', timeout: 45000 });
  report.steps.push({ stage, materialManagerVisible: true }); report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { stage, name: error.name, reason: /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'BROWSER_STEP_FAILED' };
  if (page) report.dom = await page.evaluate(() => ({ panelCount: document.querySelectorAll('[data-admin-section="plugin-management"]').length, formCount: document.forms.length, alertCount: document.querySelectorAll('[role="alert"]').length, pageOverflow: document.documentElement.scrollWidth > innerWidth + 2 })).catch(() => ({ inaccessible: true }));
} finally {
  if (ownId && !cleaned) {
    try { await api(`${endpoint}?id=${encodeURIComponent(ownId)}`, { method: 'DELETE' }); report.cleanup = { onlyOwnRecord: true, absent: !(await api(endpoint)).plugins.some((plugin) => plugin.id === ownId) }; }
    catch { report.cleanupRequired = { pluginId: ownId }; }
  }
  try { await browser?.close(); } catch (error) { report.browserCloseError = { name: error.name }; }
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(report, null, 2));
}
