import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
if(process.platform!=='linux')throw Error('Run this listener lifecycle check on Linux');
const text=fs.readFileSync(process.argv[2]||path.join(process.cwd(),'scripts/deploy-artifact-vnext.sh'),'utf8').replace(/\r\n/g,'\n');
const fn=(name,end)=>{const a=text.indexOf(name+'() {'),b=text.indexOf(end,a);assert(a>=0&&b>a,name);return text.slice(a,b+2)};
const code=[fn('wait_http','\n}\n\nassert_readiness_identity()'),fn('assert_readiness_identity','\n}\n\nverify_service_http()'),fn('verify_service_http','\n}\n\nverify_service_http '),fn('verify_pm2_identity','\n}\n\nlink_resolves_to()'),fn('link_resolves_to','\n}\n\nverify_pm2_absent()'),fn('verify_exact_active_composite','\n}\n\nif [[ -n "$PREVIOUS_TARGET"')].join('\n');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zimeiti-startup-check-'));
let child;
try{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const sha='a'.repeat(40),digest='b'.repeat(64),manifest='c'.repeat(64),release='startup-check-1',build='startup-build';
 const target=path.join(dir,'release'),asset=path.join(dir,'assets');fs.mkdirSync(target);fs.mkdirSync(asset);fs.symlinkSync(target,path.join(dir,'current'));fs.symlinkSync(asset,path.join(dir,'asset-current'));
 const body={ready:true,service:'web',releaseId:release,commitSha:sha,buildId:build,assetDigest:digest};
 child=spawn(process.execPath,['-e',"const http=require('http');process.stdout.write('armed\\n');setTimeout(()=>http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(process.argv[2])}).listen(Number(process.argv[1]),'127.0.0.1'),750)",String(port),JSON.stringify(body)],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject)});
 const metadata=pid=>[{name:'startup-check',pid,pm2_env:{status:'online',pm_cwd:target,RELEASE_ID:release,DEPLOY_COMMIT_SHA:sha,EXPECTED_BUILD_ID:build,COZE_PROJECT_ENV:'PROD',ASSET_DIGEST:digest,ASSET_MANIFEST_SHA256:manifest}}];
 const mp=path.join(dir,'pm2.json');fs.writeFileSync(mp,JSON.stringify(metadata(child.pid)));
 const env={...process.env,PM2_METADATA:mp,CURRENT_LINK:path.join(dir,'current'),ASSET_CURRENT_LINK:path.join(dir,'asset-current'),APP_NAME:'startup-check',LIVE_PORT:String(port),READINESS_PATH:'/ready',STAGING_DIR:dir,SERVICE:'web',TARGET:target,ASSET:asset,RELEASE:release,SHA:sha,BUILD:build,DIGEST:digest,MANIFEST:manifest};
 const invoke=(extra='',extraEnv={})=>spawnSync('bash',['-c','set -eu\npm2(){ cat "$PM2_METADATA"; }\n'+code+'\n'+extra+'\nverify_exact_active_composite "$TARGET" "$RELEASE" "$SHA" "$BUILD" "$ASSET" "$DIGEST" "$MANIFEST" probe'],{env:{...env,...extraEnv},encoding:'utf8',timeout:15000});
 const began=Date.now(),delayed=invoke();assert.equal(delayed.status,0,delayed.stderr);assert(Date.now()-began>=600,'delayed listener must actually wait');
 fs.writeFileSync(mp,JSON.stringify(metadata(process.pid)));assert.notEqual(invoke().status,0,'unrelated listener PID must fail');
 fs.writeFileSync(mp,JSON.stringify(metadata(child.pid)));assert.notEqual(invoke('',{SHA:'d'.repeat(40)}).status,0,'wrong readiness commit must fail');
 const count=path.join(dir,'attempts');const timeout=invoke('curl(){ echo attempt >> "$ATTEMPT_FILE"; return 7; }\nsleep(){ return 0; }',{ATTEMPT_FILE:count});assert.notEqual(timeout.status,0,'unavailable service must fail');assert.equal(fs.readFileSync(count,'utf8').trim().split('\n').length,45,'startup retries remain bounded');
 console.log(JSON.stringify({passed:true,cases:['real delayed listener accepted','wrong listener PID rejected','wrong release rejected','unavailable service rejected after 45 bounded attempts'],applicationRequests:0}));
}finally{child?.kill('SIGTERM');fs.rmSync(dir,{recursive:true,force:true});}
