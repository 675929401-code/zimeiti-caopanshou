import assert from 'node:assert/strict';import path from 'node:path';import {fileURLToPath} from 'node:url';import {startPrivateWorkerJournal} from './owner-node.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)),python='/usr/bin/python3',entry=path.join(dir,'child.py'),dep=path.join(dir,'owner-child.py'),hash='a'.repeat(64),events=[];let unknown=false;
const owner={assert_live:async()=>{},assert_bound:async()=>{},verify_file:async()=>{},checkpoint:async(p,d)=>events.push([p,d]),mark_unknown:async()=>{unknown=true;}};
const channel=await startPrivateWorkerJournal({owner,python,entry,transactionId:'fixture-session-0123456789ab',allowedFiles:[{path:python,sha256:hash},{path:entry,sha256:hash},{path:dep,sha256:hash}]});
const end=Date.now()+3000;while(events.length===0&&channel.status()==='active'&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
try{assert.deepEqual(events,[['worker-watch-created',{synthetic:true}]]);assert.equal(channel.status(),'active');}finally{channel.closeUnknown()}
await new Promise(r=>setTimeout(r,50));assert.equal(unknown,true);console.log('PASS: real Node/Python private FD, peer identity, journal callback and disconnect');
