#!/usr/bin/env node
// Explicit account audit: GET only. Do not emit identity, authentication fields,
// free-form descriptions, metadata values, IPs, user agents or payment URLs.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env.local'), quiet: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const recordId = value => typeof value === 'string' && uuid.test(value) ? value : (typeof value === 'number' ? value : null);
const enumValue = value => typeof value === 'string' && /^[a-z][a-z0-9_:.-]{0,50}$/iu.test(value) && !/\d{11}/u.test(value) ? value : null;
const numeric = value => value === null || value === undefined ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
function originSignals(row) {
  const text = `${row.description || ''} ${JSON.stringify(row.metadata || {})} ${row.reference_id || ''} ${row.source_id || ''}`.toLowerCase();
  return {
    mentionsFixture: /e2e|fixture|sandbox|验收|测试/u.test(text),
    mentionsImage: /image|生图|图片/u.test(text),
    mentionsVideo: /video|视频/u.test(text),
    mentionsAdmin: /admin|管理员|手动/u.test(text),
    mentionsRecharge: /topup|recharge|充值/u.test(text),
    mentionsRefund: /refund|退款|退还/u.test(text),
    mentionsRegistration: /register|registration|注册|邀请/u.test(text),
  };
}

async function main() {
  const phone = process.env.ACCOUNT_CASH_AUDIT_PHONE?.trim();
  const base = process.env.COZE_SUPABASE_URL?.trim();
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!phone || !/^1\d{10}$/u.test(phone) || !base || !key) throw new Error('AUDIT_CONFIGURATION_REQUIRED');
  const rest = new URL('rest/v1/', base.endsWith('/') ? base : `${base}/`);
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Accept-Profile': 'public' };
  async function read(table, columns, filters, order = 'created_at.asc') {
    const rows = [];
    let complete = false;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(table, rest);
      url.searchParams.set('select', columns.join(','));
      url.searchParams.set('limit', '200');
      url.searchParams.set('offset', String(page * 200));
      if (order) url.searchParams.set('order', order);
      for (const [name, value] of Object.entries(filters)) url.searchParams.set(name, value);
      const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload)) return { ok: false, httpStatus: response.status, errorCode: enumValue(payload?.code), rows: [], complete: false };
      rows.push(...payload);
      if (payload.length < 200) { complete = true; break; }
    }
    return { ok: true, rows, complete };
  }
  const lookup = await read('users', ['id','username','email','role','is_active','status','member_status','created_at','updated_at','last_sign_in_at','credits','cash_balance','total_credits_recharged','total_credits_consumed','total_cash_recharged','total_cash_consumed','invited_by','allowed_categories'], { phone: `eq.${phone}` });
  if (!lookup.ok || lookup.rows.length !== 1) throw new Error('TARGET_ACCOUNT_NOT_UNIQUE_OR_UNAVAILABLE');
  const user = lookup.rows[0];
  if (!uuid.test(String(user.id))) throw new Error('TARGET_ID_NOT_UUID');
  const byUser = { user_id: `eq.${user.id}` };
  const definitions = [
    ['cash_transactions', ['id','type','amount','balance_after','description','reference_id','metadata','created_at'], byUser],
    ['credit_transactions', ['id','type','transaction_type','amount','balance_after','description','metadata','created_at'], byUser],
    ['balance_audit_log', ['id','field','old_value','new_value','delta','source','source_id','operator_id','created_at'], byUser],
    ['payment_orders', ['id','type','amount','credits_amount','status','payment_method','payment_provider','paid_at','created_at'], byUser],
    ['login_logs', ['id','login_method','status','created_at'], byUser],
    ['cami_codes', ['id','credits','cash_balance','is_used','used_at','created_at'], { used_by: `eq.${user.id}` }],
    ['invitation_records', ['id','invitee_activated','invited_at','activated_at','reward_sent'], { invitee_id: `eq.${user.id}` }, 'invited_at.asc'],
    ['user_trial_activations', ['id','activated_at','expires_at','credits_granted','is_active','created_at'], byUser],
    ['revenue_records', ['id','record_type','cost_price','selling_price','profit','credits_charged','cash_charged','created_at'], byUser],
  ];
  const queried = await Promise.all(definitions.map(async ([table, columns, filters, order]) => ({ table, ...(await read(table, columns, filters, order)) })));
  const tables = queried.map(result => ({
    table: result.table, readable: result.ok, complete: result.complete, errorCode: result.errorCode || null, count: result.rows.length,
    records: result.rows.map(row => ({
      recordId: recordId(row.id), createdAt: row.created_at || row.invited_at || null,
      type: enumValue(row.type || row.record_type), status: enumValue(row.status), field: enumValue(row.field), source: enumValue(row.source),
      amount: numeric(row.amount), balanceAfter: numeric(row.balance_after), oldValue: numeric(row.old_value), newValue: numeric(row.new_value), delta: numeric(row.delta),
      credits: numeric(row.credits ?? row.credits_amount ?? row.credits_granted), cash: numeric(row.cash_balance), cost: numeric(row.cost_price), sellingPrice: numeric(row.selling_price), creditsCharged: numeric(row.credits_charged), cashCharged: numeric(row.cash_charged),
      paidAt: row.paid_at || null, usedAt: row.used_at || null, activatedAt: row.activated_at || null, isUsed: typeof row.is_used === 'boolean' ? row.is_used : null,
      rewardSent: typeof row.reward_sent === 'boolean' ? row.reward_sent : null, operatorPresent: Boolean(row.operator_id), sourceReferencePresent: Boolean(row.source_id || row.reference_id),
      loginMethod: enumValue(row.login_method), originSignals: originSignals(row),
    })),
  }));
  const report = {
    readOnly: true, method: 'GET_ONLY_TARGETED_ACCOUNT_AND_LEDGER', observedAt: new Date().toISOString(),
    target: { recordId: user.id, createdAt: user.created_at, updatedAt: user.updated_at, lastSignInAt: user.last_sign_in_at, role: enumValue(user.role), isActive: user.is_active, status: enumValue(user.status), memberStatus: enumValue(user.member_status), credits: numeric(user.credits), cashBalance: numeric(user.cash_balance), totalCreditsRecharged: numeric(user.total_credits_recharged), totalCreditsConsumed: numeric(user.total_credits_consumed), totalCashRecharged: numeric(user.total_cash_recharged), totalCashConsumed: numeric(user.total_cash_consumed), hasInviter: Boolean(user.invited_by), noAssignedCategories: Array.isArray(user.allowed_categories) && user.allowed_categories.length === 0, hasE2EUserName: /^e2e[_-]/iu.test(user.username || ''), hasReservedTestEmail: /@(?:example\.invalid|example\.test|test\.invalid)$/iu.test(user.email || '') },
    tables,
    unavailableEvidence: ['password_audit_log (absent in current schema)', 'direct SQL/import execution logs and historical caller identity', 'no login timestamp is not proof no authenticated API calls occurred'],
    sensitiveValuesEmitted: false,
  };
  const outputArg = process.argv.find(argument => argument.startsWith('--output='));
  if (!outputArg) throw new Error('LOCAL_EVIDENCE_OUTPUT_REQUIRED');
  const output = path.resolve(root, outputArg.slice('--output='.length));
  if (!output.startsWith(`${path.join(root, '.codex-evidence')}${path.sep}`)) throw new Error('OUTPUT_OUTSIDE_EVIDENCE');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}

main().catch(() => { console.error('ACCOUNT_CASH_READONLY_AUDIT_FAILED (sensitive details suppressed)'); process.exitCode = 1; });
