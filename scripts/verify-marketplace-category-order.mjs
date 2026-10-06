import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
let token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
if (!token) {
  const response = await fetch(`${origin}/api/auth/dev-session`, {
    headers: { 'x-local-workbench': 'ai-creation-studio-local' },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.ok, true, `LOCAL_ADMIN_SESSION_FETCH_FAILED:${response.status}`);
  const session = await response.json();
  token = String(session.token || '').trim();
}
assert.ok(token, 'LOCAL_ADMIN_SESSION_REQUIRED');

const expectedCategories = ['全部助手', '我的收藏', '商业IP', '影像编导', '文案创作', '运营增长', '内部工具'];
const orderedContentCategories = ['商业IP', '影像编导', '文案创作', '运营增长', '内部工具'];
const expectedCommercialIpAgents = [
  '商业IP定位',
  '账号主页包装',
  '对标账号拆解',
  '内容选题策划',
  '短视频文案成稿',
  '咨询回复与跟进',
  '运营数据复盘',
];
const out = path.resolve('.codex-evidence/marketplace-commercial-ip-seven-2.3.0');
await fs.mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const report = {
  checkedAt: new Date().toISOString(),
  origin,
  expectedCategories,
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  paidRequests: [],
  groups: {},
};

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(value => {
    localStorage.setItem('auth_token', value);
    localStorage.setItem('active_view', 'marketplace');
    sessionStorage.setItem('entered_app', '1');
  }, token);
  await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);

  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
  });
  page.on('request', request => {
    if (/\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/u.test(request.url())) {
      report.paidRequests.push(request.url());
    }
  });
  page.on('response', response => {
    if (response.status() >= 500) report.serverErrors.push({ status: response.status(), url: response.url() });
  });

  const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.equal(response?.status(), 200);
  await page.locator('.marketplace-category-bar').waitFor({ state: 'visible', timeout: 30_000 });
  const close = page.getByRole('button', { name: '关闭', exact: true });
  if (await close.count() && await close.last().isVisible()) await close.last().click();

  const categoryBar = page.locator('.marketplace-category-bar');
  const categoryTabs = categoryBar.locator('.category-tab');
  const rawLabels = (await categoryTabs.allTextContents()).map(value => value.trim());
  const labels = rawLabels.map(value => value.replace(/^[^\p{L}\p{N}]+/u, '').replace(/^我的收藏\s*\d+$/u, '我的收藏'));
  assert.deepEqual(labels, expectedCategories, `导航分类顺序不一致：${JSON.stringify(labels)}`);

  const cardNames = async () => page.locator('[aria-label^="打开智能体："]').evaluateAll(elements =>
    elements.map(element => element.getAttribute('aria-label')?.replace(/^打开智能体：/u, '') || '')
  );

  const groups = {};
  await categoryTabs.nth(1).click();
  await page.waitForTimeout(250);
  groups['我的收藏'] = await cardNames();
  for (const label of orderedContentCategories) {
    await categoryBar.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(250);
    groups[label] = await cardNames();
    assert.ok(groups[label].length > 0, `${label} 分类不应为空`);
  }
  assert.deepEqual(groups['商业IP'], expectedCommercialIpAgents, '商业IP分类必须只包含七个闭环智能体，并按业务顺序排列');
  assert.equal(groups['内部工具'].includes('对标账号拆解'), false, '对标账号拆解不应继续留在内部工具分类');
  report.groups = Object.fromEntries(Object.entries(groups).map(([label, names]) => [label, { count: names.length, names }]));

  await categoryBar.getByRole('button', { name: '全部助手', exact: true }).click();
  await page.waitForTimeout(250);
  const allCards = await cardNames();
  const expectedAllCards = orderedContentCategories.flatMap(label => groups[label]);
  assert.deepEqual(allCards.slice(0, expectedAllCards.length), expectedAllCards, '“全部”必须按导航分类顺序拼接，并保留每个分类的内部顺序');
  report.legacyFallbackCards = allCards.slice(expectedAllCards.length);
  assert.deepEqual(report.paidRequests, [], '分类验收不得触发付费生成接口');
  assert.deepEqual(report.pageErrors, [], `页面脚本错误：${report.pageErrors.join(' | ')}`);
  assert.deepEqual(report.consoleErrors, [], `页面控制台错误：${report.consoleErrors.join(' | ')}`);
  assert.deepEqual(report.serverErrors, [], `页面存在5xx：${JSON.stringify(report.serverErrors)}`);

  report.version = await page.evaluate(async () => fetch('/api/version').then(result => result.json()));
  report.allCount = allCards.length;
  report.passed = true;
  await page.screenshot({ path: path.join(out, 'marketplace-all.png'), fullPage: false });
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report));
}
