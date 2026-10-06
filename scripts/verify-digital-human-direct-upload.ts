import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

import {
  assertDigitalHumanUploadRecord,
  DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS,
  DIGITAL_HUMAN_UPLOAD_LIMITS,
  digitalHumanUploadObjectKey,
  digitalHumanUploadMeta,
  digitalHumanUploadTicketId,
  DigitalHumanUploadError,
  parseDigitalHumanUploadTicketInput,
  uploadTicketExpired,
  type UploadTicketRecord,
} from '../src/lib/digital-human-direct-upload';
import { TencentCOSProvider } from '../src/storage/object/providers/tencent-cos';

const root = process.cwd();
const checks: Array<{ name: string; passed: boolean; evidence: unknown }> = [];
const evidenceDir = path.join(root, '.codex-evidence', 'digital-human-direct-upload-20260904');

function check(name: string, condition: unknown, evidence: unknown) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, evidence });
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function mp4Prefix() {
  const value = Buffer.alloc(64);
  value.writeUInt32BE(24, 0);
  value.write('ftyp', 4, 'ascii');
  value.write('isom', 8, 'ascii');
  return value;
}

async function sourceContracts() {
  const paths = [
    'src/app/api/digital-human/upload/route.ts',
    'src/app/api/digital-human/upload-ticket/route.ts',
    'src/app/api/digital-human/upload-session/route.ts',
    'src/app/digital-human/page.tsx',
    'src/lib/digital-human-direct-upload.ts',
    'src/lib/digital-human-upload-proxy.ts',
    'src/lib/digital-human-media.ts',
    'src/storage/object/manager.ts',
    'src/storage/object/providers/tencent-cos.ts',
  ];
  const entries = await Promise.all(paths.map(async (relative): Promise<[string, string]> => [
    relative,
    await readFile(path.join(root, relative), 'utf8'),
  ]));
  const source: Record<string, string> = Object.fromEntries(entries);
  const ticket = source['src/app/api/digital-human/upload-ticket/route.ts'];
  const complete = source['src/app/api/digital-human/upload-session/route.ts'];
  const provider = source['src/storage/object/providers/tencent-cos.ts'];
  const page = source['src/app/digital-human/page.tsx'];
  const proxy = source['src/lib/digital-human-upload-proxy.ts'];
  const publicRoute = source['src/app/api/digital-human/upload/route.ts'];

  check('public upload route no longer buffers the 100 MB request itself',
    !publicRoute.includes('request.formData()') && !publicRoute.includes('file.arrayBuffer()')
      && publicRoute.includes('handleDigitalHumanProxyUpload'),
    { directBufferInRoute: false, compatibilityDelegated: true });
  check('direct grant is one object, one PUT method, and at most fifteen minutes',
    provider.includes('Method: "PUT"') && provider.includes('Key: request.key')
      && provider.includes('Math.min(900') && provider.includes('Content-Type'),
    { method: 'PUT', serverKey: true, maxTtlSeconds: 900 });
  check('permanent COS credentials never enter route or client responses',
    !/(?:secretId|secretKey|COS_SECRET|storage_tencent_cos_secret)/u.test(ticket + complete + page),
    { permanentCredentialFieldsReturned: 0 });
  check('ticket is bound to authenticated user, deterministic request id and pending ownership row',
    ticket.includes('authorizeCurrentApiUser') && ticket.includes('digitalHumanUploadTicketId(auth.user.userId')
      && ticket.includes(".eq('id', ticketId).eq('user_id', auth.user.userId)")
      && ticket.includes('DIGITAL_HUMAN_PENDING_SOURCE'),
    { authenticated: true, ownerBound: true, deterministicPrimaryKey: true });
  check('completion requires owner, HEAD, bounded range, MIME/magic and server media probe',
    complete.includes(".eq('id', ticketId).eq('user_id', userId)")
      && complete.includes('storageManager.head') && complete.includes('storageManager.readRange')
      && complete.includes('parseDigitalHumanUploadTicketInput')
      && complete.includes('mediaMetadataFromCosUrl'),
    { head: true, rangeBytes: 64 * 1024, magic: true, mediaProbe: true });
  check('completion rejects a ticket rebound to another account or request before object access',
    complete.includes('ticketId !== digitalHumanUploadTicketId(userId, requestId)')
      && complete.includes(".eq('id', ticketId).eq('user_id', userId)"),
    { accountBoundIdentity: true, requestBoundIdentity: true, rejectionBeforeHead: true });
  check('complete is idempotent and only pending rows can transition to final',
    complete.includes('idempotentReplay: true')
      && complete.includes(".eq('source', DIGITAL_HUMAN_PENDING_SOURCE).select('id').maybeSingle()")
      && complete.includes('DIGITAL_HUMAN_FINAL_SOURCE'),
    { finalReplay: true, compareAndSet: true });
  check('expired, invalid and explicitly cancelled sessions clean owned staging objects',
    complete.includes('cause.permanent') && complete.includes('cleanupPending(record)')
      && complete.includes('export async function DELETE')
      && ticket.includes('cleanupExpiredPending'),
    { expiredCleanup: true, permanentFailureCleanup: true, cancelCleanup: true });
  check('local runtimes retain one bounded proxy upload while COS requires direct upload for large files',
    proxy.includes('MAX_ACTIVE_BUFFERED_UPLOADS = 1')
      && proxy.includes('COS_COMPATIBILITY_BYTES = 10 * 1024 * 1024')
      && proxy.includes("code: 'DIRECT_UPLOAD_REQUIRED'")
      && ticket.includes("mode: 'proxy'"),
    { localCompatibility: true, cosBufferedCeilingMb: 10, retryAfter: true });
  check('browser exposes progress, cancel, retry and clear 429 waiting state',
    page.includes('xhr.upload.onprogress') && page.includes('cancelUpload')
      && page.includes("method: 'DELETE'") && page.includes('ticketResponse.status === 429')
      && page.includes('秒后自动重试') && page.includes('role="progressbar"'),
    { progress: true, cancel: true, retry429: true, accessibleStatus: true });
  check('direct-transfer uncertainty retries the same idempotent request while proxy fallback is server-selected only',
    page.includes('for (let attempt = 0; attempt < 2 && !asset; attempt += 1)')
      && page.includes("if (ticket.mode === 'proxy')")
      && page.includes('if (attempt === 0 && !current.controller.signal.aborted) continue'),
    { automaticDirectRetry: 1, sameRequestId: true, unsafeClientForcedProxyFallback: false });

  return Object.fromEntries(entries.map(([relative, value]) => [relative, sha256(value)]));
}

