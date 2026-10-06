import {createHash} from 'node:crypto';
import {get,put,list} from './store';
import {readAsset} from './assets';
import {job,publicJob,type JobInput} from './jobs';
import {selectedModel} from './models';
import {modelIdentity} from './model-identity';
import {resolveOperation} from './operation-routing';
import {assistRouteIdentity} from './prompt-assist-claim';
import {normalizeReferenceAssist,clearAssistScript,recordAssistVersion,consumeReferenceResult,editReferenceAssist,quoteReferenceAssist} from './prompt-assist-reference';
import type {ReferenceAssistState,ReferenceAssistChanges,AssistStage} from './reference-video-schema';
import {assistConfig,defaultAssistConfig,productAnalysis,parseProductAnalysis,type AssistConfig,type AssistReference,type ProductAnalysis,type VideoSettings} from './prompt-assist-schema';
import {createCommerceJobQuote} from './quotes';

export type AssistSession = {id:string;owner:string;contextId:string;fingerprint:string;revision:number;createdAt:number;updatedAt:number;references:AssistReference[];videoSettings:VideoSettings;analysis?:ProductAnalysis;analysisJobId?:string;analysisEdited:boolean;config:AssistConfig;script?:string;scriptJobId?:string;activeJobId?:string;activeStage?:AssistStage;error?:string;history:string[]} & ReferenceAssistState;
type Quote = {id:string;owner:string;sessionId:string;revision:number;stage:AssistStage;input:JobInput;modelName:string;modelFingerprint:string;routeFingerprint:string;estimatedPrice:number|null;expiresAt:number;jobId?:string};
const pending = ['queued','running','processing','saving','unknown'];
const save=(s:AssistSession)=>{s.updatedAt=Date.now();put('prompt-assists',s.id,s.owner,s);return s;};
export function readAssist(owner:string,id:string):AssistSession {
 const s=get<AssistSession>('prompt-assists',id,owner);if(!s)throw Error('帮我写会话不存在');normalizeReferenceAssist(s);
 if(s.activeJobId){const result=job(s.activeJobId,owner);if(result&&['succeeded','failed'].includes(result.status)){
  if(result.status==='succeeded'){try{if(s.activeStage==='analyze'){s.analysis=parseProductAnalysis(result.text||'',s.references);s.analysisJobId=result.id;s.analysisEdited=false;clearAssistScript(s);}else if(result.input.purpose==='prompt-assist.breakdown'||result.input.purpose==='prompt-assist.remix-script'){consumeReferenceResult(s,result);}else{s.script=result.text;s.scriptJobId=result.id;recordAssistVersion(s,'generated');}s.error=undefined;}catch(error){s.error=(error as Error).message;}}
  else s.error=result.error||'任务失败';s.activeJobId=undefined;s.activeStage=undefined;s.revision++;save(s);
 }}return s;
}
export function publicAssist(s:AssistSession){const {owner,...rest}=s;const active=s.activeJobId?job(s.activeJobId,owner):undefined;return {...rest,activeJob:active?publicJob(active):undefined,assets:s.references.map(r=>{const a=readAsset(r.id,owner);return {id:r.id,name:a?.name||'素材已删除',url:'/api/commerce/assets/'+encodeURIComponent(r.id),type:a?.type||''};})};}
export function openAssist(owner:string,input:{contextId:string;references:AssistReference[];videoSettings:VideoSettings}) {
 if(!/^[a-f0-9-]{36}$/.test(input.contextId)||!Array.isArray(input.references)||input.references.length<1||input.references.length>9||new Set(input.references.map(r=>r.id)).size!==input.references.length)throw Error('请先添加 1–9 张不同的参考图片');
 const refs=input.references.map(r=>{const asset=readAsset(r.id,owner);if(!asset||!asset.type.startsWith('image/'))throw Error('帮我写素材分析目前支持图片；音视频理解尚待接入');return {id:asset.id,slot:'reference'};});
 const v=input.videoSettings;if(!v||!Number.isInteger(v.duration)||v.duration<4||v.duration>30||typeof v.generateAudio!=='boolean'||!['21:9','16:9','4:3','1:1','3:4','9:16','3:2','2:3'].includes(v.aspectRatio)||!['480p','720p','1080p','2k','4k'].includes(String(v.resolution).toLowerCase()))throw Error('视频参数无效');
 const videoSettings={duration:v.duration,aspectRatio:v.aspectRatio,resolution:v.resolution,generateAudio:v.generateAudio};
 const fingerprint=createHash('sha256').update(JSON.stringify({refs,videoSettings})).digest('hex');
 const existing=list<AssistSession>('prompt-assists',owner).find(s=>s.contextId===input.contextId&&s.fingerprint===fingerprint);if(existing)return readAssist(owner,existing.id);
 return save({id:crypto.randomUUID(),owner,contextId:input.contextId,fingerprint,revision:1,createdAt:Date.now(),updatedAt:Date.now(),references:refs,videoSettings,analysisEdited:false,config:{...defaultAssistConfig},history:[]});
}
export function editAssist(owner:string,id:string,revision:number,changes:{analysis?:ProductAnalysis;config?:AssistConfig;script?:string}&ReferenceAssistChanges) {
 const s=readAssist(owner,id);if(s.revision!==revision)throw Error('内容已在其他窗口更新，请重新读取');if(s.activeJobId)throw Error('请等待原任务结束后再修改');
 if(changes.analysis!==undefined){if(!s.analysis)throw Error('请先分析素材');const parsed=productAnalysis(changes.analysis,s.references);if(JSON.stringify(parsed)!==JSON.stringify(s.analysis)){s.analysis=parsed;s.analysisEdited=true;s.script=undefined;s.scriptJobId=undefined;}}
 if(changes.config!==undefined){const config=assistConfig(changes.config);if(JSON.stringify(config)!==JSON.stringify(s.config)){s.config=config;s.script=undefined;s.scriptJobId=undefined;}}
 editReferenceAssist(s,changes);
 if(changes.script!==undefined){if(!s.scriptJobId||typeof changes.script!=='string'||!changes.script.trim()||changes.script.length>10000)throw Error('脚本长度需为 1–10000 字');if(s.script!==changes.script){s.script=changes.script;recordAssistVersion(s,'edited');}}
 if(!s.script)s.currentVersionId=undefined;
 s.revision++;return save(s);
}
export async function quoteAssist(owner:string,id:string,revision:number,stage:AssistStage) {
 const s=readAssist(owner,id);if(s.revision!==revision)throw Error('内容已更新，请重新读取');if(s.activeJobId&&pending.includes(job(s.activeJobId,owner)?.status||''))throw Error('已有未结束任务，请查看原任务');if(!['analyze','breakdown','script'].includes(stage)||stage!=='analyze'&&!s.analysisJobId)throw Error('请先完成素材分析');if(stage==='breakdown'||stage==='script'&&s.generationMode==='reference')return quoteReferenceAssist(owner,s,stage);
 const purpose=stage==='analyze'?'prompt-assist.analyze':'prompt-assist.script';const route=resolveOperation({kind:'agent',purpose});const model=await selectedModel('agent',route.modelId);if(!model.capabilities.imageParsing)throw Error('后台配置的对话模型不支持图片理解，请联系管理员调整功能路由');
 const quoteId=crypto.randomUUID();const referenceElements=s.references.map((r,i)=>({id:r.id,mentionLabel:'@图片'+(i+1),fileName:readAsset(r.id,owner)?.name}));
 const task=stage==='analyze'?'请分析附带的参考图片，只执行商品素材分析，不要生成视频，也不要推荐视频软件。所有字段用中文填写，仅返回符合 outputSchema 的 JSON，不能使用 Markdown 或解释段落。':'请根据以下已经确认的素材分析、创作配置和视频参数，写出一份完整的可用于视频生成的脚本；只写脚本，不推荐软件，不声称视频已经生成。';
 const outputSchema={product:'商品名称',category:'商品类目',productFeatures:['图片中可见特性'],sellingPoints:['有证据的卖点'],audience:['建议受众'],scenes:['建议使用场景'],uncertainties:['无法从图片确认的事实'],references:referenceElements.map(r=>({id:r.id,description:'这张图中实际可见内容'}))};
 const prompt=JSON.stringify({task,referenceElements,...(stage==='analyze'?{outputSchema}:{videoSettings:s.videoSettings,sourceAnalysisJobId:s.analysisJobId,analysisPayloadSnapshot:s.analysis,analysisEdited:s.analysisEdited,...s.config})});
 const input:JobInput={requestId:quoteId,kind:'agent',modelId:model.id,prompt,purpose,references:s.references,assistQuoteId:quoteId,...(stage==='script'?{parentJobId:s.analysisJobId}:{})};
 const priced=await createCommerceJobQuote(owner,input),stored=get<{input:Omit<JobInput,'requestId'>;taskRequestId:string}>('commerce-quotes',priced.id,owner);if(!stored?.taskRequestId)throw Error('统一报价任务快照缺失');const claimedInput={...stored.input,requestId:stored.taskRequestId} as JobInput;const quote:Quote={id:quoteId,owner,sessionId:id,revision,stage,input:claimedInput,modelName:model.displayName,modelFingerprint:modelIdentity(model),routeFingerprint:assistRouteIdentity(claimedInput),estimatedPrice:priced.payableTotal,expiresAt:priced.expiresAt};put('prompt-assist-quotes',quoteId,owner,quote);return {...priced,stage};
}
