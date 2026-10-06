import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  LOCAL_PREVIEW_PROJECT_ROOT,
  createLocalPreviewLaunchPlan,
  createLocalPreviewLogRedactor,
  startLocalPreviewProcess,
  validateLocalPreviewRuntime,
  parseLocalPreviewArguments,
} from './start-local-data-preview.mjs';

const fixture = () => ({ localOnly: true, databasePort: 54322, databaseName: 'zimeiti_local',
  ownerConnection: { host: '127.0.0.1', port: 54322, database: 'zimeiti_local', user: 'synthetic_owner', password: 'synthetic-password#%:@?/中文' },
  supabaseUrl: 'http://127.0.0.1:54321', serviceRoleKey: 'synthetic-service-role-key', anonKey: 'synthetic-anon-key', jwtSecret: 'synthetic-jwt-secret' });
const local = validateLocalPreviewRuntime(fixture());
const parsed = new URL(local.databaseUrl);
assert.equal(parsed.hostname, '127.0.0.1');
assert.equal(parsed.port, '54322');
assert.equal(parsed.pathname, '/zimeiti_local');
assert.equal(decodeURIComponent(parsed.password), fixture().ownerConnection.password);
assert.equal(parsed.search, '');

const invalid = [
  (input) => { input.localOnly = false; },
  (input) => { input.ownerConnection.host = 'remote.example.invalid'; },
  (input) => { input.ownerConnection.port = 5432; },
  (input) => { input.ownerConnection.database = 'production'; },
  (input) => { input.ownerConnection.connectionString = 'postgresql://remote.example.invalid/production'; },
  (input) => { input.ownerConnection.options = '-c search_path=other'; },
  (input) => { input.databaseName = 'production'; },
  (input) => { input.supabaseUrl = 'https://remote.example.invalid'; },
  (input) => { input.supabaseUrl = 'http://127.0.0.1:54320'; },
  (input) => { input.supabaseUrl = 'http://127.0.0.1:54321/rest/v1'; },
  (input) => { input.supabaseUrl = 'http://127.0.0.1:54321/?host=remote.example.invalid'; },
  (input) => { input.supabaseUrl = 'http://hidden@127.0.0.1:54321'; },
  (input) => { input.serviceRoleKey = ''; },
  (input) => { input.anonKey = 'bad\nheader'; },
];
for (const mutate of invalid) {
  const input = fixture();
  mutate(input);
  assert.throws(() => validateLocalPreviewRuntime(input), /^LocalPreviewError: LOCAL_PREVIEW_[A-Z_]+$/u);
}

