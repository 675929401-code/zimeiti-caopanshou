import {get,put,db} from './store';
import {resolveOperation} from './operation-routing';
import {template} from './prompts';
import {modelIdentity,ModelChangedBeforeDispatch} from './model-identity';
import {imageSnapshotHash,verifyImageReferenceSnapshot,type ImageReferenceSnapshot} from './image-reference-context';
import type {Job,JobInput} from './jobs';
import type {Model} from './models';

export type ImageQuote={version?:2;id:string;owner:string;originalJobId:string;createdAt:number;expiresAt:number;input:JobInput;estimatedPrice:number|null;commerceQuoteId?:string;jobId?:string;sourceFingerprint?:string;inputFingerprint?:string;modelFingerprint?:string;routeFingerprint?:string;imageReferenceSnapshot?:ImageReferenceSnapshot};
/** Query the complete job bucket; recent-list limits are not authorization. */
export function findUnsettledImageRevision(owner:string,originalJobId:string,exceptRequestId:string){
  const row=db().prepare("SELECT value FROM records WHERE bucket='jobs' AND owner=? AND json_extract(value,'$.input.regenerationOf')=? AND coalesce(json_extract(value,'$.input.requestId'),'')<>? AND json_extract(value,'$.status') IN ('queued','running','processing','saving','unknown','save_failed') LIMIT 1").get(owner,originalJobId,exceptRequestId);
  return row?JSON.parse(String(row.value)) as Job:undefined;
}
export function imageRevisionRouteIdentity(input:JobInput){const route=resolveOperation({...input,modelId:undefined}),prompt=template(route.promptId);return imageSnapshotHash({id:route.id,revision:route.revision,modelId:route.modelId,promptId:prompt.id,promptVersion:prompt.version,prompt:prompt.content});}
export function imageRevisionSourceIdentity(source:Job){return imageSnapshotHash({id:source.id,owner:source.owner,input:source.input,assetIds:source.assetIds,imageReferenceSnapshot:source.imageReferenceSnapshot,imageTextProvenance:source.imageTextProvenance});}
export function imageRevisionInputIdentity(input:JobInput){
  // A formerly adaptive original has already resolved to the accepted ratio.
  // No other input field is silently normalized during confirmation.
  return imageSnapshotHash(input);
}

export function verifyImageRevisionDispatch(owner:string,input:JobInput,model:Model,snapshot:ImageReferenceSnapshot|undefined){
  if(!input.imageRevisionQuoteId)return;
  const q=get<ImageQuote>('image-revisions',input.imageRevisionQuoteId,owner);
  if(!q||q.version!==2||q.input.requestId!==input.requestId||q.originalJobId!==input.regenerationOf||(!q.jobId&&q.expiresAt<Date.now()))throw Error('单图重生成需要有效的费用确认');
  const source=get<Job>('jobs',q.originalJobId,owner);
  if(!source||source.status!=='succeeded'||source.input.kind!=='image'||!source.assetIds.length||imageRevisionSourceIdentity(source)!==q.sourceFingerprint)throw Error('原图及来源快照已改变，请重新查看费用');
  if(imageRevisionInputIdentity(input)!==q.inputFingerprint||imageSnapshotHash(q.imageReferenceSnapshot??null)!==imageSnapshotHash(snapshot??null))throw Error('单图重生成正文、参数或图片引用与费用确认不一致');
  verifyImageReferenceSnapshot(owner,input,q.imageReferenceSnapshot);
  if(modelIdentity(model)!==q.modelFingerprint||imageRevisionRouteIdentity(input)!==q.routeFingerprint)throw new ModelChangedBeforeDispatch();
}

/** Called synchronously inside createJob's existing claim transaction. */
export function claimImageRevision(owner:string,input:JobInput,jobId:string,model:Model,snapshot:ImageReferenceSnapshot|undefined){
  if(!input.imageRevisionQuoteId)return;
  verifyImageRevisionDispatch(owner,input,model,snapshot);
  const q=get<ImageQuote>('image-revisions',input.imageRevisionQuoteId,owner)!;
  if(q.jobId&&q.jobId!==jobId)throw Error('该费用确认已有原任务，请读取原任务');
  q.jobId=jobId;put('image-revisions',q.id,owner,q);
}
