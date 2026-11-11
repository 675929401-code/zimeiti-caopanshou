import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Run only through with-local-admin-session.mjs after root verifies runningLatest.
// The only identity inputs are the three LOCAL_NAV_* values, held in RAM.
export async function main() {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || '').replace(/\/$/u, '');
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '');
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}');
  assert.equal(origin, 'http://127.0.0.1:5000', 'Exact current local preview required');
  assert.ok(token && identity?.user?.id, 'RAM wrapper identity required');
  const output = path.resolve('.codex-evidence/native-ui-brand-f76f3d79/browser');
  await fs.mkdir(output, { recursive: true });
  const native = '/publish-center/native/zh-CN';
  const api = '/api/native-operations';
  const taskId = '46f68f81-2d9d-4cdf-8f9e-1775783182b2';
  const privateValues = [token, ...Object.values(identity.user).filter(value => typeof value === 'string' && value.length >= 3)];
  const redact = value => privateValues.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));
  const report = {
    passed: false, scope: 'Read-only desktop UI; fixtures explicitly labelled; no generation, save, publication or billing acceptance',
    checks: [], scenarios: [], screenshots: [], reads: [], blockedWrites: [], externalRequestsBlocked: 0,
    pageErrors: [], fixtures: [], limitations: [], realBusinessWrites: 0, paidCalls: 0,
  };
  const check = (name, passed, evidence) => {
    report.checks.push({ name, passed: !!passed, ...(evidence === undefined ? {} : { evidence }) });
    assert.ok(passed, name);
  };
  const poll = async (fn, label, timeout = 15000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(label);
  };
  const readyRuntime = {
    ready: true, message: '创作助手已就绪',
    budget: { maxCreditsPerTurn: '50.000000', maxCallsPerTurn: 8 },
    approval: { revision: 1, configHash: 'a'.repeat(64), maxCreditsPerTurn: '50.000000' },
    capabilities: { readDraft: true, saveDraft: true, media: false, publish: false },
  };
  const envelope = data => ({ code: 0, data, message: '' });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const contexts = new Set();
  let published;
  const contextFor = async (scenario, options = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', serviceWorkers: 'block', acceptDownloads: false });
    contexts.add(context);
    await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.addInitScript(({ authToken, user, theme }) => {
      localStorage.setItem('auth_token', authToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem('entered_app', '1');
      sessionStorage.setItem('trial_dialog_dismissed', '1');
      localStorage.setItem('user_theme_preference', theme);
      localStorage.setItem('user_theme_mode_preference', 'dark');
      localStorage.setItem('user_theme_preference_expires_at', new Date(Date.now() + 3600000).toISOString());
      localStorage.setItem('aitoearn-native.theme.v1', 'dark');
      window.__nativeAcceptanceDocumentMarker = Math.random().toString(36);
    }, { authToken: token, user: identity.user, theme: options.theme || 'soft-white' });
    report.fixtures.push({ scenario, path: '/api/auth/me', reason: 'RAM identity projection prevents GET account reconciliation' });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      // No write, including OPTIONS, is ever continued or fulfilled as success.
      if (!['GET', 'HEAD'].includes(method)) {
        report.blockedWrites.push({ scenario, method, path: url.pathname });
        return route.abort('blockedbyclient');
      }
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
        report.externalRequestsBlocked++;
        return route.abort('blockedbyclient');
      }
      if (url.pathname === '/api/auth/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: identity.user }) });
      if (options.route && await options.route(route, url)) return;
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push({ scenario, message: redact(error.message).slice(0, 500) }));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith('/api/')) report.reads.push({ scenario, path: url.pathname, status: response.status() });
    });
    return { context, page };
  };
  const json = async (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  const snap = async (page, name) => {
    // Never capture identity-bearing text or account/session diagnostics.
    const secrets = privateValues.filter(value => value !== token);
    const masks = secrets.map(value => page.getByText(value, { exact: true }));
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(output, filename), fullPage: false, mask: masks });
    report.screenshots.push(filename);
  };
  const go = async (page, route = 'ai-social') => {
    await page.goto(origin + native + '/' + route, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="sidebar-logo-link"]').waitFor({ state: 'visible' });
  };
  const input = page => page.locator('textarea.native-agent-composer__input').first();
  const send = page => page.locator('.native-agent-composer').getByRole('button', { name: '发送', exact: true }).first();
  const geometry = async locator => locator.evaluate(element => {
    const r = element.getBoundingClientRect(), css = getComputedStyle(element);
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, fontFamily: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight, color: css.color, background: css.backgroundColor, colorScheme: getComputedStyle(document.documentElement).colorScheme, dark: document.documentElement.classList.contains('dark') };
  });
  const inside = box => box.width > 0 && box.height > 0 && box.x >= -1 && box.right <= 1441 && box.y >= -1 && box.bottom <= 901;
  const brandVisible = async (page, branding = published) => {
    const name = branding.brand.name;
    await poll(async () => (await page.locator('[data-testid="sidebar-logo-link"]').first().innerText()).includes(name), 'Published brand must render');
    const sidebar = page.locator('[data-testid="sidebar-logo-link"]').first();
    check('sidebar host name without upstream product wordmark', (await sidebar.innerText()).includes(name) && !/aitoearn/iu.test(await sidebar.innerText()));
    check('logo root href', await sidebar.getAttribute('href') === '/');
    await poll(async () => (await page.title()).startsWith(name), 'Document title must use Host brand');
    const expectedIcon = branding.assets.favicon?.url;
    const actualIcon = await page.locator('link[rel="icon"]').first().getAttribute('href');
    check('favicon follows host branding', expectedIcon ? actualIcon === expectedIcon : !!actualIcon && !/aitoearn|publish-center\/native\/favicon/iu.test(actualIcon));
    if (branding.assets.logo_square?.url) {
      const source = await sidebar.locator('img').getAttribute('src');
      const actual = new URL(source, origin), expected = new URL(branding.assets.logo_square.url, origin);
      check('square logo uses published asset and small derivative', actual.pathname === expected.pathname && actual.searchParams.get('revision') === expected.searchParams.get('revision') && actual.searchParams.getAll('w').length === 1 && actual.searchParams.get('w') === '256');
      await poll(() => sidebar.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), 'Published logo must decode');
    }
  };
  const scenario = async (name, fn, kind = 'actual-read-only-ui') => {
    const start = Date.now();
    try { await fn(); report.scenarios.push({ name, kind, passed: true, elapsedMs: Date.now() - start }); }
    catch (error) { report.scenarios.push({ name, kind, passed: false, error: redact(error.message).slice(0, 700), elapsedMs: Date.now() - start }); }
  };
  try {
    await scenario('real-public-brand-runtime-and-SPA', async () => {
      const { page } = await contextFor('actual');
      await go(page);
      const result = await page.evaluate(async () => { const response = await fetch('/api/branding', { cache: 'no-store' }); return { status: response.status, body: await response.json() }; });
      check('real public branding readable', result.status === 200 && result.body.ok === true);
      published = result.body.branding;
      check('real brand Host matches current preview', published.hostname === new URL(origin).hostname);
      await brandVisible(page);
      const toggle = page.locator('[data-testid="sidebar-toggle-btn"]');
      await toggle.focus(); check('sidebar toggle keyboard focus', await toggle.evaluate(element => element === document.activeElement));
      await toggle.click(); check('collapsed logo remains visible', await page.locator('[data-testid="sidebar-logo-link"]').isVisible());
      await toggle.click();
      await input(page).waitFor({ state: 'visible' });
      await poll(async () => report.reads.some(item => item.scenario === 'actual' && item.path === api + '/agent/runtime'), 'Real runtime GET required');
      check('real runtime is explicit unavailable 503', report.reads.some(item => item.scenario === 'actual' && item.path === api + '/agent/runtime' && item.status === 503));
      await page.getByText(/未就绪|暂不可用|暂时不可用|尚未安装/).first().waitFor();
      check('unavailable send disabled', await send(page).isDisabled());
      check('unavailable upload controls disabled', await page.locator('.native-agent-composer').getByRole('button', { name: 'Upload media', exact: true }).isDisabled());
      const placeholder = await input(page).getAttribute('placeholder');
      check('short placeholder and empty actual input', !!placeholder && placeholder.length <= 55 && await input(page).inputValue() === '');
      const font = await geometry(input(page));
      check('modern input computed font and readable size', /sans|Arial|Inter|Segoe|PingFang|YaHei/iu.test(font.fontFamily) && Number.parseFloat(font.fontSize) >= 14 && inside(font), font);
      const cdp = await page.context().newCDPSession(page);
      try { await cdp.send('DOM.enable'); await cdp.send('CSS.enable'); const { root } = await cdp.send('DOM.getDocument'); const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'textarea.native-agent-composer__input' }); const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }); report.checks.push({ name: 'rendered input fonts diagnostic', passed: true, evidence: fonts.fonts.map(item => ({ familyName: item.familyName, glyphCount: item.glyphCount })) }); } catch { report.limitations.push('CDP rendered fonts unavailable; computed font checked'); } finally { await cdp.detach(); }
      const wallet = page.locator('[data-testid="sidebar-wallet"][aria-busy="false"]');
      await wallet.waitFor({ state: 'visible' }); check('wallet inside 1440x900 viewport', inside(await geometry(wallet)));
      await input(page).fill('请通知团队明天整理草稿'); await input(page).press('Shift+Enter'); await input(page).press('End');
      check('Shift Enter newline without send', (await input(page).inputValue()).includes('\n'));
      await input(page).fill('中'.repeat(4001)); check('4001 characters block send', await send(page).isDisabled()); await input(page).fill('');
      check('desktop has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await snap(page, 'actual-ai-unavailable');
      const marker = await page.evaluate(() => window.__nativeAcceptanceDocumentMarker);
      for (const route of ['accounts', 'tasks-history', 'draft-box', 'agent-assets']) {
        const hrefs = await page.locator('aside a[href]').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
        const href = hrefs.find(value => value?.endsWith('/' + route)) || (route === 'draft-box' ? hrefs.find(value => value === native + '/' || value === native) : undefined);
        check('SPA navigation link exists: ' + route, !!href);
        await page.locator(`aside a[href=${JSON.stringify(href)}]`).first().click();
        await poll(() => Promise.resolve(new URL(page.url()).pathname.endsWith('/' + route) || route === 'draft-box' && [native, native + '/'].includes(new URL(page.url()).pathname)), 'SPA route reached: ' + route);
        check('SPA keeps document: ' + route, await page.evaluate(() => window.__nativeAcceptanceDocumentMarker) === marker);
        await brandVisible(page); await snap(page, 'actual-' + route);
      }
      await page.locator('[data-testid="sidebar-logo-link"]').first().click();
      await page.waitForURL(origin + '/'); check('logo actually returns to host root', new URL(page.url()).pathname === '/');
    });

    let firstNativeThemeStyle;
    for (const theme of ['soft-white', 'crystal-aurora', 'lattice']) await scenario('native-light-host-theme-' + theme, async () => {
      const { page } = await contextFor('theme-' + theme, { theme }); await go(page); await input(page).waitFor();
      const box = await geometry(input(page));
      check('native stays light despite old dark storage: ' + theme, !box.dark && !box.colorScheme.includes('dark'), box);
      const colors = await page.locator('.native-agent-composer').first().evaluate(element => { const css = getComputedStyle(element); return { background: css.backgroundColor, color: css.color, border: css.borderColor }; });
      if (!firstNativeThemeStyle) firstNativeThemeStyle = colors;
      check('native computed colors isolated from host theme: ' + theme, JSON.stringify(colors) === JSON.stringify(firstNativeThemeStyle), colors);
      check('host preference retained: ' + theme, await page.evaluate(() => localStorage.getItem('user_theme_preference')) === theme);
      await snap(page, 'theme-' + theme);
    });

    await scenario('ready-runtime-composer-interactions', async () => {
      let slowRefresh = false, draftGets = 0;
      const { page } = await contextFor('ready-fixture', { route: async (route, url) => {
        if (url.pathname === api + '/agent/runtime') { if (slowRefresh) await new Promise(resolve => setTimeout(resolve, 900)); await json(route, envelope(readyRuntime)); return true; }
        if (url.pathname.startsWith(api + '/material/group/list/')) draftGets++;
        return false;
      } });
      report.fixtures.push({ scenario: 'ready-fixture', path: api + '/agent/runtime', reason: 'Strict member-runtime DTO; render-only ready capabilities, no successful generation fixture' });
      await go(page); await page.getByText('创作助手已就绪', { exact: true }).waitFor();
      check('ready empty input still cannot send', await send(page).isDisabled());
      const details = page.locator('[data-testid="native-agent-composer-tools"] details');
      await details.locator('summary').click();
      check('cost details are expanded readable and fit viewport', await details.getAttribute('open') !== null && inside(await geometry(details)));
      await page.getByText('发送前确认本轮费用上限，完成后按实际用量结算。', { exact: true }).waitFor();
      await input(page).fill('中文创作通知');
      await input(page).dispatchEvent('compositionstart', { data: '创作' });
      await input(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
      check('IME composing Enter never opens confirmation', await page.getByText('确认本轮创作费用', { exact: true }).count() === 0);
      await input(page).dispatchEvent('compositionend', { data: '创作' });
      await input(page).press('Shift+Enter'); check('ready Shift Enter newline', (await input(page).inputValue()).includes('\n'));
      await input(page).press('Enter'); await page.getByText('确认本轮创作费用', { exact: true }).waitFor();
      const dialog = page.getByRole('dialog').filter({ hasText: '确认本轮创作费用' });
      const alertDialog = page.getByRole('alertdialog').filter({ hasText: '确认本轮创作费用' });
      const cancel = dialog.getByRole('button', { name: '取消', exact: true }).or(alertDialog.getByRole('button', { name: '取消', exact: true }));
      await cancel.first().click(); await page.getByText('确认本轮创作费用', { exact: true }).waitFor({ state: 'hidden' });
      check('cancel confirmation emits no business write', report.blockedWrites.filter(item => item.scenario === 'ready-fixture').length === 0);
      await input(page).fill('长'.repeat(4001)); check('ready overlong cannot send', await send(page).isDisabled());
      await input(page).fill('中文通知');
      const before = report.blockedWrites.length;
      await input(page).evaluate(element => { const transfer = new DataTransfer(); transfer.items.add(new File(['image fixture'], 'fixture.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })); element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })); });
      check('media capability blocks paste drop writes', report.blockedWrites.length === before);
      await page.getByRole('button', { name: '选择草稿', exact: true }).click();
      await page.getByRole('combobox', { name: '选择草稿箱' }).waitFor();
      await poll(() => Promise.resolve(draftGets > 0), 'Draft chooser reads only GET collections');
      await page.keyboard.press('Escape');
      slowRefresh = true; await page.getByRole('button', { name: '重新检查创作服务', exact: true }).click();
      await page.getByText('正在检查创作服务…', { exact: true }).waitFor(); check('refresh loading disables send', await send(page).isDisabled());
      await page.getByText('创作助手已就绪', { exact: true }).waitFor();
      await snap(page, 'fixture-ready-composer');
    }, 'GET-fixture-render-only');

    await scenario('compact-twenty-message-render', async () => {
      const messages = Array.from({ length: 20 }, (_, index) => ({ type: index % 2 ? 'assistant' : 'user', uuid: `fixture-message-${index}`, content: `界面验收段落 ${index + 1}。仅为只读布局夹具，未执行创作。\n` + '这一段用于验证长对话滚动和底部输入区域完整显示。'.repeat(9) }));
      const task = { id: taskId, userId: identity.user.id, nativeRevision: 1, nativeStatus: 'cancelled', nativeLastSeq: 0, nativeActions: [], nativePlanningTurns: [], nativeWorkflowEvents: [], turns: [], prompt: '只读布局夹具', title: '只读布局验收', description: '', tags: [], status: 'cancelled', medias: [], errorMessage: '', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', messages };
      const { page } = await contextFor('compact-fixture', { route: async (route, url) => {
        if (url.pathname === api + '/agent/runtime') { await json(route, envelope(readyRuntime)); return true; }
        if (url.pathname === api + '/agent/tasks/' + taskId) { await json(route, envelope(task)); return true; }
        if (url.pathname === api + '/ai/chat/' + taskId) { await json(route, envelope(task)); return true; }
        if (url.pathname === api + '/ai/actions' && url.searchParams.get('taskId') === taskId) { await json(route, envelope({ items: [], total: 0, page: 1, pageSize: 30 })); return true; }
        return false;
      } });
      report.fixtures.push({ scenario: 'compact-fixture', path: api + '/agent/tasks/{fixture UUID}', reason: 'Real native TaskDetail DTO, 20 explicit fixture messages, cancelled state; no generated-result or write-success API fixture' });
      await go(page, 'chat/' + taskId); await input(page).waitFor();
      await page.getByText(/界面验收段落 20/).first().waitFor();
      check('real compact composer is active', await input(page).getAttribute('rows') === '1');
      await page.getByText('创作助手已就绪', { exact: true }).waitFor();
      const details = page.locator('[data-testid="native-agent-composer-tools"] details'); await details.locator('summary').click();
      check('compact input not clipped', inside(await geometry(input(page))));
      check('compact open cost details not clipped', inside(await geometry(details)));
      const scroll = await page.evaluate(() => [...document.querySelectorAll('div')].filter(element => /auto|scroll/u.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 30 && element.textContent?.includes('界面验收段落 20')).map(element => { const before = element.scrollTop; element.scrollTop = 0; const changed = element.scrollTop !== before || element.scrollHeight > element.clientHeight; return { changed, height: element.clientHeight, scrollHeight: element.scrollHeight }; }));
      check('long compact message region scrolls', scroll.some(item => item.changed && item.height > 80), scroll);
      check('compact no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await snap(page, 'fixture-compact-expanded');
    }, 'GET-fixture-render-only');

    for (const mode of ['initial-503', 'wrong-host', 'white-label-no-image', 'platform-broken-image', 'hanging-then-refresh']) await scenario('brand-failure-' + mode, async () => {
      assert.ok(published, 'Real public snapshot required before failure fixtures');
      let requests = 0, allowRefresh = false;
      const fixture = structuredClone(published);
      if (mode === 'wrong-host') fixture.hostname = 'wrong-host.invalid';
      if (mode === 'white-label-no-image') { fixture.displayScope = 'white_label'; fixture.assets = {}; fixture.brand.assetIds = {}; }
      if (mode === 'platform-broken-image') { fixture.displayScope = 'platform'; }
      const { page } = await contextFor('brand-' + mode, { route: async (route, url) => {
        if (url.pathname === '/api/branding') {
          requests++;
          if (mode === 'initial-503') await json(route, { ok: false }, 503);
          else if (mode === 'hanging-then-refresh' && !allowRefresh) { await new Promise(resolve => setTimeout(resolve, 6500)); await route.abort().catch(() => {}); }
          else await json(route, { ok: true, branding: fixture });
          return true;
        }
        if (mode === 'platform-broken-image' && url.pathname.startsWith('/api/branding/assets/')) { await route.abort(); return true; }
        return false;
      } });
      report.fixtures.push({ scenario: 'brand-' + mode, path: '/api/branding', reason: 'Fresh-context public display failure isolation' });
      const start = Date.now(); await go(page);
      const logo = page.locator('[data-testid="sidebar-logo-link"]').first();
      if (['initial-503', 'wrong-host', 'hanging-then-refresh'].includes(mode)) {
        await poll(async () => (await logo.innerText()).includes('发布中心'), 'Fresh failure must use generic name');
        check('fresh brand failure has no old identity: ' + mode, !(await logo.innerText()).includes(published.brand.name) && !/aitoearn/iu.test(await logo.innerText()));
        check('fresh failure has no platform logo: ' + mode, await logo.locator('img').count() === 0);
        if (mode === 'hanging-then-refresh') {
          await page.waitForTimeout(Math.max(0, 5400 - (Date.now() - start)));
          allowRefresh = true;
          await page.evaluate(() => window.dispatchEvent(new Event('platform-branding:refresh')));
          await brandVisible(page, fixture);
          check('timeout releases pending for later refresh', requests >= 2 && Date.now() - start < 13000);
        }
      } else if (mode === 'white-label-no-image') {
        await poll(async () => (await logo.innerText()).includes(fixture.brand.name), 'White-label name renders');
        check('white label missing image never borrows platform', await logo.locator('img').count() === 0 && await page.locator('link[rel="icon"]').count() === 0);
      } else {
        await poll(async () => await logo.locator('img').getAttribute('src') === '/brand/platform-logo-display-256.webp', 'Platform image falls back to host default');
        check('platform default decodes after image failure', await logo.locator('img').evaluate(image => image.complete && image.naturalWidth > 0));
      }
      await snap(page, 'fixture-brand-' + mode);
    }, 'GET-fixture-render-only');
    check('no attempted business writes in acceptance', report.blockedWrites.length === 0);
    check('no browser script errors', report.pageErrors.length === 0);
    report.passed = report.scenarios.every(item => item.passed) && report.checks.every(item => item.passed);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
    const reportPath = path.join(output, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length, failedScenarios: report.scenarios.filter(item => !item.passed).map(item => item.name), checks: report.checks.length, blockedWrites: report.blockedWrites.length, report: reportPath }));
  }
  assert.ok(report.passed, 'Native brand/composer UI acceptance has failures; inspect the sanitized report');
}
