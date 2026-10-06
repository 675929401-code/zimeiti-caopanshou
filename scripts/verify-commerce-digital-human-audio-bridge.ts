import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

import {selectDigitalHumanAudioCandidates,COMMERCE_DIGITAL_HUMAN_AUDIO_BRIDGE_VERSION as SERVER_VERSION,type CommerceDigitalHumanAudioCandidate} from '../src/commerce/server/digital-human-audio-candidates';
import {commerceAudioUploadRequestId,transferCommerceAudioToDigitalHuman,COMMERCE_DIGITAL_HUMAN_AUDIO_BRIDGE_VERSION as CLIENT_VERSION,type CommerceAudioCandidate} from '../src/features/digital-human/commerce-audio-bridge';
import type {Asset} from '../src/commerce/server/assets';
import type {CommerceVoiceJob} from '../src/commerce/server/voice-jobs';

async function main(){
let checks=0;
const ok=(value:unknown,message:string)=>{assert.ok(value,message);checks+=1;};
const equal=(actual:unknown,expected:unknown,message:string)=>{assert.equal(actual,expected,message);checks+=1;};
const read=(path:string)=>readFileSync(path,'utf8');
const owner='owner-a',now=1_700_000_000_000;
const asset=(id:string,patch:Partial<Asset>={}):Asset=>({id,owner,name:`audio-${id.slice(0,4)}.mp3`,type:'audio/mpeg',size:128,sha256:'a'.repeat(64),createdAt:now,source:'upload',...patch});
const voiceJob=(id:string,assetId:string,status:CommerceVoiceJob['status']='succeeded'):CommerceVoiceJob=>({
 schema:'commerce-voice-job/v1',id,owner,quoteId:'quote',quoteFingerprint:'fingerprint',clientRequestId:'request-12345678',input:{} as CommerceVoiceJob['input'],status,billingState:'revenue_recorded',mainUserId:'main-a',mainRole:'student',chargeKey:'charge',refundKey:'refund',payableTotal:1,costAmount:0.5,assetId,createdAt:now,updatedAt:now,events:[],
});
const ids={uploaded:'11111111-1111-4111-8111-111111111111',generated:'22222222-2222-4222-8222-222222222222',pending:'33333333-3333-4333-8333-333333333333',foreign:'44444444-4444-4444-8444-444444444444',ogg:'55555555-5555-4555-8555-555555555555'};
const candidates=selectDigitalHumanAudioCandidates(owner,[
 asset(ids.uploaded),
 asset(ids.generated,{source:'generated',jobId:'voice-success'}),
 asset(ids.pending,{source:'generated',jobId:'voice-pending'}),
 asset(ids.foreign,{owner:'owner-b'}),
 asset(ids.ogg,{type:'audio/ogg'}),
],[
 voiceJob('voice-success',ids.generated),
 voiceJob('voice-pending',ids.pending,'running'),
]);
equal(SERVER_VERSION,CLIENT_VERSION,'client and server bridge versions must match');
equal(SERVER_VERSION,'commerce-digital-human-audio-bridge/v1','bridge version must remain stable');
equal(candidates.length,2,'only completed compatible owner audio may be listed');
ok(candidates.some(item=>item.id===ids.uploaded&&item.completionEvidence==='persisted-upload'),'owned upload must be selectable');
ok(candidates.some(item=>item.id===ids.generated&&item.completionEvidence==='voice-job-succeeded'),'succeeded voice asset must be selectable');
ok(!candidates.some(item=>item.id===ids.pending),'running voice job must remain hidden');
ok(!candidates.some(item=>item.id===ids.foreign),'foreign owner asset must remain hidden');
ok(!candidates.some(item=>item.id===ids.ogg),'unsupported digital-human audio MIME must remain hidden');

const bytes=Buffer.from('RIFF....WAVEfmt bridge-audio-fixture');
const sha=createHash('sha256').update(bytes).digest('hex');
const candidate:CommerceAudioCandidate={...(candidates[0] as CommerceDigitalHumanAudioCandidate),id:ids.uploaded,name:'带货配音.wav',type:'audio/wav',size:bytes.length,sha256:sha,url:'/api/commerce/assets/'+ids.uploaded};
const humanAsset={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',category:'audio' as const,url:'/owned/audio',duration:8.5,width:0,height:0,size:bytes.length};
const calls:Array<{url:string;method:string;authorization:string}> = [];
const directFetch=async(input:RequestInfo|URL,init:RequestInit={}):Promise<Response>=>{
 const url=String(input),method=String(init.method||'GET'),headers=new Headers(init.headers);calls.push({url,method,authorization:headers.get('authorization')||''});
 if(url===candidate.url)return new Response(bytes,{status:200,headers:{'Content-Type':'audio/wav'}});
 if(url==='/api/digital-human/upload-ticket')return Response.json({mode:'direct',ticketId:'ticket-a',upload:{url:'https://signed.invalid/put',headers:{'Content-Type':'audio/wav'}},completeUrl:'/api/digital-human/upload-session'});
 if(url==='https://signed.invalid/put')return new Response(null,{status:200});
 if(url==='/api/digital-human/upload-session')return Response.json({asset:humanAsset});
 return new Response(null,{status:500});
};
const transferred=await transferCommerceAudioToDigitalHuman(candidate,'main-token',{fetcher:directFetch});
equal(transferred.id,humanAsset.id,'direct bridge must return the main-site owned HumanAsset');
equal(calls.map(call=>`${call.method} ${call.url}`).join('|'),`GET ${candidate.url}|POST /api/digital-human/upload-ticket|PUT https://signed.invalid/put|POST /api/digital-human/upload-session`,'direct transfer must use the existing safe upload state machine');
equal(calls[0].authorization,'','Commerce source read must rely on the owner-scoped same-origin session');
equal(calls[1].authorization,'Bearer main-token','main upload ticket must use the current main-site identity');
equal(calls[2].authorization,'','signed object PUT must not receive the main bearer token');
equal(calls[3].authorization,'Bearer main-token','upload completion must use the current main-site identity');
ok(calls.every(call=>!/(?:generate|billing|cash|voice\/tts)/u.test(call.url)),'bridge must not call generation or billing endpoints');
equal(commerceAudioUploadRequestId(candidate),commerceAudioUploadRequestId(candidate),'upload identity must be deterministic for owner replay protection');

let completionAttempts=0,observedRetryDelay=0;
const retried=await transferCommerceAudioToDigitalHuman(candidate,'main-token',{fetcher:async input=>{
 const url=String(input);
 if(url===candidate.url)return new Response(bytes,{status:200});
 if(url==='/api/digital-human/upload-ticket')return Response.json({mode:'direct',ticketId:'ticket-retry',upload:{url:'https://signed.invalid/retry',headers:{'Content-Type':'audio/wav'}},completeUrl:'/api/digital-human/upload-session'});
 if(url==='https://signed.invalid/retry')return new Response(null,{status:200});
 if(url==='/api/digital-human/upload-session'){
  completionAttempts+=1;
  return completionAttempts===1
   ?Response.json({code:'UPLOAD_NOT_VISIBLE',error:'not visible yet'},{status:503,headers:{'Retry-After':'1'}})
   :Response.json({asset:humanAsset});
 }
 return new Response(null,{status:500});
},waiter:async milliseconds=>{observedRetryDelay=milliseconds;}});
equal(retried.id,humanAsset.id,'eventually visible direct upload must complete without another byte transfer');
equal(completionAttempts,2,'direct completion must retry the same ticket after an eventual-consistency response');
equal(observedRetryDelay,1000,'direct completion must honor the bounded Retry-After delay');

let replayCalls=0;
const replayed=await transferCommerceAudioToDigitalHuman(candidate,'main-token',{fetcher:async(input,init)=>{
 replayCalls+=1;const url=String(input);
 if(url===candidate.url)return new Response(bytes,{status:200});
 if(url==='/api/digital-human/upload-ticket')return Response.json({mode:'completed',asset:humanAsset});
 throw Error(`unexpected replay call ${String(init?.method||'GET')} ${url}`);
}});
equal(replayed.id,humanAsset.id,'completed upload ticket must read back the existing main asset');
equal(replayCalls,2,'idempotent replay must not upload bytes again');

await assert.rejects(()=>transferCommerceAudioToDigitalHuman({...candidate,sha256:'0'.repeat(64)},'main-token',{fetcher:async()=>new Response(bytes,{status:200})}),/内容与资产记录不一致/u);
checks+=1;

const route=read('src/app/api/commerce/digital-human-audio-assets/route.ts');
const component=read('src/features/digital-human/CommerceAudioAssetPicker.tsx');
const bridge=read('src/features/digital-human/commerce-audio-bridge.ts');
const page=read('src/app/digital-human/page.tsx');
ok(/requireIdentity\(request\)/u.test(route),'candidate API must require the Commerce owner session');
ok(/authorizeCurrentCommerceIdentity\(identity\)/u.test(route),'candidate API must revalidate the pinned main account binding');
ok(/private, no-store/u.test(route),'candidate API must forbid shared or browser caching');
ok(/digital-human-audio-assets/u.test(component),'picker must read the owner-scoped candidate API');
ok(/transferCommerceAudioToDigitalHuman/u.test(component),'picker must use the audited transfer helper');
ok(/sha256\(sourceBytes\)/u.test(bridge)&&/sourceBytes\.byteLength!==candidate\.size/u.test(bridge),'bridge must verify source bytes against immutable size and SHA-256');
ok(/upload-ticket/u.test(bridge)&&/upload-session/u.test(bridge),'bridge must reuse the main digital-human upload state machine');
ok(!/api\/digital-human\/(?:generate|long-generate)/u.test(bridge),'bridge must never submit a digital-human generation');
ok(!/api\/(?:cash|voice\/tts|commerce\/voice-synthesis)/u.test(bridge),'bridge must never charge or synthesize audio');
ok(/import \{ CommerceAudioAssetPicker \} from '@\/features\/digital-human\/CommerceAudioAssetPicker'/u.test(page),'shared digital-human page must import the Commerce picker');
ok(/backHref\s*===\s*['"]\/commerce['"]\s*&&\s*<CommerceAudioAssetPicker/u.test(page),'Commerce picker must render only inside the Commerce route context');
ok(/if \(locked\.current \|\| pending \|\| commerceAudioPending/u.test(page),'submit handler must reject while Commerce audio transfer is pending');
ok(/className=\{styles\.generateButton\}[^>]+disabled=\{[^}]*commerceAudioPending/u.test(page),'generate button must remain disabled while Commerce audio transfer is pending');

console.log(JSON.stringify({passed:true,checks,version:SERVER_VERSION,providerCalls:0,walletWrites:0,videoSubmissions:0,realGeneration:false}));
}

main().catch(error=>{console.error(error);process.exitCode=1;});
