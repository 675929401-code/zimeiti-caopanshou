#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { SignJWT } from 'jose';
import { parse as parseDotenv } from 'dotenv';

const root = process.cwd();
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const outputDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, '.codex-evidence', `voice-history-retry-readonly-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const marker = 'CODEX_VOICE_HISTORY_RETRY_READONLY';
const fixtureId = 'codex-voice-history-refunded-readonly';
const unknownFixtureId = 'codex-voice-history-unknown-readonly';

const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8').replace(/^\uFEFF/u, ''));
const localEnvironment = parseDotenv(fs.readFileSync(path.join(root, '.env.local'), 'utf8'));
const supabaseOrigin = new URL(runtime.supabaseUrl).origin;
assert.equal(supabaseOrigin, 'http://127.0.0.1:54321', 'local Supabase is required');
const serviceHeaders = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };

async function countWalletOperations(userId) {
  const url = new URL('/rest/v1/wallet_operations', supabaseOrigin);
  url.searchParams.set('select', 'id');
  url.searchParams.set('user_id', `eq.${userId}`);
  const response = await fetch(url, {
    headers: { ...serviceHeaders, Prefer: 'count=exact', Range: '0-0' },
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, 'wallet operation count failed');
  return Number((response.headers.get('content-range') || '0/0').split('/')[1] || 0);
}

async function readUsers() {
  const url = new URL('/rest/v1/users', supabaseOrigin);
  url.searchParams.set('select', 'id,username,display_name,role,credits,is_active');
  url.searchParams.set('is_active', 'eq.true');
  url.searchParams.set('order', 'updated_at.desc');
  url.searchParams.set('limit', '200');
  const response = await fetch(url, { headers: serviceHeaders, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json();
  assert.ok(response.ok && Array.isArray(payload), 'active user read failed');
  return payload;
}

async function verifiedTokenFor(user) {
  const secrets = [...new Set([process.env.JWT_SECRET, runtime.jwtSecret, localEnvironment.JWT_SECRET]
    .map((value) => String(value || '').trim()).filter((value) => value.length >= 16))];
  for (const secret of secrets) {
    const token = await new SignJWT({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name || user.username,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(new TextEncoder().encode(secret));
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return token;
  }
  throw new Error('could not verify a local user token');
}

async function readHistoryTotal(token) {
  const response = await fetch(`${origin}/api/voice/history?page=1&pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  assert.ok(response.ok && payload?.success === true, 'voice history read failed');
  return Number(payload.data?.total || 0);
}

fs.mkdirSync(outputDir, { recursive: true });
const componentSource = fs.readFileSync(path.join(root, 'src/components/vs/VoiceGenerationHistory.tsx'), 'utf8');
const workspaceSource = fs.readFileSync(path.join(root, 'src/app/voice-studio/workspace/page.tsx'), 'utf8');
assert.ok(componentSource.includes("item.status === 'failed' && onRestore"));
assert.ok(componentSource.includes('载入后重试'));
const restoreStart = workspaceSource.indexOf('const restoreHistoryGeneration');
const submitStart = workspaceSource.indexOf('const submitVoiceRequest', restoreStart);
assert.ok(restoreStart > 0 && submitStart > restoreStart, 'history restore handler is missing');
const restoreSource = workspaceSource.slice(restoreStart, submitStart);
assert.equal(restoreSource.includes('fetch('), false, 'history restore must not call an endpoint directly');
assert.equal(restoreSource.includes('submitVoiceRequest('), false, 'history restore must not submit generation');

const users = await readUsers();
const localUser = users.find((user) => user.role === 'admin') || users[0];
assert.ok(localUser?.id, 'an active local user is required');
const token = await verifiedTokenFor(localUser);
const session = {
  token,
  user: {
    id: localUser.id,
    username: localUser.username,
    displayName: localUser.display_name || localUser.username,
    role: localUser.role,
    credits: Number(localUser.credits || 0),
    isActive: localUser.is_active === true,
    allowedCategories: null,
  },
};

const voiceResponse = await fetch(`${origin}/api/voice/list?page=1&limit=500`, { signal: AbortSignal.timeout(15_000) });
const voicePayload = await voiceResponse.json();
const voices = voicePayload?.data?.voices;
assert.ok(voiceResponse.ok && Array.isArray(voices) && voices.length > 0, 'voice catalog is required');
const voice = voices.find((item) => item?.speakerId && item?.name) || voices[0];

