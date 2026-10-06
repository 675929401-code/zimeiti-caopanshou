import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolveAgentLookup} from '../src/lib/agent-lookup-policy';
async function main(){
 let calls=0;
 const active: {id:string;is_active:boolean;deleted_at?:string|null}={id:'same-id',is_active:true};
 const fallback=async()=>{calls++;return active;};
 assert.equal(await resolveAgentLookup(active,fallback,true),active);
 assert.equal(await resolveAgentLookup({...active,deleted_at:'2026-09-21T00:00:00Z'},fallback,true),null);
 assert.equal(await resolveAgentLookup(null,fallback,false),null);
 assert.equal(calls,0,'Existing/deleted/local-missing agents never fetch another source');
 assert.equal(await resolveAgentLookup(null,fallback,true),active);assert.equal(calls,1);
 assert.equal(await resolveAgentLookup(null,async()=>({...active,deleted_at:'deleted'}),true),null);
 assert.equal(await resolveAgentLookup(null,async()=>null,true),null);
 const inactive={...active,is_active:false};assert.equal(await resolveAgentLookup(inactive,fallback,true),inactive);
 assert.equal(calls,1,'Inactive local configuration is not replaced by an active remote agent');
 const report={passed:true,cases:7,networkRequests:0,deletedAgentNeverResurrected:true,localAcceptanceNeverFallsBack:true};
 fs.writeFileSync('.codex-evidence/bip-taxonomy-20260921/lookup-policy.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
