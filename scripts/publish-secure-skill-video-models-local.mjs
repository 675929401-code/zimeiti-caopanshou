import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'http://127.0.0.1:5000';
const CONFIRMATION = 'PUBLISH_VALIDATED_VIDEO_MODEL';
const ROOT = path.resolve('.codex-evidence/hidden-video-real-e2e-20260902');
const SOURCES = new Map([
  ['secure-skill-flow-omni-ch14', 'relay_20260905_v1'],
  ['secure-skill-flow-veo-3-1-i2v-fast-ch14', 'relay_20260905_v1'],
  ['secure-skill-flow-veo-3-1-i2v-lite-ch14', 'relay_20260905_v1'],
  ['secure-skill-flow-veo-3-1-interpolation-lite-ch14', 'relay_20260905_v1'],
  ['secure-skill-flow-veo-3-1-t2v-fast-ch14', 'relay_20260905_v1'],
  ['secure-skill-flow-veo-3-1-t2v-lite-ch14', 'relay_20260905_v1'],
  ['secure-skill-wan3-video-ch40', 'relay_20260905_v1'],
  ['secure-skill-wan3-video-prime-ch40', 'relay_20260905_v1'],
  ['secure-skill-minimax-h3-ecommerce-ch36', 'h3_parameter_repair_20260905'],
]);
// A storyboard card submits one keyframe and an optional prompt. Multi-frame,
// text-only and flexible multi-input workflows stay on the full video page.
const STORYBOARD_EXPECTED = new Set([
  'secure-skill-flow-omni-ch14',
  'secure-skill-flow-veo-3-1-i2v-fast-ch14',
  'secure-skill-flow-veo-3-1-i2v-lite-ch14',
]);
const sha = value => createHash('sha256').update(String(value)).digest('hex');
const clean = value => String(value || '').replace(/https?:\/\/\S+/gu, '[url]').replace(/\b(?:Bearer|sk-)\S+/giu, '[redacted]').slice(0, 400);

function option(argv, key) {
  return argv.find(entry => entry.startsWith(`--${key}=`))?.slice(key.length + 3);
}

