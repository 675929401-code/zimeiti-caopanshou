#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const descriptorPath = 'deploy/policies/engineering-environment.v1.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const pointer = (value, key) => key.split('/').slice(1).reduce((node, part) => node?.[part], value);

export function isImmutableActionReference(reference) {
  return /^(?:[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_-]+)*@[0-9a-f]{40}|\.\/\.github\/actions\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*|docker:\/\/[A-Za-z0-9][A-Za-z0-9._/:~-]*@sha256:[0-9a-f]{64})$/u.test(reference);
}

export function observePnpmVersion(execute = spawnSync) {
  try {
    // Windows pnpm is a command shim; the shell receives only this fixed literal, never interpolated input.
    const result = execute(process.platform === 'win32' ? 'pnpm --version' : 'pnpm', process.platform === 'win32' ? [] : ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, windowsHide: true, shell: process.platform === 'win32' });
    const version = result.stdout?.trim();
    return result.status === 0 && !result.error && /^\d+\.\d+\.\d+$/u.test(version || '') ? version : null;
  } catch { return null; }
}

export function collectEngineeringEnvironment(root) {
  const read = relative => {
    const full = path.resolve(root, relative);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('ENVIRONMENT_REFERENCE_OUTSIDE_SOURCE');
    return fs.readFileSync(full, 'utf8');
  };
  const descriptor = JSON.parse(read(descriptorPath));
  const policy = JSON.parse(read(descriptor.releasePolicy));
  const profile = JSON.parse(read(descriptor.projectProfile));
  const files = {};
  const packages = Object.fromEntries(Object.entries(descriptor.packages).map(([name, entry]) => {
    const manifest = read(entry.manifest);
    const lock = read(entry.lockfile);
    files[entry.manifest] = hash(manifest);
    files[entry.lockfile] = hash(lock);
    return [name, { manifest: JSON.parse(manifest), lockSha256: hash(lock), lockPresent: lock.length > 0 }];
  }));
  const workflows = Object.fromEntries([descriptor.environments.ci.workflow, descriptor.environments.ci.acceptanceWorkflow].map(name => [name, read(name)]));
  const configurationNames = {};
  for (const name of descriptor.configurationNameSources) {
    if (!name.endsWith('.example')) throw new Error('ONLY_CONFIGURATION_EXAMPLES_MAY_BE_READ');
    // Deliberately retain names only. Never load runtime files or report values.
    configurationNames[name] = [...new Set([...read(name).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(match => match[1]))].sort();
  }
  for (const name of [descriptor.pm2Config, descriptor.artifactPacker, descriptor.serverVerifier]) files[name] = hash(read(name));
  return { descriptor, policy, profile, packages, workflows, files, configurationNames };
}

export function evaluateEngineeringEnvironment(bundle, runtime = {}) {
  const { descriptor, policy, profile, packages, workflows } = bundle;
  const errors = [];
  const check = (condition, code) => { if (!condition) errors.push(code); };
  check(descriptor.schemaVersion === 'engineering-environment.v1', 'ENVIRONMENT_SCHEMA');
  check(profile.contracts?.environment === descriptorPath, 'PROFILE_ENVIRONMENT_REFERENCE');
  check(profile.contracts?.release === descriptor.releasePolicy, 'PROFILE_RELEASE_REFERENCE');
  const toolchain = pointer(policy, descriptor.toolchainPointer);
  check(Boolean(toolchain), 'TOOLCHAIN_POINTER');
  check(/^\d+\.\d+\.\d+$/.test(toolchain?.nodeVersion || ''), 'NODE_EXACT_VERSION_REQUIRED');
  check(/^\d+\.\d+\.\d+$/.test(toolchain?.pnpmVersion || ''), 'PNPM_EXACT_VERSION_REQUIRED');
  check(toolchain?.requireFrozenLockfile === true, 'FROZEN_LOCK_REQUIRED');
  check(toolchain?.requireCleanGit === true, 'CLEAN_RELEASE_SOURCE_REQUIRED');
  check(pointer(policy, descriptor.environments.server.buildAllowedPointer) === false, 'SERVER_BUILD_FORBIDDEN');
  check(pointer(policy, descriptor.environments.server.gitCheckoutAllowedPointer) === false, 'SERVER_CHECKOUT_FORBIDDEN');
  check(policy.release?.isolatedSameHostBuilder?.allowed === false, 'LEGACY_SAME_HOST_BUILDER_FORBIDDEN');
  const services = pointer(policy, descriptor.servicesPointer);
  check(Boolean(services?.web?.port && services?.voice?.port && services.web.port !== services.voice.port), 'SERVICE_PORT_CONTRACT');
  const mounts = pointer(policy, descriptor.persistentSlotsPointer);
  check(Array.isArray(mounts) && mounts.length > 0, 'PERSISTENCE_MOUNTS_REQUIRED');
  check(Boolean(policy.git?.primaryRepository), 'PRIMARY_REPOSITORY_REQUIRED');
  for (const [name, entry] of Object.entries(packages)) {
    check(entry.manifest.engines?.node === toolchain?.nodeVersion, `${name}:NODE_CONTRACT_DRIFT`);
    check(entry.manifest.engines?.pnpm === toolchain?.pnpmVersion, `${name}:PNPM_CONTRACT_DRIFT`);
    check(entry.lockPresent, `${name}:LOCKFILE_MISSING`);
  }
  const scripts = packages.web.manifest.scripts || {};
  check(Boolean(scripts[descriptor.environments.local.buildScript]), 'LOCAL_BUILD_SCRIPT_MISSING');
  for (const name of Object.values(descriptor.environments.ci.buildScripts)) check(Boolean(scripts[name]), `CI_BUILD_SCRIPT_MISSING:${name}`);
  const candidate = workflows[descriptor.environments.ci.workflow] || '';
  check(candidate.includes(descriptor.environments.ci.installCommand), 'CI_FROZEN_INSTALL_DRIFT');
  check(candidate.includes(descriptor.environments.ci.voiceInstallCommand), 'CI_VOICE_FROZEN_INSTALL_DRIFT');
  for (const [name, source] of Object.entries(workflows)) {
    check(source.includes('.release.productionBuild.nodeVersion') && source.includes('.release.productionBuild.pnpmVersion'), `${name}:TOOLCHAIN_NOT_FROM_POLICY`);
    // This contract supports block mappings only for Action references. Reject other
    // YAML representations rather than silently overlooking flow maps, aliases or keys.
    const actionLines = [...source.matchAll(/^\s*(?:-\s*)?uses:[ \t]*([^\r\n]+)/gmu)];
    const references = actionLines.map(match => match[1].replace(/\s+#.*$/u, '').trim().replace(/^(['"])(.*)\1$/u, '$2'));
    const usesTokens = [...source.matchAll(/\buses\b/gu)];
    const unsupportedYaml = /^\s*(?:-\s*)?["']/mu.test(source)
      || /["'][^"'\r\n]*["'][ \t]*:/u.test(source)
      || /^\s*(?:-\s*|[A-Za-z0-9_.-]+:[ \t]*)\{/mu.test(source)
      || /^\s*[A-Za-z0-9_.-]+:[ \t]*\[[^\r\n]*\{/mu.test(source)
      || /(?:^|[\s:[,{])[&*][A-Za-z_][A-Za-z0-9_-]*/mu.test(source);
    check(!unsupportedYaml && references.length > 0 && usesTokens.length === actionLines.length
      && references.every(isImmutableActionReference), `${name}:UNPINNED_ACTION`);
  }
  if (runtime.nodeVersion) check(runtime.nodeVersion === toolchain?.nodeVersion, 'LOCAL_NODE_VERSION_DRIFT');
  const runtimeObserved = Object.keys(runtime).length > 0;
  if (runtimeObserved) check(runtime.pnpmVersion === toolchain?.pnpmVersion, runtime.pnpmVersion ? 'RUNTIME_PNPM_VERSION_DRIFT' : 'RUNTIME_PNPM_VERSION_UNKNOWN');
  const isCi = runtime.environment === 'ci';
  if (runtime.platform) check(runtime.platform === (isCi ? toolchain?.platform : descriptor.environments.local.platform), 'RUNTIME_PLATFORM_DRIFT');
  if (runtime.architecture) check(isCi ? toolchain?.architectures?.includes(runtime.architecture) : runtime.architecture === descriptor.environments.local.architecture, 'RUNTIME_ARCHITECTURE_DRIFT');
  return {
    schemaVersion: 'engineering-environment-report.v1',
    ok: errors.length === 0,
    errors,
    toolchain,
    environments: {
      local: { ...descriptor.environments.local, observed: isCi ? {} : runtime, verdict: !isCi && runtime.nodeVersion ? 'observed-process-only' : 'not-observed' },
      ci: { ...descriptor.environments.ci, observed: isCi ? runtime : {}, verdict: isCi ? 'observed-process-and-source-contract-only' : 'source-contract-only-no-remote-run' },
      server: { ...descriptor.environments.server, verdict: 'UNKNOWN-not-inspected' },
    },
    services,
    persistentSlots: mounts,
    packageLocks: Object.fromEntries(Object.entries(packages).map(([name, entry]) => [name, entry.lockSha256])),
    configurationNames: bundle.configurationNames,
    sourceReferences: bundle.files,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = evaluateEngineeringEnvironment(collectEngineeringEnvironment(process.cwd()), {
      nodeVersion: process.versions.node, pnpmVersion: observePnpmVersion(), platform: process.platform, architecture: process.arch, environment: process.env.CI === 'true' ? 'ci' : 'local',
    });
    console.log(JSON.stringify(report, null, 2));
    if (process.argv.includes('--check') && !report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.code || 'ENGINEERING_ENVIRONMENT_LOAD_FAILED' }));
    process.exitCode = 1;
  }
}
