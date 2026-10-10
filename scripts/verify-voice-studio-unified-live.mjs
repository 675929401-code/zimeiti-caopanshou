#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyLocalBuildFingerprintReceipt } from './local-build-fingerprint.mjs';

const THEMES = [
  { id: 'lattice', mode: 'dark', primary: '#6ee7e0' },
  { id: 'crystal-aurora', mode: 'dark', primary: '#54e3d2' },
  { id: 'soft-white', mode: 'light', primary: '#17675a' },
];
const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const PAGES = [
  { path: '/voice-studio/workspace', label: '语音合成' },
  { path: '/voice-studio/imitate', label: '音色模仿' },
  { path: '/voice-studio/voices', label: '音色管理' },
];
const PROVIDER_RISK_ENDPOINTS = new Set([
  'POST /api/extract',
  'POST /api/voice/preview',
  'POST /api/voice/tts',
]);
const TELEMETRY_ENDPOINTS = new Set([
  'POST /api/operation-events',
  'POST /api/product-usage/events',
]);

const read = (file) => fs.readFile(path.resolve(file), 'utf8');
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function parseColor(value) {
  const input = String(value || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(input)) return [1, 3, 5].map((offset) => Number.parseInt(input.slice(offset, offset + 2), 16));
  const match = input.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/u);
  return match ? match.slice(1, 4).map(Number) : null;
}
function contrastRatio(foreground, background) {
  const luminance = (color) => {
    const values = color.map((channel) => channel / 255).map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
  };
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

async function waitForCondition(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function verifySources() {
  const [header, css, selector, workspace, imitate, voices, extraction, runtimeGate] = await Promise.all([
    read('src/components/vs/Header.tsx'),
    read('src/app/voice-studio/voice-studio.css'),
    read('src/components/vs/ReferenceAudioSelector.tsx'),
    read('src/app/voice-studio/workspace/page.tsx'),
    read('src/app/voice-studio/imitate/page.tsx'),
    read('src/app/voice-studio/voices/page.tsx'),
    read('src/lib/vs/reference-audio-extraction.ts'),
    read('src/components/vs/ReferenceAudioExtractionGate.tsx'),
  ]);
  for (const label of PAGES.map((entry) => entry.label)) {
    assert.match(label, /^\p{Script=Han}{4}$/u);
    assert.ok(header.includes(`label: '${label}'`), `missing four-character navigation label ${label}`);
  }
  assert.ok(header.includes('<UserThemeSwitcher />'), 'voice header does not expose the platform theme switcher');
  assert.ok(css.includes('html[data-theme="lattice"][data-mode="dark"] .voice-studio-root'));
  assert.ok(css.includes('--vs-primary: #68c7b4;'));
  assert.ok(css.includes('html[data-theme="soft-white"][data-mode="light"] .voice-studio-root'));
  assert.ok(css.includes('--vs-primary: #17675a;'));
  assert.ok(css.includes('html[data-theme="crystal-aurora"][data-mode="dark"] .voice-studio-root'));
  assert.ok(css.includes('--vs-primary: #54e3d2;'));
  assert.ok(!css.includes('data-theme="stellar-blue"'));
  assert.ok(!css.includes('html[data-theme="soft-white"][data-mode="dark"]'));
  assert.ok(!css.includes('html[data-theme="crystal-aurora"][data-mode="light"]'));
  assert.ok(runtimeGate.includes('useToolRuntimeCatalog(token)'));
  assert.ok(runtimeGate.includes('取消不会提交请求或产生扣费'));
  assert.ok(selector.includes('disabled={extracting || !linkUrl.trim() || !runtimeGate.ready}'));
  assert.ok(workspace.includes('disabled={extractingAudio || !referenceAudioGate.ready || !audioGenLinkInput.trim()}'));
  assert.ok(extraction.includes("fetch('/api/extract'"));
  assert.ok(extraction.includes("fetch('/api/voice/link-clone/extract-audio'"));
  assert.ok(imitate.includes('重新确认原任务'));
  assert.ok(voices.includes('aria-pressed'));
  return { passed: true, providerCalls: 0, paidRequests: 0, databaseMutations: 0 };
}

function voiceFixture() {
  return [
    { id: 'zh_female_fixture', speakerId: 'zh_female_fixture', name: '清晰女声', description: '自然清晰的中文音色', category: '模拟真人', tags: ['自然'], styleTags: ['自然'], gender: 'female', engine: 'volcano', language: 'zh', isActive: true, isRecommended: true },
    { id: 'zh_male_fixture', speakerId: 'zh_male_fixture', name: '沉稳男声', description: '沉稳有力的中文音色', category: '短视频配音', tags: ['沉稳'], styleTags: ['沉稳'], gender: 'male', engine: 'volcano', language: 'zh', isActive: true },
  ];
}

async function installFixtures(context, state, theme, token, identity) {
  const favoriteFixtures = new Map();
  await context.addInitScript(({ selectedTheme, authToken, user }) => {
    localStorage.setItem('app_theme', selectedTheme);
    localStorage.setItem('user_theme_preference', selectedTheme);
    localStorage.setItem('auth_token', authToken);
    localStorage.setItem('auth_user', JSON.stringify(user));
    sessionStorage.setItem('entered_app', '1');
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value() { this.dispatchEvent(new Event('play')); return Promise.resolve(); } });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value() { this.dispatchEvent(new Event('pause')); } });
  }, { selectedTheme: theme.id, authToken: token, user: identity });
  await context.addCookies([{ name: 'auth_token', value: token, url: state.origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== state.origin) {
      if (/(?:volcengine|byteplus|coze|douyin|xiaohongshu|seedance)/iu.test(url.hostname)) {
        state.unfixtureProviderRiskRequests.push(`${method} ${url.origin}${url.pathname}`);
      }
      state.blockedExternal.push({ method, url: `${url.origin}${url.pathname}` });
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    const requestSignature = `${method} ${url.pathname}`;
    const providerRisk = PROVIDER_RISK_ENDPOINTS.has(requestSignature);
    if (providerRisk) state.providerRiskRequests.push(requestSignature);
    if (TELEMETRY_ENDPOINTS.has(requestSignature)) {
      state.mockedTelemetryPosts.push(requestSignature);
      return json(route, { success: true, accepted: true });
    }
    if (url.pathname === '/api/auth/me') return json(route, { user: { ...identity, themePreference: theme.id, theme_preference: theme.id } });
    if (url.pathname === '/api/tools/runtime-catalog') return json(route, { items: { video: { available: true, service: 'fixture-video-extract', provider: 'fixture', model: 'fixture', unitPrice: 0.02, currency: 'CNY', unit: '条' } } });
    if (url.pathname === '/api/voice/pricing') return json(route, { success: true, data: [{ modelId: 'seed-tts-2.0' }, { modelId: 'seed-tts-1.0' }, { modelId: 'seed-audio-1.0' }] });
    if (url.pathname === '/api/voice/list') return json(route, { success: true, data: { voices: voiceFixture(), total: voiceFixture().length } });
    if (url.pathname === '/api/voice/user-voices' && method === 'GET') return json(route, { success: true, voices: [] });
    if (url.pathname === '/api/voice/favorites' && method === 'GET') {
      return json(route, { success: true, favorites: [...favoriteFixtures.values()] });
    }
    if (url.pathname === '/api/voice/favorites' && ['POST', 'DELETE'].includes(method)) {
      state.mockedMutations.push(`${method} ${url.pathname}`);
      if (method === 'POST') {
        const body = request.postDataJSON?.() || {};
        favoriteFixtures.set(String(body.voice_id || ''), {
          voice_id: String(body.voice_id || ''),
          voice_name: String(body.voice_name || ''),
          engine: String(body.engine || 'volcano'),
          gender: String(body.gender || ''),
          language: String(body.language || ''),
        });
      } else {
        favoriteFixtures.delete(String(url.searchParams.get('voice_id') || ''));
      }
      return json(route, { success: true });
    }
    if (url.pathname === '/api/voice/history') return json(route, { success: true, data: { items: [], total: 0, page: 1, pageSize: 20 } });
    if (url.pathname === '/api/voice/status') return json(route, { success: true, data: { provider: 'volcano', available: true, canSubmit: true, upstreamChecked: false, generationVerified: false, upstreamCalls: 0, creditsCharged: 0 } });
    if (url.pathname === '/api/voice/imitation-quote') return json(route, { success: true, data: { reserveCredits: 2, unitPrice: 0.02 } });
    if (url.pathname === '/api/voice/upload' && method === 'GET') return json(route, { success: true, voices: [] });
    if (url.pathname === '/api/voice/upload' && method === 'POST') {
      state.mockedMutations.push(`${method} ${url.pathname}`);
      return json(route, { success: true, voice: { id: 'custom_11111111-1111-4111-8111-111111111111', url: state.audioDataUrl, name: '上传夹具', size: 48, format: 'wav', duration: 15, createdAt: new Date(0).toISOString(), gender: 'female', source: 'upload' } });
    }
    if (url.pathname === '/api/voice/upload' && method === 'PUT') {
      state.mockedMutations.push(`${method} ${url.pathname}`);
      return json(route, { success: true, voice: { id: 'custom_22222222-2222-4222-8222-222222222222', url: state.audioDataUrl, name: '链接夹具', size: 48, format: 'wav', duration: 15, createdAt: new Date(0).toISOString(), gender: 'female', source: 'link-extracted' } });
    }
    if (url.pathname === '/api/extract' && method === 'POST') {
      state.providerRiskFixtures.push(`${method} ${url.pathname}`);
      state.mockedMutations.push(`${method} ${url.pathname}`);
      state.extractPosts += 1;
      const temporaryExpiresAt = Date.now() + 30 * 60 * 1000;
      const temporaryUrl = `/api/extract/local-video?file=${'a'.repeat(24)}&owner=fixture-user&expires=${temporaryExpiresAt}&sig=${'b'.repeat(64)}`;
      return json(route, { success: true, videos: [{
        success: true,
        title: '链接夹具',
        platform: 'douyin',
        temporary_url: temporaryUrl,
        temporary_expires_at: temporaryExpiresAt,
      }] });
    }
    if (url.pathname === '/api/voice/link-clone/extract-audio' && method === 'POST') {
      state.mockedMutations.push(`${method} ${url.pathname}`);
      state.audioExtractPosts += 1;
      return json(route, { success: true, data: { duration: 15, platform: 'douyin', voice: { id: 'custom_22222222-2222-4222-8222-222222222222', url: state.audioDataUrl, name: '链接夹具', size: 48, format: 'wav', duration: 15, createdAt: new Date(0).toISOString(), gender: 'female', source: 'link-extracted' } } });
    }
    if (url.pathname === '/api/voice/preview' && method === 'POST') {
      state.providerRiskFixtures.push(`${method} ${url.pathname}`);
      state.mockedMutations.push(`${method} ${url.pathname}`);
      state.previewPosts += 1;
      return json(route, { success: true, data: { audioUrl: state.audioDataUrl, text: '试听夹具', cached: false, providerCalls: 0, creditsCharged: 0 } });
    }
    if (url.pathname === '/api/voice/tts' && method === 'POST') {
      state.providerRiskFixtures.push(`${method} ${url.pathname}`);
      state.mockedMutations.push(`${method} ${url.pathname}`);
      const body = request.postDataJSON?.() || {};
      if (body.operation === 'quote') return json(route, { success: true, data: { quoteOnly: true, modelId: body.model || 'seed-tts-2.0', charCount: 1, quotedCredits: 1, retailPrice: 0.01 } });
      state.fixtureGenerationPosts += 1;
      return json(route, { success: false, message: 'LIVE_FIXTURE_BLOCKED_GENERATION', data: { upstreamSubmitted: false, creditsCharged: 0 } }, 409);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (providerRisk) state.unfixtureProviderRiskRequests.push(requestSignature);
      state.unmockedMutations.push(`${method} ${url.pathname}`);
      return json(route, { success: false, error: 'LIVE_FIXTURE_UNMOCKED_MUTATION' }, 418);
    }
    return route.continue();
  });
}

