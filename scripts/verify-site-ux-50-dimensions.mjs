#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(
  ['http://127.0.0.1:5000', 'http://127.0.0.1:5010'].includes(origin),
  'LOCAL_SITE_UX_ORIGIN_REQUIRED',
);
const root = process.cwd();
const output = path.resolve(root, '.codex-evidence/site-ux-matrix-20260904/ux-50-dimensions.json');
const diagnosticReadPost = '/__nextjs_original-stack-frames';
const stateAdvancingGet = [
  /^\/api\/video\/(?:status|poll|stream)$/u,
  /^\/api\/image\/status$/u,
  /^\/api\/voice\/preview$/u,
  /^\/api\/digital-human\/.+\/(?:status|poll)$/u,
  /^\/api\/health$/u,
];
const adminRoutes = [
  { id: 'tools-segment', path: '/tools?tab=segment', label: '工具箱·智能分段', returnExpected: true },
  { id: 'tools-text', path: '/tools?tab=text', label: '工具箱·文案提取', returnExpected: true },
  { id: 'tools-video', path: '/tools?tab=video', label: '工具箱·视频提取', returnExpected: true },
  { id: 'tools-format', path: '/tools?tab=format', label: '工具箱·文字排版', returnExpected: true },
  { id: 'video', path: '/video', label: '视频制作', returnExpected: true },
  { id: 'storyboard', path: '/storyboard-workbench', label: '分镜工作台', returnExpected: true },
  { id: 'image', path: '/image-workbench', label: 'AI生图工作台', returnExpected: true },
  { id: 'voice-workspace', path: '/voice-studio/workspace', label: '智音工坊·语音合成', returnExpected: true },
  { id: 'voice-voices', path: '/voice-studio/voices', label: '智音工坊·音色库', returnExpected: true },
  { id: 'voice-imitate', path: '/voice-studio/imitate', label: '智音工坊·音色模仿', returnExpected: true },
  { id: 'cover', path: '/cover', label: '封面制作', returnExpected: true },
  { id: 'manju', path: '/youcai', label: '漫剧工作台', returnExpected: true },
  { id: 'digital-human', path: '/digital-human', label: 'AI数字人', returnExpected: true },
  { id: 'profile', path: '/profile', label: '个人中心', returnExpected: false },
  { id: 'recharge', path: '/recharge', label: '充值', returnExpected: true },
  { id: 'history', path: '/media-history', label: '已退役全局生成记录', returnExpected: false },
  { id: 'admin', path: '/admin', label: '管理员后台', returnExpected: false },
];
const navTargets = [
  { id: 'nav-tools', label: '工具箱', names: ['打开工具箱', '工具箱'], expected: '/tools' },
  { id: 'nav-video', label: '视频制作', names: ['视频制作'], expected: '/video' },
  { id: 'nav-storyboard', label: '分镜工作台', names: ['分镜工作台'], expected: '/storyboard-workbench' },
  { id: 'nav-image', label: 'AI生图工作台', names: ['AI生图工作台'], expected: '/image-workbench' },
  { id: 'nav-voice', label: '智音工坊', names: ['智音工坊', '语音合成'], expected: '/voice-studio/workspace' },
  { id: 'nav-cover', label: '封面制作', names: ['封面制作'], expected: '/cover' },
  { id: 'nav-manju', label: '漫剧工作台', names: ['漫剧工作台', '有彩创作', '有彩视界'], expected: '/youcai' },
];

const evidence = {
  observedAt: new Date().toISOString(), origin,
  policy: { localOnly: true, paidGenerationRequests: 0, businessWritesAllowed: false, externalLogin: false },
  service: {}, firstEntry: {}, navInventory: [], navTransitions: [], desktopRoutes: [], anonymous: {},
  blockedRequests: [], unexpectedConsole: [], pageErrors: [], httpErrors: [], matrix: [],
};
const blocked = new Map();
const apiCounts = new Map();
let generationRequests = 0;
let businessWrites = 0;
let browser;