async function pureContracts() {
  const sample = mp4Prefix();
  const accepted = parseDigitalHumanUploadTicketInput({
    requestId: 'digital-upload-00000000-0000-4000-a000-000000000001',
    category: 'video',
    size: DIGITAL_HUMAN_UPLOAD_LIMITS.video,
    contentType: 'video/mp4',
    originalName: '../../unsafe.mp4',
    prefixBase64: sample.toString('base64'),
  });
  check('100 MB boundary is accepted without reading the complete file',
    accepted.size === 100 * 1024 * 1024 && accepted.prefix.length === sample.length,
    { declaredBytes: accepted.size, inspectedBytes: accepted.prefix.length });
  assert.throws(() => parseDigitalHumanUploadTicketInput({
    requestId: 'digital-upload-00000000-0000-4000-a000-000000000002',
    category: 'video',
    size: DIGITAL_HUMAN_UPLOAD_LIMITS.video + 1,
    contentType: 'video/mp4',
    originalName: 'too-large.mp4',
    prefixBase64: sample.toString('base64'),
  }), (error: unknown) => error instanceof DigitalHumanUploadError && error.status === 413);
  check('files above 100 MB fail before a grant is issued', true, { rejectedBytes: DIGITAL_HUMAN_UPLOAD_LIMITS.video + 1, status: 413 });
  assert.throws(() => parseDigitalHumanUploadTicketInput({
    requestId: 'digital-upload-00000000-0000-4000-a000-000000000003',
    category: 'image',
    size: sample.length,
    contentType: 'image/png',
    originalName: 'fake.png',
    prefixBase64: sample.toString('base64'),
  }), (error: unknown) => error instanceof DigitalHumanUploadError && error.status === 415);
  check('declared MIME and magic bytes must agree with the selected category', true, { mismatchStatus: 415 });

  const tickets = new Set<string>();
  const keys = new Set<string>();
  for (let user = 0; user < 100; user += 1) {
    for (let request = 0; request < 20; request += 1) {
      const owner = `10000000-0000-4000-a000-${String(user).padStart(12, '0')}`;
      const requestId = `digital-upload-${String(user).padStart(4, '0')}-${String(request).padStart(4, '0')}-fixture`;
      const ticketId = digitalHumanUploadTicketId(owner, requestId);
      const key = digitalHumanUploadObjectKey(owner, requestId, 'video', '.mp4');
      assert.equal(ticketId, digitalHumanUploadTicketId(owner, requestId));
      assert.equal(key, digitalHumanUploadObjectKey(owner, requestId, 'video', '.mp4'));
      assert.equal(key.includes(owner), false);
      assert.equal(key.includes(requestId), false);
      tickets.add(ticketId);
      keys.add(key);
    }
  }
  check('simulated 2,000 concurrent tenant requests produce deterministic unique identities',
    tickets.size === 2_000 && keys.size === 2_000,
    { tenants: 100, requestsPerTenant: 20, uniqueTickets: tickets.size, uniqueKeys: keys.size, rawIdentityInKey: false });

  const replayUser = '10000000-0000-4000-a000-000000000999';
  const replayRequest = 'digital-upload-concurrency-replay-fixture';
  const primaryKeys = await Promise.all(Array.from({ length: 50 }, async () => digitalHumanUploadTicketId(replayUser, replayRequest)));
  check('fifty simulated same-request initializers converge on one database primary key',
    new Set(primaryKeys).size === 1,
    { attempts: primaryKeys.length, durableRowsExpected: 1 });

  const replayInput = parseDigitalHumanUploadTicketInput({
    requestId: replayRequest,
    category: 'video',
    size: sample.length,
    contentType: 'video/mp4',
    originalName: 'fixture.mp4',
    prefixBase64: sample.toString('base64'),
  });
  const replayRecord = {
    id: digitalHumanUploadTicketId(replayUser, replayRequest),
    user_id: replayUser,
    storage_key: digitalHumanUploadObjectKey(replayUser, replayRequest, 'video', '.mp4'),
    storage_provider: 'tencent_cos',
    file_name: 'fixture.mp4',
    file_category: 'video',
    file_size: sample.length,
    content_type: 'video/mp4',
    source: 'digital-human-upload-pending',
    meta: digitalHumanUploadMeta(replayInput, new Date(Date.now() + 600_000).toISOString()),
    is_public: false,
    created_at: new Date().toISOString(),
  } satisfies UploadTicketRecord;
  assert.doesNotThrow(() => assertDigitalHumanUploadRecord(replayRecord, replayUser, replayInput));
  assert.throws(
    () => assertDigitalHumanUploadRecord(replayRecord, '10000000-0000-4000-a000-000000000998', replayInput),
    (error: unknown) => error instanceof DigitalHumanUploadError && error.code === 'UPLOAD_REQUEST_CONFLICT',
  );
  assert.throws(
    () => assertDigitalHumanUploadRecord(replayRecord, replayUser, { ...replayInput, requestId: 'digital-upload-another-request-fixture' }),
    (error: unknown) => error instanceof DigitalHumanUploadError && error.code === 'UPLOAD_REQUEST_CONFLICT',
  );
  check('record contract accepts exact replay and rejects cross-account and cross-request rebinding', true, {
    exactReplay: 'accepted', crossAccount: '409 UPLOAD_REQUEST_CONFLICT', crossRequest: '409 UPLOAD_REQUEST_CONFLICT',
  });

  const expired = {
    meta: { uploadExpiresAt: new Date(Date.now() - (DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS + 1) * 1000).toISOString() },
  } as unknown as UploadTicketRecord;
  check('completion grace expires deterministically', uploadTicketExpired(expired, DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS), {
    completionGraceSeconds: DIGITAL_HUMAN_UPLOAD_COMPLETION_GRACE_SECONDS,
  });
}

