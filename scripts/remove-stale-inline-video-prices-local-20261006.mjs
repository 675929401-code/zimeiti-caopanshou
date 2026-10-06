#!/usr/bin/env node

// 公共售价由独立价格字段按成本×1.20展示；模型名称不再固化供应商成本，避免调价后误导用户。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const TARGETS = [
  ['lconai-seedance-2-0-mini-480p', 'Seedance 2.0 Mini · 轻量 · 480P'],
  ['secure-skill-seedance-2-5-g42', 'Seedance 2.5 · 旗舰 · 720P · 4–30秒'],
  ['secure-skill-seedance-2-5-enterprise-g16', 'Seedance 2.5 企业 · 720P · 5–30秒 · 分组16'],
  ['secure-skill-video-2-0-fast-g16', 'Video 2.0 Fast · 720P · 5–15秒 · 企业渠道分组16'],
  ['secure-skill-video-2-0-pro-g16', 'Video 2.0 Pro · 720P · 5–15秒 · 企业渠道分组16'],
  ['secure-skill-wan3-video-ch40', 'Wan 3.0 Video · 2–30秒 · 480P/720P/1080P · 分组40'],
  ['secure-skill-wan3-video-prime-ch40', 'Wan 3.0 Prime · 2–30秒 · 480P/720P/1080P · 分组40'],
];
const output = path.resolve('.codex-evidence/model-chain-audit-20261006/video-inline-price-name-cleanup.json');

async function api(origin, headers, route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store', signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${route}:HTTP_${response.status}:${data.code || data.error || 'unknown'}`);
  return data;
}
async function publish(origin, headers, releaseId) {
  const validated = await api(origin, headers, '/api/admin/model-pool-releases', { action: 'validate', releaseId });
  assert.equal(validated.release?.status, 'validated', 'release validation failed');
  const preview = await api(origin, headers, `/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
  const previewSha256 = String(preview.preview?.previewSha256 || '');
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, 'preview fingerprint missing');
  const result = await api(origin, headers, '/api/admin/model-pool-releases', { action: 'publish', releaseId, previewSha256 });
  assert.equal(result.release?.status, 'published', 'release publication failed');
  return { id: releaseId, version: Number(result.release?.release_version || 0), previewSha256 };
}

const args = process.argv.slice(2);
assert.ok(args.includes('--execute') && args.includes('--confirm-remove-stale-inline-prices'), 'explicit confirmation required');
const origin = String(process.env.LOCAL_NAV_ORIGIN || '').replace(/\/+$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || '').trim();
assert.equal(origin, 'http://127.0.0.1:5000', 'exact local runtime required');
assert.ok(token && stepUp, 'admin step-up required');
const headers = { Authorization: `Bearer ${token}`, 'x-admin-step-up': stepUp };
const report = { checkedAt: new Date().toISOString(), pricingSource: 'dedicated model price fields', providerRequests: 0, paidGenerationRequests: 0, models: [] };

for (const [id, nextName] of TARGETS) {
  const inventory = await api(origin, headers, '/api/admin/models');
  const before = inventory.models?.find((model) => model.id === id);
  if (!before) {
    report.models.push({ id, status: 'not-configured', newName: nextName });
    continue;
  }
  const oldName = String(before.name || '');
  const gate = before.api_protocol_config?.__model_activation_gate?.state || null;
  let release = null;
  if (oldName !== nextName) {
    const staged = await api(origin, headers, '/api/admin/models', {
      model_type: 'video', id, name: nextName,
    }, 'PUT');
    assert.equal(staged.staged, true, `${id}: update was not staged`);
    const releaseId = String(staged.result?.release?.id || '');
    assert.match(releaseId, /^[a-f0-9-]{36}$/iu, `${id}: release missing`);
    release = await publish(origin, headers, releaseId);
  }
  const readback = await api(origin, headers, '/api/admin/models');
  const after = readback.models?.find((model) => model.id === id);
  assert.equal(after?.name, nextName, `${id}: name readback mismatch`);
  assert.equal(after?.api_protocol_config?.__model_activation_gate?.state || null, gate, `${id}: activation gate changed`);
  assert.doesNotMatch(nextName, /元\/(?:秒|次)|¥\s*\d/iu, `${id}: inline price remains`);
  report.models.push({ id, status: oldName === nextName ? 'already-clean' : 'updated', oldName, newName: nextName, publicPrice: Number(after.cost_per_use ?? after.price_per_use), costPrice: Number(after.cost_price), activationGate: gate, release });
}
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
