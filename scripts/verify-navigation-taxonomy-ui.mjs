import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const sourceOnly = process.argv.includes('--source-only');
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const outputDir = path.resolve('.codex-evidence/navigation-taxonomy-20260923');
const expectedCategories = ['全部助手', '我的收藏', '商业IP', '影像编导', '文案创作', '运营增长', '内部工具'];
const expectedPrimaryNavigation = ['应用广场', '效率工具', '分镜编排', '图像生成', '视频创作', '声音制作', '封面设计', '漫剧创作', '带货创作'];
const paidPattern = /\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/u;

await fs.mkdir(outputDir, { recursive: true });

const [sidebarSource, toolboxSource, marketplaceSource, catalogSource, navigationSource, shellCss] = await Promise.all([
  fs.readFile(path.resolve('src/components/app-sidebar.tsx'), 'utf8'),
  fs.readFile(path.resolve('src/components/toolbox-menu.tsx'), 'utf8'),
  fs.readFile(path.resolve('src/components/agent-marketplace.tsx'), 'utf8'),
  fs.readFile(path.resolve('src/lib/business-ip/catalog.ts'), 'utf8'),
  fs.readFile(path.resolve('src/lib/marketplace-navigation.ts'), 'utf8'),
  fs.readFile(path.resolve('src/app/ui-shell-fixes.css'), 'utf8'),
]);

