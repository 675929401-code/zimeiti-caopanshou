import {get,put} from './store';
import type {JobInput} from './jobs';
import type {AssistSession} from './prompt-assist';
import type {Model} from './models';
import {modelIdentity,ModelChangedBeforeDispatch} from './model-identity';
import {createHash} from 'node:crypto';
import {operationFor} from './operation-routing';
import {template} from './prompts';
import type {AssistApplication} from './prompt-assist-schema';
import type {AssistStage} from './reference-video-schema';
type AssistClaimQuote={id:string;sessionId:string;revision:number;stage:AssistStage;input:JobInput;expiresAt:number;jobId?:string;modelFingerprint:string;routeFingerprint:string};
export function assistRouteIdentity(input:JobInput){const route=operationFor(input),prompt=template(route.promptId);return createHash('sha256').update(JSON.stringify({id:route.id,revision:route.revision,routeDefaultModelId:route.modelId,promptId:prompt.id,promptVersion:prompt.version,prompt:prompt.content})).digest('hex');}
export function verifyAssistDispatch(owner:string,input:JobInput,model:Model){if(!input.purpose?.startsWith('prompt-assist.'))return;const q=get<AssistClaimQuote>('prompt-assist-quotes',input.assistQuoteId||'',owner);if(!q||JSON.stringify(q.input)!==JSON.stringify(input)||!q.jobId&&q.expiresAt<Date.now())throw Error('帮我写需要有效的费用确认');if(modelIdentity(model)!==q.modelFingerprint||assistRouteIdentity(input)!==q.routeFingerprint)throw new ModelChangedBeforeDispatch();const s=get<AssistSession>('prompt-assists',q.sessionId,owner);if(!s||q.jobId&&s.activeJobId!==q.jobId)throw new ModelChangedBeforeDispatch();if(input.purpose==='prompt-assist.breakdown'||input.purpose==='prompt-assist.remix-script'){const payload=JSON.parse(input.prompt),assetId=payload.evidence?.assetId||payload.sourceVideoAssetId,sha256=payload.evidence?.sha256||payload.sourceVideoSha256;if(s.referenceRevision!==payload.referenceRevision||s.referenceVideo?.assetId!==assetId||s.referenceVideo?.sha256!==sha256)throw new ModelChangedBeforeDispatch();}}
export function verifyAssistApplication(owner:string,input:JobInput){if(!input.assistApplicationId)return;const a=get<AssistApplication>('prompt-assist-applications',input.assistApplicationId,owner);const s=a?get<AssistSession>('prompt-assists',a.sessionId,owner):undefined;if(!a||!s||s.activeJobId||s.currentVersionId!==a.versionId||s.script!==a.script||s.analysisJobId!==a.sourceAnalysisJobId||a.sourceBreakdownJobId&&s.breakdownJobId!==a.sourceBreakdownJobId||input.kind!=='video'||a.script!==input.prompt||a.scriptJobId!==input.parentJobId||JSON.stringify(a.references)!==JSON.stringify(input.references||[])||a.videoSettings.duration!==input.duration||a.videoSettings.aspectRatio!==input.aspectRatio||a.videoSettings.resolution!==input.resolution||a.videoSettings.generateAudio!==(input.generateAudio??true))throw Error('脚本应用版本与当前正文、素材或视频设置不一致，请重新应用或解除来源绑定');}
// Called inside createJob's transaction. No asynchronous work or model dispatch here.
export function claimAssist(owner:string,input:JobInput,jobId:string,model:Model){
 if(!input.purpose?.startsWith('prompt-assist.'))return;
 const q=get<AssistClaimQuote>('prompt-assist-quotes',input.assistQuoteId||'',owner);
 if(!q||JSON.stringify(q.input)!==JSON.stringify(input)||q.expiresAt<Date.now())throw Error('帮我写需要有效的费用确认');
 if(modelIdentity(model)!==q.modelFingerprint||assistRouteIdentity(input)!==q.routeFingerprint)throw new ModelChangedBeforeDispatch();
 const s=get<AssistSession>('prompt-assists',q.sessionId,owner);
 if(!s||s.revision!==q.revision||s.activeJobId)throw Error('帮我写内容已更新或已有任务，请重新读取');
 s.activeJobId=jobId;s.activeStage=q.stage;s.error=undefined;s.history.push(jobId);s.revision++;s.updatedAt=Date.now();q.jobId=jobId;
 put('prompt-assists',s.id,owner,s);put('prompt-assist-quotes',q.id,owner,q);
}
