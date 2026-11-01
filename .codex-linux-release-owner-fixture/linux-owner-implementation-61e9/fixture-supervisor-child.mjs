import {attachLinuxSupervisor} from './supervisor-channel.mjs';
const output=process.stdout;
const engine={prepare:async()=> 'HELD',recordPrepared:async()=> 'PREPARED',recordIntent:async()=> 'INTENT_RECORDED',recordOutcome:async(_b,r)=>r==='UNKNOWN'?'UNKNOWN_RECORDED':'COMMITTED_RECORDED',preflight:async()=> 'PREFLIGHT_OK',activate:async()=> 'ACTIVE_PERSISTED',release:async()=> 'RELEASED',poison:()=>{process.exitCode=1;process.stdin.destroy();}};
const expected={transactionId:'transaction-test-0123456789ab',artifactSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),ownerSha256:'c'.repeat(64)};
attachLinuxSupervisor({input:process.stdin,output,verifyAndOpen:async()=>({identity:expected,engine})});
