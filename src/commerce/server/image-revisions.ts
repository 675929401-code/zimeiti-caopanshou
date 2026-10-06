import {get,put,db} from './store';
import {job,publicJob,type JobInput,type Job} from './jobs';
import {selectedModel} from './models';
import {readAsset} from './assets';
import {modelIdentity} from './model-identity';
import {resolveOperation} from './operation-routing';
import {getImageInputContract,validateImageInput} from '../image-input-contract';
import {orderImageReferenceInstances,type ImageReferenceDocument} from '../shared/image-reference-mentions';
import {prepareImageReferenceInput,verifyImageReferenceBytes,verifyImageReferenceSnapshot} from './image-reference-context';
import {imageRevisionRouteIdentity,imageRevisionSourceIdentity,imageRevisionInputIdentity,findUnsettledImageRevision,type ImageQuote} from './image-revision-claim';
import {createCommerceJobQuote} from './quotes';
export type {ImageQuote} from './image-revision-claim';

function original(owner:string,id:string){
  const value=job(id,owner);
  if(!value||value.input.kind!=='image'||value.status!=='succeeded'||!value.assetIds.length)throw Error('请选择已经生成成功的图片');
  return value;
}

/** Stable migration candidates come from the original reference positions, never
 * recent assets. Missing IDs remain visible rather than silently filtered out. */
export function imageRevisionReferenceContext(owner:string,source:Job){
  const references=(source.input.references||[]).map((r,index)=>{
    const asset=readAsset(r.id,owner);
    return {id:r.id,instanceId:r.instanceId||`legacy:${source.id}:${index}`,slot:r.slot,name:asset?.name||'素材已删除',...(!asset?{unavailable:true}:{})};
  });
  const ordered=orderImageReferenceInstances(references.map(r=>({instanceId:r.instanceId,assetId:r.id,slot:r.slot,name:r.name})),getImageInputContract(source.input.skillId).slots.map(s=>s.id));
  return {references:ordered.map(r=>references.find(item=>item.instanceId===r.instanceId)!),document:source.input.imageReferenceDocument,legacy:!source.input.imageReferenceDocument};
}

export function imageRevisions(owner:string,id:string){
  const source=original(owner,id);
  const unsettled=findUnsettledImageRevision(owner,id,'');
  const quotes=db().prepare("SELECT value FROM records WHERE bucket='image-revisions' AND owner=? AND json_extract(value,'$.originalJobId')=? AND json_extract(value,'$.jobId') IS NOT NULL ORDER BY updated DESC").all(owner,id).map(row=>JSON.parse(String(row.value)) as ImageQuote);
  return {original:publicJob(source),referenceContext:imageRevisionReferenceContext(owner,source),unsettledJob:unsettled?publicJob(unsettled):undefined,versions:quotes.map(q=>{
    const value=q.jobId?job(q.jobId,owner):undefined;
    return {id:q.id,prompt:q.input.prompt,imageReferenceDocument:q.input.imageReferenceDocument,createdAt:q.createdAt,job:value?publicJob(value):undefined};
  })};
}

export async function quoteImageRevision(owner:string,id:string,prompt:string,imageReferenceDocument?:ImageReferenceDocument){
  const source=original(owner,id);
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>16000)throw Error('请输入 1–16000 字的图片创作要求');
  if(source.input.imageReferenceDocument&&imageReferenceDocument===undefined)throw Error('原图包含图片提及，请同步提交编辑后的引用文档');
  verifyImageReferenceSnapshot(owner,source.input,source.imageReferenceSnapshot);
  const quoteId=crypto.randomUUID();
  const {imageReferenceDocument:_oldDocument,...base}=source.input;
  const context=imageRevisionReferenceContext(owner,source);
  const route=resolveOperation({kind:'image',skillId:source.input.skillId,purpose:source.input.purpose});
  const proposed:JobInput={...base,requestId:quoteId,modelId:route.modelId,prompt,regenerationOf:id,imageRevisionQuoteId:quoteId,
    ...(imageReferenceDocument!==undefined?{imageReferenceDocument,references:context.references.map(r=>({id:r.id,slot:r.slot,instanceId:r.instanceId}))}:{})};
  const prepared=prepareImageReferenceInput(owner,proposed);
  await verifyImageReferenceBytes(owner,prepared.input,prepared.snapshot);
  const model=await selectedModel('image',route.modelId);
  const assets=(prepared.input.references||[]).map(r=>{const a=readAsset(r.id,owner);if(!a)throw Error('参考图片已删除或不属于当前账号');return a;});
  validateImageInput(prepared.input,assets,model.capabilities);
  const priced=await createCommerceJobQuote(owner,prepared.input),stored=get<{input:Omit<JobInput,'requestId'>;taskRequestId:string}>('commerce-quotes',priced.id,owner);if(!stored?.taskRequestId)throw Error('统一报价任务快照缺失');const claimedInput={...stored.input,requestId:stored.taskRequestId} as JobInput;
  const quote:ImageQuote={version:2,id:quoteId,owner,originalJobId:id,createdAt:Date.now(),expiresAt:priced.expiresAt,input:claimedInput,
    estimatedPrice:priced.payableTotal,commerceQuoteId:priced.id,sourceFingerprint:imageRevisionSourceIdentity(source),inputFingerprint:imageRevisionInputIdentity(claimedInput),
    modelFingerprint:modelIdentity(model),routeFingerprint:imageRevisionRouteIdentity(claimedInput),imageReferenceSnapshot:prepared.snapshot};
  // The transaction in createJob owns the one-time claim. No job at quote stage.
  put('image-revisions',quote.id,owner,quote);
  return {...priced,prompt:quote.input.prompt,imageReferenceDocument:quote.input.imageReferenceDocument};
}
