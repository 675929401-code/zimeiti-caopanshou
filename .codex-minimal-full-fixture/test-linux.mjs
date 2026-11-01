import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {once} from 'node:events';import {fileURLToPath} from 'node:url';
const R='/tmp/codex-window-fixture-only',HERE=path.dirname(fileURLToPath(import.meta.url));
const active=process.platform==='linux'&&process.geteuid?.()===0&&process.env.FIXTURE_ISOLATED==='1';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');let owned=false;
function setup(mode){
 if(fs.existsSync(R)){if(!owned)throw Error('FIXTURE_ROOT_EXISTS');fs.rmSync(R,{recursive:true,force:true})}
 fs.mkdirSync(R,{mode:0o700});owned=true;for(const dir of ['web','control','web/releases','web/releases/fixture-release','web/releases/fixture-release/web'])fs.mkdirSync(path.join(R,dir),{mode:0o700});
 fs.writeFileSync(R+'/scenario',mode);fs.writeFileSync(R+'/web/.deploy.lock','',{mode:0o600});fs.writeFileSync(R+'/control/config','fixture-config',{mode:0o600});fs.writeFileSync(R+'/artifact','fixture-artifact',{mode:0o600});
 for(const n of ['maintenance.py','prestop.py','db.mjs','controller.py','controller.sh','entry.mjs','window-main-fixture.mjs','dispatch-deadline.mjs'])fs.copyFileSync(path.join(HERE,n),path.join(R,n));
 const artifactSha256=sha(fs.readFileSync(R+'/artifact')),releaseId='fixture-release',transactionId=releaseId+'-'+artifactSha256.slice(0,12);
 const d={transactionId,releaseId,artifactPath:R+'/artifact',artifactSha256,commitSha:'1'.repeat(40),buildId:'fixture-build',sourceVersion:'fixture-source',buildOutputDigest:'2'.repeat(64),assetDigest:'3'.repeat(64),assetManifestSha256:'4'.repeat(64),pythonPath:'/usr/bin/python3',maintenancePath:R+'/maintenance.py',workerFactoryPath:R+'/prestop.py',controllerPath:R+'/controller.sh',controllerSha256:sha(fs.readFileSync(R+'/controller.sh')),hookPath:R+'/control/hook',hookSha256:'5'.repeat(64),configPath:R+'/control/config',configSha256:sha(fs.readFileSync(R+'/control/config')),verifierPath:R+'/verifier',verifierSha256:'6'.repeat(64),receiptPath:R+'/receipt',receiptSha256:'7'.repeat(64),controlDescriptorPath:R+'/control-descriptor',controlDescriptorSha256:'8'.repeat(64),bundlePath:R+'/bundle',bundleSha256:'9'.repeat(64)};
 fs.writeFileSync(R+'/descriptor.json',JSON.stringify(d));return d;
}
async function run(mode,{locked=true,invalid=false,expectReady=true,disconnectAt=null}={}){
 const d=setup(mode);const shell=locked?'exec 9>"$1"; /usr/bin/flock -n 9; exec "$2" "$3"':'exec 9>"$1"; exec "$2" "$3"';
 const child=spawn('/bin/bash',['-c',shell,'fixture',R+'/web/.deploy.lock',process.execPath,R+'/entry.mjs'],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
 let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
 const close=once(child,'close');const disconnect=disconnectAt? (async()=>{const deadline=Date.now()+15000;while(!fs.existsSync(R+'/events')||!fs.readFileSync(R+'/events','utf8').split('\n').includes(disconnectAt)){if(Date.now()>deadline)throw Error('FIXTURE_DISCONNECT_TIMEOUT');if(child.exitCode!==null)throw Error('FIXTURE_EARLY_EXIT '+err+' EVENTS '+(fs.existsSync(R+'/events')?fs.readFileSync(R+'/events','utf8'):'none'));await new Promise(r=>setTimeout(r,10));}child.stdout.destroy();await new Promise(r=>setTimeout(r,300));fs.writeFileSync(R+'/continue','go');})():null;try{
  if(expectReady){
   const deadline=Date.now()+15000;while(!out.includes('READY_FOR_WIRE')){if(Date.now()>deadline)throw Error('FIXTURE_READY_TIMEOUT');if(child.exitCode!==null)throw Error('FIXTURE_EARLY_EXIT '+err+' EVENTS '+(fs.existsSync(R+'/events')?fs.readFileSync(R+'/events','utf8'):'none'));await new Promise(r=>setTimeout(r,10));}
   const sql=Buffer.from('fixture SQL; no database\n'),wire=Buffer.from(sql.toString('base64')+'\n'),header={batchId:'11111111-1111-4111-8111-111111111111',scriptSha256:sha(sql),wireSha256:sha(wire),wireLength:wire.length};
   if(invalid)header.wireSha256='f'.repeat(64);
   child.stdin.end(Buffer.concat([Buffer.from(JSON.stringify(header)+'\n'),wire]));
  }else if(!disconnectAt)child.stdin.end();
  if(disconnect)await disconnect;
  const [code,signal]=await close;return {code,signal,out,err,d,events:fs.existsSync(R+'/events')?fs.readFileSync(R+'/events','utf8').trim().split('\n'):[],held:fs.existsSync(R+'/held'),attempt:fs.existsSync(R+'/control/transactions/'+d.transactionId+'/migration-attempt.json'),confirmed:fs.existsSync(R+'/control/transactions/'+d.transactionId+'/migration-confirmed.json')};
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
}
test('private network, mount and fd9 full sequence plus failures',{skip:!active,timeout:55000},async()=>{
 assert.ok(process.env.FIXTURE_HOST_NET);assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),process.env.FIXTURE_HOST_NET);assert.equal(fs.statSync('/tmp').mode&0o077,0);
 let x=await run('good');assert.equal(x.code,0,x.err);assert.match(x.out,/"phase":"WINDOW_RELEASED"/);assert.deepEqual(x.events,['plan','hold-ready','hold-install','hold-verify','prestop-ready','db-once','prestop-handoff','controller-start','controller-success','restore']);assert.equal(x.held,false);assert.equal(x.attempt,true);assert.equal(x.confirmed,true);
 for(const scenario of ['db-failure','handoff-failure','prestop-close-input','controller-failure','maintenance-during-handoff','missing-success','restore-failure','ingress-held']){
  x=await run(scenario);assert.notEqual(x.code,0,scenario);assert.doesNotMatch(x.out,/WINDOW_RELEASED/);assert.equal(x.held,true,scenario);assert.equal(x.events.includes('restore'),false,scenario);if(scenario==='db-failure')assert.equal(x.events.includes('controller-start'),false);if(scenario==='handoff-failure'||scenario==='prestop-close-input'||scenario==='maintenance-during-handoff')assert.equal(x.events.includes('controller-start'),false);
 }
 x=await run('good',{invalid:true});assert.notEqual(x.code,0);assert.equal(x.held,true);assert.equal(x.events.includes('db-once'),false);assert.equal(x.events.includes('controller-start'),false);
 x=await run('stdout-plan',{expectReady:false,disconnectAt:'plan'});assert.notEqual(x.code,0);assert.deepEqual(x.events,['plan']);assert.equal(x.held,false);assert.equal(x.events.includes('db-once'),false);
 x=await run('stdout-controller',{disconnectAt:'controller-success'});assert.notEqual(x.code,0);assert.equal(x.events.includes('controller-success'),true);assert.equal(x.events.includes('restore'),false);assert.equal(x.held,true);
 x=await run('plan-failure',{expectReady:false});assert.notEqual(x.code,0);assert.deepEqual(x.events,['plan']);assert.equal(x.held,false);assert.equal(x.events.includes('db-once'),false);
 x=await run('maintenance-close-input',{expectReady:false});assert.notEqual(x.code,0);assert.equal(x.events.includes('db-once'),false);assert.equal(x.events.includes('hold-install'),false);
 x=await run('prestop-failure',{expectReady:false});assert.notEqual(x.code,0);assert.equal(x.held,true);assert.equal(x.events.includes('db-once'),false);
 x=await run('ingress-before',{expectReady:false});assert.notEqual(x.code,0);assert.equal(x.held,true);assert.equal(x.events.includes('prestop-ready'),false);
 x=await run('good',{locked:false,expectReady:false});assert.notEqual(x.code,0);assert.equal(x.events.length,0);
 // Once restore is sent, an ingress observation failure cannot prove it stayed closed.
 x=await run('ingress-after');assert.notEqual(x.code,0);assert.equal(x.events.includes('restore'),true);assert.equal(x.held,false);assert.doesNotMatch(x.out,/WINDOW_RELEASED/);
});
process.on('exit',()=>{if(owned&&fs.existsSync(R))fs.rmSync(R,{recursive:true,force:true})});
