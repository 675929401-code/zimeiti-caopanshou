import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ADMIN_ACTIVITY_LOG_COLUMNS, adminActivityLogLimit, normalizeActivityDisplayText, normalizeAdminActivityLog } from '@/lib/admin-activity-display';

const latin1 = (value: string) => Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join('');
const source = readFileSync('src/app/api/health/route.ts', 'utf8');
const tree = ts.createSourceFile('health-route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const get = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'GET');
assert.ok(get, 'actual GET handler is required');
const code = ts.transpileModule(`${get.getText(tree)}\nGET;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Probe = { queries: string[]; checks: string[]; selected: string[]; limits: number[]; dbFailure?: boolean };
const row = { id: 'fixture-log', level: 'info', source: latin1('系统'), message: latin1('积分充值完成 ¥0.00'), created_at: '2026-09-02T00:00:00Z', auto_fixed: false, details: { Authorization: 'fixture-only-secret' }, headers: { Cookie: 'fixture-only-cookie' }, context: { user: 'fixture-only-identity' } };
const checkNames = ['checkDatabase','checkCozeAPI','checkLLMAPI','checkObjectStorage','checkDatabaseIntegrity','checkRecentErrors','checkUserActivity'];

function loadHandler(probe: Probe) {
  const dependencies: Record<string, unknown> = {
    exports: {}, URL, Date,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
    isAuthorizedInternalRequest: () => false,
    authorizeAdminToken: async (token: string) => token === 'fixture-admin'
      ? { ok: true }
      : { ok: false, status: 403, code: 'ADMIN_REQUIRED', error: '仅管理员可访问' },
    ADMIN_ACTIVITY_LOG_COLUMNS, adminActivityLogLimit, normalizeAdminActivityLog,
    getSupabase: () => ({
      from(table: string) {
        probe.queries.push(table);
        const result = () => ({ data: table === 'system_logs' ? [row] : [], error: probe.dbFailure ? { message: 'fixture-only-sensitive-db-error' } : null });
        const query = {
          select(columns: string) { probe.selected.push(columns); return query; },
          order() { return query; },
          limit(limit: number) { probe.limits.push(limit); return query; },
          single() { return Promise.resolve(result()); },
          then(yes: (value: ReturnType<typeof result>) => unknown, no: (reason: unknown) => unknown) { return Promise.resolve(result()).then(yes,no); },
        };
        return query;
      },
    }),
  };
  for (const name of checkNames) dependencies[name] = async () => { probe.checks.push(name); return { name, status: 'healthy', message: 'fixture check' }; };
  return runInNewContext(code, dependencies) as (request: Request) => Promise<Response>;
}
const freshProbe = (): Probe => ({ queries: [], checks: [], selected: [], limits: [] });
const request = (query: string, token: string | null = 'fixture-admin') => new Request(`http://fixture.invalid/api/health${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function main() {
  for (const value of ['积分充值完成 ¥0.00','中文与 emoji 😀 保持原样','English café déjà vu','àéîöü','??? 保持问号','发生错误\n第二行']) {
    assert.equal(normalizeActivityDisplayText(value), value);
  }
  assert.equal(normalizeActivityDisplayText(latin1('积分充值完成 ¥0.00')), '积分充值完成 ¥0.00');
  assert.equal(normalizeActivityDisplayText(latin1('文案提取消费')), '文案提取消费');
  const mixed = `原有中文 😀 ${latin1('积分充值完成')}`;
  assert.equal(normalizeActivityDisplayText(mixed), mixed, 'mixed non-Latin1 bytes must never be truncated into a guessed repair');
  const broken = 'å\u0085 invalid';
  assert.equal(normalizeActivityDisplayText(broken), broken);
  assert.equal(normalizeActivityDisplayText(null, '未填写'), '未填写');
  assert.deepEqual([null, '', 'abc', '-1', '0', '1', '50', '10000', '9007199254740992'].map(adminActivityLogLimit), [50,50,50,50,1,1,50,100,50]);

  for (const token of [null, 'fixture-demoted-user']) {
    const probe = freshProbe();
    const response = await loadHandler(probe)(request('?logs=true', token));
    assert.equal(response.status, token ? 403 : 401);
    assert.deepEqual(probe.queries, []);
    assert.deepEqual(probe.checks, []);
  }
  const logsProbe = freshProbe();
  const logsResponse = await loadHandler(logsProbe)(request('?logs=true&limit=10000'));
  const payload = await logsResponse.json();
  assert.equal(logsResponse.status, 200);
  assert.deepEqual(logsProbe.queries, ['system_logs']);
  assert.deepEqual(logsProbe.checks, [], 'logs=true must not call health or provider probes');
  assert.deepEqual(logsProbe.limits, [100]);
  assert.deepEqual(logsProbe.selected, [ADMIN_ACTIVITY_LOG_COLUMNS]);
  assert.equal(payload.logs[0].message, '积分充值完成 ¥0.00');
  assert.deepEqual(Object.keys(payload.logs[0]), ['id','level','source','message','created_at','auto_fixed']);
  assert.ok(!JSON.stringify(payload).includes('fixture-only-'));
  assert.equal(row.message, latin1('积分充值完成 ¥0.00'), 'read mapping must preserve source data');

  const failedProbe = { ...freshProbe(), dbFailure: true };
  const failedResponse = await loadHandler(failedProbe)(request('?logs=true'));
  assert.equal(failedResponse.status, 503);
  assert.ok(!(await failedResponse.text()).includes('fixture-only-sensitive'));
  assert.deepEqual(failedProbe.checks, []);

  const healthProbe = freshProbe();
  const healthPayload = await (await loadHandler(healthProbe)(request(''))).json();
  assert.deepEqual(healthProbe.checks, checkNames, 'normal health route retains every existing check');
  assert.equal(healthPayload.status, 'healthy');
  assert.equal(healthPayload.summary.total, 7);
  assert.equal(healthPayload.recentLogs[0].message, '积分充值完成 ¥0.00');
  assert.ok(!('details' in healthPayload.recentLogs[0]));
  assert.equal(healthPayload.logs, undefined);

  const livenessProbe = freshProbe();
  const livePayload = await (await loadHandler(livenessProbe)(request('?liveness=true', null))).json();
  assert.equal(livePayload.status, 'ok');
  assert.deepEqual(livenessProbe.queries, []);
  assert.deepEqual(livenessProbe.checks, []);
  console.log('PASS: activity text round-trip, auth, bounded logs, no provider probe, field allowlist, database error, normal health and liveness (8 groups)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
