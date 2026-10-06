import {createHash} from 'node:crypto';
import {executionEdges,edgeType} from '../shared/canvas-schema';
import type {CanvasMentionDocument} from '../shared/canvas-mentions';

export type WorkflowNode={id:string;data:{label:string;kind:'text'|'image'|'video'|'audio';prompt:string;modelId?:string;skillId?:string;mode?:string;assetIds?:string[];resolution?:string;aspectRatio?:string;duration?:number;outputFormat?:string;generateAudio?:boolean;mention_document?:CanvasMentionDocument}};
export type WorkflowEdge={source:string;target:string;data?:{role?:string;edgeType?:'instruction'|'reference'|'derived'}};

export function selectDependencies(nodes:WorkflowNode[],edges:WorkflowEdge[],selected?:string[]){
 edges=executionEdges(edges);
 if(!selected?.length)return {nodes,edges};
 const all=new Set(nodes.map(n=>n.id)),needed=new Set(selected),pending=[...selected];
 if(selected.some(id=>!all.has(id)))throw Error('选中的节点已删除，请刷新画布');
 while(pending.length){const id=pending.pop()!;for(const edge of edges.filter(e=>e.target===id))if(!needed.has(edge.source)){needed.add(edge.source);pending.push(edge.source);}}
 return {nodes:nodes.filter(n=>needed.has(n.id)),edges:edges.filter(e=>needed.has(e.source)&&needed.has(e.target))};
}

// Output previews and node positions must not invalidate a completed model result.
// Inputs, model settings, reference roles and every ancestor do invalidate it.
export function nodeFingerprints(nodes:WorkflowNode[],edges:WorkflowEdge[]){
 edges=executionEdges(edges);
 const result:Record<string,string>={},visiting=new Set<string>();
 function visit(id:string):string{
  if(result[id])return result[id];
  if(visiting.has(id))throw Error('画布存在循环依赖');
  const node=nodes.find(n=>n.id===id);if(!node)throw Error('画布依赖节点不存在');
  visiting.add(id);const d=node.data;
  const content={kind:d.kind,mode:d.mode||(d.kind==='text'?'input':'generate'),prompt:d.prompt,modelId:d.modelId||'',skillId:d.skillId||'default',assetIds:d.assetIds||[],resolution:d.resolution||'',aspectRatio:d.aspectRatio||'',duration:d.duration||0,outputFormat:d.outputFormat||'',generateAudio:d.generateAudio===undefined?'':String(d.generateAudio),mentionDocument:d.mention_document?createHash('sha256').update(JSON.stringify(d.mention_document)).digest('hex'):'',parents:edges.filter(e=>e.target===id).map(e=>({source:e.source,role:e.data?.role||'',...(edgeType(e)==='instruction'?{edgeType:'instruction'}:{}),fingerprint:visit(e.source)}))};
  result[id]=createHash('sha256').update(JSON.stringify(content)).digest('hex');visiting.delete(id);return result[id];
 }
 nodes.forEach(n=>visit(n.id));return result;
}