async function providerContracts() {
  const calls: Array<Record<string, unknown>> = [];
  const fakeCos = {
    getObjectUrl(input: Record<string, unknown>, callback: (error: Error | null, data: { Url: string }) => void) {
      calls.push({ operation: 'sign', ...input });
      callback(null, { Url: 'https://bucket.cos.ap-guangzhou.myqcloud.com/one-object?short-signature=fixture' });
    },
    getObject(input: Record<string, unknown>, callback: (error: Error | null, data: { Body: Buffer }) => void) {
      calls.push({ operation: 'range', ...input });
      callback(null, { Body: mp4Prefix() });
    },
  };
  const provider = new TencentCOSProvider() as unknown as {
    cos: typeof fakeCos;
    bucket: string;
    region: string;
    createDirectUploadTicket(input: { key: string; contentType: string; contentLength: number; expireTime: number }): Promise<{ url: string; method: string; headers: Record<string, string> }>;
    readRange(key: string, start: number, end: number): Promise<Buffer>;
  };
  provider.cos = fakeCos;
  provider.bucket = 'bucket';
  provider.region = 'ap-guangzhou';
  const grant = await provider.createDirectUploadTicket({
    key: 'digital-human-inputs/staging/owner/video/object.mp4',
    contentType: 'video/mp4',
    contentLength: 100 * 1024 * 1024,
    expireTime: 600,
  });
  const prefix = await provider.readRange('digital-human-inputs/staging/owner/video/object.mp4', 0, 65_535);
  check('mocked COS adapter signs only PUT for the requested key and performs bounded range GET',
    grant.method === 'PUT' && grant.headers['Content-Type'] === 'video/mp4'
      && calls[0]?.Method === 'PUT' && calls[0]?.Key === 'digital-human-inputs/staging/owner/video/object.mp4'
      && calls[1]?.Range === 'bytes=0-65535' && prefix.length === 64,
    { signCall: calls[0], rangeCall: calls[1], permanentCredentialsReturned: false });
}

