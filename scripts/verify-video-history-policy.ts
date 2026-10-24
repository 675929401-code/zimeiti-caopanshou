import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as policy from '../src/lib/video-history-policy';
import * as archive from '../src/lib/storyboard-video-archive-policy';
import * as digitalHuman from '../src/lib/digital-human-task';
import * as presentation from '../src/lib/video-history-presentation';
import { createClient } from '@supabase/supabase-js';

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3600000).toISOString();
const settled = { status: 'completed', billingState: 'settled', createdAt: ago(150), completedAt: ago(119) };
assert.equal(policy.isVideoHistoryExpired(settled, now), false);
assert.equal(policy.isVideoHistoryExpired({ ...settled, completedAt: ago(120) }, now), true);
assert.equal(policy.isVideoHistoryExpired({ ...settled, taskLabel: '分镜工作台', completedAt: ago(200) }, now), false, 'media expiry must keep storyboard task and fee audit');
assert.equal(policy.isVideoHistoryExpired({ status: 'completed', billing_state: 'settled', created_at: ago(120) }, now), true);
for (const billingState of ['', 'unknown', 'usage_pending', 'billing_review', 'quote_exceeded', 'settled_pending_commit']) {
  assert.equal(policy.isVideoHistoryProtected({ ...settled, billingState }), true);
  assert.equal(policy.isVideoHistoryExpired({ ...settled, billingState, completedAt: ago(200) }, now), false);
}
// Rows created before billing tracking existed carry no billing state at all.
// They can never become settled, so "missing" must not mean "pending forever":
// it follows the same five-day retention and stays clearable.
for (const billingState of [null, undefined]) {
  assert.equal(policy.isVideoHistoryProtected({ ...settled, billingState }), false);
  assert.equal(policy.isVideoHistoryExpired({ ...settled, billingState, completedAt: ago(200) }, now), true);
  assert.equal(policy.isVideoHistoryExpired({ ...settled, billingState, completedAt: ago(24) }, now), false);
  assert.equal(policy.isVideoHistoryProtected({ ...settled, billingState, status: 'processing' }), true);
}
// A job the provider accepted may still settle, but only inside the window.
{
  const submitted = { ...settled, billingState: 'provider_submitted' };
  assert.equal(policy.isVideoHistoryProtected({ ...submitted, completedAt: ago(24) }, now), true);
  assert.equal(policy.isVideoHistoryExpired({ ...submitted, completedAt: ago(24) }, now), false);
  assert.equal(policy.isVideoHistoryProtected({ ...submitted, completedAt: ago(200) }, now), false);
  assert.equal(policy.isVideoHistoryExpired({ ...submitted, completedAt: ago(200) }, now), true);
}
assert.equal(policy.isVideoHistoryExpired({ ...settled, createdAt: 'invalid', completedAt: 'invalid' }, now), false);
assert.equal(policy.isVideoHistoryExpired({ ...settled, status: 'unknown', completedAt: ago(200) }, now), false);
assert.equal(policy.isVideoHistoryExplicitlyHidden({ historyHiddenAt: '2026-10-18T08:00:00+08:00', sourceExpiredAt: '2026-10-18T00:00:00.000Z' }), false);
assert.equal(policy.isVideoHistoryExplicitlyHidden({ historyHiddenAt: '2026-10-18T00:00:00.001Z', sourceExpiredAt: '2026-10-18T00:00:00.000Z' }), true);
assert.equal(policy.isVideoHistoryExplicitlyHidden({ historyHiddenAt: 'invalid', sourceExpiredAt: 'invalid' }), true);
const grouped = policy.groupVideoHistory([
  { ...settled, id: 'a-old', batchId: 'batch-a', cardIndex: 0, createdAt: ago(30) },
  { ...settled, id: 'a-new', batchId: 'batch-a', cardIndex: 0, createdAt: ago(1) },
  { ...settled, id: 'a-one', batchId: 'batch-a', cardIndex: 1, createdAt: ago(2) },
  { ...settled, id: 'b-zero', batchId: 'batch-b', cardIndex: 0, createdAt: ago(0.5) },
], now);
const batches = grouped.flatMap((day) => day.batches);
assert.equal(batches.length, 2);
assert.deepEqual(batches[1].items.map((item) => item.id), ['a-new', 'a-old', 'a-one']);
assert.equal(policy.groupVideoHistory([{ ...settled, taskId: 'independent-a' }, { ...settled, taskId: 'independent-b' }], now).flatMap((day) => day.batches).length, 2);