const compact = value => String(value || '').replace(/https?:\/\/\S+/gu, '[url]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[redacted]').slice(0, 260);
const normalize = value => String(value || '').replace(/\s+/gu, '');
const isStateAdvancing = pathname => stateAdvancingGet.some(pattern => pattern.test(pathname));
const isGenerationPath = pathname => /\/(?:generate|submit|create|tts|clone|design)(?:\/|$)/u.test(pathname);
const isExpectedConsole = text => /ERR_BLOCKED_BY_CLIENT|Failed to load resource.*net::ERR_ABORTED|Download the React DevTools/u.test(text);
const routeMatches = (actual, expected) => actual === expected || actual.startsWith(expected + '/');
const requestSignature = url => {
  if (url.pathname === '/api/video/proxy') return null;
  const query = [...url.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    if (/token|secret|key|url|search|query/iu.test(key)) return `${key}=*`;
    return `${key}=${value.slice(0, 32)}`;
  }).join('&');
  return query ? `${url.pathname}?${query}` : url.pathname;
};

async function installPolicy(context, role, activeRoute) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let reason = '';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !(method === 'POST' && url.origin === origin && url.pathname === diagnosticReadPost)) {
      reason = 'business-non-get'; businessWrites += 1;
      if (isGenerationPath(url.pathname)) generationRequests += 1;
    } else if (method === 'GET' && url.origin === origin && isStateAdvancing(url.pathname)) reason = 'state-advancing-get';
    else if (url.origin !== origin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) reason = 'external-non-get';
    if (reason) {
      const key = `${role} ${method} ${url.origin === origin ? url.pathname : 'external'} ${reason}`;
      blocked.set(key, (blocked.get(key) || 0) + 1);
      await route.abort('blockedbyclient');
      return;
    }
    if (url.origin === origin && method === 'GET' && url.pathname.startsWith('/api/')) {
      const signature = requestSignature(url);
      if (signature) {
        const key = `${role} ${activeRoute?.value || '/unknown'} ${signature}`;
        apiCounts.set(key, (apiCounts.get(key) || 0) + 1);
      }
    }
    await route.continue();
  });
}

function attachObservers(page, role, activeRoute) {
  page.on('console', message => {
    if (message.type() !== 'error' || isExpectedConsole(message.text())) return;
    evidence.unexpectedConsole.push({ role, route: activeRoute.value, text: compact(message.text()) });
  });
  page.on('pageerror', error => evidence.pageErrors.push({ role, route: activeRoute.value, type: error.name || 'Error', message: compact(error.message) }));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) evidence.httpErrors.push({ role, route: activeRoute.value, path: url.pathname, status: response.status() });
  });
}

