#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the real entrypoints in an empty directory, with subprocess and
// mutation sentinels. A documentation marker alone cannot pass this test.
const root = process.cwd();
function validateDeploymentNavigation(template) {
  assert.ok(template && typeof template === 'object' && !Array.isArray(template));
  assert.equal(Object.hasOwn(template, 'nextOperatorSteps'), false, 'RETIRED_OPERATOR_STEPS_PRESENT');
  const authority = template.deploymentAuthority;
  assert.ok(authority && typeof authority === 'object' && !Array.isArray(authority), 'DEPLOYMENT_AUTHORITY_MISSING');
  assert.deepEqual(Object.keys(authority).sort(), ['role', 'workspaceRelativePath'], 'DEPLOYMENT_AUTHORITY_KEYS_INVALID');
  assert.equal(authority.workspaceRelativePath, '99_系统协议/02_操作协议/自媒体操盘手部署执行规约-当前版.md', 'DEPLOYMENT_AUTHORITY_PATH_INVALID');
  assert.equal(authority.role, 'navigation-only', 'DEPLOYMENT_AUTHORITY_ROLE_INVALID');
}
const template = JSON.parse(fs.readFileSync(path.join(root, 'deploy/environments/production-topology.template.json'), 'utf8'));
validateDeploymentNavigation(template);
const legitimateBackup = structuredClone(template);
legitimateBackup.git.backupRemote.recommendedProvider = 'Gitee private backup';
validateDeploymentNavigation(legitimateBackup); // Provider names are not executable deployment instructions.
const navigationNegatives = [
  ['old steps restored', value => { value.nextOperatorSteps = ['npm run deploy:remotes:apply']; }],
  ['command injected', value => { value.deploymentAuthority.command = 'npm run deploy:close-loop:push'; }],
  ['steps injected', value => { value.deploymentAuthority.nextSteps = ['deploy']; }],
  ['wrong path', value => { value.deploymentAuthority.workspaceRelativePath = 'docs/old-deployment.md'; }],
  ['wrong role', value => { value.deploymentAuthority.role = 'execute'; }],
  ['missing authority', value => { delete value.deploymentAuthority; }],
  ['missing path', value => { delete value.deploymentAuthority.workspaceRelativePath; }],
  ['missing role', value => { delete value.deploymentAuthority.role; }],
];
for (const [name, mutate] of navigationNegatives) {
  const value = structuredClone(template); mutate(value);
  assert.throws(() => validateDeploymentNavigation(value), { name: 'AssertionError' }, name);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-release-'));
const sentinel = `import fs from 'node:fs'; import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const stop=()=>{throw new Error('RETIRED_ENTRYPOINT_SIDE_EFFECT')};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[name]=stop;
for(const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync'])fs[name]=stop;
syncBuiltinESMExports();`;
const cases = [
  ['scripts/publish-local-release.mjs', ['unused-repository', 'unused-key'], 'LEGACY_LOCAL_PUBLISH_DISABLED'],
  ['scripts/configure-release-remotes.mjs', ['--apply'], 'LEGACY_REMOTE_REWRITE_DISABLED'],
  ['scripts/configure-release-remotes.mjs', ['--apply=true'], 'LEGACY_REMOTE_REWRITE_DISABLED'],
  ['scripts/release-close-loop.mjs', ['--push-git'], 'LEGACY_GIT_PUSH_DISABLED'],
  ['scripts/release-close-loop.mjs', ['--push-git=true'], 'LEGACY_GIT_PUSH_DISABLED'],
];
try {
  for (const [script, args, code] of cases) {
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(sentinel)}`, path.join(root, script), ...args], {
      cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.status, 2, `${script}: ${result.stderr}`);
    assert.ok(result.stderr.includes(code), `${script}: expected retirement result`);
    assert.ok(!result.stderr.includes('RETIRED_ENTRYPOINT_SIDE_EFFECT'));
  }
  assert.deepEqual(fs.readdirSync(temporary), []);
  console.log(JSON.stringify({ ok: true, guardedEntrypointCases: cases.length, deploymentNavigationPositiveCases: 2, deploymentNavigationNegativeCases: navigationNegatives.length, remoteWrites: 0 }));
} finally {
  fs.rmdirSync(temporary);
}
