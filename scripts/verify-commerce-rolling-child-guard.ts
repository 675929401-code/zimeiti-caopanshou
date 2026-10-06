import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const fixture = path.resolve('.codex-evidence', `commerce-rolling-child-guard-${Date.now()}`);
  process.env.COMMERCE_DATA_DIR = fixture;
  process.env.SHARED_CONFIGURATION_ENABLED = '0';
  await fs.mkdir(fixture, { recursive: true });

  const { createJob } = await import('../src/commerce/server/jobs');
  const base = {
    requestId: '11111111-1111-4111-8111-111111111111',
    kind: 'video' as const,
    modelId: 'guard-fixture',
    prompt: 'guard fixture',
    duration: 4,
    aspectRatio: '9:16',
    resolution: '720p',
  };

  await assert.rejects(
    () => createJob('guard-owner', { ...base, rollingChild: true }),
    /滚动子任务只能由已确认的父任务创建/,
  );
  await assert.rejects(
    () => createJob('guard-owner', { ...base, rollingChild: true }, undefined, {}),
    /滚动子任务只能由已确认的父任务创建/,
  );
  await assert.rejects(
    () => createJob('guard-owner', { ...base, rollingChild: true, rollingParentJobId: 'parent', rollingSegmentIndex: 0 }, undefined, { rollingParentId: 'parent' }),
    /滚动子任务只能由已确认的父任务创建/,
  );
  await assert.rejects(
    () => createJob('guard-owner', { ...base, rollingParentJobId: 'parent', rollingSegmentIndex: 0 }),
    /滚动任务内部字段无效/,
  );

  console.log(JSON.stringify({
    passed: 4,
    networkCalls: 0,
    paidCalls: 0,
    checks: ['missing-context', 'empty-context', 'missing-segment-index', 'internal-fields-on-parent'],
    fixture,
  }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
