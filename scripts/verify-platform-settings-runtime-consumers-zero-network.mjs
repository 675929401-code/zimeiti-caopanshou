#!/usr/bin/env node
// Real settings handlers, parser and consumers in an allowlisted VM; all data and SMTP are RAM fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixedTime = Date.parse('2026-10-31T00:00:00.000Z');
const sourceFiles = new Set([
  'src/app/api/settings/admin/route.ts', 'src/app/api/settings/route.ts',
  'src/lib/email.ts', 'src/lib/billing.ts', 'src/lib/coze-api.ts',
  'src/app/api/llm/llm-state.ts', 'src/lib/platform-settings-contract.ts',
  'src/lib/server/platform-settings-runtime-cache.ts',
  'src/lib/server/platform-secret-settings.ts', 'src/lib/server/platform-settings-reserved.ts',
  'src/lib/themes.ts', 'src/lib/theme-color-settings.ts', 'src/lib/display-normalization.ts',
  'src/lib/verification-email-template.ts', 'src/lib/branding/contracts.ts',
  'src/app/api/auth/send-email-code/route.ts', 'src/lib/email-code-store.ts',
  'src/lib/auto-avatar/settings.ts', 'src/lib/auto-avatar/index.ts', 'src/lib/auto-avatar/generator.ts', 'src/lib/auto-avatar/prompts.ts', 'src/lib/retired-cover-models.ts',
]);
const original = {
  email_smtp_host: 'smtp-a.invalid', email_smtp_port: '465',
  email_smtp_user: 'sender-a@example.invalid', email_smtp_pass: 'fixture-password-a', email_from: 'Fixture A',
  credits_per_yuan: '50', global_system_prefix: 'fixture-prefix-a',
  coze_api_base_url: 'https://coze-a.invalid', coze_api_token: 'fixture-token-a', coze_workspace_id: 'fixture-space-a',
  input_cost_per_million: '25', output_cost_per_million: '125', cached_cost_per_million: '2.5',
  profit_margin: '50', token_rounding_enabled: 'false', token_rounding_unit: '0',
  token_rounding_min: '100', token_rounding_max: '10000', theme: 'obsidian', theme_mode: 'dark',
};
const replacement = {
  email_smtp_host: 'smtp-b.invalid', email_smtp_port: '587',
  email_smtp_user: 'sender-b@example.invalid', email_smtp_pass: 'fixture-password-b', email_from: 'Fixture B',
  credits_per_yuan: '100', global_system_prefix: 'fixture-prefix-b',
  coze_api_base_url: 'https://coze-b.invalid', coze_api_token: 'fixture-token-b', coze_workspace_id: 'fixture-space-b',
};
const changedOriginal = Object.fromEntries(Object.keys(replacement).map(key => [key, original[key]]));
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

