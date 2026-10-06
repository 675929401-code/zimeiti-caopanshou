import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readLocalPreviewLaunchPlan, createLocalPreviewLogRedactor, LOCAL_PREVIEW_DATA_ROOT } from './start-local-data-preview.mjs';
import { ensureLocalDataReady } from './local-data-readiness.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--build', '--check', '--candidate', '--port=5000', '--port=5002'].includes(arg))) throw new Error('LOCAL_ACCEPTANCE_ARGUMENT_REJECTED');
if (args.filter(arg => arg.startsWith('--port=')).length > 1) throw new Error('LOCAL_ACCEPTANCE_PORT_REJECTED');
const port = args.includes('--port=5000') ? 5000 : 5002;
const distDir = args.includes('--candidate') ? '.next-local-acceptance-next' : '.next-local-acceptance';
const plan = await readLocalPreviewLaunchPlan(port);
const localFfmpegPath = path.join(
  plan.cwd,
  'node_modules',
  'ffmpeg-static',
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
);
await access(localFfmpegPath);
Object.assign(plan.env, {
  NODE_ENV: 'production', LOCAL_ACCEPTANCE_PREVIEW: 'true', LOCAL_VALIDATION_DIST_DIR: distDir,
  // A production acceptance run must advance durable media tasks without a
  // browser request acting as the worker. The database leases still fence
  // duplicate claims when another acceptance process is running.
  MEDIA_QUEUE_WORKER_PROCESS: '1',
  DIGITAL_VIDEO_QUEUE_WORKER: '1',
  DIGITAL_HUMAN_LONG_WORKER: '1',
  FFMPEG_PATH: localFfmpegPath,
  APP_DATA_DIR: path.join(plan.cwd, 'data'),
  BACKUP_DIR: path.join(LOCAL_PREVIEW_DATA_ROOT, 'acceptance-backups'),
  VOICE_SQLITE_PATH: path.join(LOCAL_PREVIEW_DATA_ROOT, 'voice', 'voice.db'),
  NEXT_TELEMETRY_DISABLED: '1',
});
await access(plan.env.VOICE_SQLITE_PATH);
if (!args.includes('--build')) {
  const data = await ensureLocalDataReady(plan, { restore: !args.includes('--check') });
  if (data.restored) console.log('[local-acceptance] 本地数据库与数据接口已恢复并验证。');
}
for (const key of ['APP_DATA_DIR', 'APP_RUNTIME_DIR', 'COMMERCE_DATA_DIR', 'BACKUP_DIR', 'IDEMPOTENCY_DIR']) await mkdir(plan.env[key], { recursive: true });
if (args.includes('--check')) {
  console.log(JSON.stringify({ localDatabaseVerified: true, port, distDir, mode: 'production', started: false }));
} else {
  const next = path.join(plan.cwd, 'node_modules/next/dist/bin/next');
  const childEnv = { ...plan.env };
  if (args.includes('--build') && !String(childEnv.NODE_OPTIONS || '').includes('--max-old-space-size')) {
    childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, '--max-old-space-size=8192'].filter(Boolean).join(' ');
  }
  const child = spawn(plan.executable, args.includes('--build') ? [next, 'build', '--webpack'] : [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: plan.cwd, env: childEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const redact = createLocalPreviewLogRedactor(plan.env);
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => console.log(redact(line)));
  child.once('error', () => { console.error('LOCAL_ACCEPTANCE_START_FAILED'); process.exitCode = 1; });
  child.once('close', (code, signal) => {
    console.log(`[local-acceptance] child closed ${JSON.stringify({ code, signal })}`);
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    const forwardedSignal = 'SIGTERM';
    const delivered = child.kill(forwardedSignal);
    console.log(`[local-acceptance] parent signal forwarded ${JSON.stringify({ receivedSignal: signal, forwardedSignal, delivered })}`);
  });
}
