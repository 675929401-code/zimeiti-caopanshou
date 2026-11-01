// Bridges ordered remote owner stages to one controller process. The supplied
// launcher must be made by the installed authenticated owner; the production
// factory remains closed. No caller JSON authorizes controller execution.
import {attachControllerSession} from './controller-session-channel.mjs';
const fail=x=>{throw Error(x)};
export function createControllerStageFacade({engine,launchOwnedController}){
 if(!engine||!['prepare','recordPrepared','recordIntent','recordOutcome','preflight','claimControllerHook','controllerPhase','controllerExited','release','poison'].every(k=>typeof engine[k]==='function')||typeof launchOwnedController!=='function')fail('CONTROLLER_FACADE_INVALID');
 let stage='initial',channel=null,openActivation,failed=false;
 const gate=new Promise(resolve=>{openActivation=resolve});
 const poison=()=>{if(failed)return;failed=true;try{channel?.closeUnknown()}catch{}try{engine.poison()}catch{}};
 async function preflight(){
  if(stage!=='initial'||failed)fail('CONTROLLER_FACADE_PHASE');stage='opening';
  try{const child=await launchOwnedController();if(failed||!child?.stdio?.[3]||!child?.stdio?.[4])fail('CONTROLLER_LAUNCH_INVALID');
   channel=attachControllerSession({engine,child,input:child.stdio[4],output:child.stdio[3],activationGate:gate});
   await channel.claimed;if(failed||channel.status()!=='active')fail('CONTROLLER_FACADE_UNKNOWN');stage='claimed';return 'PREFLIGHT_OK';
  }catch{poison();fail('CONTROLLER_FACADE_UNKNOWN');}
 }
 async function activate(){
  if(stage!=='claimed'||failed)fail('CONTROLLER_FACADE_PHASE');stage='activating';openActivation();
  try{const result=await channel.completed;if(failed||result!=='ACTIVE_PERSISTED')fail('CONTROLLER_FACADE_UNKNOWN');stage='active';return result;}catch{poison();fail('CONTROLLER_FACADE_UNKNOWN');}
 }
 async function release(){if(stage!=='active'||failed)fail('CONTROLLER_FACADE_PHASE');stage='releasing';try{const value=await engine.release();if(failed||stage!=='releasing')fail('CONTROLLER_FACADE_UNKNOWN');stage='released';return value;}catch{poison();fail('CONTROLLER_FACADE_UNKNOWN');}}
 return Object.freeze({prepare:()=>engine.prepare(),recordPrepared:x=>engine.recordPrepared(x),recordIntent:x=>engine.recordIntent(x),recordOutcome:(x,y)=>engine.recordOutcome(x,y),preflight,activate,release,poison});
}
export function openProductionControllerFacade(){fail('CONTROLLER_AUTHENTICATED_LAUNCHER_NOT_CONNECTED');}
