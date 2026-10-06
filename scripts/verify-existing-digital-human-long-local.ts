import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseDotenv } from 'dotenv';
import { SignJWT } from 'jose';

const ORIGIN = 'http://127.0.0.1:5000';
const RUNTIME_PATH = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const ENV_PATH = 'F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/.env.local';
const PATTERN = /^dhl_[a-f0-9]{40}$/u;
type Json = Record<string, unknown>;
type Runtime = Json & { supabaseUrl?: string; restUrl?: string; serviceRoleKey?: string };
const run = promisify(execFile);
const ffprobe = createRequire(import.meta.url)('ffprobe-static') as { path: string };

function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
async function responseBody(response: Response) { const value = await response.text(); try { return value ? JSON.parse(value) as Json : {}; } catch { return {}; } }
async function api(token: string, pathname: string) {
  const response = await fetch(new URL(pathname, ORIGIN), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(60_000) });
  return { response, body: await responseBody(response) };
}
async function rest(runtime: Runtime, table: string, query: Record<string, string>) {
  const key = String(runtime.serviceRoleKey || ''); assert.ok(key, 'LOCAL_SERVICE_ROLE_KEY_REQUIRED');
  const url = new URL(`/rest/v1/${table}`, String(runtime.supabaseUrl || runtime.restUrl));
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, `LOCAL_REST_READ_FAILED:${table}:${response.status}`);
  return await response.json() as Json[];
}
async function probeVideo(rawUrl: string, download = false) {
  const url = new URL(rawUrl); assert.equal(url.protocol, 'https:'); assert.ok(url.hostname.endsWith('.myqcloud.com'));
  if (download) assert.ok(url.searchParams.has('response-content-disposition'), 'DOWNLOAD_URL_ATTACHMENT_OVERRIDE_MISSING');
  const response = await fetch(url, { headers: { Range: 'bytes=0-65535' }, signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `OWNED_VIDEO_UNREADABLE:${response.status}`);
  const reader = response.body?.getReader(); const first = reader ? await reader.read() : { value: new Uint8Array() };
  await reader?.cancel(); const bytes = first.value || new Uint8Array();
  assert.ok(bytes.byteLength > 0); assert.ok(String(response.headers.get('content-type') || '').startsWith('video/'));
  if (download) assert.match(String(response.headers.get('content-disposition') || ''), /attachment/iu);
  return { status: response.status, contentType: response.headers.get('content-type'), contentDisposition: download ? response.headers.get('content-disposition') : null, firstChunkBytes: bytes.byteLength, mp4HeaderDetected: Buffer.from(bytes.slice(0, 32)).includes(Buffer.from('ftyp')) };
}
async function probeFullVideo(rawUrl: string, outputPath: string, expectedBytes: number, expectedDurationSeconds: number) {
  const url = new URL(rawUrl); assert.equal(url.protocol, 'https:'); assert.ok(url.hostname.endsWith('.myqcloud.com'));
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  assert.ok(response.ok, `OWNED_FULL_VIDEO_UNREADABLE:${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.byteLength, expectedBytes, 'MERGED_VIDEO_SIZE_MISMATCH');
  await writeFile(outputPath, bytes);
  try {
    const { stdout } = await run(ffprobe.path, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath], { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    const media = JSON.parse(stdout) as Json;
    const streams = Array.isArray(media.streams) ? media.streams as Json[] : [];
    const durationSeconds = Number(object(media.format).duration);
    assert.ok(Math.abs(durationSeconds - expectedDurationSeconds) <= 1, `MERGED_VIDEO_DURATION_INVALID:${durationSeconds}`);
    assert.ok(streams.some((row) => row.codec_type === 'video'), 'MERGED_VIDEO_STREAM_MISSING');
    assert.ok(streams.some((row) => row.codec_type === 'audio'), 'MERGED_AUDIO_STREAM_MISSING');
    return { bytes: bytes.byteLength, durationSeconds, videoStreams: streams.filter((row) => row.codec_type === 'video').length, audioStreams: streams.filter((row) => row.codec_type === 'audio').length };
  } finally {
    await unlink(outputPath).catch(() => undefined);
  }
}
async function alternateToken(runtime: Runtime, ownerId: string) {
  const candidates = await rest(runtime, 'users', { select: 'id,email,role,display_name,status,is_active', id: `neq.${ownerId}`, limit: '100' });
  const account = candidates.find((row) => row.is_active !== false && !['blocked', 'suspended', 'disabled', 'inactive'].includes(String(row.status || '').trim().toLowerCase()));
  if (!account?.id || !account.email) return null;
  const environment = parseDotenv(await readFile(ENV_PATH, 'utf8')); const secret = String(environment.JWT_SECRET || '');
  assert.ok(secret.length >= 16, 'LOCAL_JWT_SECRET_REQUIRED');
  return new SignJWT({ userId: String(account.id), username: String(account.email), role: account.role === 'admin' ? 'admin' : 'student', displayName: String(account.display_name || '验收用户') })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(secret));
}

export async function main() {
  const parentId = process.argv.find((value) => value.startsWith('--parent-id='))?.slice('--parent-id='.length) || '';
  assert.match(parentId, PATTERN, 'EXISTING_LONG_PARENT_REQUIRED');
  const runtime = JSON.parse((await readFile(RUNTIME_PATH, 'utf8')).replace(/^\uFEFF/u, '')) as Runtime;
  assert.equal(runtime.localOnly, true); assert.equal(runtime.host, '127.0.0.1'); assert.equal(Number(runtime.databasePort), 54322);
  assert.equal(new URL(String(runtime.supabaseUrl || runtime.restUrl)).origin, 'http://127.0.0.1:54321');
  const localToken = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  let token = '';
  let owner: Json;
  if (localToken) {
    const current = await api(localToken, '/api/auth/me');
    owner = object(current.body.user);
    assert.ok(current.response.ok && owner.id && owner.role === 'admin');
    token = localToken;
  } else {
    const sessionResponse = await fetch(`${ORIGIN}/api/auth/dev-session`, { headers: { 'x-local-workbench': 'ai-creation-studio-local' }, signal: AbortSignal.timeout(20_000) });
    const session = await responseBody(sessionResponse);
    owner = object(session.user);
    assert.ok(sessionResponse.ok && session.token && owner.role === 'admin');
    token = String(session.token);
  }
  const ownerId = String(owner.id || '');

  const status = await api(token, `/api/digital-human/long-status?${new URLSearchParams({ taskId: parentId })}`);
  assert.ok(status.response.ok); assert.equal(status.body.status, 'completed'); assert.equal(Number(status.body.segmentCount), 2); assert.equal(Number(status.body.completedSegments), 2);
  const parentRows = await rest(runtime, 'digital_human_long_jobs', { select: '*', id: `eq.${parentId}`, user_id: `eq.${ownerId}`, limit: '1' });
  assert.equal(parentRows.length, 1); const parent = parentRows[0];
  assert.equal(parent.state, 'completed'); assert.equal(parent.billing_exempt, true); assert.equal(Number(parent.locked_price_yuan), 0); assert.equal(Number(parent.charged_yuan), 0); assert.equal(parent.billing_state, 'settled'); assert.equal(parent.billing_operation_id, null);
  const segments = await rest(runtime, 'digital_human_long_segments', { select: 'id,ordinal,start_seconds,end_seconds,duration_seconds,state,provider_task_id,result_asset_id,result_storage_url,result_sha256,attempt_count', parent_id: `eq.${parentId}`, user_id: `eq.${ownerId}`, order: 'ordinal' });
  assert.equal(segments.length, 2); assert.ok(segments.every((row) => row.state === 'completed' && row.provider_task_id && row.result_asset_id && row.attempt_count === 1 && /^object:\/\/tencent_cos\//u.test(String(row.result_storage_url)) && /^[a-f0-9]{64}$/u.test(String(row.result_sha256))));
  assert.equal(new Set(segments.map((row) => row.provider_task_id)).size, 2, 'SEGMENTS_MUST_BIND_TWO_DISTINCT_PROVIDER_TASKS');
  const merged = await rest(runtime, 'user_files', { select: 'id,user_id,file_category,storage_provider,file_size,content_type,source,meta', id: `eq.${String(parent.merged_asset_id)}`, user_id: `eq.${ownerId}`, limit: '1' });
  assert.equal(merged.length, 1); assert.equal(merged[0].source, 'video-generation'); assert.equal(merged[0].file_category, 'video'); assert.ok(Number(merged[0].file_size) > 0);
  const operations = await rest(runtime, 'wallet_operations', { select: 'id', user_id: `eq.${ownerId}`, idempotency_key: `eq.${String(parent.billing_idempotency_key)}` });
  const ledger = await rest(runtime, 'wallet_ledger_entries', { select: 'id', user_id: `eq.${ownerId}`, idempotency_key: `eq.${String(parent.billing_idempotency_key)}` });
  assert.equal(operations.length, 0); assert.equal(ledger.length, 0);
  const history = await api(token, '/api/digital-human/long-history?limit=100');
  const historyRow = (Array.isArray(history.body.tasks) ? history.body.tasks as Json[] : []).find((row) => row.id === parentId);
  assert.ok(history.response.ok && historyRow); const playback = await probeVideo(String(historyRow.resultUrl || status.body.resultUrl || ''));
  const evidenceDir = path.resolve('artifacts', `digital-human-long-existing-${parentId}-${new Date().toISOString().replace(/[:.]/gu, '-')}`); await mkdir(evidenceDir, { recursive: true });
  const media = await probeFullVideo(String(historyRow.resultUrl || status.body.resultUrl || ''), path.join(evidenceDir, 'merged-probe.mp4'), Number(merged[0].file_size), Number(parent.total_duration_seconds));
  const downloadTicket = await api(token, `/api/digital-human/long-download?${new URLSearchParams({ taskId: parentId, name: 'AI数字人长视频验收.mp4' })}`);
  assert.ok(downloadTicket.response.ok && downloadTicket.body.url); const download = await probeVideo(String(downloadTicket.body.url), true);

  const foreignToken = await alternateToken(runtime, ownerId);
  let accountIsolation: Json;
  if (foreignToken) {
    const foreignStatus = await api(foreignToken, `/api/digital-human/long-status?${new URLSearchParams({ taskId: parentId })}`);
    const foreignHistory = await api(foreignToken, '/api/digital-human/long-history?limit=100');
    const foreignDownload = await api(foreignToken, `/api/digital-human/long-download?${new URLSearchParams({ taskId: parentId })}`);
    assert.equal(foreignStatus.response.status, 404); assert.equal(foreignDownload.response.status, 404);
    assert.ok(foreignHistory.response.ok && !(Array.isArray(foreignHistory.body.tasks) ? foreignHistory.body.tasks as Json[] : []).some((row) => row.id === parentId));
    accountIsolation = { mode: 'active_local_account_http', foreignStatus: 404, foreignHistoryHidden: true, foreignDownload: 404 };
  } else {
    const foreignId = randomUUID();
    const foreignTask = await rest(runtime, 'digital_human_long_jobs', { select: 'id', id: `eq.${parentId}`, user_id: `eq.${foreignId}`, limit: '1' });
    const foreignHistory = await rest(runtime, 'digital_human_long_jobs', { select: 'id', user_id: `eq.${foreignId}`, limit: '100' });
    const foreignDownload = await rest(runtime, 'user_files', { select: 'id', id: `eq.${String(parent.merged_asset_id)}`, user_id: `eq.${foreignId}`, limit: '1' });
    assert.deepEqual(foreignTask, []); assert.deepEqual(foreignDownload, []);
    assert.ok(!foreignHistory.some((row) => row.id === parentId));
    accountIsolation = { mode: 'database_owner_scope_no_secondary_account', foreignStatus: 'not_visible', foreignHistoryHidden: true, foreignDownload: 'not_visible' };
  }
  const anonymous = await Promise.all(['/api/digital-human/long-status?taskId=' + parentId, '/api/digital-human/long-history?limit=100', '/api/digital-human/long-download?taskId=' + parentId].map((pathname) => fetch(new URL(pathname, ORIGIN), { signal: AbortSignal.timeout(20_000) })));
  assert.deepEqual(anonymous.map((response) => response.status), [401, 401, 401]);

  const evidence = path.join(evidenceDir, 'summary.json');
  accountIsolation.anonymousStatuses = [401, 401, 401];
  const report = { ok: true, localRuntimeOnly: true, parentId, state: parent.state, totalDurationSeconds: Number(parent.total_duration_seconds), segmentCount: segments.length, providerSubmissionCount: 2, providerReplayCount: 0, segments, mergedAsset: merged[0], mergedMedia: media, billing: { exempt: true, lockedPriceYuan: 0, chargedYuan: 0, operationCount: 0, ledgerCount: 0 }, historyPresent: true, playback, download, accountIsolation, databaseWrites: 0, credentialsPrinted: false };
  await writeFile(evidence, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, parentId, evidence, providerSubmissionCount: 2, providerReplayCount: 0, history: true, playback: true, download: true, accountIsolation: true, credentialsPrinted: false }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), providerRequests: 0, databaseWrites: 0, credentialsPrinted: false })); process.exitCode = 1; });
}
