import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { manjuConfigSemanticHash as hash } from './lib/manju-config-semantic-hash.mjs';

const before = { version: '1', policy: 'private', runtime_prompts: { manga_virtual_agent_prompt: { version: 'v1', content: 'fixture baseline' } } };
const persisted = { policy: 'private', runtime_prompts: { manga_virtual_agent_prompt: { content: 'fixture baseline', version: 'v1' } }, version: '1' };
const raw = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
assert.notEqual(raw(before), raw(persisted));
assert.equal(hash(before), hash(persisted));
assert.notEqual(hash(before), hash({ ...persisted, runtime_prompts: { ...persisted.runtime_prompts, own_test: { content: 'not removed' } } }));
assert.notEqual(hash(before), hash({ ...persisted, version: '2' }));
assert.notEqual(hash([before, 'second']), hash(['second', persisted]));
assert.notEqual(hash({ value: 0 }), hash({ value: null }));
assert.notEqual(hash({ value: false }), hash({ value: '' }));
assert.equal(hash({ z: [{ b: 2, a: 1 }], A: 1 }), hash({ A: 1, z: [{ a: 1, b: 2 }] }));
console.log(JSON.stringify({ passed: 8, failed: 0, databaseWrites: 0, generationRequests: 0, originalOrderSensitiveFailureReproduced: true, meaningfulValueDifferencesPreserved: true }));
