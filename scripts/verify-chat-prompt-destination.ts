import assert from 'node:assert/strict';
import {buildChatVideoPromptTransfer as video} from '../src/lib/chat-video-prompt-transfer';
import {buildUnboundChatStoryboardPromptDraft as manual} from '../src/lib/chat-storyboard-prompt-draft';
import {isChatPromptDeliveryMessageReady as ready} from '../src/lib/chat-prompt-delivery-state';
import {storyboardPromptVisibleText} from '../src/lib/storyboard-prompt-draft';
import {buildHomepageStoryboardDraftDetail,readStoryboardIntakeSnapshotForMessage} from '../src/lib/agent-workbench-handoff';
import {parseStoryboardCanvasImport} from '../src/lib/storyboard-canvas-bridge';
import {STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION, type StoryboardDirectorInput} from '../src/lib/storyboard-director-protocol';
import {buildDestinationFixture} from './lib/chat-prompt-destination-fixtures.mjs';
let checks=0; const failures:string[]=[];
const check=(name:string,run:()=>void)=>{try{run();checks++;console.log('PASS '+name);}catch{failures.push(name);console.log('FAIL '+name);}};
const fence=(text:string,language='text')=>'```'+language+'\n'+text+'\n```';
const message=(content:string)=>({id:'destination-current-message',role:'assistant' as const,content});
const explicit={storyboardPromptHandoff:{enabled:true,target:'storyboard-workbench'}};
for(const reference of [false,true])check(`actual homepage and canvas ${reference?'reference':'ordinary'} fixture`,()=>{
 const fixture=buildDestinationFixture({reference});
 const messages=[{id:'original-card',role:'user',content:fixture.cardText},message(fixture.replyText)];
 const intake=readStoryboardIntakeSnapshotForMessage(messages,'destination-current-message');assert.ok(intake);assert.deepEqual(intake.missingFields,[]);assert.deepEqual(intake.input,fixture.input);
 const detail=buildHomepageStoryboardDraftDetail(message(fixture.replyText),fixture.input as StoryboardDirectorInput);assert.ok(detail);
 const plan=parseStoryboardCanvasImport(detail);assert.ok(plan);assert.equal(plan.segments.length,12);assert.equal(plan.originalInput.aspect_ratio,'16:9');assert.equal(plan.originalInput.target_duration_seconds,10);assert.equal(plan.originalInput.animation_style,fixture.input.animation_style);
 assert.deepEqual(plan.segments.map(x=>x.narration),fixture.narrations);assert.deepEqual(plan.segments.map(x=>x.imagePrompt),fixture.imagePrompts);assert.deepEqual(plan.segments.map(x=>x.videoPrompt),fixture.videoPrompts);
 assert.equal(plan.visualAssetPlan?.assets.length,reference?2:0);if(reference){assert.deepEqual(plan.visualAssetPlan?.assets.map(x=>x.role),['character','pet']);assert.deepEqual(plan.visualAssetPlan?.assets.map(x=>x.name),['女主人','小狗']);assert.equal(plan.visualAssetPlan?.assets[0].referencePrompts[0].prompt.includes('女主人三视图'),true);}
 const transferred=video(fixture.replyText);assert.ok(transferred);assert.equal(transferred.items.length,12);assert.deepEqual(transferred.items.map(x=>x.prompt),fixture.videoPrompts);
});
check('video transfer belongs only to current reply and keeps literal words and blank lines',()=>{
 const current='镜头轻推。\n\n复制/发送是正文，不能删。\n\n第二动作。';const reply='### 生图 Prompt\n'+fence('图片不推送')+'\n\n### 图生视频 Prompt\n'+fence(current);
 assert.deepEqual(video(reply)?.items.map(x=>x.prompt),[current]);assert.equal(video('### 生图 Prompt\n'+fence('只有图片')),null);
});
check('second eligible code preserves actual original order',()=>{
 const reply='### 生图 Prompt\n'+fence('图')+'\n### 图生视频 Prompt\n'+fence('摄影机第一个视频')+'\n### 图生视频 Prompt\n'+fence('摄影机第二个视频');
 assert.deepEqual(video(reply,2)?.items.map(x=>({order:x.order,prompt:x.prompt})),[{order:2,prompt:'摄影机第二个视频'}]);assert.equal(video(reply,0),null);assert.equal(video(reply,3),null);assert.equal(video(reply,-1),null);
});
check('40 cards accepted and 41 rejected without clamping',()=>{assert.equal(video(buildDestinationFixture({segments:40}).replyText)?.items.length,40);assert.throws(()=>video(buildDestinationFixture({segments:41}).replyText),/40/u);assert.throws(()=>video(buildDestinationFixture({segments:41}).replyText,81),/40/u);});
check('unknown code language never becomes video',()=>{assert.equal(video('### 视频 Prompt\n'+fence('镜头移动','python')),null);});
check('image-only body never becomes video',()=>{assert.equal(video('![图片](https://fixture.invalid/image.png)'),null);});
check('unclassified ordinary code never becomes video',()=>{assert.equal(video(fence('ordinary content')),null);});
check('explicit ordinary agent manual draft reaches actual bridge',()=>{const fixture=buildDestinationFixture({segments:2});const detail=manual('synthetic-ordinary-agent',explicit,message(fixture.replyText));assert.ok(detail);const plan=parseStoryboardCanvasImport(detail);assert.ok(plan);assert.equal(plan.intakeVerified,false);assert.equal(plan.executionMode,'ordinary');assert.equal(plan.segments.length,2);});
check('manual refuses official, implicit legacy, missing explicit, intake and any protected contract',()=>{
 const reply=buildDestinationFixture({segments:2}).replyText;
 for(const id of ['agent-1786843330392-emdjv2','agent-1786633444187-594spj'])assert.equal(manual(id,explicit,message(reply)),null);
 for(const style of [{},undefined,{storyboardPromptHandoff:{enabled:true}},{storyboardPromptHandoff:{target:'video'}},{storyboardPromptHandoff:{target:'unknown'}}])assert.equal(manual('agent-1793171231055-r9qzu6',style,message(reply)),null);
 assert.equal(manual('synthetic-ordinary-agent',explicit,message(reply),true),null);
 for(const key of ['production_contract_version','production_contract_activated_at','performance_contract','performance_contract_activated_at'])for(const value of [undefined,null,false,'invalid'])assert.equal(manual('synthetic-ordinary-agent',{...explicit,[key]:value},message(reply)),null);
 assert.equal(manual('synthetic-ordinary-agent',explicit,message(buildDestinationFixture({reference:true}).replyText)),null);
});
check('bridge forbids manual expected intake, production contract and performance bypass',()=>{const fixture=buildDestinationFixture({segments:2});const detail=manual('synthetic-ordinary-agent',explicit,message(fixture.replyText));assert.ok(detail);assert.equal(parseStoryboardCanvasImport(detail,{expectedInput:fixture.input as StoryboardDirectorInput}),null);assert.equal(parseStoryboardCanvasImport(detail,{requiredContractVersion:STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION}),null);assert.equal(parseStoryboardCanvasImport(detail,{requirePerformancePlan:true}),null);});
check('nested video fence retains logical literal body',()=>{assert.equal(video('> ### 图生视频 Prompt\n> ```text\n> 镜头移动，复制/发送保留。\n>\n> 第二行。\n> ```')?.items[0].prompt,'镜头移动，复制/发送保留。\n\n第二行。');});
check('CRLF video fences preserve original EOL bytes and accept normalized visible DOM',()=>{const text='### 图生视频 Prompt\r\n```text\r\n镜头移动，复制/发送。\r\n\r\n第二动作。\r\n```';const original='镜头移动，复制/发送。\r\n\r\n第二动作。';assert.equal(video(text)?.items[0].prompt,original);assert.equal(video(text,0,'镜头移动，复制/发送。\n\n第二动作。\n')?.items[0].prompt,original);});
check('selected index uses original fence position including unknown code',()=>{const text=fence('not-video','python')+'\n### 视频 Prompt\n'+fence('镜头一')+'\n### 视频 Prompt\n'+fence('镜头二');assert.equal(video(text,0),null);assert.deepEqual(video(text,2)?.items.map(x=>[x.order,x.prompt]),[[2,'镜头二']]);});
check('any unclosed fence rejects entire video transfer',()=>{for(const text of ['### 视频 Prompt\n```text\n镜头一', '### 视频 Prompt\n'+fence('镜头一')+'\n```python\nunknown', '### 视频 Prompt\n~~~text\n镜头一'])assert.equal(video(text),null);});
check('delivery state rejects unknown failure markers and all interrupted statuses',()=>{assert.equal(ready(message('完整回复')),true);for(const patch of [{role:'user'},{isStreaming:true},{error:'failed'},{content:' '}])assert.equal(ready({...message('完整回复'),...patch}),false);for(const status of ['error','failed','aborted','result_unknown','stopped','已停止','已终止','失败','中断'])assert.equal(ready({...message('完整回复'),streamStatus:status}),false);for(const marker of ['最终结果暂未确认','结果不明','禁止重复提交','避免重复发送','RECONCILIATION_REQUIRED','RESULT_UNKNOWN','[已终止]','[已停止接收；等待]','输出中断','网络中断','连接中断','发送失败：未送达']){assert.equal(ready(message(marker)),false);assert.equal(video('### 视频 Prompt\n'+fence('摄影机移动')+'\n'+marker),null);}assert.equal(ready(undefined),false);});
check('hidden machine fence cannot shift second visible code to wrong prompt',()=>{const text=fence('{"schema_version":"storyboard_director_output.v1","artifact_type":"storyboard_director_package"}','json')+'\n### 生图 Prompt\n'+fence('图片')+'\n### 视频 Prompt\n'+fence('镜头一')+'\n### 视频 Prompt\n'+fence('镜头二');assert.doesNotMatch(storyboardPromptVisibleText(text), /storyboard_director_output/u);assert.deepEqual(video(text,1,'镜头一\n')?.items.map(x=>[x.order,x.prompt]),[[1,'镜头一']]);assert.deepEqual(video(text,2,'镜头二\n')?.items.map(x=>[x.order,x.prompt]),[[2,'镜头二']]);assert.equal(video(text,1,'not present'),null);});
check('duplicate clicked literals reject ambiguity',()=>{const text='### 视频 Prompt\n'+fence('相同镜头')+'\n### 视频 Prompt\n'+fence('相同镜头');assert.equal(video(text,0,'相同镜头\n'),null);});
console.log(JSON.stringify({passed:failures.length===0,checks,failures,fixtureOnly:true,providerCalls:0,businessWrites:0}));assert.equal(failures.length,0,'ALL_DESTINATION_CONTRACTS_REQUIRED');
