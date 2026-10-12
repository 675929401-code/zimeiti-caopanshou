#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectLocalDiagnostic, metadataEnvironment, parseDiagnosticArgs } from './release-close-loop.mjs';

const root = fs.realpathSync(process.cwd());
const secret = 'synthetic-diagnostic-poison-not-a-credential';
const cases = [];
function check(name, run) { return Promise.resolve().then(run).then(() => cases.push(name)); }
const poison = new Proxy({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, { get(target, key) {
  if (/DATABASE|TOKEN|SECRET|RELEASE_REPO|GIT_BIN|GIT_DIR|GIT_WORK_TREE/u.test(String(key))) throw new Error('FORBIDDEN_ENVIRONMENT_READ');
  return target[key];
} });
const baseDependencies = {
  cwd: root, platform: process.platform, realpath: value => path.resolve(value), exists: () => true,
  environment: poison, nodeVersion: '24.19.0',
  loadEnvironment: async () => ({ collectEngineeringEnvironment: () => ({}), evaluateEngineeringEnvironment: (_bundle, runtime) => {
    assert.deepEqual(runtime, {});
    return { errors: [], toolchain: { nodeVersion: '24.19.0' } };
  } }),
  executeGit: (command, args, options) => {
    assert.equal(command, 'git');
    assert.equal(options.shell, false);
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(options.timeout, 10_000);
    assert.ok(args.includes('core.fsmonitor=false'));
    assert.ok(!Object.keys(options.env).some(key => /DATABASE|TOKEN|SECRET|RELEASE_REPO|GIT_BIN/u.test(key)));
    const values = { 'rev-parse --show-toplevel': root + '\n', 'branch --show-current': 'main\n', 'rev-parse --verify HEAD': 'a'.repeat(40) + '\n', 'status --porcelain=v1 -z --untracked-files=all': '', remote: 'github\norigin\n' };
    const key = args.slice(5).join(' ');
    assert.ok(key in values, 'ONLY_LOCAL_GIT_METADATA_ALLOWED');
    return { status: 0, stdout: values[key], stderr: secret };
  },
};

await check('default reports local evidence and unknown external states', async () => {
  const report = await collectLocalDiagnostic(root, baseDependencies);
  assert.equal(report.ok, true);
  assert.equal('canExecuteServerDeploy' in report, false);
  for (const key of ['github', 'database', 'production']) assert.equal(report[key].verdict, 'UNKNOWN-not-inspected');
  assert.equal(report.localPreview.runningLatest, 'UNKNOWN-not-inspected');
  assert.equal(report.nextActions.length, 1);
  assert.equal(report.nextActions[0].kind, 'READ_AUTHORITY');
  assert.equal(JSON.stringify(report).includes(secret), false);
});
await check('secret and redirect environment values never inspected or forwarded', () => {
  assert.equal(metadataEnvironment(poison).GIT_TERMINAL_PROMPT, '0');
});
await check('dirty worktree is a local failure', async () => {
  const report = await collectLocalDiagnostic(root, { ...baseDependencies, executeGit: (command, args, options) => args.includes('status')
    ? { status: 0, stdout: ' M src/fixture.ts\0' } : baseDependencies.executeGit(command, args, options) });
  assert.equal(report.ok, false);
  assert.ok(report.errors.includes('SOURCE_WORKTREE_DIRTY'));
});
await check('toolchain drift cannot produce success', async () => {
  const report = await collectLocalDiagnostic(root, { ...baseDependencies, nodeVersion: '24.21.0' });
  assert.equal(report.ok, false);
  assert.ok(report.errors.includes('LOCAL_NODE_VERSION_DRIFT'));
});
await check('contract failures stay local failures', async () => {
  const report = await collectLocalDiagnostic(root, { ...baseDependencies, loadEnvironment: async () => ({
    collectEngineeringEnvironment: () => ({}), evaluateEngineeringEnvironment: () => ({ errors: ['ENVIRONMENT_SCHEMA'], toolchain: { nodeVersion: '24.19.0' } }),
  }) });
  assert.equal(report.ok, false);
});
await check('missing git is closed', () => assert.rejects(collectLocalDiagnostic(root, { ...baseDependencies, executeGit: () => ({ status: 1, stdout: '', stderr: secret }) }), /LOCAL_GIT_METADATA_UNAVAILABLE/u));
await check('git timeout is closed', () => assert.rejects(collectLocalDiagnostic(root, { ...baseDependencies, executeGit: () => ({ status: null, error: new Error(secret) }) }), /LOCAL_GIT_METADATA_UNAVAILABLE/u));
await check('git root redirect is closed', () => assert.rejects(collectLocalDiagnostic(root, { ...baseDependencies, executeGit: (command, args, options) => args.includes('--show-toplevel')
  ? { status: 0, stdout: path.dirname(root) } : baseDependencies.executeGit(command, args, options) }), /LOCAL_GIT_ROOT_MISMATCH/u));
await check('different cwd rejected before loading config or git', () => assert.rejects(collectLocalDiagnostic(root, { ...baseDependencies, cwd: path.dirname(root), loadEnvironment: () => { throw new Error('UNEXPECTED_CONFIG_READ'); } }), /LOCAL_DIAGNOSTIC_CWD_MUST_BE_SOURCE/u));
await check('missing authority rejected before loading config', () => assert.rejects(collectLocalDiagnostic(root, { ...baseDependencies, exists: () => false }), /DEPLOYMENT_AUTHORITY_MISSING/u));

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'local-diagnostic-'));
const sentinel = `import fs from 'node:fs'; import child from 'node:child_process'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module';
const originalRead=fs.readFileSync; const originalSpawn=child.spawnSync; const originalEnvironment=process.env;
const stop=()=>{throw new Error('DIAGNOSTIC_SIDE_EFFECT')};
for(const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','createWriteStream'])fs[name]=stop;
for(const name of ['writeFile','appendFile','mkdir','rename','unlink','rm'])fs.promises[name]=stop;
fs.readFileSync=(name,...rest)=>{if(/(?:^|[\\\\/])(?:runtime[.]json|[.]env(?:[.]local|[.]production(?:[.]local)?)?)$/u.test(String(name)))stop();return originalRead(name,...rest)};
for(const name of ['spawn','exec','execSync','execFile','execFileSync','fork'])child[name]=stop;
child.spawnSync=(command,args,options)=>{if(command!=='git'||!Array.isArray(args)||!args.includes('--no-optional-locks')||args.some(arg=>/^(?:fetch|push|ls-remote)$/u.test(arg)))stop();if(Object.keys(options.env||{}).some(key=>/DATABASE|TOKEN|SECRET|RELEASE_REPO|GIT_BIN/u.test(key)))stop();return originalSpawn(command,args,options)};
for(const protocol of [http,https])for(const name of ['request','get'])protocol[name]=stop;
net.connect=stop; net.createConnection=stop; tls.connect=stop;
globalThis.fetch=stop; process.env=new Proxy(originalEnvironment,{get(target,key){if(/^(?:DATABASE_URL|DEPLOY_DATABASE_URL|SUPABASE_DATABASE_URL|POSTGRES_URL|RELEASE_REPO|GIT_BIN|GIT_DIR|GIT_WORK_TREE)$/u.test(String(key)))stop();return target[key]}});
syncBuiltinESMExports();`;
try {
  for (const args of [['--push-git'], ['--human', '--push-git=true'], ['--push-git=false'], ['--push-git='], ['--push-git', 'false'], ['--push-git', '--push-git'], ['--execute'], ['--database'], ['--live'], ['--unknown']]) {
    await check(`argv rejection before effects: ${args.join(' ')}`, () => {
      assert.throws(() => parseDiagnosticArgs(args));
      const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(sentinel)}`, path.join(root, 'scripts/release-close-loop.mjs'), ...args], {
        cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, PATH: '', DATABASE_URL: secret, RELEASE_REPO: secret, GIT_BIN: secret },
      });
      assert.equal(result.status, 2, result.stderr);
      assert.equal((result.stdout + result.stderr).includes(secret), false);
      assert.equal((result.stdout + result.stderr).includes('DIAGNOSTIC_SIDE_EFFECT'), false);
    });
  }
  await check('help works before config and subprocesses', () => {
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(sentinel)}`, path.join(root, 'scripts/release-close-loop.mjs'), '--help'], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
  });
  await check('real default CLI with poison environment has no forbidden effects', () => {
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(sentinel)}`, path.join(root, 'scripts/release-close-loop.mjs'), '--json'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, DATABASE_URL: secret, RELEASE_REPO: secret, GIT_BIN: secret },
    });
    assert.ok([0, 1].includes(result.status), result.stderr);
    assert.equal(result.stderr.includes('DIAGNOSTIC_SIDE_EFFECT'), false);
    const expectedIdentityFailure = process.platform === 'win32' && root.replace(/\\/gu, '/').toLowerCase() !== 'F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本'.toLowerCase()
      ? 'LOCAL_DIAGNOSTIC_F_SOURCE_REQUIRED'
      : !fs.existsSync(path.resolve(root, '../../../99_系统协议/02_操作协议/自媒体操盘手部署执行规约-当前版.md')) ? 'DEPLOYMENT_AUTHORITY_MISSING' : null;
    if (expectedIdentityFailure) {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error, expectedIdentityFailure);
    } else {
      const report = JSON.parse(result.stdout);
      assert.equal(report.schemaVersion, 'local-engineering-diagnostic.v1');
      assert.equal(report.database.verdict, 'UNKNOWN-not-inspected');
      assert.equal('canExecuteServerDeploy' in report, false);
    }
    assert.equal((result.stdout + result.stderr).includes(secret), false);
  });
  assert.deepEqual(fs.readdirSync(temporary), []);
} finally { fs.rmdirSync(temporary); }
await check('isolated CI checkout without external authority is an explicit closed result', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-ci-'));
  const scripts = path.join(fixture, 'scripts');
  const entry = path.join(scripts, 'release-close-loop.mjs');
  try {
    assert.equal(fs.existsSync(path.resolve(fixture, '../../../99_系统协议/02_操作协议/自媒体操盘手部署执行规约-当前版.md')), false);
    fs.mkdirSync(scripts);
    fs.copyFileSync(path.join(root, 'scripts/release-close-loop.mjs'), entry);
    const ciSentinel = sentinel + "\nObject.defineProperty(process,'platform',{value:'linux'});";
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(ciSentinel)}`, entry, '--json'], { cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'DEPLOYMENT_AUTHORITY_MISSING');
  } finally {
    if (fs.existsSync(entry)) fs.unlinkSync(entry);
    if (fs.existsSync(scripts)) fs.rmdirSync(scripts);
    fs.rmdirSync(fixture);
  }
});
console.log(JSON.stringify({ ok: true, checks: cases.length, cases, networkRequests: 0, databaseConnections: 0 }));