export function createHarness({ upstreamFetch, avatarRequest, runtimeEnv = {} } = {}) {
  const rows = new Map(Object.entries(original).map(([setting_key, setting_value]) => [setting_key,
    { setting_key, setting_value, updated_at: '2026-10-30T00:00:00.000Z' }]));
  const state = {
    queries: [], writes: [], audits: [], authorizations: [], transports: [], mails: [], warnings: [],
    invalidations: { email: 0, billing: 0, prefix: 0, coze: 0 },
    deniedStatus: null, deniedPermission: null, failUpsert: false, failReadback: null,
    pauseEmailRead: null, pauseSend: null, networkAttempts: 0, closeCalls: 0, verifyCalls: 0,
    pauseReads: [], agent: null, model: null,
    clock: fixedTime, user: null, coverModels: [],
  };
  function query(source, table) {
    const trace = { source, table, columns: '', keys: null, single: false };
    state.queries.push(trace);
    const q = {
      select(columns) { trace.columns = columns; return q; },
      in(field, keys) { assert.equal(field, 'setting_key'); trace.keys = [...keys]; return q; },
      eq(field, key) { assert.ok(table === 'platform_settings' ? field === 'setting_key' : table === 'users' ? field === 'email' : table === 'cover_models' ? ['is_active', 'is_hidden'].includes(field) : field === 'id'); if (table === 'platform_settings') trace.keys = [key]; return q; },
      single() { trace.single = true; return q; },
      maybeSingle() { trace.single = true; return q; },
      order() { return q; },
      async upsert(updates, options) {
        assert.equal(source, 'admin', 'consumer database write forbidden');
        assert.equal(options.onConflict, 'setting_key');
        state.writes.push(clone(updates));
        if (state.failUpsert) return { error: new Error('FIXTURE_UPSERT_FAILED') };
        for (const update of updates) rows.set(update.setting_key, clone(update));
        return { error: null };
      },
      then(resolve, reject) {
        return Promise.resolve().then(async () => {
          assert.ok(trace.columns, 'database select must name columns');
          const columns = trace.columns.split(',').map(column => column.trim());
          let selected = [...rows.values()].filter(row => !trace.keys || trace.keys.includes(row.setting_key));
          selected = selected.map(row => Object.fromEntries(columns.map(key => [key, row[key] ?? null])));
          if (table !== 'platform_settings') selected = (table === 'agents' ? state.agent : state.model) ? [clone(table === 'agents' ? state.agent : state.model)] : [];
          if (table === 'users') selected = state.user ? [clone(state.user)] : [];
          if (table === 'cover_models') selected = clone(state.coverModels);
          const pendingIndex = state.pauseReads.findIndex(pause => pause.source === source && pause.table === table && (!pause.key || trace.keys?.includes(pause.key)));
          if (pendingIndex >= 0) {
            const [pause] = state.pauseReads.splice(pendingIndex, 1);
            pause.started.resolve();
            await pause.release.promise;
            if (pause.fail) throw new Error('FIXTURE_DELAYED_READ_FAILURE');
            if (pause.returnError) return { data: null, error: new Error('FIXTURE_DELAYED_READ_ERROR_RESULT') };
          }
          const isReadback = source === 'admin' && state.writes.length > 0;
          if (isReadback && state.failReadback === 'error') return { data: null, error: new Error('FIXTURE_READBACK_FAILED') };
          if (isReadback && state.failReadback === 'mismatch') selected = selected.map(row => ({ ...row, setting_value: 'fixture-readback-mismatch' }));
          if (source === 'consumer' && trace.keys?.includes('email_smtp_host') && state.pauseEmailRead) {
            const pause = state.pauseEmailRead;
            state.pauseEmailRead = null;
            pause.started.resolve();
            await pause.release.promise;
          }
          return { data: trace.single ? selected[0] || null : selected, error: null };
        }).then(resolve, reject);
      },
    };
    return q;
  }
  const dbFor = source => ({ from(table) { assert.ok(['platform_settings', 'agents', 'llm_models', 'users', 'cover_models'].includes(table), 'unexpected database table'); return query(source, table); } });
  const publishedBranding = { brand: { name: 'Fixture platform', welcomeMessage: 'Fixture welcome' }, assets: {}, source: 'published', generation: 1,
    revisionId: 'fixture-revision', revisionVersion: 1, publishedAt: '2026-10-30T00:00:00.000Z' };
  const mocks = {
    'server-only': {},
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@/storage/database/supabase-client': { getSupabaseAdminClient: () => dbFor('admin'), getSupabaseClient: () => dbFor('consumer') },
    '@/lib/db': { getDb: async () => dbFor('billing') },
    '@/lib/server-runtime-env': { ensureServerRuntimeEnvLoaded() {} },
    '@/lib/server/brand-authority': { readPublishedPlatformBranding: async () => publishedBranding },
    '@/lib/server/admin-governance-authority': {
      async authorizeAdminCapability(_request, permission, options) {
        state.authorizations.push({ permission, ...options });
        assert.equal(options.requireStepUp, true, 'step-up protection retained');
        if (state.deniedStatus && (!state.deniedPermission || state.deniedPermission === permission)) {
          return { ok: false, response: Response.json({ code: 'FIXTURE_PERMISSION_DENIED' }, { status: state.deniedStatus }) };
        }
        return { ok: true, actor: { userId: 'fixture-admin' }, access: { adminLevel: 'super_admin' } };
      },
      async appendAdminGovernanceAudit(entry) { state.audits.push(entry); },
    },
    nodemailer: {
      createTransport(options) {
        const transport = { options: clone(options),
          async sendMail(mail) {
            state.mails.push({ options: clone(options), mail: clone(mail) });
            if (state.pauseSend) {
              const pause = state.pauseSend;
              state.pauseSend = null;
              pause.started.resolve();
              await pause.release.promise;
            }
            return { messageId: 'fixture-message' };
          },
          close() { state.closeCalls += 1; throw new Error('IN_FLIGHT_TRANSPORT_CLOSE_FORBIDDEN'); },
          verify() { state.verifyCalls += 1; throw new Error('SMTP_VERIFY_FORBIDDEN'); },
        };
        state.transports.push(transport);
        return transport;
      },
    },
    'coze-coding-dev-sdk': { Config: class {}, ImageGenerationClient: class { constructor() { throw new Error('SDK_PROVIDER_FORBIDDEN'); } } },
    '@/lib/storage': { persistAvatar() { throw new Error('STORAGE_FORBIDDEN'); }, discardUnclaimedGeneratedAvatar() { throw new Error('STORAGE_FORBIDDEN'); } },
    '@/app/api/llm/handle-image-gen': { callImageGenerationAPI(...args) { assert.ok(avatarRequest, 'avatar mock required'); return avatarRequest(...args); } },
    '@/lib/bots-cache': { invalidateBotsCache() {} },
  };
  const cache = new Map();
  function load(relative) {
    assert.ok(sourceFiles.has(relative), `UNAPPROVED_SOURCE:${relative}`);
    if (cache.has(relative)) return cache.get(relative);
    const module = { exports: {} };
    cache.set(relative, module.exports);
    const compiled = ts.transpileModule(readFileSync(path.join(root, relative), 'utf8'), {
      fileName: relative, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0, `TS syntax:${relative}`);
    class FixedDate extends Date {
      constructor(...args) { super(...(args.length ? args : [fixedTime])); }
      static now() { return state.clock; }
    }
    vm.runInNewContext(compiled.outputText, {
      module, exports: module.exports, URL, URLSearchParams, Request, Response, Headers,
      Date: FixedDate, process: { env: Object.freeze(runtimeEnv) },
      setInterval: () => ({ unref() {} }), setTimeout: () => 0,
      console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => state.warnings.push({ level, text: args.map(String).join(' ') })])),
      fetch(...args) { if (upstreamFetch) return upstreamFetch(...args); state.networkAttempts += 1; throw new Error('NETWORK_FORBIDDEN'); },
      require(specifier) {
        const absolute = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
          : specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : '';
        const alias = absolute.startsWith('src/') ? `@/${absolute.slice(4)}` : specifier;
        if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
        if (Object.hasOwn(mocks, alias)) return mocks[alias];
        assert.ok(absolute && sourceFiles.has(`${absolute}.ts`), `UNMOCKED_IMPORT:${relative}:${specifier}`);
        return load(`${absolute}.ts`);
      },
    }, { filename: relative, timeout: 5000 });
    const methods = {
      'src/lib/email.ts': ['invalidateEmailConfigCache', 'email'],
      'src/lib/billing.ts': ['invalidateBillingConfigCache', 'billing'],
      'src/lib/coze-api.ts': ['clearCozeConfigCache', 'coze'],
      'src/app/api/llm/llm-state.ts': ['invalidateGlobalSystemPrefixCache', 'prefix'],
    };
    if (methods[relative]) {
      const [method, counter] = methods[relative];
      if (module.exports[method]) {
        const actual = module.exports[method];
        module.exports[method] = (...args) => { state.invalidations[counter] += 1; return actual(...args); };
      }
    }
    cache.set(relative, module.exports);
    return module.exports;
  }
  const email = load('src/lib/email.ts');
  const billing = load('src/lib/billing.ts');
  const coze = load('src/lib/coze-api.ts');
  const prefix = load('src/app/api/llm/llm-state.ts');
  const routes = { admin: load('src/app/api/settings/admin/route.ts'), legacy: load('src/app/api/settings/route.ts') };
  return {
    state, rows, email, billing, coze, prefix, load, dbFor,
    async save(surface, values, { scope = '', body, headers = {} } = {}) {
      const request = new Request(`http://fixture.invalid/api/settings${surface === 'admin' ? '/admin' : ''}${scope ? `?scope=${scope}` : ''}`, {
        method: surface === 'admin' ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'fixture-request', ...headers },
        body: body ?? JSON.stringify(surface === 'admin' ? values : { settings: values }),
      });
      Object.defineProperty(request, 'nextUrl', { value: new URL(request.url) });
      const response = await (surface === 'admin' ? routes.admin.POST(request) : routes.legacy.PUT(request));
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
    async consume() {
      const config = await billing.getBillingConfig();
      const result = billing.calculateCredits(config, 1000, 1000, 0);
      assert.equal(await email.sendVerificationCode('recipient@example.invalid', '123456'), true);
      const smtp = state.mails.at(-1);
      return { config, credits: result.creditsCharged, smtp, coze: await coze.getCozeConfig(), prefix: await prefix.getGlobalSystemPrefix(dbFor('consumer')) };
    },
    async publicGet() { const response = await routes.legacy.GET(); return { status: response.status, body: await response.json() }; },
    async adminGet(scope) {
      const request = new Request(`http://fixture.invalid/api/settings/admin?scope=${scope}`);
      Object.defineProperty(request, 'nextUrl', { value: new URL(request.url) });
      const response = await routes.admin.GET(request);
      return { status: response.status, body: await response.json() };
    },
  };
}

