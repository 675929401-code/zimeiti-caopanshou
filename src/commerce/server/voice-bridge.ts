import {createHash} from 'node:crypto';

import {readVoiceCatalog} from '@/lib/voice-studio/catalog';
import {safeFetch} from '@/lib/safe-fetch';
import {loadVolcanoVoiceProviderConfig} from '@/lib/server/voice-provider-config';
import {calculateVoiceCost,type CostBreakdown} from '@/lib/vs/pricing';
import {getDefaultModelBySpeaker} from '@/lib/vs/voices-data';
import {synthesizeSpeech} from '@/lib/vs/volcengine';
import {get} from './store';

export type CommerceVoiceFormat='mp3'|'wav'|'ogg';
export type CommerceVoiceParameters={
  speedRatio:number;
  pitch:number;
  emotion:string;
  format:CommerceVoiceFormat;
  sampleRate:16000|24000|48000;
};
export type CommerceVoiceCatalogEntry={
  voiceId:string;
  name:string;
  description:string;
  gender:string;
  language:string;
  engine:'volcano';
  speakerId:string;
  modelId:string;
  providerModelId:string;
  providerResourceId:string;
  available:boolean;
  priceConfigured:boolean;
  generationReady:boolean;
  readinessMessage?:string;
};
export type FrozenCommerceVoiceInput={
  voiceId:string;
  voiceName:string;
  speakerId:string;
  engine:'volcano';
  modelId:string;
  providerModelId:string;
  providerResourceId:string;
  configHash:string;
  acceptanceFingerprint:string;
  text:string;
  textHash:string;
  textLength:number;
  parameters:CommerceVoiceParameters;
  payableTotal:number;
  costAmount:number;
};
export type CommerceVoiceExecutionResult={
  bytes:Buffer;
  type:'audio/mpeg'|'audio/wav'|'audio/ogg';
  providerTaskId:string;
  duration?:number;
  actualCostAmount?:number;
};

type ProviderSnapshot={
  configured:boolean;
  source:'plugins'|'environment'|'test'|'none';
  bindingId?:string;
  credentialFingerprint?:string;
};
type CatalogVoice={
  id?:string;
  adminId?:string;
  name:string;
  description?:string;
  gender?:string;
  language?:string;
  engine?:string;
  speakerId:string;
  isActive?:boolean;
};
type VoiceBridgeTestDependencies={
  catalog?:()=>CatalogVoice[];
  pricing?:(characters:number,modelId:string)=>CostBreakdown|null;
  providerSnapshot?:()=>Promise<ProviderSnapshot>;
  executor?:(input:FrozenCommerceVoiceInput,attemptId:string)=>Promise<CommerceVoiceExecutionResult>;
  acceptanceEvidence?:(fingerprint:string)=>CommerceVoiceAcceptanceEvidence|undefined;
};

export type CommerceVoiceAcceptanceEvidence={
  schema:'commerce-voice-acceptance/v1';
  fingerprint:string;
  status:'published';
  evidenceHash:string;
  providerTaskId:string;
  resultSha256:string;
  testedAt:number;
  publishedAt:number;
  publishedBy:string;
};

let testDependencies:VoiceBridgeTestDependencies|undefined;

/** Test-only seam. It cannot replace production transport in a live runtime. */
export function setCommerceVoiceBridgeForTesting(value?:VoiceBridgeTestDependencies){
  if(process.env.NODE_ENV!=='test')throw Error('VOICE_TEST_DEPENDENCIES_FORBIDDEN');
  testDependencies=value;
}

export class CommerceVoiceBridgeError extends Error{
  constructor(public readonly code:string,message:string,public readonly status=400){super(message);this.name='CommerceVoiceBridgeError';}
}

export class CommerceVoiceKnownFailure extends Error{
  constructor(public readonly code:string,message=code){super(message);this.name='CommerceVoiceKnownFailure';}
}

