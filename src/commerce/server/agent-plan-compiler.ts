import {createHash} from 'node:crypto';
import {readAsset,assetBytes} from './assets';
import {parseAgentPlan,type AgentPlanSpec,type PlanReference} from './agent-plan-schema';
import {getImageInputContract,validateImageInput,validateImageTextSources} from '../image-input-contract';
import {orderImageReferenceInstances,reconcileImageReferenceDocument,completeImageReferenceUpload,validateImageReferenceDocument,type ImageReferenceDocument,type ImageReferenceInstance} from '../shared/image-reference-mentions';
import type {WorkflowNode,WorkflowEdge} from './workflow-selection';
import type {Job} from './jobs';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export type PlanBoundReference={instanceId:string;sourceNodeId:string;source?:number;step?:string;slot:string;assetId:string|null;sha256?:string;name:string;type:string};
export type PlanStepBillingSnapshot={operationId:string;modelId:string;modelConfigHash:string;billingUnit:'per_use'|'output_second';quantity:number;unitCost:number;estimatedTotalCost:number;unitPrice:number;payableTotal:number};
export type PlanStepExecution={nodePrompt:string;prompt:string;kind:'image'|'video';skillId:string;references:PlanBoundReference[];document?:ImageReferenceDocument;textSources:{nodeId:string;text:string;contentHash:string;sourceScriptId?:string;originalText?:string;originalHash?:string}[];billingSnapshot?:PlanStepBillingSnapshot};
export type AgentPlanExecution={version:1;planId:string;sourceJobId:string;sourceReplyHash:string;sourceInputHash:string;quoteId?:string;quoteFingerprint?:string;clientRequestId?:string;releaseId?:string;releaseVersion?:number;manifestSha256?:string;steps:Record<string,PlanStepExecution>};
export type PlanPreview={fingerprint:string;sourceJobId:string;sourceInput:{text:string;sha256:string};sharedText:string;scripts:{id:string;text:string;sha256:string}[];steps:{id:string;label:string;kind:string;prompt:string;modelId?:string;modelLabel?:string;referencePrice?:number;aspectRatio?:string;resolution?:string;duration?:number;references:{number:number;instanceId:string;sourceNodeId:string;slot:string;assetId:string|null;name:string;sha256?:string}[]}[]};
type PlanNode=WorkflowNode&{type:string;position:{x:number;y:number}};
type PlanEdge=WorkflowEdge&{id:string;label:string};

function parseSource(source:Job){if(source.input.kind!=='agent'||source.status!=='succeeded')throw Error('计划来源对话已删除或尚未成功');const original=parseAgentPlan(source.text||'',source.input.references?.length||0);if(!original)throw Error('来源回复缺少有效计划');return original;}
function sameRef(a:PlanBoundReference,b:PlanBoundReference){return a.instanceId===b.instanceId;}
function selectMention(number:number,refs:PlanBoundReference[],scope:'source'|'step'|'legacy'){
 const globals=refs.filter(r=>r.source===number&&r.type.startsWith('image/')),local=refs[number-1];
 if(scope==='source'){if(globals.length!==1)throw Error(`共同要求或脚本的 @图片${number} 未绑定唯一来源角色，请在此步骤补齐引用或改成明确角色描述`);return globals[0];}
 if(scope==='step'){if(!local?.type.startsWith('image/'))throw Error(`@图片${number} 没有对应的步骤图片引用`);return local;}
 const possibilities=[...globals,...(local?.type.startsWith('image/')?[local]:[])].filter((r,i,all)=>all.findIndex(v=>sameRef(v,r))===i);
 if(possibilities.length!==1)throw Error(`@图片${number} 的本轮素材编号和步骤编号有歧义，请明确选择步骤编号或本轮素材编号`);
 return possibilities[0];
}

/** Bind each token to its declared source identity BEFORE role sorting. Only the
 * visible numbered label changes; references never rebind by filename/ordinal. */
