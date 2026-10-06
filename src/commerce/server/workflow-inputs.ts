import {resolveAgentPlanInput,type PlanStepExecution} from './agent-plan-compiler';
import {createHash} from 'node:crypto';
import {IMAGE_SKILLS} from '../components/commerce-agent/catalog';
import {readAsset} from './assets';
import {executionEdges,edgeType} from '../shared/canvas-schema';
import type {WorkflowNode,WorkflowEdge} from './workflow-selection';
import {validateImageInput,validateImageTextSources} from '../image-input-contract';
export type WorkflowOutput={text:string;assets:{id:string;slot:string}[]};
export type TextInstructionSource={sourceNodeId:string;kind:'text';text:string;contentHash:string;role:'instruction'|'reference'|'derived'};
export type MediaInstructionSource={sourceNodeId:string;kind:'image'|'video'|'audio';role:string|null;assets:{id:string;slot:string}[]};
export type InstructionSources={text:TextInstructionSource[];media:MediaInstructionSource[]};
export function verifyWorkflowRoles(nodes:WorkflowNode[],edges:WorkflowEdge[]){for(const edge of executionEdges(edges)){const source=nodes.find(n=>n.id===edge.source),target=nodes.find(n=>n.id===edge.target);if(!source||!target)throw Error('画布连线无效');if(source.data.kind==='text')continue;const slot=edge.data?.role;if(target.data.kind==='image'){const skill=IMAGE_SKILLS.find(s=>s.id===(target.data.skillId||'default'));if(!skill)throw Error('图片技能不存在');const role=slot||skill.slots.find(s=>s.kinds.includes(source.data.kind as 'image'|'video'|'audio'))?.id;if(!skill.slots.some(s=>s.id===role&&s.kinds.includes(source.data.kind as 'image'|'video'|'audio')))throw Error(`“${target.data.label}”的连线角色与图片技能不匹配`);}else if(target.data.kind==='video'&&slot&&(!['reference','sound'].includes(slot)||slot==='sound'&&source.data.kind!=='audio'||slot==='reference'&&source.data.kind==='audio'))throw Error('视频连线角色与素材类型不匹配');}}
export function workflowInput(owner:string,target:WorkflowNode,nodes:WorkflowNode[],edges:WorkflowEdge[],steps:Record<string,{status?:string;output?:WorkflowOutput}>,planStep?:PlanStepExecution){
 if(planStep)return {...resolveAgentPlanInput(owner,target,nodes,edges,steps,planStep),instructionSources:{text:[],media:[]} satisfies InstructionSources};
 const incoming=executionEdges(edges).filter(e=>e.target===target.id),firstSlot=(IMAGE_SKILLS.find(s=>s.id===target.data.skillId)||IMAGE_SKILLS[0]).slots[0]?.id||'reference';
 const textSources:TextInstructionSource[]=incoming.flatMap(e=>{const source=nodes.find(n=>n.id===e.source),text=steps[e.source]?.output?.text||'';return source?.data.kind==='text'?[{sourceNodeId:source.id,kind:'text' as const,text,contentHash:createHash('sha256').update(text).digest('hex'),role:edgeType(e)}]:[];});
 const mediaInstructions:MediaInstructionSource[]=incoming.filter(e=>edgeType(e)==='instruction').flatMap(e=>{const source=nodes.find(n=>n.id===e.source);if(!source||source.data.kind==='text')return [];const role=e.data?.role||null;const assets=(steps[e.source]?.output?.assets||[]).map(a=>{const asset=readAsset(a.id,owner);if(!asset)throw Error('上游输出素材不存在或不属于当前账号');return {id:a.id,slot:role||(target.data.kind==='video'&&asset.type.startsWith('audio/')?'sound':firstSlot)};});return assets.length?[{sourceNodeId:source.id,kind:source.data.kind as 'image'|'video'|'audio',role,assets}]:[];});
 const prompt=[...incoming.map(e=>steps[e.source]?.output?.text).filter(Boolean),target.data.prompt].join('\n\n');
 const references=[...incoming.filter(e=>edgeType(e)!=='instruction'),...incoming.filter(e=>edgeType(e)==='instruction'&&nodes.find(n=>n.id===e.source&&n.data.kind!=='text'))].flatMap(e=>(steps[e.source]?.output?.assets||[]).map(a=>{const asset=readAsset(a.id,owner);if(!asset)throw Error('上游输出素材不存在或不属于当前账号');return {id:a.id,slot:e.data?.role||(target.data.kind==='video'&&asset.type.startsWith('audio/')?'sound':firstSlot)};}));
 const seen=new Set<string>(),uniqueReferences=references.filter(r=>{const key=r.id+':'+r.slot;if(seen.has(key))return false;seen.add(key);return true;});
 const instructionSources:InstructionSources={text:textSources,media:mediaInstructions};
 // C-P2: 项目内 mention 文档按其正文与 UTF-16 范围作用域投影为图片引用文档；
 // 已解析编号把 instanceId 带进参考清单，编号绑定变化使指纹失效（见 nodeFingerprints）。
 const mentionDocument=target.data.kind==='image'?(target.data.mention_document??undefined):undefined;
 type ScopedReference={id:string;slot:string;instanceId?:string};
 const resolvedMentions=(mentionDocument?.mentions||[]).filter((m)=>m.status==='resolved'&&m.assetId&&m.instanceId);
 const scopedReferences:ScopedReference[]=resolvedMentions.length?uniqueReferences.map((r)=>({...r})):uniqueReferences;
 for(const m of resolvedMentions){
  const existing=scopedReferences.find((r)=>r.id===m.assetId);
  if(existing)existing.instanceId=m.instanceId!;
  else scopedReferences.push({id:m.assetId!,slot:m.slot||firstSlot,instanceId:m.instanceId!});
 }
 const imageReferenceDocument=mentionDocument&&resolvedMentions.length?{version:1,text:mentionDocument.text,mentions:resolvedMentions.map(m=>({instanceId:m.instanceId!,assetId:m.assetId,slot:m.slot,label:m.label,start:m.start,end:m.end,status:'resolved' as const}))}:undefined;
 if(target.data.kind==='image'){
  validateImageTextSources(target.data.skillId||'default',textSources);
  validateImageInput({skillId:target.data.skillId||'default',prompt,references:uniqueReferences},uniqueReferences.map(r=>readAsset(r.id,owner)!));
 }
 return {prompt,textSources,instructionSources,references:scopedReferences,imageReferenceDocument};
}
/** Pure canvas node → JobInput projection; no owner/state access so tests can check the request contract. */
export function canvasJobInput(node:WorkflowNode,assembled:{prompt:string;references:{id:string;slot:string;instanceId?:string}[];imageReferenceDocument?:unknown}){
 return {kind:(node.data.kind==='text'?'agent':node.data.kind) as 'agent'|'image'|'video',modelId:node.data.modelId!,prompt:assembled.prompt,skillId:node.data.skillId||'default',references:assembled.references,...(assembled.imageReferenceDocument?{imageReferenceDocument:assembled.imageReferenceDocument as import('./jobs').JobInput['imageReferenceDocument']}:{}),aspectRatio:node.data.aspectRatio||'1:1',resolution:node.data.resolution||(node.data.kind==='image'?'2K':'720p'),duration:node.data.duration||5,...(node.data.kind==='image'&&node.data.outputFormat!==undefined?{format:node.data.outputFormat}:{}),...(node.data.kind==='video'&&node.data.generateAudio!==undefined?{generateAudio:node.data.generateAudio}:{})};
}