type Row = Record<string, unknown>;
let rows: Row[] = [];
const writes: Row[] = [];
let thumbnailCalls = 0;
const filterExpressions: string[] = [];
const splitFilter = (value: string): string[] => {
  let depth = 0; let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '(') depth++;
    if (value[index] === ')') depth--;
    if (value[index] === ',' && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
  }
  parts.push(value.slice(start));
  return parts;
};
const evaluateFilter = (row: Row, expression: string): boolean => {
  if (expression.startsWith('and(')) return splitFilter(expression.slice(4, -1)).every((part) => evaluateFilter(row, part));
  if (expression.startsWith('or(')) return splitFilter(expression.slice(3, -1)).some((part) => evaluateFilter(row, part));
  const match = expression.match(/^([^.]+)\.(not\.)?(in|is|like|lte|gt)\.(.*)$/);
  assert.ok(match, `unsupported filter ${expression}`);
  const [, key, not, operation, expected] = match;
  const actual = row[key] ?? null;
  const result = operation === 'is' ? actual === (expected === 'null' ? null : expected)
    : operation === 'in' ? splitFilter(expected.slice(1, -1)).includes(String(actual))
    : operation === 'like' ? actual !== null && String(actual).startsWith(expected.replace(/%$/, ''))
    : actual !== null && (operation === 'lte' ? String(actual) <= expected : String(actual) > expected);
  return not ? actual !== null && !result : result;
};
class Query {
  predicates: ((row: Row) => boolean)[] = [];
  start = 0; end = Infinity; single = false; updateValue?: Row;
  selectFields?: string[];
  select(fields?: string) { this.selectFields = fields?.split(',').map((field) => field.trim()); return this; }
  eq(key: string, value: unknown) { this.predicates.push((row) => row[key] === value); return this; }
  is(key: string, value: unknown) { this.predicates.push((row) => (row[key] ?? null) === value); return this; }
  in(key: string, values: unknown[]) { this.predicates.push((row) => values.includes(row[key])); return this; }
  lte(key: string, value: string) { this.predicates.push((row) => String(row[key]) <= value); return this; }
  like(key: string, value: string) { this.predicates.push((row) => String(row[key] || '').startsWith(value.slice(0, -1))); return this; }
  or(expression: string) {
    filterExpressions.push(expression);
    this.predicates.push((row) => splitFilter(expression).some((part) => evaluateFilter(row, part)));
    return this;
  }
  order() { return this; }
  range(start: number, end: number) { this.start = start; this.end = end; return this; }
  maybeSingle() { this.single = true; return this; }
  update(value: Row) { this.updateValue = value; writes.push(value); return this; }
  then(resolve: (value: unknown) => unknown) {
    const found = rows.filter((row) => this.predicates.every((test) => test(row))).slice(this.start, this.end + 1);
    if (this.updateValue) found.forEach((row) => Object.assign(row, this.updateValue));
    const projected = this.selectFields ? found.map((row) => Object.fromEntries(this.selectFields!.filter((field) => field in row).map((field) => [field, row[field]]))) : found;
    return Promise.resolve({ data: this.single ? projected[0] || null : projected, error: null }).then(resolve);
  }
}
const stubs: Record<string, unknown> = {
  '@/lib/video-manual-retry-eligibility': { canManuallyRetryUnsubmittedVideoTask: async () => false },
  'next/server': { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status || 200 }) } },
  '@/lib/digital-human-task': digitalHuman,
  '@/storage/database/supabase-client': { getSupabaseClient: () => ({ from: () => new Query() }) },
  '@/lib/current-api-user': { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: 'alice' } }) },
  '@/lib/video-error-policy': { classifyVideoProviderError: () => ({ publicMessage: '失败' }), localVideoTaskFailureMessage: () => '' },
  '@/lib/video-access-ticket': { createVideoAccessUrl: async (options: { taskId: string; scope: string }) => { if (options.scope === 'thumbnail') thumbnailCalls++; return `/api/video/proxy?taskId=${options.taskId}`; } },
  '@/lib/autodl-h3-assets': { signAutodlH3OwnedAssetRefForUser: async () => '' },
  '@/lib/public-model-dto': { publicModelDisplayName: () => '视频模型', toPublicModelId: () => 'public-model' },
  '@/lib/video-input-contract': { getVideoInputContract: () => ({ requiresSourceVideo: false }) },
  '@/lib/video-cancellation': { supportsConfirmedVideoCancellation: () => false },
  '@/lib/media-history-visibility': { hideMediaHistoryItem: () => ({ body: { success: true }, status: 200 }) },
  '@/lib/video-history-cleanup': { removeVideoHistoryThumbnails: async () => 0 },
  '@/lib/video-history-presentation': presentation,
  '@/lib/video-history-policy': policy,
  '@/lib/storyboard-video-archive-policy': archive,
  '@/lib/video-budget-reservation': { parseVideoGenerationRequestSnapshot: () => null },
};
const source = fs.readFileSync(new URL('../src/app/api/video/history/route.ts', import.meta.url), 'utf8');
assert.equal(source.includes('.delete('), false, 'history route must not physically delete tasks');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports: Record<string, (request: unknown) => Promise<{ body: Record<string, unknown>; status: number }>> = {};
vm.runInNewContext(compiled, { exports, require: (name: string) => { assert.ok(name in stubs, `unmocked dependency ${name}`); return stubs[name]; }, console, URL, Date, Promise, Map, Set });
const request = (query: string) => ({ url: `http://localhost/api/video/history?${query}`, nextUrl: new URL(`http://localhost/api/video/history?${query}`) });
const row = (id: string, extra: Row = {}): Row => ({ id, user_id: 'alice', status: 'completed', billing_state: 'settled', created_at: ago(2), completed_at: ago(1), video_url: 'https://fixture.invalid/video.mp4', history_hidden_at: null, task_label: '分镜工作台', ...extra });

