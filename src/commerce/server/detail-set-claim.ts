import {createHash} from 'node:crypto';
import {get,put} from './store';
import type {JobInput} from './jobs';
import type {Model} from './models';
import {modelIdentity,ModelChangedBeforeDispatch} from './model-identity';
import {resolveOperation} from './operation-routing';
import {template} from './prompts';
import type {DetailSession,DetailQuote,DetailRun} from './detail-sets';

export function detailRouteIdentity(input:JobInput){const route=resolveOperation({...input,modelId:undefined}),prompt=template(route.promptId);return createHash('sha256').update(JSON.stringify({id:route.id,revision:route.revision,modelId:route.modelId,promptId:prompt.id,promptVersion:prompt.version,prompt:prompt.content})).digest('hex');}
export function verifyDetailDispatch(owner:string,input:JobInput,model:Model){if(!input.purpose?.startsWith('detail-set.'))return;const q=get<DetailQuote>('detail-set-quotes',input.detailQuoteId||'',owner);if(!q||(!q.jobId&&!q.runId&&q.expiresAt<Date.now()))throw new ModelChangedBeforeDispatch();if(modelIdentity(model)!==q.modelFingerprint||detailRouteIdentity(input)!==q.routeFingerprint)throw new ModelChangedBeforeDispatch();}
// Synchronous, called from createJob's existing SQLite transaction before insertion.
export function claimDetailSet(owner:string,input:JobInput,jobId:string,model:Model){
 if(!input.purpose?.startsWith('detail-set.'))return;
 const q=get<DetailQuote>('detail-set-quotes',input.detailQuoteId||'',owner);
 if(!q||(!q.jobId&&!q.runId&&q.expiresAt<Date.now()))throw Error('商详任务需要有效的费用确认');
 verifyDetailDispatch(owner,input,model);
 const s=get<DetailSession>('detail-sets',q.sessionId,owner);if(!s)throw Error('商详工作区不存在');
 if(q.stage==='analyze'){
  if(!q.input||JSON.stringify(q.input)!==JSON.stringify(input))throw Error('商详分析参数与费用确认不一致');
  if(s.revision!==q.revision||s.analysisActiveJobId||s.activeRunId)throw Error('商详内容已更新或已有任务，请重新读取');
  s.analysisActiveJobId=jobId;s.history.push(jobId);s.error=undefined;s.revision++;s.updatedAt=Date.now();q.jobId=jobId;
  put('detail-sets',s.id,owner,s);put('detail-set-quotes',q.id,owner,q);return;
 }
 const run=get<DetailRun>('detail-set-runs',input.detailRunId||'',owner);
 const item=run?.rows.find(r=>r.row.id===input.detailRowId);
 const expected=q.rows?.find(r=>r.row.id===input.detailRowId);
 if(!run||run.quoteId!==q.id||q.runId!==run.id||run.status!=='running'||s.activeRunId!==run.id||s.revision!==run.sessionRevision||!item||item.jobId||!expected||JSON.stringify(expected.input)!==JSON.stringify(input))throw Error('商详生成参数已变化或该屏已有任务，请读取原任务');
 if(run.rows.some(r=>r.jobId&&['queued','running','processing','saving','unknown'].includes(get<{status:string}>('jobs',r.jobId,owner)?.status||'')))throw Error('商详上一屏尚未结束，请查看原任务');
 item.jobId=jobId;item.error=undefined;run.error=undefined;run.updatedAt=Date.now();put('detail-set-runs',run.id,owner,run);
}
