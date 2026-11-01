import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { buildSecureSkillImagePayload, validateSecureSkillGpt25SyncInput, SECURE_SKILL_GPT25_SYNC_CONTRACT, SECURE_SKILL_GPT25_SYNC_V2_CONTRACT, type SecureSkillImageRequestInput } from '../src/lib/secure-skill-image-adapter';
import { resolveImageProviderContract, imageReferenceContractIssue } from '../src/lib/image-provider-contract';
import { buildOpenAIEndpoint } from '../src/lib/api-endpoints';
import { parseImageUpstreamResponse } from '../src/lib/image-upstream-response';

const input: SecureSkillImageRequestInput = { modelName: 'gpt-image-2.5-flare', prompt: '原始中文提示词，保持主体身份。', resolution: '2K', aspectRatio: '16:9', providerContract: SECURE_SKILL_GPT25_SYNC_V2_CONTRACT };
const preflight = (patch: Partial<Parameters<typeof validateSecureSkillGpt25SyncInput>[0]> = {}) => validateSecureSkillGpt25SyncInput({ ...input, requestProtocol: 'images_generations', referenceTransport: 'generations_url_array', maxReferenceImages: 9, ...patch });
let passed = 0;
for (const modelName of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
  for (const resolution of ['1K', '2K', '4K'] as const) {
    for (const aspectRatio of ['16:9', '1:1']) {
      const payload = buildSecureSkillImagePayload({ ...input, modelName, resolution, aspectRatio });
      assert.deepEqual(payload, { model: modelName, prompt: input.prompt, n: 1, response_format: 'url', resolution, aspect_ratio: aspectRatio, quality: 'high' });
      assert.equal('size' in payload, false); assert.equal('image_size' in payload, false); assert.equal('image' in payload, false); passed++;
    }
  }
}
for (const quality of ['low', 'medium', 'high', 'xhigh', 'max']) {
  assert.equal(buildSecureSkillImagePayload({ ...input, quality }).quality, quality); passed++;
}
for (const count of [1, 2, 16]) {
  const references = Array.from({ length: count }, (_, index) => 'https://fixture.invalid/reference-' + index + '.png');
  assert.deepEqual(buildSecureSkillImagePayload({ ...input, referenceImageUrls: references }).image, references); passed++;
}
for (const patch of [
  { resolution: '3K' }, { aspectRatio: 'unknown' }, { modelName: 'gpt-image-2.5-high' }, { quality: 'auto' }, { quality: '' },
  { quality: null }, { providerContract: 'secure_skill_gpt_image_2_5_sync.v3' },
  { referenceImageUrls: ['data:image/png;base64,AA=='] }, { referenceImageUrls: ['ftp://fixture.invalid/reference.png'] },
  { referenceImageUrls: [Object.assign(new URL('https://fixture.invalid/reference.png'), { username: 'fixture-user', password: 'invalid-fixture-value' }).href] }, { referenceImageUrls: [''] },
  { referenceImageUrls: Array.from({ length: 17 }, () => 'https://fixture.invalid/reference.png') },
]) {
  assert.throws(() => buildSecureSkillImagePayload({ ...input, ...patch } as SecureSkillImageRequestInput), /IMAGE_PROVIDER_CONTRACT_|IMAGE_REFERENCE_/u); passed++;
}
for (const patch of [{ requestProtocol: 'images_edits' }, { referenceTransport: 'edits_multipart_array' },
  { protocolConfig: { protocol: 'chat_completions' } }, { protocolConfig: { quality: 123 } }, { protocolConfig: { quality: null } },
  { protocolConfig: { image_reference_transport: 'edits_multipart_single' } },
]) { assert.equal(preflight(patch)?.code, 'IMAGE_PROVIDER_CONTRACT_MISMATCH'); passed++; }
assert.equal(preflight({ referenceImageUrls: Array.from({ length: 10 }, () => 'https://fixture.invalid/reference.png') })?.code, 'IMAGE_REFERENCE_LIMIT_EXCEEDED'); passed++;
assert.equal(preflight(), null);
const legacy = { ...input, providerContract: SECURE_SKILL_GPT25_SYNC_CONTRACT, resolution: '1K' as const, aspectRatio: '1:1', pixelSize: '1024x1024', quality: 'high' };
assert.equal(buildSecureSkillImagePayload(legacy).size, '1024x1024');
assert.throws(() => buildSecureSkillImagePayload({ ...legacy, resolution: '2K' }), /IMAGE_PROVIDER_CONTRACT_MISMATCH/u);
assert.throws(() => buildSecureSkillImagePayload({ ...legacy, aspectRatio: '16:9' }), /IMAGE_PROVIDER_CONTRACT_MISMATCH/u);
assert.equal(buildSecureSkillImagePayload({ ...input, providerContract: undefined }).image_size, '2K', 'a model name alone must not opt in to v2'); passed++;