async function installFrameProbe(context) {
  await context.addInitScript(() => {
    window.__uxFrames = [];
    window.__uxCls = 0;
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__uxCls += entry.value;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
    const started = performance.now();
    const sample = () => {
      const nav = document.querySelector('.nav-bar-container');
      const cards = document.querySelectorAll('.agent-card-hover').length;
      const body = document.body;
      window.__uxFrames.push({ at: Math.round(performance.now() - started), nav: Boolean(nav), cards, width: document.documentElement?.scrollWidth || 0, text: body?.innerText?.length || 0 });
      if (performance.now() - started < 2500) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function measurePage(page, route, elapsedMs) {
  await page.waitForFunction(() => document.body?.innerText?.trim().length > 40, null, { timeout: 30_000 });
  await page.waitForTimeout(450);
  const measured = await page.evaluate(async input => {
    const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const controls = [...document.querySelectorAll('a,button')].filter(visible);
    const returnControls = controls.filter(element => /返回(?:主页|首页)|主站首页|返回[^\n]{0,20}主站/u.test(`${element.textContent || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`));
    const images = [...document.images].filter(visible);
    await Promise.all(images.slice(0, 80).map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); setTimeout(resolve, 1200); })));
    const brokenImages = images.filter(image => image.complete && image.naturalWidth === 0).length;
    const candidates = [document.scrollingElement, ...document.querySelectorAll('*')].filter(Boolean).filter(element => {
      const style = getComputedStyle(element); return element.scrollHeight > element.clientHeight + 4 && /(auto|scroll)/u.test(style.overflowY);
    });
    let scrollProbe = { needed: candidates.length > 0, worked: candidates.length === 0 };
    if (candidates.length) {
      const ordered = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      const attempts = [];
      for (const target of ordered.slice(0, 12)) {
        const isDocumentScroller = target === document.scrollingElement || target === document.documentElement || target === document.body;
        const priorHtmlScrollBehavior = document.documentElement.style.scrollBehavior;
        const priorBodyScrollBehavior = document.body.style.scrollBehavior;
        const priorTargetScrollBehavior = target.style.scrollBehavior;
        if (isDocumentScroller) {
          document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
          document.body.style.setProperty('scroll-behavior', 'auto', 'important');
        } else target.style.setProperty('scroll-behavior', 'auto', 'important');
        const restore = isDocumentScroller ? window.scrollY : target.scrollTop;
        if (isDocumentScroller) window.scrollTo(0, 0); else target.scrollTop = 0;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const before = isDocumentScroller ? window.scrollY : target.scrollTop;
        if (isDocumentScroller) window.scrollTo(0, 80); else target.scrollTop = 80;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const after = isDocumentScroller ? window.scrollY : target.scrollTop;
        attempts.push({ worked: after > before, delta: after - before, tag: target.tagName, className: typeof target.className === 'string' ? target.className.slice(0, 80) : '' });
        if (isDocumentScroller) window.scrollTo(0, restore); else target.scrollTop = restore;
        if (isDocumentScroller) {
          document.documentElement.style.scrollBehavior = priorHtmlScrollBehavior;
          document.body.style.scrollBehavior = priorBodyScrollBehavior;
        } else target.style.scrollBehavior = priorTargetScrollBehavior;
        if (attempts.at(-1).worked) break;
      }
      scrollProbe = { needed: true, worked: attempts.some(attempt => attempt.worked), attempts };
    }
    const text = document.body.innerText;
    const fatalPatterns = [...text.matchAll(/Application error|Unhandled Runtime Error|Internal Server Error|Cannot read properties|MIGRATION_NOT_READY|MODULE_NOT_FOUND|This page could not be found/gu)].map(match => match[0]);
    return {
      path: location.pathname, search: location.search, title: document.title,
      elapsedMs: input.elapsedMs, textLength: text.length, controls: document.querySelectorAll('button,input,textarea,select,a[href]').length,
      viewportWidth: innerWidth, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
      documentScrollable: document.documentElement.scrollHeight > innerHeight + 4,
      scrollProbe, imageCount: images.length, brokenImages,
      headings: [...document.querySelectorAll('h1,h2')].filter(visible).slice(0, 5).map(node => node.textContent?.trim()),
      returnExpected: input.returnExpected, returnCount: returnControls.length,
      returnTop: returnControls.slice(0, 3).map(element => Math.round(element.getBoundingClientRect().top)),
      fatalPatterns,
    };
  }, { returnExpected: route.returnExpected, elapsedMs });
  return { id: route.id, label: route.label, expected: route.path, ...measured };
}