function sha(value:string|Buffer){return createHash('sha256').update(value).digest('hex');}
function stable(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,nested])=>`${JSON.stringify(key)}:${stable(nested)}`).join(',')}}`;
  return JSON.stringify(value);
}
function publishedModel(providerModelId:string){
  if(/^seed-tts-2\.0(?:-|$)/u.test(providerModelId))return 'seed-tts-2.0';
  if(/^seed-icl-2\.0(?:-|$)/u.test(providerModelId))return 'seed-icl-2.0';
  return providerModelId;
}
function targetFor(speakerId:string){
  const providerModelId=getDefaultModelBySpeaker(speakerId).trim();
  const modelId=publishedModel(providerModelId);
  const providerResourceId=modelId==='seed-icl-2.0'?'seed-icl-2.0':'seed-tts-2.0';
  return {modelId,providerModelId,providerResourceId};
}
function catalogRows(){
  const rows=testDependencies?.catalog?.()||(readVoiceCatalog(false) as CatalogVoice[]);
  return rows.filter(row=>row.isActive!==false&&row.engine==='volcano'&&row.speakerId&&row.name);
}
function pricing(characters:number,modelId:string){return testDependencies?.pricing?.(characters,modelId)??calculateVoiceCost(characters,modelId,1);}
async function providerSnapshot():Promise<ProviderSnapshot>{
  if(testDependencies?.providerSnapshot)return testDependencies.providerSnapshot();
  const config=await loadVolcanoVoiceProviderConfig();
  if(!config?.apiKey?.trim())return {configured:false,source:'none'};
  return {configured:true,source:config.source,bindingId:config.bindingId,credentialFingerprint:sha(config.apiKey.trim())};
}
function normalizeParameters(value:Partial<CommerceVoiceParameters>|undefined):CommerceVoiceParameters{
  const speedRatio=Number(value?.speedRatio??1),pitch=Number(value?.pitch??0);
  const emotion=String(value?.emotion||'neutral').trim().toLowerCase();
  const format=String(value?.format||'mp3') as CommerceVoiceFormat;
  const sampleRate=Number(value?.sampleRate||24000) as CommerceVoiceParameters['sampleRate'];
  if(!Number.isFinite(speedRatio)||speedRatio<0.5||speedRatio>2)throw new CommerceVoiceBridgeError('VOICE_SPEED_INVALID','语速必须在 0.5 至 2.0 之间');
  if(!Number.isFinite(pitch)||pitch<-12||pitch>12)throw new CommerceVoiceBridgeError('VOICE_PITCH_INVALID','音调必须在 -12 至 12 之间');
  if(!/^[a-z][a-z0-9_-]{1,39}$/u.test(emotion))throw new CommerceVoiceBridgeError('VOICE_EMOTION_INVALID','情绪参数无效');
  if(!['mp3','wav','ogg'].includes(format))throw new CommerceVoiceBridgeError('VOICE_FORMAT_INVALID','音频格式仅支持 mp3、wav 或 ogg');
  if(![16000,24000,48000].includes(sampleRate))throw new CommerceVoiceBridgeError('VOICE_SAMPLE_RATE_INVALID','采样率仅支持 16000、24000 或 48000');
  return {speedRatio,pitch,emotion,format,sampleRate};
}
function configHash(input:{voice:CatalogVoice;target:ReturnType<typeof targetFor>;price:CostBreakdown;provider:ProviderSnapshot;parameters:CommerceVoiceParameters}){
  return sha(stable({
    voice:{id:input.voice.adminId||input.voice.id,name:input.voice.name,speakerId:input.voice.speakerId,engine:'volcano',active:input.voice.isActive!==false},
    model:{modelId:input.target.modelId,providerModelId:input.target.providerModelId,providerResourceId:input.target.providerResourceId},
    pricing:input.price.pricing,
    provider:input.provider,
    parameters:input.parameters,
  }));
}

function normalizedQuoteAmounts(price:CostBreakdown|null|undefined){
  if(!price||!Number.isFinite(price.sellPriceRmb)||!Number.isFinite(price.costPriceRmb))return;
  const payableTotal=Math.round(price.sellPriceRmb*100)/100;
  const costAmount=Math.round(price.costPriceRmb*1_000_000)/1_000_000;
  if(payableTotal<=0||costAmount<0||payableTotal<costAmount)return;
  return {payableTotal,costAmount};
}

function voiceAcceptanceFingerprint(input:{voice:CatalogVoice;target:ReturnType<typeof targetFor>;price:CostBreakdown;provider:ProviderSnapshot}){
  return sha(stable({
    voice:{id:input.voice.adminId||input.voice.id,speakerId:input.voice.speakerId,engine:'volcano',active:input.voice.isActive!==false},
    model:input.target,
    pricing:input.price.pricing,
    provider:{source:input.provider.source,bindingId:input.provider.bindingId,credentialFingerprint:input.provider.credentialFingerprint},
  }));
}

function acceptanceEvidence(fingerprint:string){
  const value=testDependencies?.acceptanceEvidence?.(fingerprint)??get<CommerceVoiceAcceptanceEvidence>('settings',`voice-acceptance-${fingerprint}`,'system');
  if(!value||value.schema!=='commerce-voice-acceptance/v1'||value.status!=='published'||value.fingerprint!==fingerprint)return;
  if(!/^[a-f0-9]{64}$/u.test(value.evidenceHash)||!/^[a-f0-9]{64}$/u.test(value.resultSha256)||!value.providerTaskId||!value.publishedBy)return;
  return value;
}

export async function commerceVoiceCatalog():Promise<CommerceVoiceCatalogEntry[]>{
  const provider=await providerSnapshot();
  return catalogRows().map(voice=>{
    const target=targetFor(voice.speakerId),cost=pricing(1,target.modelId);
    const amounts=normalizedQuoteAmounts(cost);
    const fingerprint=cost&&amounts&&provider.configured?voiceAcceptanceFingerprint({voice,target,price:cost,provider}):undefined;
    const generationReady=Boolean(fingerprint&&acceptanceEvidence(fingerprint));
    return {
      voiceId:String(voice.adminId||voice.id),name:voice.name,description:String(voice.description||''),gender:String(voice.gender||'neutral'),language:String(voice.language||'zh'),
       engine:'volcano' as const,speakerId:voice.speakerId,...target,available:provider.configured,priceConfigured:Boolean(amounts),generationReady,
       ...(!generationReady?{readinessMessage:'真实语音验收证据尚未发布；当前只允许查看配置和准确报价。'}:{}),
    };
  });
}

export async function freezeCommerceVoiceInput(value:{voiceId:string;text:string;parameters?:Partial<CommerceVoiceParameters>}):Promise<FrozenCommerceVoiceInput>{
  const voiceId=String(value.voiceId||'').trim(),text=String(value.text||'').trim();
  if(!text)throw new CommerceVoiceBridgeError('VOICE_TEXT_REQUIRED','请填写要合成的文字');
  if([...text].length>5000)throw new CommerceVoiceBridgeError('VOICE_TEXT_TOO_LONG','合成文字超过 5000 字上限');
  const voice=catalogRows().find(row=>String(row.adminId||row.id)===voiceId);
  if(!voice)throw new CommerceVoiceBridgeError('VOICE_NOT_AVAILABLE','所选音色不存在、已停用或当前账号不可用');
  const target=targetFor(voice.speakerId),parameters=normalizeParameters(value.parameters);
  const price=pricing([...text].length,target.modelId);
  const amounts=normalizedQuoteAmounts(price);
  if(!price||!amounts){
    throw new CommerceVoiceBridgeError('VOICE_PRICE_NOT_CONFIGURED','当前语音模型未配置有效成本价和现金售价，本次未调用上游、未扣费。',503);
  }
  const provider=await providerSnapshot();
  if(!provider.configured)throw new CommerceVoiceBridgeError('VOICE_PROVIDER_CONFIGURATION_REQUIRED','语音供应商凭据未完成配置，本次未调用上游、未扣费。',503);
  const acceptanceFingerprint=voiceAcceptanceFingerprint({voice,target,price,provider});
  return {
    voiceId,voiceName:voice.name,speakerId:voice.speakerId,engine:'volcano',...target,
    configHash:configHash({voice,target,price,provider,parameters}),acceptanceFingerprint,text,textHash:sha(text),textLength:[...text].length,parameters,
    payableTotal:amounts.payableTotal,costAmount:amounts.costAmount,
  };
}

export async function assertCommerceVoiceInputCurrent(input:FrozenCommerceVoiceInput){
  const current=await freezeCommerceVoiceInput({voiceId:input.voiceId,text:input.text,parameters:input.parameters});
  if(current.textHash!==input.textHash||current.modelId!==input.modelId||current.providerModelId!==input.providerModelId||current.providerResourceId!==input.providerResourceId||current.configHash!==input.configHash||current.acceptanceFingerprint!==input.acceptanceFingerprint||current.payableTotal!==input.payableTotal||current.costAmount!==input.costAmount){
    throw new CommerceVoiceBridgeError('VOICE_CONFIGURATION_CHANGED','音色、模型、价格或供应商配置已变化，请重新获取报价；本次未调用上游。',409);
  }
  return current;
}

export function assertCommerceVoiceAcceptanceCurrent(input:FrozenCommerceVoiceInput){
  const evidence=acceptanceEvidence(input.acceptanceFingerprint);
  if(!evidence)throw new CommerceVoiceBridgeError('VOICE_ACCEPTANCE_EVIDENCE_INCOMPLETE','真实语音生成尚未完成受控验收并发布证据；本次未调用上游、未扣费。',409);
  return evidence;
}

function decodeDataAudio(url:string){
  const match=/^data:(audio\/(?:mpeg|mp3|wav|x-wav|ogg));base64,([A-Za-z0-9+/=\s]+)$/u.exec(url);
  if(!match)return;
  const type=match[1]==='audio/mp3'?'audio/mpeg':match[1]==='audio/x-wav'?'audio/wav':match[1] as CommerceVoiceExecutionResult['type'];
  const bytes=Buffer.from(match[2].replace(/\s/gu,''),'base64');
  if(bytes.length<1||bytes.length>150*1024*1024)throw new CommerceVoiceKnownFailure('VOICE_RESULT_SIZE_INVALID','供应商返回的音频大小无效');
  return {bytes,type};
}
async function loadAudio(url:string){
  const inline=decodeDataAudio(url);if(inline)return inline;
  const result=await safeFetch(url,{maxBytes:150*1024*1024,timeoutMs:30_000,maxRedirects:3});
  const raw=result.contentType.split(';',1)[0].toLowerCase(),type=raw==='audio/mp3'?'audio/mpeg':raw==='audio/x-wav'?'audio/wav':raw;
  if(!['audio/mpeg','audio/wav','audio/ogg'].includes(type))throw new CommerceVoiceKnownFailure('VOICE_RESULT_CONTENT_FORBIDDEN','供应商返回了非音频内容');
  return {bytes:result.buffer,type:type as CommerceVoiceExecutionResult['type']};
}

async function productionExecutor(input:FrozenCommerceVoiceInput,attemptId:string):Promise<CommerceVoiceExecutionResult>{
  const format=input.parameters.format==='ogg'?'ogg_opus':input.parameters.format;
  const response=await synthesizeSpeech({
    text:input.text,speaker:input.speakerId,model:input.providerModelId,resourceId:input.providerResourceId,pitch:input.parameters.pitch,
    audioParams:{format,sample_rate:input.parameters.sampleRate,speech_rate:Math.round((input.parameters.speedRatio-1)*100),emotion:input.parameters.emotion},
  });
  const audio=await loadAudio(response.audioUrl);
  return {...audio,providerTaskId:String(response.logId||attemptId),duration:Number(response.duration)||undefined};
}

export async function executeCommerceVoice(input:FrozenCommerceVoiceInput,attemptId:string){
  await assertCommerceVoiceInputCurrent(input);
  assertCommerceVoiceAcceptanceCurrent(input);
  const result=await (testDependencies?.executor||productionExecutor)(input,attemptId);
  if(!result?.bytes?.length||!['audio/mpeg','audio/wav','audio/ogg'].includes(result.type)||!result.providerTaskId)throw new CommerceVoiceKnownFailure('VOICE_PROVIDER_RESULT_INVALID','供应商未返回可保存的音频结果');
  return result;
}

export function classifyCommerceVoiceFailure(error:unknown):{known:boolean;code:string}{
  if(error instanceof CommerceVoiceKnownFailure)return {known:true,code:error.code};
  if(error instanceof CommerceVoiceBridgeError)return {known:true,code:error.code};
  const message=error instanceof Error?error.message:String(error||'');
  const http=message.match(/(?:VOICE_PROVIDER_HTTP_|火山引擎API HTTP错误:\s*)(400|401|402|403|404|413|422|429)(?:\D|$)/u);
  if(http)return {known:true,code:`VOICE_PROVIDER_HTTP_${http[1]}`};
  return {known:false,code:/^[A-Z][A-Z0-9_: -]{2,90}$/u.test(message)?message:'VOICE_PROVIDER_RESULT_UNCONFIRMED'};
}
