import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
  assertRollingTailFrameCapacity,
  assertVideoReferenceCapabilities,
  videoReferenceImageLimit,
  videoReferenceTotalLimit,
} from '../src/commerce/server/video-reference-capabilities';
import {validateVideoDurationPlan,videoNativeDurationOptions} from '../src/commerce/server/jobs';
import {doubaoSeedanceTaskBody} from '../src/lib/video-doubao-seedance-relay';
import {classifyDepthCloneModel,depthCloneProfilesForModels} from '../src/commerce/server/depth-video-clone-model-profiles';

type ReferenceAsset={type:string};
const images=(count:number):ReferenceAsset[]=>Array.from({length:count},()=>({type:'image/png'}));
const audios=(count:number):ReferenceAsset[]=>Array.from({length:count},()=>({type:'audio/wav'}));
const videos=(count:number):ReferenceAsset[]=>Array.from({length:count},()=>({type:'video/mp4'}));

assert.doesNotThrow(()=>assertVideoReferenceCapabilities({maxReferenceImages:12},images(12)));
assert.throws(()=>assertVideoReferenceCapabilities({maxReferenceImages:9},images(12)),/参考图数量超出/u);

assert.doesNotThrow(()=>assertVideoReferenceCapabilities({supportsAudioInput:true,maxReferenceAudios:1},audios(1)));
for(const supportsAudioInput of [false,'true',1,undefined]){
  assert.throws(()=>assertVideoReferenceCapabilities({supportsAudioInput,maxReferenceAudios:1},audios(1)),/不支持这些音频参考/u);
}

assert.doesNotThrow(()=>assertVideoReferenceCapabilities({supportsSourceVideoInput:true,maxReferenceVideos:1},videos(1)));
for(const supportsSourceVideoInput of [false,'true',1,undefined]){
  assert.throws(()=>assertVideoReferenceCapabilities({supportsSourceVideoInput,maxReferenceVideos:1},videos(1)),/不支持这些视频参考/u);
}

const h3Caps={maxReferenceFiles:12,maxReferenceImages:9,supportsAudioInput:true,maxReferenceAudios:3,supportsSourceVideoInput:true,maxReferenceVideos:3,audioRequiresVisualReference:true};
assert.doesNotThrow(()=>assertVideoReferenceCapabilities(h3Caps,[...images(9),...videos(3)]));
assert.doesNotThrow(()=>assertVideoReferenceCapabilities(h3Caps,[...images(9),...audios(3)]));
assert.throws(()=>assertVideoReferenceCapabilities(h3Caps,[...images(9),...audios(3),...videos(1)]),/参考素材总数/u);
assert.throws(()=>assertVideoReferenceCapabilities(h3Caps,audios(1)),/必须与参考图片或视频一起/u);
assert.equal(videoReferenceTotalLimit(h3Caps),12);

assert.equal(videoReferenceImageLimit({}),1);
assert.doesNotThrow(()=>assertRollingTailFrameCapacity({},[]));
assert.throws(()=>assertRollingTailFrameCapacity({},images(1)),/滚动尾帧/u);
assert.doesNotThrow(()=>assertRollingTailFrameCapacity({maxReferenceImages:9},images(8)));
assert.throws(()=>assertRollingTailFrameCapacity({maxReferenceImages:9},images(9)),/滚动尾帧/u);
assert.doesNotThrow(()=>assertRollingTailFrameCapacity({maxReferenceImages:9,maxReferenceFiles:12},[...images(8),...audios(3)]));
assert.throws(()=>assertRollingTailFrameCapacity({maxReferenceImages:9,maxReferenceFiles:12},[...images(8),...audios(3),...videos(1)]),/参考文件总数/u);

const baseModel={id:'fixture',displayName:'MiniMax H3',kind:'video' as const,generationReady:false};
assert.equal(classifyDepthCloneModel({...baseModel,modelName:'MiniMax H3',capabilities:{supportsSourceVideoInput:true,supportsImageInput:true,maxReferenceImages:9}}),null);
const ref2va={...baseModel,displayName:'MiniMax H3 Base Ref2VA',modelName:'H3-Base-Ref2VA',capabilities:{supportsSourceVideoInput:true,supportsImageInput:true,maxReferenceImages:9,maxReferenceVideos:3,supportsAudioInput:true,maxReferenceAudios:3,maxReferenceFiles:12,audioRequiresVisualReference:true}};
assert.equal(classifyDepthCloneModel(ref2va),'value-minimax-h3-ref2va');
assert.equal(depthCloneProfilesForModels([ref2va]).find(profile=>profile.id==='value-minimax-h3-ref2va')?.status,'missing');

