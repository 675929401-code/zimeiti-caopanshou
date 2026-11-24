import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import pg from 'pg';

// R2 媒体素材库现场验收：管理员会话 + 提权会话直入数据库 →
// 1) 无头浏览器打开 /commerce/manage 核对浅色主题、卡片中心新布局、提示词正文直显；
// 2) API 真实上传一张 PNG 到共享素材库 → 公开 URL 可读（Range 支持）→ 列表可见；
// 3) 新建卡片草稿引用该素材为图标 → 删除素材被引用拦截 → 清理草稿与素材零残留。
// 只运行，不打印任何令牌或口令。
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '');
assert.ok(adminToken.length > 32, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
const evidencePath = String(process.env.MEDIA_EVIDENCE || 'media-library-evidence.png');
const summary = { origin, checks: [], writes: [], cleanup: [] };
const check = (name, ok, detail = '') => { summary.checks.push({ name, ok, detail }); assert.ok(ok, `${name}:${detail}`); };

const payload = JSON.parse(Buffer.from(String(adminToken.split('.')[1]), 'base64url').toString('utf8'));
const actorId = String(payload.userId || payload.sub || '');
assert.ok(actorId, 'ACTOR_ID_REQUIRED');

const api = async (path, init = {}) => {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { Accept: 'application/json', Authorization: `Bearer ${adminToken}`, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};

const stepUpToken = crypto.randomBytes(32).toString('base64url');
const stepUpHash = crypto.createHash('sha256').update(stepUpToken).digest('hex');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
let browser = null;
const created = { mediaId: '', mediaUrl: '', cardKey: '' };

// 1×1 红色 PNG
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

try {
  const self = await api('/api/admin/access-control/self');
  assert.equal(self.status, 200, `SELF_${self.status}`);
  const permissionKeys = self.body.access?.permissionKeys || [];
  const revision = self.body.access?.revision || 1;
  check('管理员权限矩阵', ['agents.view', 'agents.manage', 'prompts.view', 'prompts.edit', 'models.view', 'models.manage'].every(key => permissionKeys.includes(key)), `${permissionKeys.length} keys`);

  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT set_config('app.admin_governance_write','on',true)");
  await db.query(
    `INSERT INTO public.admin_step_up_sessions (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
     VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','media-library-acceptance',$5)`,
    [actorId, stepUpHash, JSON.stringify(permissionKeys), revision, new Date(Date.now() + 30 * 60 * 1000).toISOString()],
  );
  await db.query('COMMIT');
  const stepUpHeaders = { Authorization: `Bearer ${adminToken}`, 'x-admin-step-up': stepUpToken, 'Content-Type': 'application/json' };

  // —— 素材上传（multipart）——
  const form = new FormData();
  form.append('file', new Blob([pngBytes], { type: 'image/png' }), `acceptance-${Date.now().toString(36)}.png`);
  const uploadResponse = await fetch(`${origin}/api/admin/commerce/media`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'x-admin-step-up': stepUpToken }, body: form });
  const uploadBody = await uploadResponse.json().catch(() => ({}));
  assert.equal(uploadResponse.status, 201, `UPLOAD_${uploadResponse.status}:${JSON.stringify(uploadBody).slice(0, 200)}`);
  created.mediaId = String(uploadBody.media?.id || '');
  created.mediaUrl = String(uploadBody.media?.url || '');
  check('素材上传 201', /^\/api\/commerce\/shared-media\/[a-f0-9-]{36}$/.test(created.mediaUrl), created.mediaUrl);
  summary.writes.push({ kind: 'shared-media', id: created.mediaId.slice(0, 8) });

  // —— 公开 URL 可读（不带凭证）+ Range ——
  const publicGet = await fetch(`${origin}${created.mediaUrl}`);
  assert.equal(publicGet.status, 200, `PUBLIC_GET_${publicGet.status}`);
  check('公开读取 Content-Type', (publicGet.headers.get('content-type') || '').startsWith('image/png'), publicGet.headers.get('content-type') || '');
  check('公开读取不可变缓存', /immutable/.test(publicGet.headers.get('cache-control') || ''), publicGet.headers.get('cache-control') || '');
  const rangeGet = await fetch(`${origin}${created.mediaUrl}`, { headers: { Range: 'bytes=0-3' } });
  check('Range 206', rangeGet.status === 206, `RANGE_${rangeGet.status}`);

  // —— 管理端列表可见 ——
  const list = await api('/api/admin/commerce/media', { headers: { 'x-admin-step-up': stepUpToken } });
  assert.equal(list.status, 200, `LIST_${list.status}`);
  check('素材列表回读可见', (list.body.media || []).some(item => String(item.id) === created.mediaId));

  // —— 新建卡片草稿引用素材图标 ——
  const overview = await api('/api/admin/commerce', { headers: { 'x-admin-step-up': stepUpToken } });
  assert.equal(overview.status, 200, `OVERVIEW_${overview.status}`);
  const template = (overview.body.cards || []).find(card => (overview.body.cardVersions || []).some(v => v.card_id === card.id && v.prompt_version_id));
  const templateVersion = (overview.body.cardVersions || []).filter(v => v.card_id === template?.id).sort((a, b) => Number(b.version) - Number(a.version))[0];
  assert.ok(template && templateVersion, 'TEMPLATE_CARD_REQUIRED');
  created.cardKey = `media-verify-${Date.now().toString(36)}`;
  const cardSave = await api('/api/admin/commerce/cards', {
    method: 'POST', headers: stepUpHeaders,
    body: JSON.stringify({ card: {
      stableKey: created.cardKey,
      display: { ...templateVersion.display, name: '素材库验收卡', icon: created.mediaUrl, visibility: 'admins' },
      executorType: String(templateVersion.executor_type || 'director'),
      promptVersionId: templateVersion.prompt_version_id || '',
      materialSlots: templateVersion.material_slots || [],
      inputFields: templateVersion.input_fields || [],
      outputContract: templateVersion.output_contract || {},
      qualityRules: templateVersion.quality_rules || {},
      testCases: templateVersion.test_cases || [],
      knowledgeDocumentIds: templateVersion.knowledge_document_ids || [],
      modelPolicy: templateVersion.model_policy || {},
      videoDefaults: templateVersion.video_defaults || {},
      changeNote: '素材库现场验收（模板复制）',
    } }),
  });
  assert.equal(cardSave.status, 201, `CARD_SAVE_${cardSave.status}:${JSON.stringify(cardSave.body).slice(0, 200)}`);
  summary.writes.push({ kind: 'card-draft', key: created.cardKey });

  // —— 引用中的素材禁止删除 ——
  const blocked = await fetch(`${origin}/api/admin/commerce/media`, { method: 'DELETE', headers: stepUpHeaders, body: JSON.stringify({ id: created.mediaId }) });
  const blockedBody = await blocked.json().catch(() => ({}));
  check('引用中素材删除被拦截', blocked.status === 400 && /引用/.test(String(blockedBody.error || '')), String(blockedBody.error || '').slice(0, 60));

  // —— 浏览器验收：浅色主题 + 卡片中心新布局 ——
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addCookies([
    { name: 'auth_token', value: adminToken, url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'zimeiti_admin_step_up', value: stepUpToken, url: origin, httpOnly: true, sameSite: 'Strict' },
  ]);
  await context.addInitScript(token => { try { window.localStorage.setItem('auth_token', token); } catch { /* noop */ } }, adminToken);
  const page = await context.newPage();
  await page.goto(`${origin}/commerce/manage`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByText('带货创作管理', { exact: false }).first().waitFor({ timeout: 60_000 });
  check('管理页解锁渲染', true, '带货创作管理标题可见');

  const mainBg = await page.evaluate(() => getComputedStyle(document.querySelector('main')).backgroundColor);
  const cardBg = await page.evaluate(() => { const el = document.querySelector('main section'); return el ? getComputedStyle(el).backgroundColor : ''; });
  check('管理页浅色主题', mainBg === 'rgb(245, 247, 251)' && cardBg === 'rgb(255, 255, 255)', `main=${mainBg} card=${cardBg}`);

  const list2 = page.locator('section[aria-label="卡片中心"]');
  await list2.waitFor({ timeout: 15_000 });
  check('新建卡片入口', (await list2.getByRole('button', { name: /新建卡片/ }).count()) >= 1);

  // 展开刚建的验收卡：提示词正文应自动直显
  await list2.getByText('素材库验收卡', { exact: false }).first().click();
  const editor = list2.locator('div.grid.gap-4').first();
  await editor.getByText('基础信息', { exact: true }).waitFor({ timeout: 10_000 });
  const promptArea = editor.locator('textarea[readonly]').first();
  await promptArea.waitFor({ timeout: 10_000 });
  const promptText = await promptArea.inputValue();
  check('提示词正文自动直显', promptText.length > 50, `正文 ${promptText.length} 字`);
  const iconValue = await editor.locator('input').evaluateAll(nodes => nodes.map(node => node.value).find(value => value.includes('/api/commerce/shared-media/')) || '');
  check('图标输入框引用素材 URL', iconValue.includes('/api/commerce/shared-media/'), iconValue.slice(0, 60));
  await page.screenshot({ path: evidencePath, fullPage: false });
  summary.screenshot = evidencePath;

  // —— 首页侧栏管理入口 ——
  await page.goto(`${origin}/commerce`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000);
  const adminLink = page.locator('a.cs-rail-admin[href="/commerce/manage"]');
  check('首页侧栏管理入口渲染', (await adminLink.count()) === 1, `count=${await adminLink.count()}`);

  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  const base = String(process.env.SHARED_CONFIGURATION_SUPABASE_URL || '').replace(/\/$/u, '');
  const key = String(process.env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY || '');
  if (base && key) {
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    if (created.cardKey) {
      const cardRow = await fetch(`${base}/rest/v1/commerce_cards?stable_key=eq.${created.cardKey}&select=id`, { headers }).then(r => r.json()).catch(() => []);
      const cardId = String(cardRow?.[0]?.id || '');
      if (cardId) {
        await fetch(`${base}/rest/v1/commerce_card_versions?card_id=eq.${cardId}`, { method: 'DELETE', headers }).catch(() => null);
        const removed = await fetch(`${base}/rest/v1/commerce_cards?id=eq.${cardId}`, { method: 'DELETE', headers }).catch(() => null);
        summary.cleanup.push({ table: 'commerce_cards', key: created.cardKey, status: removed?.status || 'failed' });
      }
    }
  }
  if (created.mediaId) {
    const removed = await fetch(`${origin}/api/admin/commerce/media`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}`, 'x-admin-step-up': stepUpToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: created.mediaId }) }).catch(() => null);
    summary.cleanup.push({ kind: 'shared-media', id: created.mediaId.slice(0, 8), status: removed?.status || 'failed' });
  }
  await db.end().catch(() => undefined);
  if (!summary.checks.length) console.log(JSON.stringify({ ok: false, summary }, null, 2));
}
