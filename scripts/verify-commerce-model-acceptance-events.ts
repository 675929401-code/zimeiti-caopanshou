import assert from 'node:assert/strict';
import { currentPassedAcceptanceRows } from '../src/commerce/server/model-acceptance';

const hash = (character: string) => character.repeat(64);
const key = { model_kind: 'video' as const, model_id: 'video-model', model_config_hash: hash('a') };
const oldPass = { ...key, status: 'passed' as const, canary_job_id: 'job-1' };
const invalidated = { ...key, status: 'invalidated' as const, canary_job_id: 'job-1' };
const newPass = { ...key, status: 'passed' as const, canary_job_id: 'job-2' };
const otherPass = { model_kind: 'image' as const, model_id: 'image-model', model_config_hash: hash('b'), status: 'passed' as const, canary_job_id: 'job-3' };

assert.deepEqual(currentPassedAcceptanceRows([oldPass]), [oldPass]);
assert.deepEqual(currentPassedAcceptanceRows([invalidated, oldPass]), []);
assert.deepEqual(currentPassedAcceptanceRows([newPass, invalidated, oldPass, otherPass]), [newPass, otherPass]);
assert.deepEqual(currentPassedAcceptanceRows([invalidated, oldPass, otherPass]), [otherPass]);

console.log(JSON.stringify({ suite: 'commerce-model-acceptance-events', assertions: 4, passed: true, paidCalls: 0 }));