assert.deepEqual(videoNativeDurationOptions({nativeDurations:[10,5,10]}),[5,10]);
assert.deepEqual(videoNativeDurationOptions({durationMode:'range',minDuration:4,maxDuration:8,durationStep:2}),[4,6,8]);
const baseVideoInput={requestId:'12345678-1234-1234-1234-123456789012',kind:'video' as const,modelId:'fixture',prompt:'fixture',duration:20,aspectRatio:'9:16',resolution:'720p'};
assert.doesNotThrow(()=>validateVideoDurationPlan({...baseVideoInput,rollingPlan:{segments:[10,10]}},{nativeDurations:[5,10],maxReferenceImages:2},images(1)));
assert.throws(()=>validateVideoDurationPlan({...baseVideoInput,rollingPlan:{segments:[10,10]}},{nativeDurations:[5,10],maxReferenceImages:1},images(1)),/滚动尾帧/u);
assert.throws(()=>validateVideoDurationPlan({...baseVideoInput,duration:11},{nativeDurations:[5,10]},[]),/无法用当前模型/u);
assert.throws(()=>validateVideoDurationPlan({...baseVideoInput,rollingPlan:{segments:[10,5]}},{nativeDurations:[5,10]},[]),/分段计划/u);

function source(relativePath:string){return readFileSync(new URL(`../${relativePath}`,import.meta.url),'utf8');}
function compact(value:string){return value.replace(/\s+/gu,'');}
function section(value:string,start:string,end:string){
  const from=value.indexOf(start),to=value.indexOf(end,from+start.length);
  assert.ok(from>=0&&to>from,`静态合同区段不存在：${start}`);
  return value.slice(from,to);
}

const gateway=source('src/app/api/commerce-model-gateway/route.ts');
const gatewayVideo=section(gateway,'const caps=model._capabilities as Row; const images=Array.isArray(input.images)?input.images:[];','const result=await submitVideoTask');
assert.doesNotMatch(gatewayVideo,/\.slice\s*\(/u,'视频网关不得静默截断参考素材');
assert.match(compact(gatewayVideo),/images\.length\+audios\.length\+videos\.length>15/u);

const jobs=compact(source('src/commerce/server/jobs.ts'));
assert.ok(jobs.split('generateAudio:value.input.generateAudio').length-1>=2,'自定义与主站网关提交都必须透传 generateAudio');

const adapter=source('src/lib/video-adapter.ts');
const newApi=compact(section(adapter,'async function generateNewApiVideo','async function pollNewApiVideo'));
assert.match(newApi,/if\(audioUrls\.length>0\)body\.audios=audioUrls;/u,'NewAPI 必须保留参考音频');
assert.match(newApi,/if\(params\.generateAudio!==undefined\)body\.generate_audio=params\.generateAudio;/u,'NewAPI 必须保留显式 false');

const doubaoSource=compact(source('src/lib/video-doubao-seedance-relay.ts'));
assert.match(doubaoSource,/for\(consturlofaudioUrls\)content\.push\(mediaItem\("audio_url",url,"reference_audio"\)\)/u,'Doubao 必须保留参考音频');
assert.match(doubaoSource,/params\.generateAudio!==undefined\?\{generate_audio:params\.generateAudio\}/u,'Doubao 必须保留显式 false');
const doubao=(()=>doubaoSeedanceTaskBody({
  id:'fixture',name:'fixture',provider:'fixture',api_endpoint:'https://fixture.invalid',api_key:'fixture',protocol_type:'secure_skill_doubao_seedance',price_per_use:0,duration_seconds:6,supports_image_input:true,model_name:'doubao-seedance-2-5-260628',api_protocol_config:{default_resolution:'720p'},
},{prompt:'fixture',audioUrl:'https://fixture.invalid/reference.wav',generateAudio:false,duration:6,resolutionTier:'720p'}))();
assert.equal(doubao.generate_audio,false);
assert.equal((doubao.content as Array<Record<string,unknown>>).filter(item=>item.role==='reference_audio').length,1);

console.log(JSON.stringify({passed:40,networkCalls:0,databaseWrites:0,walletCalls:0,providerCalls:0,checks:['12-images-supported','max-9-rejected','audio-strict-true','source-video-strict-true','h3-total-12','h3-total-13-rejected','h3-audio-needs-visual','rolling-tail-image-and-total-reserved','ordinary-h3-not-ref2va','explicit-ref2va-still-missing','rolling-duration-plan-exact','unrepresentable-duration-rejected','gateway-no-silent-slice','jobs-generate-audio-passthrough','newapi-audio-and-explicit-false','doubao-audio-and-explicit-false']}));
