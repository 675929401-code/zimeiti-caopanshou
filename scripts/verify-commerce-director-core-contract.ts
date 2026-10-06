import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

function pcmWav(seconds:number){
  const sampleRate=8000,samples=Math.floor(sampleRate*seconds),bytes=Buffer.alloc(44+samples*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(sampleRate,24);bytes.writeUInt32LE(sampleRate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);return bytes;
}

async function main(){
  const fixture=path.resolve('.codex-evidence/commerce-director-core-'+Date.now());
  process.env.COMMERCE_DATA_DIR=fixture;
  process.env.SHARED_CONFIGURATION_ENABLED='0';
  await fs.mkdir(fixture,{recursive:true});
  const store=await import('../src/commerce/server/store');
  const catalog=await import('../src/commerce/server/director-catalog');
  const directorSchema=await import('../src/commerce/server/director-conversation-schema');
  const output=await import('../src/commerce/server/director-output');
  const directorPrompts=await import('../src/commerce/server/director-prompts');
  const director=await import('../src/commerce/server/director-conversation');
  const claims=await import('../src/commerce/server/director-turn-claim');
  const routing=await import('../src/commerce/server/operation-routing');
  const quotes=await import('../src/commerce/server/quotes');
  const jobs=await import('../src/commerce/server/jobs');
  const owner='director-contract-owner';
  const agentModel={id:'3a998bfc-aab4-4f8f-9128-b27498894a7b',modelName:'claude-sonnet-4-6',displayName:'Claude Sonnet 4.6 合同夹具',kind:'agent' as const,source:'main' as const,enabled:true,publicPrice:1.5,costPrice:1,billingUnit:'per_use' as const,configHash:'a'.repeat(64),protocol:'openai-chat',endpoint:'https://example.invalid',capabilities:{available:true,executionSupported:true,credentialsConfigured:true,endpointConfigured:true,protocolConfigured:true,imageParsing:true}};
  const videoModel={id:'director-video-fixture',displayName:'可选视频能力',kind:'video' as const,source:'custom' as const,enabled:true,publicPrice:0.2,costPrice:0.1,billingUnit:'output_second' as const,configHash:'d'.repeat(64),protocol:'video-task',endpoint:'https://example.invalid',capabilities:{available:true,executionSupported:true,nativeDurations:[15],aspectRatios:['9:16'],resolutionOptions:['720p'],maxReferenceImages:9,maxReferenceAudios:1,supportsAudioInput:true,supportsGenerateAudioToggle:true}};
  store.put('settings','main-model-source','system',{enabled:false});
  store.put('settings','defaults','system',{agent:agentModel.id,video:videoModel.id});
  store.put('models',agentModel.id,'system',agentModel);
  store.put('models',videoModel.id,'system',videoModel);
  const imageId='11111111-1111-4111-8111-111111111111',audioId='22222222-2222-4222-8222-222222222222',longAudioId='22222222-2222-4222-8222-222222222223';
  const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const audioBytes=pcmWav(2),longAudioBytes=pcmWav(16);
  store.put('assets',imageId,owner,{id:imageId,owner,name:'统一商品参考.png',type:'image/png',size:imageBytes.length,sha256:createHash('sha256').update(imageBytes).digest('hex'),createdAt:Date.now(),source:'upload',providerReferenceUrl:'https://example.invalid/commerce-director-product.png'});
  store.put('assets',audioId,owner,{id:audioId,owner,name:'参考声音.wav',type:'audio/wav',size:audioBytes.length,sha256:createHash('sha256').update(audioBytes).digest('hex'),createdAt:Date.now(),source:'upload',providerReferenceUrl:'https://example.invalid/commerce-director-voice.wav'});
  store.put('assets',longAudioId,owner,{id:longAudioId,owner,name:'过长声音.wav',type:'audio/wav',size:longAudioBytes.length,sha256:createHash('sha256').update(longAudioBytes).digest('hex'),createdAt:Date.now(),source:'upload',providerReferenceUrl:'https://example.invalid/commerce-director-long-voice.wav'});
  await fs.mkdir(path.join(fixture,'assets'),{recursive:true});
  await fs.writeFile(path.join(fixture,'assets',imageId),imageBytes);
  await fs.writeFile(path.join(fixture,'assets',audioId),audioBytes);
  await fs.writeFile(path.join(fixture,'assets',longAudioId),longAudioBytes);

  const cards=catalog.baselineDirectorCatalog();
  assert.equal(cards.length,19);
  assert.equal(new Set(cards.map(card=>card.key)).size,19);
  assert.equal(cards.filter(card=>card.default).length,1);
  assert.ok(cards.every(card=>card.slots.length>0&&new Set(card.slots.map(slot=>slot.key)).size===card.slots.length));
  assert.ok(cards.every(card=>card.slots.every(slot=>Number.isInteger(slot.min)&&Number.isInteger(slot.max)&&slot.min>=0&&slot.max>=slot.min&&slot.max<=directorSchema.DIRECTOR_REFERENCE_LIMIT&&slot.kinds.length>0)));
  assert.ok(cards.every(card=>card.slots.reduce((sum,slot)=>sum+slot.max,0)<=directorSchema.DIRECTOR_REFERENCE_LIMIT));
  for(const card of cards)for(const slot of card.slots)if(slot.label.trim()==='声音')assert.deepEqual(slot.kinds,['audio'],`${card.key} 的声音槽必须只接收音频`);
  const templates=directorPrompts.directorTemplates('共同事实规则。');
  assert.equal(templates.length,19);
  assert.equal(new Set(templates.map(template=>template.id)).size,19);
  assert.ok(templates.every(template=>template.version===8&&template.content.includes('director-script/v2')&&template.content.includes('本编导skillKey为 ')&&template.content.includes('【common:platform-facts】')&&template.content.includes('【category:commerce-video-director】')&&template.content.includes('【skill:')&&template.content.includes('【runtime:director-script-v2】')));

  const settings={skillKey:'ecommerce-spoken-selling',selections:{},spokenLanguage:'中文',durationSeconds:15,generateAudio:true};
  const selectedDirectorCard=cards.find(card=>card.key===settings.skillKey);
  assert.ok(selectedDirectorCard);
  const requiredImageSlot=selectedDirectorCard.slots.find(slot=>slot.min>0&&slot.kinds.includes('image'));
  assert.ok(requiredImageSlot);
  const references=[{id:imageId,slot:'reference_1',instanceId:'product-instance',name:'统一商品参考.png',type:'image/png'}];
  const reply={
    schema:'director-script/v2',replyType:'script',skillKey:settings.skillKey,durationSeconds:15,spokenLanguage:'中文',generateAudio:true,questions:[],
    script:{title:'可信商品口播',creativeDirection:'围绕可见包装和真实使用动作建立信任。',factLedger:[{fact:'商品外观来自参考1',source:'reference',evidence:'参考1可见包装与配色'}],story:'人物拿起同一商品，演示使用动作并给出适用人群建议。',setting:'室内自然光，人物、商品、光线方向和空间位置连续。',characters:[{id:'人物A',identity:'体验者',appearance:'成年女性，面部特征沿用参考设定',wardrobe:'浅色上衣，全片不变',relationships:'独立口播，无其他人物',continuity:'右手持商品，镜头间保持朝向'}],materials:[{referenceNumber:1,observation:'可见一件有固定包装和配色的商品',inherit:['商品包装、配色、结构与可辨文字'],exclude:['白底背景、静态摆拍光影']}],productContinuity:['包装结构、文字、配色、比例和使用状态跨镜一致'],shots:[{id:'镜头1｜痛点截停',start:0,end:5,visual:'人物右手拿起参考1商品并正面展示包装。',camera:'中近景固定机位，轻推至商品特写。',referenceNumbers:[1],speech:'人物A：先看它的包装和使用方式。',ambient:'室内轻微环境声',foley:'拿起包装的轻响',music:'轻柔背景音乐'},{id:'镜头2｜动作验证与收尾',start:5,end:15,visual:'人物保持同一只商品完成一次清楚使用动作，最后回到正面展示。',camera:'手部特写跟随动作，结尾回到中近景。',referenceNumbers:[1],speech:'人物A：按你的实际需要核对后再选择。',ambient:'室内轻微环境声',foley:'包装接触声',music:''}],conversionClose:'最后用可见商品正面和单一合规选择建议收尾，不虚构价格或库存。',preserve:['参考1商品包装和人物服装保持一致'],forbid:['不得编造功效、价格、认证、库存或生成结果']}
  } as const;
  const parsed=output.parseDirectorOutput(JSON.stringify(reply),settings,references,'director-script/v2');
  assert.equal(parsed.schema,'director-script/v2');
  const visibleOutput=output.directorGenerationText(parsed,references);
  assert.deepEqual([...visibleOutput.matchAll(/^##\s+(.+)$/gmu)].map(match=>match[1]),['剧情梗概','素材与职责','主体与全片设定','镜头 / 时间轴','始终禁止']);
  assert.match(visibleOutput,/@图片1/);
  assert.match(visibleOutput,/\(轻柔背景音乐\)/);
  assert.match(visibleOutput,/<室内轻微环境声、拿起包装的轻响>/);
  assert.match(visibleOutput,/\{人物A：先看它的包装和使用方式。\}/);
  const missingFact=structuredClone(reply) as any;delete missingFact.script.factLedger;
  assert.throws(()=>output.parseDirectorOutput(JSON.stringify(missingFact),settings,references,'director-script/v2'),/字段不完整/);
  const badShot=structuredClone(reply) as any;badShot.script.shots[0].id='第一镜';
  assert.throws(()=>output.parseDirectorOutput(JSON.stringify(badShot),settings,references,'director-script/v2'),/镜头编号/);
  const gap=structuredClone(reply) as any;gap.script.shots[1].start=6;
  assert.throws(()=>output.parseDirectorOutput(JSON.stringify(gap),settings,references,'director-script/v2'),/连续/);
  const silent=structuredClone(reply) as any;silent.script.shots.forEach((shot:any)=>{shot.speech='';shot.ambient='';shot.foley='';shot.music='';});
  assert.throws(()=>output.parseDirectorOutput(JSON.stringify(silent),settings,references,'director-script/v2'),/声音计划/);
  const legacy={...reply,schema:'director-script/v1',script:{title:reply.script.title,creativeDirection:reply.script.creativeDirection,story:reply.script.story,setting:reply.script.setting,materials:reply.script.materials,shots:reply.script.shots,preserve:reply.script.preserve,forbid:reply.script.forbid}};
  assert.equal(output.parseDirectorOutput(JSON.stringify(legacy),settings,references,'director-script/v1').schema,'director-script/v1');
  assert.throws(()=>output.parseDirectorOutput(JSON.stringify(legacy),settings,references,'director-script/v2'),/协议/);
  for(const card of cards){
    const cardSettings={...settings,skillKey:card.key};
    const cardReferences=card.slots.flatMap(slot=>Array.from({length:slot.min},(_,index)=>({id:slot.kinds.includes('image')?imageId:audioId,slot:slot.key,instanceId:`${card.key}-${slot.key}-${index}`})));
    const validated=claims.validateDirectorReferences(owner,cardSettings,cardReferences);
    const cardReply=structuredClone(reply) as any;cardReply.skillKey=card.key;cardReply.script.materials=validated.map((reference,index)=>({referenceNumber:index+1,observation:`参考${index+1}可见内容`,inherit:[`继承${reference.slot}职责`],exclude:['不继承无关背景']}));cardReply.script.shots.forEach((shot:any)=>{shot.referenceNumbers=validated.map((_,index)=>index+1);});
    const cardRaw=validated.length?JSON.stringify(cardReply):JSON.stringify(cardReply).replaceAll('参考1','本轮商品');
    assert.equal(output.parseDirectorOutput(cardRaw,cardSettings,validated,'director-script/v2').skillKey,card.key);
  }

  const conversationId='33333333-3333-4333-8333-333333333333';
  director.openDirector(owner,conversationId,settings);
  await assert.rejects(()=>director.quoteDirectorTurn(owner,{id:conversationId,operationId:'44444444-4444-4444-8444-444444444444',message:'生成脚本',expectedScriptMessageId:null,settings,references:[]}),new RegExp(`需要 ${requiredImageSlot.min}–${requiredImageSlot.max} 个素材`));
  await assert.rejects(()=>director.quoteDirectorTurn(owner,{id:conversationId,operationId:'55555555-5555-4555-8555-555555555555',message:'生成脚本',expectedScriptMessageId:null,settings,references:[{id:audioId,slot:'reference_1'}]}),/不能用于/);
  await assert.rejects(()=>claims.verifyDirectorAudioReferences(owner,settings,[{id:imageId,slot:'reference_1',instanceId:'product-instance'},{id:longAudioId,slot:'reference_4',instanceId:'long-voice'}]),/不能超过 15 秒/);
  const firstOperation='66666666-6666-4666-8666-666666666666';
  const firstReferences=[{id:imageId,slot:'reference_1',instanceId:'product-instance'},{id:audioId,slot:'reference_4',instanceId:'voice-instance'}];
  const firstQuote=await director.quoteDirectorTurn(owner,{id:conversationId,operationId:firstOperation,message:'请基于商品图和声音参考生成15秒可信口播',expectedScriptMessageId:null,settings,references:firstReferences});
  assert.equal(firstQuote.payableTotal,1.5);
  assert.equal(firstQuote.model.id,undefined);
  assert.equal(firstQuote.model.displayName,agentModel.displayName);
  assert.equal('costPrice' in firstQuote.model,false);
  assert.equal('endpoint' in firstQuote.model,false);
  const firstJob=await quotes.confirmCommerceQuote(owner,{quoteId:firstQuote.id,clientRequestId:'77777777-7777-4777-8777-777777777777',inputFingerprint:firstQuote.inputFingerprint});
  assert.doesNotMatch(firstJob.compiledPrompt,/【当前脚本版本】/);
  assert.match(firstJob.compiledPrompt,/声音参考未提供给文字模型收听或转写/);
  const audioReply=structuredClone(reply) as any;audioReply.script.materials.push({referenceNumber:2,observation:'声音参考未由文字模型收听或转写',inherit:['仅供下游视频模型参考声线或音轨'],exclude:['不得推断原台词、说话人身份或事实']});audioReply.script.shots.forEach((shot:any)=>{shot.referenceNumbers=[1,2];});
  firstJob.status='succeeded';firstJob.text=JSON.stringify(audioReply);jobs.persistJob(firstJob);
  const chat=store.get<any>('conversations',conversationId,owner)!;chat.messages.push({id:'first-assistant',role:'assistant',content:firstJob.text,jobId:firstJob.id});store.put('conversations',conversationId,owner,chat);
  const synchronized=director.readDirector(owner,conversationId);
  const scriptMessageId=synchronized.latestScriptMessageId!;
  assert.ok(scriptMessageId);
  assert.equal(synchronized.messages.find(message=>message.id===scriptMessageId)?.business?.state,'ready');
  const application=director.applyDirector(owner,{id:conversationId,messageId:scriptMessageId,expectedScriptMessageId:scriptMessageId,settings,references:firstReferences,videoSettings:{aspectRatio:'9:16',resolution:'720p'}});
  assert.equal(application.outputProtocol,'director-script/v2');
  assert.equal(application.sourceContentHash,claims.directorContentHash(firstJob.text));
  assert.equal(application.sourceConfigurationHash,claims.directorSourceConfigurationHash(firstJob));
  assert.deepEqual(application.sourceReferences.map(reference=>reference.slot),['reference_1','reference_4']);
  assert.deepEqual(application.references.map(reference=>reference.slot),['reference','sound']);

  const videoQuote=await quotes.createCommerceJobQuote(owner,{requestId:'88888888-8888-4888-8888-888888888888',kind:'video',modelId:videoModel.id,prompt:application.script,aspectRatio:'9:16',resolution:'720p',duration:15,generateAudio:true,parentJobId:firstJob.id,directorApplicationId:application.id,references:application.references});
  const videoJob=await quotes.confirmCommerceQuote(owner,{quoteId:videoQuote.id,clientRequestId:'99999999-9999-4999-8999-999999999999',inputFingerprint:videoQuote.inputFingerprint});
  assert.equal(videoJob.directorApplicationSnapshot?.applicationId,application.id);
  assert.equal(videoJob.directorApplicationSnapshot?.sourceConfigurationHash,application.sourceConfigurationHash);
  assert.match(videoJob.compiledPrompt,/编导素材职责 reference_1/);
  assert.equal('directorApplicationSnapshot' in jobs.publicJob(videoJob),false);

  const sourceBefore=structuredClone(firstJob);firstJob.model={...firstJob.model,configHash:'tampered'};jobs.persistJob(firstJob);
  assert.throws(()=>claims.verifyDirectorApplication(owner,{requestId:crypto.randomUUID(),kind:'video',modelId:videoModel.id,prompt:application.script,aspectRatio:'9:16',resolution:'720p',duration:15,generateAudio:true,parentJobId:sourceBefore.id,directorApplicationId:application.id,references:application.references}),/配置快照/);
  store.put('jobs',sourceBefore.id,owner,sourceBefore);

  const revisionOperation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const revisionQuote=await director.quoteDirectorTurn(owner,{id:conversationId,operationId:revisionOperation,message:'只把镜头2的台词改得更口语，其余全部保留',expectedScriptMessageId:scriptMessageId,settings,references:firstReferences});
  const revisionJob=await quotes.confirmCommerceQuote(owner,{quoteId:revisionQuote.id,clientRequestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',inputFingerprint:revisionQuote.inputFingerprint});
  assert.match(revisionJob.compiledPrompt,/【当前脚本版本】/);
  assert.match(revisionJob.compiledPrompt,new RegExp(scriptMessageId));
  assert.match(revisionJob.compiledPrompt,new RegExp(claims.directorContentHash(firstJob.text)));
  assert.match(revisionJob.compiledPrompt,/只改用户明确要求的部分，其余镜头和约束逐项保留/);
  assert.match(revisionJob.compiledPrompt,/镜头2｜动作验证与收尾/);

  const legacyTarget=cards[0];
  const legacyCustom={...structuredClone(legacyTarget),key:'legacy-custom-director',name:'旧本地自定义编导',default:false};
  store.put('director-catalog','state','system',{disabled:[legacyTarget.key],custom:[legacyCustom],edits:{[cards[1].key]:{name:'旧本地改名编导'}}});
  store.put('operation-routes',`director.${cards[1].key}`,'system',{modelId:'legacy-local-model',revision:99});
  const originalFetch=globalThis.fetch;let sharedBaselineNetworkCalls=0;
  globalThis.fetch=(async()=>{sharedBaselineNetworkCalls++;throw Error('共享配置无发布版本的基线测试不得访问网络');}) as typeof fetch;
  process.env.SHARED_CONFIGURATION_ENABLED='1';
  try{
    const sharedCards=catalog.directorCatalog();
    assert.deepEqual(sharedCards.map(card=>card.key),cards.map(card=>card.key));
    assert.equal(catalog.findDirectorCard(legacyTarget.key)?.name,legacyTarget.name);
    assert.equal(catalog.findDirectorCard('旧本地改名编导'),undefined);
    assert.equal(catalog.findDirectorCard(legacyCustom.key),undefined);
    assert.equal(catalog.findDirectorCard('默认编导')?.key,cards.find(card=>card.default)?.key);
    const sharedDirectorRoutes=routing.operations().filter(route=>route.id.startsWith('director.'));
    assert.deepEqual(sharedDirectorRoutes.map(route=>route.id),cards.map(card=>`director.${card.key}`));
    const legacyRoute=sharedDirectorRoutes.find(route=>route.id===`director.${cards[1].key}`)!;
    assert.equal(legacyRoute.modelId,agentModel.id);
    assert.equal(legacyRoute.revision,1);
    assert.equal(routing.operationFor({kind:'agent',purpose:'director',director:legacyTarget.key}).id,`director.${legacyTarget.key}`);
    assert.equal(sharedBaselineNetworkCalls,0);
  }finally{
    process.env.SHARED_CONFIGURATION_ENABLED='0';
    globalThis.fetch=originalFetch;
  }

  const promptSource=await fs.readFile(new URL('../src/commerce/server/prompt-compiler.ts',import.meta.url),'utf8');
  const workspaceSource=await fs.readFile(new URL('../src/commerce/components/commerce-agent/workspace.tsx',import.meta.url),'utf8');
  const compilerReturn=promptSource.slice(promptSource.indexOf('return ['));
  assert.ok(['平台事实与安全规则（不可覆盖）','当前卡片系统提示词','当前发布知识','素材编号与职责','管理员配置的输入字段','用户本轮要求','已验证对话历史','当前脚本版本','输出合同','交付前质检'].every((label,index,labels)=>compilerReturn.indexOf(label)>=0&&(index===0||compilerReturn.indexOf(label)>compilerReturn.indexOf(labels[index-1]))));
  assert.match(workspaceSource,/matchingDirectorApplication/);
  assert.match(workspaceSource,/directorSpec=\{directorSpec\}/);
  assert.match(await fs.readFile(new URL('../src/commerce/components/commerce-agent/director-conversation.tsx',import.meta.url),'utf8'),/ca-director-configured-fields/);
  assert.doesNotMatch(workspaceSource,/directorName=\{director\}/);
  console.log(JSON.stringify({passed:64,networkCalls:0,paidCalls:0,catalog:{directors:cards.length,validatedCards:cards.length,referenceLimit:directorSchema.DIRECTOR_REFERENCE_LIMIT},protocol:'director-script/v2',fixture,checks:['19-card-catalog','unique-card-keys','single-default','slot-keys','slot-bounds','card-total-reference-limit','19-template-count','unique-template-ids','v2-template-contract','19-card-slot-and-output-matrix','v2-parse','facts-projection','characters-projection','product-projection','conversion-projection','missing-fact-rejected','shot-title-rejected','timeline-gap-rejected','empty-audio-plan-rejected','legacy-v1-readable','v1-not-accepted-as-v2','required-slot-rejected','wrong-role-rejected','long-audio-rejected-before-quote','director-quote-with-audio','hidden-agent-model','first-turn-no-base','opaque-audio-rule-compiled','source-job-synchronized','ready-script','application-v2','source-content-hash','source-configuration-hash','source-role-frozen','downstream-audio-role-mapped','video-quote','video-source-snapshot','video-config-hash','video-role-binding','public-source-snapshot-hidden','revision-current-script-block','revision-message-id','revision-content-hash','revision-preserve-rule','revision-full-script','tamper-rejected','shared-no-release-baseline-catalog','shared-no-release-find-director','shared-no-release-baseline-routes','shared-no-release-legacy-route-ignored','shared-no-release-zero-network','compiler-order','director-matcher','dynamic-card-prop','configured-fields-ui','no-provider-dispatch']}));
}

main().catch(error=>{console.error(error);process.exitCode=1;});