const checks = [];
async function check(name, run) { await run(); checks.push(name); }
function assertSafety(h) {
  assert.equal(h.state.networkAttempts, 0);
  assert.equal(h.state.closeCalls, 0);
  assert.equal(h.state.verifyCalls, 0);
  for (const audit of h.state.audits) {
    const serialized = JSON.stringify(audit.metadata);
    assert.ok(!serialized.includes(original.email_smtp_pass) && !serialized.includes(replacement.email_smtp_pass), 'secret leaked into audit metadata');
  }
}
function assertObserved(result, values) {
  assert.deepEqual({
    rate: result.config.creditsPerYuan, smtpHost: result.smtp.options.host, smtpPort: result.smtp.options.port,
    smtpSecure: result.smtp.options.secure, smtpUser: result.smtp.options.auth.user, smtpPass: result.smtp.options.auth.pass,
    fromName: result.smtp.mail.from.name, fromAddress: result.smtp.mail.from.address,
    cozeBase: result.coze.apiBase, cozeToken: result.coze.apiToken, cozeSpace: result.coze.workspaceId, prefix: result.prefix,
  }, {
    rate: Number(values.credits_per_yuan), smtpHost: values.email_smtp_host, smtpPort: Number(values.email_smtp_port),
    smtpSecure: values.email_smtp_port === '465', smtpUser: values.email_smtp_user, smtpPass: values.email_smtp_pass,
    fromName: values.email_from, fromAddress: values.email_smtp_user,
    cozeBase: values.coze_api_base_url, cozeToken: values.coze_api_token, cozeSpace: values.coze_workspace_id, prefix: values.global_system_prefix,
  }, 'real consumers must observe the just-saved settings without advancing time');
}