async function main() {
  rows = [row('a'), row('b', { source_expired_at: ago(0.1), history_hidden_at: ago(0.1) }), row('old', { completed_at: ago(121) }), row('protected', { completed_at: ago(200), billing_state: 'usage_pending' }), row('bob', { user_id: 'bob' }), row('video', { task_label: '' })];
  const first = await exports.GET(request('surface=storyboard-workbench&limit=2'));
  assert.equal(first.body.total, 4);
  assert.equal(first.body.retentionDays, 3);
  assert.ok(Number.isFinite(Date.parse(String(first.body.serverTime))));
  assert.equal(first.body.nextOffset, 2);
  assert.equal(thumbnailCalls, 1, 'playable completed tasks receive real video-frame tickets');
  assert.deepEqual(Array.from((first.body.tasks as Row[]).map((item) => item.id)), ['a', 'b']);
  assert.equal((first.body.tasks as Row[])[0].mediaAvailable, true);
  assert.equal((first.body.tasks as Row[])[1].mediaAvailable, false);
  assert.equal((first.body.tasks as Row[])[1].videoUrl, '');
  assert.equal((first.body.tasks as Row[])[1].deliveryState, 'failed');
  let networkCalls = 0;
  const client = createClient('https://history-contract.invalid', 'offline-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async () => { networkCalls++; throw Error('NETWORK_FORBIDDEN'); } },
  });
  const actualQuery = client.from('video_tasks').select('id').eq('user_id', 'alice').or(filterExpressions[0]);
  const actualUrl = (actualQuery as unknown as { url: URL }).url;
  assert.deepEqual(actualUrl.searchParams.getAll('or'), [`(${filterExpressions[0]})`]);
  assert.ok(filterExpressions[0].startsWith('and('));
  assert.ok(filterExpressions[0].includes('history_hidden_at.is.null,source_expired_at.not.is.null'));
  assert.equal(filterExpressions[0].includes('billing_state.not.in.('), false, 'storyboard task audit must not use the media retention cutoff');
  assert.equal(networkCalls, 0, 'constructing the real SDK query must remain offline');
  const second = await exports.GET(request('surface=storyboard-workbench&limit=2&offset=2'));
  assert.equal((second.body.tasks as Row[]).length, 2);
  assert.equal((second.body.tasks as Row[])[0].id, 'old');
  assert.equal((second.body.tasks as Row[])[0].deliveryState, 'expired');
  assert.equal((second.body.tasks as Row[])[0].mediaAvailable, false);
  assert.equal((second.body.tasks as Row[])[1].id, 'protected');
  const sync = await exports.GET(request('surface=storyboard-workbench&reconcileTaskIds=b,bob,video,missing'));
  assert.deepEqual(Array.from(sync.body.hiddenTaskIds as string[]), ['bob', 'video', 'missing']);
  assert.equal((await exports.DELETE(request('surface=video-page&taskId=a'))).status, 404);
  assert.equal((await exports.DELETE(request('surface=storyboard-workbench&taskId=protected'))).status, 409);
  assert.equal((await exports.DELETE(request('surface=unrecognized&clearAll=true'))).status, 400);
  assert.equal((await exports.DELETE(request(`surface=storyboard-workbench&clearAll=true&cutoff=${encodeURIComponent(new Date(now + 3600000).toISOString())}`))).status, 400);
  rows.push(row('new-completion', { completed_at: new Date(now + 3600000).toISOString() }));
  // A legacy row outside the retention window: hidden from history, still clearable.
  rows.push(row('legacy', { billing_state: null, created_at: ago(130), completed_at: ago(129) }));
  const clock = await exports.GET(request('surface=storyboard-workbench&reconcileTaskIds='));
  const clientClockAhead = now + 3600000;
  assert.ok(Date.parse(String(clock.body.serverTime)) < clientClockAhead);
  const cutoff = encodeURIComponent(String(clock.body.serverTime));
  const clear = await exports.DELETE(request(`surface=storyboard-workbench&clearAll=true&cutoff=${cutoff}`));
  assert.equal(clear.status, 200);
  assert.equal(clear.body.cutoff, clock.body.serverTime);
  assert.equal(clear.body.protectedCount, 1);
  assert.deepEqual(Array.from(clear.body.clearedTaskIds as string[]).sort(), ['a', 'b', 'legacy', 'old']);
  const clearWriteFilter = filterExpressions[filterExpressions.length - 1] || '';
  assert.ok(clearWriteFilter.includes('billing_state.is.null'), 'clear write must still match rows without a billing state');
  assert.ok(clearWriteFilter.includes('provider_submitted'), 'clear write must reach stale provider_submitted rows the policy already released');
  const retry = await exports.DELETE(request(`surface=storyboard-workbench&clearAll=true&cutoff=${cutoff}`));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.cutoff, clock.body.serverTime);
  assert.equal(retry.body.clearedCount, 0);
  assert.equal(policy.isVideoHistoryExplicitlyHidden(rows.find((item) => item.id === 'b')!), true);
  assert.ok(writes.every((value) => Object.keys(value).join(',') === 'history_hidden_at'));
  assert.equal(rows.find((item) => item.id === 'new-completion')?.history_hidden_at, null);
  assert.equal(rows.find((item) => item.id === 'bob')?.history_hidden_at, null);
  assert.equal(rows.find((item) => item.id === 'video')?.history_hidden_at, null);
  const afterClear = await exports.GET(request('surface=storyboard-workbench&reconcileTaskIds=a,b,protected,new-completion'));
  assert.deepEqual(Array.from(afterClear.body.hiddenTaskIds as string[]), ['a', 'b']);
  rows.push(row('digital-current', { task_label: 'digital-human:photo', client_request_id: 'digital-current-request' }));
  rows.push(row('digital-retired', { task_label: 'digital-human:photo', client_request_id: 'legacy-request' }));
  rows.push(row('digital-validation', { task_label: 'digital-human:video', client_request_id: `vav_${'a'.repeat(64)}` }));
  const digitalSync = await exports.GET(request('surface=video-page&reconcileTaskIds=digital-current,digital-retired,digital-validation'));
  assert.deepEqual(Array.from(digitalSync.body.hiddenTaskIds as string[]), ['digital-current', 'digital-retired', 'digital-validation']);
  assert.equal((await exports.DELETE(request('surface=digital-human&taskId=digital-current'))).status, 200);
  assert.equal((await exports.DELETE(request('surface=digital-human&taskId=digital-validation'))).status, 200);
  assert.equal((await exports.DELETE(request('surface=digital-human&taskId=digital-retired'))).status, 404);
  console.log('PASS: separate storyboard media/audit retention, availability, thumbnail tickets, API isolation/pagination/reconcile/soft-clear/idempotency; no DB or network accessed');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
