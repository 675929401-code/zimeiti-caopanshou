import { spawn, spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

export const LOCAL_PREVIEW_PROJECT_ROOT = 'F:\\总项目文件\\Skill存储系统\\01_网页开发项目\\自媒体操盘手\\当前版本';
export const LOCAL_PREVIEW_DATA_ROOT = 'F:\\总项目文件\\Skill存储系统\\运行数据\\自媒体操盘手\\local-data-20260902';
export const LOCAL_PREVIEW_RUNTIME_FILE = path.win32.join(LOCAL_PREVIEW_DATA_ROOT, 'config', 'runtime.json');
const DEFAULT_PREVIEW_PORT = 5002;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

class LocalPreviewError extends Error {
  constructor(code) { super(code); this.name = 'LocalPreviewError'; }
}

function requiredString(value, code) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/u.test(value)) throw new LocalPreviewError(code);
  return value;
}

/** Pure validation: no database connection, file mutation or process launch. */
export function validateLocalPreviewRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object' || runtime.localOnly !== true) throw new LocalPreviewError('LOCAL_PREVIEW_CONFIG_NOT_LOCAL');
  const connection = runtime.ownerConnection;
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw new LocalPreviewError('LOCAL_PREVIEW_OWNER_CONNECTION_REQUIRED');
  const allowedFields = new Set(['host', 'port', 'database', 'user', 'password']);
  if (Object.keys(connection).some((field) => !allowedFields.has(field))) throw new LocalPreviewError('LOCAL_PREVIEW_CONNECTION_OPTIONS_REJECTED');
  if (!LOOPBACK_HOSTS.has(connection.host) || Number(connection.port) !== 54322 || connection.database !== 'zimeiti_local') throw new LocalPreviewError('LOCAL_PREVIEW_DATABASE_TARGET_REJECTED');
  if (runtime.databasePort !== 54322 || runtime.databaseName !== 'zimeiti_local') throw new LocalPreviewError('LOCAL_PREVIEW_DATABASE_IDENTITY_MISMATCH');
  const user = requiredString(connection.user, 'LOCAL_PREVIEW_OWNER_USER_REQUIRED');
  const password = requiredString(connection.password, 'LOCAL_PREVIEW_OWNER_PASSWORD_REQUIRED');
  // Rebuild from the validated fields. A supplied connection string, hostaddr,
  // options or query can never redirect the driver's connection elsewhere.
  const database = new URL('postgresql://127.0.0.1:54322/zimeiti_local');
  database.username = encodeURIComponent(user);
  database.password = encodeURIComponent(password);

  let supabase;
  try { supabase = new URL(requiredString(runtime.supabaseUrl, 'LOCAL_PREVIEW_REST_URL_REQUIRED')); }
  catch { throw new LocalPreviewError('LOCAL_PREVIEW_REST_TARGET_REJECTED'); }
  if (supabase.protocol !== 'http:' || !LOOPBACK_HOSTS.has(supabase.hostname) || supabase.port !== '54321'
    || supabase.pathname !== '/' || supabase.search || supabase.hash || supabase.username || supabase.password) {
    throw new LocalPreviewError('LOCAL_PREVIEW_REST_TARGET_REJECTED');
  }
  return {
    databaseUrl: database.toString(),
    // Pin both clients to a literal loopback address; never resolve a hostname.
    supabaseUrl: 'http://127.0.0.1:54321',
    serviceRoleKey: requiredString(runtime.serviceRoleKey, 'LOCAL_PREVIEW_SERVICE_ROLE_KEY_REQUIRED'),
    anonKey: requiredString(runtime.anonKey, 'LOCAL_PREVIEW_ANON_KEY_REQUIRED'),
    jwtSecret: requiredString(runtime.jwtSecret, 'LOCAL_PREVIEW_JWT_SECRET_REQUIRED'),
  };
}