function compileText(segments:{text:string;scope:'source'|'step'|'legacy'}[],refs:PlanBoundReference[],kind:'image'|'video',slots:string[]){
 const ordered=kind==='image'?orderImageReferenceInstances(refs.map(r=>({instanceId:r.instanceId,assetId:r.assetId,slot:r.slot,name:r.name})),slots):refs.map(r=>({instanceId:r.instanceId,assetId:r.assetId,slot:r.slot,name:r.name}));
 let text='';const mentions:ImageReferenceDocument['mentions']=[];
 for(const segment of segments){if(text)text+='\n\n';let cursor=0;for(const match of segment.text.matchAll(/@图片(\d+)/g)){const number=Number(match[1]);if(!Number.isSafeInteger(number)||number<1||String(number)!==match[1])throw Error('计划图片编号无效');const ref=selectMention(number,refs,segment.scope),index=ordered.findIndex(r=>r.instanceId===ref.instanceId);text+=segment.text.slice(cursor,match.index);const label=kind==='image'?'@图片'+(index+1):`参考${index+1}（${ref.slot}）`,start=text.length;text+=label;if(kind==='image')mentions.push({instanceId:ref.instanceId,assetId:ref.assetId,slot:ref.slot,label,start,end:text.length,status:ref.assetId?'resolved':'upload-pending'});cursor=match.index!+match[0].length;}text+=segment.text.slice(cursor);}
 if(text.length>20000)throw Error('共同要求、脚本与步骤合并后超过 20000 字，请精简后确认');
 const document:ImageReferenceDocument={version:1,text,mentions};
 if(kind==='image')validateImageReferenceDocument(document,text,ordered,slots,{allowUnresolved:true});
 return {text,document,ordered};
}

/** Source scripts are parsed JSON values from the persisted successful reply.
 * Comparing parsed values supports quotes/newlines without unsafe substring tests. */
