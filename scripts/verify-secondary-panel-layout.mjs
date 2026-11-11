import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installStoryboardBrowserFixture } from './storyboard-browser-fixture.mjs';

// Run through with-local-admin-session.mjs. All layouts are read from the
// current local pages. The browser cannot submit a generation or save a draft.
const origin = 'http://127.0.0.1:5000';

async function sameEdges(left, right, label) {
  const [a, b] = await Promise.all([left.boundingBox(), right.boundingBox()]);
  assert.ok(a && b, label + ' missing panel');
  assert.ok(Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.y + a.height - b.y - b.height) <= 0.5,
    label + ': ' + JSON.stringify([a, b]));
  const height = left.page().viewportSize().height;
  assert.ok(a.height <= height, label + ' extends beyond a desktop viewport: ' + a.height);
  if (label.startsWith('/')) assert.ok(a.y + a.height <= height, label + ' pane extends below the viewport');
  return { top: a.y - b.y, bottom: a.y + a.height - b.y - b.height };
}

async function scrollToEnd(locator) {
  return locator.evaluate(node => {
    node.scrollTop = node.scrollHeight;
    return node.scrollHeight <= node.clientHeight + 1 ||
      node.scrollTop > 0 && node.scrollHeight - node.clientHeight - node.scrollTop < 2;
  });
}