async function visitRoute(page, activeRoute, route) {
  activeRoute.value = route.path;
  const began = Date.now();
  let response;
  try {
    response = await page.goto(origin + route.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    return { http: response?.status() || null, ...(await measurePage(page, route, Date.now() - began)) };
  } catch (error) {
    return { id: route.id, label: route.label, expected: route.path, http: response?.status() || null, failed: compact(error.message), elapsedMs: Date.now() - began };
  }
}

async function adminDesktop(session) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  const activeRoute = { value: '/' };
  await installPolicy(context, 'admin-desktop', activeRoute);
  await installFrameProbe(context);
  await context.addInitScript(({ token, user }) => { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); }, session);
  const page = await context.newPage(); attachObservers(page, 'admin-desktop', activeRoute);
  const started = Date.now();
  const homeResponse = await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  evidence.service.homeStatus = homeResponse?.status() || null;
  const cta = page.getByRole('button', { name: /立即体验/u }).first();
  const landingVisible = await cta.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  if (landingVisible) await cta.click();
  let entryRecovery = false;
  try {
    await page.locator('.agent-card-hover').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    evidence.firstEntryFailure = await page.evaluate(() => ({
      path: location.pathname,
      text: document.body.innerText.slice(0, 500),
      enteredApp: sessionStorage.getItem('entered_app'),
      shellCount: document.querySelectorAll('.app-shell').length,
      marketplaceCount: document.querySelectorAll('.marketplace-shell').length,
      cardCount: document.querySelectorAll('.agent-card-hover').length,
    }));
    await page.screenshot({ path: path.resolve(root, '.codex-evidence/site-ux-matrix-20260904/first-entry-failure.png') });
    await page.evaluate(() => sessionStorage.setItem('entered_app', '1'));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator('.agent-card-hover').first().waitFor({ state: 'visible', timeout: 30_000 });
    entryRecovery = true;
  }
  const cardReadyMs = Date.now() - started;
  await page.waitForTimeout(500);
  const first = await page.evaluate(async entry => {
    const images = [...document.querySelectorAll('.agent-card-hover img')];
    await Promise.all(images.slice(0, 40).map(image => Promise.race([
      image.decode().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 2_000)),
    ])));
    const frames = window.__uxFrames || [];
    const firstNav = frames.find(frame => frame.nav)?.at ?? null;
    const firstCards = frames.find(frame => frame.cards > 0)?.at ?? null;
    return {
      landingVisible: entry.landingVisible, entryRecovery: entry.entryRecovery, cardReadyMs: entry.cardReadyMs, cardCount: document.querySelectorAll('.agent-card-hover').length,
      agentImageCount: images.length, brokenAgentImages: images.filter(image => image.complete && image.naturalWidth === 0).length,
      firstNavFrameMs: firstNav, firstCardFrameMs: firstCards, cls: window.__uxCls || 0,
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      navVisible: Boolean(document.querySelector('.nav-bar-container')),
      marketplaceTextVisible: /应用广场/u.test(document.body.innerText),
    };
  }, { landingVisible, entryRecovery, cardReadyMs });
  evidence.firstEntry = first;
  evidence.navInventory = await page.locator('.nav-bar-container button').evaluateAll(buttons => buttons.map((button, index) => ({ index, text: button.textContent?.trim(), aria: button.getAttribute('aria-label'), visible: button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0 })));
  for (const target of navTargets) {
    activeRoute.value = `/nav-check/${target.id}`;
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.locator('.nav-bar-container').waitFor({ state: 'visible', timeout: 30_000 });
    const documentMarker = await page.evaluate(() => { window.__siteUxDocumentMarker = crypto.randomUUID(); return window.__siteUxDocumentMarker; });
    const buttons = page.locator('.nav-bar-container button');
    const snapshots = await buttons.evaluateAll(elements => elements.map((element, index) => ({ index, name: element.getAttribute('aria-label') || element.textContent?.trim() || '', visible: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 })));
    const candidates = snapshots.filter(item => item.visible && target.names.some(name => normalize(item.name) === normalize(name)));
    const result = { id: target.id, label: target.label, expected: target.expected, candidates: candidates.map(item => item.name) };
    if (candidates.length !== 1) {
      result.passed = false; result.reason = `visible-candidate-count:${candidates.length}`; evidence.navTransitions.push(result); continue;
    }
    const locator = page.locator('.nav-bar-container').getByRole('button', { name: candidates[0].name, exact: true });
    await locator.scrollIntoViewIfNeeded();
    const began = Date.now(); await locator.click();
    await page.waitForFunction(() => location.pathname !== '/', null, { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(300);
    result.actual = new URL(page.url()).pathname; result.elapsedMs = Date.now() - began;
    result.sameDocument = await page.evaluate(marker => window.__siteUxDocumentMarker === marker, documentMarker);
    result.passed = routeMatches(result.actual, target.expected) && result.sameDocument;
    evidence.navTransitions.push(result);
  }
  for (const route of adminRoutes) evidence.desktopRoutes.push(await visitRoute(page, activeRoute, route));
  await context.close();
}

async function anonymousChecks() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  const activeRoute = { value: '/' };
  await installPolicy(context, 'anonymous', activeRoute);
  const page = await context.newPage(); attachObservers(page, 'anonymous', activeRoute);
  const home = await visitRoute(page, activeRoute, { id: 'anonymous-home', path: '/', label: '匿名首页', returnExpected: false });
  const homeWheelBefore = await page.locator('.landing-page').evaluate(element => element.scrollTop).catch(() => null);
  await page.mouse.move(720, 480);
  await page.mouse.wheel(0, 1000);
  await page.waitForTimeout(700);
  const homeWheelAfter = await page.locator('.landing-page').evaluate(element => element.scrollTop).catch(() => null);
  const homeWheel = {
    before: homeWheelBefore,
    after: homeWheelAfter,
    worked: Number.isFinite(homeWheelBefore) && Number.isFinite(homeWheelAfter) && homeWheelAfter > homeWheelBefore,
  };
  const admin = await visitRoute(page, activeRoute, { id: 'anonymous-admin', path: '/admin', label: '匿名后台', returnExpected: false });
  const adminText = await page.locator('body').innerText().catch(() => '');
  const profile = await visitRoute(page, activeRoute, { id: 'anonymous-profile', path: '/profile', label: '匿名个人中心', returnExpected: false });
  const profileText = await page.locator('body').innerText().catch(() => '');
  evidence.anonymous = {
    home, homeWheel, admin, profile,
    adminDenied: /登录|无权|权限|管理员/u.test(adminText) && !/后台管理系统/u.test(adminText.replace(/请.*登录/gu, '')),
    profileDenied: profile.path !== '/profile' || /登录|请先登录|返回首页/u.test(profileText),
  };
  await context.close();
}

