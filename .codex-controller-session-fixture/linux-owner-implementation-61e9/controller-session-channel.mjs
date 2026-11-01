// Private controller session transport for one already-owned controller child.
// The installed owner must authenticate child, bundle, descriptor and provider.
const fail=x=>{throw Error(x)};
export function attachControllerSession({engine,input,output,child}){
 if(!engine||!['preflight','claimControllerHook','controllerPhase','controllerExited','poison'].every(k=>typeof engine[k]==='function')||!input||!output||!child)fail('CONTROLLER_INPUT_INVALID');
 const stages=['preflight-ok','prepare','activated','precommit','persisted'];let seq=0,busy=false,invalid=false,epoch=0,ended=false,exitOk=false,done=false,finishing=false,timer,buffer=Buffer.alloc(0),resolve,reject;
 const completed=new Promise((a,b)=>{resolve=a;reject=b});
 const poison=()=>{if(invalid||done)return;invalid=true;clearTimeout(timer);epoch++;try{engine.poison()}catch{}try{input.destroy()}catch{}try{output.destroy()}catch{}reject(Error('CONTROLLER_OUTCOME_UNKNOWN'));};
 const arm=()=>{clearTimeout(timer);timer=setTimeout(poison,120000);timer.unref?.();};
 const guard=()=>{if(invalid||done||input.destroyed||output.destroyed||child.signalCode!==null||child.exitCode!==null)fail('CONTROLLER_CHANNEL_LOST');};
 async function receive(v){
  const token=epoch;guard();
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).join(',')!=='phase,seq'||v.seq!==seq+1||v.phase!==stages[seq])fail('CONTROLLER_FRAME_INVALID');
  if(v.phase==='preflight-ok'){await engine.preflight();guard();if(epoch!==token)fail('CONTROLLER_CHANNEL_LOST');await engine.claimControllerHook();}
  else await engine.controllerPhase(v.phase);
  guard();if(epoch!==token)fail('CONTROLLER_CHANNEL_LOST');seq=v.seq;
  const type=v.phase==='preflight-ok'?'resume':'ok';if(!output.write(JSON.stringify({type,seq,phase:v.phase})+'\n'))fail('CONTROLLER_WRITE_UNKNOWN');guard();arm();
 }
 async function finish(){if(invalid||done||finishing||busy||!ended||!exitOk)return;finishing=true;const token=epoch;try{await engine.controllerExited();if(invalid||epoch!==token)fail('CONTROLLER_CHANNEL_LOST');done=true;clearTimeout(timer);resolve('ACTIVE_PERSISTED');}catch{poison();}finally{finishing=false;}}
 input.on('data',chunk=>{
  if(invalid||done)return;if(busy||!Buffer.isBuffer(chunk)){poison();return;}
  buffer=Buffer.concat([buffer,chunk]);if(buffer.length>8192){poison();return;}const i=buffer.indexOf(10);if(i<0)return;
  if(i===0||i!==buffer.length-1){poison();return;}
  let v;try{const line=new TextDecoder('utf8',{fatal:true}).decode(buffer.subarray(0,i));v=JSON.parse(line);if(JSON.stringify(v)!==line)throw Error('bad');}catch{poison();return;}
  buffer=Buffer.alloc(0);busy=true;receive(v).then(()=>{busy=false;void finish();},poison);
 });
 input.on('end',()=>{if(invalid||done)return;if(busy||buffer.length||seq!==stages.length){poison();return;}ended=true;void finish();});
 input.on('error',poison);input.on('close',()=>{if(!ended)poison();});output.on('error',poison);output.on('close',()=>{if(seq!==stages.length)poison();});child.on('error',poison);
 child.on('exit',(code,signal)=>{if(invalid||done)return;if(code!==0||signal!==null||seq!==stages.length){poison();return;}exitOk=true;void finish();});
 if(!output.write('{"type":"ready"}\n'))poison();else arm();
 return Object.freeze({completed,status:()=>invalid?'unknown':done?'complete':'active',closeUnknown:poison});
}
export function openProductionControllerSession(){fail('CONTROLLER_AUTHENTICATED_OWNER_NOT_CONNECTED');}
