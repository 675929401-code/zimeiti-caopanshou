import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const [action, configFile] = process.argv.slice(2);
if (!configFile || !['receive','run','status'].includes(action)) throw new Error('Expected receive|run|status <protected-config.json>');
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
for(const key of ['repository','stateRoot','driver']) if(!path.isAbsolute(config[key]||''))throw new Error(`Invalid ${key}`);
if (!fs.existsSync(config.repository) || !fs.existsSync(config.driver)) throw new Error('Pipeline paths unavailable');
fs.mkdirSync(config.stateRoot,{recursive:true,mode:0o700});
for(const name of ['jobs','authorizations','logs']) fs.mkdirSync(path.join(config.stateRoot,name),{recursive:true,mode:0o700});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const git=args=>{
  const r=spawnSync('git',['--git-dir',config.repository,...args],{encoding:'utf8',timeout:15000,windowsHide:true});
  if(r.status!==0)throw new Error('GIT_IDENTITY_CHECK_FAILED');return r.stdout.trim();
};
function save(file,value){const temporary=`${file}.${crypto.randomUUID()}.tmp`;fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
function assertCommit(sha){if(!/^[a-f0-9]{40}$/.test(sha)||git(['rev-parse',`${sha}^{commit}`])!==sha)throw new Error('INVALID_COMMIT');}
const jobsRoot=path.join(config.stateRoot,'jobs');

if(action==='receive'){
  const input=fs.readFileSync(0,'utf8');
  for(const line of input.trim().split('\n')){
    const [oldSha,commit,ref]=line.trim().split(/\s+/);
    if(!commit||/^0+$/.test(commit)||!['refs/heads/main','refs/heads/codex/pipeline-rehearsal'].includes(ref))continue;
    assertCommit(commit);
    const mode=ref.endsWith('/pipeline-rehearsal')?'rehearsal':'deploy';
    const file=path.join(jobsRoot,`${commit}-${mode}.json`);
    if(fs.existsSync(file)){console.log(`RELEASE_ALREADY_QUEUED ${commit}`);continue;}
    const job={schemaVersion:1,commit,ref,mode,status:'queued',createdAt:new Date().toISOString(),attempts:0};
    // Exclusive create makes duplicate receives idempotent; worker validates complete JSON.
    try{fs.writeFileSync(file,JSON.stringify(job,null,2)+'\n',{flag:'wx',mode:0o600});}
    catch(e){if(e.code!=='EEXIST')throw e;}
    console.log(`RELEASE_QUEUED ${commit} ${mode}`);
  }
}else if(action==='status'){
  const rows=fs.readdirSync(jobsRoot).filter(n=>/^[a-f0-9]{40}-(deploy|rehearsal)\.json$/.test(n))
    .map(n=>JSON.parse(fs.readFileSync(path.join(jobsRoot,n),'utf8'))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  console.log(JSON.stringify(rows.slice(0,12),null,2));
}else{
  const lock=path.join(config.stateRoot,'.worker.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST'){console.log('WORKER_ALREADY_RUNNING');process.exit(0);}throw e;}
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  try{
    for(const name of fs.readdirSync(jobsRoot).filter(n=>/^[a-f0-9]{40}-(deploy|rehearsal)\.json$/.test(n)).sort()){
      const file=path.join(jobsRoot,name);const job=JSON.parse(fs.readFileSync(file,'utf8'));
      if(!['queued','waiting-local-acceptance'].includes(job.status))continue;
      assertCommit(job.commit);
      if(job.mode==='deploy'){
        // Never promote an older queued commit after a newer main was pushed.
        if(git(['rev-parse','refs/heads/main'])!==job.commit){save(file,{...job,status:'superseded'});continue;}
        const authPath=path.join(config.stateRoot,'authorizations',`${job.commit}.json`);
        if(!fs.existsSync(authPath)){if(job.status!=='waiting-local-acceptance')save(file,{...job,status:'waiting-local-acceptance'});continue;}
        const stat=fs.lstatSync(authPath);
        if(stat.isSymbolicLink() || !stat.isFile() || (process.platform!=='win32'&&(stat.uid!==0||(stat.mode&0o077)!==0)))throw new Error('UNPROTECTED_RELEASE_AUTHORIZATION');
        const auth=JSON.parse(fs.readFileSync(authPath,'utf8'));
        const raw=spawnSync('git',['--git-dir',config.repository,'show',`${job.commit}:.release/source-files.v1.json`],{encoding:'buffer',timeout:15000});
        const version=JSON.parse(git(['show',`${job.commit}:public/version.json`]));
        if(raw.status!==0||auth.commit!==job.commit||auth.sourceVersion!==version.sourceVersion||auth.sourceManifestSha256!==hash(raw.stdout)
          ||auth.scope!=='web'||!/^[a-f0-9]{64}$/.test(auth.localAcceptanceSha256||'')||!Number.isFinite(Date.parse(auth.expiresAt))||Date.parse(auth.expiresAt)<Date.now()){
          save(file,{...job,status:'invalid-authorization'});continue;
        }
      }
      const running={...job,status:'running',attempts:job.attempts+1,startedAt:new Date().toISOString()};save(file,running);
      const logPath=path.join(config.stateRoot,'logs',`${job.commit}-${job.mode}.log`);const log=fs.openSync(logPath,'a',0o600);
      let result;
      try{result=spawnSync('bash',[config.driver,job.commit,job.mode],{env:{...process.env,PIPELINE_CONFIG:configFile},stdio:['ignore',log,log],timeout:3600000,windowsHide:true});}
      finally{fs.closeSync(log);}
      save(file,{...running,status:result.status===0?'passed':'failed',finishedAt:new Date().toISOString(),exitCode:result.status ?? -1,log:path.basename(logPath)});
    }
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
