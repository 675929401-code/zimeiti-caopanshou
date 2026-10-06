import {createHash,randomUUID} from 'node:crypto';
import {getImageInputContract,validateImageTextSources,type ImageTextSource} from '../image-input-contract';
import {get,put,remove} from './store';
import type {JobInput} from './jobs';

export type ImageExecutionContext={imageWorkflowContext:{workflowId:string;targetNodeId:string}};
export type ImageTextProvenance={version:1;workflowId:string;targetNodeId:string;sourceJobId?:string;sources:readonly ImageTextSource[];snapshotHash:string};
type StoredWorkflow={id:string;owner:string;status:string;nodes:{id:string;data:{kind:string;skillId?:string;mode?:string}}[];edges:{source:string;target:string;data?:{edgeType?:string}}[];steps:Record<string,{requestId:string;status:string;output?:{text:string}}>};
type SourceJob={id:string;owner:string;status:string;input:JobInput;assetIds:string[];imageTextProvenance?:ImageTextProvenance};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function verifiedSources(skillId:string,sources:readonly ImageTextSource[]){const checked=validateImageTextSources(skillId,sources);if(checked.some(s=>hash(s.text)!==s.contentHash))throw Error('脚本文本来源指纹与内容不一致');return checked;}

export type StagedCardCanaryImageTextWorkflow={executionContext:ImageExecutionContext;scriptTextHash:string;cleanup:()=>void};

// Card canaries must exercise the same persisted-workflow provenance gate as
// ordinary canvas jobs. This helper is server-only: it stages one succeeded
// text node and the exact target request, then the caller removes the fixture
// immediately after createJob has persisted the immutable provenance snapshot.
export function stageCardCanaryImageTextWorkflow(owner:string,input:JobInput,rawScriptText:unknown):StagedCardCanaryImageTextWorkflow|undefined {
 if(input.kind!=='image')return undefined;
 const contract=getImageInputContract(input.skillId);
 if(!contract.minTextReferences)return undefined;
 if(typeof rawScriptText!=='string'||!rawScriptText.trim()||rawScriptText.length>20000)throw Error('脚本故事版 canary 需要提供 1—20000 字的完整脚本文本');
 const scriptText=rawScriptText.trim(),sourceNodeId=`card-canary-script-${randomUUID()}`,targetNodeId=`card-canary-image-${randomUUID()}`,workflowId=`card-canary-workflow-${randomUUID()}`;
 const source:ImageTextSource={sourceNodeId,text:scriptText,contentHash:hash(scriptText),role:'instruction'};
 verifiedSources(contract.skillId,[source]);
 const workflow:StoredWorkflow={
  id:workflowId,owner,status:'running',
  nodes:[
   {id:sourceNodeId,data:{kind:'text',mode:'input'}},
   {id:targetNodeId,data:{kind:'image',skillId:contract.skillId,mode:'generate'}},
  ],
  edges:[{source:sourceNodeId,target:targetNodeId,data:{edgeType:'instruction'}}],
  steps:{
   [sourceNodeId]:{requestId:`card-canary-source-${randomUUID()}`,status:'succeeded',output:{text:scriptText}},
   [targetNodeId]:{requestId:input.requestId,status:'pending'},
  },
 };
 put('workflows',workflow.id,owner,workflow);
 return {
  executionContext:{imageWorkflowContext:{workflowId,targetNodeId}},
  scriptTextHash:source.contentHash,
  cleanup:()=>remove('workflows',workflow.id,owner),
 };
}

// executionContext is an internal third argument, never sourced from API input.
// Invoke inside the job-claim transaction to bind the same stored graph version.
export function resolveImageTextProvenance(owner:string,input:JobInput,executionContext?:ImageExecutionContext):ImageTextProvenance|undefined {
 if(input.kind!=='image')return undefined;
 const contract=getImageInputContract(input.skillId);if(!contract.minTextReferences)return undefined;
 if(input.regenerationOf){
  const original=get<SourceJob>('jobs',input.regenerationOf,owner),saved=original?.imageTextProvenance;
  if(!original||original.owner!==owner||original.status!=='succeeded'||original.input.kind!=='image'||original.input.skillId!==contract.skillId||!original.assetIds.length||!saved||saved.version!==1)throw Error('故事版重生成需要同账号成功原图及已验证的脚本来源');
  // G12 may explicitly upgrade a legacy reference with an instanceId. Preserve
  // role and within-role order semantics; extra identity metadata is validated
  // independently by G12 and must not make an otherwise identical source fail.
  const referenceOrder=(refs:JobInput['references'])=>(refs||[]).map((r,index)=>({id:r.id,slot:r.slot,index})).sort((a,b)=>contract.slots.findIndex(s=>s.id===a.slot)-contract.slots.findIndex(s=>s.id===b.slot)||a.index-b.index).map(({id,slot})=>({id,slot}));
  if(JSON.stringify(referenceOrder(original.input.references))!==JSON.stringify(referenceOrder(input.references)))throw Error('故事版重生成的参考素材与原图来源不一致');
  const sources=verifiedSources(contract.skillId,saved.sources);
  if(hash(JSON.stringify(sources))!==saved.snapshotHash)throw Error('原故事版脚本来源快照已变化');
  return {...saved,sources,sourceJobId:original.id};
 }
 const context=executionContext?.imageWorkflowContext;
 if(!context||typeof context.workflowId!=='string'||typeof context.targetNodeId!=='string')throw Error('脚本故事版需要从已保存画布连接脚本文本后执行');
 const workflow=get<StoredWorkflow>('workflows',context.workflowId,owner);
 if(!workflow||workflow.owner!==owner||!['running','waiting'].includes(workflow.status))throw Error('故事版所属画布任务不存在、已结束或不属于当前账号');
 const target=workflow.nodes.find(n=>n.id===context.targetNodeId),step=workflow.steps[context.targetNodeId];
 if(!target||target.data.kind!=='image'||target.data.mode==='input'||target.data.skillId!==contract.skillId||!step||step.requestId!==input.requestId)throw Error('故事版节点、技能或请求号与已保存画布不一致');
 const candidates:ImageTextSource[]=[];
 for(const edge of workflow.edges.filter(e=>e.target===target.id)){
  const role=edge.data?.edgeType||'reference';if(role==='derived')continue;
  if(!['instruction','reference'].includes(role))throw Error('故事版文本连线类型无效');
  const node=workflow.nodes.find(n=>n.id===edge.source),sourceStep=workflow.steps[edge.source];
  if(!node||sourceStep?.status!=='succeeded')throw Error('故事版上游素材或脚本尚未完成');
  if(node.data.kind!=='text')continue;
  const text=sourceStep.output?.text;if(typeof text!=='string')throw Error('故事版脚本文本输出不存在');
  candidates.push({sourceNodeId:node.id,text,contentHash:hash(text),role:role as ImageTextSource['role']});
 }
 const sources=verifiedSources(contract.skillId,candidates);
 return {version:1,workflowId:workflow.id,targetNodeId:target.id,sources,snapshotHash:hash(JSON.stringify(sources))};
}

export function imageTextSourceInstruction(provenance:ImageTextProvenance|undefined,prompt:string){
 // Initial workflow prompts normally already include their script. If a single
 // image revision rewrites the prompt, retain the proven script independently.
 const missing=provenance?.sources.filter(source=>!prompt.includes(source.text))||[];
 return missing.length?'\n已验证脚本文本参考：\n'+missing.map((s,i)=>`脚本${i+1}（${s.sourceNodeId}）：\n${s.text}`).join('\n\n'):'';
}
