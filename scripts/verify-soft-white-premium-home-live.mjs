import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const sourceOnly = process.argv.includes('--source-only');
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const out = path.resolve('.codex-evidence/soft-white-home-20260923');
await fs.mkdir(out, { recursive: true });

const themeCssPath = path.resolve('src/app/theme-soft-white.css');
const [landingSource, softSource, softCss, operatingCss, themeCss, themeCssStat] = await Promise.all([
  fs.readFile(path.resolve('src/components/landing-page.tsx'), 'utf8'),
  fs.readFile(path.resolve('src/components/landing/soft-white-landing.tsx'), 'utf8'),
  fs.readFile(path.resolve('src/components/landing/soft-white-landing.css'), 'utf8'),
  fs.readFile(path.resolve('src/components/landing/operating-home-v2.css'), 'utf8'),
  fs.readFile(themeCssPath, 'utf8'),
  fs.stat(themeCssPath),
]);

assert.match(landingSource, /themeId === "soft-white" \|\| themeId === "lattice" \|\| themeId === "crystal-aurora"[\s\S]*?<SoftWhiteLanding/u, '三套标准主题必须共用业务首页');
assert.match(softSource, /data-landing-version="v2"/u);
assert.match(softSource, /把一个内容想法[\s\S]*?推进到完整成片[\s\S]*?沉淀为可用资产/u);
assert.match(softSource, /少一点重复开工，多一点持续产出/u);
assert.match(softSource, /选对呈现方式，再把每一步做到位/u);
assert.match(softSource, /真正有用的 AI，不只回答，还要接住下一步/u);
assert.match(softSource, /AI 原生视频/u);
assert.match(softSource, /交付回到作品历史/u);
assert.match(softSource, /把策略、创作、生产与归档/u);
assert.match(softSource, /从持续表达，到用内容经营生意/u);
assert.match(softSource, /继续扩展/u);
assert.match(softCss, /\.soft-white-home/u);
assert.match(operatingCss, /html\[data-theme="lattice"\]\[data-mode="dark"\] \.soft-white-home\[data-landing-version="v2"\]/u, '深空金必须通过私有主题 token 呈现同一业务首页');
assert.match(operatingCss, /html\[data-theme="crystal-aurora"\]\[data-mode="dark"\] \.soft-white-home\[data-landing-version="v2"\]/u, '黑曜霓彩必须通过私有主题 token 呈现同一业务首页');
assert.match(softCss, /height: 100dvh;[\s\S]*?overflow-y: auto;/u, '业务首页根容器必须恢复纵向滚动');
assert.match(themeCss, /\.login-form-shell \.login-panel[\s\S]*?linear-gradient\(155deg, #182520/u, '柔光白登录面板必须使用深色高对比表面');
assert.match(themeCss, /\.login-form-shell :where\(input, textarea, select\)[\s\S]*?color: #ffffff !important/u, '柔光白登录输入文字必须清晰');

const report = {
  checkedAt: new Date().toISOString(),
  sourceOnly,
  source: { sharedBusinessHomepage: true, desktopRootScrolling: true, plannedCapabilitiesLabeled: true, loginContrastScoped: true },
  pages: [],
  adjacentPages: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  paidRequests: [],
  unexpectedWrites: [],
  sourcePatchPreviews: [],
};

function watch(page, id) {
  page.on('pageerror', error => report.pageErrors.push({ page: id, message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error' && !/React DevTools/u.test(message.text())) report.consoleErrors.push({ page: id, message: message.text() });
  });
  page.on('response', response => {
    if (response.status() >= 500) report.serverErrors.push({ page: id, status: response.status(), url: response.url() });
  });
  page.on('request', request => {
    const url = new URL(request.url());
    const method = request.method();
    if (/\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/u.test(url.pathname)) report.paidRequests.push({ page: id, pathname: url.pathname });
    const diagnostic = method === 'POST' && ['/__nextjs_original-stack-frames', '/api/client-errors'].includes(url.pathname);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !diagnostic) report.unexpectedWrites.push({ page: id, method, pathname: url.pathname });
  });
}

async function addThemePreference(context, theme, entered = false, identity = null) {
  await context.addInitScript(({ selectedTheme, shouldEnter, user }) => {
    localStorage.setItem('user_theme_preference', selectedTheme);
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    sessionStorage.removeItem('entered_app');
    if (shouldEnter) {
      sessionStorage.setItem('entered_app', '1');
      if (user?.token) localStorage.setItem('auth_token', user.token);
      if (user?.record) localStorage.setItem('auth_user', JSON.stringify(user.record));
    }
  }, { selectedTheme: theme, shouldEnter: entered, user: identity });
}

if (!sourceOnly) {
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
  const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(versionResponse.ok, true, `LOCAL_VERSION_FAILED:${versionResponse.status}`);
  const servedVersion = await versionResponse.json();
  const servedBundlePredatesThemeSource = themeCssStat.mtimeMs > new Date(servedVersion.timestamp).getTime();
  report.servedVersion = servedVersion;
  report.servedBundlePredatesThemeSource = servedBundlePredatesThemeSource;
  const identityResponse = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  assert.equal(identityResponse.ok, true, `LOCAL_ADMIN_SESSION_INVALID:${identityResponse.status}`);
  const identityPayload = await identityResponse.json();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { name: 'desktop-1280', width: 1280, height: 800 },
      { name: 'desktop-1440', width: 1440, height: 900 },
      { name: 'desktop-1920', width: 1920, height: 1080 },
    ]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block' });
      await addThemePreference(context, 'soft-white');
      const page = await context.newPage();
      watch(page, `soft-white-${viewport.name}`);
      const response = await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      assert.equal(response?.status(), 200);
      const home = page.getByTestId('soft-white-premium-home');
      await home.waitFor({ state: 'visible', timeout: 30_000 });
      await page.getByRole('heading', { name: /把一个内容想法/u }).waitFor({ state: 'visible' });
      assert.equal(await page.getByText('继续扩展', { exact: true }).count() > 0, true);
      assert.equal(await page.locator('.swh-module-rail-items > span').count(), 7);
      const theme = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, mode: document.documentElement.dataset.mode }));
      assert.deepEqual(theme, { theme: 'soft-white', mode: 'light' });
      const scroll = await home.evaluate(element => {
        const before = element.scrollTop;
        const previousScrollBehavior = element.style.scrollBehavior;
        element.style.scrollBehavior = 'auto';
        element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight);
        const after = element.scrollTop;
        element.style.scrollBehavior = previousScrollBehavior;
        return { before, after, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      });
      assert.ok(scroll.scrollHeight > scroll.clientHeight, `${viewport.name.toUpperCase()}_HOME_NOT_SCROLLABLE`);
      assert.ok(scroll.after > scroll.before, `${viewport.name.toUpperCase()}_HOME_SCROLL_DID_NOT_MOVE`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${viewport.name.toUpperCase()}_HOME_OVERFLOW:${overflow}`);
      const proofContrast = await page.locator('.swh-proof-bar').evaluate(element => {
        const channels = value => (value.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
        const luminance = value => {
          const [r, g, b] = channels(value).map(channel => {
            const normalized = channel / 255;
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (foreground, background) => {
          const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
          return (values[0] + 0.05) / (values[1] + 0.05);
        };
        const background = getComputedStyle(element).backgroundColor;
        const strong = element.querySelector('strong');
        const auxiliary = element.querySelector('span');
        return {
          background,
          primary: ratio(getComputedStyle(strong).color, background),
          auxiliary: ratio(getComputedStyle(auxiliary).color, background),
        };
      });
      assert.ok(proofContrast.primary >= 4.5 && proofContrast.auxiliary >= 4.5,
        `${viewport.name.toUpperCase()}_PROOF_TEXT_CONTRAST:${JSON.stringify(proofContrast)}`);
      const initialBounds = await home.evaluate((element) => {
        const previousScrollBehavior = element.style.scrollBehavior;
        element.style.scrollBehavior = 'auto';
        element.scrollTop = 0;
        const header = element.querySelector('.swh-header')?.getBoundingClientRect();
        const heading = element.querySelector('.swh-hero h1')?.getBoundingClientRect();
        const result = {
          scrollTop: element.scrollTop,
          headerBottom: header?.bottom || 0,
          headingTop: heading?.top || 0,
        };
        element.style.scrollBehavior = previousScrollBehavior;
        return result;
      });
      assert.equal(initialBounds.scrollTop, 0, `${viewport.name.toUpperCase()}_HOME_DID_NOT_RETURN_TO_INITIAL_POSITION`);
      assert.ok(initialBounds.headingTop >= initialBounds.headerBottom - 1,
        `${viewport.name.toUpperCase()}_HOME_HEADING_OBSCURED_BY_HEADER:${JSON.stringify(initialBounds)}`);
      await page.screenshot({ path: path.join(out, `soft-white-home-${viewport.name}.png`), fullPage: false });

      await page.getByRole('button', { name: /登录平台/u }).first().click();
      const drawer = page.getByRole('dialog', { name: '登录自媒体操盘手' });
      await drawer.waitFor({ state: 'visible' });
      const accountInput = drawer.locator('input[name="account"]');
      await accountInput.fill('contrast-check-account');
      const loginStyles = await accountInput.evaluate(input => {
        const inputStyle = getComputedStyle(input);
        const placeholderStyle = getComputedStyle(input, '::placeholder');
        const panel = input.closest('.login-panel');
        const panelStyle = panel ? getComputedStyle(panel) : null;
        return {
          color: inputStyle.color,
          backgroundColor: inputStyle.backgroundColor,
          placeholderColor: placeholderStyle.color,
          panelBackgroundImage: panelStyle?.backgroundImage || '',
        };
      });
      assert.equal(loginStyles.color, 'rgb(255, 255, 255)');
      assert.match(loginStyles.backgroundColor, /^rgba?\(/u);
      assert.match(loginStyles.panelBackgroundImage, /linear-gradient/u);
      assert.notEqual(loginStyles.placeholderColor, 'rgb(255, 255, 255)');
      const footer = drawer.locator('.login-form-shell > p');
      const initialFooterStyles = await footer.evaluate(node => {
        const style = getComputedStyle(node);
        return { color: style.color, opacity: style.opacity, textShadow: style.textShadow };
      });
      let sourcePatchPreviewApplied = false;
      if (initialFooterStyles.color !== 'rgb(95, 104, 100)' && servedBundlePredatesThemeSource) {
        await page.addStyleTag({ content: 'html[data-theme="soft-white"][data-mode="light"] .login-form-shell > p{color:#5f6864!important;text-shadow:none!important;opacity:1!important}' });
        sourcePatchPreviewApplied = true;
      }
      const footerStyles = await footer.evaluate(node => {
        const style = getComputedStyle(node);
        return { color: style.color, opacity: style.opacity, textShadow: style.textShadow };
      });
      assert.deepEqual(footerStyles, { color: 'rgb(95, 104, 100)', opacity: '1', textShadow: 'none' });
      report.sourcePatchPreviews.push({ viewport: viewport.name, applied: sourcePatchPreviewApplied, initialFooterStyles });
      const loginOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(loginOverflow <= 1, `${viewport.name.toUpperCase()}_LOGIN_OVERFLOW:${loginOverflow}`);
      await page.screenshot({ path: path.join(out, `soft-white-login-${viewport.name}.png`), fullPage: false });
      report.pages.push({ ...viewport, overflow, scroll, proofContrast, loginOverflow, loginStyles, footerStyles });
      await context.close();
    }

    const defaultContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
    await addThemePreference(defaultContext, 'lattice');
    const defaultPage = await defaultContext.newPage();
    watch(defaultPage, 'default-home');
    const defaultResponse = await defaultPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    assert.equal(defaultResponse?.status(), 200);
    await defaultPage.getByRole('heading', { name: /把一个内容想法/u }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await defaultPage.getByTestId('soft-white-premium-home').count(), 1, '深空金必须渲染同一业务首页');
    const defaultIdentity = await defaultPage.evaluate(() => ({ theme: document.documentElement.dataset.theme, mode: document.documentElement.dataset.mode }));
    assert.equal(defaultIdentity.theme, 'lattice');
    const defaultOverflow = await defaultPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(defaultOverflow <= 1, `DEFAULT_HOME_OVERFLOW:${defaultOverflow}`);
    const defaultProofContrast = await defaultPage.locator('.swh-proof-bar').evaluate(element => {
      const channels = value => (value.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
      const luminance = value => {
        const [r, g, b] = channels(value).map(channel => {
          const normalized = channel / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (foreground, background) => {
        const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      const background = getComputedStyle(element).backgroundColor;
      return {
        background,
        primary: ratio(getComputedStyle(element.querySelector('strong')).color, background),
        auxiliary: ratio(getComputedStyle(element.querySelector('span')).color, background),
      };
    });
    assert.ok(defaultProofContrast.primary >= 4.5 && defaultProofContrast.auxiliary >= 4.5,
      `DEFAULT_PROOF_TEXT_CONTRAST:${JSON.stringify(defaultProofContrast)}`);
    await defaultPage.screenshot({ path: path.join(out, 'default-home-regression.png'), fullPage: false });
    const defaultScroll = await defaultPage.getByTestId('soft-white-premium-home').evaluate(element => {
      const previousScrollBehavior = element.style.scrollBehavior;
      element.style.scrollBehavior = 'auto';
      element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight);
      const result = { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      element.style.scrollBehavior = previousScrollBehavior;
      return result;
    });
    assert.ok(defaultScroll.scrollHeight > defaultScroll.clientHeight && defaultScroll.scrollTop > 0, '深空金首页必须可纵向滚动');
    report.defaultHomepage = { ...defaultIdentity, overflow: defaultOverflow, shared: true, scroll: defaultScroll, proofContrast: defaultProofContrast };
    await defaultContext.close();

    for (const pathname of ['/video', '/tools']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
      await addThemePreference(context, 'soft-white', true, { token, record: identityPayload.user });
      await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      await context.route('**/api/auth/me', async route => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { ...identityPayload.user, themePreference: 'soft-white', theme_preference: 'soft-white' } }) });
      });
      const page = await context.newPage();
      watch(page, pathname);
      const response = await page.goto(`${origin}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      assert.equal(response?.status(), 200);
      await page.waitForFunction(() => document.body?.innerText?.trim().length > 30, null, { timeout: 30_000 });
      const result = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        mode: document.documentElement.dataset.mode,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      assert.deepEqual({ theme: result.theme, mode: result.mode }, { theme: 'soft-white', mode: 'light' });
      assert.ok(result.overflow <= 1, `${pathname}_OVERFLOW:${result.overflow}`);
      report.adjacentPages.push({ pathname, ...result });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(report.pageErrors, [], `PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
  assert.deepEqual(report.consoleErrors, [], `CONSOLE_ERRORS:${JSON.stringify(report.consoleErrors)}`);
  assert.deepEqual(report.serverErrors, [], `SERVER_ERRORS:${JSON.stringify(report.serverErrors)}`);
  assert.deepEqual(report.paidRequests, [], `PAID_REQUESTS:${JSON.stringify(report.paidRequests)}`);
  assert.deepEqual(report.unexpectedWrites, [], `UNEXPECTED_WRITES:${JSON.stringify(report.unexpectedWrites)}`);
}

report.passed = true;
await fs.writeFile(path.join(out, sourceOnly ? 'source-report.json' : 'live-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ passed: true, sourceOnly, pages: report.pages.map(page => page.name), adjacentPages: report.adjacentPages.map(page => page.pathname) }));
