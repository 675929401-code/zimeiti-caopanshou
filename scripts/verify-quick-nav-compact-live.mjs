import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const sourceOnly = process.argv.includes('--source-only');
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const outputDir = path.resolve('.codex-evidence/quick-nav-compact-20260924');
const expectedLabels = ['应用广场', '文案提取', '视频创作', '漫剧创作', '效率工具', '声音制作', '分镜编排', '封面设计', '带货创作'];

await fs.mkdir(outputDir, { recursive: true });

const [sidebarSource, toolboxSource, shellCss] = await Promise.all([
  fs.readFile(path.resolve('src/components/app-sidebar.tsx'), 'utf8'),
  fs.readFile(path.resolve('src/components/toolbox-menu.tsx'), 'utf8'),
  fs.readFile(path.resolve('src/app/ui-shell-fixes.css'), 'utf8'),
]);

assert.match(sidebarSource, /sidebar-shortcut-grid grid grid-cols-3 gap-2/u);
assert.match(sidebarSource, /sidebar-shortcut-card[\s\S]*min-h-16[\s\S]*hover:-translate-y-px/u);
assert.match(sidebarSource, /sidebar-shortcut-icon[\s\S]*h-\[30px\][\s\S]*w-\[30px\]/u);
assert.match(toolboxSource, /sidebar-shortcut-card toolbox-trigger-sidebar[\s\S]*min-h-16/u);
assert.match(toolboxSource, /toolbox-trigger-icon sidebar-shortcut-icon[\s\S]*h-\[30px\][\s\S]*w-\[30px\]/u);
assert.match(shellCss, /\.sidebar-shell \.sidebar-shortcut-grid \.sidebar-tool-card \{[\s\S]*?min-height: 64px;[\s\S]*?border-radius: 10px;/u);

const report = {
  fingerprint: 'UI-SIDEBAR-QUICK-CARD-DENSITY-20260924',
  checkedAt: new Date().toISOString(),
  origin,
  sourceOnly,
  expectedLabels,
  viewports: [],
  adjacentPages: [],
  blockedWrites: [],
  paidRequests: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
};

if (!sourceOnly) {
  const { chromium } = await import('playwright');
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
  const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(20_000) });
  assert.equal(versionResponse.ok, true, `LOCAL_VERSION_FAILED:${versionResponse.status}`);
  report.servedVersion = await versionResponse.json();
  const identityResponse = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(identityResponse.ok, true, `LOCAL_ADMIN_SESSION_INVALID:${identityResponse.status}`);
  const identityPayload = await identityResponse.json();
  const browser = await chromium.launch({ headless: true });

  const watch = (page, id) => {
    page.on('pageerror', error => report.pageErrors.push({ id, message: error.message }));
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('ERR_BLOCKED_BY_CLIENT')) {
        report.consoleErrors.push({ id, message: message.text() });
      }
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (/\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/u.test(url.pathname)) {
        report.paidRequests.push({ id, method: request.method(), pathname: url.pathname });
      }
    });
    page.on('response', response => {
      if (response.status() >= 500) report.serverErrors.push({ id, status: response.status(), url: response.url() });
    });
  };

  const prepareContext = async (theme, viewport) => {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await context.addInitScript(({ authToken, authUser, selectedTheme }) => {
      localStorage.setItem('auth_token', authToken);
      localStorage.setItem('auth_user', JSON.stringify(authUser));
      localStorage.setItem('active_view', 'marketplace');
      localStorage.setItem('user_theme_preference', selectedTheme);
      sessionStorage.setItem('entered_app', '1');
    }, { authToken: token, authUser: identityPayload.user, selectedTheme: theme });
    await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/auth/me') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ user: { ...identityPayload.user, themePreference: theme, theme_preference: theme } }),
        });
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        report.blockedWrites.push({ theme, method: request.method(), pathname: url.pathname });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    return context;
  };

  try {
    for (const themeCase of [
      { theme: 'lattice', mode: 'dark' },
      { theme: 'soft-white', mode: 'light' },
    ]) {
      for (const viewport of [
        { name: 'desktop-1280', width: 1280, height: 800, expectedHeight: 64, expectedIcon: 30 },
        { name: 'desktop-1440', width: 1440, height: 900, expectedHeight: 64, expectedIcon: 30 },
        { name: 'desktop-1920', width: 1920, height: 1080, expectedHeight: 64, expectedIcon: 30 },
      ]) {
        const id = `${themeCase.theme}-${viewport.name}`;
        const context = await prepareContext(themeCase.theme, { width: viewport.width, height: viewport.height });
        const page = await context.newPage();
        watch(page, id);
        const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        assert.equal(response?.status(), 200);
        await page.locator('.marketplace-category-bar').waitFor({ state: 'visible', timeout: 30_000 });
        const close = page.getByRole('button', { name: '关闭', exact: true });
        if (await close.count() && await close.last().isVisible()) await close.last().click();
        const grid = page.locator('.sidebar-shortcut-grid');
        await grid.waitFor({ state: 'visible', timeout: 15_000 });
        const measurements = await grid.evaluate(element => {
          const cards = [...element.querySelectorAll('.sidebar-tool-card')];
          return {
            theme: document.documentElement.dataset.theme,
            mode: document.documentElement.dataset.mode,
            gridGap: Number.parseFloat(getComputedStyle(element).gap),
            labels: cards.map(card => card.textContent?.trim() || ''),
            cards: cards.map(card => {
              const rect = card.getBoundingClientRect();
              const style = getComputedStyle(card);
              const icon = card.querySelector('.sidebar-shortcut-icon');
              const iconRect = icon?.getBoundingClientRect();
              const label = card.lastElementChild;
              const labelStyle = label ? getComputedStyle(label) : null;
              return {
                width: rect.width,
                height: rect.height,
                paddingTop: Number.parseFloat(style.paddingTop),
                radius: Number.parseFloat(style.borderTopLeftRadius),
                iconWidth: iconRect?.width || 0,
                iconHeight: iconRect?.height || 0,
                labelFontSize: labelStyle ? Number.parseFloat(labelStyle.fontSize) : 0,
                labelOverflow: label ? label.scrollWidth - label.clientWidth : 0,
              };
            }),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });

        assert.deepEqual(measurements.labels, expectedLabels, `${id} 快捷入口名称或顺序异常`);
        assert.deepEqual({ theme: measurements.theme, mode: measurements.mode }, themeCase, `${id} 主题身份异常`);
        assert.ok(Math.abs(measurements.gridGap - 8) <= 0.5, `${id} 网格间距不是 8px`);
        assert.ok(measurements.cards.every(card => Math.abs(card.height - viewport.expectedHeight) <= 1), `${id} 卡片未等高：${JSON.stringify(measurements.cards)}`);
        assert.ok(measurements.cards.every(card => card.height >= 44), `${id} 点击高度不足 44px`);
        assert.ok(measurements.cards.every(card => Math.abs(card.iconWidth - viewport.expectedIcon) <= 1 && Math.abs(card.iconHeight - viewport.expectedIcon) <= 1), `${id} 图标底座尺寸异常`);
        assert.ok(measurements.cards.every(card => card.labelFontSize >= 13), `${id} 快捷入口字号回退`);
        assert.ok(measurements.cards.every(card => card.labelOverflow <= 1), `${id} 快捷入口文字被截断`);
        assert.ok(measurements.cards.every(card => Math.abs(card.radius - 10) <= 0.5), `${id} 圆角不一致`);
        assert.ok(measurements.overflow <= 1, `${id} 页面横向溢出 ${measurements.overflow}px`);

        const first = grid.locator('.sidebar-tool-card').first();
        await first.hover();
        await page.waitForTimeout(240);
        const transform = await first.evaluate(node => getComputedStyle(node).transform);
        assert.notEqual(transform, 'none', `${id} 缺少轻量悬浮反馈`);
        measurements.hoverTransform = transform;

        await page.screenshot({ path: path.join(outputDir, `${id}.png`), fullPage: false });
        report.viewports.push({ id, ...viewport, ...measurements });
        await context.close();
      }
    }

    const adjacentContext = await prepareContext('lattice', { width: 1440, height: 1000 });
    const adjacentPage = await adjacentContext.newPage();
    watch(adjacentPage, 'adjacent');
    for (const pathname of ['/video', '/tools']) {
      const response = await adjacentPage.goto(`${origin}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      assert.equal(response?.status(), 200);
      await adjacentPage.waitForFunction(() => document.body?.innerText?.trim().length > 30, null, { timeout: 30_000 });
      const overflow = await adjacentPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${pathname} 横向溢出 ${overflow}px`);
      report.adjacentPages.push({ pathname, overflow });
    }
    await adjacentContext.close();
  } finally {
    await browser.close();
  }

  assert.deepEqual(report.pageErrors, [], `PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
  assert.deepEqual(report.consoleErrors, [], `CONSOLE_ERRORS:${JSON.stringify(report.consoleErrors)}`);
  assert.deepEqual(report.serverErrors, [], `SERVER_ERRORS:${JSON.stringify(report.serverErrors)}`);
  assert.deepEqual(report.paidRequests, [], `PAID_REQUESTS:${JSON.stringify(report.paidRequests)}`);
}

report.productionWrites = 0;
report.paidGenerationRequests = report.paidRequests.length;
report.passed = true;
await fs.writeFile(path.join(outputDir, sourceOnly ? 'source-report.json' : 'live-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ passed: true, sourceOnly, viewports: report.viewports.map(item => item.id), adjacentPages: report.adjacentPages }));