// Execute the actual route transport with only dispatch/response IO replaced by fixtures.
const route = readFileSync('src/app/api/image/generate/route.ts', 'utf8');
const tree = ts.createSourceFile('image-route.ts', route, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(['generateLocalImageCandidate', 'ImageCandidateFailure']);
const definitions = tree.statements.filter(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && names.has(node.name.text)).map(node => node.getText(tree));
assert.equal(definitions.length, names.size);
const executable = ts.transpileModule(definitions.join('\n') + '\ngenerateLocalImageCandidate;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
async function routeCase(references: string[], empty = false, patch: Partial<SecureSkillImageRequestInput> = {}) {
  let dispatches = 0; let sent: Record<string, unknown> | undefined;
  const generate = vm.runInNewContext(executable, {
    Error, URL, Response, createHash, resolveImageProviderContract, imageReferenceContractIssue, buildSecureSkillImagePayload, buildOpenAIEndpoint, parseImageUpstreamResponse,
    assertAutodlH3SelfhostModelBinding: () => false, resolveProviderSecret: () => 'fixture-secret',
    configuredImagePixelSizeFor: () => 'ignored-legacy-pixel-map', safeUpstreamTarget: (url: string) => url,
    fetchAuditedImageProviderPost: async (request: { url: string; init: { body: string }; providerProtocol: string }) => {
      dispatches++; assert.equal(request.url, 'https://provider.fixture.invalid/v1/images/generations'); assert.equal(request.providerProtocol, 'images_generations');
      sent = JSON.parse(request.init.body); return { response: Response.json({ data: empty ? [] : [{ url: 'https://media.fixture.invalid/result.png' }] }), dispatchReceipt: {} };
    },
    readAuditedImageProviderResponseText: async ({ response }: { response: Response }) => response.text(),
  }) as (options: Record<string, unknown>) => Promise<string>;
  const task = generate({ actorId: 'fixture-user', model: { id: 'fixture-gpt25', name: 'Explicit GPT25', model_name: patch.modelName || input.modelName,
    provider: 'openai_compat', api_endpoint: 'https://provider.fixture.invalid/v1', api_key: 'fixture-secret', supports_image_input: true,
    api_protocol_config: { protocol: 'images_generations', reference_transport: 'generations_url_array', provider_contract: patch.providerContract || SECURE_SKILL_GPT25_SYNC_V2_CONTRACT, ...(patch.quality !== undefined ? { quality: patch.quality } : {}) } },
    ratio: patch.aspectRatio || input.aspectRatio, effectiveResolution: patch.resolution || input.resolution, references, identityReferenceOnly: false,
    userPrompt: input.prompt, fullPrompt: input.prompt, idempotencyKey: 'fixture-idempotency', receiptContext: {}, strictSingleSubmit: true });
  if (empty) await assert.rejects(task, /模型未返回图片URL或数据/u);
  else if (patch.resolution === '3K' || patch.providerContract?.endsWith('.v3')) await assert.rejects(task, /IMAGE_PROVIDER_CONTRACT_/u);
  else assert.equal(await task, 'https://media.fixture.invalid/result.png');
  if (patch.resolution === '3K' || patch.providerContract?.endsWith('.v3')) assert.equal(dispatches, 0, 'invalid v2 never dispatches or falls back');
  else { assert.equal(dispatches, 1); assert.equal(sent!.resolution, patch.resolution || input.resolution); assert.equal(sent!.aspect_ratio, patch.aspectRatio || input.aspectRatio);
    assert.equal('size' in sent!, false); assert.equal('image_size' in sent!, false); if (references.length) assert.deepEqual(sent!.image, references); }
  passed++;
}
async function main() {
  await routeCase([]); await routeCase(['https://fixture.invalid/reference.png']);
  await routeCase(['https://fixture.invalid/a.png', 'https://fixture.invalid/b.png'], false, { resolution: '4K', quality: 'max' });
  await routeCase([], true); await routeCase([], false, { resolution: '3K' });
  await routeCase([], false, { providerContract: 'secure_skill_gpt_image_2_5_sync.v3' });
  console.log(JSON.stringify({ passed, failed: 0, actualNetworkRequests: 0, databaseWrites: 0, providerCalls: 0,
    route: 'actual generateLocalImageCandidate with fixture dispatch', contract: SECURE_SKILL_GPT25_SYNC_V2_CONTRACT, legacyPreserved: true }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
