import assert from 'node:assert/strict';
import { readSuanlichengMaterial, type SuanlichengMaterialDependencies } from '../src/lib/video-suanlicheng-material';
const ownUrl = 'https://owned-123.cos.ap-beijing.myqcloud.com/input.jpg?signature=private';
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
let ownedReads = 0, externalReads = 0;
const deps: SuanlichengMaterialDependencies = {
  async readOwned(url, userId, kind, limit) {
    ownedReads++;
    assert.equal(url, ownUrl);
    assert.equal(kind, 'image');
    assert.equal(limit, 16 * 1024 * 1024);
    if (userId !== 'owner-a') throw new Error('OWNERSHIP_DENIED');
    return { buffer: bytes, contentType: 'image/jpeg' };
  },
  async readExternal(url, kind, limit) {
    externalReads++;
    assert.equal(kind, 'audio'); assert.equal(limit, 20 * 1024 * 1024);
    return { buffer: bytes, contentType: 'audio/wav' };
  },
};
async function main() {
  assert.deepEqual((await readSuanlichengMaterial(ownUrl, 'image', 'owner-a', deps)).buffer, bytes);
  assert.equal(externalReads, 0);
  await assert.rejects(readSuanlichengMaterial(ownUrl, 'image', 'owner-b', deps), /OWNERSHIP_DENIED/);
  const before = ownedReads;
  await assert.rejects(readSuanlichengMaterial(ownUrl, 'image', undefined, deps), /账号归属/);
  assert.equal(ownedReads, before);
  assert.equal(externalReads, 0, 'Ownership failures must never fall back to URL download');
  await assert.rejects(readSuanlichengMaterial(ownUrl, 'image', 'owner-a', { ...deps, readOwned: async () => { throw Error('STORAGE_TIMEOUT'); } }), /STORAGE_TIMEOUT/);
  assert.equal(externalReads, 0);
  await assert.rejects(readSuanlichengMaterial(ownUrl, 'image', 'owner-a', { ...deps, readOwned: async () => ({ buffer: Buffer.alloc(16 * 1024 * 1024 + 1), contentType: 'image/jpeg' }) }), /大小限制/);
  await assert.rejects(readSuanlichengMaterial(ownUrl, 'image', 'owner-a', { ...deps, readOwned: async () => ({ buffer: bytes, contentType: 'text/html' }) }), /格式不支持/);
  await assert.rejects(readSuanlichengMaterial(ownUrl, 'image', 'owner-a', { ...deps, readOwned: async () => ({ buffer: Buffer.alloc(0), contentType: 'image/jpeg' }) }), /为空/);
  await readSuanlichengMaterial('https://media.example/audio.wav', 'audio', undefined, deps);
  assert.equal(externalReads, 1);
  console.log('PASS owned material: valid owner, cross-account denial, missing owner, no unsafe fallback, bounded bytes, type, empty content, external safe path.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
