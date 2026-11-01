// Private ordered stdio protocol for one long-lived SSH child. Its remote
// supervisor and authenticated production launcher are not yet installed.
// This is a transport primitive, not proof of ingress or database eligibility.
const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TX=/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}-[a-f0-9]{12}$/;
const fail=s=>{throw Error(s)};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function expectedContext(x){
 if(!x||Object.keys(x).sort().join(',')!=='artifactSha256,descriptorSha256,manifestSha256,ownerSha256,transactionId'||!TX.test(x.transactionId)||!['artifactSha256','descriptorSha256','manifestSha256','ownerSha256'].every(k=>HEX.test(x[k])))fail('SSH_OWNER_CONTEXT_INVALID');
 return Object.freeze({...x});
}
export function validateOwnerSessionOptions(context,{timeoutMs,onUnknown}){
 const fixed=expectedContext(context);
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000||typeof onUnknown!=='function')fail('SSH_OWNER_CHANNEL_INVALID');
 return fixed;
}
function connect(child,context,{timeoutMs,onUnknown}){
 const fixed=validateOwnerSessionOptions(context,{timeoutMs,onUnknown});
 if(!child?.stdin||!child?.stdout||!child?.stderr||typeof child.on!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000||typeof onUnknown!=='function')fail('SSH_OWNER_CHANNEL_INVALID');
 let state='opening',seq=0,pending=null,buffer='',bad=false,batch=null,closeWait=null;
 function poison(){if(bad)return;bad=true;state='unknown';if(pending){const x=pending;pending=null;clearTimeout(x.timer);x.reject(Error('SSH_OWNER_UNKNOWN'));}if(closeWait){const x=closeWait;closeWait=null;clearTimeout(x.timer);x.reject(Error('SSH_OWNER_UNKNOWN'));}try{const x=onUnknown();if(x&&typeof x.then==='function')Promise.resolve(x).catch(()=>{});}catch{}}
 child.on('error',poison);child.stdin.on('error',poison);child.stdout.on('error',poison);child.stderr.on('error',poison);child.stderr.on('data',()=>{});
 const ended=()=>{if((state!=='closing'&&state!=='closed')||pending||buffer)poison();};
 child.stdout.on('end',ended);child.stdout.on('close',ended);
 child.on('close',(code,signal)=>{
  if(state==='closing'&&closeWait&&code===0&&signal===null&&!buffer){const x=closeWait;closeWait=null;clearTimeout(x.timer);state='closed';x.resolve();return;}
  if(state!=='closed')poison();
 });
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
  if(bad)return;buffer+=chunk;if(buffer.length>8192){poison();return;}
  const end=buffer.indexOf('\n');if(end<0)return;
  const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
  if(!pending||!line||buffer.length){poison();return;}
  const x=pending;pending=null;clearTimeout(x.timer);
  try{
   const value=JSON.parse(line),keys=['seq','transactionId','op','outcome','manifestSha256','ownerSha256','artifactSha256','descriptorSha256'];
   if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(',')||JSON.stringify(value)!==line||value.seq!==x.seq||value.transactionId!==fixed.transactionId||value.op!==x.op||value.outcome!==x.outcome||value.manifestSha256!==fixed.manifestSha256||value.ownerSha256!==fixed.ownerSha256||value.artifactSha256!==fixed.artifactSha256||value.descriptorSha256!==fixed.descriptorSha256)fail('SSH_OWNER_REPLY_INVALID');
   seq=x.seq;state=x.next;x.resolve();
  }catch{x.reject(Error('SSH_OWNER_UNKNOWN'));poison();}
 });
 function wait(frame,request){
  if(pending){poison();fail('SSH_OWNER_CONCURRENT');}
  if(bad||buffer.length||!child.stdin.writable){poison();fail('SSH_OWNER_UNAVAILABLE');}
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(poison,timeoutMs);pending={...frame,resolve,reject,timer};
   if(request){try{child.stdin.write(JSON.stringify(request)+'\n',e=>{if(e)poison();});}catch{poison();}}
  });
 }
 // The initial frame conveys context; it does not authenticate it. The remote
 // supervisor must verify its installed descriptor and artifact independently.
 const ready=wait({seq:0,op:'ready',outcome:'READY',next:'ready'},
  {seq:0,op:'initialize',...fixed});
 function fields(meta){if(!meta||Object.keys(meta).sort().join(',')!=='batchId,scriptSha256,wireSha256'||!UUID.test(meta.batchId)||!HEX.test(meta.scriptSha256)||!HEX.test(meta.wireSha256))fail('SSH_OWNER_BATCH_INVALID');return {batchId:meta.batchId,scriptSha256:meta.scriptSha256,wireSha256:meta.wireSha256};}
 async function step(expected,op,outcome,next,meta=null,result=''){
  if(state!==expected||bad)fail('SSH_OWNER_PHASE_INVALID');
  const q={seq:seq+1,transactionId:fixed.transactionId,op,batchId:meta?.batchId||'',scriptSha256:meta?.scriptSha256||'',wireSha256:meta?.wireSha256||'',result};
  await wait({seq:seq+1,op,outcome,next},q);
 }
 async function prepare(){await step('ready','prepare','HELD','held');}
 async function recordPrepared(meta){try{batch=fields(meta);await step('held','migration-prepared','PREPARED','prepared',batch);}catch(e){poison();throw e;}}
 async function recordDispatchIntent(meta){try{const v=fields(meta);if(!same(batch,v))fail('SSH_OWNER_BATCH_DRIFT');await step('prepared','migration-intent','INTENT_RECORDED','intent',v);}catch(e){poison();throw e;}}
 async function recordTransportOutcome(result,meta){
  try{
   const v=fields(meta);if(!same(batch,v))fail('SSH_OWNER_BATCH_DRIFT');
   const confirmed=result?.outcome==='COMMITTED'&&result.reason==='EXACT_RECEIPT'&&result.wireSubmitted===true;
   if(confirmed && ![`COMMIT_CONFIRMED_${v.batchId}\n`,`COMMIT_CONFIRMED_${v.batchId}\r\n`].includes(result.receiptText))fail('SSH_OWNER_RAW_RECEIPT_INVALID');
   await step('intent','migration-outcome',confirmed?'COMMITTED_RECORDED':'UNKNOWN_RECORDED',confirmed?'committed':'unknown',v,confirmed?result.receiptText:'UNKNOWN');
   if(!confirmed)poison();
  }catch(e){poison();throw e;}
 }
 async function preflight(){await step('committed','preflight','PREFLIGHT_OK','preflight');}
 async function activate(){await step('preflight','activate','ACTIVE_PERSISTED','active');}
 async function release(){await step('active','release','RELEASED','released');}
 // Child remains alive after release until the owner closes this pipe.
 async function close(){
  if(state!=='released'||bad||pending||buffer)fail('SSH_OWNER_CLOSE_UNSAFE');state='closing';
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(poison,timeoutMs);closeWait={resolve,reject,timer};
   try{child.stdin.end(error=>{if(error)poison();});}catch{poison();}
  });
 }
 return Object.freeze({ready,prepare,recordPrepared,recordDispatchIntent,recordTransportOutcome,preflight,activate,release,close,status:()=>state});
}

// This test constructor is impossible to call on the Linux target.
export function sessionForWindowsTest(child,context,options){if(process.platform!=='win32')fail('SSH_OWNER_WINDOWS_TEST_ONLY');return connect(child,context,options);}

// Transport only. Caller must supply a child spawned by the fixed owner
// launcher after authenticated provenance; no authorization is inferred here.
export function attachOwnerChild(child,context,options){return connect(child,context,options);}
