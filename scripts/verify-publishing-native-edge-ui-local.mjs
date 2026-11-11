import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

// Explicit zero-network fixtures. This file never launches a browser or reads credentials.
// The owning task supplies its already validated browser and an in-memory fixture identity.
export async function verifyNativeEdgeUi({ browser, origin, token, user, directory, check }) {
  if (origin !== 'http://127.0.0.1:5000' || !browser || !token || !user?.id || typeof check !== 'function') throw new Error('Canonical origin, browser, in-memory fixture identity and assertion callback required');
  const output = path.resolve(directory); await fs.mkdir(output, { recursive: true });
  const report = { passed: false, fixtureOnly: true, realApiWrites: 0, realProviderCalls: 0, paidCalls: 0, checks: [], cases: [], screenshots: [], errors: [] };
  const privateValues = [token, user.username, user.displayName, user.display_name].filter(value => typeof value === 'string' && value.length > 1).sort((a, b) => b.length - a.length);
  const safe = input => { let value = String(input ?? ''); for (const item of privateValues) value = value.split(item).join('[redacted]'); return value.replace(/\b1[3-9]\d{9}\b/g, '[phone]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]'); };
  const verify = (name, passed) => { const item = { name, passed: Boolean(passed) }; report.checks.push(item); check(name, item.passed); if (!item.passed) throw new Error(name); };
  const stamp = new Date().toISOString(); const future = new Date(Date.now() + 3600000).toISOString();
  const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  const ids = { draft: id(1), a: id(2), b: id(3), wx: id(4), targetA: id(5), targetB: id(6), targetWx: id(7), batch: id(8), attemptA: id(9), attemptB: id(10), entitlement: id(11), plan: id(12), purchase: id(13), imageAsset: id(14) };
  const accounts = [
    { id: ids.a, platform: 'xhs', platformAccountId: 'edge-account-a', displayName: '边界账号 A', source: 'browser_reported', updatedAt: stamp },
    { id: ids.b, platform: 'xhs', platformAccountId: 'edge-account-b', displayName: '边界账号 B', source: 'browser_reported', updatedAt: stamp },
    { id: ids.wx, platform: 'wxSph', platformAccountId: 'edge-account-wx', displayName: '边界视频号', source: 'browser_reported', updatedAt: stamp },
  ];
  const target = (which, platform = 'xhs') => ({ id: which === 'A' ? ids.targetA : which === 'B' ? ids.targetB : ids.targetWx, accountId: which === 'A' ? ids.a : which === 'B' ? ids.b : ids.wx, platform, options: {}, scheduledAt: null });
  const localMedia = (value, role, fileName) => ({ id: id(value), role, fileName, size: 128, type: role === 'video' ? 'video/mp4' : 'image/png', lastModified: 1700000000000, width: 64, height: 64, ...(role === 'video' ? { duration: 1 } : {}), source: 'local_file', requiresReselection: true });
  const draft = (title, contentType, media, targets) => ({ id: ids.draft, revision: 1, payload: { schemaVersion: 2, collectionId: null, contentType, title, body: '只用于显式零网络界面验收', topics: ['边界验证'], media, targets }, archived: false, createdAt: stamp, updatedAt: stamp });
  const clone = value => JSON.parse(JSON.stringify(value));
  const png = makePng(64, 64);

  function stateFor(currentDraft = null) {
    return { draft: currentDraft, batches: [], attempts: [], events: [], history: [], failAsset: false, savedDraft: null, lastReport: null, currentAccount: 'B', pending: null, counters: { fixtureWrites: 0, saveDraft: 0, saveAccount: 0, createBatch: 0, claim: 0, report: 0, assetReads: 0, attemptLookups: 0, exactReportLookups: 0, blockedWrites: 0, externalBlocked: 0 }, claimedTargets: [] };
  }
  function batchFor(currentDraft) { return { id: ids.batch, draftId: currentDraft.id, draftVersion: currentDraft.revision, targetIds: currentDraft.payload.targets.map(item => item.id), accountSnapshots: currentDraft.payload.targets.map(item => { const account = accounts.find(value => value.id === item.accountId); return { id: account.id, platform: account.platform, platformAccountId: account.platformAccountId, displayName: account.displayName, updatedAt: account.updatedAt }; }), requestKey: `batch:${currentDraft.id}:${currentDraft.revision}:manual`, createdAt: stamp }; }
  function attemptFor(currentDraft, selectedTarget, attemptId = ids.attemptA) { const account = accounts.find(item => item.id === selectedTarget.accountId); return { id: attemptId, batchId: ids.batch, targetId: selectedTarget.id, entitlementId: ids.entitlement, platform: selectedTarget.platform, transport: 'browser_plugin', snapshot: { draft: clone(currentDraft.payload), draftId: currentDraft.id, draftVersion: currentDraft.revision, target: clone(selectedTarget), account: { id: account.id, platform: account.platform, platformAccountId: account.platformAccountId, displayName: account.displayName, updatedAt: account.updatedAt }, localSchedule: null, transport: 'browser_plugin' }, snapshotHash: 'a'.repeat(64), requestKey: `claim:${ids.batch}:${selectedTarget.id}`, createdAt: stamp }; }
  function eventFor(attemptId, value = 90) { return { id: id(value), attemptId, kind: 'browser_report', requestKey: `report:${attemptId}`, payload: { success: true }, source: 'browser_reported', createdAt: stamp }; }

  async function openCase(name, state, action) {
    const result = { name, passed: false, counters: state.counters, pluginMockCalls: 0 }; report.cases.push(result);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' }); let page;
    try {
      await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      await context.addInitScript(({ runtimeToken, runtimeUser, initialPending, currentAccount, identities }) => {
        localStorage.setItem('auth_token', runtimeToken); localStorage.setItem('auth_user', JSON.stringify(runtimeUser)); sessionStorage.setItem('entered_app', '1'); sessionStorage.setItem('trial_dialog_dismissed', '1');
        if (initialPending) localStorage.setItem(`publishing.pending-execution.v2:user:${encodeURIComponent(runtimeUser.id)}`, JSON.stringify(initialPending));
        window.__nativeEdgeFixture = { pluginCalls: 0, searchLocations: 0, searchActivities: 0, published: [] };
        const fixture = {
          getVersion: async () => ({ version: '3.3.11' }), checkPermission: async () => ({ granted: true, hostAccess: true }),
          login: async platform => { const account = platform === 'wxSph' ? identities[2] : identities[currentAccount === 'A' ? 0 : 1]; return { type: platform, uid: account.platformAccountId, account: account.platformAccountId, nickname: account.displayName, cookie: 'EXPLICIT_FIXTURE_PRIVATE_FIELD' }; },
          publish: async (params, onProgress) => { window.__nativeEdgeFixture.pluginCalls++; window.__nativeEdgeFixture.published.push({ platform: params.platform, names: params.type === 'image' ? params.images.map(file => file.name) : [params.video.name], type: params.type }); onProgress?.({ stage: 'upload', progress: 50, message: 'EXPLICIT_FIXTURE_PRIVATE_FIELD' }); return { success: true, workId: 'edge-work-b', shareLink: 'https://www.xiaohongshu.com/explore/edge-work-b', publishTime: Date.now(), errorCode: 'UNTRUSTED_CODE', platformData: { cookie: 'EXPLICIT_FIXTURE_PRIVATE_FIELD', unexpected: 'discard' }, cookie: 'EXPLICIT_FIXTURE_PRIVATE_FIELD' }; },
          wxSphSearchLocation: async () => { window.__nativeEdgeFixture.searchLocations++; return [{ poiId: 'edge-poi', poiName: '边界公园', poiCity: '测试城市', latitude: 31.2, longitude: 121.4, cookie: 'EXPLICIT_FIXTURE_PRIVATE_FIELD' }]; },
          wxSphSearchActivity: async () => { window.__nativeEdgeFixture.searchActivities++; return [{ eventTopicId: 'edge-event', eventName: '边界创作活动', eventAttendCount: 3, token: 'EXPLICIT_FIXTURE_PRIVATE_FIELD' }]; },
        };
        Object.defineProperty(window, 'AIToEarnPlugin', { value: fixture, writable: false, configurable: false });
      }, { runtimeToken: token, runtimeUser: user, initialPending: state.pending, currentAccount: state.currentAccount, identities: accounts });
      const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      await context.route('**/*', async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.origin !== origin) { state.counters.externalBlocked++; await route.abort('blockedbyclient'); return; }
        if (!['GET', 'HEAD'].includes(request.method())) {
          let body; try { body = request.postDataJSON(); } catch { state.counters.blockedWrites++; await route.abort('blockedbyclient'); return; }
          // Every allowed mutation below is fulfilled in memory. route.continue is NEVER used for writes.
          if (url.pathname === '/api/publish-center' && body?.action === 'save-account') { state.counters.fixtureWrites++; state.counters.saveAccount++; const found = accounts.find(item => item.platform === body.account.platform && item.platformAccountId === body.account.platformAccountId); await fulfill(route, found ? { ok: true, account: found } : { error: 'Fixture account unavailable' }, found ? 200 : 400); return; }
          if (url.pathname === '/api/publish-center/v2' && body?.action === 'save-draft') { state.counters.fixtureWrites++; state.counters.saveDraft++; state.savedDraft = clone(body.draft); state.draft = { id: body.id || ids.draft, revision: (body.expectedRevision || 0) + 1, payload: clone(body.draft), archived: false, createdAt: stamp, updatedAt: stamp }; await fulfill(route, { ok: true, draft: state.draft }); return; }
          if (url.pathname === '/api/publish-center/v2' && body?.action === 'create-batch') { state.counters.fixtureWrites++; state.counters.createBatch++; const batch = state.batches[0] || batchFor(state.draft); state.batches = [batch]; await fulfill(route, { ok: true, batch }); return; }
          if (url.pathname === '/api/publish-center/v2' && body?.action === 'claim') { state.counters.fixtureWrites++; state.counters.claim++; state.claimedTargets.push(body.targetId); const selected = state.draft.payload.targets.find(item => item.id === body.targetId); const existing = state.attempts.find(item => item.targetId === body.targetId); const attempt = existing || attemptFor(state.draft, selected, ids.attemptB); if (!existing) state.attempts.push(attempt); await fulfill(route, { ok: true, attempt, shouldExecute: !existing, alreadyFulfilled: Boolean(existing) }); return; }
          if (url.pathname === '/api/publish-center/v2' && body?.action === 'report') { state.counters.fixtureWrites++; state.counters.report++; state.lastReport = clone(body); const { action: _action, attemptId, idempotencyKey, ...payload } = body; const event = { id: id(91), attemptId, kind: 'browser_report', requestKey: idempotencyKey, payload, source: 'browser_reported', createdAt: stamp }; state.events.push(event); await fulfill(route, { ok: true, event }); return; }
          state.counters.blockedWrites++; await route.abort('blockedbyclient'); return;
        }
        if (url.pathname === '/api/auth/me') { await fulfill(route, { user: { ...user, themePreference: 'soft-white', themeModePreference: 'light', themePreferenceExpiresAt: future }, auth_projection: true }); return; }
        if (url.pathname === '/api/member-permissions') { await fulfill(route, { permission: { userId: user.id, role: user.role || 'student', featureNavigationKeys: ['marketplace', 'cover', 'publish_center', 'youcai'], agentNavigationKeys: [], revision: 1, checksum: 'b'.repeat(64), sourceProfileKey: null, sourceProfileVersion: null, updatedAt: stamp, updatedBy: null, reason: 'explicit readonly edge fixture', integrityValid: true, authorityStatus: 'ready' } }); return; }
        if (url.pathname === '/api/announcements/inbox') { await fulfill(route, { announcements: [], cursor: '', read_fixture: true }); return; }
        if (url.pathname === '/api/popup-pushes') { await fulfill(route, { success: true, popups: [], read_fixture: true }); return; }
        if (url.pathname === '/api/publish-center') { await fulfill(route, { config: { version: 1, mode: 'browser_plugin', executionEnabled: true, salesEnabled: false, cloudEnabled: false, enabledPlatforms: ['xhs', 'wxSph', 'douyin'], pluginUrl: null, announcement: '', usageNotice: '显式零网络验收夹具' }, plans: [], entitlements: [{ id: ids.entitlement, purchaseId: ids.purchase, planId: ids.plan, planVersion: 1, planName: '内存夹具额度', quota: 50, used: state.counters.claim, expiresAt: new Date(Date.now() + 86400000).toISOString(), platforms: ['xhs', 'wxSph'] }], purchases: [], accounts, drafts: [], tasks: [], walletCash: 0, schemaReady: true, access: { allowed: true, code: 'PUBLISH_ACCESS_READY', message: 'fixture' } }); return; }
        if (url.pathname === '/api/publish-center/v2') {
          const resource = url.searchParams.get('resource') || 'drafts'; let items = ({ drafts: state.draft ? [state.draft] : [], collections: [], groups: [], batches: state.batches, attempts: state.attempts, events: state.events, schedules: [], 'account-meta': [], versions: state.draft ? [{ draftId: state.draft.id, version: state.draft.revision, payload: state.draft.payload, createdAt: stamp }] : [] })[resource] || [];
          if (url.searchParams.has('requestKey')) { if (resource === 'attempts') state.counters.attemptLookups++; items = items.filter(item => item.requestKey === url.searchParams.get('requestKey')); }
          if (url.searchParams.has('attemptId')) items = items.filter(item => item.attemptId === url.searchParams.get('attemptId'));
          if (url.searchParams.has('eventKind')) { if (url.searchParams.get('eventKind') === 'browser_report') state.counters.exactReportLookups++; items = items.filter(item => item.kind === url.searchParams.get('eventKind')); }
          const pageNumber = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('pageSize') || 30), start = (pageNumber - 1) * size;
          await fulfill(route, { schemaReady: true, resource, page: pageNumber, pageSize: size, total: items.length, hasMore: start + size < items.length, items: items.slice(start, start + size) }); return;
        }
        if (url.pathname === '/api/media-history') { await fulfill(route, { items: state.history, pagination: { nextOffset: null, hasMore: false } }); return; }
        if (url.pathname === '/api/media-history/content') { state.counters.assetReads++; if (state.failAsset) await fulfill(route, { error: 'Fixture asset expired' }, 403); else await route.fulfill({ status: 200, contentType: 'image/png', body: png }); return; }
        if (url.pathname === '/api/publish-center/provider') { await fulfill(route, { schemaReady: true, provider: { configured: false, environment: 'domestic', routeExecutionEnabled: false, bindingRequired: true }, counts: null }); return; }
        if (url.pathname.startsWith('/api/')) { await fulfill(route, { items: [], agents: [], models: [], categories: [], conversations: [], messages: [], settings: {}, preferences: {}, announcements: [], popups: [] }); return; }
        await route.continue();
      });
      page = await context.newPage(); page.on('pageerror', error => report.errors.push({ case: name, message: safe(error.message).slice(0, 400) }));
      await page.goto(origin + '/publish-center?tab=compose', { waitUntil: 'domcontentloaded' }); await page.locator('[data-native-publishing="2"]').waitFor(); await page.getByText('浏览器执行已开放', { exact: true }).waitFor({ timeout: 30000 });
      const openDraft = async () => { await page.getByRole('button').filter({ hasText: state.draft.payload.title }).first().click(); await page.waitForFunction(title => document.querySelector('#publishing-title')?.value === title, state.draft.payload.title); };
      await action({ page, state, openDraft, context });
      result.pluginMockCalls = await page.evaluate(() => window.__nativeEdgeFixture.pluginCalls);
      const file = path.join(output, `edge-${name}.png`); await page.screenshot({ path: file, fullPage: true, mask: [page.locator('[data-testid="sidebar-user-menu-trigger"]'), ...privateValues.filter(value => value !== token).map(value => page.getByText(value, { exact: false })), page.getByText(/\b1[3-9]\d{9}\b/)] }); report.screenshots.push({ name, file });
      result.passed = true;
    } catch (error) {
      result.error = safe(error.message).slice(0, 600);
      if (page && !page.isClosed()) { await fs.writeFile(path.join(output, `edge-${name}-failure.txt`), safe(await page.locator('body').innerText().catch(() => '')).slice(0, 14000)); await page.screenshot({ path: path.join(output, `edge-${name}-failure.png`), fullPage: true, mask: [page.locator('[data-testid="sidebar-user-menu-trigger"]'), ...privateValues.filter(value => value !== token).map(value => page.getByText(value, { exact: false }))] }).catch(() => {}); }
    } finally { await context.close(); }
  }

  const advanced = stateFor(draft('边界参数草稿', 'video', [localMedia(20, 'video', 'clip-one.mp4'), localMedia(21, 'video', 'clip-two.mp4'), localMedia(22, 'cover', 'cover-one.png'), localMedia(23, 'cover', 'cover-two.png')], [target('A'), target('W', 'wxSph')]));
  await openCase('native-options', advanced, async ({ page, state, openDraft }) => {
    await openDraft(); await page.getByRole('button', { name: '各账号定制', exact: true }).click();
    // Label text includes helper text and native select option text; match the stable field prefix.
    await page.getByLabel(/^此账号成片/).nth(0).selectOption(id(21)); await page.getByLabel(/^此账号成片/).nth(1).selectOption(id(20)); await page.getByLabel(/^此账号封面/).nth(0).selectOption(id(23)); await page.getByLabel(/^此账号封面/).nth(1).selectOption(id(22));
    const xhs = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '小红书原生发布设置' }) }); await xhs.locator('summary').click(); await xhs.locator('select').selectOption('2');
    const wx = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '视频号原生发布设置' }) }); await wx.locator('summary').click(); await wx.getByLabel(/^声明原创内容/).check(); await wx.getByLabel(/^扩展链接/).fill('https://example.com/edge');
    await wx.getByPlaceholder('输入地点关键词').fill('公园'); await wx.getByRole('button', { name: '搜索', exact: true }).nth(0).click(); await wx.getByRole('button', { name: '边界公园 · 测试城市', exact: true }).click();
    await wx.getByPlaceholder('输入活动关键词').fill('创作'); await wx.getByRole('button', { name: '搜索', exact: true }).nth(1).click(); await wx.getByRole('button', { name: '边界创作活动', exact: true }).click();
    const scheduled = new Date(Date.now() + 7200000); const local = `${scheduled.getFullYear()}-${String(scheduled.getMonth() + 1).padStart(2, '0')}-${String(scheduled.getDate()).padStart(2, '0')}T${String(scheduled.getHours()).padStart(2, '0')}:${String(scheduled.getMinutes()).padStart(2, '0')}`; await wx.locator('input[type="datetime-local"]').fill(local);
    await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await page.waitForFunction(() => document.body.innerText.includes('内容、素材顺序与各账号设置已保存'));
    const [a, w] = state.savedDraft.targets; verify('edge native fields persist as strict per-target data', a.options.declaration === 2 && w.options.postFlag === 1 && w.options.poiInfo.poiId === 'edge-poi' && w.options.event.eventTopicId === 'edge-event' && w.options.extLink === 'https://example.com/edge' && Date.parse(w.scheduledAt) > Date.now());
    verify('edge targets keep independent video and cover identities', a.mediaIds[0] === id(21) && w.mediaIds[0] === id(20) && a.coverMediaId === id(23) && w.coverMediaId === id(22));
    verify('edge search projection drops raw credential-shaped fields', !JSON.stringify(state.savedDraft).includes('EXPLICIT_FIXTURE_PRIVATE_FIELD') && state.counters.claim === 0 && await page.evaluate(() => window.__nativeEdgeFixture.searchLocations === 1 && window.__nativeEdgeFixture.searchActivities === 1 && window.__nativeEdgeFixture.pluginCalls === 0));
  });

  await openCase('ordered-target-images', stateFor(draft('边界图片顺序', 'image', [localMedia(30, 'image', 'one.png'), localMedia(31, 'image', 'two.png'), localMedia(32, 'image', 'three.png')], [target('A')])), async ({ page, state, openDraft }) => {
    await openDraft(); await page.getByRole('button', { name: '各账号定制', exact: true }).click(); await page.getByRole('button', { name: '此账号图片 3 向前', exact: true }).click(); await page.getByRole('button', { name: '此账号图片 2 向前', exact: true }).click(); await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await page.waitForFunction(() => document.body.innerText.includes('内容、素材顺序与各账号设置已保存'));
    verify('edge per-target image order differs from shared asset pool', JSON.stringify(state.savedDraft.targets[0].mediaIds) === JSON.stringify([id(32), id(30), id(31)]) && state.savedDraft.media[0].id === id(30));
  });

  await openCase('native-limit-keeps-draft', stateFor(draft('边界标题限制', 'image', [localMedia(35, 'image', 'limit.png')], [target('A')])), async ({ page, state, openDraft }) => {
    await openDraft(); const longTitle = '原'.repeat(21); await page.locator('#publishing-title').fill(longTitle); await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await page.waitForFunction(() => document.body.innerText.includes('内容、素材顺序与各账号设置已保存'));
    verify('edge native title violation preserves full saved input and blocks quota claim', state.savedDraft.title === longTitle && (await page.locator('body').innerText()).includes('标题最多 20') && await page.getByRole('button', { name: '核对并发起发布', exact: true }).isDisabled() && state.counters.claim === 0 && await page.evaluate(() => window.__nativeEdgeFixture.pluginCalls === 0));
  });

  await openCase('main-assets-empty', stateFor(), async ({ page, state }) => { await page.getByRole('button', { name: '从主站作品选择', exact: true }).click(); await page.getByRole('dialog').getByRole('heading', { name: '当前还没有可读取的主站作品', exact: true }).waitFor(); verify('edge main asset empty state never fabricates media or dispatch', state.counters.assetReads === 0 && state.counters.fixtureWrites === 0 && await page.evaluate(() => window.__nativeEdgeFixture.pluginCalls === 0)); });
  const expired = stateFor(); expired.failAsset = true; expired.history = [{ id: 'edge-expired-image', kind: 'image', title: '边界已失效作品', status: 'completed', downloadPath: `/api/media-history/content?assetId=${ids.imageAsset}`, expiresAt: new Date(Date.now() - 1000).toISOString() }];
  await openCase('main-assets-expired', expired, async ({ page, state }) => { await page.getByRole('button', { name: '从主站作品选择', exact: true }).click(); await page.getByRole('dialog').getByRole('button').filter({ hasText: '边界已失效作品' }).click(); await page.locator('[role="alert"]').filter({ hasText: '作品素材已过期或当前账号不可读取' }).waitFor(); verify('edge expired asset is rejected without draft persistence or publish', state.counters.assetReads === 1 && state.counters.saveDraft === 0 && state.counters.claim === 0 && await page.evaluate(() => window.__nativeEdgeFixture.pluginCalls === 0)); });

  const recoveryDraft = draft('边界恢复草稿', 'image', [localMedia(40, 'image', 'pending.png')], [target('A')]);
  const unknown = stateFor(recoveryDraft); unknown.batches = [batchFor(recoveryDraft)]; unknown.attempts = [attemptFor(recoveryDraft, recoveryDraft.payload.targets[0])]; unknown.pending = { action: { action: 'claim', batchId: ids.batch, targetId: ids.targetA, entitlementId: ids.entitlement, idempotencyKey: unknown.attempts[0].requestKey }, attemptId: ids.attemptA };
  await openCase('unknown-readonly-recovery', unknown, async ({ page, state }) => { await page.getByRole('button', { name: '核对原提交', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已找到原执行，结果仍待平台核对' }).waitFor(); const retained = await page.evaluate(ownerId => localStorage.getItem(`publishing.pending-execution.v2:user:${encodeURIComponent(ownerId)}`) !== null, user.id); verify('edge unknown recovery performs exact readonly lookup and preserves pending', retained && state.counters.attemptLookups >= 1 && state.counters.exactReportLookups >= 1 && state.counters.claim === 0 && state.counters.report === 0 && await page.evaluate(() => window.__nativeEdgeFixture.pluginCalls === 0)); });
  const reported = stateFor(recoveryDraft); reported.batches = [batchFor(recoveryDraft)]; reported.attempts = [attemptFor(recoveryDraft, recoveryDraft.payload.targets[0])]; reported.pending = clone(unknown.pending); reported.events = [...Array.from({ length: 120 }, (_, index) => ({ id: id(1000 + index), attemptId: ids.attemptA, kind: 'append_link', requestKey: `append:edge:${index}`, payload: { shareLink: 'https://www.xiaohongshu.com/explore/edge' }, source: 'user_reported', createdAt: stamp })), eventFor(ids.attemptA)];
  await openCase('reported-recovery-beyond-page', reported, async ({ page, state }) => { await page.getByRole('button', { name: '核对原提交', exact: true }).click(); await page.getByRole('status').filter({ hasText: '原任务已有浏览器报告' }).waitFor(); const cleared = await page.evaluate(ownerId => localStorage.getItem(`publishing.pending-execution.v2:user:${encodeURIComponent(ownerId)}`) === null, user.id); verify('edge recovery finds browser report beyond 100 appended links without dispatch', cleared && state.counters.exactReportLookups >= 1 && state.counters.claim === 0 && state.counters.fixtureWrites === 0 && await page.evaluate(() => window.__nativeEdgeFixture.pluginCalls === 0)); });

  const mainImage = { ...localMedia(50, 'image', 'edge-main.png'), size: png.length, source: 'main_asset', requiresReselection: false, reference: { kind: 'image_asset', id: ids.imageAsset } };
  const continuationDraft = draft('边界同平台续发', 'image', [mainImage], [target('A'), target('B')]); const continuation = stateFor(continuationDraft); continuation.batches = [batchFor(continuationDraft)]; continuation.attempts = [attemptFor(continuationDraft, continuationDraft.payload.targets[0])]; continuation.events = [eventFor(ids.attemptA)];
  await openCase('account-b-continuation', continuation, async ({ page, state, openDraft }) => {
    await openDraft(); await page.getByRole('button', { name: '读取当前账号', exact: true }).nth(1).click(); await page.getByRole('status').filter({ hasText: '已读取当前浏览器账号' }).waitFor(); await page.getByLabel('确认当前浏览器使用此账号发布本次作品', { exact: true }).nth(1).check();
    const publish = page.getByRole('button', { name: '核对并发起发布', exact: true }); verify('edge completed A does not require A reconfirmation before B continuation', await publish.isEnabled()); await publish.click(); await page.getByRole('dialog', { name: '最后核对本次发布' }).getByRole('button', { name: /确认发起/ }).click(); await page.getByRole('status').filter({ hasText: '浏览器报告已保存' }).waitFor({ timeout: 30000 });
    const fixture = await page.evaluate(() => window.__nativeEdgeFixture); verify('edge continuation skips reported A and claims only B exactly once', state.counters.claim === 1 && state.claimedTargets[0] === ids.targetB && fixture.pluginCalls === 1 && fixture.published[0].names[0] === 'edge-main.png');
    verify('edge unchanged B probe preserves account CAS without save-account mutation', state.counters.saveAccount === 0 && state.counters.createBatch === 1 && state.counters.report === 1);
    const reportBody = state.lastReport; verify('edge browser report projects safe receipt fields and discards arbitrary raw data', reportBody.success === true && typeof reportBody.publishTime === 'string' && !('platformData' in reportBody) && !('errorCode' in reportBody) && !JSON.stringify(reportBody).includes('EXPLICIT_FIXTURE_PRIVATE_FIELD'));
    verify('edge mocked browser report remains labeled pending platform verification', await page.getByText(/不会自动重发或返还额度/).count() > 0 && reportBody.action === 'report');
  });

  report.passed = report.cases.every(item => item.passed) && report.checks.every(item => item.passed) && report.errors.length === 0;
  await fs.writeFile(path.join(output, 'native-edge-ui-report.json'), JSON.stringify(report, null, 2));
  return report;
}

function makePng(width, height) {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let index = 0; index < 8; index++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => { const kind = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc(Buffer.concat([kind, bytes]))); return Buffer.concat([size, kind, bytes, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * 4 + 1) + 1 + x * 4; rows[offset] = 223; rows[offset + 1] = 206; rows[offset + 2] = 170; rows[offset + 3] = 255; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
