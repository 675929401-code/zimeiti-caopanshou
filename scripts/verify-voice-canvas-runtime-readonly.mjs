import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { main, navigationReportDirectory } from './verify-local-navigation-experience.mjs';

const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin), 'Local origin required');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token, 'Normal administrator session required');
const runId = process.argv.find(value => value.startsWith('--run-id='))?.slice(9); assert.ok(runId, 'Fresh --run-id required');
const directory = navigationReportDirectory(runId); await fs.mkdir(directory, { recursive: true });
const reportPath = `${directory}/api-readback.json`;
const report = { at: new Date().toISOString(), origin, normalAdmin: false, requests: [], generationRequests: 0, databaseMutationRequests: 0, passed: false };
await fs.writeFile(reportPath, JSON.stringify(report), { flag: 'wx' });
try {
  const headers = { Authorization: `Bearer ${token}` };
  const identity = await fetch(`${origin}/api/auth/me`, { headers, signal: AbortSignal.timeout(30000) });
  const auth = await identity.json(); assert.ok(identity.ok && auth.user?.role === 'admin', 'Normal admin authorization failed'); report.normalAdmin = true;
  for (const pathname of ['/api/admin/voice-studio/models', '/api/canvas']) {
    const started = Date.now();
    try {
      const response = await fetch(origin + pathname, { headers, signal: AbortSignal.timeout(30000) }); const body = await response.json();
      const result = { path: pathname, status: response.status, elapsedMs: Date.now() - started, passed: false };
      if (pathname.endsWith('/models')) {
        result.count = Array.isArray(body.data) ? body.data.length : null;
        result.secretFieldsReturned = Array.isArray(body.data) && body.data.some(row => Object.keys(row).some(key => /api.?key|token|secret|password/iu.test(key)));
        result.passed = response.ok && body.success === true && Number.isInteger(result.count) && !result.secretFieldsReturned;
      } else {
        result.count = Array.isArray(body.canvases) ? body.canvases.length : null;
        result.defaultLimit = body.pagination?.limit ?? null;
        result.passed = response.ok && Number.isInteger(result.count) && result.defaultLimit === 50;
      }
      if (typeof body.code === 'string' && /^[A-Z0-9_]{1,90}$/u.test(body.code)) result.code = body.code;
      report.requests.push(result);
    } catch (error) { report.requests.push({ path: pathname, elapsedMs: Date.now() - started, errorName: ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name) ? error.name : 'ReadFailed', passed: false }); }
  }
  await main(['--scope=secondary', `--run-id=${runId}`, '--routes=/voice-studio,/voice-studio/admin,/voice-studio/nest,/youcai/voice-studio,/youcai/voice-studio/nest,/youcai/image-workbench,/youcai/tools/canvas/workspace/new']);
  report.passed = report.requests.every(item => item.passed) && !process.exitCode;
} catch { report.failure = 'LOCAL_READONLY_VERIFICATION_FAILED'; }
finally { report.finishedAt = new Date().toISOString(); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ reportPath, passed: report.passed, apiResults: report.requests, generationRequests: 0 })); }
if (!report.passed) process.exitCode = 1;
