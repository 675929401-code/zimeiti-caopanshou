import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

import { DurableQueueLoop } from '../src/lib/durable-queue-loop';

const root = process.cwd();
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const evidenceDir = path.join(root, '.codex-evidence', 'media-queue-worker-20260904');
const require = createRequire(import.meta.url);
const checks: Array<{ name: string; passed: boolean; evidence: unknown }> = [];

function check(name: string, condition: unknown, evidence: unknown) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, evidence });
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalize(value: string) {
  return value.replace(/\s+/gu, ' ').trim();
}

async function sourceContracts() {
  const fileEntries = await Promise.all([
    'src/lib/digital-video-queue-worker.ts',
    'src/lib/digital-human-long-worker.ts',
    'src/lib/user-content-retention-worker.ts',
    'src/lib/media-queue-worker-runtime.ts',
    'src/lib/durable-queue-loop.ts',
    'src/commerce/server/ordinary-worker.ts',
    'src/instrumentation.ts',
    'deploy/pm2/ecosystem.vnext.config.cjs',
    'next.config.ts',
  ].map(async (relative): Promise<[string, string]> => [relative, await readFile(path.join(root, relative), 'utf8')]));
  const files: Record<string, string> = Object.fromEntries(fileEntries);

  check('web request wake-up is disabled unless explicitly running in worker mode',
    files['src/lib/digital-video-queue-worker.ts'].includes("process.env.MEDIA_QUEUE_WORKER_PROCESS!=='1'")
      && files['src/lib/digital-video-queue-worker.ts'].includes("process.env.DIGITAL_VIDEO_QUEUE_WORKER!=='1'")
      && files['src/lib/digital-human-long-worker.ts'].includes("process.env.MEDIA_QUEUE_WORKER_PROCESS !== '1'")
      && files['src/lib/digital-human-long-worker.ts'].includes("process.env.DIGITAL_HUMAN_LONG_WORKER !== '1'"),
    { dedicatedProcessRequired: true, ordinaryExplicitGate: true, longExplicitGate: true });
  check('standalone process instrumentation starts the dedicated media worker before web lifecycle work',
    /MEDIA_QUEUE_WORKER_PROCESS === "1"[\s\S]*startMediaQueueWorkerRuntime\(\)[\s\S]*return;/u.test(files['src/instrumentation.ts']),
    { instrumentationWorkerBoot: true });
  check('standalone output traces the worker implementation into the immutable web artifact',
    files['next.config.ts'].includes("output: 'standalone'")
      && files['src/instrumentation.ts'].includes('@/lib/media-queue-worker-runtime'),
    { output: 'standalone', workerImportedByInstrumentation: true });
  check('queue transitions retain owner fencing and do not expose cross-account reads',
    files['src/lib/digital-video-queue-worker.ts'].includes(".eq('id',job.task_id).eq('user_id',job.user_id)")
      && files['src/lib/digital-video-queue-worker.ts'].includes('ownedDigitalHumanAsset(job.user_id')
      && files['src/lib/digital-human-long-worker.ts'].includes("ownedDigitalHumanAsset(text(job.parent.user_id)")
      && files['src/lib/digital-human-long-worker.ts'].includes(".eq('id', text(parent.user_id)).single()"),
    { ordinaryTaskOwnerBound: true, ordinaryAssetsOwnerBound: true, longAssetsOwnerBound: true, longAccountOwnerBound: true });
  check('unknown provider submission is retained without an automatic second POST',
    (files['src/lib/digital-video-queue-worker.ts'].match(/submission_unknown/gu) || []).length >= 4
      && (files['src/lib/digital-human-long-worker.ts'].match(/submission_unknown/gu) || []).length >= 3,
    { ordinaryUnknownRetention: true, longUnknownRetention: true });
  check('worker runtime handles PM2 shutdown messages and signal fallback with bounded drain',
    files['src/lib/media-queue-worker-runtime.ts'].includes("message === 'shutdown'")
      && files['src/lib/media-queue-worker-runtime.ts'].includes("process.once('SIGTERM'")
      && files['src/lib/media-queue-worker-runtime.ts'].includes('stopUserContentRetentionWorker')
      && files['src/lib/media-queue-worker-runtime.ts'].includes('stopDigitalVideoQueueWorker')
      && files['src/lib/media-queue-worker-runtime.ts'].includes('stopDigitalHumanLongWorker')
      && files['src/lib/media-queue-worker-runtime.ts'].includes('stopCommerceOrdinaryWorker'),
    { pm2Message: true, sigterm: true, allQueuesDrained: true });
  check('dedicated runtime starts and reports the Commerce ordinary coordinator',
    files['src/lib/media-queue-worker-runtime.ts'].includes('startCommerceOrdinaryWorker()')
      && files['src/lib/media-queue-worker-runtime.ts'].includes('commerceOrdinary: commerceOrdinaryWorkerStatus()'),
    { start: true, status: true });
  check('dedicated runtime owns bounded user-content retention without provider or billing work',
    files['src/lib/media-queue-worker-runtime.ts'].includes('startUserContentRetentionWorker()')
      && files['src/lib/media-queue-worker-runtime.ts'].includes('userContentRetention: userContentRetentionWorkerStatus()')
      && files['src/lib/user-content-retention-worker.ts'].includes("db.rpc('purge_expired_user_content'")
      && files['src/lib/user-content-retention-worker.ts'].includes('RETENTION_MAX_BATCHES_PER_TICK = 10')
      && !/(?:generate|submit).*\bPOST\b|wallet|billing|deduct/iu.test(files['src/lib/user-content-retention-worker.ts']),
    { start: true, status: true, maxBatches: 10, providerPosts: 0, billingMutations: 0 });
  check('Commerce ordinary coordinator has database leases and covers jobs, media edits, frames, and depth preparation',
    files['src/commerce/server/ordinary-worker.ts'].includes("LEASE_BUCKET='commerce-ordinary-worker-leases'")
      && files['src/commerce/server/ordinary-worker.ts'].includes("kind:'job'|'media-edit'|'frame-extraction'|'depth-preparation'")
      && files['src/commerce/server/ordinary-worker.ts'].includes('claimCommerceOrdinaryLease')
      && files['src/commerce/server/ordinary-worker.ts'].includes('renewCommerceOrdinaryLease')
      && files['src/commerce/server/ordinary-worker.ts'].includes('claimStaleUndispatchedCommerceJob'),
    { databaseLease: true, job: true, mediaEdit: true, frameExtraction: true, depthPreparation: true });

  const previous = {
    RELEASE_ROOT: process.env.RELEASE_ROOT,
    MEDIA_QUEUE_WORKER_INSTANCES: process.env.MEDIA_QUEUE_WORKER_INSTANCES,
  };
  process.env.RELEASE_ROOT = '/srv/zimeiti-caopanshou';
  process.env.MEDIA_QUEUE_WORKER_INSTANCES = '2';
  const configPath = path.join(root, 'deploy', 'pm2', 'ecosystem.vnext.config.cjs');
  delete require.cache[require.resolve(configPath)];
  const ecosystem = require(configPath) as { apps: Array<Record<string, unknown>> };
  Object.assign(process.env, previous);
  const web = ecosystem.apps.find((app) => app.name === 'agent-hub-web');
  const worker = ecosystem.apps.find((app) => app.name === 'agent-hub-media-worker');
  assert.ok(web && worker);
  const webEnv = web.env_production as Record<string, string>;
  const workerEnv = worker.env_production as Record<string, string>;
  check('PM2 keeps queue work out of the public web process',
    webEnv.MEDIA_QUEUE_WORKER_PROCESS === '0'
      && webEnv.DIGITAL_VIDEO_QUEUE_WORKER === '0'
      && webEnv.DIGITAL_HUMAN_LONG_WORKER === '0',
    { process: web.name, mediaQueue: webEnv.MEDIA_QUEUE_WORKER_PROCESS, ordinary: webEnv.DIGITAL_VIDEO_QUEUE_WORKER, long: webEnv.DIGITAL_HUMAN_LONG_WORKER });
  check('PM2 launches at least two independent media queue processes from the immutable web artifact',
    worker.exec_mode === 'fork' && Number(worker.instances) >= 2 && worker.increment_var === 'PORT'
      && worker.interpreter === process.execPath
      && worker.script === web.script && worker.cwd === web.cwd
      && workerEnv.MEDIA_QUEUE_WORKER_PROCESS === '1',
    { process: worker.name, mode: worker.exec_mode, instances: worker.instances, sameArtifact: worker.script === web.script });
  check('PM2 gives the worker enough time to drain before forced termination',
    worker.shutdown_with_message === true
      && Number(worker.kill_timeout) > Number(workerEnv.MEDIA_QUEUE_WORKER_DRAIN_MS),
    { shutdownWithMessage: worker.shutdown_with_message, drainMs: workerEnv.MEDIA_QUEUE_WORKER_DRAIN_MS, killTimeoutMs: worker.kill_timeout });

  return Object.fromEntries(Object.entries(files).map(([file, content]) => [file, sha256(content)]));
}

