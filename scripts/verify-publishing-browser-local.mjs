#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import { chromium } from 'playwright';

export async function main() {
  const origin = 'http://127.0.0.1:5000';
  assert.equal(process.env.LOCAL_NAV_ORIGIN, origin);
  const adminToken = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const adminIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || 'null');
  const step = process.env.LOCAL_ADMIN_STEP_UP_TOKEN;
  assert.ok(adminToken && adminIdentity?.user?.id && step);
  const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(runtime.localOnly, true);
  assert.equal(runtime.ownerConnection?.host, '127.0.0.1');
  assert.equal(Number(runtime.ownerConnection?.port), 54322);
  assert.equal(runtime.ownerConnection?.database, 'zimeiti_local');
  assert.notEqual(process.env.PUBLISHING_EXTERNAL_EXECUTION_ENABLED, 'true');
  const directory = path.resolve('.codex-evidence/publish-center-20261109-c12aa131/browser');
  await fs.mkdir(directory, { recursive: true });
  const report = { passed: false, checks: [], screenshots: [], errors: [], blockedWrites: [], externalRequestsBlocked: 0, paidCalls: 0, realPosts: 0, fixtureCleaned: false };
  const check = (name, value, detail) => { report.checks.push({ name, passed: Boolean(value), ...(detail ? { detail } : {}) }); assert.ok(value, name); };
  const save = () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  const database = new pg.Client({ ...runtime.ownerConnection, application_name: 'codex-publishing-browser-fixture' });
  const userId = randomUUID(), sessionId = `publish-browser-${randomUUID()}`;
  const username = `pub-ui-${userId.replaceAll('-', '')}`;
  const user = { id: userId, username, displayName: '发布中心本地验收', display_name: '发布中心本地验收', role: 'student', memberStatus: 'active', sessionId };
  let browser, inserted = false;
  const request = async (route, token, body, stepUp = false) => {
    const response = await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(stepUp ? { 'x-admin-step-up': step } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    return { status: response.status, data: await response.json() };
  };
  const snap = async (page, name) => { const file = path.join(directory, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push({ name, file }); };
  try {
    await database.connect();
    const identity = (await database.query('SELECT current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0];
    assert.deepEqual(identity, { db: 'zimeiti_local', host: '127.0.0.1', port: 54322 });
    await database.query('BEGIN');
    await database.query("SELECT set_config('app.member_permission_write','on',true)");
    await database.query("INSERT INTO public.users(id,username,email,password_hash,display_name,role,credits,cash_balance,is_active,status,member_status,session_id) VALUES($1,$2,$3,'local-unusable-password-hash','发布中心本地验收','student',0,0,true,'active','active',$4)", [userId, username, `${username}@fixture.invalid`, sessionId]);
    const features = JSON.stringify(['marketplace', 'toolbox', 'storyboard_workbench', 'create', 'voice', 'cover', 'publish_center', 'youcai', 'commerce_agent']);
    await database.query("INSERT INTO public.member_permission_assignments(user_id,feature_navigation_keys,agent_navigation_keys,revision,checksum,source,reason) VALUES($1::text,$2::jsonb,'[]',1,public.member_permission_checksum($1::text,$2::jsonb,'[]',1),'custom','isolated local browser fixture') ON CONFLICT(user_id) DO UPDATE SET feature_navigation_keys=EXCLUDED.feature_navigation_keys,agent_navigation_keys='[]',revision=1,checksum=EXCLUDED.checksum", [userId, features]);
    await database.query("INSERT INTO public.user_auth_sessions(user_id,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour') ON CONFLICT(session_id) DO NOTHING", [userId, sessionId]);
    await fs.writeFile(path.join(directory, 'temporary-fixture.json'), JSON.stringify({ userId, username, createdAt: new Date().toISOString(), scope: 'new browser fixture only; revoke sessions, deactivate the exact owner, archive drafts, retain isolated immutable audit rows' }));
    inserted = true; // Cleanup is required even if COMMIT's response is lost.
    await database.query('COMMIT');
    const token = await new SignJWT({ userId, username, role: 'student', displayName: user.displayName, sessionId }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('30m').sign(new TextEncoder().encode(runtime.jwtSecret));
    report.runtime = (await request('/api/version', token)).data;
    report.scope = { actualLocalPublishingApi: true, actualLocalStudioDrafts: true, currentStudioUi: true, legacyWorkbenchMock: 'removed; current Studio coverage runs in verify-publishing-studio-ui.mjs', unrelatedAnnouncements: 'empty read fixture, no read-state writes' };
    const state = await request('/api/publish-center', token);
    check('real member API uses fixture permission and ready local schema', state.status === 200 && state.data.schemaReady && state.data.access.allowed);
    check('sales and external execution stay disabled', !state.data.config.salesEnabled && !state.data.config.executionEnabled);
    check('public state excludes procurement and operator configuration', !('operatorLinks' in state.data.config) && !('procurementNotes' in state.data.config));
    const deniedAdmin = await request('/api/admin/publishing', token);
    check('ordinary member cannot read administrator procurement configuration', deniedAdmin.status === 403);
    const tampered = await request('/api/publish-center', token, { action: 'purchase', planId: randomUUID(), planVersion: 1, idempotencyKey: `ui-tamper-${randomUUID()}`, priceCents: 1 });
    check('client supplied price is rejected before any transaction', tampered.status === 400 && tampered.data.code === 'PUBLISH_INPUT_INVALID');
    const purchase = await request('/api/publish-center', token, { action: 'purchase', planId: randomUUID(), planVersion: 1, idempotencyKey: `ui-gate-${randomUUID()}` });
    check('closed runtime prevents purchase without touching wallet', purchase.status === 409 && purchase.data.code === 'PUBLISH_SALES_DISABLED');
    const locked = await request('/api/admin/publishing', adminToken, { action: 'save-config', config: { expectedVersion: 1, executionEnabled: false, salesEnabled: false, enabledPlatforms: [], announcement: '', operatorLinks: { officialUrl: null, docsUrl: null, apiKeyUrl: null, contactUrl: null, pluginUrl: null }, procurementNotes: '', procurementVerifiedAt: null } });
    check('sensitive admin write requires actual existing step-up authority', locked.status === 428 && locked.data.code === 'ADMIN_STEP_UP_REQUIRED');
    const admin = await request('/api/admin/publishing', adminToken, null, true);
    check('admin API reads real configuration under existing capabilities', admin.status === 200 && admin.data.schemaReady);
    const refused = await request('/api/admin/publishing', adminToken, { action: 'save-config', config: { expectedVersion: admin.data.config.version, executionEnabled: true, salesEnabled: true, enabledPlatforms: ['xhs'], announcement: admin.data.config.announcement, operatorLinks: admin.data.config.operatorLinks, procurementNotes: '', procurementVerifiedAt: new Date().toISOString() } }, true);
    check('admin UI switch cannot override runtime sales gate', refused.status === 409 && refused.data.code === 'PUBLISH_SALES_NOT_READY');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const contexts = [];
    for (const theme of ['soft-white', 'lattice', 'crystal-aurora']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' }); contexts.push(context);
      await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      await context.addInitScript(({ token, user, theme }) => {
        localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('entered_app', '1'); localStorage.setItem('user_theme_preference', theme); localStorage.setItem('user_theme_mode_preference', theme === 'soft-white' ? 'light' : 'dark'); localStorage.setItem('user_theme_preference_expires_at', new Date(Date.now()+3600000).toISOString());
      }, { token, user, theme });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { report.externalRequestsBlocked++; return route.abort('blockedbyclient'); }
        if (url.pathname === '/api/announcements/inbox') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ announcements: [], cursor: '' }) });
        if (url.pathname === '/api/popup-pushes') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, popups: [] }) });
        if (url.pathname === '/api/auth/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { ...user, themePreference: theme, themeModePreference: theme === 'soft-white' ? 'light' : 'dark', themePreferenceExpiresAt: new Date(Date.now()+3600000).toISOString() } }) });
        if (!['GET', 'HEAD'].includes(request.method())) {
          const body = request.postDataJSON();
          if (url.pathname !== '/api/native-operations/publishing/generic' || body?.action !== 'save-draft') { report.blockedWrites.push({ path: url.pathname, method: request.method() }); return route.abort('blockedbyclient'); }
        }
        return route.continue();
      });
      const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message.slice(0,300)));
      await page.goto(origin+'/publish-center', { waitUntil: 'networkidle' });
      const root = page.getByTestId('publishing-studio'); await root.waitFor();
      await page.getByRole('heading', { name: '从这里，发布好作品', exact: true }).waitFor();
      await page.getByTestId('studio-overview').waitFor();
      await page.waitForFunction(theme => document.documentElement.getAttribute('data-theme') === theme, theme);
      const colors = await root.evaluate(el => { const c = getComputedStyle(el); const h = el.querySelector('h1'), hc = getComputedStyle(h); return { theme: document.documentElement.getAttribute('data-theme'), colorScheme: c.colorScheme, backgroundImage: c.backgroundImage, ink: c.color, heading: hc.color, headingFill: hc.webkitTextFillColor, headingBackground: hc.backgroundImage, width: el.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > innerWidth }; });
      check(`Studio fixed light palette under ${theme}`, colors.colorScheme === 'light' && colors.backgroundImage.includes('radial-gradient') && colors.backgroundImage.includes('linear-gradient') && colors.ink === 'rgb(24, 24, 27)' && colors.heading === 'rgba(0, 0, 0, 0)' && colors.headingFill === 'rgba(0, 0, 0, 0)' && colors.headingBackground.includes('linear-gradient') && !colors.overflow, colors);
      const notice = page.getByTestId('studio-publish-notice');
      check(`closed runtime has accurate execution notice under ${theme}`, await notice.getAttribute('data-execution') === 'disabled' && /发布执行已关闭/u.test(await notice.innerText()) && !/执行已开启|仅限本机测试/u.test(await notice.innerText()));
      check(`overview has no premature publish action under ${theme}`, await page.getByTestId('studio-publish-button').count() === 0);
      await snap(page, `publish-${theme}`);
      if (theme === 'soft-white') {
        await page.setViewportSize({ width: 1920, height: 1080 });
        check('1920 desktop keeps page within viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await snap(page, 'publish-1920');
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      await page.goto(origin+'/publish-center?tab=accounts', { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: '平台账号', exact: true }).waitFor();
      check(`direct accounts link works under ${theme}`, await page.getByTestId('studio-accounts-tab').getAttribute('aria-current') === 'page');
      if (theme === 'soft-white') {
        await snap(page, 'publish-accounts');
        await page.goto(origin+'/publish-center?tab=compose', { waitUntil: 'networkidle' });
        await page.getByTestId('studio-type-text').click();
        await page.getByTestId('studio-title').fill('本地验收临时草稿');
        await page.getByTestId('studio-body').fill('仅保存到隔离本地发布服务，不连接账号、不提交外部平台。');
        await page.getByRole('button', { name: '保存发布草稿', exact: true }).click();
        await page.getByText('稿件与所选账号的素材、发布参数和排期已完整保存', { exact: true }).waitFor();
        const persistedResponse = await fetch(`${origin}/api/native-operations/publishing/generic?resource=drafts&pageSize=100`, { headers: { Cookie: `auth_token=${token}`, 'X-Native-Actor-Id': userId }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
        const persisted = { status: persistedResponse.status, data: await persistedResponse.json() };
        const persistedItems = Array.isArray(persisted.data?.data?.items) ? persisted.data.data.items : [];
        check('Studio text draft saves to actual owner-scoped local service', persisted.status === 200 && persisted.data.code === 0 && persistedItems.some(d => d.title === '本地验收临时草稿'), { status: persisted.status, code: persisted.data?.code, titles: persistedItems.map(item => item.title), response: persisted.data?.data });
        await page.getByTestId('studio-history-tab').click(); await page.getByRole('heading', { name: '发布记录', exact: true }).waitFor(); await snap(page, 'publish-history');
        for (const [route, name] of [['/cover','neighbor-cover'], ['/youcai','neighbor-youcai'], ['/','neighbor-marketplace']]) {
          await page.goto(origin+route, { waitUntil: 'networkidle' });
          const neighborText = await page.locator('body').innerText();
          check(`adjacent page renders ${route}`, route === '/youcai' ? neighborText.includes('漫剧创作') && (neighborText.includes('正在开发中') || neighborText.length > 100) : neighborText.length > 100);
          await snap(page, name);
          if (route === '/') check('main navigation contains publish center', await page.getByText('发布中心', { exact: true }).count() > 0);
        }
      }
      await context.close();
    }
    report.currentStudioSuite = 'scripts/verify-publishing-studio-ui.mjs';
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { Authorization: `Bearer ${adminToken}`, 'x-admin-step-up': step } });
    await adminContext.addCookies([{ name: 'auth_token', value: adminToken, url: origin, httpOnly: true }, { name: 'zimeiti_admin_step_up', value: step, url: origin, httpOnly: true }]);
    await adminContext.addInitScript(({ token, identity }) => { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(identity.user)); sessionStorage.setItem('entered_app', '1'); }, { token: adminToken, identity: adminIdentity });
    await adminContext.route('**/*', route => { const r=route.request(), url=new URL(r.url()); if(url.origin!==origin) { report.externalRequestsBlocked++; return route.abort('blockedbyclient'); } if(url.pathname==='/api/auth/me') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(adminIdentity)}); if(!['GET','HEAD'].includes(r.method())) return route.abort('blockedbyclient'); return route.continue(); });
    const page = await adminContext.newPage(); page.on('pageerror', error => report.errors.push(error.message.slice(0,300)));
    await page.goto(origin+'/admin?tab=publishing', { waitUntil: 'networkidle' });
    await page.getByTestId('publishing-admin').waitFor();
    await page.getByTestId('publishing-service-config').waitFor();
    await page.getByTestId('publishing-cash-pricing').waitFor();
    check('admin panel exposes current service config and cash pricing', await page.getByTestId('publishing-service-config').isVisible() && await page.getByTestId('publishing-cash-pricing').isVisible());
    check('admin runtime gate remains visibly closed', await page.getByText('执行门禁未开放', { exact: true }).isVisible());
    check('admin panel keeps site admin layout and procurement links', await page.getByTestId('publishing-procurement').isVisible());
    await snap(page, 'admin-publishing');
    await adminContext.close();
    check('no browser JavaScript exceptions', report.errors.length === 0);
    report.passed = true;
  } catch (error) {
    report.error = String(error.message).slice(0,600); process.exitCode = 1;
    if (browser) for (const [i, context] of browser.contexts().entries()) {
      const activePage = context.pages().at(-1);
      if (activePage && !activePage.isClosed()) {
        await activePage.screenshot({ path: path.join(directory, `failure-${i}.png`), fullPage: true }).catch(()=>{});
        const body = await activePage.locator('body').innerText().catch(()=> 'unavailable');
        await fs.writeFile(path.join(directory, `failure-${i}.json`), JSON.stringify({ url: activePage.url(), body: body.slice(0,8000) }));
      }
    }
  }
  finally {
    await browser?.close();
    if (inserted) {
      await database.query('BEGIN');
      try {
        await database.query("SELECT set_config('app.member_permission_write','on',true)");
        // Draft versions and request receipts are deliberately immutable. Do
        // not disable history triggers for a browser test. Isolate the owner,
        // revoke access and hide its drafts while retaining that audit chain.
        await database.query('DELETE FROM public.user_auth_sessions WHERE user_id=$1', [userId]);
        await database.query('UPDATE public.pub5_studio_drafts SET archived=true,updated_at=now() WHERE owner_id=$1', [userId]);
        await database.query("UPDATE public.users SET is_active=false,status='blocked',session_id=null WHERE id=$1 AND username=$2", [userId, username]);
        await database.query('COMMIT');
        const [owner, sessions, visibleDrafts, auditVersions] = await Promise.all([
          database.query('SELECT is_active,status,session_id FROM public.users WHERE id=$1 AND username=$2', [userId, username]),
          database.query('SELECT count(*)::int count FROM public.user_auth_sessions WHERE user_id=$1', [userId]),
          database.query('SELECT count(*)::int count FROM public.pub5_studio_drafts WHERE owner_id=$1 AND archived=false', [userId]),
          database.query('SELECT count(*)::int count FROM public.pub5_draft_profiles WHERE owner_id=$1', [userId]),
        ]);
        report.fixtureRetention = { mode: 'deactivated-owner-archived-drafts-immutable-audit-retained', auditVersions: auditVersions.rows[0].count };
        report.fixtureCleaned = owner.rows[0]?.is_active === false && owner.rows[0]?.status === 'blocked' && owner.rows[0]?.session_id === null && sessions.rows[0].count === 0 && visibleDrafts.rows[0].count === 0;
      } catch (error) { await database.query('ROLLBACK'); report.cleanupError=String(error.message).slice(0,200); process.exitCode=1; report.passed=false; }
    } else { await database.query('ROLLBACK').catch(()=>{}); }
    await database.end();
    if (!report.fixtureCleaned) { report.passed=false; process.exitCode=1; }
    await save(); console.log(JSON.stringify({ passed:report.passed, checks:report.checks.length, fixtureCleaned:report.fixtureCleaned, screenshots:report.screenshots.length, error:report.error, cleanupError:report.cleanupError }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
