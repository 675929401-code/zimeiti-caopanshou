import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const controllerPath = path.join(scriptDirectory, 'deploy-artifact-vnext.sh');
const source = fs.readFileSync(controllerPath, 'utf8').replace(/\r\n/g, '\n');
const begin = source.indexOf('assert_readiness_identity() {');
const end = source.indexOf('\n}\n\nverify_service_http()', begin);
assert(begin >= 0 && end > begin, 'extract the actual controller shell function');
const actualFunction = source.slice(begin, end + 2);
const bash = process.env.BASH_BIN || (process.platform === 'win32'
  ? ['E:/大模型聚合套壳/Git/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'].find(fs.existsSync)
  : 'bash');
assert(bash, 'Git Bash is required on Windows; set BASH_BIN if installed elsewhere');
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prestop-readiness-compat-'));
const response = path.join(temp, 'readiness.json').replaceAll('\\', '/');
const identity = { releaseId: 'fixture-legacy-web-r30', commitSha: 'a'.repeat(40), buildId: 'fixture-build',
  assetDigest: 'b'.repeat(64), sourceVersion: 'fixture-source', buildOutputDigest: 'c'.repeat(64) };
const legacy = { ready: true, activationReady: true, readinessProfile: 'production-full-v1', service: 'web', ...identity };
const modern = { ...legacy, readinessScope: 'core-platform', fullVerificationReady: false, verificationState: 'partial-video-model-verification' };
let cases = 0;
function check(name, body, { adopt = '1', label = 'predeploy', service = 'web', accepted = false } = {}) {
  fs.writeFileSync(response, `${JSON.stringify(body)}\n`);
  const shell = `set -eu\nnode(){ ${quote(process.execPath.replaceAll('\\', '/'))} "$@"; }\n${actualFunction}\nSERVICE=${quote(service)}\nPRESTOP_ADOPT=${quote(adopt)}\nassert_readiness_identity ${[response, identity.releaseId, identity.commitSha, identity.buildId, identity.assetDigest, identity.sourceVersion, identity.buildOutputDigest, label].map(quote).join(' ')}\n`;
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', shell], { encoding: 'utf8', timeout: 10000, env: { ...process.env, BASH_ENV: '', ENV: '' } });
  assert.ifError(result.error);
  if (accepted) assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  else assert.notEqual(result.status, 0, `${name}: unexpected acceptance`);
  cases += 1;
}
try {
  check('complete legacy predeploy with adoption', legacy, { accepted: true });
  check('ordinary predeploy cannot use legacy omission', legacy, { adopt: '0' });
  check('noncanonical adoption cannot use legacy omission', legacy, { adopt: 'true' });
  for (const label of ['candidate', 'live', 'rollback', 'probe']) check(`${label} cannot use legacy omission`, legacy, { label });
  check('voice predeploy cannot use web compatibility', { ...legacy, service: 'voice' }, { service: 'voice' });
  const semanticKeys = ['readinessScope', 'fullVerificationReady', 'verificationState'];
  for (let mask = 1; mask < 7; mask += 1) {
    const partial = { ...legacy };
    semanticKeys.forEach((key, index) => { if (mask & (1 << index)) partial[key] = modern[key]; });
    check(`partial legacy semantics mask ${mask}`, partial);
  }
  for (const key of semanticKeys) {
    check(`present null ${key} is not absence`, { ...legacy, [key]: null });
    check(`modern missing ${key} cannot pass live`, Object.fromEntries(Object.entries(modern).filter(([name]) => name !== key)), { label: 'live' });
  }
  for (const key of Object.keys(identity)) check(`legacy wrong ${key}`, { ...legacy, [key]: 'wrong' });
  check('legacy not ready', { ...legacy, ready: false });
  check('legacy not activation ready', { ...legacy, activationReady: false });
  check('legacy wrong production profile', { ...legacy, readinessProfile: 'candidate-runtime-v1' });
  check('modern wrong scope', { ...modern, readinessScope: 'candidate-runtime' });
  check('modern semantics remain accepted for adopted baseline', modern, { accepted: true });
  check('modern ordinary baseline remains accepted', modern, { adopt: '0', accepted: true });
  check('modern live remains accepted', modern, { label: 'live', accepted: true });
  const candidate = { ...modern, activationReady: false, readinessProfile: 'candidate-runtime-v1', readinessScope: 'candidate-runtime',
    checks: Object.fromEntries(['database', 'referenceData'].map((key) => [key, { state: 'external-attestation-required', probeExecuted: false, requiredBeforeActivation: true }])) };
  check('full candidate contract remains accepted', candidate, { label: 'candidate', accepted: true });
  check('candidate external gates remain required', { ...candidate, checks: {} }, { label: 'candidate' });
  const proofBegin = source.indexOf('prepare_control_plane_compatibility() {');
  const proofEnd = source.indexOf('\n}\n', proofBegin);
  const bindingBegin = source.indexOf('\nprepare_control_plane_compatibility\n"$DEPLOY_NODE_BIN"');
  const bindingEnd = source.indexOf('\nASSET_DIGEST=""', bindingBegin);
  assert(proofBegin >= 0 && proofEnd > proofBegin && bindingBegin >= 0 && bindingEnd > bindingBegin);
  const proofFunction = source.slice(proofBegin, proofEnd + 2);
  const runtimeBegin = source.indexOf('assert_deferred_runtime_control_paths() {');
  const runtimeEnd = source.indexOf('\n}\n', runtimeBegin);
  assert(runtimeBegin >= 0 && runtimeEnd > runtimeBegin);
  const runtimeFunction = source.slice(runtimeBegin,runtimeEnd + 2);
  const actualBindingCall = source.slice(bindingBegin, bindingEnd);
  const proofFile = path.join(temp, 'compatibility-proof.json').replaceAll('\\', '/');
  const verifier = path.join(temp, 'capture-verifier.mjs').replaceAll('\\', '/');
  fs.writeFileSync(proofFile, '{"fixture":"compatibility-only"}\n');
  fs.writeFileSync(verifier, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const proofPath = process.platform === 'win32' ? proofFile.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : proofFile;
  const proofSha = createHash('sha256').update(fs.readFileSync(proofFile)).digest('hex');
  const root = '/data/direct-deploy/bin/V1.0-fixture';
  function proofCheck(name, proof, digest, { accepted = false, trusted = true } = {}) {
    const values = { CONTROL_PLANE_ROOT: root, CONTROL_PLANE_COMPATIBILITY_PROOF: proof, CONTROL_PLANE_COMPATIBILITY_PROOF_SHA256: digest,
      DEPLOY_NODE_BIN: process.execPath.replaceAll('\\', '/'), CONTROL_PLANE_TRUSTED_VERIFIER: verifier, CONTROL_PLANE_EXPECTED_DESCRIPTOR: '/fixture/descriptor.json',
      RELEASE_VALIDATION_BUNDLE: '/fixture/bundle.json', RELEASE_VALIDATION_BUNDLE_SHA256: 'd'.repeat(64), SERVICE: 'web', ACTUAL_SHA256: 'e'.repeat(64),
      RELEASE_ID: identity.releaseId, COMMIT_SHA: identity.commitSha, SOURCE_VERSION: identity.sourceVersion, BUILD_ID: identity.buildId, BUILD_OUTPUT_DIGEST: identity.buildOutputDigest };
    const shell = `set -eu\ndie(){ exit 2; }\nrequire_trusted_controller_file(){ ${trusted ? 'return 0;' : 'return 7;'} }\n${Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`).join('\n')}\n${proofFunction}\n${runtimeFunction}\n${actualBindingCall}\n`;
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', shell], { encoding: 'utf8', timeout: 10000, env: { ...process.env, BASH_ENV: '', ENV: '' } });
    assert.ifError(result.error);
    if (accepted) {
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      const args = JSON.parse(result.stdout);
      assert.equal(args[0], 'verify-deployment-binding');
      if (proof) assert.deepEqual(args.slice(-4), ['--compatibility-proof', process.platform === 'win32' ? proofFile : proof, '--compatibility-proof-sha256', digest]);
      else assert(!args.includes('--compatibility-proof') && !args.includes('--compatibility-proof-sha256'), 'ordinary binding passes no optional arguments');
    } else assert.notEqual(result.status, 0, `${name}: unexpected acceptance`);
    cases += 1;
  }
  proofCheck('ordinary binding without proof unchanged', '', '', { accepted: true });
  proofCheck('proof path alone rejected', proofPath, '');
  proofCheck('proof digest alone rejected', '', proofSha);
  proofCheck('relative proof path rejected', 'relative.json', proofSha);
  proofCheck('proof inside new control bundle rejected', `${root}/proof.json`, proofSha);
  proofCheck('malformed proof digest rejected', proofPath, 'NOT_A_DIGEST');
  proofCheck('proof byte drift rejected', proofPath, '0'.repeat(64));
  proofCheck('trusted root file gate remains mandatory', proofPath, proofSha, { trusted: false });
  proofCheck('valid proof forwarded to same canonical verifier binding', proofPath, proofSha, { accepted: true });
  const originalManifest = '9'.repeat(64);
  const originalBundle = path.join(temp,'original-bundle.json');
  fs.writeFileSync(originalBundle,JSON.stringify({subject:{controlPlane:{manifestSha256:originalManifest}}}));
  const derivation = runtimeFunction.match(/<<'NODE'\n([\s\S]*?)\nNODE/u)?.[1];
  assert(derivation,'original-root derivation must be the actual controller Node program');
  let result=spawnSync(process.execPath,['-',originalBundle],{input:derivation,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,`/data/direct-deploy/bin/V1.0-${originalManifest.slice(0,12)}`);cases++;
  fs.writeFileSync(originalBundle,JSON.stringify({subject:{controlPlane:{manifestSha256:'../wrong'}}}));
  result=spawnSync(process.execPath,['-',originalBundle],{input:derivation,encoding:'utf8'});
  assert.notEqual(result.status,0);cases++;
  const fixtureOld=path.join(temp,'old-runtime'),fixtureNew=path.join(temp,'new-control');
  fs.mkdirSync(fixtureOld);fs.mkdirSync(fixtureNew);
  for(const dir of [fixtureOld,fixtureNew])for(const name of ['transaction-hook.mjs','ecosystem.config.cjs'])fs.writeFileSync(path.join(dir,name),`same reviewed ${name}`);
  const unix=p=>process.platform==='win32'?p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d)=>`/${d.toLowerCase()}`):p;
  const oldRoot=unix(fixtureOld),newRoot=unix(fixtureNew);
  // Only unsupported Windows root metadata and the separately tested Node
  // derivation output are fixture-owned. The real shell gate and SHA checks run.
  function runtimeCheck(name,{adopt='1',args=true,wrongPath=false,trusted=true,accepted=false,change=null}={}){
    if(change)fs.writeFileSync(path.join(fixtureOld,change),'drift');
    const script=`set -eu\ndie(){ exit 2; }\nnode(){ printf '%s' ${quote(oldRoot)}; }\nrequire_trusted_controller_file(){ ${trusted?'[[ -f "$1" && ! -L "$1" ]]':'return 7'}; }\nCONTROL_PLANE_RUNTIME_PATHS_DEFERRED=1\nPRESTOP_ADOPT=${quote(adopt)}\nCONTROL_PLANE_COMPATIBILITY_ARGS=(${args?"a b c d":""})\nCONTROL_PLANE_ROOT=${quote(newRoot)}\nRELEASE_VALIDATION_BUNDLE=/fixture/original.json\nDIRECT_HOOK_PATH=${quote((wrongPath?newRoot:oldRoot)+'/transaction-hook.mjs')}\nDIRECT_HOOK_PM2_CONFIG_PATH=${quote(oldRoot+'/ecosystem.config.cjs')}\n${runtimeFunction}\nassert_deferred_runtime_control_paths\n`;
    try{const x=spawnSync(bash,['--noprofile','--norc','-c',script],{encoding:'utf8',timeout:10000,env:{...process.env,BASH_ENV:'',ENV:''}});assert.ifError(x.error);if(accepted)assert.equal(x.status,0,`${name}: ${x.stderr}`);else assert.notEqual(x.status,0,name);cases++;}
    finally{if(change)fs.writeFileSync(path.join(fixtureOld,change),`same reviewed ${change}`);}
  }
  runtimeCheck('same original hook/config bytes accepted',{accepted:true});
  runtimeCheck('non-adoption old runtime paths rejected',{adopt:'0'});
  runtimeCheck('old paths without verified proof arguments rejected',{args:false});
  runtimeCheck('old root mismatch rejected',{wrongPath:true});
  runtimeCheck('old hook drift rejected',{change:'transaction-hook.mjs'});
  runtimeCheck('old config drift rejected',{change:'ecosystem.config.cjs'});
  runtimeCheck('trusted file metadata remains required',{trusted:false});
  const gateBegin=source.indexOf('CONTROL_PLANE_RUNTIME_PATHS_DEFERRED=0');
  const gateEnd=source.indexOf('\nASSET_POLICY_TRANSITION_VERIFIER=',gateBegin);
  assert(gateBegin>=0&&gateEnd>gateBegin);
  const earlyGate=source.slice(gateBegin,gateEnd);
  for(const item of [{adopt:'0',proof:'',sha:'',accepted:false},{adopt:'1',proof:'',sha:proofSha,accepted:false},{adopt:'1',proof:proofPath,sha:proofSha,accepted:true}]){
    const script=`set -eu\ndie(){ exit 2; }\nSERVICE=web\nCONTROL_PLANE_ROOT=${quote(newRoot)}\nDIRECT_HOOK_PATH=${quote(oldRoot+'/transaction-hook.mjs')}\nDIRECT_HOOK_PM2_CONFIG_PATH=${quote(oldRoot+'/ecosystem.config.cjs')}\nPRESTOP_ADOPT=${quote(item.adopt)}\nCONTROL_PLANE_COMPATIBILITY_PROOF=${quote(item.proof)}\nCONTROL_PLANE_COMPATIBILITY_PROOF_SHA256=${quote(item.sha)}\n${earlyGate}\n[[ "$CONTROL_PLANE_RUNTIME_PATHS_DEFERRED" == 1 ]]\n`;
    const x=spawnSync(bash,['--noprofile','--norc','-c',script],{encoding:'utf8',timeout:10000,env:{...process.env,BASH_ENV:'',ENV:''}});assert.ifError(x.error);if(item.accepted)assert.equal(x.status,0,x.stderr);else assert.notEqual(x.status,0);cases++;
  }
  const bindingSuccess=source.indexOf('|| die "business artifact/control-plane release binding failed"');
  const deferredCall=source.indexOf('\nassert_deferred_runtime_control_paths\n',bindingSuccess);
  assert(bindingSuccess>=0&&deferredCall>bindingSuccess);
  assert(deferredCall<source.indexOf('\nvalidate_direct_hook_configuration\n',deferredCall));cases++;
  console.log(JSON.stringify({ passed: true, cases, actualControllerShellFunctionExecuted: true, productionRequests: 0 }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
