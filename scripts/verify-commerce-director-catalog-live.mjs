import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const sourceOnly = process.argv.includes('--source-only');
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const out = path.resolve('.codex-evidence/commerce-director-catalog-20260923');
await fs.mkdir(out, { recursive: true });

const [workspaceSource, pickerSource] = await Promise.all([
  fs.readFile(path.resolve('src/commerce/components/commerce-agent/workspace.tsx'), 'utf8'),
  fs.readFile(path.resolve('src/commerce/components/commerce-agent/reference-ui.tsx'), 'utf8'),
]);
assert.doesNotMatch(workspaceSource, /VideoDirectorCatalog/u, '视频制作不应常驻渲染超级编导卡片墙');
assert.doesNotMatch(workspaceSource, /ca-prompt-chips[\s\S]*?直击产品核心痛点/u, '六个对标切入点只属于超级编导会话，不应重复出现在普通视频编辑器');
assert.match(workspaceSource, /className="ca-depth-entry"[\s\S]*?上传原视频并替换人物、服装、商品或环境/u);
assert.match(workspaceSource, /<CreationPicker kind="video"[\s\S]*?onPick=\{chooseDirector\}/u);
assert.match(workspaceSource, /onClick=\{\(\) => chooseDirector\('default-director'\)\}[\s\S]*?超级编导/u);
assert.match(pickerSource, /label=\{kind==='image'\?'选择图片技能':'选择视频编导'\}/u);
assert.match(pickerSource, /\['电商带货','同城到店','品牌广告','剧情短片'\]/u);

const report = {
  checkedAt: new Date().toISOString(),
  sourceOnly,
  source: { persistentCatalog: false, compactPicker: true, compactCloneEntry: true },
  viewports: [], adjacentPages: [], pageErrors: [], consoleErrors: [], serverErrors: [],
  paidRequests: [], normalConversationOpens: [], unexpectedWrites: [],
};

