import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

// The root task owns build/start and must supply a fresh root -CheckOnly proof.
// Invoke through with-local-admin-session.mjs. Identity stays in RAM. This
// verifier never reads credentials or the database, never fulfils a write, and
// never confirms publication. Read fixtures prove UI behavior only.
const API = '/api/native-operations';
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const accountIds = { xhs: uid(101), wxSph: uid(102), douyin: uid(103) };
const platformNames = { xhs: '小红书', wxSph: '视频号', douyin: '抖音', linkedin: 'LinkedIn', threads: 'Threads', instagram: 'Instagram', KWAI: '快手', pinterest: 'Pinterest', wxGzh: '微信公众号', bilibili: '哔哩哔哩', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok', twitter: 'X' };
Object.keys(platformNames).filter(key => !(key in accountIds)).forEach((key, index) => { accountIds[key] = uid(201 + index); });
const hash = value => createHash('sha256').update(value).digest('hex');
const runFile = promisify(execFile);
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const envelope = data => ({ code: 0, data, message: '' });
const forbiddenInitial = url => /\/(?:media-history|history\/(?:assets|logs|videos)|ai\/|agent\/|material\/|tasks)/u.test(url.pathname)
  || /\/(?:publishing|publish-center)\/v2$/u.test(url.pathname) && ['drafts', 'collections', 'versions'].includes(url.searchParams.get('resource'))
  || url.pathname === '/api/publish-center'
  || url.pathname.endsWith('/publishing/generic') && ['records', 'drafts', 'profile'].includes(url.searchParams.get('resource'))
  || url.pathname.endsWith('/studio/history')
  || /\/v2\/channels\/publish\/records/u.test(url.pathname);

export async function main(args = process.argv.slice(2)) {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || '').replace(/\/$/u, '');
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '');
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}');
  assert.equal(origin, 'http://127.0.0.1:5000', 'Exact F-drive local preview required');
  assert.ok(token && identity.user?.id, 'RAM identity from with-local-admin-session is required');
  const proofArg = args.find(value => value.startsWith('--runtime-proof='))?.slice('--runtime-proof='.length);
  assert.ok(proofArg, 'Supply --runtime-proof=<fresh root CheckOnly JSON>');
  const proofBytes = await fs.readFile(path.resolve(proofArg));
  const proof = JSON.parse(proofBytes.toString('utf8').replace(/^\uFEFF/u, ''));
  assert.equal(proof.runningLatest, true, 'Root proof must show runningLatest=true');
  assert.equal(proof.processMatchesSource, true, 'Runtime must belong to the formal source');
  assert.equal(proof.sourceFingerprintCurrent, true, 'Source fingerprint must be current');
  assert.equal(path.resolve(proof.source).toLowerCase(), process.cwd().toLowerCase(), 'Proof must bind the current formal checkout');
  assert.equal(proof.diskBuildId, proof.servedBuildId, 'Disk and served build IDs must agree');
  assert.equal((await fs.readFile('.next/BUILD_ID', 'utf8')).trim(), proof.diskBuildId, 'Build changed after root proof');
  assert.ok(Date.now() - Date.parse(proof.checkedAt) < 60 * 60 * 1000 && Date.now() >= Date.parse(proof.checkedAt) - 60_000, 'Root proof must be less than one hour old');

  const stamp = new Date().toISOString();
  const runId = stamp.replace(/[:.]/gu, '-');
  const output = path.resolve('.codex-evidence/publishing-studio-f76f3d79/qa', `browser-${runId}`);
  await fs.mkdir(output, { recursive: true });
  const privateValues = [token, ...Object.values(identity.user).filter(value => typeof value === 'string' && value.length > 2)].sort((a, b) => b.length - a.length);
  const safe = value => privateValues.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value ?? ''))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[token]').replace(/\b1[3-9]\d{9}\b/gu, '[phone]');
  const report = {
    schemaVersion: 'publishing-studio-portal-ui-readonly.v2', at: stamp, passed: false, viewport: { width: 1440, height: 900 }, browser: 'Microsoft Edge',
    runtime: { proofSha256: hash(proofBytes), checkedAt: proof.checkedAt, sourceVersion: proof.sourceVersion, sourceDigest: proof.sourceDigest, buildId: proof.diskBuildId, runningLatest: true },
    scope: 'Actual local UI and GET-only reads plus separately labelled in-memory GET fixtures. No prepare/upload/publish/save, real plugin execution, paid model call or billing action. Same-origin metadata GETs may read provider capabilities on the server; backend provider metadata traffic is not claimed to be zero.',
    checks: [], scenarios: [], screenshots: [], requests: [], fixtures: [], typography: [], blockedWrites: [], externalRequestsBlocked: [], unsafeReadsBlocked: [], pageErrors: [], consoleErrors: [], limitations: [],
    actualReadEvidence: {}, realWrites: 0, paidModelCalls: 0, publicationCalls: 0,
  };
  const check = (name, passed, evidence) => {
    report.checks.push({ name, passed: !!passed, ...(evidence === undefined ? {} : { evidence }) });
    assert.ok(passed, name);
  };
  const poll = async (fn, message, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(message);
  };
  const video = path.join(output, 'synthetic-local-preview.mp4');
  const cover = path.join(output, 'synthetic-local-cover.png');
  const ffmpeg = path.resolve('node_modules/ffmpeg-static/ffmpeg.exe');
  await fs.access(ffmpeg);
  await runFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12:duration=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], { timeout: 30000, windowsHide: true });
  await runFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=0x235be8:size=640x360', '-frames:v', '1', cover], { timeout: 30000, windowsHide: true });
  const [videoBytes, coverBytes] = await Promise.all([fs.readFile(video), fs.readFile(cover)]);
  report.localMediaFixture = { label: 'Locally generated synthetic file, no model or downloaded media', video: { bytes: videoBytes.length, sha256: hash(videoBytes), width: 640, height: 360, seconds: 2 }, cover: { bytes: coverBytes.length, sha256: hash(coverBytes), width: 640, height: 360 } };

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const contexts = new Set();
  const requestsFor = scenario => report.requests.filter(item => item.scenario === scenario);
  const future = new Date(Date.now() + 86400000).toISOString();
  const optionFixtures = JSON.parse(await fs.readFile('.codex-evidence/publishing-studio-f76f3d79/qa/fixed-14-platform-option-fixtures.json', 'utf8'));
  report.optionFixtureEvidence = { fixtureOnly: true, sourceCommit: optionFixtures.sourceCommit, sha256: hash(JSON.stringify(optionFixtures)), claim: 'Fixed-source-derived renderer fixtures; not hosted provider availability or actual option effect.' };
  const fixtureAccounts = [
    { id: accountIds.xhs, type: 'xhs', uid: 'fixture-xhs-only', nickname: '验收夹具小红书', avatar: '', status: 1, rank: 0, groupId: '', clientType: 'web', createdAt: stamp, updatedAt: stamp, nativeAccountKind: 'browser', nativeConnectionState: 'browser_reported', nativeDisconnected: false, nativeRevision: 1, nativeMetadataRevision: 0 },
    { id: accountIds.wxSph, type: 'wxSph', uid: 'fixture-wxsph-only', nickname: '验收夹具视频号', avatar: '', status: 1, rank: 1, groupId: '', clientType: 'web', createdAt: stamp, updatedAt: stamp, nativeAccountKind: 'browser', nativeConnectionState: 'browser_reported', nativeDisconnected: false, nativeRevision: 1, nativeMetadataRevision: 0 },
    { id: accountIds.douyin, type: 'douyin', uid: 'fixture-douyin-only', nickname: '验收夹具抖音', avatar: '', status: 1, rank: 2, groupId: '', clientType: 'web', createdAt: stamp, updatedAt: stamp, nativeAccountKind: 'official', nativeConnectionState: 'official_bound', nativeDisconnected: false, nativeRevision: 1, nativeMetadataRevision: 0 },
  ];
  for (const [platform, name] of Object.entries(platformNames).filter(([key]) => !['xhs', 'wxSph', 'douyin'].includes(key))) fixtureAccounts.push({ id: accountIds[platform], type: platform, uid: `fixture-${platform}-only`, nickname: `验收夹具${name}`, avatar: '', status: 1, rank: fixtureAccounts.length, groupId: '', clientType: 'web', createdAt: stamp, updatedAt: stamp, nativeAccountKind: 'generic', nativeConnectionState: 'official_bound', nativeDisconnected: false, nativeRevision: 1, nativeMetadataRevision: 0 });
  const fixturePlatforms = ready => Object.entries(platformNames).map(([platform, name]) => ({
    platform, name, nativeConnectionAllowed: platform !== 'youtube', nativePublishAllowed: ready && !['youtube', 'wxGzh'].includes(platform), nativeReason: platform === 'wxGzh' ? '仅验收夹具：公众号发布身份适配尚待核实' : ready && platform !== 'youtube' ? '仅验收夹具可用状态' : '仅验收夹具：发布服务未开放',
    ...(platform === 'douyin' ? { channels: ['browser_plugin', 'official_api'].map(transport => ({ transport, connectionAllowed: true, publishAllowed: ready, reason: '仅界面夹具；实际通道未执行' })) } : {}),
    ...(!['xhs', 'wxSph', 'douyin'].includes(platform) ? {
      editor: 'text', contentLimits: { modes: ['linkedin', 'facebook', 'twitter', 'threads'].includes(platform) ? ['article2', 'article', 'video'] : ['article', 'video'], maxTitleLength: platform === 'twitter' ? 0 : 100, maxBodyLength: platform === 'twitter' ? 280 : 5000, maxImages: platform === 'tiktok' ? 35 : 10, maxVideos: 1 },
      mediaRules: { imageFormats: ['png', 'jpg', 'jpeg'], videoFormats: ['mp4'], maxImageSize: 20 * 1024 * 1024, maxVideoSize: 100 * 1024 * 1024 }, topic: { supported: true },
      optionSchema: optionFixtures.platforms.find(item => item.platform === platform).optionSchema,
    } : {}),
  }));
  const fixtureBootstrap = (ready, membership = false) => ({
    config: { version: 1, mode: 'browser_plugin', executionEnabled: ready, salesEnabled: false, cloudEnabled: false, enabledPlatforms: Object.keys(platformNames), pluginUrl: null, announcement: ready ? '' : '[FIXTURE] 发布执行已开启（故意冲突，不得展示）', usageNotice: '显式只读界面验收夹具' },
    entitlements: ready && !membership ? [{ id: uid(111), purchaseId: uid(112), planId: uid(113), planVersion: 1, planName: '验收夹具额度', quota: 40, used: 0, expiresAt: future, platforms: Object.keys(platformNames) }] : [],
    schemaReady: true, access: { allowed: true, code: 'PUBLISH_ACCESS_READY', message: '仅验收夹具' },
    membership: { schemaReady: true, canConsumeExisting: true, quote: membership ? { quoteHash: 'c'.repeat(64), policyId: uid(501), policyVersion: 1, profileKey: 'qa_member', profileVersion: 1, periodStart: new Date(Date.now() - 86400000).toISOString(), periodEnd: future, periodKind: 'calendar_month', timeZone: 'Asia/Shanghai', quota: 10, platforms: Object.keys(platformNames), expiresAt: future, wouldGrant: true, cashChargeCents: 0 } : null },
  });
  const fixtureRecords = [
    { id: uid(130), title: '只读夹具浏览器报告', accountType: 'xhs', nativeOutcome: 'browser_reported', nativeEvidence: 'browser_reported', nativeReportSource: 'browser_reported', nativeTransport: 'browser_plugin', nativeReportedSuccess: true, status: 8, createdAt: stamp },
    { id: uid(131), title: '只读夹具明确失败', accountType: 'wxSph', nativeOutcome: 'browser_reported', nativeEvidence: 'browser_reported', nativeReportSource: 'browser_reported', nativeTransport: 'browser_plugin', nativeReportedSuccess: false, status: -1, createdAt: stamp },
    { id: uid(132), title: '只读夹具结果未知', accountType: 'douyin', nativeOutcome: 'unknown', nativeEvidence: 'provider_reported', nativeReportSource: 'provider_reported', nativeTransport: 'official_api', createdAt: stamp },
    { id: uid(133), title: '只读夹具等待手机接力', accountType: 'douyin', nativeOutcome: 'awaiting_user_action', nativeEvidence: 'provider_reported', nativeReportSource: 'provider_reported', nativeTransport: 'official_api', nativeRevision: 1, nativeConnectionCurrent: true, createdAt: stamp },
    { id: uid(134), title: '只读夹具队列任务', accountType: 'douyin', nativeOutcome: 'queued', nativeEvidence: 'provider_reported', nativeReportSource: 'provider_reported', nativeTransport: 'official_api', nativeRevision: 3, nativeConnectionCurrent: true, publishTime: new Date(Date.now() + 7200000).toISOString(), createdAt: stamp },
    { id: uid(135), title: '只读夹具到期原浏览器计划', accountType: 'xhs', nativeOutcome: 'planned', nativeEvidence: 'local_plan', nativeReportSource: 'local_plan', nativeTransport: 'local_plan', nativeRevision: 2, nativeConnectionCurrent: true, publishTime: new Date(Date.now() - 3600000).toISOString(), createdAt: stamp },
  ];
  const adminAccessFixture = { access: { authorityStatus: 'ready', integrityValid: true, adminLevel: 'admin', permissionKeys: ['integrations.manage', 'packages.manage'], revision: 1, profileActive: true, updatedAt: stamp }, stepUp: { status: 'missing', expiresAt: null, authMethod: null }, maintenanceLock: { status: 'inactive', enabled: false, revision: 0, enabledAt: null, expiresAt: null, enableReason: '', disabledAt: null, disableReason: '', maxDurationMinutes: 60 }, tabAccess: { publishing: true }, managementPasswordSet: false, catalog: [] };
  const adminPublishingFixture = { config: { ...fixtureBootstrap(false).config, operatorLinks: { officialUrl: 'https://aitoearn.ai', apiKeyUrl: 'https://aitoearn.ai/zh-CN/api-key', docsUrl: 'https://docs.aitoearn.ai/zh/use/plugin-publish', contactUrl: null, pluginUrl: null }, runtimeExecutionEnabled: false, procurementNotes: '仅界面夹具：统一采购与成员权益分别配置', procurementVerifiedAt: null }, plans: [], stats: null, tasks: [], schemaReady: true, sectionAccess: { billing: false } };
  const adminMembershipFixture = { schemaReady: true, profiles: [{ key: 'qa_member', version: 1, name: '只读夹具会员', eligible: true }], plans: [{ id: uid(502), version: 1, name: '只读夹具十次方案', quota: 10, platforms: ['douyin', 'xhs'], enabled: true }], policies: [] };
  async function open(scenario, mode = 'actual', theme = 'soft-white', options = {}) {
    const hostMode = theme === 'lattice' ? 'dark' : 'light';
    const projectedUser = options.member ? { ...identity.user, role: 'user', isAdmin: false, adminLevel: null } : identity.user;
    const ready = mode === 'ready' || mode === 'membership';
    const context = await browser.newContext({ viewport: report.viewport, colorScheme: hostMode, serviceWorkers: 'block', acceptDownloads: false });
    contexts.add(context);
    await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.addInitScript(({ authToken, user, selectedTheme, selectedMode, fixture }) => {
      localStorage.setItem('auth_token', authToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      sessionStorage.setItem('entered_app', '1'); sessionStorage.setItem('trial_dialog_dismissed', '1');
      localStorage.setItem('user_theme_preference', selectedTheme);
      localStorage.setItem('user_theme_mode_preference', selectedMode);
      localStorage.setItem('user_theme_preference_expires_at', new Date(Date.now() + 3600000).toISOString());
      window.__studioVerification = { fixture, pluginPublishCalls: 0 };
      // A trap prevents an extension from converting a UI fixture into a side effect.
      Object.defineProperty(window, 'AIToEarnPlugin', { configurable: false, writable: false, value: {
        getVersion: async () => ({ version: '3.3.11' }), checkPermission: async () => ({ granted: true, hostAccess: true }),
        login: async platform => ({ type: platform, uid: platform === 'xhs' ? 'fixture-xhs-only' : 'fixture-wxsph-only', account: 'fixture-only', nickname: '只读验收夹具' }),
        publish: async () => { window.__studioVerification.pluginPublishCalls++; throw new Error('Verification forbids publication'); },
      } });
    }, { authToken: token, user: projectedUser, selectedTheme: theme, selectedMode: hostMode, fixture: mode !== 'actual' });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => socket.close());
    const logFixture = (pathname, reason) => { if (!report.fixtures.some(item => item.scenario === scenario && item.path === pathname)) report.fixtures.push({ scenario, path: pathname, reason }); };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const entry = { scenario, method, path: url.pathname, ...(/\/(?:publishing|publish-center)\/(?:v2|generic)$|\/studio\/history$/u.test(url.pathname) ? { resource: url.searchParams.get('resource'), page: url.searchParams.get('page'), from: url.searchParams.get('from'), to: url.searchParams.get('to') } : {}), delivery: 'pending' };
      if (url.pathname.startsWith('/api/')) report.requests.push(entry);
      if (!['GET', 'HEAD'].includes(method)) { entry.delivery = 'blocked-write'; report.blockedWrites.push({ scenario, method, path: url.pathname }); return route.abort('blockedbyclient'); }
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) { entry.delivery = 'blocked-external'; report.externalRequestsBlocked.push({ scenario, host: url.hostname, path: url.pathname }); return route.abort('blockedbyclient'); }
      // A detail GET reconciles provider state server-side. Only known RAM
      // fixture IDs may be rendered; no real detail GET ever reaches the BFF.
      if (/\/v2\/channels\/publish\/records\//u.test(url.pathname)) {
        const relative = url.pathname.slice((API + '/v2/channels/publish/records/').length), record = fixtureRecords.find(item => item.id === relative);
        const handoff = relative === `${uid(133)}/user-action`;
        if (mode !== 'actual' && (record || handoff)) {
          entry.delivery = 'read-only-detail-fixture'; logFixture(url.pathname, 'Explicit render-only record/phone-handoff snapshot; real GET reconciliation is prohibited');
          return json(route, envelope(handoff ? { recordId: uid(133), platform: 'douyin', shortLink: 'https://www.douyin.com/verification-fixture-never-opened', schemeUrl: 'snssdk1128://verification-fixture-never-opened', expiresAt: future } : record));
        }
        entry.delivery = 'blocked-reconciling-read'; report.unsafeReadsBlocked.push({ scenario, path: url.pathname }); return route.abort('blockedbyclient');
      }
      if (url.pathname === '/api/auth/me') {
        entry.delivery = 'identity-projection'; logFixture(url.pathname, 'RAM identity projection avoids GET account reconciliation');
        return json(route, { user: { ...projectedUser, themePreference: theme, themeModePreference: hostMode, themePreferenceExpiresAt: future } });
      }
      if (['/api/announcements/inbox', '/api/popup-pushes'].includes(url.pathname)) {
        entry.delivery = 'non-business-fixture'; logFixture(url.pathname, 'Empty notices prevent automatic seen/acknowledge writes');
        return json(route, url.pathname.endsWith('inbox') ? { announcements: [], cursor: '' } : { success: true, popups: [] });
      }
      if (options.admin && url.pathname.startsWith('/api/admin/')) {
        entry.delivery = 'read-only-admin-fixture'; logFixture(url.pathname, 'Admin component render-only GET fixture; step-up remains missing; no authorization or save proof');
        if (url.pathname === '/api/admin/access-control/self') return json(route, adminAccessFixture);
        if (url.pathname === '/api/admin/publishing') return json(route, adminPublishingFixture);
        if (url.pathname === '/api/admin/publishing/membership-policy') return json(route, adminMembershipFixture);
        if (url.pathname === '/api/admin/publishing/native') return json(route, { schemaReady: true, provider: { configured: false, environment: 'domestic', routeExecutionEnabled: false, bindingRequired: true, credentialSource: 'missing' }, counts: null });
        entry.delivery = 'blocked-unexpected-admin-get'; return route.abort('blockedbyclient');
      }
      if (mode !== 'actual' && url.pathname.startsWith(API + '/')) {
        entry.delivery = 'read-only-fixture'; logFixture(url.pathname, `${mode} UI snapshot; not actual server availability or publication evidence`);
        if (url.pathname === API + '/session') return json(route, envelope({ version: 'native-host-session.v1', authenticated: true, user: { id: identity.user.id, username: 'fixture-studio', displayName: '发布页只读夹具', role: options.member ? 'user' : 'admin' }, featureNavigationKeys: ['marketplace', 'publish_center', 'cover'], wallet: { cashCents: 0, credits: 0 }, csrfToken: 'READ_ONLY_FIXTURE_NO_WRITE_ALLOWED_'.repeat(3) }));
        if (url.pathname === API + '/studio/bootstrap') return mode === 'failure' ? json(route, { code: 'FIXTURE_SERVICE_UNAVAILABLE', data: null, message: '只读验收夹具：服务暂时不可用' }, 503) : json(route, envelope(fixtureBootstrap(ready, mode === 'membership')));
        if (url.pathname === API + '/v2/channels/accounts') return json(route, envelope({ list: fixtureAccounts, total: fixtureAccounts.length }));
        if (url.pathname === API + '/v2/channels/platforms') return json(route, envelope(fixturePlatforms(ready)));
        if (url.pathname === API + '/v2/channels/publish/records') return json(route, envelope(fixtureRecords));
        if (url.pathname === API + '/studio/history') {
          const number = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 30), from = url.searchParams.get('from'), to = url.searchParams.get('to');
          const rows = fixtureRecords.filter(item => (!from || Date.parse(item.publishTime || item.createdAt) >= Date.parse(from)) && (!to || Date.parse(item.publishTime || item.createdAt) < Date.parse(to)));
          const paged = scenario === 'fixture-history-paging';
          const items = paged && number === 2 ? [{ ...fixtureRecords[4], id: uid(136), title: '只读夹具第二页原任务' }] : rows;
          return json(route, envelope({ items: items.map(value => ({ source: 'legacy', value })), page: number, pageSize, total: paged ? 31 : rows.length }));
        }
        if (url.pathname === API + '/history/assets') return json(route, envelope({ list: [], total: 0, page: 1, pageSize: 50, hasMore: false }));
        if (url.pathname === API + '/publishing/v2' && url.searchParams.get('resource') === 'drafts') return json(route, envelope({ schemaReady: true, resource: 'drafts', page: 1, pageSize: 50, total: 0, hasMore: false, items: [] }));
        if (url.pathname === API + '/publishing/generic' && ['records', 'drafts'].includes(url.searchParams.get('resource'))) return json(route, envelope({ items: [], total: 0, page: Number(url.searchParams.get('page') || 1), pageSize: Number(url.searchParams.get('pageSize') || 100) }));
        if (url.pathname === API + '/publishing/generic' && url.searchParams.get('resource') === 'status') return json(route, envelope({ schemaReady: true, configured: true, executionEnabled: ready }));
        // An unexpected module read is visible and fails closed; no broad success fixture.
        entry.delivery = 'blocked-unexpected-native-get';
        return route.abort('blockedbyclient');
      }
      entry.delivery = 'actual-get';
      if (url.pathname.startsWith(API + '/') && ![API + '/session', API + '/studio/bootstrap', API + '/v2/channels/platforms', API + '/v2/channels/accounts', API + '/v2/channels/publish/records', API + '/studio/history'].includes(url.pathname)) {
        entry.delivery = 'blocked-unexpected-native-get'; return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push({ scenario, message: safe(error.message).slice(0, 600) }));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ scenario, message: safe(message.text()).slice(0, 600) }); });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== origin || !url.pathname.startsWith('/api/')) return;
      const entry = [...report.requests].reverse().find(item => item.scenario === scenario && item.path === url.pathname && item.status === undefined);
      if (entry) entry.status = response.status();
    });
    await page.goto(origin + (options.admin ? '/admin?tab=publishing' : '/publish-center'), { waitUntil: 'domcontentloaded' });
    await page.getByTestId(options.admin ? 'publishing-procurement' : 'publishing-studio').waitFor({ state: 'visible' });
    if (mode !== 'actual') await page.evaluate(label => {
      const badge = document.createElement('div'); badge.textContent = label; badge.setAttribute('data-qa-fixture', 'true');
      Object.assign(badge.style, { position: 'fixed', bottom: '8px', left: '8px', zIndex: '2147483647', padding: '6px 10px', background: '#702111', color: '#fff', fontSize: '12px', pointerEvents: 'none' }); document.body.append(badge);
    }, `仅界面验收 FIXTURE · ${mode} · 未执行发布`);
    return { page, context, scenario, mode };
  }
  const studio = page => page.getByTestId('publishing-studio');
  async function capture(page, name) {
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(output, filename), fullPage: false, mask: [page.locator('[data-testid="sidebar-user-menu-trigger"]'), ...privateValues.filter(value => value !== token).map(value => page.getByText(value, { exact: true }))] });
    report.screenshots.push(filename);
  }
  async function layout(page, name) {
    const measurement = await studio(page).evaluate(root => {
      const r = root.getBoundingClientRect(), css = getComputedStyle(root);
      const visible = [...root.querySelectorAll('input:not([type=file]),textarea,button,[role=tab],video,img')].filter(element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width && box.height && style.display !== 'none' && style.visibility !== 'hidden'; });
      return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, root: { x: r.x, right: r.right, width: r.width }, fontFamily: css.fontFamily, colorScheme: css.colorScheme,
        overflow: visible.filter(element => { const box = element.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; }).map(element => ({ tag: element.tagName, testid: element.getAttribute('data-testid') })).slice(0, 15) };
    });
    check(`${name}: no horizontal overflow or offscreen controls`, measurement.documentWidth <= measurement.viewportWidth + 1 && measurement.root.x >= -1 && measurement.root.right <= measurement.viewportWidth + 1 && !measurement.overflow.length, measurement);
  }
  async function headingReadability(page, name, requireDialog = false) {
    const headings = await page.evaluate(() => {
      const rgba = value => { const parts = value.match(/[\d.]+/gu)?.map(Number) || []; return parts.length >= 3 ? [parts[0], parts[1], parts[2], parts[3] ?? 1] : null; };
      const over = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3]));
      const light = rgb => rgb.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      return [...document.querySelectorAll('[data-testid="publishing-studio"] h1,[data-testid="publishing-studio"] h2,[data-testid="publishing-studio"] h3,[role="dialog"] h1,[role="dialog"] h2,[role="dialog"] h3')].filter(element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; }).map(element => {
        const style = getComputedStyle(element), foreground = rgba(style.webkitTextFillColor || style.color), ancestors = [];
        for (let parent = element; parent; parent = parent.parentElement) ancestors.push(parent);
        let background = [255, 255, 255];
        for (const parent of ancestors.reverse()) { const color = rgba(getComputedStyle(parent).backgroundColor); if (color) background = over(color, background); }
        const fg = foreground ? light(over(foreground, background)) : null, bg = light(background);
        return { tag: element.tagName, text: element.textContent.trim().slice(0, 100), color: style.color, textFillColor: style.webkitTextFillColor, textShadow: style.textShadow, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, background, inDialog: !!element.closest('[role="dialog"]'), contrast: fg === null ? 0 : (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) };
      });
    });
    check(`${name}: all studio h1 h2 h3 contrast is at least 4.5 on their actual background`, headings.length > 0 && (!requireDialog || headings.some(item => item.inDialog)) && headings.every(item => item.contrast >= 4.5), headings);
  }
  async function noInitialImports(page, scenario) {
    await poll(() => Promise.resolve(requestsFor(scenario).some(item => item.path === API + '/studio/bootstrap' && item.status !== undefined)), 'Bootstrap response did not complete');
    await page.waitForTimeout(250);
    const reads = requestsFor(scenario);
    check(`${scenario}: default draft has no media/history/AI/draft requests`, !reads.some(item => forbiddenInitial(new URL(item.path + (item.resource ? `?resource=${item.resource}` : ''), origin))), reads.map(({ path: pathname, resource, delivery, status }) => ({ path: pathname, resource, delivery, status })));
    check(`${scenario}: initial overview has no populated editor or loaded draft`, await page.getByTestId('studio-overview').isVisible() && await page.getByTestId('studio-title').count() === 0 && !/本次正在编辑/u.test(await studio(page).innerText()));
    check(`${scenario}: no native subapp navigation`, new URL(page.url()).pathname === '/publish-center');
    check(`${scenario}: no model or admin controls in studio`, !await studio(page).locator('a[href^="/admin"],a[href^="/publish-center/native"],select[name*="model"]').count());
    check(`${scenario}: original subapp brand absent from top-level UI`, !/aitoearn|ai\s*to\s*earn/iu.test(await studio(page).locator('aside').innerText()));
  }
  async function compose(page, kind = 'image') {
    await page.getByTestId('studio-compose-tab').click();
    await page.getByTestId('studio-step-1').click();
    await page.getByTestId(`studio-type-${kind}`).click();
  }
  async function step(page, index) { await page.getByTestId(`studio-step-${index}`).click(); }
  async function scenario(name, kind, fn) {
    const start = Date.now();
    try { await fn(); report.scenarios.push({ name, kind, passed: true, elapsedMs: Date.now() - start }); }
    catch (error) {
      report.scenarios.push({ name, kind, passed: false, elapsedMs: Date.now() - start, error: safe(error.message).slice(0, 1400) });
      const page = browser.contexts().at(-1)?.pages().at(-1);
      if (page && !page.isClosed()) {
        await capture(page, `${name}-failure`).catch(() => {});
        await fs.writeFile(path.join(output, `${name}-failure.txt`), safe(await page.locator('body').innerText().catch(() => '')).slice(0, 16000));
      }
    }
  }

  try {
    await scenario('actual-default-and-adjacent-pages', 'actual-get-ui', async () => {
      const { page, context } = await open('actual-default');
      await noInitialImports(page, 'actual-default');
      for (const suffix of ['/session', '/studio/bootstrap', '/v2/channels/platforms', '/v2/channels/accounts']) {
        const items = requestsFor('actual-default').filter(item => item.path === API + suffix);
        check(`actual GET ${suffix} completed`, items.some(item => item.delivery === 'actual-get' && Number.isInteger(item.status)), items.map(({ status, delivery }) => ({ status, delivery })));
        report.actualReadEvidence[suffix] = items.map(({ status, delivery }) => ({ status, delivery }));
      }
      check('actual overview has no premature publish action', await page.getByTestId('studio-publish-button').count() === 0);
      await layout(page, 'actual blank'); await capture(page, 'actual-empty-studio');
      await compose(page);
      check('empty material step cannot skip to accounts or scheduling', await page.getByTestId('studio-step-2').isDisabled() && await page.getByTestId('studio-step-3').isDisabled());
      check('empty material step reveals only the upload stage', await page.getByTestId('studio-media-input').count() === 1 && await page.getByTestId('studio-title').count() === 0);
      await capture(page, 'actual-empty-material-stage');
      for (const [legacy, tab] of [['/publish-center/native', 'overview'], ['/publish-center/native/zh-CN/ai-social', 'overview'], ['/publish-center/native/zh-CN/accounts', 'overview']]) {
        const response = await page.goto(origin + legacy, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('publishing-studio').waitFor();
        check(`legacy ${legacy} redirects to the exact new tab`, new URL(page.url()).pathname === '/publish-center' && (new URL(page.url()).searchParams.get('tab') || 'overview') === tab);
        check(`legacy ${legacy} uses an HTTP redirect`, Boolean(response?.request().redirectedFrom()));
        check(`legacy ${legacy} displays the new tab`, await page.getByTestId('studio-nav-overview').getAttribute('aria-current') === 'page');
      }
      const preferences = await page.evaluate(() => ({ theme: localStorage.getItem('user_theme_preference'), mode: localStorage.getItem('user_theme_mode_preference') }));
      for (const target of ['/', '/cover']) {
        await page.goto(origin + target, { waitUntil: 'domcontentloaded' });
        await poll(() => page.locator('body').evaluate(body => body.innerText.trim().length > 80), 'Adjacent page did not render');
        check(`adjacent ${target} stays on requested route`, new URL(page.url()).pathname === target);
        check(`adjacent ${target} has no studio shell`, await page.getByTestId('publishing-studio').count() === 0);
        check(`adjacent ${target} has no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        check(`adjacent ${target} preserves theme preferences`, JSON.stringify(await page.evaluate(() => ({ theme: localStorage.getItem('user_theme_preference'), mode: localStorage.getItem('user_theme_mode_preference') }))) === JSON.stringify(preferences));
        await capture(page, target === '/' ? 'actual-adjacent-home' : 'actual-adjacent-cover');
      }
      await context.close(); contexts.delete(context);
    });
    await scenario('fixture-ready-local-media-and-final-review', 'GET-fixture-ui-only', async () => {
      const { page, context } = await open('fixture-ready', 'ready');
      await noInitialImports(page, 'fixture-ready');
      await compose(page, 'video');
      await page.getByTestId('studio-media-input').setInputFiles({ name: 'invalid-media.txt', mimeType: 'text/plain', buffer: Buffer.from('Explicit local invalid media fixture') });
      await poll(() => studio(page).locator('[role="alert"]').allTextContents().then(values => values.some(text => /请选择|不支持|格式/u.test(text))), 'Invalid media must show an actionable error');
      check('invalid file is not rendered as playable media', await studio(page).locator('video').count() === 0);
      await page.getByTestId('studio-media-input').setInputFiles(video);
      const preview = studio(page).locator('video').first(); await preview.waitFor();
      await poll(() => preview.evaluate(element => element.readyState >= 1 && element.videoWidth === 640 && element.videoHeight === 360 && element.duration >= 1.9 && element.duration <= 2.2), 'Real synthetic video must decode locally');
      await preview.evaluate(element => element.play()); await poll(() => preview.evaluate(element => element.currentTime > 0), 'Local video must actually play'); await preview.evaluate(element => element.pause());
      check('video preview uses a local blob URL', (await preview.getAttribute('src') || '').startsWith('blob:'));
      await page.getByTestId('studio-title').focus();
      check('title supports keyboard focus after selecting media', await page.getByTestId('studio-title').evaluate(element => element === document.activeElement));
      await page.keyboard.press('Tab');
      check('keyboard advances from title without leaving document', await page.evaluate(() => document.activeElement !== document.body));
      await page.getByTestId('studio-cover-input').setInputFiles(cover);
      await page.getByTestId('studio-title').fill('本机真实短视频预览');
      await page.getByTestId('studio-body').fill('仅验收夹具中的本机素材预览。所有真实发布动作保持未执行。');
      await page.getByTestId('studio-topics').fill('本机预览 只读验收');
      await page.getByTestId('studio-topics').press('Enter');
      await layout(page, 'ready video and cover'); await capture(page, 'fixture-ready-local-media');
      await page.getByTestId('studio-title').fill('中文长标题用于验证不同平台限制与布局换行'.repeat(12));
      await page.getByTestId('studio-body').fill(('这是一段较长的中文正文，用于检查连续文字换行、内容编辑与右侧真实预览。\n').repeat(12));
      await layout(page, 'long Chinese content');
      await step(page, 2); await page.getByTestId(`studio-account-${accountIds.xhs}`).click(); await step(page, 3);
      if (!await page.getByTestId('studio-publish-button').isDisabled()) await page.getByTestId('studio-publish-button').click();
      await poll(() => studio(page).innerText().then(text => /标题.*(?:最多|超过|长度)|(?:最多|超过).*标题/u.test(text)), 'Long title must show platform rule failure');
      check('oversized title cannot open final review', await page.getByTestId('studio-confirm-dialog').count() === 0);
      await capture(page, 'fixture-long-chinese-validation');
      await step(page, 1);
      await page.getByTestId('studio-title').fill('甲'.repeat(18));
      await step(page, 2);
      await page.getByTestId(`studio-account-${accountIds.wxSph}`).click();
      await step(page, 3);
      await page.getByTestId('studio-publish-button').click();
      await poll(() => studio(page).innerText().then(text => /视频号[\s\S]*标题最多 16/u.test(text)), 'Selected video-channel account must enforce its own 16-character title rule');
      check('platform-specific rule blocks the combined review', await page.getByTestId('studio-confirm-dialog').count() === 0);
      await step(page, 2);
      await page.getByTestId(`studio-account-${accountIds.wxSph}`).click();
      await step(page, 1);
      await page.getByTestId('studio-title').fill('本机真实短视频预览');
      await step(page, 3);
      await page.getByTestId('studio-publish-button').click();
      const dialog = page.getByTestId('studio-confirm-dialog'); await dialog.waitFor({ state: 'visible' });
      check('final confirmation contains selected account and content', (await dialog.innerText()).includes('验收夹具小红书') && (await dialog.innerText()).includes('本机真实短视频预览'));
      check('review opens before any upload/prepare/write', report.blockedWrites.filter(item => item.scenario === 'fixture-ready').length === 0);
      check('dialog keeps focus inside modal', await dialog.evaluate(element => element.contains(document.activeElement)));
      await capture(page, 'fixture-final-review-cancel-only');
      await page.getByTestId('studio-confirm-cancel').click(); await dialog.waitFor({ state: 'hidden' });
      await step(page, 1);
      check('cancelling review retains the local draft', await page.getByTestId('studio-title').inputValue() === '本机真实短视频预览' && await page.getByTestId('studio-media-preview').count() === 1);
      check('cancelling review makes zero plugin publication calls', await page.evaluate(() => window.__studioVerification.pluginPublishCalls) === 0);
      await page.getByTestId('studio-title').fill('重新核对修改后的标题');
      await page.getByTestId('studio-nav-overview').click();
      check('leaving composer preserves only this in-memory draft', /本次正在编辑/u.test(await page.getByTestId('studio-overview').innerText()));
      await page.getByTestId('studio-compose-tab').click(); await step(page, 3);
      await page.getByTestId('studio-publish-button').click(); await dialog.waitFor();
      check('a new review reflects edited content and does not reuse cancelled title', (await dialog.innerText()).includes('重新核对修改后的标题') && !(await dialog.innerText()).includes('本机真实短视频预览'));
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      check('Escape cancels review without write or publication', !report.blockedWrites.some(item => item.scenario === 'fixture-ready') && await page.evaluate(() => window.__studioVerification.pluginPublishCalls) === 0);
      await context.close(); contexts.delete(context);
    });
    await scenario('fixture-dynamic-options-and-scheduling-journey', 'GET-fixture-schema-render-and-pure-review-only', async () => {
      const { page, context } = await open('fixture-options', 'ready'); await noInitialImports(page, 'fixture-options');
      await compose(page, 'text');
      await page.getByTestId('studio-title').fill('这个工作标题不应发送到 X');
      await page.getByTestId('studio-body').fill('纯文字发布的本地验收内容。');
      await step(page, 2);
      const choose = async platform => { await page.getByTestId(`studio-account-${accountIds[platform]}`).click(); await page.getByTestId(`studio-target-tab-${accountIds[platform]}`).click(); };
      const advanced = async () => { const details = page.getByTestId('studio-platform-fields').locator('details').first(); if (!await details.evaluate(node => node.open)) await details.locator('summary').click(); };
      await choose('twitter');
      check('X target hides unsupported title in both editor and actual preview', await page.getByTestId('studio-target-title').count() === 0 && !(await page.getByTestId('studio-content-preview').innerText()).includes('这个工作标题不应发送到 X'));
      await advanced();
      await page.getByRole('checkbox', { name: '设置投票', exact: true }).check();
      await page.getByRole('button', { name: '添加投票选项', exact: true }).click();
      await page.getByRole('button', { name: '添加投票选项', exact: true }).click();
      await page.getByTestId('studio-option-poll-options-0').fill('选项甲');
      await page.getByTestId('studio-option-poll-options-1').fill('选项乙');
      await page.getByTestId('studio-option-poll-duration_minutes').fill('60');
      await page.getByTestId('studio-option-made_with_ai').selectOption('false');
      check('nested poll and explicit false remain editable', await page.getByTestId('studio-option-poll-options-1').inputValue() === '选项乙' && await page.getByTestId('studio-option-made_with_ai').inputValue() === 'false');
      await layout(page, 'X nested poll'); await capture(page, 'fixture-text-poll-fields');
      await choose('bilibili');
      const copyright = page.getByTestId('studio-option-copyright');
      check('copyright branch labels distinguish original and reprint', (await copyright.locator('option').allTextContents()).includes('原创') && (await copyright.locator('option').allTextContents()).includes('转载'));
      await copyright.selectOption('1');
      await page.getByTestId('studio-option-tid').fill('1');
      await page.getByTestId('studio-option-source').fill('已授权来源仅作本地字段夹具');
      check('reprint branch exposes a required source field', /必填/u.test(await page.getByTestId('studio-option-source').locator('..').innerText()));
      await capture(page, 'fixture-bilibili-conditional-source');
      await choose('linkedin'); await advanced();
      check('unverified private audience cannot be selected', await page.getByTestId('studio-option-visibility').locator('option[value="0"]').isDisabled());
      check('unverified non-feed distribution cannot be selected', await page.getByTestId('studio-option-distribution').locator('option[value="1"]').isDisabled());
      await choose('facebook'); await advanced();
      check('unverified Facebook audience restriction is explicitly blocked', await page.getByTestId('studio-option-blocked-feed_targeting').isVisible());
      check('unverified Facebook draft state cannot be selected', await page.getByTestId('studio-option-video_state').locator('option[value="0"]').isDisabled());
      await choose('instagram'); await advanced();
      check('unverified collaborator setting is visibly blocked', await page.getByTestId('studio-option-blocked-collaborators').isVisible());
      await choose('wxGzh');
      check('unverified official-account identity is explained before execution', /发布身份.*(?:核实|确认)/u.test(await page.getByTestId('studio-target-editor').innerText()));
      for (const platform of ['bilibili', 'linkedin', 'facebook', 'instagram', 'wxGzh']) await page.getByTestId(`studio-account-${accountIds[platform]}`).click();
      await page.getByTestId(`studio-target-tab-${accountIds.twitter}`).click(); await advanced();
      check('switching target tabs preserves typed options and false values', await page.getByTestId('studio-option-poll-options-0').inputValue() === '选项甲' && await page.getByTestId('studio-option-made_with_ai').inputValue() === 'false');
      await step(page, 3);
      await studio(page).getByRole('button', { name: /指定时间.*按各平台实际排期能力执行/u }).click();
      await page.getByLabel('验收夹具X 的时间方式', { exact: true }).selectOption('now');
      check('target immediate override coexists with common schedule', await page.getByTestId('studio-common-schedule').isVisible() && await page.getByLabel('验收夹具X 的时间方式', { exact: true }).inputValue() === 'now');
      await capture(page, 'fixture-per-target-scheduling');
      await page.getByTestId('studio-publish-button').click();
      const dialog = page.getByTestId('studio-confirm-dialog'); await dialog.waitFor();
      check('pure text review includes actual poll options without writing', (await dialog.innerText()).includes('选项甲') && !report.blockedWrites.some(item => item.scenario === 'fixture-options'));
      await page.getByTestId('studio-confirm-cancel').click(); await dialog.waitFor({ state: 'hidden' });
      await context.close(); contexts.delete(context);
    });
    await scenario('fixture-explicit-history-and-import', 'GET-fixture-ui-only', async () => {
      const { page, context } = await open('fixture-import', 'ready'); await noInitialImports(page, 'fixture-import');
      await page.getByTestId('studio-accounts-tab').click();
      check('accounts tab updates the new page query', new URL(page.url()).searchParams.get('tab') === 'accounts');
      check('accounts tab retains unavailable platform catalog', await studio(page).getByRole('heading', { name: 'YouTube', exact: true }).isVisible());
      for (const name of Object.values(platformNames)) check(`platform catalog retains ${name}`, await studio(page).getByRole('heading', { name, exact: true }).isVisible());
      check('unconnected platform has disabled connect action', await studio(page).locator('section').filter({ has: page.getByRole('heading', { name: 'YouTube', exact: true }) }).getByRole('button', { name: '连接账号', exact: true }).isDisabled());
      await page.getByTestId('studio-connect-douyin').click();
      const connection = page.getByTestId('studio-connect-channel'); await connection.waitFor();
      check('Douyin exposes both connection channels before authorization', await page.getByTestId('studio-connect-channel-browser_plugin').isVisible() && await page.getByTestId('studio-connect-channel-official_api').isVisible());
      await capture(page, 'fixture-douyin-channel-choice-cancel-only');
      await connection.getByRole('button', { name: '暂不连接', exact: true }).click();
      await capture(page, 'fixture-platform-accounts');
      await page.getByTestId('studio-history-tab').click();
      await poll(() => Promise.resolve(requestsFor('fixture-import').some(item => item.path === API + '/studio/history')), 'History tab must read paginated publication records');
      check('history tab does not read other-module history', !requestsFor('fixture-import').some(item => /\/history\/|\/media-history|\/agent\/|\/ai\//u.test(item.path)));
      await studio(page).getByText('只读夹具明确失败', { exact: true }).waitFor();
      const failure = studio(page).locator('article').filter({ hasText: '只读夹具明确失败' });
      const browserReport = studio(page).locator('article').filter({ hasText: '只读夹具浏览器报告' });
      check('browser-reported failure remains an explicit failure', /失败|未完成/u.test(await failure.innerText()));
      check('browser-reported success is not promoted to platform success', !/发布成功|已完成/u.test(await browserReport.innerText()) && /核对|报告/u.test(await browserReport.innerText()));
      await capture(page, 'fixture-publication-history-only');
      await page.getByTestId('studio-compose-tab').click(); await page.getByTestId('studio-import-button').click();
      await poll(() => Promise.resolve(requestsFor('fixture-import').some(item => item.path === API + '/history/assets')), 'Explicit import must request main-site media');
      await capture(page, 'fixture-explicit-import');
      await page.getByTestId('studio-import-dialog').getByRole('button', { name: '发布草稿', exact: true }).click();
      await poll(() => Promise.resolve(requestsFor('fixture-import').some(item => item.path === API + '/publishing/v2' && item.resource === 'drafts')), 'Explicit draft-import tab must request drafts');
      await poll(() => Promise.resolve(requestsFor('fixture-import').some(item => item.path === API + '/publishing/generic' && item.resource === 'drafts')), 'Explicit draft import must also read the independent studio drafts');
      await page.keyboard.press('Escape');
      check('import inspection issues no write', !report.blockedWrites.some(item => item.scenario === 'fixture-import'));
      const recordsBefore = requestsFor('fixture-import').filter(item => item.path === API + '/studio/history').length;
      await page.goto(origin + '/publish-center?tab=history', { waitUntil: 'domcontentloaded' });
      await page.getByTestId('studio-history-tab').waitFor();
      await poll(() => Promise.resolve(requestsFor('fixture-import').filter(item => item.path === API + '/studio/history').length > recordsBefore), 'Direct history-tab URL must load publication records');
      check('direct history query selects publication records tab', await page.getByTestId('studio-history-tab').getAttribute('aria-current') === 'page');
      await context.close(); contexts.delete(context);
    });
    await scenario('fixture-calendar-readonly-navigation', 'GET-fixture-calendar-only', async () => {
      const { page, context } = await open('fixture-calendar', 'ready'); await noInitialImports(page, 'fixture-calendar');
      await page.getByTestId('studio-nav-calendar').click(); await page.getByTestId('studio-calendar').waitFor();
      await poll(() => Promise.resolve(requestsFor('fixture-calendar').some(item => item.path === API + '/studio/history' && item.from && item.to && item.status === 200)), 'Calendar must explicitly read owner-scoped publication records in its date window');
      const queued = fixtureRecords.find(item => item.id === uid(134)); const date = new Date(queued.publishTime);
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const day = page.getByTestId(`studio-calendar-day-${dateKey}`); await day.click();
      await page.getByTestId(`studio-history-${uid(134)}`).waitFor();
      check('calendar day renders a real-shaped fixture task rather than invented statistics', /只读夹具队列任务/u.test(await page.getByTestId('studio-calendar').innerText()));
      check('calendar selection itself does not reconcile individual records', !requestsFor('fixture-calendar').some(item => /\/publish\/records\//u.test(item.path)));
      await layout(page, 'calendar'); await capture(page, 'fixture-calendar-selected-day');
      await page.getByRole('button', { name: '下个月', exact: true }).click();
      await poll(() => studio(page).innerText().then(text => /当前已读取记录/u.test(text)), 'Empty calendar day must describe only observed records');
      check('calendar navigation does not attempt mutation', !report.blockedWrites.some(item => item.scenario === 'fixture-calendar'));
      await context.close(); contexts.delete(context);
    });
    await scenario('fixture-history-detail-relay-and-cancelled-actions', 'GET-detail-fixture-render-only', async () => {
      const { page, context } = await open('fixture-record-actions', 'ready'); await noInitialImports(page, 'fixture-record-actions');
      await page.getByTestId('studio-history-tab').click();
      await page.getByTestId(`studio-record-relay-${uid(133)}`).click();
      const detail = page.getByTestId('studio-record-detail'); await detail.waitFor();
      const relay = page.getByTestId('studio-record-relay'); await relay.waitFor();
      check('phone handoff fixture renders a local QR and visible expiry', await relay.locator('svg').count() > 0 && /有效至|有效期/u.test(await relay.innerText()));
      check('phone handoff URL comes from the explicit GET fixture', await relay.getByRole('link', { name: /打开官方接力链接/u }).getAttribute('href') === 'https://www.douyin.com/verification-fixture-never-opened');
      await capture(page, 'fixture-phone-handoff-render-only');
      await detail.getByRole('button', { name: '关闭', exact: true }).click(); await detail.waitFor({ state: 'hidden' });
      await page.getByTestId(`studio-record-detail-${uid(134)}`).click(); await detail.waitFor();
      check('queued record shows its original state and task actions', /队列中/u.test(await detail.innerText()) && await page.getByTestId('studio-record-reschedule').isVisible() && await page.getByTestId('studio-record-cancel').isVisible());
      for (const action of ['cancel', 'reschedule', 'publish-now']) {
        await page.getByTestId(`studio-record-${action}`).click();
        const confirmation = page.getByTestId('studio-record-action-confirm'); await confirmation.waitFor();
        check(`${action} confirmation is reachable before any task mutation`, await page.getByTestId('studio-record-action-submit').isVisible() && !report.blockedWrites.some(item => item.scenario === 'fixture-record-actions'));
        if (action === 'reschedule') check('reschedule confirmation exposes the current local datetime', (await page.getByTestId('studio-record-reschedule-time').inputValue()).length >= 16);
        await capture(page, `fixture-task-${action}-cancel-only`);
        await confirmation.getByRole('button', { name: '返回详情', exact: true }).click(); await detail.waitFor();
      }
      await detail.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByTestId(`studio-record-detail-${uid(135)}`).click(); await detail.waitFor();
      await page.getByTestId('studio-record-resume').click();
      const resume = page.getByTestId('studio-record-action-confirm'); await resume.waitFor();
      check('original browser plan has a cancellable restore review', /原计划|原内容/u.test(await resume.innerText()) && /不扣额度|不调用插件/u.test(await resume.innerText()));
      await capture(page, 'fixture-original-browser-plan-resume-cancel-only');
      await page.getByTestId('studio-record-action-cancel').click(); await detail.waitFor(); await page.getByTestId('studio-record-close').click();
      check('history detail reads are all isolated fixtures', requestsFor('fixture-record-actions').filter(item => /\/publish\/records\//u.test(item.path)).every(item => item.delivery === 'read-only-detail-fixture'));
      check('closing task confirmations creates no mutation or plugin execution', !report.blockedWrites.some(item => item.scenario === 'fixture-record-actions') && await page.evaluate(() => window.__studioVerification.pluginPublishCalls) === 0);
      await context.close(); contexts.delete(context);
    });
    await scenario('fixture-history-pagination', 'GET-fixture-pagination-only', async () => {
      const { page, context } = await open('fixture-history-paging', 'ready'); await noInitialImports(page, 'fixture-history-paging');
      await page.getByTestId('studio-history-tab').click(); await page.getByTestId(`studio-history-${uid(134)}`).waitFor();
      await studio(page).getByRole('button', { name: '下一页', exact: true }).click(); await page.getByTestId(`studio-history-${uid(136)}`).waitFor();
      check('second history page replaces the first without scanning all history', await page.getByTestId(`studio-history-${uid(134)}`).count() === 0 && requestsFor('fixture-history-paging').filter(item => item.path === API + '/studio/history').map(item => item.page).join(',') === '1,2');
      check('history paging uses unified owner endpoint without legacy full-list GET', !requestsFor('fixture-history-paging').some(item => item.path === API + '/v2/channels/publish/records'));
      await capture(page, 'fixture-history-second-page'); await studio(page).getByRole('button', { name: '上一页', exact: true }).click(); await page.getByTestId(`studio-history-${uid(134)}`).waitFor();
      await context.close(); contexts.delete(context);
    });
    await scenario('fixture-member-allowance-review-and-navigation', 'GET-fixture-member-render-only', async () => {
      const { page, context } = await open('fixture-member', 'membership', 'soft-white', { member: true }); await noInitialImports(page, 'fixture-member');
      await page.getByTestId('studio-accounts-tab').click();
      check('ordinary member has no admin navigation or personal supplier recharge links', await page.locator('a[href^="/admin"]').count() === 0 && !await studio(page).locator('a[href*="api-key"],a[href*="recharge"],a[href*="credits"],a[href*="pricing"]').count());
      check('member installation guide points to official only-authorization instructions', await page.getByTestId('studio-plugin-guide').getAttribute('href') === 'https://docs.aitoearn.ai/zh/use/plugin-publish' && /Authorize Only|仅授权/u.test(await studio(page).innerText()));
      await compose(page, 'image'); await page.getByTestId('studio-media-input').setInputFiles(cover);
      await page.getByTestId('studio-title').fill('会员权益只读核对'); await page.getByTestId('studio-body').fill('此内容仅用于本地界面验收，不会发布。');
      await page.getByTestId('studio-step-next').click(); await page.getByTestId(`studio-account-${accountIds.xhs}`).check(); await page.getByTestId('studio-step-next').click();
      await page.getByTestId('studio-publish-button').click(); await page.getByTestId('studio-confirm-dialog').waitFor();
      const allowance = page.getByTestId('studio-confirm-membership'); await allowance.waitFor();
      check('membership final review explains zero cash and one monthly grant before any claim', /¥0\.00/u.test(await allowance.innerText()) && /本月不会重复领取/u.test(await allowance.innerText()) && !requestsFor('fixture-member').some(item => item.path.endsWith('/publishing/membership')));
      await capture(page, 'fixture-member-allowance-cancel-only'); await page.getByTestId('studio-confirm-cancel').click();
      await context.close(); contexts.delete(context);
    });
    await scenario('fixture-admin-procurement-and-membership-policy', 'GET-fixture-admin-render-only-no-step-up', async () => {
      const { page, context } = await open('fixture-admin', 'ready', 'soft-white', { admin: true });
      for (const key of ['api', 'credits', 'plugin']) await page.getByTestId(`publishing-procurement-${key}`).waitFor();
      const policy = page.getByTestId('publishing-membership-policy'); await policy.waitFor();
      await page.getByTestId('membership-policy-profile').selectOption('qa_member:1');
      await page.getByTestId('membership-policy-plan').selectOption(`${uid(502)}:1`);
      check('new membership policy starts disabled and requires preview before save', !await page.getByTestId('membership-policy-enabled').isChecked() && await page.getByTestId('membership-policy-preview').isVisible() && await page.getByTestId('membership-policy-save').count() === 0);
      check('policy describes retained current grants and separate supplier quotas', /本月已领取额度继续使用/u.test(await policy.innerText()) && /不补发差额/u.test(await policy.innerText()) && /供应商 API 调用额度分别管理/u.test(await policy.innerText()));
      check('admin render fixture leaves step-up missing and performs no preview/save/grant', adminAccessFixture.stepUp.status === 'missing' && !report.blockedWrites.some(item => item.scenario === 'fixture-admin'));
      await page.getByTestId('publishing-procurement').scrollIntoViewIfNeeded(); await capture(page, 'fixture-admin-three-procurement-categories');
      await policy.scrollIntoViewIfNeeded(); await capture(page, 'fixture-admin-disabled-membership-policy');
      check('admin page has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
      await context.close(); contexts.delete(context);
    });
    for (const mode of ['unready', 'failure']) await scenario(`fixture-${mode}`, 'GET-fixture-ui-only', async () => {
      const { page, context } = await open(`fixture-${mode}`, mode);
      await noInitialImports(page, `fixture-${mode}`);
      await compose(page, 'text');
      check(`${mode} still shows manual editor`, await page.getByTestId('studio-title').isVisible() && await page.getByTestId('studio-body').isVisible());
      check(`${mode} cannot skip the empty draft to final publication`, await page.getByTestId('studio-step-3').isDisabled() && await page.getByTestId('studio-confirm-dialog').count() === 0);
      const text = await studio(page).innerText();
      check(`${mode} explains unavailable service`, /未开放|不可用|尚未|未就绪|暂时|读取失败|连接失败/u.test(text));
      if (mode === 'unready') {
        const notice = page.getByTestId('studio-publish-notice');
        check('closed execution ignores a contradictory stale announcement', await notice.getAttribute('data-execution') === 'disabled' && /发布执行已关闭/u.test(await notice.innerText()) && !/执行已开启|故意冲突/u.test(await notice.innerText()));
      }
      await layout(page, mode); await capture(page, `fixture-${mode}`); await context.close(); contexts.delete(context);
    });
    for (const theme of ['soft-white', 'crystal-aurora', 'lattice']) await scenario(`fixture-theme-isolation-${theme}`, 'GET-fixture-ui-only', async () => {
      const scenarioId = `fixture-theme-${theme}`, hostMode = theme === 'lattice' ? 'dark' : 'light';
      const { page, context } = await open(scenarioId, 'ready', theme); await noInitialImports(page, scenarioId);
      await headingReadability(page, `${theme} overview`); await capture(page, `fixture-theme-${theme}-overview`);
      await compose(page, 'text');
      const preferences = await page.evaluate(() => ({ theme: localStorage.getItem('user_theme_preference'), mode: localStorage.getItem('user_theme_mode_preference') }));
      check(`${theme}: studio preserves the host theme and mode`, preferences.theme === theme && preferences.mode === hostMode, preferences);
      check(`${theme}: studio has scoped light colors`, await studio(page).evaluate(element => getComputedStyle(element).colorScheme === 'light'));
      report.typography.push({ theme, hostMode, elements: await page.evaluate(() => ['publishing-studio', 'studio-title', 'studio-body'].map(testid => { const element = document.querySelector(`[data-testid="${testid}"]`), style = getComputedStyle(element); return { testid, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, color: style.color, textFillColor: style.webkitTextFillColor, backgroundColor: style.backgroundColor }; })) });
      await headingReadability(page, `${theme} compose`); await layout(page, theme); await capture(page, `fixture-theme-${theme}-compose`);
      await page.getByTestId('studio-nav-overview').click(); await page.getByTestId('studio-import-button').click(); await page.getByTestId('studio-import-dialog').waitFor();
      await headingReadability(page, `${theme} portal dialog`, true); await capture(page, `fixture-theme-${theme}-dialog`); await page.keyboard.press('Escape');
      await page.getByTestId('studio-accounts-tab').click(); await headingReadability(page, `${theme} platform accounts`); await capture(page, `fixture-theme-${theme}-accounts`);
      await context.close(); contexts.delete(context);
    });
    check('no attempted write requests in any scenario', report.blockedWrites.length === 0, report.blockedWrites);
    check('no unexpected native GET request', !report.requests.some(item => item.delivery === 'blocked-unexpected-native-get'));
    check('no unexpected admin GET request', !report.requests.some(item => item.delivery === 'blocked-unexpected-admin-get'));
    check('no browser page errors', report.pageErrors.length === 0, report.pageErrors);
    report.passed = report.scenarios.every(item => item.passed) && report.checks.every(item => item.passed);
  } catch (error) {
    report.fatal = safe(error.message).slice(0, 1400);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
    report.limitations.push('Read fixtures do not prove database readiness, platform account validity, successful upload, manifest creation, provider execution, publication, billing or history persistence.');
    report.limitations.push('The shared wrapper performs its separately bounded read-only authentication probe before this script; its media-history identity probe is not a PublishingStudio initial request.');
    report.limitations.push('Browser request interception does not inspect backend outbound HTTP. Real metadata GETs may read provider capabilities; this verification proves no browser write or publication action, not zero provider metadata traffic.');
    report.limitations.push('The admin render-only scenario supplies explicit GET fixtures and leaves step-up missing. It proves component visibility only, not real administrator authorization, policy preview/save, entitlement issuance or procurement availability.');
    const serialized = JSON.stringify(report, null, 2) + '\n';
    await fs.writeFile(path.join(output, 'report.json'), safe(serialized));
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, scenarios: report.scenarios.map(({ name, passed }) => ({ name, passed })), blockedWrites: report.blockedWrites.length, pageErrors: report.pageErrors.length, output }));
    if (!report.passed) process.exitCode = 1;
  }
}
