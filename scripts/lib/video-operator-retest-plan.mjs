import assert from 'node:assert/strict';

export const AUTODL_PUBLIC_RESULT_HOST = 'codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com';
const sourceModels = new Set(['minimax-h3-autodl-hosted', 'minimax-h3-autodl-hosted-lightx2v-v5']);

export function selectOperatorRetest({ modelIds, reason, reviewedModels }) {
  assert.ok(Array.isArray(modelIds) && modelIds.length === 1, 'Operator retest requires exactly one explicit model');
  assert.ok(typeof reason === 'string' && reason.trim().length > 0 && reason.trim().length <= 500, 'Operator retest requires a reason of 1–500 characters');
  // Reasons are audit text, never a vehicle for source URLs or credentials.
  assert.doesNotMatch(reason, /https?:\/\/|\bBearer\s|\bsk-[A-Za-z0-9]|\beyJ[A-Za-z0-9_-]+\./iu, 'Retest reason must not contain URLs or credentials');
  const matches = reviewedModels.filter(model => model.internalId === modelIds[0]);
  assert.equal(matches.length, 1, 'Explicit model must belong to the reviewed catalog');
  return { reviewedModels: matches, reason: reason.trim() };
}

export function operatorRetestControls({ health, confirmation, reason, expectedKey }) {
  assert.ok(health?.productionBlocked === true && typeof health.operatorRetestKey === 'string' && health.operatorRetestKey.length > 0, 'Model has no current failed epoch eligible for operator retest');
  assert.ok(typeof confirmation === 'string' && confirmation.length > 0, 'Current server recovery confirmation is required');
  assert.ok(typeof reason === 'string' && reason.trim().length > 0 && reason.trim().length <= 500, 'Operator retest requires a reason of 1–500 characters');
  if (expectedKey !== undefined) assert.ok(health.operatorRetestKey === expectedKey, 'Health epoch changed after inspection; no task submitted');
  return { client_request_id: health.operatorRetestKey, health_recovery_canary: true,
    health_recovery_key: health.operatorRetestKey, health_recovery_confirmation: confirmation,
    health_operator_retest: true, health_operator_retest_reason: reason.trim() };
}

export function ownedPublicSource({ row, userId, taskId }) {
  assert.ok(row && row.id === taskId && row.user_id === userId, 'Source task ownership must match the normal authenticated user');
  assert.equal(row.status, 'completed', 'Public source task must already be completed');
  assert.ok(sourceModels.has(row.model_id), 'Public source must be a previously completed trusted AutoDL model');
  assert.ok(Number.isFinite(Number(row.duration_seconds)) && Number(row.duration_seconds) > 0 && Number(row.duration_seconds) <= 30, 'Source duration must be within the documented Omni Edit limit');
  let url;
  try { url = new URL(row.provider_result_url); } catch { throw new Error('Public source URL is invalid'); }
  assert.ok(url.protocol === 'https:' && url.hostname === AUTODL_PUBLIC_RESULT_HOST && !url.port && !url.username && !url.password && !url.search && !url.hash, 'Source must use the exact trusted HTTPS AutoDL host with no query or credentials');
  assert.ok(url.pathname.length > 1, 'Source must refer to a specific completed video');
  return url;
}

export async function probeOwnedPublicSource(url, fetcher) {
  const probes = [];
  for (const method of ['HEAD', 'GET']) {
    let response;
    try {
      response = await fetcher(url, { method, headers: method === 'GET' ? { Range: 'bytes=0-1023' } : {}, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    } catch { throw new Error(`Public source ${method} transport probe failed`); }
    try {
      assert.ok(response.status === (method === 'HEAD' ? 200 : 206) && /^video\//u.test(response.headers.get('content-type') || ''), `Public source ${method} is not readable as a video`);
      probes.push({ method, http: response.status, contentType: response.headers.get('content-type'), contentLength: response.headers.get('content-length'), contentRange: response.headers.get('content-range') });
      if (method === 'GET') {
        assert.ok(/^bytes 0-1023\/\d+$/u.test(response.headers.get('content-range') || ''), 'Public source must honor the bounded range request');
        const reader = response.body?.getReader();
        assert.ok(reader, 'Public source range body is missing');
        let bytes = 0;
        try { while (bytes < 1024) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; assert.ok(bytes <= 1024, 'Public source exceeded the requested range'); } }
        finally { await reader.cancel(); }
        assert.equal(bytes, 1024, 'Public source range body was incomplete');
        probes.at(-1).bytes = bytes;
      }
    } finally { if (!response.body?.locked) await response.body?.cancel(); }
  }
  return probes;
}