const requestedSurface = process.argv.find(argument => argument.startsWith('--surface='))?.slice('--surface='.length);
assert.ok(!requestedSurface || ['admin', 'legacy'].includes(requestedSurface), 'surface must be admin or legacy');
for (const surface of requestedSurface ? [requestedSurface] : ['admin', 'legacy']) {
  await check(`${surface}: warm A -> save B -> consume B -> restore A at the same clock`, async () => {
    const h = createHarness();
    const a = await h.consume();
    assertObserved(a, original);
    const transportsBefore = h.state.transports.length;
    const mailsBefore = h.state.mails.length;
    const save = await h.save(surface, replacement);
    assert.equal(save.status, 200);
    assert.equal(save.body.success, true);
    assert.equal(h.state.transports.length, transportsBefore, 'saving only invalidates; it does not create a transport');
    assert.equal(h.state.mails.length, mailsBefore, 'saving does not send SMTP mail');
    assert.deepEqual(save.body.changedKeys.sort(), Object.keys(replacement).sort());
    if (surface === 'admin') {
      assert.deepEqual(save.body.verifiedKeys.sort(), Object.keys(replacement).sort());
      assert.equal(save.body.verification, 'database-readback');
    }
    const b = await h.consume();
    assertObserved(b, replacement);
    assert.equal(b.credits, a.credits * 2, 'actual calculateCredits uses refreshed exchange rate');
    assert.equal(a.config.creditsPerYuan, 50, 'already captured billing snapshot is immutable across invalidation');
    assert.deepEqual(h.state.invalidations, { email: 1, billing: 1, prefix: 1, coze: 1 });
    assert.equal((await h.save(surface, changedOriginal)).status, 200);
    assertObserved(await h.consume(), original);
    assert.equal(h.state.audits.filter(entry => entry.result === 'success').length, 6, 'three authorized write scopes audited for each save');
    assertSafety(h);
  });
  await check(`${surface}: same value, unrelated key and masked/blank secret retain warm caches`, async () => {
    const h = createHarness();
    await h.consume();
    const queriesBefore = h.state.queries.filter(query => query.source !== 'admin').length;
    const transportsBefore = h.state.transports.length;
    for (const values of [{ ...changedOriginal }, { theme_mode: 'light' }, { email_smtp_pass: '***' }, { email_smtp_pass: '' }]) {
      assert.equal((await h.save(surface, values)).status, 200);
    }
    assert.deepEqual(h.state.invalidations, { email: 0, billing: 0, prefix: 0, coze: 0 });
    assert.equal(h.rows.get('email_smtp_pass').setting_value, original.email_smtp_pass);
    assertObserved(await h.consume(), original);
    assert.equal(h.state.queries.filter(query => query.source !== 'admin').length, queriesBefore);
    assert.equal(h.state.transports.length, transportsBefore);
    const admin = await h.adminGet('integrations');
    assert.equal(admin.status, 200);
    assert.equal(admin.body.settings.email_smtp_pass_configured, true);
    assert.equal(Object.hasOwn(admin.body.settings, 'email_smtp_pass'), false);
    assertSafety(h);
  });
  for (const status of [401, 403]) {
    await check(`${surface}: permission ${status} does not write or invalidate`, async () => {
      const h = createHarness();
      await h.consume();
      h.state.deniedStatus = status;
      h.state.deniedPermission = 'payment.settings.manage';
      const response = await h.save(surface, replacement);
      assert.equal(response.status, status);
      assert.equal(h.state.writes.length, 0);
      assert.deepEqual(h.state.invalidations, { email: 0, billing: 0, prefix: 0, coze: 0 });
      assertObserved(await h.consume(), original);
      assertSafety(h);
    });
  }
  for (const [label, values, options, code] of [
    ['invalid SMTP port', { email_smtp_port: '65536' }, {}, 'INVALID_SMTP_PORT'],
    ['invalid billing number', { credits_per_yuan: '-1' }, {}, 'INVALID_NUMBER_SETTING'],
    ['unknown field', { unsafe_runtime_field: 'x' }, {}, 'PLATFORM_SETTING_NOT_ALLOWED'],
    ['wrong value type', { credits_per_yuan: 100 }, {}, 'PLATFORM_SETTING_TYPE_INVALID'],
    ['reserved versioned field', { 'manju.config.v1.fixture': '{}' }, {}, 'VERSIONED_PLATFORM_SETTING_KEY'],
    ['malformed JSON', {}, { body: '{' }, 'PLATFORM_SETTINGS_REQUEST_INVALID'],
  ]) {
    await check(`${surface}: ${label} does not write or invalidate`, async () => {
      const h = createHarness();
      await h.consume();
      const response = await h.save(surface, values, options);
      assert.equal(response.status, 400);
      assert.equal(response.body.code, code);
      assert.equal(h.state.writes.length, 0);
      assert.deepEqual(h.state.invalidations, { email: 0, billing: 0, prefix: 0, coze: 0 });
      assertSafety(h);
    });
  }
  await check(`${surface}: failed upsert retains old caches`, async () => {
    const h = createHarness();
    await h.consume();
    h.state.failUpsert = true;
    assert.equal((await h.save(surface, replacement)).status, 500);
    assert.deepEqual(h.state.invalidations, { email: 0, billing: 0, prefix: 0, coze: 0 });
    assertObserved(await h.consume(), original);
    assert.ok(h.state.audits.every(entry => entry.result === 'failure'));
    assertSafety(h);
  });
  for (const failure of ['error', 'mismatch']) {
    await check(`${surface}: committed write with ${failure} readback fails response and invalidates affected caches`, async () => {
      const h = createHarness();
      await h.consume();
      h.state.failReadback = failure;
      const response = await h.save(surface, replacement);
      assert.equal(response.status, failure === 'error' ? 500 : 400);
      assert.equal(response.body.success, undefined);
      if (failure === 'mismatch') assert.equal(response.body.code, 'PLATFORM_SETTINGS_READBACK_MISMATCH');
      assert.deepEqual(h.state.invalidations, { email: 1, billing: 1, prefix: 1, coze: 1 });
      assert.ok(h.state.audits.every(entry => entry.result === 'failure'));
      h.state.failReadback = null;
      assertObserved(await h.consume(), replacement);
      assertSafety(h);
    });
  }
  await check(`${surface}: SMTP in-flight send keeps A and next send uses B without close`, async () => {
    const h = createHarness();
    await h.consume();
    const pause = { started: deferred(), release: deferred() };
    h.state.pauseSend = pause;
    const inFlight = h.email.sendVerificationCode('recipient@example.invalid', '654321');
    await pause.started.promise;
    assert.equal((await h.save(surface, replacement)).status, 200);
    assertObserved(await h.consume(), replacement);
    pause.release.resolve();
    assert.equal(await inFlight, true);
    assert.equal(h.state.mails.at(-2).options.host, original.email_smtp_host);
    assert.equal(h.state.mails.at(-2).mail.from.name, original.email_from);
    assertSafety(h);
  });
  await check(`${surface}: stale pending SMTP read cannot refill invalidated DB cache`, async () => {
    const h = createHarness();
    const pause = { started: deferred(), release: deferred() };
    h.state.pauseEmailRead = pause;
    const oldSend = h.email.sendVerificationCode('recipient@example.invalid', '654321');
    await pause.started.promise;
    assert.equal((await h.save(surface, replacement)).status, 200);
    assertObserved(await h.consume(), replacement);
    pause.release.resolve();
    assert.equal(await oldSend, true);
    assert.equal(h.state.mails.at(-1).options.host, original.email_smtp_host, 'already-started request keeps captured A transport');
    assert.equal(h.state.mails.at(-1).mail.from.name, original.email_from);
    assertObserved(await h.consume(), replacement);
    assertSafety(h);
  });
  await check(`${surface}: each billing setting refreshes its real configuration without clearing other consumers`, async () => {
    const h = createHarness();
    await h.consume();
    for (const [key, value, field, expected] of [
      ['input_cost_per_million', '30', 'inputCostPerMillion', 30],
      ['output_cost_per_million', '130', 'outputCostPerMillion', 130],
      ['cached_cost_per_million', '3', 'cachedCostPerMillion', 3],
      ['profit_margin', '60', 'profitMargin', 60],
      ['credits_per_yuan', '75', 'creditsPerYuan', 75],
      ['token_rounding_enabled', 'true', 'tokenRoundingEnabled', true],
      ['token_rounding_unit', '1000', 'tokenRoundingUnit', 1000],
      ['token_rounding_min', '200', 'tokenRoundingMin', 200],
      ['token_rounding_max', '2000', 'tokenRoundingMax', 2000],
    ]) {
      const before = { ...h.state.invalidations };
      const captured = await h.billing.getBillingConfig();
      const previous = captured[field];
      assert.equal((await h.save(surface, { [key]: value })).status, 200);
      const refreshed = await h.billing.getBillingConfig();
      assert.equal(refreshed[field], expected, key);
      assert.equal(captured[field], previous, 'old billing snapshot retained');
      assert.deepEqual(h.state.invalidations, { ...before, billing: before.billing + 1 });
      assert.ok(Number.isFinite(h.billing.calculateCredits(refreshed, 1500, 1250, 200).creditsCharged));
    }
    assertSafety(h);
  });
  await check(`${surface}: each SMTP setting refreshes actual transport or sender without clearing other consumers`, async () => {
    const h = createHarness();
    await h.consume();
    const expected = { ...original };
    for (const key of ['email_smtp_host', 'email_smtp_port', 'email_smtp_user', 'email_smtp_pass', 'email_from']) {
      const before = { ...h.state.invalidations };
      expected[key] = replacement[key];
      assert.equal((await h.save(surface, { [key]: replacement[key] })).status, 200);
      assertObserved(await h.consume(), expected);
      assert.deepEqual(h.state.invalidations, { ...before, email: before.email + 1 });
    }
    assertSafety(h);
  });
}