/** Secrets remain in the returned child environment, never in argv or logs. */
export function createLocalPreviewLaunchPlan(runtime, baseEnv, inheritedEnv = process.env, nodeExecutable = process.execPath, port = DEFAULT_PREVIEW_PORT) {
  if (port !== 5000 && port !== 5002) throw new LocalPreviewError('LOCAL_PREVIEW_PORT_REJECTED');
  const local = validateLocalPreviewRuntime(runtime);
  const env = {
    ...inheritedEnv,
    ...baseEnv,
    COZE_SUPABASE_URL: local.supabaseUrl,
    COZE_SUPABASE_SERVICE_ROLE_KEY: local.serviceRoleKey,
    COZE_SUPABASE_ANON_KEY: local.anonKey,
    JWT_SECRET: local.jwtSecret,
    DATABASE_URL: local.databaseUrl,
    // Local acceptance must keep shared configuration on the same verified
    // loopback database as user/task data. Inheriting the cloud configuration
    // URL makes a local UI test read or mutate a different environment.
    SHARED_CONFIGURATION_ENABLED: '1',
    SHARED_CONFIGURATION_SUPABASE_URL: local.supabaseUrl,
    SHARED_CONFIGURATION_SERVICE_ROLE_KEY: local.serviceRoleKey,
    SHARED_CONFIGURATION_ID: 'local-acceptance',
    LOCAL_RUNTIME_PROFILE: 'local-acceptance',
    LOCAL_ACCEPTANCE_PREVIEW: 'true',
    NODE_ENV: 'development',
    LOCAL_VALIDATION_DIST_DIR: '.next-validation',
    SAFE_FETCH_PUBLIC_DNS: 'cloudflare-doh-v1',
    AUTODL_H3_LIFECYCLE_ENABLED: 'false',
    DIGITAL_VIDEO_QUEUE_WORKER: '1',
    APP_RUNTIME_DIR: path.win32.join(LOCAL_PREVIEW_DATA_ROOT, 'preview-runtime'),
    COMMERCE_DATA_DIR: path.win32.join(LOCAL_PREVIEW_DATA_ROOT, 'preview-runtime', 'commerce-agent'),
    COMMERCE_DISCOVERY_CATALOG: path.win32.join(LOCAL_PREVIEW_DATA_ROOT, 'preview-runtime', 'commerce-discovery', 'catalog.json'),
    COMMERCE_GATEWAY_KEY_FILE: path.win32.join(LOCAL_PREVIEW_DATA_ROOT, 'preview-runtime', 'commerce-agent', 'main-gateway.key'),
    IDEMPOTENCY_DIR: path.win32.join(LOCAL_PREVIEW_DATA_ROOT, 'preview-runtime', 'llm-request-idempotency'),
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
  };
  const nodeDirectory = path.dirname(nodeExecutable);
  const currentPath = env.Path || env.PATH || '';
  const runtimePath = [nodeDirectory, ...currentPath.split(path.delimiter).filter((entry) => entry && entry !== nodeDirectory)].join(path.delimiter);
  env.Path = runtimePath;
  env.PATH = runtimePath;
  return {
    executable: nodeExecutable,
    args: [path.win32.join(LOCAL_PREVIEW_PROJECT_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)],
    cwd: LOCAL_PREVIEW_PROJECT_ROOT,
    env,
  };
}

export function createLocalPreviewLogRedactor(env) {
  const secrets = [...new Set(Object.entries(env)
    .filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CONNECTION|DATABASE_URL|SUPABASE_URL)/iu.test(key) && typeof value === 'string' && value)
    .map(([, value]) => value))].sort((left, right) => right.length - left.length);
  // Also remove the decoded/encoded database password if a driver logs it alone.
  try { const url = new URL(env.DATABASE_URL); secrets.push(url.password, decodeURIComponent(url.password)); } catch { /* no raw diagnostic */ }
  return (line) => {
    let text = String(line);
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[database-url-redacted]');
  };
}