const before = {
  historyTotal: await readHistoryTotal(session.token),
  walletOperations: await countWalletOperations(session.user.id),
};
const report = {
  observedAt: new Date().toISOString(),
  origin,
  sourceChecks: {
    failedActionVisible: true,
    restoreHandlerContainsNoFetch: true,
    restoreHandlerContainsNoSubmit: true,
  },
  browser: {
    fixtureHistoryGets: 0,
    quoteRequests: 0,
    generationRequests: 0,
    blockedWrites: [],
    externalRequestsBlocked: 0,
    pageErrors: [],
  },
  state: { before, after: null },
  assertions: {},
  passed: false,
};

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  await context.addInitScript(({ token, user }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
    sessionStorage.setItem('entered_app', '1');
  }, { token: session.token, user: session.user });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      report.browser.externalRequestsBlocked += 1;
      await route.abort('blockedbyclient');
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/api/voice/history') {
      report.browser.fixtureHistoryGets += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            items: [{
              id: fixtureId,
              userId: session.user.id,
              voiceModelId: voice.id || voice.speakerId,
              voiceModelName: voice.name,
              inputText: marker,
              textLength: marker.length,
              outputFormat: 'wav',
              speedRatio: 8,
              emotion: 'happy',
              engine: voice.engine || 'volcano',
              cost: 0,
              status: 'failed',
              terminalState: 'refunded',
              billingState: 'not_charged',
              chargedCredits: 0,
              refundedCredits: 0,
              retryEligible: true,
              errorMessage: 'read-only refunded fixture',
              createdAt: '2026-09-15T00:00:00.000Z',
            }, {
              id: unknownFixtureId,
              userId: session.user.id,
              voiceModelId: voice.id || voice.speakerId,
              voiceModelName: voice.name,
              inputText: `${marker}_UNKNOWN`,
              textLength: `${marker}_UNKNOWN`.length,
              outputFormat: 'wav',
              speedRatio: 1,
              emotion: 'neutral',
              engine: voice.engine || 'volcano',
              cost: 0,
              status: 'failed',
              terminalState: 'failed_unknown',
              billingState: 'not_charged',
              chargedCredits: 0,
              refundedCredits: 0,
              retryEligible: false,
              retryUnavailableReason: '任务终态尚未确认，需先完成核对，暂不能重试',
              errorMessage: '任务终态尚未确认，请联系管理员核对',
              createdAt: '2026-09-15T00:01:00.000Z',
            }],
            total: 2,
            page: 1,
            pageSize: 5,
            totalPages: 1,
            stats: {},
          },
        }),
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/api/voice/tts') {
      const body = request.postDataJSON();
      if (body?.operation === 'quote') {
        report.browser.quoteRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { quoteOnly: true, quotedCredits: 1, retailPrice: 0.01, adminExempt: true, reservationSeconds: 0 },
          }),
        });
      } else {
        report.browser.generationRequests += 1;
        await route.abort('blockedbyclient');
      }
      return;
    }
    const diagnostic = request.method() === 'POST' && url.pathname === '/__nextjs_original-stack-frames';
    if (request.method() !== 'GET' && !diagnostic) {
      report.browser.blockedWrites.push({ method: request.method(), path: url.pathname });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (error) => report.browser.pageErrors.push(String(error.message || error)));
  const navigation = await page.goto(`${origin}/voice-studio/workspace`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert.ok(navigation?.ok(), 'voice workspace did not load');
  const historyButton = page.getByRole('button', { name: '生成历史', exact: true });
  await historyButton.waitFor({ state: 'visible' });
  await historyButton.click();
  const failedItem = page.locator(`[data-generation-id="${fixtureId}"]`);
  await failedItem.waitFor({ state: 'visible' });
  const retryButton = failedItem.getByRole('button', { name: '载入后重试', exact: true });
  const unknownItem = page.locator(`[data-generation-id="${unknownFixtureId}"]`);
  await unknownItem.waitFor({ state: 'visible' });
  const unknownRetryButton = unknownItem.getByRole('button', { name: '载入后重试', exact: true });
  const unknownText = await unknownItem.innerText();
  assert.equal(await unknownRetryButton.count(), 0, 'failed_unknown must not expose retry action');
  assert.match(unknownText, /待核对/u, 'failed_unknown must be labeled as awaiting reconciliation');
  await retryButton.click();

  const input = page.getByPlaceholder('输入要合成的文本内容...', { exact: true });
  await input.waitFor({ state: 'visible' });
  await page.locator('[data-history-restore-notice]').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  const selectedVoiceRow = page.getByRole('button', { name: `试听 ${voice.name}`, exact: true }).first().locator('xpath=..');
  const selectedVoiceClass = await selectedVoiceRow.getAttribute('class');
  const selectedValues = await page.locator('select').evaluateAll((elements) => elements.map((element) => element.value));
  const speedText = await page.getByText('语速', { exact: true }).first().locator('xpath=..').innerText();
  const notice = await page.locator('[data-history-restore-notice]').innerText();
  const inputValue = await input.inputValue();

  report.assertions = {
    failedRetryActionVisible: await retryButton.isVisible(),
    failedUnknownRetryBlocked: await unknownRetryButton.count() === 0,
    failedUnknownLabeledForReconciliation: unknownText.includes('待核对'),
    originalTextRestored: inputValue === marker,
    originalVoiceRestored: Boolean(selectedVoiceClass?.includes('shadow-[0_0_14px')),
    speedRestored: speedText.includes('+8'),
    formatRestored: selectedValues.includes('wav'),
    explicitSubmitRequired: report.browser.generationRequests === 0,
    quoteOnlyWasRead: report.browser.quoteRequests >= 1,
    noticeExplainsNewTask: notice.includes('本次会创建新任务'),
    pageErrorFree: report.browser.pageErrors.length === 0,
  };
  assert.ok(Object.values(report.assertions).every(Boolean), `browser assertions failed: ${JSON.stringify(report.assertions)}`);
  await page.screenshot({ path: path.join(outputDir, 'voice-history-failed-loaded-no-submit.png'), fullPage: true });
  await context.close();
} finally {
  if (browser) await browser.close();
}

const after = {
  historyTotal: await readHistoryTotal(session.token),
  walletOperations: await countWalletOperations(session.user.id),
};
report.state.after = after;
assert.deepEqual(after, before, 'read-only verification changed history or wallet state');
assert.equal(report.browser.generationRequests, 0, 'history retry submitted a generation request');
assert.equal(report.browser.blockedWrites.length, 0, 'unexpected write request was attempted');
report.passed = true;
fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