export function compileAgentPlan(owner:string,planId:string,source:Job,spec:AgentPlanSpec,bindings:Record<string,string>){
 if(source.owner!==owner)throw Error('计划来源不属于当前账号');
 const original=parseSource(source);
 for(const script of spec.scripts||[]){const actual=original.scripts?.find(s=>s.id===script.id);if(!actual||actual.text!==script.text)throw Error('计划脚本与成功来源回复不一致，请返回对话修订脚本后重新准备');}
 const sourceAssets=(source.input.references||[]).map(r=>{const a=readAsset(r.id,owner);if(!a)throw Error('本轮计划参考素材已删除或不属于当前账号');if(a.type.startsWith('audio/'))throw Error('普通 Agent 计划尚不支持音频输入，请先提供文字');return a;});
 const shared=spec.sharedContext;
 const sharedText=[spec.summary.trim()?'确认的共同要求：\n'+spec.summary:'',shared?.product?'商品：'+shared.product:'',shared?.person?'人物：'+shared.person:'',shared?.style?'风格：'+shared.style:'',...(shared?.constraints||[]).map(s=>'保持约束：'+s),shared&&(shared.product||shared.person||shared.style||shared.constraints?.length)?'本次确认的商品、人物、风格及保持约束优先；共同要求概述用于补充未覆盖的信息。步骤只修改明确指定的目标，其他要求保持。':''].filter(Boolean).join('\n');
 const nodes:PlanNode[]=sourceAssets.map((a,i)=>({id:'source-'+(i+1),type:'commerce',position:{x:20,y:i*240},data:{label:a.name,kind:a.type.startsWith('image/')?'image':'video',mode:'input',assetIds:[a.id],prompt:''}}));
 const edges:PlanEdge[]=[],execution:AgentPlanExecution={version:1,planId,sourceJobId:source.id,sourceReplyHash:hash(source.text||''),sourceInputHash:hash(JSON.stringify(source.input)),steps:{}};
 const nodeIds=new Set(nodes.map(n=>n.id)),textNodes=new Map<string,string>();
 function textNode(text:string,label:string){const key=hash(text),existing=textNodes.get(key);if(existing)return existing;let id='context-'+key.slice(0,24);if(spec.steps.some(s=>s.id===id)||nodeIds.has(id))throw Error('计划步骤标识与脚本来源冲突');nodes.push({id,type:'commerce',position:{x:20,y:nodes.length*240},data:{label,kind:'text',mode:'input',prompt:text}});nodeIds.add(id);textNodes.set(key,id);return id;}
 for(const [index,step] of spec.steps.entries()){
  const contract=step.kind==='image'?getImageInputContract(step.skillId):undefined,slots=contract?.slots.map(s=>s.id)||[];
  const refs:PlanBoundReference[]=step.references.map((r:PlanReference)=>{const a=r.source?sourceAssets[r.source-1]:undefined;return {instanceId:'plan:'+planId+':'+step.id+':'+hash(JSON.stringify({source:r.source,step:r.step,slot:r.slot})).slice(0,20),sourceNodeId:r.step||'source-'+r.source,...(r.source?{source:r.source}:{step:r.step}),slot:r.slot,assetId:a?.id||null,...(a?{sha256:a.sha256}:{}),name:a?.name||'待生成：'+spec.steps.find(s=>s.id===r.step)?.label,type:a?.type||'image/png'};});
  if(new Set(refs.map(r=>r.instanceId)).size!==refs.length)throw Error(step.label+'：相同来源角色重复');
  if(step.kind==='image'){
   const ids=refs.map(r=>({id:r.assetId||'pending:'+r.sourceNodeId,slot:r.slot}));
   validateImageInput({skillId:step.skillId,prompt:step.prompt,references:ids},refs.map((r,i)=>({id:ids[i].id,type:r.type})));
  }
  const scripts=(step.scriptIds||[]).map(id=>spec.scripts!.find(s=>s.id===id)!);
  if(contract?.minTextReferences&&!scripts.length)throw Error(step.label+'：请在来源对话计划中提供 scripts 正文并用 scriptIds 连接，介绍文字不能代替脚本');
  const pieces:{text:string;scope:'source'|'step'|'legacy'}[]=[],textSources:PlanStepExecution['textSources']=[];
  if(sharedText){const common=compileText([{text:sharedText,scope:'source'}],refs,step.kind,slots);const id=textNode(common.text,'已确认共同要求');textSources.push({nodeId:id,text:common.text,contentHash:hash(common.text)});pieces.push({text:sharedText,scope:'source'});}
  for(const script of scripts){const prepared=compileText([{text:script.text,scope:'source'}],refs,step.kind,slots),id=textNode(prepared.text,'确认脚本：'+script.id);if(!textSources.some(s=>s.nodeId===id)){textSources.push({nodeId:id,text:prepared.text,contentHash:hash(prepared.text),sourceScriptId:script.id,originalText:script.text,originalHash:hash(script.text)});pieces.push({text:script.text,scope:'source'});}}
  pieces.push({text:'本步骤执行要求：\n'+step.prompt,scope:step.referenceNumbering||'legacy'});
  const compiled=compileText(pieces,refs,step.kind,slots),orderedRefs=compiled.ordered.map(r=>refs.find(v=>v.instanceId===r.instanceId)!);
  nodes.push({id:step.id,type:'commerce',position:{x:400+(index%2)*340,y:Math.floor(index/2)*280},data:{label:step.label,kind:step.kind,mode:'generate',prompt:step.prompt,modelId:bindings[step.id],skillId:step.skillId,aspectRatio:step.aspectRatio,resolution:step.resolution,duration:step.duration}});
  for(const ref of orderedRefs)edges.push({id:step.id+'-ref-'+ref.instanceId.slice(-20),source:ref.sourceNodeId,target:step.id,data:{role:ref.slot,edgeType:'reference'},label:ref.slot});
  for(const ref of textSources)edges.push({id:step.id+'-text-'+ref.nodeId,source:ref.nodeId,target:step.id,data:{edgeType:'instruction'},label:'已确认文字'});
  execution.steps[step.id]={nodePrompt:step.prompt,prompt:compiled.text,kind:step.kind,skillId:step.skillId,references:orderedRefs,...(step.kind==='image'?{document:compiled.document}:{}),textSources};
 }
 if(nodes.length>30)throw Error('计划素材、脚本与生成步骤合计超过 30 个执行节点，请拆成多个计划');
 const fingerprint=hash(JSON.stringify({spec,bindings,execution}));
 const preview:PlanPreview={fingerprint,sourceJobId:source.id,sourceInput:{text:source.input.prompt,sha256:hash(source.input.prompt)},sharedText,scripts:(spec.scripts||[]).map(s=>({...s,sha256:hash(s.text)})),steps:spec.steps.map(s=>({id:s.id,label:s.label,kind:s.kind,prompt:execution.steps[s.id].prompt,references:execution.steps[s.id].references.map((r,i)=>({number:i+1,instanceId:r.instanceId,sourceNodeId:r.sourceNodeId,slot:r.slot,assetId:r.assetId,name:r.name,...(r.sha256?{sha256:r.sha256}:{})}))}))};
 return {nodes,edges,execution,preview,sourceAssets};
}