async function readProof(modelId, sourceRun) {
  const evidencePath = path.join(ROOT, sourceRun, modelId.replace(/[^A-Za-z0-9_-]/gu, '_'), 'result.json');
  assert.ok(`${path.resolve(evidencePath)}${path.sep}`.startsWith(`${ROOT}${path.sep}`), 'Evidence path escaped its reviewed root');
  const result = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
  assert.equal(result.modelId, modelId);
  assert.equal(result.posts, 1, 'Publication requires exactly one reviewed dispatch');
  assert.equal(result.state, 'completed');
  assert.equal(result.business?.status, 'completed');
  assert.equal(result.business?.hasOwnedStorage, true);
  assert.equal(result.routingVerified, true);
  assert.match(result.business?.id || '', /^vt_[A-Za-z0-9]{20,100}$/u);
  for (const key of ['configurationHash', 'healthEpoch']) assert.match(result.marker?.[key] || '', /^[a-f0-9]{64}$/u);
  assert.match(result.marker?.clientRequestId || '', /^vav_[a-f0-9]{64}$/u);
  return {
    modelId,
    sourceRun,
    publicId: result.marker.publicModelId,
    taskId: result.business.id,
    proof: {
      validationKey: result.marker.clientRequestId,
      configurationHash: result.marker.configurationHash,
      healthEpoch: result.marker.healthEpoch,
      clientRequestId: result.marker.clientRequestId,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv.includes('--execute') ? 'execute' : argv.includes('--inspect') ? 'inspect' : 'plan';
  if (mode === 'plan') {
    console.log(JSON.stringify({ mode, writes: 0, providerRequests: 0, command: '--inspect|--execute --run-id=<safe-id>', confirmation: '--confirm-publish-validated-models' }));
    return;
  }
  const runId = option(argv, 'run-id');
  assert.match(runId || '', /^[A-Za-z0-9_-]{6,100}$/u);
  if (mode === 'execute') assert.ok(argv.includes('--confirm-publish-validated-models'), 'Explicit publication confirmation is required');
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.ok(token, 'Normal local administrator session is required');
  const headers = { Authorization: `Bearer ${token}` };
  const api = async (route, init = {}) => {
    const response = await fetch(`${ORIGIN}${route}`, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  };
  const me = await api('/api/auth/me');
  assert.ok(me.ok && me.body?.user?.role === 'admin');
  const out = path.resolve('.codex-evidence/secure-skill-video-publication-20260905', runId);
  const planPath = path.join(out, 'plan.json');
  await fs.mkdir(out, { recursive: true });

  if (mode === 'inspect') {
    try { await fs.access(planPath); throw new Error('Frozen publication plan already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const models = [];
    for (const [modelId, sourceRun] of SOURCES) {
      const item = await readProof(modelId, sourceRun);
      const validation = await api(`/api/admin/video-models/validation?modelId=${encodeURIComponent(modelId)}`);
      assert.ok(validation.ok && validation.body?.success === true, `Current validation unavailable: ${modelId}`);
      assert.equal(validation.body.configurationHash, item.proof.configurationHash, `Configuration changed after successful canary: ${modelId}`);
      assert.equal(validation.body.readiness?.credentialReady, true);
      assert.equal(validation.body.readiness?.endpointConfigured, true);
      assert.equal(validation.body.model?.publicId, item.publicId);
      models.push({ ...item, displayName: clean(validation.body.model.displayName), currentActive: validation.body.model.active === true, currentHidden: validation.body.model.hidden === true });
    }
    const plan = { schema: 'secure-skill-video-publication.v1', at: new Date().toISOString(), origin: ORIGIN, userHash: sha(me.body.user.id), providerRequests: 0,
      requestedPublications: models.length, excludedFailedModel: 'secure-skill-flow-veo-3-1-r2v-fast-ch14', models };
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ phase: 'inspect', ready: models.length, excludedFailed: 1, evidence: planPath }));
    return;
  }

  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  assert.equal(plan.schema, 'secure-skill-video-publication.v1');
  assert.equal(plan.userHash, sha(me.body.user.id));
  const results = [];
  for (const frozen of plan.models) {
    const current = await readProof(frozen.modelId, frozen.sourceRun);
    assert.deepEqual(current.proof, frozen.proof, `Proof changed: ${frozen.modelId}`);
    assert.equal(current.taskId, frozen.taskId);
    const validation = await api(`/api/admin/video-models/validation?modelId=${encodeURIComponent(frozen.modelId)}`);
    assert.ok(validation.ok, `Current validation unavailable: ${frozen.modelId}`);
    const alreadyPublic = validation.body?.model?.active === true && validation.body?.model?.hidden === false;
    // Publication adds signed activation evidence to the protocol config. On
    // replay the server validates that evidence and the original proof.
    assert.ok(validation.body?.configurationHash === frozen.proof.configurationHash || alreadyPublic, `Current configuration changed before publication: ${frozen.modelId}`);
    const response = await api('/api/admin/video-models/validation/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: frozen.modelId, taskId: frozen.taskId, confirmation: CONFIRMATION, ...frozen.proof }),
    });
    const record = { modelId: frozen.modelId, http: response.status, success: response.body?.success === true, published: response.body?.published ?? null,
      active: response.body?.active === true, hidden: response.body?.hidden === true, alreadyPublished: response.body?.alreadyPublished === true,
      code: clean(response.body?.code), error: clean(response.body?.error) };
    results.push(record);
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    assert.ok(response.ok && record.success && record.active && !record.hidden, `Publication failed: ${frozen.modelId}:${record.code}`);
  }
  const videoCatalog = await api('/api/video/models?surface=video-page');
  const storyboardCatalog = await api('/api/video/models?surface=storyboard-workbench');
  assert.ok(videoCatalog.ok && Array.isArray(videoCatalog.body?.models));
  assert.ok(storyboardCatalog.ok && Array.isArray(storyboardCatalog.body?.models));
  for (const frozen of plan.models) {
    assert.equal(videoCatalog.body.models.filter(model => model.id === frozen.publicId).length, 1, `Published model missing from video-page: ${frozen.modelId}`);
    const storyboardMatches = storyboardCatalog.body.models.filter(model => model.id === frozen.publicId).length;
    assert.equal(storyboardMatches, STORYBOARD_EXPECTED.has(frozen.modelId) ? 1 : 0, `Storyboard input contract mismatch: ${frozen.modelId}`);
  }
  for (const catalog of [videoCatalog, storyboardCatalog]) {
    assert.equal(catalog.body.models.some(model => model.displayName?.includes('多参考 Fast') && model.displayName?.includes('Secure Skill Flow 14')), false, 'Failed channel leaked into a public catalog');
  }
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), published: results.length, failedChannelStillExcluded: true,
    videoPagePublished: results.length, storyboardEligiblePublished: STORYBOARD_EXPECTED.size,
    publicSurfacesVerified: ['video-page', 'storyboard-workbench'], providerRequests: 0, results }, null, 2));
  console.log(JSON.stringify({ phase: 'complete', published: results.length, storyboardEligiblePublished: STORYBOARD_EXPECTED.size, failedChannelStillExcluded: true, publicSurfacesVerified: 2 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ failed: true, error: clean(error.message), providerRequests: 0 })); process.exitCode = 1; });
}
