import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  PublishingActionSchema, PublishingCenterSchema, PublishingMutationResponseSchema,
  PublishingRecoverySchema, PUBLISHING_DEFAULT_PUBLIC_CONFIG,
} from '../src/lib/publishing-contract.ts';

/**
 * Playwright real-page regression with explicit in-memory API/plugin substitutes.
 * Every publishing API request is fulfilled or aborted locally. No real mutation,
 * platform publication, credential read, browser launch or filesystem write occurs.
 */
export async function verifyPublishingUiMock({ browser, origin, token, user, check }) {
  assert.equal(origin, 'http://127.0.0.1:5000');
  assert.ok(browser && typeof browser.newContext === 'function', 'Playwright browser required');
  assert.ok(typeof token === 'string' && user?.id, 'existing local fixture identity required');
  const checks = [];
  const verify = (name, condition, detail) => {
    const entry = { name: `MOCK publishing UI: ${name}`, passed: Boolean(condition), ...(detail ? { detail } : {}) };
    checks.push(entry);
    if (check) check(entry.name, entry.passed, detail);
    assert.ok(condition, entry.name);
  };
  const cases = [];
  const pendingKey = `publishing.pending-execution.v1:user:${encodeURIComponent(user.id)}`;
  // Same cursor algorithm as the announcement inbox for an empty collection.
  const emptyInboxCursor = `ann_${createHash('sha256').update('').digest('base64url').slice(0, 32)}`;

  async function scenario(mode) {
    const ids = Object.fromEntries(['draft', 'account', 'entitlement', 'purchase', 'plan', 'task'].map(key => [key, randomUUID()]));
    const stamp = new Date().toISOString();
    const counts = { claims: 0, lookups: 0, pluginPublishes: 0, pluginLogins: 0, reports: 0, draftSaves: 0, apiGets: 0, announcementInboxStubs: 0, popupPushStubs: 0, blockedExternalRequests: 0, blockedOtherWrites: 0, realMutations: 0, secretLeaks: 0, invalidPayloads: 0, directFiles: true };
    const fixture = PublishingCenterSchema.parse({
      config: { ...PUBLISHING_DEFAULT_PUBLIC_CONFIG, executionEnabled: true, salesEnabled: false, announcement: '[MOCK] 发布验收替身；没有真实执行权限。' },
      plans: [], purchases: [], accounts: [], drafts: [], tasks: [], walletCash: 0, schemaReady: true,
      access: { allowed: true, code: 'MOCK_ALLOWED', message: '[MOCK] 仅页面回归' },
      entitlements: [{ id: ids.entitlement, purchaseId: ids.purchase, planId: ids.plan, planVersion: 1, planName: '[MOCK] 合成额度', quota: 5, used: 0, expiresAt: new Date(Date.now() + 86400000).toISOString(), platforms: mode === 'douyin-limits' ? ['douyin'] : ['xhs'] }],
    });
    let originalClaimKey = null;
    let task = null;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const pageErrors = [];
    try {
      await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      await context.exposeBinding('__publishingUiMockEvent', (_source, event) => {
        if (event?.kind === 'publish') { counts.pluginPublishes++; if (event.directFiles !== true) counts.directFiles = false; }
        if (event?.kind === 'login') counts.pluginLogins++;
      });
      await context.addInitScript(({ authToken, authUser, storageKey, damaged }) => {
        localStorage.setItem('auth_token', authToken);
        localStorage.setItem('auth_user', JSON.stringify(authUser));
        sessionStorage.setItem('entered_app', '1');
        if (!sessionStorage.getItem('publishing-ui-mock-initialized')) {
          if (damaged) localStorage.setItem(storageKey, JSON.stringify('damaged-marker'));
          sessionStorage.setItem('publishing-ui-mock-initialized', '1');
        }
        // Generated only inside page memory; never printed, returned, or persisted.
        const syntheticCookie = `invalid-mock-cookie-${crypto.randomUUID()}`;
        window.__publishingUiMockHasSecretLeak = () => document.documentElement.outerHTML.includes(syntheticCookie)
          || Object.keys(localStorage).some(key => (localStorage.getItem(key) || '').includes(syntheticCookie))
          || Object.keys(sessionStorage).some(key => (sessionStorage.getItem(key) || '').includes(syntheticCookie));
        window.AIToEarnPlugin = {
          getVersion: async () => ({ version: '1.2.3' }),
          checkPermission: async () => ({ granted: true, hostAccess: true }),
          login: async platform => {
            await window.__publishingUiMockEvent({ kind: 'login' });
            return { type: platform, uid: 'mock-browser-account', account: 'mock-creator', nickname: '[MOCK] 合成账号', loginCookie: syntheticCookie, privateNested: { cookie: syntheticCookie } };
          },
          publish: async (params, onProgress) => {
            await window.__publishingUiMockEvent({ kind: 'publish', directFiles: params.video instanceof File && params.cover instanceof File });
            onProgress?.({ stage: 'complete', progress: 100, message: syntheticCookie, data: { loginCookie: syntheticCookie } });
            return { success: true, workId: 'mock_work_only', platformData: { loginCookie: syntheticCookie } };
          },
        };
      }, { authToken: token, authUser: user, storageKey: pendingKey, damaged: mode === 'damaged' });

      const fulfill = (route, payload, schema, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(schema ? schema.parse(payload) : payload), headers: { 'Cache-Control': 'no-store' } });
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) { counts.blockedExternalRequests++; return route.abort('blockedbyclient'); }
        if (url.pathname === '/api/auth/me' && request.method() === 'GET') return fulfill(route, { user: { ...user, isActive: true, credits: 0, allowedCategories: ['publish_center', 'marketplace', 'toolbox', 'cover', 'youcai'], themePreference: 'soft-white', themeModePreference: 'light', themePreferenceExpiresAt: new Date(Date.now() + 3600000).toISOString(), themePreferenceStatus: 'active' } });
        if (url.pathname === '/api/announcements/inbox' && request.method() === 'GET') {
          counts.announcementInboxStubs++;
          return fulfill(route, { announcements: [], cursor: emptyInboxCursor, serverTime: new Date().toISOString(), unchanged: url.searchParams.get('cursor') === emptyInboxCursor });
        }
        if (url.pathname === '/api/popup-pushes' && request.method() === 'GET') {
          counts.popupPushStubs++;
          return fulfill(route, { success: true, popups: [] });
        }
        if (url.pathname === '/api/publish-center') {
          if (request.method() === 'GET') {
            counts.apiGets++;
            if (url.searchParams.has('submissionKey')) {
              counts.lookups++;
              const found = url.searchParams.get('submissionKey') === originalClaimKey && Boolean(task);
              return fulfill(route, { schemaReady: true, found, task: found ? task : null, shouldExecute: false }, PublishingRecoverySchema);
            }
            return fulfill(route, fixture, PublishingCenterSchema);
          }
          if (request.method() !== 'POST') return route.abort('blockedbyclient');
          let action;
          try { action = PublishingActionSchema.parse(request.postDataJSON()); }
          catch { counts.invalidPayloads++; return fulfill(route, { error: '[MOCK] 请求不符合合同', code: 'PUBLISH_INPUT_INVALID' }, null, 400); }
          if (/loginCookie|privateNested|invalid-mock-cookie-/.test(request.postData() || '')) counts.secretLeaks++;
          if (action.action === 'save-draft') {
            counts.draftSaves++;
            const draft = { ...action.draft, id: action.id || ids.draft, revision: action.expectedRevision + 1, createdAt: stamp, updatedAt: new Date().toISOString() };
            fixture.drafts = [draft];
            return fulfill(route, { ok: true, draft }, PublishingMutationResponseSchema);
          }
          if (action.action === 'save-account') {
            const account = { ...action.account, id: ids.account, source: 'browser_reported', updatedAt: stamp };
            fixture.accounts = [account];
            return fulfill(route, { ok: true, account }, PublishingMutationResponseSchema);
          }
          if (action.action === 'claim') {
            counts.claims++;
            originalClaimKey = action.idempotencyKey;
            if (mode === 'rejection') return fulfill(route, { error: '[MOCK] 本次额度被拒绝，未产生执行许可。', code: 'PUBLISH_NO_QUOTA' }, null, 409);
            task = { id: ids.task, draftId: action.draftId, draftRevision: action.draftRevision, accountId: action.accountId, platform: 'xhs', status: 'awaiting_receipt', reportedSuccess: null, workId: null, shareLink: null, receiptSource: null, createdAt: stamp, updatedAt: stamp };
            fixture.tasks = [task]; fixture.entitlements[0].used = 1;
            if (mode === 'lost') return route.abort('connectionreset');
            if (mode === 'success') return fulfill(route, { ok: true, task, shouldExecute: true, alreadyFulfilled: false }, PublishingMutationResponseSchema);
            return fulfill(route, { error: '[MOCK] 损坏记录不可准入', code: 'PUBLISH_INPUT_INVALID' }, null, 400);
          }
          if (action.action === 'report' && mode === 'success' && task) {
            counts.reports++;
            task = { ...task, status: 'browser_reported', reportedSuccess: action.success, workId: action.workId || null, shareLink: action.shareLink || null, receiptSource: 'browser_reported', updatedAt: new Date().toISOString() };
            fixture.tasks = [task];
            return fulfill(route, { ok: true, task }, PublishingMutationResponseSchema);
          }
          return fulfill(route, { error: '[MOCK] 本用例不允许此动作', code: 'PUBLISH_INPUT_INVALID' }, null, 400);
        }
        if (!['GET', 'HEAD'].includes(request.method())) { counts.blockedOtherWrites++; return route.abort('blockedbyclient'); }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', () => pageErrors.push('pageerror'));
      await page.goto(`${origin}/publish-center`, { waitUntil: 'networkidle' });
      await page.locator('[data-publishing-workbench]').waitFor();
      await page.getByRole('heading', { name: '作品准备好，发布就从这里开始' }).waitFor();
      if (mode === 'damaged') {
        await page.getByRole('alert').filter({ hasText: '待核对记录已损坏' }).waitFor();
        verify('damaged marker has a concrete warning', true);
      }
      await page.locator('#publishing-title').fill(mode === 'douyin-limits' ? '长'.repeat(31) : `[MOCK] ${mode} 页面验收`);
      if (mode === 'douyin-limits') {
        await page.locator('#publishing-body').fill('文'.repeat(1001));
        await page.locator('button[aria-pressed]').filter({ hasText: '抖音' }).click();
      }
      await page.locator('#publishing-video-file').setInputFiles({ name: 'mock-final.mp4', mimeType: 'video/mp4', buffer: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]) });
      await page.locator('#publishing-cover-file').setInputFiles({ name: 'mock-cover.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=', 'base64') });
      await page.getByRole('button', { name: '读取账号', exact: true }).click();
      await page.getByLabel('确认使用此账号发布本次作品').check();
      const submit = page.getByRole('button', { name: '核对并发起发布', exact: true });
      if (mode === 'douyin-limits') {
        await page.locator('#publishing-title-limit').waitFor();
        await page.locator('#publishing-body-limit').waitFor();
        verify('switching to Douyin preserves overlong title and body', (await page.locator('#publishing-title').inputValue()).length === 31 && (await page.locator('#publishing-body').inputValue()).length === 1001);
        verify('Douyin inputs use verified platform limits', await page.locator('#publishing-title').getAttribute('maxlength') === '30' && await page.locator('#publishing-body').getAttribute('maxlength') === '1000');
        verify('Douyin overlong content blocks execution before claiming quota', await submit.isDisabled() && counts.claims === 0 && counts.pluginPublishes === 0);
        await page.locator('#publishing-title').fill('长'.repeat(30));
        await page.locator('#publishing-body').fill('文'.repeat(1000));
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '核对并发起发布' && !button.disabled));
        verify('Douyin exact boundary becomes ready without sending a claim', counts.claims === 0 && counts.pluginPublishes === 0);
      } else if (mode === 'damaged') {
        verify('damaged pending fails closed even with materials, account and quota ready', await submit.isDisabled());
        verify('damaged pending is preserved', await page.evaluate(key => localStorage.getItem(key) === JSON.stringify('damaged-marker'), pendingKey));
        verify('damaged pending sends neither claim nor plugin publish', counts.claims === 0 && counts.pluginPublishes === 0);
      } else {
        await submit.click();
        await page.getByRole('button', { name: '确认发起，消耗 1 次', exact: true }).click();
        if (mode === 'rejection') {
          await page.getByRole('alert').filter({ hasText: '[MOCK] 本次额度被拒绝' }).waitFor();
          verify('explicit 409 claim rejection clears only the first-attempt marker', await page.evaluate(key => localStorage.getItem(key) === null, pendingKey));
          verify('rejected claim never calls plugin publish', counts.claims === 1 && counts.pluginPublishes === 0 && counts.reports === 0);
        } else if (mode === 'lost') {
          await page.getByRole('alert').waitFor();
          await page.getByText('有一笔原提交需要核对', { exact: true }).waitFor();
          const beforeKey = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).claim.idempotencyKey, pendingKey);
          verify('lost claim response retains original pending marker and never publishes', Boolean(beforeKey) && counts.claims === 1 && counts.pluginPublishes === 0);
          await page.reload({ waitUntil: 'networkidle' });
          await page.getByText('有一笔原提交需要核对', { exact: true }).waitFor();
          await page.getByRole('button', { name: '刷新原任务', exact: true }).click();
          await page.getByText('已找到原提交，结果仍需核对。请检查平台作品；不会再次调用插件。', { exact: true }).waitFor();
          const recovered = await page.evaluate(({ key, original, taskId }) => {
            const marker = JSON.parse(localStorage.getItem(key));
            return marker?.claim?.idempotencyKey === original && marker.taskId === taskId;
          }, { key: pendingKey, original: beforeKey, taskId: ids.task });
          verify('reload recovery uses read-only lookup and preserves the same pending request', recovered && counts.lookups === 1);
          verify('lookup cannot issue a new claim or publish after reload', counts.claims === 1 && counts.pluginPublishes === 0 && counts.reports === 0);
          verify('unknown recovered execution remains blocked', await page.getByRole('button', { name: '核对并发起发布', exact: true }).isDisabled());
        } else {
          await page.getByText('浏览器报告已完成，平台结果待核对。请前往平台检查作品。', { exact: true }).waitFor();
          verify('explicit mock success calls one fake publish and one mock report', counts.claims === 1 && counts.pluginPublishes === 1 && counts.reports === 1 && counts.directFiles);
          verify('mock browser report is labeled pending platform verification', await page.getByText('浏览器报告已完成', { exact: true }).isVisible());
          verify('mock success clears completed local marker', await page.evaluate(key => localStorage.getItem(key) === null, pendingKey));
        }
      }
      const secretLeak = await page.evaluate(() => window.__publishingUiMockHasSecretLeak());
      verify(`${mode}: sensitive plugin fields do not enter UI, browser storage or API payload`, !secretLeak && counts.secretLeaks === 0);
      verify(`${mode}: only shared-contract publishing payloads were used`, counts.invalidPayloads === 0);
      verify(`${mode}: no real mutation or external publication occurred`, counts.realMutations === 0);
      verify(`${mode}: no uncaught page exceptions`, pageErrors.length === 0);
      cases.push({ mode, mock: true, counts });
    } finally { await context.close(); }
  }

  await scenario('rejection');
  await scenario('lost');
  await scenario('damaged');
  await scenario('douyin-limits');
  await scenario('success');
  const totals = {};
  for (const { counts } of cases) for (const [key, value] of Object.entries(counts)) if (typeof value === 'number') totals[key] = (totals[key] || 0) + value;
  return { mock: true, checks, cases, counts: totals, realMutations: 0, realPosts: 0, paidCalls: 0 };
}