export async function verifyPlanAssetBytes(owner:string,refs:{assetId:string|null;sha256?:string}[]){
 for(const ref of new Map(refs.filter(r=>r.assetId).map(r=>[r.assetId!,r])).values()){const a=readAsset(ref.assetId!,owner);if(!a||a.sha256!==ref.sha256||createHash('sha256').update(await assetBytes(a)).digest('hex')!==ref.sha256)throw Error('计划参考素材已改变，请重新预览并确认');}
}

/** Execution-only resolution of pending outputs. It never substitutes a different
 * source, drops references, or rewrites a failed mention to another instance. */
export function resolveAgentPlanInput(owner:string,target:WorkflowNode,nodes:WorkflowNode[],edges:WorkflowEdge[],steps:Record<string,{status?:string;output?:{text:string;assets:{id:string;slot:string}[]}}>,contract:PlanStepExecution){
 if(target.data.prompt!==contract.nodePrompt||target.data.kind!==contract.kind||target.data.skillId!==contract.skillId)throw Error('计划节点已改变，请重新确认执行计划');
 const incoming=edges.filter(e=>e.target===target.id&&e.data?.edgeType!=='derived');
 const expected=contract.references.length+contract.textSources.length;if(incoming.length!==expected)throw Error('计划引用连线已改变');
 const textSources=contract.textSources.map(s=>{const n=nodes.find(n=>n.id===s.nodeId),value=steps[s.nodeId];if(n?.data.kind!=='text'||value?.status!=='succeeded'||value.output?.text!==s.text||hash(value.output.text)!==s.contentHash||!incoming.some(e=>e.source===s.nodeId&&e.data?.edgeType==='instruction'))throw Error('计划已确认文本来源尚未成功或已改变');return {sourceNodeId:s.nodeId,text:s.text,contentHash:s.contentHash,role:'instruction' as const};});
 let document=contract.document;let instances:ImageReferenceInstance[]=contract.references.map(r=>({instanceId:r.instanceId,assetId:r.assetId,slot:r.slot,name:r.name}));
 const references=contract.references.map(ref=>{const value=steps[ref.sourceNodeId],outputs=value?.output?.assets;if(value?.status!=='succeeded'||outputs?.length!==1||!incoming.some(e=>e.source===ref.sourceNodeId&&e.data?.role===ref.slot&&e.data?.edgeType!=='instruction'))throw Error('计划参考来源尚未成功或没有唯一输出');const a=readAsset(outputs[0].id,owner);if(!a||ref.assetId&&(a.id!==ref.assetId||a.sha256!==ref.sha256||a.type!==ref.type)||!ref.assetId&&!a.type.startsWith('image/'))throw Error('计划参考素材类型、身份或指纹已改变');if(document&&ref.assetId===null){const filled=completeImageReferenceUpload(document,instances,getImageInputContract(contract.skillId).slots.map(s=>s.id),{instanceId:ref.instanceId,assetId:a.id});document=filled.document;instances=filled.references;}return {id:a.id,slot:ref.slot,...(contract.kind==='image'?{instanceId:ref.instanceId}:{})};});
 if(contract.kind==='image'){validateImageTextSources(contract.skillId,textSources);validateImageInput({skillId:contract.skillId,prompt:contract.prompt,references},references.map(r=>readAsset(r.id,owner)!));if(!document)throw Error('计划图片引用文档缺失');document=reconcileImageReferenceDocument(document,instances,getImageInputContract(contract.skillId).slots.map(s=>s.id));validateImageReferenceDocument(document,contract.prompt,instances,getImageInputContract(contract.skillId).slots.map(s=>s.id));}
 return {prompt:contract.prompt,references,textSources,...(document?{imageReferenceDocument:document}:{})};
}