const base = { COZE_SUPABASE_URL: 'https://old.example.invalid', COZE_SUPABASE_SERVICE_ROLE_KEY: 'old-key', COZE_SUPABASE_ANON_KEY: 'old-anon', DATABASE_URL: 'postgresql://old.example.invalid/old', COS_SECRET_ID: 'synthetic-cos-id', COS_SECRET_KEY: 'synthetic-cos-key', NODE_ENV: 'production', LOCAL_VALIDATION_DIST_DIR: '../other', PORT: '5000', AUTODL_H3_LIFECYCLE_ENABLED: 'true', APP_RUNTIME_DIR: 'F:\\other-runtime', COMMERCE_DATA_DIR: 'F:\\shared-agent-runtime', COMMERCE_DISCOVERY_CATALOG: 'F:\\untrusted-discovery\\catalog.json', COMMERCE_GATEWAY_KEY_FILE: 'F:\\shared-agent-runtime\\main-gateway.key', IDEMPOTENCY_DIR: 'F:\\other-idempotency' };
const inherited = { COZE_SUPABASE_URL: 'https://inherited.example.invalid', Path: 'C:\\existing' };
const oldBase = structuredClone(base);
const oldInherited = structuredClone(inherited);
const plan = createLocalPreviewLaunchPlan(fixture(), base, inherited, 'C:\\runtime\\node.exe');
assert.deepEqual(base, oldBase);
assert.deepEqual(inherited, oldInherited);
assert.equal(plan.env.NODE_ENV, 'development');
assert.equal(plan.env.PORT, '5002');
assert.equal(plan.env.COZE_SUPABASE_URL, 'http://127.0.0.1:54321');
assert.equal(plan.env.COZE_SUPABASE_SERVICE_ROLE_KEY, fixture().serviceRoleKey);
assert.equal(plan.env.COZE_SUPABASE_ANON_KEY, fixture().anonKey);
assert.equal(plan.env.DATABASE_URL, local.databaseUrl);
assert.equal(plan.env.SHARED_CONFIGURATION_ENABLED, '1');
assert.equal(plan.env.SHARED_CONFIGURATION_SUPABASE_URL, 'http://127.0.0.1:54321');
assert.equal(plan.env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY, fixture().serviceRoleKey);
assert.equal(plan.env.COS_SECRET_KEY, base.COS_SECRET_KEY);
assert.equal(plan.env.LOCAL_VALIDATION_DIST_DIR, '.next-validation');
assert.equal(plan.env.SAFE_FETCH_PUBLIC_DNS, 'cloudflare-doh-v1');
assert.equal(plan.env.AUTODL_H3_LIFECYCLE_ENABLED, 'false');
assert.ok(plan.env.APP_RUNTIME_DIR.endsWith('local-data-20260902\\preview-runtime'));
assert.ok(plan.env.COMMERCE_DATA_DIR.endsWith('local-data-20260902\\preview-runtime\\commerce-agent'));
assert.ok(plan.env.COMMERCE_DISCOVERY_CATALOG.endsWith('local-data-20260902\\preview-runtime\\commerce-discovery\\catalog.json'));
assert.ok(plan.env.COMMERCE_GATEWAY_KEY_FILE.endsWith('local-data-20260902\\preview-runtime\\commerce-agent\\main-gateway.key'));
assert.notEqual(plan.env.COMMERCE_DATA_DIR, base.COMMERCE_DATA_DIR);
assert.notEqual(plan.env.COMMERCE_DISCOVERY_CATALOG, base.COMMERCE_DISCOVERY_CATALOG);
assert.notEqual(plan.env.COMMERCE_GATEWAY_KEY_FILE, base.COMMERCE_GATEWAY_KEY_FILE);
assert.ok(plan.env.IDEMPOTENCY_DIR.endsWith('local-data-20260902\\preview-runtime\\llm-request-idempotency'));
assert.equal(plan.cwd, LOCAL_PREVIEW_PROJECT_ROOT);
assert.deepEqual(plan.args.slice(1), ['dev', '--webpack', '--hostname', '127.0.0.1', '--port', '5002']);
assert.ok(!JSON.stringify(plan.args).includes(fixture().serviceRoleKey));
assert.ok(!JSON.stringify(plan.args).includes(local.databaseUrl));
assert.deepEqual(parseLocalPreviewArguments([]), { port: 5002, check: false });
for (const port of [5000, 5002]) {
  assert.deepEqual(parseLocalPreviewArguments([`--port=${port}`, '--check']), { port, check: true });
  const other = createLocalPreviewLaunchPlan(fixture(), base, inherited, 'C:\\runtime\\node.exe', port);
  assert.equal(other.env.PORT, String(port)); assert.equal(other.args.at(-1), String(port));
  assert.equal(other.env.DATABASE_URL, plan.env.DATABASE_URL);
}
for (const args of [['--port=5001'], ['--port', '5000'], ['--port=5000', '--port=5002']]) assert.throws(() => parseLocalPreviewArguments(args), /LOCAL_PREVIEW_ARGUMENT_REJECTED/u);
assert.throws(() => createLocalPreviewLaunchPlan(fixture(), base, inherited, 'C:\\runtime\\node.exe', 5001), /LOCAL_PREVIEW_PORT_REJECTED/u);