export async function main() {
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.ok(token, 'Use the local acceptance launcher');
  const user = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY).user;
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const [width, height] of [[1366, 768], [1440, 900], [2400, 1240]]) {
      for (const theme of ['soft-white', 'lattice', 'crystal-aurora']) {
        const mode = theme === 'soft-white' ? 'light' : 'dark';
        const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
        try {
          await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true }]);
          await context.route('**/*', route => {
            const req = route.request(), url = new URL(req.url());
            if (url.origin !== origin) return route.abort();
            if (!['GET', 'HEAD'].includes(req.method())) return route.fulfill({ status: 204 });
            if (url.pathname === '/_next/image' && /^https?:/iu.test(url.searchParams.get('url') || '')) return route.abort();
            if (url.pathname.startsWith('/api/') && !['/api/help', '/api/video/models', '/api/tools/runtime-catalog'].includes(url.pathname)) {
              return route.fulfill({ json: { settings: { theme, theme_mode: mode }, items: [], tasks: [],
                activeTasks: [], records: [], projects: [], history: [], models: [], notifications: [], announcements: [] } });
            }
            return route.continue();
          });
          const page = await context.newPage();
          await installStoryboardBrowserFixture(page, { origin, token, user: { ...user, themePreference: theme,
            themeModePreference: mode, themePreferenceExpiresAt: '2099-01-01T00:00:00Z' }, resetStorage: false });
          await page.addInitScript(({ theme, mode }) => {
            localStorage.setItem('user_theme_preference', theme);
            localStorage.setItem('user_theme_mode_preference', mode);
            localStorage.setItem('user_theme_preference_expires_at', '2099-01-01T00:00:00Z');
          }, { theme, mode });
          const visit = async pathname => {
            await page.goto(origin + pathname, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(id => document.documentElement.dataset.theme === id, theme);
          };
          const check = async (name, a, b) => {
            await a.waitFor(); await b.waitFor();
            results.push({ width, height, theme, name, ...await sameEdges(a, b, name) });
          };
          await visit('/storyboard-workbench');
          await check('storyboard', page.locator('.sbw-editor .sbw-body .sbw-model-rail'), page.locator('.sbw-editor .sbw-workspace'));
          const readPalette = selector => page.locator(selector).evaluate(node => {
            const css = getComputedStyle(node);
            return [css.backgroundColor, css.getPropertyValue('--primary').trim()];
          });
          await visit('/video');
          const studioPalette = await readPalette('.secondary-workbench');
          for (const pathname of ['/image-workbench', '/tools/image/image-chat']) {
            await visit(pathname);
            const settings = page.locator('.image-workbench-root > main > aside');
            const editor = page.locator('.image-workbench-root > main > section');
            await check(pathname, settings, editor);
            assert.deepEqual(await readPalette('.image-workbench-root'), studioPalette, pathname + ' palette');
            assert.ok(await scrollToEnd(settings), pathname + ' settings scroll');
            assert.ok(await scrollToEnd(editor), pathname + ' editor scroll');
          }
          for (const pathname of ['/video', '/tools/video/kling-video']) {
            await visit(pathname);
            const rail = page.locator('[data-video-model-list]'), pane = page.locator('[data-video-task-pane]');
            await check(pathname, rail, pane);
            assert.deepEqual(await readPalette('.secondary-workbench'), studioPalette, pathname + ' palette');
            const tasks = pane.locator('[data-video-task-card]');
            await tasks.first().waitFor();
            const count = await tasks.count();
            assert.equal(count, 3, pathname + ' initial task count');
            await pane.getByRole('button', {name: /添加任务/}).click();
            await tasks.nth(count).waitFor();
            const boxes = await tasks.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
            const gridWidth = await tasks.first().evaluate(node => node.parentElement.clientWidth);
            const columns = Math.max(1, Math.min(3, Math.floor((gridWidth + 16) / (304 + 16))));
            assert.ok(boxes.slice(0, columns).every(box => Math.abs(box.y - boxes[0].y) < 1), pathname + ' first row');
            assert.ok(boxes[columns].y >= boxes[0].bottom && Math.abs(boxes[columns].x - boxes[0].x) < 1, pathname + ' next task starts row two');
            await check(pathname + ' with added task', rail, pane);
            assert.ok(await scrollToEnd(rail.locator(':scope > :last-child')), pathname + ' model list scroll');
            assert.ok(await scrollToEnd(pane), pathname + ' task scroll');
            await check(pathname + ' scrolled', rail, pane);
            for (let remaining = count; remaining >= 1; remaining--) {
              await pane.getByRole('button', {name: '移除末张卡片'}).click();
              await page.getByRole('button', {name: '确认移除'}).click();
              await tasks.nth(remaining).waitFor({state: 'detached'});
              const first = await tasks.first().boundingBox();
              assert.ok(first && Math.abs(first.width - boxes[0].width) < 1, pathname + ' width at ' + remaining + ' tasks');
            }
          }
          await visit('/help');
          const categories = page.getByRole('complementary', { name: '学习中心分类' });
          const list = categories.locator('xpath=following-sibling::section[1]');
          await check('help index', categories, list);
          assert.deepEqual(await readPalette('.help-page'), studioPalette, 'directory palette');
          const mainBackground = await page.locator('#help-main').evaluate(node => getComputedStyle(node).backgroundColor);
          assert.equal(mainBackground, 'rgba(0, 0, 0, 0)', 'the public directory shows the surrounding theme grid');
          const link = list.locator('a[href^="/help/"]').first();
          const detailPath = await link.getAttribute('href');
          assert.ok(detailPath?.startsWith('/help/'));
          assert.ok(await scrollToEnd(list), 'last article reachable');
          await check('help index scrolled', categories, list);
          await visit(detailPath);
          const toc = page.getByRole('complementary', { name: '本文目录' });
          const article = toc.locator('xpath=preceding-sibling::article[1]');
          await check('help article', article, toc);
          assert.deepEqual(await readPalette('.help-page'), studioPalette, 'article palette');
          const anchor = toc.locator('a').last();
          const hash = await anchor.getAttribute('href');
          await anchor.click();
          await page.waitForFunction(hash => location.hash === hash, hash);
          assert.ok(await article.evaluate((node, hash) => {
            const target = document.getElementById(hash.slice(1));
            if (!target) return false;
            const box = node.getBoundingClientRect(), item = target.getBoundingClientRect();
            return item.top < box.bottom && item.bottom > box.top;
          }, hash), 'section reached inside the article');
          await check('help article anchored', article, toc);
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify({ cases: results.length, maxTop: Math.max(...results.map(r => Math.abs(r.top))),
    maxBottom: Math.max(...results.map(r => Math.abs(r.bottom))) }));
}