if (!sourceOnly) {
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
  const identityResponse = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  assert.equal(identityResponse.ok, true, `LOCAL_ADMIN_SESSION_INVALID:${identityResponse.status}`);
  const identity = await identityResponse.json();
  const catalogResponse = await fetch(`${origin}/api/commerce/v1/director-catalog`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  assert.equal(catalogResponse.ok, true, `DIRECTOR_CATALOG_FAILED:${catalogResponse.status}`);
  const catalog = await catalogResponse.json();
  const expectedDirectors = catalog.directors.filter(item => !item.default);
  assert.ok(expectedDirectors.length >= 18, `DIRECTOR_COUNT_TOO_SMALL:${expectedDirectors.length}`);
  const expectedNames = expectedDirectors.map(item => item.name).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  report.expectedDirectorCount = expectedDirectors.length;
  report.expectedDirectorNames = expectedNames;

  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      await context.addInitScript(({ sessionToken, sessionUser }) => {
        localStorage.setItem('auth_token', sessionToken);
        localStorage.setItem('auth_user', JSON.stringify(sessionUser));
        localStorage.setItem('ca-announce-20260912', '1');
      }, { sessionToken: token, sessionUser: identity.user });
      await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      page.on('pageerror', error => report.pageErrors.push({ viewport: viewport.name, message: error.message }));
      page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ viewport: viewport.name, message: message.text() }); });
      page.on('response', response => { if (response.status() >= 500) report.serverErrors.push({ viewport: viewport.name, status: response.status(), url: response.url() }); });
      page.on('request', request => {
        const url = new URL(request.url());
        if (/\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/u.test(url.pathname)) report.paidRequests.push(url.pathname);
        let normalConversationOpen = false;
        if (request.method() === 'POST' && url.pathname === '/api/commerce/director-conversations') {
          try {
            const body = request.postDataJSON();
            normalConversationOpen = body?.action === 'open';
            if (normalConversationOpen) report.normalConversationOpens.push({ viewport: viewport.name, action: body.action });
          } catch {}
        }
        if (request.method() !== 'GET' && request.method() !== 'HEAD' && !normalConversationOpen && !(url.pathname === '/api/commerce/depth-video-clones' && viewport.name === 'desktop')) {
          report.unexpectedWrites.push({ viewport: viewport.name, method: request.method(), pathname: url.pathname });
        }
      });
      const response = await page.goto(`${origin}/commerce/toolbox/video-generation`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      assert.equal(response?.status(), 200);
      await page.getByTestId('commerce-workspace').waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await page.getByTestId('commerce-video-director-catalog').count(), 0, '超级编导卡片墙不应占用工作台首屏');
      const editor = page.locator('.ca-editor').first();
      const headingTrigger = page.locator('.ca-editor-heading > button[data-popover-trigger]').first();
      const cloneEntry = page.locator('button.ca-depth-entry[aria-label="上传原视频并替换人物、服装、商品或环境"]');
      await Promise.all([editor.waitFor({ state: 'visible' }), headingTrigger.waitFor({ state: 'visible' }), cloneEntry.waitFor({ state: 'visible' })]);
      const editorTop = (await editor.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
      assert.ok(editorTop < (viewport.name === 'desktop' ? 180 : 260), `${viewport.name.toUpperCase()}_EDITOR_PUSHED_BELOW_FOLD:${editorTop}`);

      const benchmarkEntries = ['直击产品核心痛点', '利用新奇场景开场', '制造强烈情绪反转', '用反常识观点开场', '真实痛点引出需求', '强烈对比突出差异'];
      for (const entry of benchmarkEntries) assert.equal(await editor.getByRole('button', { name: entry, exact: true }).count(), 0, `普通视频编辑器不应重复展示超级编导切入点：${entry}`);
      await page.locator('.ca-video-helper-actions button').filter({ hasText: '超级编导' }).click();
      const directorWelcome = page.locator('.ca-director-welcome');
      await directorWelcome.waitFor({ state: 'visible', timeout: 20_000 });
      assert.deepEqual((await directorWelcome.locator('button').allInnerTexts()).map(value => value.trim()), benchmarkEntries, '超级编导首层必须提供对标站当前六个创作切入点');
      await directorWelcome.getByRole('button', { name: benchmarkEntries[0], exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: '编导聊天输入' }).inputValue(), benchmarkEntries[0]);
      await page.getByRole('button', { name: '退出编导', exact: true }).click();

      await headingTrigger.click();
      const dialog = page.getByRole('dialog', { name: '选择视频编导' });
      await dialog.waitFor({ state: 'visible', timeout: 20_000 });
      const reachable = new Set();
      for (const category of ['电商带货', '同城到店', '品牌广告', '剧情短片']) {
        await dialog.getByRole('button', { name: category, exact: true }).click();
        const names = await dialog.locator('.ca-creation-cards strong').allInnerTexts();
        names.forEach(name => reachable.add(name.trim()));
      }
      const reachableNames = [...reachable].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      assert.deepEqual(reachableNames, expectedNames, '四个分类必须覆盖全部已发布超级编导');

      const chosen = expectedDirectors[0];
      await dialog.getByRole('button', { name: '搜索创作技能' }).click();
      await dialog.getByRole('textbox', { name: '搜索图片或编导技能' }).fill(chosen.name);
      const chosenCard = dialog.locator('.ca-creation-cards button').filter({ hasText: chosen.name }).first();
      await chosenCard.waitFor({ state: 'visible' });
      await chosenCard.click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.ca-editor-heading strong').first().innerText(), chosen.name);
      await page.waitForTimeout(500);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${viewport.name.toUpperCase()}_OVERFLOW:${overflow}`);
      const headingFontSize = Number.parseFloat(await page.locator('.ca-editor-heading strong').first().evaluate(node => getComputedStyle(node).fontSize));
      const cloneFontSize = Number.parseFloat(await cloneEntry.locator('strong').evaluate(node => getComputedStyle(node).fontSize));
      assert.ok(headingFontSize >= 13, `DIRECTOR_HEADING_FONT_TOO_SMALL:${headingFontSize}`);
      assert.ok(cloneFontSize >= 12, `CLONE_ENTRY_FONT_TOO_SMALL:${cloneFontSize}`);
      await page.screenshot({ path: path.join(out, `${viewport.name}-video-director-picker.png`), fullPage: viewport.name === 'mobile' });
      report.viewports.push({ ...viewport, reachableDirectorCount: reachableNames.length, overflow, editorTop, headingFontSize, cloneFontSize });

      if (viewport.name === 'desktop') {
        await cloneEntry.click();
        await page.waitForURL(/\/commerce\/toolbox\/depth-video-clone(?:\?|$)/u, { timeout: 20_000 });
        await page.getByRole('region', { name: '深度复刻工作区' }).waitFor({ state: 'visible', timeout: 20_000 });
        report.cloneRoute = new URL(page.url()).pathname;
      }
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(({ sessionToken, sessionUser }) => {
      localStorage.setItem('auth_token', sessionToken);
      localStorage.setItem('auth_user', JSON.stringify(sessionUser));
      localStorage.setItem('ca-announce-20260912', '1');
    }, { sessionToken: token, sessionUser: identity.user });
    await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    for (const pathname of ['/commerce/toolbox/image-generation', '/commerce']) {
      const response = await page.goto(`${origin}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      assert.equal(response?.status(), 200);
      await page.waitForTimeout(800);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${pathname}_OVERFLOW:${overflow}`);
      report.adjacentPages.push({ pathname, overflow });
    }
    await context.close();
  } finally { await browser.close(); }
  assert.deepEqual(report.pageErrors, [], `PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
  assert.deepEqual(report.consoleErrors, [], `CONSOLE_ERRORS:${JSON.stringify(report.consoleErrors)}`);
  assert.deepEqual(report.serverErrors, [], `SERVER_ERRORS:${JSON.stringify(report.serverErrors)}`);
  assert.deepEqual(report.paidRequests, [], `PAID_REQUESTS:${JSON.stringify(report.paidRequests)}`);
  assert.deepEqual(report.normalConversationOpens, [{ viewport: 'desktop', action: 'open' }, { viewport: 'desktop', action: 'open' }, { viewport: 'mobile', action: 'open' }, { viewport: 'mobile', action: 'open' }], `NORMAL_CONVERSATION_OPENS:${JSON.stringify(report.normalConversationOpens)}`);
  assert.deepEqual(report.unexpectedWrites, [], `UNEXPECTED_WRITES:${JSON.stringify(report.unexpectedWrites)}`);
}

report.passed = true;
await fs.writeFile(path.join(out, sourceOnly ? 'source-report.json' : 'live-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ passed: true, sourceOnly, directorCount: report.expectedDirectorCount || null, viewports: report.viewports }));