for (const surface of requestedSurface ? [requestedSurface] : ['admin', 'legacy']) {
  for (const consumer of ['coze', 'coze-catch', 'prefix', 'prefix-catch', 'billing', 'agent-missing', 'agent-disabled', 'agent-independent', 'agent-model', 'agent-independent-global', 'agent-model-global']) {
    await check(`${surface}: invalidation epoch rejects stale ${consumer} refill and A-B-A`, async () => {
      const h = createHarness();
      const agentCase = consumer.startsWith('agent-');
      const activeAgent = { token_billing_enabled: true, input_cost_per_million: 40, model_id: consumer.startsWith('agent-model') ? 'fixture-model' : null };
      h.state.agent = consumer === 'agent-missing' ? null : consumer === 'agent-disabled' ? { token_billing_enabled: false } : activeAgent;
      h.state.model = { token_billing_enabled: true, input_cost_per_million: 45 };
      const pause = { started: deferred(), release: deferred(), source: consumer.startsWith('billing') || agentCase ? 'billing' : 'consumer',
        table: agentCase && !consumer.endsWith('-global') ? consumer.startsWith('agent-model') ? 'llm_models' : 'agents' : 'platform_settings',
        key: consumer.startsWith('coze') ? 'coze_api_base_url' : consumer.startsWith('prefix') ? 'global_system_prefix' : null, fail: consumer.endsWith('catch') };
      h.state.pauseReads.push(pause);
      const read = () => consumer.startsWith('coze') ? h.coze.getCozeConfig() : consumer.startsWith('prefix') ? h.prefix.getGlobalSystemPrefix(h.dbFor('consumer')) : agentCase ? h.billing.getAgentBillingConfig('fixture-agent') : h.billing.getBillingConfig();
      const value = result => consumer.startsWith('coze') ? result.apiBase : consumer.startsWith('prefix') ? result : agentCase ? result?.inputCostPerMillion : result.creditsPerYuan;
      const old = read(); await pause.started.promise;
      assert.equal((await h.save(surface, replacement)).status, 200);
      h.state.agent = { ...activeAgent, input_cost_per_million: 80 };
      h.state.model = { token_billing_enabled: true, input_cost_per_million: 90 };
      const fresh = await read();
      const expectedB = consumer.startsWith('coze') ? replacement.coze_api_base_url : consumer.startsWith('prefix') ? replacement.global_system_prefix : agentCase ? consumer.startsWith('agent-model') ? 90 : 80 : 100;
      assert.equal(value(fresh), expectedB);
      pause.release.resolve(); const captured = await old;
      assert.equal(value(await read()), expectedB, 'late A must not replace B cache');
      if (consumer === 'billing' || consumer.endsWith('-global')) assert.equal(captured.creditsPerYuan, 50, 'in-flight billing snapshot stays A');
      if (consumer === 'coze') assert.equal(captured.apiBase, original.coze_api_base_url);
      if (consumer === 'prefix') assert.equal(captured, original.global_system_prefix);
      assert.equal((await h.save(surface, changedOriginal)).status, 200);
      h.state.agent = activeAgent; h.state.model = { token_billing_enabled: true, input_cost_per_million: 45 };
      const expectedA = consumer.startsWith('coze') ? original.coze_api_base_url : consumer.startsWith('prefix') ? original.global_system_prefix : agentCase ? consumer.startsWith('agent-model') ? 45 : 40 : 50;
      assert.equal(value(await read()), expectedA, 'restored A is consumed without advancing TTL');
      assertSafety(h);
    });
  }
}