function routeOk(route) { return Boolean(route && !route.failed && route.http && route.http < 400 && !route.horizontalOverflow && route.fatalPatterns?.length === 0 && route.controls > 0); }
function findDesktop(id) { return evidence.desktopRoutes.find(route => route.id === id); }
function add(id, area, check, passed, detail) { evidence.matrix.push({ id, area, check, passed: Boolean(passed), evidence: detail }); }

function buildMatrix() {
  const desktop = evidence.desktopRoutes;
  const tools = ['tools-segment', 'tools-text', 'tools-video', 'tools-format'].map(findDesktop);
  const nav = id => evidence.navTransitions.find(item => item.id === id);
  const noDesktopPageErrors = evidence.pageErrors.filter(item => item.role === 'admin-desktop').length === 0;
  const noUnexpectedDesktopConsole = evidence.unexpectedConsole.filter(item => item.role === 'admin-desktop').length === 0;
  const authenticatedHttpErrors = evidence.httpErrors.filter(item => item.role.startsWith('admin-'));
  const duplicateReads = [...apiCounts].filter(([, count]) => count > 4).map(([request, count]) => ({ request, count }));
  const staticBoundaries = [
    'src/app/tools/loading.tsx', 'src/app/tools/error.tsx', 'src/app/video/loading.tsx',
    'src/app/storyboard-workbench/loading.tsx', 'src/app/storyboard-workbench/error.tsx',
    'src/app/image-workbench/loading.tsx', 'src/app/image-workbench/error.tsx',
    'src/app/voice-studio/loading.tsx', 'src/app/voice-studio/error.tsx', 'src/app/cover/loading.tsx',
  ];
  add('UX-01', 'runtime', '127.0.0.1:5000 首页 HTTP 200', evidence.service.homeStatus === 200, evidence.service);
  add('UX-02', 'auth', '本地管理员开发会话身份匹配', evidence.service.adminSession === true, { status: evidence.service.devSessionStatus, role: evidence.service.adminRole });
  add('UX-03', 'auth', '匿名首页可渲染并可通过鼠标滚轮浏览', routeOk(evidence.anonymous.home) && evidence.anonymous.homeWheel?.worked, { route: evidence.anonymous.home, wheel: evidence.anonymous.homeWheel });
  add('UX-04', 'auth', '匿名访问后台被明确拒绝', evidence.anonymous.adminDenied, { path: evidence.anonymous.admin.path, denied: evidence.anonymous.adminDenied });
  add('UX-05', 'auth', '匿名个人中心要求登录', evidence.anonymous.profileDenied, { path: evidence.anonymous.profile.path, denied: evidence.anonymous.profileDenied });
  add('UX-06', 'auth', '管理员后台可访问且有交互控件', routeOk(findDesktop('admin')), findDesktop('admin'));
  add('UX-07', 'home', '首次进入入口可进入应用', evidence.firstEntry.landingVisible && !evidence.firstEntry.entryRecovery && evidence.firstEntry.cardCount > 0, evidence.firstEntry);
  add('UX-08', 'home', '首次智能体卡片 5 秒内可见', evidence.firstEntry.cardReadyMs <= 5000, { cardReadyMs: evidence.firstEntry.cardReadyMs });
  add('UX-09', 'home', '应用广场存在智能体卡片', evidence.firstEntry.cardCount > 0, { cardCount: evidence.firstEntry.cardCount });
  add('UX-10', 'home', '智能体头像完成解码且无破图', evidence.firstEntry.agentImageCount > 0 && evidence.firstEntry.brokenAgentImages === 0, { imageCount: evidence.firstEntry.agentImageCount, broken: evidence.firstEntry.brokenAgentImages });
  add('UX-11', 'home', '首页导航首帧可见', evidence.firstEntry.navVisible && evidence.firstEntry.firstNavFrameMs !== null, { firstNavFrameMs: evidence.firstEntry.firstNavFrameMs });
  add('UX-12', 'home', '首页智能体卡片首帧时间有采样', evidence.firstEntry.firstCardFrameMs !== null, { firstCardFrameMs: evidence.firstEntry.firstCardFrameMs });
  add('UX-13', 'home', '首页 CLS 不超过 0.1', evidence.firstEntry.cls <= 0.1, { cls: evidence.firstEntry.cls });
  add('UX-14', 'home', '桌面首页无文档级横向溢出', evidence.firstEntry.documentWidth <= evidence.firstEntry.viewportWidth + 2, { documentWidth: evidence.firstEntry.documentWidth, viewportWidth: evidence.firstEntry.viewportWidth });
  add('UX-15', 'home', '应用广场主内容可见', evidence.firstEntry.marketplaceTextVisible, { visible: evidence.firstEntry.marketplaceTextVisible });
  add('UX-16', 'navigation', '主导航不存在重复可访问名称', new Set(evidence.navInventory.filter(item => item.visible).map(item => normalize(item.aria || item.text))).size === evidence.navInventory.filter(item => item.visible).length, evidence.navInventory);
  add('UX-17', 'navigation', '工具箱入口 SPA 到达正确路由', nav('nav-tools')?.passed, nav('nav-tools'));
  add('UX-18', 'navigation', '视频制作入口 SPA 到达正确路由', nav('nav-video')?.passed, nav('nav-video'));
  add('UX-19', 'navigation', '分镜工作台入口 SPA 到达正确路由', nav('nav-storyboard')?.passed, nav('nav-storyboard'));
  add('UX-20', 'navigation', 'AI 生图入口 SPA 到达正确路由', nav('nav-image')?.passed, nav('nav-image'));
  add('UX-21', 'navigation', '智音工坊入口 SPA 到达正确路由', nav('nav-voice')?.passed, nav('nav-voice'));
  add('UX-22', 'navigation', '封面制作入口 SPA 到达正确路由', nav('nav-cover')?.passed, nav('nav-cover'));
  add('UX-23', 'navigation', '漫剧工作台入口 SPA 到达正确路由', nav('nav-manju')?.passed, nav('nav-manju'));
  const retiredDigitalHumanNav = evidence.navInventory.filter(item => item.visible && /^(?:AI|AA|UsersAI)?数字人$/iu.test(normalize(item.aria || item.text)));
  add('UX-24', 'navigation', '已退役数字人不再出现在主导航', retiredDigitalHumanNav.length === 0, retiredDigitalHumanNav);
  add('UX-25', 'toolbox', '智能分段页可渲染且无溢出', routeOk(findDesktop('tools-segment')), findDesktop('tools-segment'));
  add('UX-26', 'toolbox', '文案提取页可渲染且无溢出', routeOk(findDesktop('tools-text')), findDesktop('tools-text'));
  add('UX-27', 'toolbox', '视频提取页可渲染且无溢出', routeOk(findDesktop('tools-video')), findDesktop('tools-video'));
  add('UX-28', 'toolbox', '文字排版页可渲染且无溢出', routeOk(findDesktop('tools-format')), findDesktop('tools-format'));
  add('UX-29', 'toolbox', '工具箱四页都有可操作控件', tools.every(route => route?.controls > 0), tools.map(route => ({ id: route?.id, controls: route?.controls })));
  add('UX-30', 'toolbox', '工具箱四页均无破图', tools.every(route => route?.brokenImages === 0), tools.map(route => ({ id: route?.id, images: route?.imageCount, broken: route?.brokenImages })));
  add('UX-31', 'workbench', '视频制作页可渲染、可滚动且无溢出', routeOk(findDesktop('video')) && findDesktop('video')?.scrollProbe?.worked, findDesktop('video'));
  add('UX-32', 'workbench', '分镜工作台可渲染、可滚动且无溢出', routeOk(findDesktop('storyboard')) && findDesktop('storyboard')?.scrollProbe?.worked, findDesktop('storyboard'));
  add('UX-33', 'workbench', 'AI 生图工作台可渲染、可滚动且无溢出', routeOk(findDesktop('image')) && findDesktop('image')?.scrollProbe?.worked, findDesktop('image'));
  add('UX-34', 'voice', '智音工坊语音合成页可渲染且无溢出', routeOk(findDesktop('voice-workspace')), findDesktop('voice-workspace'));
  add('UX-35', 'voice', '智音工坊音色库可渲染且无破图', routeOk(findDesktop('voice-voices')) && findDesktop('voice-voices')?.brokenImages === 0, findDesktop('voice-voices'));
  add('UX-36', 'voice', '智音工坊音色模仿页可渲染且无溢出', routeOk(findDesktop('voice-imitate')), findDesktop('voice-imitate'));
  add('UX-37', 'workbench', '封面制作页可渲染、可滚动且无溢出', routeOk(findDesktop('cover')) && findDesktop('cover')?.scrollProbe?.worked, findDesktop('cover'));
  add('UX-38', 'workbench', '漫剧工作台可渲染且无溢出', routeOk(findDesktop('manju')), findDesktop('manju'));
  add('UX-39', 'workbench', 'AI 数字人可渲染、可滚动且无溢出', routeOk(findDesktop('digital-human')) && findDesktop('digital-human')?.scrollProbe?.worked, findDesktop('digital-human'));
  add('UX-40', 'account', '个人中心可访问且无溢出', routeOk(findDesktop('profile')), findDesktop('profile'));
  add('UX-41', 'account', '充值页可访问且无溢出', routeOk(findDesktop('recharge')), findDesktop('recharge'));
  add('UX-42', 'account', '旧全局生成记录已安全退役并返回应用广场', routeOk(findDesktop('history')) && findDesktop('history')?.path === '/', findDesktop('history'));
  add('UX-43', 'navigation', '要求返回入口的二级页均提供顶部返回控件', desktop.filter(route => adminRoutes.find(item => item.id === route.id)?.returnExpected).every(route => route.returnCount > 0 && route.returnTop.some(top => top <= 160)), desktop.filter(route => route.returnExpected).map(route => ({ id: route.id, count: route.returnCount, top: route.returnTop })));
  add('UX-44', 'desktop', '电脑端关键页全部无文档级横向溢出', desktop.every(route => route.horizontalOverflow === false), desktop.map(route => ({ id: route.id, width: route.documentWidth, viewport: route.viewportWidth, overflow: route.horizontalOverflow })));
  add('UX-45', 'desktop', '电脑端关键页内容需要滚动时能够滚动', desktop.every(route => route.scrollProbe?.worked !== false), desktop.map(route => ({ id: route.id, scroll: route.scrollProbe })));
  add('UX-46', 'quality', '电脑端无浏览器 pageerror 且认证页无 HTTP 4xx/5xx', noDesktopPageErrors && authenticatedHttpErrors.length === 0, { pageErrors: evidence.pageErrors, authenticatedHttpErrors });
  add('UX-47', 'quality', '桌面无非拦截器导致的 console error', noUnexpectedDesktopConsole, evidence.unexpectedConsole.filter(item => item.role === 'admin-desktop'));
  add('UX-48', 'quality', '核心加载/错误边界文件齐全', staticBoundaries.every(file => evidence.service.boundaries[file]), evidence.service.boundaries);
  add('UX-49', 'quality', '单页同一业务 GET 不超过 4 次', duplicateReads.length === 0, duplicateReads);
  add('UX-50', 'safety', '验收未执行付费生成或业务写入', generationRequests === 0 && evidence.policy.executedBusinessWrites === 0, { generationRequests, blockedBusinessWriteAttempts: businessWrites, executedBusinessWrites: evidence.policy.executedBusinessWrites });
  assert.equal(evidence.matrix.length, 50);
}

