import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// These fixtures bind only to 127.0.0.1 on random ports. They exercise native
// fetch, real Undici dispatchers and the actual audited route functions.
const reports = [];
for (const name of ['transport', 'redirect', 'misdirected', 'receipt']) {
  const result = spawnSync(process.execPath, [path.resolve('scripts/fixtures/image-provider-http-local', `${name}.mjs`)],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.error?.message || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.externalProviderCalls, 0);
  assert.equal(report.liveDatabaseCalls, 0);
  reports.push({ name, ...report });
}
console.log(JSON.stringify({ passed: true, localHttpOnly: true, externalProviderCalls: 0, liveDatabaseCalls: 0, reports }, null, 2));
