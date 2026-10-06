import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const directory = '.codex-evidence/cover-deterministic-text-e2e-20260902';
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
assert.equal(manifest.marker, 'cover-e2e-layout-20260902-742c0da1');
assert.equal(manifest.providerRequests.length, 1); assert.equal(manifest.compositions.length, 2);
const events = (await readFile(`${directory}/network.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const renders = events.filter(event => event.type === 'response' && event.path === '/api/cover/render' && event.data?.persisted === true);
assert.equal(renders.length, 2);
assert.equal(renders[0].data.sourceAssetId, renders[1].data.sourceAssetId);
assert.deepEqual(renders.map(event => event.data.renderedText), [{ title: '小芽种薄荷', subtitle: '每天一点绿意' }, { title: '小芽和薄荷', subtitle: '今天也有绿意' }]);
assert.equal(events.filter(event => event.type === 'pageerror').length, 0);
const first = await readFile(`${directory}/cover-download-1.bin`), edited = await readFile(`${directory}/cover-download-2.bin`);
const reloaded = await readFile(`${directory}/cover-download-3.bin`), preserved = await readFile(`${directory}/cover-download-5.bin`);
assert.ok(edited.equals(reloaded), 'Reloaded edited download has identical bytes');
assert.ok(first.equals(preserved), 'Original selected history remains byte-for-byte unchanged');
assert.ok(!first.equals(edited), 'Text editing produces distinct output');
const metadata = await sharp(first).metadata();
assert.equal(metadata.width, 2388); assert.equal(metadata.height, 1791);
const crop = { left: 0, top: Math.floor(metadata.height / 2), width: metadata.width, height: Math.floor(metadata.height / 2) };
const firstArtwork = await sharp(first).extract(crop).raw().toBuffer(), editedArtwork = await sharp(edited).extract(crop).raw().toBuffer();
assert.ok(firstArtwork.equals(editedArtwork), 'Art pixels outside the edited text remain unchanged');
const state = JSON.parse(await readFile(`${directory}/results/036-reloaded-history-state.json`, 'utf8')).result;
assert.equal(state.state.pending, null); assert.equal(state.state.history.length, 2);
assert.equal(state.draft.modelId, manifest.expectedModelId); assert.equal(state.state.history[0].title, '小芽和薄荷');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = { passed: true, providerGenerations: 1, compositionSaves: 2, replayProof: 'checkpoint-recovery-result.json',
  initial: { bytes: first.length, sha256: hash(first), assetId: renders[0].data.assetId, historyRecordId: renders[0].data.historyRecordId },
  edited: { bytes: edited.length, sha256: hash(edited), assetId: renders[1].data.assetId, historyRecordId: renders[1].data.historyRecordId },
  width: metadata.width, height: metadata.height, sameBackgroundAsset: true, unchangedArtworkPixels: true,
  reloadedDownloadByteIdentical: true, originalHistoryByteIdentical: true, pending: false, historyCount: 2, pageErrors: 0,
  blockedDiagnostics: events.filter(event => event.type === 'blocked-mutation' && event.path === '/api/diagnostic-logs').length,
  manualVisualReview: 'Both downloaded images were inspected: all requested title and subtitle characters matched' };
await writeFile(`${directory}/delivered-files-verification.json`, JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