try {
  const home = await fetch(origin + '/', { signal: AbortSignal.timeout(15_000) });
  evidence.service.httpPreflight = home.status;
  const suppliedToken = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  const sessionResponse = suppliedToken
    ? await fetch(origin + '/api/auth/me', { headers: { Authorization: `Bearer ${suppliedToken}` }, signal: AbortSignal.timeout(15_000) })
    : await fetch(origin + '/api/auth/dev-session', { headers: { 'x-local-workbench': 'ai-creation-studio-local' }, signal: AbortSignal.timeout(15_000) });
  evidence.service.sessionStatus = sessionResponse.status;
  evidence.service.sessionMode = suppliedToken ? 'authenticated-admin-session' : 'local-development-session';
  const sessionBody = await sessionResponse.json();
  const session = suppliedToken ? { token: suppliedToken, user: sessionBody.user } : sessionBody;
  assert.ok(sessionResponse.ok && session.token && session.user?.role === 'admin', 'Normal local admin session is unavailable');
  evidence.service.adminSession = true; evidence.service.adminRole = session.user.role;
  evidence.service.boundaries = Object.fromEntries(await Promise.all([
    'src/app/tools/loading.tsx', 'src/app/tools/error.tsx', 'src/app/video/loading.tsx',
    'src/app/storyboard-workbench/loading.tsx', 'src/app/storyboard-workbench/error.tsx',
    'src/app/image-workbench/loading.tsx', 'src/app/image-workbench/error.tsx',
    'src/app/voice-studio/loading.tsx', 'src/app/voice-studio/error.tsx', 'src/app/cover/loading.tsx',
  ].map(async file => [file, await fs.access(path.join(root, file)).then(() => true).catch(() => false)])));
  browser = await chromium.launch({ headless: true });
  await adminDesktop({ token: session.token, user: session.user });
  await anonymousChecks();
  evidence.policy.executedBusinessWrites = 0;
  buildMatrix();
  evidence.policy.paidGenerationRequests = generationRequests;
  evidence.policy.blockedBusinessWriteAttempts = businessWrites;
  evidence.blockedRequests = [...blocked].map(([request, count]) => ({ request, count }));
  evidence.apiRequestCounts = [...apiCounts].map(([request, count]) => ({ request, count }));
  evidence.summary = { total: 50, passed: evidence.matrix.filter(item => item.passed).length, failed: evidence.matrix.filter(item => !item.passed).length };
  if (evidence.summary.failed > 0) process.exitCode = 1;
} catch (error) {
  evidence.failure = { type: error.name || 'Error', message: compact(error.message) };
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output, summary: evidence.summary || null, failure: evidence.failure || null, generationRequests, businessWrites, pageErrors: evidence.pageErrors.length, unexpectedConsole: evidence.unexpectedConsole.length }, null, 2));
}

