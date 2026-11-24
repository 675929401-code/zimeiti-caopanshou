import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {billingQuantity,quoteCost,quotePrice} from '../src/commerce/server/billing';
import {DEPTH_MODEL_CAPABILITY_REQUIREMENTS,depthConfig,depthModelDurationOptions,validateDepthModel,type DepthSnapshot} from '../src/commerce/server/depth-video-clone-schema';
import {classifyDepthCloneModel,depthCloneProfilesForModels} from '../src/commerce/server/depth-video-clone-model-profiles';
import {commerceVideoParameters} from '../src/commerce/server/video-media-parameters';
import {gaoruiSeedanceNativeBody} from '../src/lib/gaorui-seedance-native-contract';
import type {VideoModelConfig} from '../src/lib/video-adapter';
import {toPublicModelId} from '../src/lib/public-model-dto';
import type {Model} from '../src/commerce/server/models';

async function source(file:string){return fs.readFile(path.resolve(file),'utf8');}

async function main(){
 let passed=0;
 const check=(name:string,work:()=>void)=>{work();passed+=1;console.log(`PASS ${name}`);};
 const [server,claim,ui,workspace,routing,jobs,modelsApi,gateway,configuration,profilesSource]=await Promise.all([
  source('src/commerce/server/depth-video-clones.ts'),
  source('src/commerce/server/depth-video-clone-claim.ts'),
  source('src/commerce/components/commerce-agent/depth-video-clone-studio.tsx'),
  source('src/commerce/components/commerce-agent/workspace.tsx'),
  source('src/commerce/server/operation-routing.ts'),
  source('src/commerce/server/jobs.ts'),
  source('src/app/api/commerce/models/route.ts'),
  source('src/app/api/commerce-model-gateway/route.ts'),
   source('src/commerce/server/configuration-admin.ts'),
   source('src/commerce/server/depth-video-clone-model-profiles.ts'),
 ]);

 const model={publicPrice:2,costPrice:1,billingUnit:'per_use' as const};
 const planned={kind:'video' as const,duration:15,rollingPlan:{segments:[5,5,5]}};
 check('滚动生成按段计费',()=>{assert.equal(billingQuantity(planned,model),3);assert.equal(quoteCost(planned,model),3);assert.equal(quotePrice(planned,model),6);});
 check('按输出秒计费不重复乘段',()=>assert.equal(billingQuantity(planned,{billingUnit:'output_second'}),15));
 const snapshot={sessionId:'session',revision:1,source:{assetId:'source',sha256:'a',name:'source.mp4',type:'video/mp4',bytes:10,durationSeconds:20,startTimestampSeconds:0,width:1080,height:1920,fps:30,frameCount:600,hasAudioTrack:true},prepared:{id:'prepared',version:'v1',source:{} as never,clip:{sha256:'b',bytes:10,durationSeconds:10,hasAudioTrack:true},range:{mode:'leading' as const,start:0 as const,end:10},facts:{audioUnderstanding:'unknown' as const,sourceBlackSegments:[],clipBlackTail:false},createdAt:1},references:[{id:'person',slot:'person' as const,sha256:'c',name:'person.jpg',type:'image/jpeg',bytes:10}],config:{modelId:'model',duration:10,aspectRatio:'9:16',resolution:'720p',generateAudio:false,extraInstruction:'',mentions:{text:'',mentions:[]}}} as DepthSnapshot;snapshot.prepared.source=snapshot.source;
 const compatibleModel={id:'model',displayName:'Seedance fixture',kind:'video' as const,source:'main' as const,publicPrice:2,costPrice:1,billingUnit:'per_use' as const,configHash:'hash',capabilities:{available:true,executionSupported:true,supportsSourceVideoInput:true,supportsImageInput:true,maxReferenceImages:9,supportsAudioInput:true,maxReferenceAudios:3,supportsGenerateAudioToggle:true,durationMode:'discrete',nativeDurations:[4,5,6,7,8,9,10,11,12,13,14,15],aspectRatios:['9:16'],resolutionOptions:['720p']}} satisfies Model;
 check('按原片、商品及声音三个角色各传一次',()=>{
  const cfg={protocol_type:'gaorui_video',model_name:'seedance-2.0-fast'} as VideoModelConfig;
  const media={images:['https://example.com/product.png'],videos:['https://example.com/source.mp4'],audios:['https://example.com/speech.wav']};
  const base={prompt:'保留原片运镜',duration:4,aspectRatio:'9:16',generateAudio:true};
  assert.throws(()=>gaoruiSeedanceNativeBody(cfg,{...base,imageUrl:media.images[0],imageUrls:media.images,sourceVideoUrl:media.videos[0],audioUrl:media.audios[0],audioUrls:media.audios}),/INPUT_MODE_CONFLICT/);
  const body=gaoruiSeedanceNativeBody(cfg,commerceVideoParameters(cfg,base,media,false));
  assert.deepEqual(body.content.flatMap(row=>'role' in row?[row.role]:[]),['reference_image','reference_video','reference_audio']);
  assert.throws(()=>commerceVideoParameters(cfg,base,media,true),/BEFORE_DISPATCH/);
  const framed=commerceVideoParameters(cfg,base,{images:[...media.images,'https://example.com/end.png'],audios:[],videos:[]},true);
  assert.deepEqual(gaoruiSeedanceNativeBody(cfg,framed).content.flatMap(row=>'role' in row?[row.role]:[]),['first_frame','last_frame']);
  const fastSizeModel={...compatibleModel,id:toPublicModelId('video','gaorui-seedance-2-0-fast-video'),capabilities:{...compatibleModel.capabilities,supportsAudioInput:true,maxReferenceAudios:1}};
 check('Seedance Fast 按源片像素在报价前阻止不合规参考',()=>{
   const sized=(width:number,height:number)=>({...snapshot,source:{...snapshot.source,width,height}});
   assert.throws(()=>validateDepthModel(fastSizeModel,sized(512,288)),/512×288/u);
   assert.throws(()=>validateDepthModel(fastSizeModel,sized(480,640)),/总像素/u);
   assert.throws(()=>validateDepthModel(fastSizeModel,sized(4000,4000)),/总像素/u);
   assert.throws(()=>validateDepthModel(fastSizeModel,sized(1800,500)),/宽高比/u);
   validateDepthModel(fastSizeModel,sized(1280,720));
   validateDepthModel(fastSizeModel,sized(720,1280));
 });
 const fast={...compatibleModel,id:toPublicModelId('video','gaorui-seedance-2-0-fast-video')};
  assert.equal(classifyDepthCloneModel(fast),'seedance-2-0-fast');
  assert.equal(classifyDepthCloneModel({...fast,capabilities:{...fast.capabilities,supportsGenerateAudioToggle:false}}),null);
 });
 check('主站模型按真实能力通过深度复刻门禁',()=>assert.doesNotThrow(()=>validateDepthModel(compatibleModel,snapshot)));
 check('深度复刻只允许模型原生时长',()=>{assert.deepEqual(depthModelDurationOptions(compatibleModel.capabilities,12.8),[4,5,6,7,8,9,10,11,12]);assert.throws(()=>validateDepthModel({...compatibleModel,capabilities:{...compatibleModel.capabilities,nativeDurations:[5,15]}},snapshot),/原生时长/u);});
 check('深度复刻拒绝伪源视频模型',()=>assert.throws(()=>validateDepthModel({...compatibleModel,capabilities:{...compatibleModel.capabilities,supportsSourceVideoInput:false}},snapshot),/不支持源视频/u));
 check('深度复刻拒绝未验证声音开关',()=>assert.throws(()=>validateDepthModel({...compatibleModel,capabilities:{...compatibleModel.capabilities,supportsGenerateAudioToggle:false}},snapshot),/声音开关/u));
 check('深度复刻声音参考严格核对音频能力',()=>{const voice={...snapshot,references:[...snapshot.references,{id:'voice',slot:'voice' as const,sha256:'d',name:'voice.mp3',type:'audio/mpeg',bytes:10}]};assert.throws(()=>validateDepthModel({...compatibleModel,capabilities:{...compatibleModel.capabilities,supportsAudioInput:false}},voice),/声音参考/u);});
 check('深度复刻接受对标画幅并允许环境图作为替换素材',()=>{assert.equal(depthConfig({...snapshot.config,aspectRatio:'21:9'}).aspectRatio,'21:9');assert.match(server,/depthImageIds\(s\.references\)\.length===0/u);assert.doesNotMatch(server,/slot==='person'\|\|r\.slot==='product'/u);assert.match(ui,/hasRequiredReplacement=imageIds\.length>0/u);});
 check('深度复刻只按已审核模型家族与真实能力绑定',()=>{const seedance={...compatibleModel,displayName:'Seedance 2.5',modelName:'doubao-seedance-2-5-260628'};assert.equal(classifyDepthCloneModel(seedance),'benchmark-seedance-2-5');assert.equal(classifyDepthCloneModel({...compatibleModel,displayName:'Omni Video Edit',modelName:'omni-video-edit'}),null);assert.equal(classifyDepthCloneModel({...compatibleModel,displayName:'Wan 3.0',modelName:'wan3.0-video'}),null);assert.equal(classifyDepthCloneModel({...compatibleModel,displayName:'MiniMax H3 多图',modelName:'MiniMax-H3',capabilities:{...compatibleModel.capabilities,supportsSourceVideoInput:false,maxReferenceImages:9}}),null);const h3Ref2va={...compatibleModel,displayName:'MiniMax H3 Ref2VA',modelName:'MiniMax-H3-Ref2VA',capabilities:{...compatibleModel.capabilities,maxReferenceImages:9,maxReferenceVideos:3,maxReferenceAudios:3,maxReferenceFiles:12,audioRequiresVisualReference:true}};assert.equal(classifyDepthCloneModel(h3Ref2va),'value-minimax-h3-ref2va');assert.equal(classifyDepthCloneModel({...h3Ref2va,capabilities:{...h3Ref2va.capabilities,maxReferenceFiles:11}}),null);});
 check('模型画像公开官方边界但不冒充分段执行',()=>{const values=depthCloneProfilesForModels([]);assert.deepEqual(values.map(value=>value.id),['benchmark-seedance-2-5','value-minimax-h3-ref2va']);assert.ok(values.every(value=>value.status==='missing'&&!value.durationPolicy.executionConnected));assert.deepEqual(values[0].durationPolicy.examples.find(value=>value.sourceSeconds===70)?.segmentSeconds,[20,20,15,15]);assert.deepEqual(values[1].durationPolicy.examples.find(value=>value.sourceSeconds===70)?.segmentSeconds,[14,14,14,14,14]);});
 check('深度复刻禁用语义错误的通用滚动生成',()=>{assert.doesNotMatch(server,/planSegments|rollingPlan/u);assert.match(jobs,/input\.purpose!==DEPTH_PURPOSE/u);});
 check('深度复刻报价先加载发布配置并检查付费就绪',()=>{assert.match(server,/quoteDepthClone[^\{]*\{await primePublishedCommerceConfiguration/u);assert.match(server,/assertPublishedCommercePaidJobsReady\(\)/u);});
 check('深度复刻报价强制模型哈希与当前专项验收',()=>{assert.match(server,/if\(!model\.configHash\)throw Error\('深度复刻模型配置哈希缺失/u);assert.match(server,/requireCommerceDepthCloneAcceptance\(model\)/u);});
 check('深度复刻报价保存发布与模型快照',()=>{assert.match(server,/modelId:model\.id,modelConfigHash:model\.configHash/u);assert.match(server,/releaseId:published\.releaseId,releaseVersion:published\.releaseVersion,manifestSha256:published\.manifestSha256/u);assert.match(claim,/modelConfigHash:string/u);});
 check('确认阶段重新核对发布版本模型与专项验收',()=>{assert.match(server,/confirmDepthClone[\s\S]*force:Boolean\(q\.releaseId\)/u);assert.match(server,/model\.configHash!==q\.modelConfigHash/u);assert.match(server,/depthRouteFingerprint\(q\.input\)!==q\.routeFingerprint/u);assert.match(server,/if\(published\)await requireCommerceDepthCloneAcceptance\(model\)/u);});
 check('报价只公开应付金额不泄露成本',()=>{assert.match(server,/return \{id:q\.id,modelName:q\.modelName,payableTotal:q\.payableTotal,currency:'CNY'/u);assert.doesNotMatch(server,/return \{id:q\.id[^\n]+unitCost/u);});
 check('售价与零元门禁继续生效',()=>{assert.match(server,/payableTotal<estimatedTotalCost/u);assert.match(server,/explicitlyFree!==true/u);});
 check('发布路由限制客户端只能选择本功能允许模型',()=>{assert.match(routing,/const allowed=\[route\.modelId,\.\.\.\(route\.fallbackModelIds\|\|\[\]\)\]\.filter\(Boolean\)/u);assert.match(routing,/allowed\.some\(id=>id===requestedModelId\|\|sameCuratedModelProfile/u);assert.match(routing,/所选模型尚未发布用于此功能/u);});
 check('深度复刻发布路由固定要求源视频图片与声音开关',()=>{assert.deepEqual(DEPTH_MODEL_CAPABILITY_REQUIREMENTS,{supportsSourceVideoInput:true,supportsImageInput:true,supportsGenerateAudioToggle:true});assert.match(routing,/capabilityRequirements: DEPTH_MODEL_CAPABILITY_REQUIREMENTS/u);assert.match(configuration,/fixedOperationRequirements/u);});
 check('模型目录按深度复刻画像标注不兼容原因',()=>{assert.match(modelsApi,/operationId===DEPTH_PURPOSE/u);assert.match(modelsApi,/classifyDepthCloneModel/u);assert.match(modelsApi,/depthCloneProfilesForModels/u);assert.match(modelsApi,/未绑定已审核的源视频复刻方案/u);assert.match(modelsApi,/不支持源视频复刻/u);assert.match(modelsApi,/声音开关传输尚未验证/u);assert.match(profilesSource,/MiniMax H3 Ref2VA · 性价比/u);});
 check('声音开关能力由真实适配器派生且不进入配置哈希',()=>{assert.match(gateway,/supportsCommerceGenerateAudioToggle/u);assert.match(gateway,/secure_skill_doubao_seedance/u);const hashExpression=gateway.match(/const configHash =[^\n]+/u)?.[0]||'';assert.doesNotMatch(hashExpression,/supportsGenerateAudioToggle/u);});
 check('深度复刻只读取本功能发布模型',()=>assert.match(ui,/operationId='\+encodeURIComponent\(DEPTH_PURPOSE\)/u));
 check('深度复刻页面只呈现已审核画像与长视频边界',()=>{assert.match(ui,/上传或从素材库选择原视频/u);for(const role of ['product','person','background','voice'])assert.match(ui,new RegExp(`'${role}'`));assert.match(ui,/aria-label="深度复刻模型"/u);assert.match(ui,/aria-label="深度复刻时长"/u);assert.match(ui,/benchmark-seedance-2-5/u);assert.match(ui,/value-minimax-h3-ref2va/u);assert.match(ui,/profiles\.map\(profile/u);assert.match(ui,/模型能力与长视频边界/u);assert.match(ui,/30、60、70、80秒深度复刻处理规则/u);assert.match(ui,/普通视频模型不满足源视频复刻能力/u);assert.match(ui,/disabled=\{!canGenerate\}/u);});
 check('通用视频页提供清晰站内复刻入口',()=>{assert.match(workspace,/aria-label="上传原视频并替换人物、服装、商品或环境"/u);assert.match(workspace,/navigatePath\('\/toolbox\/depth-video-clone'\)/u);assert.match(workspace,/复刻原视频/u);assert.doesNotMatch(workspace,/tab==='video'&&!helperMode&&<button type="button" className="ca-depth-entry"/u);});
 check('前端费用确认展示准确应付额',()=>{assert.match(ui,/本次应付 ¥\{quote\.payableTotal\.toFixed\(4\)\}/u);assert.match(ui,/确认支付 ¥\{quote\.payableTotal\.toFixed\(4\)\} 并生成/u);assert.doesNotMatch(ui,/供应商实际用量结算|参考费用/u);});

 console.log(JSON.stringify({passed,networkCalls:0,paidCalls:0,databaseWrites:0}));
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
