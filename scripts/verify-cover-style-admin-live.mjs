import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5000';
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const step = process.env.LOCAL_ADMIN_STEP_UP_TOKEN;
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || 'null');
assert.ok(token && step && identity?.user?.id);
assert.ok(process.argv.includes('--execute-local-config'), 'Explicit local configuration verification is required');
const directory = path.resolve(process.env.COVER_ADMIN_EVIDENCE_DIR);
await fs.mkdir(directory, { recursive: true });
const marker = path.join(directory, 'config-submit-consumed.json');
await fs.writeFile(marker, JSON.stringify({ at: new Date().toISOString(), rule: 'Do not replay this run. Read the existing configuration after any uncertain outcome.' }), { flag: 'wx' });
const headers = { Authorization: `Bearer ${token}`, 'x-admin-step-up': step };
const report = { scope: 'real local administrator UI and configuration; no provider or paid generation', operations: [], checks: [], errors: [], paidCalls: 0, passed: false };
const save = () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = async route => { const response = await fetch(origin + route, { headers, cache: 'no-store' }); assert.equal(response.status, 200, route); return response.json(); };
const browser = await chromium.launch({ headless: true });
let captures = Promise.resolve();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: headers });
  await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'zimeiti_admin_step_up', value: step, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  await context.addInitScript(({ token, user }) => { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); }, { token, user: identity.user });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== '/api/admin/cover-styles') return route.abort('blockedbyclient');
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message.slice(0, 300)));
  page.on('response', response => {
    if (new URL(response.url()).pathname !== '/api/admin/cover-styles' || response.request().method() !== 'POST') return;
    captures = captures.then(async () => {
      const body = await response.json(), request = response.request().postDataJSON();
      report.operations.push({ at: new Date().toISOString(), action: request.action, styleKey: request.styleKey, httpStatus: response.status(),
        ok: body.ok, revision: body.revision, hash: body.hash, selectedVersion: body.selected?.viewed?.version,
        selectedReleaseId: body.selected?.viewed?.releaseId, error: body.code });
      await save();
    });
  });
  async function clickWrite(button) {
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/cover-styles' && response.request().method() === 'POST');
    await button.click(); const response = await responsePromise; const data = await response.json();
    await captures; assert.equal(response.status(), 200, data.code || data.error); assert.equal(data.ok, true);
    await page.getByRole('status').filter({ hasText: /已保存|已读回/u }).first().waitFor();
    return data;
  }
  const publicBefore = await read('/api/cover-styles');
  const original = await read('/api/admin/cover-styles?styleKey=cartoon');
  report.baseline = { revision: original.revision, hash: original.hash, publicStyles: publicBefore.styles, selectedReleaseId: original.selected.currentReleaseId };
  await page.goto(origin + '/admin?tab=cover-styles', { waitUntil: 'networkidle' });
  const panel = page.getByTestId('cover-styles-admin'); await panel.waitFor();
  const analysisInput = panel.getByTestId('cover-style-analysis-prompt'), generationInput = panel.getByTestId('cover-style-generation-prompt');
  await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="cover-style-analysis-prompt"]')?.value));
  const analysisPrompt = await analysisInput.inputValue(), generationPrompt = await generationInput.inputValue();
  assert.equal(analysisPrompt, original.selected.viewed.analysisPrompt);
  assert.equal(generationPrompt, original.selected.viewed.generationPrompt);
  const analysisAddition = '\n审核前检查：标题、主体、动作、关系与核心观点一致；画面只表达一个清晰瞬间。';
  const generationAddition = '\n肢体与道具检查：人物的手部数量和归属必须正确，不增加手臂、手掌或手指。文案明确放下手机时，手机必须落在桌面等支撑物上，不能仍握在手里。';
  await analysisInput.fill(analysisPrompt + analysisAddition); await generationInput.fill(generationPrompt + generationAddition);
  const draft = await clickWrite(panel.getByRole('button', { name: '保存为新草稿版本', exact: true }));
  assert.deepEqual((await read('/api/cover-styles')).styles, publicBefore.styles, 'Saving a draft must not publish it');
  const published = await clickWrite(panel.getByRole('button', { name: '发布待发布版本', exact: true }));
  const current = await read('/api/admin/cover-styles?styleKey=cartoon');
  assert.equal(current.selected.viewed.analysisPrompt, analysisPrompt + analysisAddition);
  assert.equal(current.selected.viewed.generationPrompt, generationPrompt + generationAddition);
  assert.equal(current.selected.currentReleaseId, published.selected.currentReleaseId);
  const publicAfter = await read('/api/cover-styles');
  assert.equal(publicAfter.styles.find(style => style.styleKey === 'cartoon').version, draft.selected.viewed.version);
  assert.doesNotMatch(JSON.stringify(publicAfter), /analysisPrompt|generationPrompt|好运降临|哈尼有话讲/u);
  report.checks.push({ kind: 'real-ui-save-and-publish-paired-prompts', releaseId: current.selected.currentReleaseId, promptPairHash: hash([current.selected.viewed.analysisPrompt, current.selected.viewed.generationPrompt]) });
  // Exercise enabled/order/history through the same visible administrator controls.
  const firstRow = panel.getByRole('button', { name: /暖光叙事/u }).locator('..');
  await clickWrite(firstRow.getByRole('button', { name: '下移', exact: true }));
  assert.equal((await read('/api/cover-styles')).styles[0].styleKey, 'funny-cartoon');
  await clickWrite(firstRow.getByRole('button', { name: '上移', exact: true }));
  assert.equal((await read('/api/cover-styles')).styles[0].styleKey, 'cartoon');
  await clickWrite(firstRow.getByRole('button', { name: '停用', exact: true }));
  assert.ok(!(await read('/api/cover-styles')).styles.some(style => style.styleKey === 'cartoon'));
  await clickWrite(firstRow.getByRole('button', { name: '启用', exact: true }));
  assert.equal((await read('/api/cover-styles')).styles.length, publicBefore.styles.length);
  const history = panel.locator('select');
  await history.selectOption(original.selected.currentReleaseId);
  await clickWrite(panel.getByRole('button', { name: '将此已发布版本设为当前', exact: true }));
  assert.equal((await read('/api/admin/cover-styles?styleKey=cartoon')).selected.currentReleaseId, original.selected.currentReleaseId);
  await history.selectOption(current.selected.currentReleaseId);
  await clickWrite(panel.getByRole('button', { name: '将此已发布版本设为当前', exact: true }));
  const final = await read('/api/admin/cover-styles?styleKey=cartoon');
  assert.equal(final.selected.currentReleaseId, current.selected.currentReleaseId);
  assert.ok(final.selected.releases.some(release => release.releaseId === original.selected.currentReleaseId));
  report.checks.push({ kind: 'real-ui-order-enable-rollback-and-history-retained', finalRevision: final.revision, finalHash: final.hash });
  await page.screenshot({ path: path.join(directory, 'admin-paired-prompts.png'), fullPage: true });
  await page.goto(origin + '/cover', { waitUntil: 'networkidle' });
  await page.locator('#cover-workbench-style').waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /好运降临|哈尼有话讲|查看参考来源/u);
  await page.locator('#cover-workbench-style').click();
  await page.getByRole('dialog', { name: '选择画面风格' }).waitFor();
  await page.screenshot({ path: path.join(directory, 'public-published-style-picker.png') });
  report.publicFinal = await read('/api/cover-styles');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = String(error.message).slice(0, 500); process.exitCode = 1; }
finally { await captures; await save(); await browser.close(); console.log(JSON.stringify({ passed: report.passed, directory, operations: report.operations.length, error: report.error })); }