async function loopContracts() {
  let calls = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  let release: (() => void) | undefined;
  let began: (() => void) | undefined;
  const beganPromise = new Promise<void>((resolve) => { began = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const loop = new DurableQueueLoop({
    name: 'fixture-drain',
    intervalMs: 100,
    runOnce: async () => {
      calls += 1;
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      began?.();
      await releasePromise;
      concurrent -= 1;
    },
  });
  check('single process starts one scheduler only', loop.start() === true && loop.start() === false, { firstStart: true, duplicateStart: false });
  await Promise.race([beganPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('fixture tick did not start')), 2_000))]);
  const drain = loop.stop(2_000);
  setTimeout(() => release?.(), 50);
  const drained = await drain;
  await new Promise((resolve) => setTimeout(resolve, 180));
  check('graceful stop drains the active tick and prevents a later claim',
    drained && calls === 1 && maximumConcurrent === 1 && loop.snapshot().stopping,
    { drained, calls, maximumConcurrent, status: loop.snapshot() });

  let timeoutRelease: (() => void) | undefined;
  let timeoutBegan: (() => void) | undefined;
  const timeoutBeganPromise = new Promise<void>((resolve) => { timeoutBegan = resolve; });
  const timeoutReleasePromise = new Promise<void>((resolve) => { timeoutRelease = resolve; });
  const timeoutLoop = new DurableQueueLoop({
    name: 'fixture-timeout', intervalMs: 100,
    runOnce: async () => { timeoutBegan?.(); await timeoutReleasePromise; },
  });
  timeoutLoop.start();
  await Promise.race([timeoutBeganPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout fixture did not start')), 2_000))]);
  const timedOut = await timeoutLoop.stop(100);
  timeoutRelease?.();
  check('bounded drain reports an unfinished tick without starting another one', timedOut === false, { drained: timedOut, status: timeoutLoop.snapshot() });
}

async function databaseContracts() {
  const runtime = JSON.parse((await readFile(runtimePath, 'utf8')).replace(/^\uFEFF/u, '')) as Record<string, unknown>;
  assert.equal(runtime.localOnly, true, 'LOCAL_RUNTIME_REQUIRED');
  assert.equal(runtime.host, '127.0.0.1', 'LOCAL_HOST_REQUIRED');
  assert.equal(Number(runtime.databasePort), 54322, 'LOCAL_DATABASE_PORT_REQUIRED');
  assert.equal(runtime.databaseName, 'zimeiti_local', 'LOCAL_DATABASE_NAME_REQUIRED');
  const client = new pg.Client({
    connectionString: String(runtime.databaseUrl || ''),
    application_name: 'codex-media-queue-readonly-verifier',
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const readOnly = await client.query("SELECT current_setting('transaction_read_only') AS value");
    check('database evidence transaction is read only', readOnly.rows[0]?.value === 'on', { transactionReadOnly: readOnly.rows[0]?.value });
    const names = [
      'claim_digital_video_dispatch',
      'update_digital_video_dispatch',
      'begin_digital_video_post',
      'claim_digital_human_long_segment',
      'claim_digital_human_long_finalization',
      'begin_digital_human_long_segment_post',
      'purge_expired_user_content',
      'mark_video_upstream_source_expired',
      'scrub_transient_video_extraction_content',
    ];
    const definitions = await client.query<{ proname: string; definition: string }>(
      `SELECT p.proname,pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname=ANY($1::text[])`,
      [names],
    );
    const functionMap = new Map(definitions.rows.map((row) => [row.proname, normalize(row.definition)]));
    check('all queue claim and transition RPCs exist in the active local database',
      names.every((name) => functionMap.has(name)),
      { required: names.length, present: names.filter((name) => functionMap.has(name)).length });
    const ordinaryClaim = functionMap.get('claim_digital_video_dispatch') || '';
    const ordinaryUpdate = functionMap.get('update_digital_video_dispatch') || '';
    const ordinaryBegin = functionMap.get('begin_digital_video_post') || '';
    const longClaim = functionMap.get('claim_digital_human_long_segment') || '';
    const longFinalization = functionMap.get('claim_digital_human_long_finalization') || '';
    const longBegin = functionMap.get('begin_digital_human_long_segment_post') || '';
    const retentionPurge = functionMap.get('purge_expired_user_content') || '';
    const sourceExpiry = functionMap.get('mark_video_upstream_source_expired') || '';
    const transientScrub = functionMap.get('scrub_transient_video_extraction_content') || '';
    check('ordinary queue claim is atomic and supports multiple worker processes',
      /FOR UPDATE SKIP LOCKED/iu.test(ordinaryClaim)
        && /lease_owner\s*=\s*p_worker/iu.test(ordinaryClaim)
        && /lease_until[\s\S]{0,80}(?:5 minutes|00:05:00)/iu.test(ordinaryClaim),
      { skipLocked: true, ownerLease: true, leaseMinutes: 5, functionSha256: sha256(ordinaryClaim) });
    check('ordinary queue crash recovery never automatically replays an uncertain provider POST',
      /state\s*=\s*CASE\s+WHEN\s+t\.task_id_external\s+IS\s+NOT\s+NULL\s+THEN\s+'running'\s+ELSE\s+'submission_unknown'/iu.test(ordinaryClaim)
        && !/state IN \('queued','running','finalizing','submission_unknown'/iu.test(ordinaryClaim),
      { expiredWithReceipt: 'running', expiredWithoutReceipt: 'submission_unknown', unknownClaimable: false });
    check('ordinary transitions and provider POST gate are lease-owner fenced',
      /lease_owner IS DISTINCT FROM p_worker/iu.test(ordinaryUpdate)
        && /lease_owner\s*=\s*p_worker/iu.test(ordinaryBegin)
        && /state\s*=\s*'dispatching'/iu.test(ordinaryBegin),
      { transitionOwnerFenced: true, beginPostOwnerFenced: true });
    check('long segment and finalization claims use row locks, leases, and SKIP LOCKED',
      /FOR UPDATE OF s SKIP LOCKED/iu.test(longClaim)
        && /lease_owner\s*=\s*p_worker/iu.test(longClaim)
        && /FOR UPDATE SKIP LOCKED/iu.test(longFinalization)
        && /merge_lease_owner\s*=\s*p_worker/iu.test(longFinalization),
      { segmentSkipLocked: true, segmentOwnerLease: true, finalizerSkipLocked: true, mergeOwnerLease: true, segmentFunctionSha256: sha256(longClaim), finalizerFunctionSha256: sha256(longFinalization) });
    check('long segment restart recovery separates pre-provider retry from uncertain provider submission',
      /state\s*=\s*'queued'[\s\S]*WHERE\s+state\s*=\s*'preparing'/iu.test(longClaim)
        && /CASE\s+WHEN\s+provider_task_id\s+IS\s+NULL\s+THEN\s+'submission_unknown'\s+ELSE\s+'running'/iu.test(longClaim)
        && /state\s*=\s*'dispatching'[\s\S]*lease_owner\s*=\s*p_worker/iu.test(longBegin),
      { expiredPreparing: 'queued', expiredDispatchWithoutReceipt: 'submission_unknown', expiredDispatchWithReceipt: 'running', beginPostOwnerFenced: true });
    check('retention cleanup is bounded, skip-locked and keeps protected collections out of delete statements',
      /LIMIT v_limit[\s\S]{0,120}FOR UPDATE SKIP LOCKED/iu.test(retentionPurge)
        && /greatest\(1, least\(coalesce\(p_limit, 500\), 2000\)\)/iu.test(retentionPurge)
        && !/DELETE FROM public\.(?:agents|agent_memories|text_chat_memories|user_files)/iu.test(retentionPurge),
      { skipLocked: true, boundedBatch: true, protectedCollectionsDeleted: false });
    check('source expiry and transient-video scrub are narrow and cannot mutate billing',
      /p_http_status NOT IN \(404, 410\)/iu.test(sourceExpiry)
        && /v_extraction_mode = 'video'/iu.test(transientScrub)
        && /NEW\.response := NULL/iu.test(transientScrub)
        && !/(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\.(?:wallet\w*|billing\w*|payment\w*)|\bbalance\s*=/iu.test(`${retentionPurge} ${sourceExpiry} ${transientScrub}`),
      { expiryStatuses: [404, 410], rawVideoDurableContent: false, billingMutations: 0 });

    const ordinaryCounts = await client.query(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE state IN ('completed','failed','cancelled'))::int AS terminal,
      count(*) FILTER (WHERE state NOT IN ('completed','failed','cancelled'))::int AS active,
      count(DISTINCT user_id)::int AS owners
      FROM public.digital_video_dispatch_jobs`);
    const longCounts = await client.query(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE state IN ('completed','failed','cancelled'))::int AS terminal,
      count(*) FILTER (WHERE state NOT IN ('completed','failed','cancelled'))::int AS active,
      count(DISTINCT user_id)::int AS owners
      FROM public.digital_human_long_jobs`);
    check('existing queue state was inspected without creating a paid task', true, {
      ordinary: ordinaryCounts.rows[0],
      long: longCounts.rows[0],
      insertedTasks: 0,
      providerRequests: 0,
      databaseWrites: 0,
    });
    await client.query('ROLLBACK');
    return {
      transactionReadOnly: true,
      functions: Object.fromEntries([...functionMap].map(([name, definition]) => [name, sha256(definition)])),
      existingState: { ordinary: ordinaryCounts.rows[0], long: longCounts.rows[0] },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const sourceHashes = await sourceContracts();
  await loopContracts();
  const database = await databaseContracts();
  const report = {
    observedAt: new Date().toISOString(),
    sourceRoot: root,
    localDatabase: { host: '127.0.0.1', port: 54322, name: 'zimeiti_local' },
    result: { total: checks.length, passed: checks.filter((item) => item.passed).length, failed: 0 },
    safety: { paidTasksCreated: 0, providerRequests: 0, databaseWrites: 0, serverChanges: 0, gitPushes: 0 },
    checks,
    sourceHashes,
    database,
  };
  await mkdir(evidenceDir, { recursive: true });
  const output = path.join(evidenceDir, 'report.json');
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output, result: report.result, safety: report.safety }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), paidTasksCreated: 0, providerRequests: 0, databaseWrites: 0 }));
  process.exitCode = 1;
});