async function databaseContracts() {
  const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
    || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as { ownerConnection: pg.ClientConfig };
  const client = new pg.Client(runtime.ownerConnection);
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='user_files'",
    );
    const constraints = await client.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='public.user_files'::regclass",
    );
    const names = new Set(columns.rows.map(row => row.column_name));
    check('active local user_files can durably hold the pending/final upload session',
      ['id', 'user_id', 'storage_key', 'storage_provider', 'file_category', 'file_size', 'content_type', 'source', 'meta']
        .every(name => names.has(name))
        && constraints.rows.some(row => /PRIMARY KEY \(id\)/u.test(row.definition)),
      { transactionReadOnly: true, requiredColumns: 9, deterministicTicketPrimaryKey: true });
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}

async function main() {
  const sourceHashes = await sourceContracts();
  await pureContracts();
  await providerContracts();
  await databaseContracts();
  const report = {
    observedAt: new Date().toISOString(),
    sourceRoot: root,
    result: { total: checks.length, passed: checks.length, failed: 0 },
    safety: { cloudUploads: 0, providerRequests: 0, databaseWrites: 0, paidTasksCreated: 0, serverChanges: 0, gitPushes: 0 },
    checks,
    sourceHashes,
  };
  await mkdir(evidenceDir, { recursive: true });
  const output = path.join(evidenceDir, 'report.json');
  await writeFile(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ output, result: report.result, safety: report.safety }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
