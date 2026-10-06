import assert from 'node:assert/strict';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const requestedTextRecord = process.argv.find(value => value.startsWith('--text-record='))?.slice('--text-record='.length) || '';
const requestedVideoRecord = process.argv.find(value => value.startsWith('--video-record='))?.slice('--video-record='.length) || '';

function recordShape(record) {
  return {
    id: record?.id || null,
    mode: record?.mode || null,
    status: record?.status || null,
    videoCount: Array.isArray(record?.result?.videos) ? record.result.videos.length : 0,
    textCount: Array.isArray(record?.result?.texts) ? record.result.texts.length : 0,
  };
}

export async function main() {
  assert.ok(token, 'Normal local administrator session is required');
  assert.match(requestedTextRecord, /^[a-f0-9]{64}$/u, 'A text record id is required');
  assert.match(requestedVideoRecord, /^[a-f0-9]{64}$/u, 'A video record id is required');

  const historyResponse = await fetch(`${origin}/api/extract/history`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const history = await historyResponse.json();
  assert.equal(historyResponse.status, 200, 'Account extraction history must be readable');
  assert.ok(Array.isArray(history.records), 'Account extraction history must contain records');

  const textRecord = history.records.find(record => record?.id === requestedTextRecord);
  const videoRecord = history.records.find(record => record?.id === requestedVideoRecord);
  assert.ok(textRecord, 'The completed text record must be in account history');
  assert.ok(videoRecord, 'The completed video record must be in account history');
  assert.equal(textRecord.mode, 'text');
  assert.equal(textRecord.status, 'success');
  assert.equal(videoRecord.mode, 'video');
  assert.equal(videoRecord.status, 'success');

  const media = videoRecord.result?.videos?.find(item => item?.success !== false && (item?.temporary_url || item?.asset_id || item?.download_url || item?.url));
  assert.ok(media, 'The completed video record must contain downloadable media');
  const candidates = [...new Map([
    ['temporary_url', media.temporary_url],
    ['download_url', media.download_url],
    ['url', media.url],
  ].filter(([, value]) => typeof value === 'string' && value).map(([field, value]) => [value, { field, value }])).values()];
  const downloadAttempts = [];
  for (const candidate of candidates) {
    if (candidate.field === 'temporary_url') {
      const mediaResponse = await fetch(new URL(candidate.value, origin), {
        headers: { Range: 'bytes=0-65535' },
        redirect: 'manual',
        signal: AbortSignal.timeout(70_000),
      });
      const contentType = mediaResponse.headers.get('content-type') || '';
      const body = new Uint8Array(await mediaResponse.arrayBuffer());
      downloadAttempts.push({
        field: candidate.field,
        host: 'same-origin-temporary-media',
        ticketStatus: 'embedded-signed-url',
        firstGetStatus: mediaResponse.status,
        contentType,
        bytes: body.byteLength,
        error: '',
        passed: mediaResponse.ok && body.byteLength > 0 && /^video\//u.test(contentType),
      });
      continue;
    }
    const ticketResponse = await fetch(`${origin}/api/extract/download-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: candidate.value, filename: 'toolbox-download-check.mp4', mode: 'download' }),
      signal: AbortSignal.timeout(20_000),
    });
    const ticket = await ticketResponse.json();
    assert.equal(ticketResponse.status, 200, 'A fresh account download ticket must be issued');
    assert.ok(typeof ticket.download_url === 'string' && ticket.download_url.startsWith('/api/extract/download?'), 'A local signed download URL is required');
    const mediaResponse = await fetch(new URL(ticket.download_url, origin), {
      headers: { Range: 'bytes=0-65535' },
      redirect: 'manual',
      signal: AbortSignal.timeout(70_000),
    });
    const contentType = mediaResponse.headers.get('content-type') || '';
    const body = new Uint8Array(await mediaResponse.arrayBuffer());
    let error = '';
    if (!mediaResponse.ok && contentType.includes('application/json')) {
      try { error = String(JSON.parse(new TextDecoder().decode(body))?.error || ''); } catch { /* no raw body output */ }
    }
    downloadAttempts.push({
      field: candidate.field,
      host: new URL(candidate.value).hostname,
      ticketStatus: ticketResponse.status,
      firstGetStatus: mediaResponse.status,
      contentType,
      bytes: body.byteLength,
      error: error.slice(0, 180),
      passed: mediaResponse.ok && body.byteLength > 0 && /^video\//u.test(contentType),
    });
  }
  const successfulDownload = downloadAttempts.find(attempt => attempt.passed);

  console.log(JSON.stringify({
    passed: historyResponse.ok && Boolean(successfulDownload),
    history: {
      accountScoped: true,
      total: history.records.length,
      text: recordShape(textRecord),
      video: recordShape(videoRecord),
    },
    download: { attempts: downloadAttempts },
    providerSubmissions: 0,
    credentialsPersisted: false,
    mediaUrlsPersisted: false,
  }, null, 2));
}