assert.match(sidebarSource, /const MEDIA_HISTORY_SHORTCUT[\s\S]*?title: "作品历史"[\s\S]*?link_value: "\/media-history"/u);
assert.doesNotMatch(sidebarSource, /\u4f5c\u54c1\u76f4\u8fbe/u);
assert.match(sidebarSource, /const isExtractShortcut[\s\S]*?item\.link_value === "\/tools\?tab=text"[\s\S]*?item\.link_value === "\/extract"[\s\S]*?title === "文案提取"/u);
assert.match(sidebarSource, /next\.splice\(marketplaceIndex >= 0 \? marketplaceIndex \+ 1 : 0, 0, MEDIA_HISTORY_SHORTCUT\)/u);
assert.match(sidebarSource, /text-\[clamp\(13px,calc\(13px\*var\(--sidebar-scale,1\)\),15px\)\]/u);
assert.match(toolboxSource, /text-\[clamp\(13px,calc\(13px\*var\(--sidebar-scale,1\)\),15px\)\]/u);
assert.match(marketplaceSource, /label: "全部助手"/u);
assert.match(marketplaceSource, /return \["all", FAVORITES_CATEGORY, \.\.\.fixedKeys/u, '我的收藏必须紧随全部助手且不挤掉原有分类');
assert.match(marketplaceSource, /label:"内部工具"/u);
assert.match(marketplaceSource, /CATEGORY_LUCIDE_ICONS/u);
assert.match(catalogSource, /key:'task:获客转化',label:'运营增长'/u);
assert.match(catalogSource, /if\(agent\.category==='自用'\)/u, '内部分类键必须保持兼容');
for (const label of expectedPrimaryNavigation) assert.match(navigationSource, new RegExp(`label: "${label}"`, 'u'));
assert.equal(expectedPrimaryNavigation.every(label => /^\p{Script=Han}{4}$/u.test(label)), true, '一级导航名称必须统一为四个汉字');
assert.match(marketplaceSource, /return \[\.\.\.PRIMARY_NAVIGATION_ORDER, \.\.\.Array\.from\(new Set\(supplementalKeys\)\)\]/u, '固定九项导航必须在前，兼容补充项仅可去重追加');
assert.match(shellCss, /font-size: var\(--market-nav-font-size, 15px\)/u);
assert.match(shellCss, /width 220ms/u);
const primaryNavRule = shellCss.match(/html\[data-theme\] \.marketplace-shell \.nav-bar-container \{[\s\S]*?\n\}/u)?.[0] || '';
assert.ok(primaryNavRule, '必须保留一级导航最终约束规则');
assert.match(primaryNavRule, /-webkit-mask-image: none !important;/u, '一级导航不得使用 WebKit 渐隐 mask 裁切文字');
assert.match(primaryNavRule, /mask-image: none !important;/u, '一级导航不得使用渐隐 mask 裁切文字');
assert.doesNotMatch(primaryNavRule, /mask-image: linear-gradient/u, '一级导航规则内不得恢复渐隐 mask');

const report = {
  checkedAt: new Date().toISOString(),
  origin,
  expectedCategories,
  expectedPrimaryNavigation,
  source: {
    stableKeysPreserved: true,
    mediaHistoryShortcutInserted: true,
    legacyExtractShortcutsFiltered: true,
    minimumShortcutFontPx: 13,
    lucideCategoryIcons: true,
  },
  viewports: [],
  adjacentPages: [],
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  paidRequests: [],
  writes: [],
  devSessionRequests: [],
};

if (!sourceOnly) {
  const { chromium } = await import('playwright');
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
  const versionResponse = await fetch(`${origin}/api/version`, {
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(versionResponse.ok, true, `LOCAL_VERSION_FAILED:${versionResponse.status}`);
  report.servedVersion = await versionResponse.json();
  const identityResponse = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(identityResponse.ok, true, `LOCAL_ADMIN_SESSION_INVALID:${identityResponse.status}`);
  report.authentication = 'injected-short-lived-local-audit-session';

  const watch = (page, viewport) => {
    page.on('pageerror', error => report.pageErrors.push({ viewport, message: error.message }));
    page.on('console', message => {
      if (message.type() === 'error') report.consoleErrors.push({ viewport, message: message.text() });
    });
    page.on('request', request => {
      const url = new URL(request.url());
      const method = request.method();
      if (paidPattern.test(url.pathname)) report.paidRequests.push({ viewport, method, path: url.pathname });
      if (url.pathname === '/api/auth/dev-session') report.devSessionRequests.push({ viewport, method });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) report.writes.push({ viewport, method, path: url.pathname, origin: url.origin });
    });
    page.on('response', response => {
      if (response.status() >= 500) report.serverErrors.push({ viewport, status: response.status(), url: response.url() });
    });
  };

  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      await context.addInitScript(value => {
        localStorage.setItem('auth_token', value);
        localStorage.setItem('active_view', 'marketplace');
        sessionStorage.setItem('entered_app', '1');
      }, token);
      await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      watch(page, viewport.name);

      const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      assert.equal(response?.status(), 200);
      await page.locator('.marketplace-category-bar').waitFor({ state: 'visible', timeout: 30_000 });
      const close = page.getByRole('button', { name: '关闭系统公告', exact: true });
      if (await close.count() && await close.last().isVisible()) await close.last().click();

      const tabs = page.locator('.marketplace-category-bar .category-tab');
      const labels = (await tabs.allTextContents()).map(value => {
        const label = value.replace(/\s+/gu, '').trim();
        return label.replace(/^我的收藏\d+$/u, '我的收藏');
      });
      assert.deepEqual(labels.slice(0, expectedCategories.length), expectedCategories);
      assert.equal(await tabs.locator('svg').count() >= expectedCategories.length, true, '内置分类应使用统一线性图标');

      const mediaHistory = page.locator('button[title="作品历史"]');
      await mediaHistory.waitFor({ state: 'visible', timeout: 15_000 });
      const fontSize = Number.parseFloat(await mediaHistory.locator('span').last().evaluate(node => getComputedStyle(node).fontSize));
      assert.ok(fontSize >= 13, `作品历史字号过小：${fontSize}px`);
      const shortcutGrid = mediaHistory.locator('xpath=..');
      const shortcutLabels = (await shortcutGrid.locator('button').allTextContents()).map(value => value.trim());
      assert.equal(shortcutLabels.includes('作品历史'), true);
      assert.equal(shortcutLabels.includes('文案提取'), false, '文案提取已归入效率工具，不应再占用快捷位');
      assert.equal(new Set(shortcutLabels).size, shortcutLabels.length, '快捷导航不应出现重复入口');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${viewport.name} 首页横向溢出 ${overflow}px`);
      await page.screenshot({ path: path.join(outputDir, `${viewport.name}-home.png`), fullPage: false });
      report.viewports.push({ ...viewport, categoryLabels: labels.slice(0, expectedCategories.length), shortcutLabels, mediaHistoryFontSize: fontSize, overflow });

      await mediaHistory.click();
      await page.waitForURL(url => url.pathname === '/media-history', { timeout: 20_000 });
      const mediaHistoryUrl = new URL(page.url());
      assert.equal(mediaHistoryUrl.pathname, '/media-history');
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(value => {
      localStorage.setItem('auth_token', value);
      sessionStorage.setItem('entered_app', '1');
    }, token);
    await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    watch(page, 'adjacent');
    for (const pathname of ['/video', '/tools']) {
      const response = await page.goto(`${origin}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      assert.equal(response?.status(), 200);
      await page.waitForTimeout(800);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${pathname} 横向溢出 ${overflow}px`);
      report.adjacentPages.push({ pathname, overflow });
    }
    await context.close();
  } finally {
    await browser.close();
  }

  assert.deepEqual(report.pageErrors, [], `页面脚本错误：${JSON.stringify(report.pageErrors)}`);
  assert.deepEqual(report.consoleErrors, [], `控制台错误：${JSON.stringify(report.consoleErrors)}`);
  assert.deepEqual(report.serverErrors, [], `页面存在 5xx：${JSON.stringify(report.serverErrors)}`);
  assert.deepEqual(report.paidRequests, [], '导航验收不得触发付费接口');
  assert.deepEqual(report.devSessionRequests, [], '导航验收器不得再请求已下线的 dev-session 接口');
  assert.equal(report.writes.every(item => item.origin === origin && item.method === 'POST' && item.path === '/api/announcements/events'), true, `导航验收出现非同源公告写入：${JSON.stringify(report.writes)}`);
  report.productionWrites = 0;
  report.providerRequests = 0;
  report.paidGenerationRequests = report.paidRequests.length;
  report.nonGetRequests = report.writes.length;
}

report.passed = true;
report.sourceOnly = sourceOnly;
await fs.writeFile(path.join(outputDir, sourceOnly ? 'source-report.json' : 'live-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
