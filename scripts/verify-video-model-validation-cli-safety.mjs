import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const repoRoot = process.cwd();
const runner = path.join(repoRoot, 'scripts', 'run-video-model-validation-publish.mjs');
const calls = [];
let responseMode = 'missing';

const server = http.createServer((request, response) => {
  calls.push({ method: request.method, url: request.url });
  response.setHeader('content-type', 'application/json');

  if (request.method === 'GET' && request.url?.startsWith('/api/admin/video-models/validation?')) {
    response.end(JSON.stringify({
      validationKey: 'validation-key',
      configurationHash: 'configuration-hash',
      healthEpoch: 'health-epoch',
      outputCapabilities: { defaultResolution: '720p' },
      ...(responseMode === 'completed'
        ? { existingTask: { businessTaskId: 'vt_existing_completed', status: 'completed' } }
        : {}),
    }));
    return;
  }

  if (request.method === 'GET' && request.url?.startsWith('/api/admin/video-models?')) {
    response.end(JSON.stringify({ models: [] }));
    return;
  }

  response.statusCode = 500;
  response.end(JSON.stringify({ error: 'unexpected mutation in read-only verification' }));
});

const listen = () => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(5002, '127.0.0.1', resolve);
});

const close = () => new Promise((resolve) => server.close(resolve));

const runReadOnly = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [runner, 'safety-test-model'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LOCAL_NAV_ORIGIN: 'http://127.0.0.1:5002',
      LOCAL_NAV_ADMIN_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', code => resolve({ code, stdout, stderr }));
});

try {
  await listen();

  calls.length = 0;
  responseMode = 'missing';
  const missing = await runReadOnly();
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(missing.stderr, /READ_ONLY_NO_COMPLETED_CANARY/u);
  assert.equal(calls.some(call => call.method !== 'GET'), false, JSON.stringify(calls));

  calls.length = 0;
  responseMode = 'completed';
  const completed = await runReadOnly();
  assert.equal(completed.code, 0, completed.stderr);
  assert.match(completed.stderr, /COMPLETED_CANARY_NOT_PUBLISHED_IN_READ_ONLY_MODE/u);
  assert.equal(calls.some(call => call.method !== 'GET'), false, JSON.stringify(calls));

  console.log('PASS: video validation CLI is read-only unless explicit submit/publish flags are supplied');
} finally {
  await close();
}