async function inspectPage(page, expected, theme) {
  await page.locator('.voice-studio-root').first().waitFor({ state: 'visible', timeout: 30_000 });
  const nav = page.getByRole('navigation', { name: '智音工坊功能导航' });
  await nav.waitFor({ state: 'visible' });
  for (const entry of PAGES) await nav.getByRole('link', { name: entry.label }).waitFor({ state: 'visible' });
  await nav.getByRole('link', { name: expected.label }).getAttribute('aria-current').then((value) => assert.equal(value, 'page'));
  await page.locator('[data-theme-switcher-trigger="true"]').waitFor({ state: 'visible' });
  const metrics = await page.evaluate(() => {
    const root = document.querySelector('.voice-studio-root');
    const description = document.querySelector('.vs-page-description');
    if (!(root instanceof HTMLElement) || !(description instanceof HTMLElement)) throw new Error('VOICE_PAGE_ANCHOR_MISSING');
    const rootStyle = getComputedStyle(root);
    const descriptionStyle = getComputedStyle(description);
    return {
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      primary: rootStyle.getPropertyValue('--vs-primary').trim().toLowerCase(),
      foreground: rootStyle.getPropertyValue('--vs-text').trim(),
      background: rootStyle.getPropertyValue('--vs-bg').trim(),
      bodyFontSize: Number.parseFloat(descriptionStyle.fontSize),
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      documentHeight: document.documentElement.scrollHeight,
    };
  });
  assert.deepEqual({ theme: metrics.theme, mode: metrics.mode }, { theme: theme.id, mode: theme.mode });
  assert.equal(metrics.primary, theme.primary);
  assert.ok(metrics.bodyFontSize >= 14, `body font too small: ${metrics.bodyFontSize}`);
  assert.ok(metrics.horizontalOverflow <= 1, `horizontal overflow: ${metrics.horizontalOverflow}`);
  const fg = parseColor(metrics.foreground), bg = parseColor(metrics.background);
  assert.ok(fg && bg && contrastRatio(fg, bg) >= 4.5, `body contrast below 4.5:1 (${metrics.foreground} / ${metrics.background})`);
  return metrics;
}

