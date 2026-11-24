import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { chromium } from 'playwright';
import pg from 'pg';

// 卡片中心现场验收：管理员会话 + 提权会话直入数据库 → 无头浏览器打开
// /commerce/manage → 核对卡片中心聚合视图与编辑器 → API 写路径草稿验证 →
// 清理草稿。只运行，不打印任何令牌或口令。
const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '');
assert.ok(adminToken.length > 32, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
const evidencePath = String(process.env.CARD_CENTER_EVIDENCE || 'card-center-evidence.png');
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
const created = { promptVersionId: '', routeId: '' };

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
     VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','card-center-acceptance',$5)`,
    [actorId, stepUpHash, JSON.stringify(permissionKeys), revision, new Date(Date.now() + 30 * 60 * 1000).toISOString()],
  );
  await db.query('COMMIT');

  const stepUpHeaders = { Authorization: `Bearer ${adminToken}`, 'x-admin-step-up': stepUpToken, 'Content-Type': 'application/json' };

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addCookies([
    { name: 'auth_token', value: adminToken, url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'zimeiti_admin_step_up', value: stepUpToken, url: origin, httpOnly: true, sameSite: 'Strict' },
  ]);
  await context.addInitScript(token => { try { window.localStorage.setItem('auth_token', token); } catch { /* noop */ } }, adminToken);
  const page = await context.newPage();
  await page.goto(`${origin}/commerce/manage`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByText('带货 Agent 管理', { exact: false }).first().waitFor({ timeout: 60_000 });
  check('管理页解锁渲染', true, '带货 Agent 管理可见');

  const cardCenterTab = page.getByRole('button', { name: '卡片中心', exact: true });
  await cardCenterTab.waitFor({ timeout: 15_000 });
  await cardCenterTab.click();
  const list = page.locator('section[aria-label="卡片中心"]');
  await list.waitFor({ timeout: 15_000 });
  const rowsContainer = list.locator('div.mt-4.space-y-2').first();
  const rowButtons = rowsContainer.locator('> div > button');
  const rowCount = await rowButtons.count();
  check('卡片聚合行数', rowCount >= 10, `${rowCount} 行`);
  const firstRowText = await rowButtons.first().innerText();
  check('首行显示提示词版本', /提示词：.+·\s*v\d+/.test(firstRowText), firstRowText.slice(0, 80).replace(/\n/g, ' '));
  check('首行显示模型路由', /(对话模型|拆解生图模型)：/.test(firstRowText), firstRowText.slice(0, 120).replace(/\n/g, ' '));

  await rowButtons.first().click();
  const editor = rowsContainer.locator('> div').first();
  await editor.getByText('模型配置', { exact: true }).waitFor({ timeout: 10_000 });
  check('编辑器包含提示词区', (await editor.getByText('提示词（', { exact: false }).count()) >= 1);
  check('编辑器包含可见性区', (await editor.getByText('可见性', { exact: true }).count()) >= 1);
  check('编辑器包含视频路由说明', (await editor.getByText('video.generate', { exact: false }).count()) >= 1);
  await page.screenshot({ path: evidencePath, fullPage: false });
  summary.screenshot = evidencePath;

  const overview = await api('/api/admin/commerce', { headers: { 'x-admin-step-up': stepUpToken } });
  assert.equal(overview.status, 200, `OVERVIEW_${overview.status}`);
  const agentModel = (overview.body.models || []).find(model => model.kind === 'agent' && model.available);
  assert.ok(agentModel, 'AGENT_MODEL_REQUIRED');

  const verifyKey = `card-center.verify.${Date.now().toString(36)}`;
  const promptSave = await api('/api/admin/commerce/prompts', {
    method: 'POST', headers: stepUpHeaders,
    body: JSON.stringify({ kind: 'prompt', promptKey: verifyKey, name: '卡片中心验收提示词', content: '你是卡片中心验收专用提示词，仅用于读写路径验证。', changeNote: '现场验收' }),
  });
  assert.equal(promptSave.status, 201, `PROMPT_SAVE_${promptSave.status}:${JSON.stringify(promptSave.body).slice(0, 200)}`);
  created.promptVersionId = String(promptSave.body.version?.id || '');
  summary.writes.push({ kind: 'prompt-draft', id: created.promptVersionId.slice(0, 8) });

  const routeSave = await api('/api/admin/commerce/routes', {
    method: 'POST', headers: stepUpHeaders,
    body: JSON.stringify({ operationId: verifyKey, label: '卡片中心验收路由', modelKind: 'agent', primaryModelId: agentModel.id, fallbackModelIds: [], userSelectable: false, capabilityRequirements: {} }),
  });
  assert.equal(routeSave.status, 201, `ROUTE_SAVE_${routeSave.status}:${JSON.stringify(routeSave.body).slice(0, 200)}`);
  created.routeId = String(routeSave.body.version?.id || '');
  summary.writes.push({ kind: 'route-draft', id: created.routeId.slice(0, 8) });

  const reread = await api('/api/admin/commerce', { headers: { 'x-admin-step-up': stepUpToken } });
  const promptVisible = (reread.body.prompts || []).some(row => String(row.prompt_key) === verifyKey && String(row.status) === 'draft');
  const routeVisible = (reread.body.routes || []).some(row => String(row.operation_id) === verifyKey && String(row.status) === 'draft');
  check('提示词草稿回读可见', promptVisible);
  check('路由草稿回读可见', routeVisible);

  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (created.promptVersionId || created.routeId) {
    const base = String(process.env.SHARED_CONFIGURATION_SUPABASE_URL || '').replace(/\/$/u, '');
    const key = String(process.env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY || '');
    if (base && key) {
      const headers = { apikey: key, Authorization: `Bearer ${key}` };
      for (const [table, id] of [['commerce_prompt_versions', created.promptVersionId], ['commerce_operation_routes', created.routeId]]) {
        if (!id) continue;
        const response = await fetch(`${base}/rest/v1/${table}?id=eq.${id}`, { method: 'DELETE', headers }).catch(() => null);
        summary.cleanup.push({ table, id: id.slice(0, 8), status: response?.status || 'failed' });
      }
    }
  }
  await db.end().catch(() => undefined);
  if (!summary.checks.length) console.log(JSON.stringify({ ok: false, summary }, null, 2));
}
