import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

export function workerEnvironment(root, manifest, inherited, protectedValues) {
  const shared=path.join(root,'shared');
  const safe={...inherited,...protectedValues};
  // Runtime files cannot replace the deployment toolchain or inject Node flags.
  safe.PATH=inherited.PATH;
  delete safe.NODE_OPTIONS;
  return {...safe,NODE_ENV:'production',COZE_PROJECT_ENV:'PROD',
    RELEASE_ROOT:root,WEB_RELEASE_DIR:path.join(root,'current-web'),
    APP_DATA_DIR:path.join(shared,'data'),APP_RUNTIME_DIR:path.join(shared,'runtime'),
    COMMERCE_DATA_DIR:path.join(shared,'runtime','commerce-agent'),
    COMMERCE_GATEWAY_KEY_FILE:path.join(shared,'runtime','commerce-agent','main-gateway.key'),
    IDEMPOTENCY_DIR:path.join(shared,'runtime','llm-request-idempotency'),BACKUP_DIR:path.join(shared,'backups'),
    PUBLIC_ASSET_ROOT:path.join(shared,'assets','current','public'),STORAGE_LOCAL_BASE_PATH:path.join(shared,'uploads'),
    VOICE_SQLITE_PATH:path.join(shared,'voice','voice.db'),VOICE_REFERENCE_AUDIO_DIR:path.join(shared,'voice','reference-audio'),
    RELEASE_ID:manifest.releaseId,DEPLOY_COMMIT_SHA:manifest.commitSha,EXPECTED_BUILD_ID:manifest.buildId,
    ASSET_DIGEST:manifest.assetDigest,ASSET_MANIFEST_SHA256:manifest.assetManifestSha256,
    MEDIA_QUEUE_WORKER_INSTANCES:'2',MEDIA_QUEUE_WORKER_PORT:'5102'};
}

export function workersMatch(entries, root, manifest, resolve=fs.realpathSync, executable=pid=>fs.readlinkSync(`/proc/${pid}/exe`)) {
  const workers=entries.filter(p=>p.name==='agent-hub-media-worker');
  const current=resolve(path.join(root,'current-web'));
  return workers.length===2 && new Set(workers.map(p=>Number(p.pm2_env?.PORT))).size===2 && workers.every(p=>{const e=p.pm2_env||{};
    try {return p.pid>0&&e.status==='online'&&resolve(e.pm_cwd)===current&&resolve(e.pm_exec_path)===path.join(current,'server.js')
      &&e.exec_mode==='fork_mode'&&[5102,5103].includes(Number(e.PORT))&&executable(p.pid)===process.execPath
      &&e.DEPLOY_COMMIT_SHA===manifest.commitSha&&e.RELEASE_ID===manifest.releaseId&&e.EXPECTED_BUILD_ID===manifest.buildId
      &&e.COMMERCE_GATEWAY_KEY_FILE===path.join(root,'shared','runtime','commerce-agent','main-gateway.key')
      &&e.MEDIA_QUEUE_WORKER_PROCESS==='1'&&e.DIGITAL_VIDEO_QUEUE_WORKER==='1'&&e.DIGITAL_HUMAN_LONG_WORKER==='1';}
    catch{return false;}
  });
}

async function main(){
  const root=path.resolve(process.argv[2]||'/data/web');
  if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('LINUX_RELEASE_OPERATOR_REQUIRED');
  const current=fs.realpathSync(path.join(root,'current-web'));
  const manifest=JSON.parse(fs.readFileSync(path.join(current,'release-manifest.json'),'utf8'));
  if(manifest.service!=='web'||!/^[a-f0-9]{40}$/.test(manifest.commitSha)||!manifest.buildId||current!==path.join(root,'releases',manifest.releaseId,'web'))throw Error('MANAGED_WEB_IDENTITY_REQUIRED');
  const envFile=path.join(root,'shared','env','.env.local'),stat=fs.lstatSync(envFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o077)!==0)throw Error('PROTECTED_ENVIRONMENT_REQUIRED');
  const env=workerEnvironment(root,manifest,process.env,parseEnv(fs.readFileSync(envFile,'utf8')));
  const gatewayKeyStat=fs.lstatSync(env.COMMERCE_GATEWAY_KEY_FILE);
  if(!gatewayKeyStat.isFile()||gatewayKeyStat.isSymbolicLink()||gatewayKeyStat.uid!==0||(gatewayKeyStat.mode&0o077)!==0)throw Error('COMMERCE_GATEWAY_KEY_FILE_REQUIRED');
  if(fs.readFileSync(env.COMMERCE_GATEWAY_KEY_FILE,'utf8').trim().length<40)throw Error('COMMERCE_GATEWAY_KEY_INVALID');
  const run=args=>{const r=spawnSync('pm2',args,{env,encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024});if(r.status!==0||r.error)throw Error('MEDIA_WORKER_PM2_OPERATION_FAILED');return r.stdout;};
  // Mode changes need an explicit stop/delete; the direct transaction snapshots
  // old definitions before invoking this script and restores them on failure.
  const previous=JSON.parse(run(['jlist'])).filter(p=>p.name==='agent-hub-media-worker');
  if(previous.some(p=>p.pm2_env.exec_mode!=='fork_mode'))throw Error('OLD_MEDIA_WORKERS_MUST_BE_TRANSACTIONALLY_REMOVED');
  run(['startOrReload',path.join(current,'.release/ecosystem.config.cjs'),'--only','agent-hub-media-worker','--env','production','--update-env']);
  let passed=false;
  for(let i=0;i<30;i++){
    if(workersMatch(JSON.parse(run(['jlist'])),root,manifest)){
      try{const identities=await Promise.all([5102,5103].map(async port=>{const r=await fetch(`http://127.0.0.1:${port}/api/version`,{signal:AbortSignal.timeout(3000)});const v=await r.json();return r.ok&&v.deployCommitSha===manifest.commitSha&&v.buildId===manifest.buildId&&v.releaseId===manifest.releaseId;}));if(identities.every(Boolean)){passed=true;break;}}catch{}
    }
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!passed)throw Error('MEDIA_WORKER_CURRENT_RELEASE_NOT_READY');
  run(['save']);
  console.log(JSON.stringify({passed:true,workers:2,commit:manifest.commitSha,buildId:manifest.buildId,ports:[5102,5103],nodeExecutable:process.execPath}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){main().catch(e=>{console.error(e.message);process.exitCode=1;});}