async function exerciseButtons(page, state) {
  await page.goto(`${state.origin}/voice-studio/workspace`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('.voice-studio-root').first().waitFor({ state: 'visible' });
  const modes = page.getByRole('button', { name: /单人模式|双人对话/u });
  if (await modes.count() >= 2) {
    await page.getByRole('button', { name: /双人对话/u }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('双人对话') && button.getAttribute('aria-pressed') === 'true'));
    assert.equal(await page.getByRole('button', { name: /双人对话/u }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: /单人模式/u }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('单人模式') && button.getAttribute('aria-pressed') === 'true'));
  }

  await page.goto(`${state.origin}/voice-studio/imitate`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('.voice-studio-root').first().waitFor({ state: 'visible' });
  const generate = page.getByRole('button', { name: /请先输入文案|生成音频/u });
  await generate.waitFor({ state: 'visible' });
  assert.equal(await generate.isDisabled(), true, 'generation should be visibly disabled before required input');
  await page.getByRole('button', { name: /选择第一条参考音频/u }).click();
  await page.getByPlaceholder('粘贴抖音/小红书分享链接...').fill('https://v.douyin.com/fixture');
  const extract = page.getByRole('button', { name: '提取', exact: true });
  await extract.click();
  await page.getByTestId('reference-audio-charge-confirm').waitFor({ state: 'visible' });
  const beforeCancel = state.extractPosts;
  await page.getByTestId('reference-audio-charge-confirm')
    .getByRole('button', { name: '取消', exact: true })
    .click();
  assert.equal(state.extractPosts, beforeCancel, 'cancelled extraction submitted a paid request');
  await extract.click();
  await page.getByRole('button', { name: /确认并支付/u }).click();
  await page.getByRole('heading', { name: '确认参考音频' }).waitFor({ state: 'visible' });
  assert.equal(state.extractPosts, beforeCancel + 1);
  assert.ok(state.audioExtractPosts >= 1);
  await page.getByRole('button', { name: '确认并选用' }).click();
  await page.getByText('链接夹具', { exact: true }).first().waitFor({ state: 'visible' });

  await page.getByRole('button', { name: /添加第 2 条参考音频/u }).click();
  await page.getByRole('button', { name: '上传音频', exact: true }).click();
  const uploadInput = page.locator('input[type="file"]').last();
  await uploadInput.setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF0000WAVEfmt ') });
  await page.getByText('fixture.wav', { exact: true }).first().waitFor({ state: 'visible' });

  await page.goto(`${state.origin}/voice-studio/voices`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('.voice-studio-root').first().waitFor({ state: 'visible' });
  const favorite = page.getByRole('button', { name: /收藏 清晰女声/u }).first();
  await favorite.click();
  await page.waitForFunction(() => document.querySelector(
    'button[aria-label="取消收藏 清晰女声"][aria-pressed="true"]',
  ) !== null);
  const favorited = page.getByRole('button', { name: '取消收藏 清晰女声', exact: true }).first();
  assert.equal(await favorited.getAttribute('aria-pressed'), 'true');
  const preview = page.getByRole('button', { name: /试听 清晰女声/u }).first();
  const beforePreview = state.previewPosts;
  await preview.click();
  await page.getByRole('button', { name: '停止试听 清晰女声', exact: true }).first().waitFor({ state: 'visible' });
  await waitForCondition(() => state.previewPosts === beforePreview + 1, 'preview fixture request was not observed');
  assert.equal(state.previewPosts, beforePreview + 1, 'preview fixture was not exercised exactly once');
}

export async function main(args = process.argv.slice(2)) {
  const sourceOnly = args.includes('--source-only');
  const live = args.includes('--live');
  const source = await verifySources();
  if (sourceOnly || !live) {
    console.log(JSON.stringify({ verifier: 'voice-studio-unified-live', sourceOnly: true, ...source, themes: THEMES, viewports: VIEWPORTS, pages: PAGES }, null, 2));
    return;
  }
  const originArg = args.find((value) => value.startsWith('--origin='));
  const origin = String(originArg?.slice('--origin='.length) || process.env.LOCAL_NAV_ORIGIN || '').replace(/\/+$/u, '');
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, 'local origin required');
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
  const localBuild = verifyLocalBuildFingerprintReceipt(process.cwd(), '.next/local-source-fingerprint.v1.json');
  const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(20_000) });
  assert.ok(versionResponse.ok, `local version unavailable: ${versionResponse.status}`);
  const version = await versionResponse.json();
  assert.equal(version.buildId, localBuild.buildId, 'served runtime is not the current local build');
  const identityResponse = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  assert.ok(identityResponse.ok, `local identity unavailable: ${identityResponse.status}`);
  const payload = await identityResponse.json();
  const identity = { ...(payload.user || {}), id: String(payload.user?.id || ''), role: payload.user?.role || 'admin' };
  assert.ok(identity.id);

  const state = {
    origin,
    audioDataUrl: `data:audio/wav;base64,${Buffer.from('RIFF0000WAVEfmt ').toString('base64')}`,
    blockedExternal: [], mockedMutations: [], mockedTelemetryPosts: [], unmockedMutations: [],
    providerRiskRequests: [], providerRiskFixtures: [], unfixtureProviderRiskRequests: [],
    extractPosts: 0, audioExtractPosts: 0, previewPosts: 0, fixtureGenerationPosts: 0,
  };
  const outputDir = path.resolve('.codex-evidence/voice-studio-unified-20260927');
  await fs.mkdir(outputDir, { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const pages = [];
  const pageErrors = [];
  const consoleErrors = [];
  try {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({ viewport, serviceWorkers: 'block', colorScheme: theme.mode });
        await installFixtures(context, state, theme, token, identity);
        for (const expected of PAGES) {
          const page = await context.newPage();
          const id = `${theme.id}-${viewport.name}-${expected.label}`;
          page.on('pageerror', (error) => pageErrors.push({ id, message: error.message }));
          page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('ERR_BLOCKED_BY_CLIENT')) consoleErrors.push({ id, message: message.text() }); });
          const response = await page.goto(`${origin}${expected.path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          assert.equal(response?.status(), 200, `${id} HTTP ${response?.status()}`);
          const metrics = await inspectPage(page, expected, theme);
          await page.screenshot({ path: path.join(outputDir, `${id}.png`), fullPage: true });
          pages.push({ id, path: expected.path, theme: theme.id, viewport, ...metrics });
          await page.close();
        }
        const interactionPage = await context.newPage();
        await exerciseButtons(interactionPage, state);
        await interactionPage.close();
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(state.unmockedMutations, [], `unmocked mutations: ${state.unmockedMutations.join(', ')}`);
  assert.equal(state.fixtureGenerationPosts, 0, 'live verifier submitted a generation request');
  assert.deepEqual(state.unfixtureProviderRiskRequests, [], `provider-risk request escaped fixtures: ${state.unfixtureProviderRiskRequests.join(', ')}`);
  assert.equal(state.providerRiskRequests.length, state.providerRiskFixtures.length, 'not every provider-risk API request was intercepted by a fixture');
  const providerCalls = state.unfixtureProviderRiskRequests.length;
  assert.equal(providerCalls, 0);
  assert.ok(state.providerRiskFixtures.length >= THEMES.length * VIEWPORTS.length * 2, 'provider-risk buttons were not exercised through fixtures across the matrix');
  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${JSON.stringify(consoleErrors)}`);
  const report = {
    verifier: 'voice-studio-unified-live', passed: true,
    runningLatest: true, buildId: localBuild.buildId,
    pages, interactions: { linkChargeCancelZeroPosts: true, linkTwoStageFixture: true, uploadFixture: true, previewFixture: true, favoriteFeedback: true, generationDisabledFeedback: true },
    providerCalls, paidRequests: 0, databaseMutations: 0,
    providerRiskFixtures: state.providerRiskFixtures,
    mockedMutations: state.mockedMutations, mockedTelemetryPosts: state.mockedTelemetryPosts.length,
    blockedExternalRequests: state.blockedExternal.length,
  };
  await fs.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