/** Own only the child tree created here; never discover or kill by port. */
export function startLocalPreviewProcess(plan, dependencies = {}) {
  const spawnProcess = dependencies.spawn || spawn;
  const spawnSyncProcess = dependencies.spawnSync || spawnSync;
  const hostProcess = dependencies.process || process;
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const redact = createLocalPreviewLogRedactor(plan.env);
  const child = spawnProcess(plan.executable, plan.args, {
    cwd: plan.cwd, env: plan.env, shell: false, windowsHide: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const readers = [];
  for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]]) {
    if (!stream) continue;
    const reader = createInterface({ input: stream });
    reader.on('line', (line) => output.write(`${redact(line)}\n`));
    readers.push(reader);
  }
  let stopping = false;
  let finished = false;
  const stop = () => {
    if (stopping || finished || !Number.isInteger(child.pid) || child.pid <= 0) return;
    stopping = true;
    if (hostProcess.platform === 'win32') {
      // Next dev forks its server. Killing only the CLI leaves that server alive.
      const result = spawnSyncProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      if (result.error || result.status !== 0) child.kill('SIGTERM');
    } else child.kill('SIGTERM');
  };
  const cleanup = () => {
    finished = true;
    for (const signal of ['SIGINT', 'SIGTERM', 'exit']) hostProcess.removeListener(signal, stop);
    for (const reader of readers) reader.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'exit']) hostProcess.once(signal, stop);
  child.once('error', () => {
    stderr.write('[local-data-preview] CHILD_START_FAILED\n');
    hostProcess.exitCode = 1;
    cleanup();
  });
  child.once('close', (code) => {
    hostProcess.exitCode = stopping ? 0 : (Number.isInteger(code) ? code : 1);
    stdout.write(`[local-data-preview] child stopped; exitCode=${hostProcess.exitCode}\n`);
    cleanup();
  });
  stdout.write(`[local-data-preview] development child started; port=${plan.env.PORT}; distDir=.next-validation\n`);
  return { child, stop };
}

export async function readLocalPreviewLaunchPlan(port = DEFAULT_PREVIEW_PORT) {
  let runtime;
  let baseEnv;
  try {
    const scriptRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
    if (path.win32.normalize(scriptRoot).toLowerCase() !== path.win32.normalize(LOCAL_PREVIEW_PROJECT_ROOT).toLowerCase()) throw new LocalPreviewError('LOCAL_PREVIEW_SOURCE_ROOT_REJECTED');
    runtime = JSON.parse(await readFile(LOCAL_PREVIEW_RUNTIME_FILE, 'utf8'));
    baseEnv = parseDotenv(await readFile(path.win32.join(LOCAL_PREVIEW_PROJECT_ROOT, '.env.local')));
  } catch (error) {
    if (error instanceof LocalPreviewError) throw error;
    // JSON/parser/filesystem diagnostics can contain credentials or file content.
    throw new LocalPreviewError('LOCAL_PREVIEW_CONFIG_READ_FAILED');
  }
  return createLocalPreviewLaunchPlan(runtime, baseEnv, process.env, process.execPath, port);
}

export function parseLocalPreviewArguments(args) {
  const portArguments = args.filter((argument) => argument.startsWith('--port='));
  if (portArguments.length > 1 || args.some((argument) => !['--check', '--port=5000', '--port=5002'].includes(argument))) throw new LocalPreviewError('LOCAL_PREVIEW_ARGUMENT_REJECTED');
  return { port: portArguments[0] === '--port=5000' ? 5000 : DEFAULT_PREVIEW_PORT, check: args.includes('--check') };
}

async function main() {
  const args = parseLocalPreviewArguments(process.argv.slice(2));
  const plan = await readLocalPreviewLaunchPlan(args.port);
  if (args.check) {
    console.log(JSON.stringify({ valid: true, databaseTargetVerified: true, restTargetVerified: true, port: args.port, distDir: '.next-validation', started: false }));
    return;
  }
  startLocalPreviewProcess(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[local-data-preview] ${error instanceof LocalPreviewError ? error.message : 'LOCAL_PREVIEW_START_FAILED'}`);
    process.exitCode = 1;
  });
}
