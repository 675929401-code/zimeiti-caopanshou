import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
assert.equal(origin, 'http://127.0.0.1:5000');
const output = path.resolve(process.env.AUDIT_OUTPUT_DIR || '.codex-evidence/public-contact-discovery');
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const report = { fixtureQrIsNotScannabilityProof: true, providerCalls: 0, mutationsSent: 0, checks: [], contrastChecks: [], screenshots: [], blockedWrites: [], blockedExternal: [], realGetPaths: [], fixtureGetPaths: [], pageErrors: [], passed: false };
const qrSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="white"/><path fill="#111" d="M20 20h50v50H20zm110 0h50v50h-50zM20 130h50v50H20zm70-40h20v20H90zm40 0h20v20h-20zm-40 40h20v50H90zm40 0h50v20h-50zm30 30h20v20h-20z"/><path fill="white" d="M30 30h30v30H30zm110 0h30v30h-30zM30 140h30v30H30z"/></svg>';
const themes = [['soft-white', 'light'], ['lattice', 'dark'], ['crystal-aurora', 'dark']];
let browser; let activePage;
function check(name, condition = true) { assert.ok(condition, name); report.checks.push(name); }
async function identity() {
  const response = await fetch(origin + '/api/version'); assert.ok(response.ok);
  const version = await response.json();
  const [receipt, build, disk] = await Promise.all([readFile('.next/local-source-fingerprint.v1.json', 'utf8').then(JSON.parse), readFile('.next/BUILD_ID', 'utf8'), readFile('public/version.json', 'utf8').then(JSON.parse)]);
  const fingerprint = computeLocalBuildFingerprint(process.cwd());
  assert.equal(receipt.fingerprint, fingerprint.fingerprint); assert.equal(receipt.fileCount, fingerprint.fileCount);
  assert.equal(version.buildId, build.trim()); assert.equal(receipt.buildId, build.trim()); assert.equal(version.sourceVersion, disk.sourceVersion);
  return { sourceVersion: version.sourceVersion, buildId: version.buildId, fingerprint: fingerprint.fingerprint, runningLatest: true };
}
const panel = page => page.getByTestId('public-brand-contact');
async function screenshot(page, label) { const name = `${stamp}-${label}.png`; await page.screenshot({ path: path.join(output, name) }); report.screenshots.push(name); }
async function settle(locator) { await locator.evaluate(async node => { await Promise.all(node.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }); }
// Radix restores focus in the unmount cleanup task, after a layer may already be hidden.
// Keep the exact node captured before opening; never move focus or accept a fallback.
async function waitForClosedAndFocus(page, layerSelector, triggerNode) {
  assert.ok(triggerNode, 'Original contact trigger must exist');
  await page.waitForFunction(({ layerSelector, triggerNode }) => {
    const layer = document.querySelector(layerSelector);
    const hidden = !layer || layer.getClientRects().length === 0 || getComputedStyle(layer).visibility === 'hidden';
    return hidden && triggerNode.isConnected && document.activeElement === triggerNode;
  }, { layerSelector, triggerNode }, { timeout: 2000 });
}
async function assertPanel(page, label, expectQrs) {
  const dialog = panel(page); await dialog.waitFor({ state: 'visible' }); await settle(dialog);
  const result = await dialog.evaluate(node => { const rect = node.getBoundingClientRect(); return { bounds: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, focused: node.contains(document.activeElement) }; });
  check(`${label}:dialog bounds and focus`, result.bounds && result.focused);
  const contrast = await dialog.evaluate(node => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Contrast sampling canvas unavailable');
    const rgba = color => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255, pixel[3] / 255];
    };
    const composite = (front, back) => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      return [0, 1, 2].map(index => alpha ? (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha : 0).concat(alpha);
    };
    const luminance = color => color.slice(0, 3).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (front, back) => {
      const foreground = luminance(composite(front, back)); const background = luminance(back);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    };
    // A genuine old regression (light #f1f5f9 with #edf1f7 text) must fail;
    // transparent foreground and backgrounds must be composited, not treated as black.
    const regressionRatio = ratio(rgba('#edf1f7'), rgba('#f1f5f9'));
    const alphaRegressionRatio = ratio(rgba('rgba(0,0,0,0.1)'), rgba('#fff'));
    if (regressionRatio >= 4.5 || alphaRegressionRatio >= 4.5 || Math.abs(ratio(rgba('#000'), rgba('#fff')) - 21) > 0.01) throw new Error('Contrast calculation regression self-check failed');
    const selectors = ['[data-slot=dialog-title]', '[data-slot=dialog-description]', '.public-contact-details dt', '.public-contact-value', '.public-contact-details a', '.public-contact-details dd button', '.public-contact-qrs figcaption', '.public-contact-qrs figcaption span', '.public-contact-feedback'];
    return [...node.querySelectorAll(selectors.join(','))].filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden').map(element => {
      const ancestors = []; for (let current = element; current; current = current.parentElement) ancestors.unshift(current);
      let background = [1, 1, 1, 1]; let opacity = 1;
      for (const ancestor of ancestors) { const style = getComputedStyle(ancestor); background = composite(rgba(style.backgroundColor), background); opacity *= Number(style.opacity); }
      const style = getComputedStyle(element); const foreground = rgba(style.color); foreground[3] *= opacity;
      return { element: element.tagName.toLowerCase(), slot: element.getAttribute('data-slot'), className: element.className, foreground: style.color, effectiveBackground: background, ratio: ratio(foreground, background), regressionRatio, alphaRegressionRatio };
    });
  });
  report.contrastChecks.push({ label, samples: contrast });
  check(`${label}:computed text contrast >=4.5`, contrast.length >= 2 && contrast.every(sample => sample.ratio >= 4.5));
  if (expectQrs) {
    await dialog.locator('.public-contact-qr-button img').first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=public-brand-contact] .public-contact-qr-button img')].length === 2 && [...document.querySelectorAll('[data-testid=public-brand-contact] .public-contact-qr-button img')].every(img => img.complete && img.naturalWidth > 0));
    const metrics = await dialog.locator('.public-contact-qr-button img').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height, fit: getComputedStyle(node).objectFit, background: getComputedStyle(node.parentElement).backgroundColor }; }));
    check(`${label}:two complete white QR >=160`, metrics.length === 2 && metrics.every(item => item.width >= 160 && item.height >= 160 && item.fit === 'contain' && item.background === 'rgb(255, 255, 255)'));
  }
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); check(`${label}:Tab remains in top dialog ${i}`, await dialog.evaluate(node => node.contains(document.activeElement))); }
}
await mkdir(output, { recursive: true });
try {
  report.runtime = await identity();
  const brandResponse = await fetch(origin + '/api/branding'); assert.equal(brandResponse.status, 200);
  const realBranding = (await brandResponse.json()).branding;
  report.actualPublishedConfiguration = { source: realBranding.source, displayScope: realBranding.displayScope, generation: realBranding.generation, hasContact: Object.values(realBranding.brand.contact).some(Boolean), qrCount: ['contact_wechat_qr_primary', 'contact_wechat_qr_secondary'].filter(key => realBranding.assets[key]?.url).length };
  const fixture = structuredClone(realBranding);
  fixture.source = 'published'; fixture.generation += 100; fixture.revisionId = 'public-contact-audit-fixture';
  fixture.brand.contact = { name: '联系夹具', wechat: 'wx_contact_audit', phone: '010-5550-2026', email: 'contact@example.invalid' };
  for (const [purpose, suffix] of [['contact_wechat_qr_primary', 'primary'], ['contact_wechat_qr_secondary', 'secondary']]) {
    fixture.brand.assetIds[purpose] = `contact-audit-${suffix}`;
    fixture.assets[purpose] = { id: `contact-audit-${suffix}`, purpose, url: `/api/branding/assets/contact-audit-${suffix}`, mimeType: 'image/svg+xml', width: 200, height: 200, bytes: qrSvg.length, sha256: 'fixture-only' };
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  async function createContext(theme, mode, useFixture) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(({ theme, mode }) => {
      const protectedTool = ['/formatter', '/segmenter'].includes(location.pathname)
        || (location.pathname === '/tools' && ['format', 'segment'].includes(new URLSearchParams(location.search).get('tab')));
      if (protectedTool) {
        localStorage.setItem('auth_token', 'contact-readonly-fixture');
        localStorage.setItem('auth_user', JSON.stringify({ id: 'contact-readonly-fixture', username: 'contact_fixture', role: 'user', status: 'active', is_active: true }));
        sessionStorage.setItem('entered_app', '1');
      } else { localStorage.removeItem('auth_token'); localStorage.removeItem('auth_user'); sessionStorage.removeItem('entered_app'); }
      localStorage.setItem('user_theme_preference', theme); localStorage.setItem('user_theme_mode_preference', mode); localStorage.setItem('platform_theme', theme); localStorage.setItem('platform_theme_mode', mode); window.__contactClipboardFailure = false; window.__contactCopied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { if (window.__contactClipboardFailure) throw new Error('fixture clipboard failure'); window.__contactCopied = value; } } }); document.execCommand = () => false;
    }, { theme, mode });
    let brokenQr = false; let protectedFixtureActive = false;
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== origin) { report.blockedExternal.push(url.origin + url.pathname); return route.abort('blockedbyclient'); }
      if (request.method() !== 'GET') { report.blockedWrites.push({ method: request.method(), path: url.pathname }); return route.fulfill({ status: 403, json: { error: 'READ_ONLY_AUDIT' } }); }
      if (url.pathname.startsWith('/api/branding/assets/contact-audit-')) { report.fixtureGetPaths.push(url.pathname); return brokenQr ? route.fulfill({ status: 404, body: 'fixture unavailable' }) : route.fulfill({ status: 200, contentType: 'image/svg+xml', body: qrSvg }); }
      if (url.pathname === '/api/branding' && useFixture) { report.fixtureGetPaths.push(url.pathname); return route.fulfill({ status: 200, json: { ok: true, branding: fixture } }); }
      if (protectedFixtureActive && ['/api/auth/me', '/api/member-permissions'].includes(url.pathname)) {
        report.fixtureGetPaths.push(url.pathname);
        if (url.pathname === '/api/auth/me') return route.fulfill({ status: 200, json: { user: { id: 'contact-readonly-fixture', username: 'contact_fixture', role: 'user', status: 'active', is_active: true } } });
        return route.fulfill({ status: 200, json: { permission: { userId: 'contact-readonly-fixture', role: 'user', featureNavigationKeys: ['toolbox'], agentNavigationKeys: [], revision: 1, checksum: 'contact-readonly-fixture', sourceProfileKey: null, sourceProfileVersion: null, updatedAt: null, updatedBy: null, reason: 'readonly browser fixture', integrityValid: true, authorityStatus: 'member' } } });
      }
      if (['/api/settings/appearance', '/api/settings'].includes(url.pathname)) { report.fixtureGetPaths.push(url.pathname); return route.fulfill({ status: 200, json: { settings: { theme, theme_mode: mode } } }); }
      if (url.pathname.startsWith('/api/') && !['/api/branding', '/api/settings/layout', '/api/version'].includes(url.pathname) && !url.pathname.startsWith('/api/branding/assets/')) { report.fixtureGetPaths.push(url.pathname); return route.fulfill({ status: 200, json: { records: [], tasks: [], models: [], projects: [], assets: [] } }); }
      if (url.pathname.startsWith('/api/')) report.realGetPaths.push(url.pathname);
      return route.continue();
    });
    const page = await context.newPage(); activePage = page;
    page.on('pageerror', error => report.pageErrors.push({ theme, fixture: useFixture, message: error.message }));
    const load = async target => {
      protectedFixtureActive = ['/formatter', '/segmenter'].includes(target);
      await page.goto(origin + target, { waitUntil: 'domcontentloaded' });
      if (protectedFixtureActive) {
        const tab = target === '/formatter' ? 'format' : 'segment';
        await page.locator(`#tool-tab-${tab}[aria-selected=true]`).waitFor();
        check(`${theme}:${target}:canonical tool tab retained`, new URL(page.url()).pathname === '/tools' && new URL(page.url()).searchParams.get('tab') === tab);
        check(`${theme}:${target}:active tool panel visible`, await page.locator(`#tool-panel-${tab}`).isVisible());
      }
      await page.waitForFunction(() => document.body.innerText.length > 100);
      await page.evaluate(({ theme, mode }) => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.mode = mode; document.documentElement.classList.toggle('dark', mode === 'dark'); }, { theme, mode });
      if (useFixture) {
        await page.waitForTimeout(120);
        const update = page.waitForResponse(response => new URL(response.url()).pathname === '/api/branding');
        await page.evaluate(() => window.dispatchEvent(new Event('platform-branding:refresh'))); await update;
      }
      check(`${theme}:${target}:actual theme and mode`, await page.locator('html').getAttribute('data-theme') === theme && await page.locator('html').getAttribute('data-mode') === mode);
      check(`${theme}:${target}:no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    };
    return { context, page, load, breakQr: () => { brokenQr = true; } };
  }
  {
    const { context, page, load } = await createContext('soft-white', 'light', false);
    await load('/'); await page.locator('.swh-header .public-contact-trigger').click();
    await assertPanel(page, 'actual-public-brand', false);
    check('actual published contact is empty', !report.actualPublishedConfiguration.hasContact && report.actualPublishedConfiguration.qrCount === 0);
    check('actual empty contact feedback', await panel(page).getByText('暂未提供公开联系方式，请稍后再试。', { exact: true }).isVisible());
    await screenshot(page, 'actual-empty-contact'); await page.keyboard.press('Escape');
    check('actual home:no public configuration instructions', !/管理员发布联系信息后|联系信息请在后台品牌中心设置|随品牌版本发布/u.test(await page.locator('body').innerText()));
    await page.locator('.swh-login-button').click(); await page.getByTestId('login-form-shell').waitFor();
    await page.locator('.swh-login-drawer .public-contact-trigger').click(); await assertPanel(page, 'actual-login-contact', false); await page.keyboard.press('Escape');
    check('actual contact Escape leaves login open', await page.locator('.swh-login-drawer').isVisible());
    for (const target of ['/login', '/register', '/forgot-password']) { await load(target); const text = await page.locator('body').innerText(); check(`actual ${target}:no engineering copy`, !/沿用主站现有认证接口|本页不会模拟注册成功|主站当前没有独立|真实接口发送|去后台|后台品牌中心设置/u.test(text)); }
    await context.close();
  }
  for (const [theme, mode] of themes) {
    const { context, page, load, breakQr } = await createContext(theme, mode, true);
    await load('/'); await page.locator('.swh-header .public-contact-trigger').click(); await assertPanel(page, `${theme}:header`, true);
    await panel(page).getByRole('button', { name: '复制', exact: true }).click(); check(`${theme}:copy success records exact text`, await page.evaluate(() => window.__contactCopied === 'wx_contact_audit')); await panel(page).getByText('微信号已复制', { exact: true }).waitFor();
    await page.evaluate(() => { window.__contactClipboardFailure = true; }); await panel(page).getByRole('button', { name: '复制', exact: true }).click();
    await panel(page).getByText('未能复制，请选中上方微信号手动复制。', { exact: true }).waitFor(); check(`${theme}:double copy failure not success`, await panel(page).getByText('微信号已复制', { exact: true }).count() === 0);
    await page.screenshot({ path: path.join(output, `${stamp}-${theme}-contact.png`) }); report.screenshots.push(`${stamp}-${theme}-contact.png`);
    const previewTrigger = panel(page).getByRole('button', { name: '放大微信联系二维码', exact: true }); const previewTriggerNode = await previewTrigger.elementHandle(); await previewTrigger.click();
    const preview = page.locator('.public-contact-preview'); await preview.waitFor(); await settle(preview);
    check(`${theme}:complete preview image`, await preview.locator('img').evaluate(img => getComputedStyle(img).objectFit === 'contain' && img.getBoundingClientRect().width >= 160));
    await page.keyboard.press('Tab'); check(`${theme}:preview Tab trapped`, await preview.evaluate(node => node.contains(document.activeElement)));
    await page.keyboard.press('Escape'); await waitForClosedAndFocus(page, '.public-contact-preview', previewTriggerNode); check(`${theme}:preview Escape leaves contact open`, await panel(page).isVisible()); check(`${theme}:preview focus restored`, await previewTrigger.evaluate(node => document.activeElement === node));
    await page.keyboard.press('Escape'); await panel(page).waitFor({ state: 'hidden' });
    const homeLoginTrigger = page.locator('.swh-login-button'); const homeLoginTriggerNode = await homeLoginTrigger.elementHandle(); await homeLoginTrigger.click(); await page.getByTestId('login-form-shell').waitFor(); const loginTrigger = page.locator('.swh-login-drawer .public-contact-trigger'); const loginTriggerNode = await loginTrigger.elementHandle(); await loginTrigger.click(); await assertPanel(page, `${theme}:login-drawer`, true);
    await page.keyboard.press('Escape'); await waitForClosedAndFocus(page, '[data-testid=public-brand-contact]', loginTriggerNode); check(`${theme}:contact Escape keeps login/focus`, await loginTrigger.evaluate(node => document.activeElement === node) && await page.locator('.swh-login-drawer').isVisible());
    await page.keyboard.press('Escape');
    await waitForClosedAndFocus(page, '.swh-login-drawer', homeLoginTriggerNode);
    check(`${theme}:final Escape closes login and restores original home trigger`, await homeLoginTrigger.evaluate(node => document.activeElement === node) && await page.locator('.swh-login-drawer').count() === 0);
    for (const target of ['/login', '/register', '/forgot-password', '/formatter', '/segmenter']) {
      await load(target); const triggerSelector = target.startsWith('/f') && target !== '/forgot-password' || target === '/segmenter' ? 'footer .public-contact-trigger' : '.login-contact-row .public-contact-trigger'; const trigger = page.locator(triggerSelector);
      const triggerNode = await trigger.elementHandle(); await trigger.click(); await assertPanel(page, `${theme}:${target}`, true); await screenshot(page, `${theme}-${target.slice(1)}-contact`); await page.keyboard.press('Escape');
      await waitForClosedAndFocus(page, '[data-testid=public-brand-contact]', triggerNode);
      check(`${theme}:${target}:returned focus`, await trigger.evaluate(node => document.activeElement === node));
      if (target === '/formatter' || target === '/segmenter') check(`${theme}:${target}:Escape retained canonical workspace`, new URL(page.url()).pathname === '/tools' && new URL(page.url()).searchParams.get('tab') === (target === '/formatter' ? 'format' : 'segment'));
      if (target === '/formatter' || target === '/segmenter') {
        await screenshot(page, `${theme}-${target.slice(1)}-workspace`);
        await page.setViewportSize({ width: 1920, height: 1080 });
        await screenshot(page, `${theme}-${target.slice(1)}-workspace-1920`);
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    }
    breakQr(); await load('/login'); await page.locator('.login-contact-row .public-contact-trigger').click(); await panel(page).getByText('二维码暂时无法加载', { exact: true }).first().waitFor();
    check(`${theme}:image failure preserves contact details`, await panel(page).getByText('wx_contact_audit', { exact: true }).isVisible()); await screenshot(page, `${theme}-qr-failure`);
    await context.close();
  }
  check('no page runtime exceptions', report.pageErrors.length === 0);
  check('no auth or provider submission attempted', !report.blockedWrites.some(item => /\/auth\/|\/generate|\/llm/u.test(item.path)));
  report.runtimeAfter = await identity(); assert.deepEqual(report.runtimeAfter, report.runtime); report.passed = true;
} catch (error) { report.failure = error.stack || String(error); process.exitCode = 1; if (activePage && !activePage.isClosed()) await screenshot(activePage, 'failure').catch(() => {}); }
finally { if (browser) await browser.close(); await writeFile(path.join(output, `report-${stamp}.json`), JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, providerCalls: 0, runtime: report.runtime, output, failure: report.failure || null })); }