const acceptanceLauncher = readFileSync('scripts/start-local-acceptance.mjs', 'utf8');
assert.match(acceptanceLauncher, /FFMPEG_PATH:\s*localFfmpegPath/u, 'local acceptance must expose the bundled FFmpeg binary');
assert.match(acceptanceLauncher, /node_modules['"],\s*['"]ffmpeg-static/u, 'local acceptance must resolve FFmpeg from the project dependency');
assert.match(acceptanceLauncher, /MEDIA_QUEUE_WORKER_PROCESS:\s*'1'/u, 'local acceptance must start the durable media worker runtime');
assert.match(acceptanceLauncher, /DIGITAL_VIDEO_QUEUE_WORKER:\s*'1'/u, 'local acceptance must advance ordinary video tasks');
assert.match(acceptanceLauncher, /DIGITAL_HUMAN_LONG_WORKER:\s*'1'/u, 'local acceptance must advance long video tasks');
assert.match(acceptanceLauncher, /--max-old-space-size=8192/u, 'local acceptance builds must use the audited heap ceiling');

const redact = createLocalPreviewLogRedactor(plan.env);
for (const secret of [plan.env.DATABASE_URL, fixture().ownerConnection.password, fixture().serviceRoleKey, fixture().anonKey, base.COS_SECRET_KEY, base.COS_SECRET_ID, plan.env.COZE_SUPABASE_URL]) {
  assert.ok(!redact(`value=${secret}`).includes(secret));
}
assert.equal(redact('postgresql://another:unknown@remote.example.invalid/db'), '[database-url-redacted]');

// Execute actual lifecycle wiring with fake child/process handles only.
const host = new EventEmitter(); host.platform = 'win32';
const child = new EventEmitter(); child.pid = 45678; child.stdout = new PassThrough(); child.stderr = new PassThrough();
child.kill = () => { throw new Error('successful tree stop must not fall back'); };
const spawned = []; const stopped = []; let output = '';
const { stop } = startLocalPreviewProcess(plan, {
  process: host,
  spawn: (...args) => { spawned.push(args); return child; },
  spawnSync: (...args) => { stopped.push(args); return { status: 0 }; },
  stdout: { write: (text) => { output += text; } }, stderr: { write: (text) => { output += text; } },
});
assert.equal(spawned.length, 1);
assert.equal(spawned[0][2].shell, false);
assert.equal(spawned[0][2].windowsHide, true);
assert.equal(spawned[0][2].env.DATABASE_URL, local.databaseUrl);
child.stdout.write('synthetic-service-'); child.stdout.write('role-key\n');
assert.ok(!output.includes(fixture().serviceRoleKey), 'a secret split across chunks is redacted');
host.emit('SIGINT'); stop(); host.emit('exit');
assert.equal(stopped.length, 1);
assert.equal(stopped[0][0], 'taskkill.exe');
assert.deepEqual(stopped[0][1], ['/PID', '45678', '/T', '/F']);
child.emit('close', null);
assert.equal(host.exitCode, 0);
assert.equal(host.listenerCount('SIGTERM'), 0);
assert.equal(host.listenerCount('exit'), 0);

const configCode = ts.transpileModule(readFileSync('next.config.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
for (const [environment, requested, expected] of [
  ['development', undefined, '.next'], ['development', '.next-validation', '.next-validation'],
  ['production', '.next-validation', '.next'], ['test', '.next-validation', '.next'],
  ['development', '../other', '.next'], ['development', '.next-validation ', '.next'],
]) {
  const context = { process: { env: { NODE_ENV: environment, LOCAL_VALIDATION_DIST_DIR: requested }, cwd: () => process.cwd() }, exports: {} };
  runInNewContext(configCode, context);
  assert.equal(context.exports.default.distDir, expected);
  assert.equal(context.exports.default.output, 'standalone');
}

const result = { passed: true, dynamicGroups: 7, rejectedUnsafeConfigurations: invalid.length, localAcceptanceFfmpegBound: true, realChildProcesses: 0, databaseConnections: 0, envFilesWritten: 0, port5002Started: false };
mkdirSync('.codex-evidence/local-data-preview-20260902', { recursive: true });
writeFileSync('.codex-evidence/local-data-preview-20260902/fixture.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
