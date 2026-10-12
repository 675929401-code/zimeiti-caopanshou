#!/usr/bin/env node
import assert from 'node:assert/strict';
import { collectEngineeringEnvironment, evaluateEngineeringEnvironment, observePnpmVersion } from './inspect-engineering-environment.mjs';

const baseline = collectEngineeringEnvironment(process.cwd());
assert.equal(evaluateEngineeringEnvironment(baseline).ok, true, 'Current environment contracts must agree');
const cases = [
  ['web engine drift', b => { b.packages.web.manifest.engines.node = '24.x'; }],
  ['voice engine drift', b => { b.packages.voice.manifest.engines.node = '22.0.0'; }],
  ['pnpm drift', b => { b.packages.voice.manifest.engines.pnpm = '10.0.0'; }],
  ['missing lock', b => { b.packages.web.lockPresent = false; }],
  ['mutable install', b => { b.policy.release.productionBuild.requireFrozenLockfile = false; }],
  ['dirty release', b => { b.policy.release.productionBuild.requireCleanGit = false; }],
  ['server build enabled', b => { b.policy.release.serverBuildAllowed = true; }],
  ['server checkout enabled', b => { b.policy.release.serverGitCheckoutAllowed = true; }],
  ['old builder enabled', b => { b.policy.release.isolatedSameHostBuilder.allowed = true; }],
  ['duplicate service port', b => { b.policy.services.voice.port = b.policy.services.web.port; }],
  ['empty mounts', b => { b.policy.runtime.requiredServerMounts = []; }],
  ['missing build script', b => { delete b.packages.web.manifest.scripts[b.descriptor.environments.local.buildScript]; }],
  ['profile drift', b => { b.profile.contracts.environment = 'old.json'; }],
  ['untrusted action tag', b => { b.workflows[b.descriptor.environments.ci.workflow] += '\n  - uses: actions/checkout@v4\n'; }],
  ['unreviewed action branch', b => { b.workflows[b.descriptor.environments.ci.workflow] = b.workflows[b.descriptor.environments.ci.workflow].replace(/actions\/checkout@[0-9a-f]{40}/u, 'actions/checkout@unreviewed-branch'); }],
  ['local action traversal', b => { b.workflows[b.descriptor.environments.ci.workflow] += '\n  - uses: ./.github/actions/../escape\n'; }],
  ['mutable docker action', b => { b.workflows[b.descriptor.environments.ci.workflow] += '\n  - uses: docker://alpine:latest\n'; }],
  ['short action SHA', b => { b.workflows[b.descriptor.environments.ci.workflow] += '\n  - uses: actions/checkout@abcdef\n'; }],
  ['flow mapping action branch', b => { b.workflows[b.descriptor.environments.ci.workflow] = b.workflows[b.descriptor.environments.ci.workflow].replace(/- uses: actions\/checkout@[0-9a-f]{40}/u, '- {uses: actions/checkout@unreviewed-branch}'); }],
  ['quoted action key', b => { b.workflows[b.descriptor.environments.ci.workflow] += '\n  - "uses": actions/checkout@unreviewed-branch\n'; }],
  ['multiline action value', b => { b.workflows[b.descriptor.environments.ci.workflow] += '\n  - uses: >-\n      actions/checkout@unreviewed-branch\n'; }],
  ['aliased action step', b => { b.workflows[b.descriptor.environments.ci.workflow] += '\n  - *unreviewed\n'; }],
  ['escaped quoted flow key', b => { b.workflows[b.descriptor.environments.ci.workflow] += '\n  - {"u\\u0073es": actions/checkout@unreviewed-branch}\n'; }],
];
for (const [name, mutate] of cases) {
  const fixture = structuredClone(baseline);
  mutate(fixture);
  assert.equal(evaluateEngineeringEnvironment(fixture).ok, false, `${name} must fail`);
}
assert.equal(evaluateEngineeringEnvironment(baseline, { nodeVersion: '24.21.0' }).ok, false);
const runtime = { nodeVersion: baseline.policy.release.productionBuild.nodeVersion, pnpmVersion: baseline.policy.release.productionBuild.pnpmVersion };
assert.equal(evaluateEngineeringEnvironment(baseline, runtime).ok, true);
assert.equal(evaluateEngineeringEnvironment(baseline, { ...runtime, pnpmVersion: '10.99.0' }).ok, false);
assert.equal(evaluateEngineeringEnvironment(baseline, { ...runtime, pnpmVersion: null }).errors.includes('RUNTIME_PNPM_VERSION_UNKNOWN'), true);
for (const result of [{ status: 1, stdout: '9.0.0' }, { status: null, error: { code: 'ETIMEDOUT' } }, { status: 0, stdout: 'unknown' }]) assert.equal(observePnpmVersion(() => result), null);
assert.equal(observePnpmVersion(() => { throw new Error('unavailable'); }), null);
assert.equal(observePnpmVersion((command, args, options) => {
  assert.equal(command, process.platform === 'win32' ? 'pnpm --version' : 'pnpm'); assert.deepEqual(args, process.platform === 'win32' ? [] : ['--version']); assert.equal(options.timeout, 10_000);
  return { status: 0, stdout: '9.0.0\n' };
}), '9.0.0');
for (const reference of ['./.github/actions/reviewed', `docker://alpine@sha256:${'a'.repeat(64)}`]) {
  const fixture = structuredClone(baseline);
  fixture.workflows[fixture.descriptor.environments.ci.workflow] += `\n  - uses: ${reference}\n`;
  assert.equal(evaluateEngineeringEnvironment(fixture).ok, true);
}
assert.equal(evaluateEngineeringEnvironment(baseline).environments.server.verdict, 'UNKNOWN-not-inspected');
console.log(JSON.stringify({ ok: true, positiveCases: 6, negativeCases: cases.length + 7, network: false, database: false }));