await check('admin: declared scope mismatch fails before writes and invalidation', async () => {
  const h = createHarness();
  await h.consume();
  const response = await h.save('admin', { email_smtp_host: replacement.email_smtp_host }, { scope: 'payment' });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'PLATFORM_SETTING_SCOPE_MISMATCH');
  assert.equal(h.state.authorizations.length, 0);
  assert.equal(h.state.writes.length, 0);
  assert.deepEqual(h.state.invalidations, { email: 0, billing: 0, prefix: 0, coze: 0 });
  assertSafety(h);
});

await check('public GET keeps its explicit key filter and excludes SMTP/billing/Coze/prefix', async () => {
  const h = createHarness();
  const response = await h.publicGet();
  assert.equal(response.status, 200);
  const publicQuery = h.state.queries.find(query => query.source === 'admin');
  assert.deepEqual(publicQuery.keys, ['theme', 'theme_mode', 'theme_primary_color', 'theme_accent_color',
    'theme_gradient_start', 'theme_gradient_mid', 'theme_gradient_end', 'page_layout', 'card_layout', 'video_page_config']);
  for (const key of Object.keys(replacement)) assert.equal(Object.hasOwn(response.body.settings, key), false);
  assert.equal(h.state.writes.length, 0);
  assertSafety(h);
});

console.log(JSON.stringify({ status: 'PASS', checks: checks.length, cases: checks, clockAdvanced: false,
  realNetworkCalls: 0, realDatabaseCalls: 0, realSmtpCalls: 0, scope: 'single VM/process cache invalidation; not multi-process synchronization' }, null, 2));
