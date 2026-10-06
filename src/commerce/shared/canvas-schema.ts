import {normalizeCanvasMentionDocument,type CanvasMentionDocument} from './canvas-mentions';
import type {DiscoveryCanvasImportResult} from './discovery-canvas-import-schema';
import type {DiscoveryItem} from './discovery-catalog-types';
/** Server-owned import review. Client graph normalization never accepts this field. */
export type CanvasImportReview={schemaVersion:1;status:'review-required';sourceItemId:string;sourceSha256:string;createdAt:number;representationReady:boolean;executionReady:false;issues:DiscoveryCanvasImportResult['issues'];migration:DiscoveryCanvasImportResult['migration'];preview:DiscoveryItem};
export type CanvasKind='text'|'image'|'video'|'audio';
export type CanvasEdgeType='instruction'|'reference'|'derived';
export type CanvasNodeData={label:string;kind:CanvasKind;prompt:string;mode?:'input'|'generate';modelId?:string;skillId?:string;assetIds?:string[];resolution?:string;aspectRatio?:string;duration?:number;status?:string;resultAssetIds?:string[];resultText?:string;resultJobId?:string;frameExtractions?:string[];thumbnailAssetId?:string;mention_document?:CanvasMentionDocument;outputFormat?:string;generateAudio?:boolean};
export type CanvasNode={id:string;type?:string;position:{x:number;y:number};data:CanvasNodeData;width?:number;height?:number;selected?:boolean;dragging?:boolean;measured?:{width?:number;height?:number}};
export type CanvasEdge={id:string;source:string;target:string;label?:string;data?:{role?:string;edgeType?:CanvasEdgeType};selected?:boolean};
export type CanvasGroup={id:string;title:string;nodeIds:string[];position:{x:number;y:number};size:{width:number;height:number}};
export type CanvasViewport={x:number;y:number;zoom:number};
export type CanvasGraph={nodes:CanvasNode[];edges:CanvasEdge[];groups:CanvasGroup[];viewport:CanvasViewport};
export type CanvasDocument=CanvasGraph&{schemaVersion:2;id:string;title:string;revision:number;createdAt:number;updatedAt:number;importReview?:CanvasImportReview};
export function canvasAssetIds(graph:Pick<CanvasGraph,'nodes'>):string[]{return [...new Set(graph.nodes.flatMap(n=>[...(n.data.assetIds||[]),...(n.data.resultAssetIds||[]),...(n.data.thumbnailAssetId?[n.data.thumbnailAssetId]:[]),...(n.data.mention_document?.mentions.filter(m=>m.status==='resolved'&&m.assetId).map(m=>m.assetId!)||[])]))];}
export const defaultCanvasViewport=():CanvasViewport=>({x:0,y:0,zoom:1});
const object=(value:unknown):Record<string,any>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('画布对象格式无效');return value as Record<string,any>;};
const text=(value:unknown,max:number,name:string,fallback?:string)=>{if(value===undefined&&fallback!==undefined)return fallback;if(typeof value!=='string'||value.length>max)throw Error(name+'格式无效');return value;};
const identity=(value:unknown)=>{const v=text(value,160,'标识');if(!v||['__proto__','constructor','prototype'].includes(v)||/[\u0000-\u001f]/.test(v))throw Error('画布标识无效');return v;};
const number=(value:unknown,name:string,min=-1e7,max=1e7)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(name+'无效');return value;};
const strings=(value:unknown,name:string,max=100)=>{if(!Array.isArray(value)||value.length>max)throw Error(name+'格式无效');const rows=value.map(identity);if(new Set(rows).size!==rows.length)throw Error(name+'不能重复');return rows;};
export function edgeType(edge:{data?:{edgeType?:string}}):CanvasEdgeType{const type=edge.data?.edgeType;if(type===undefined)return 'reference';if(!['instruction','reference','derived'].includes(type))throw Error('连线类型无效');return type as CanvasEdgeType;}
export function executionEdges<T extends {data?:{edgeType?:string}}>(edges:T[]):T[]{return edges.filter(edge=>edgeType(edge)!=='derived');}
export function graphOrder(nodes:{id:string}[],edges:{source:string;target:string;data?:{edgeType?:string}}[],limit=100):string[]{
 if(nodes.length>limit||new Set(nodes.map(n=>n.id)).size!==nodes.length)throw Error(`画布最多支持 ${limit} 个不同节点`);const ids=new Set(nodes.map(n=>n.id));
 for(const edge of edges)if(!ids.has(edge.source)||!ids.has(edge.target)||edge.source===edge.target)throw Error('画布连线无效');
 const inputs=executionEdges(edges),degree=new Map(nodes.map(n=>[n.id,0]));for(const edge of inputs)degree.set(edge.target,degree.get(edge.target)!+1);
 const queue=nodes.filter(n=>degree.get(n.id)===0).map(n=>n.id),ordered:string[]=[];while(queue.length){const id=queue.shift()!;ordered.push(id);for(const edge of inputs.filter(e=>e.source===id)){degree.set(edge.target,degree.get(edge.target)!-1);if(degree.get(edge.target)===0)queue.push(edge.target);}}
 if(ordered.length!==nodes.length)throw Error('画布存在循环依赖，请移除回环连线');return ordered;
}
export function normalizeCanvasGraph(value:unknown):CanvasGraph{
 const v=object(value);if(!Array.isArray(v.nodes)||!Array.isArray(v.edges)||v.nodes.length>100||v.edges.length>300)throw Error('画布最多支持100节点和300条连线');
 const nodes:CanvasNode[]=v.nodes.map(raw=>{const n=object(raw),d=object(n.data),p=object(n.position);if(!['text','image','video','audio'].includes(d.kind))throw Error('节点类型无效');const data:CanvasNodeData={label:text(d.label,120,'节点名称',d.kind==='text'?'文本':'素材'),kind:d.kind,prompt:text(d.prompt,20000,'节点正文')};
  if(d.mode!==undefined){if(!['input','generate'].includes(d.mode))throw Error('节点用途无效');data.mode=d.mode;}
  for(const [key,max] of [['modelId',200],['skillId',200],['resolution',40],['aspectRatio',40],['resultText',100000]] as const)if(d[key]!==undefined)data[key]=text(d[key],max,key);
  if(d.duration!==undefined)data.duration=number(d.duration,'节点时长',0,3600);
  if(d.outputFormat!==undefined)data.outputFormat=text(d.outputFormat,16,'输出格式');
  if(d.generateAudio!==undefined){if(typeof d.generateAudio!=='boolean')throw Error('声音开关无效');data.generateAudio=d.generateAudio;}
  if(d.status!==undefined){const status=text(d.status,30,'节点状态');if(!['pending','running','waiting','queued','succeeded','failed','unknown','save_failed','blocked','paused','saved'].includes(status))throw Error('节点状态无效');data.status=status;}
  for(const key of ['assetIds','resultAssetIds','frameExtractions'] as const)if(d[key]!==undefined)data[key]=strings(d[key],key);
  if(d.resultJobId!==undefined)data.resultJobId=identity(d.resultJobId);
  if(d.thumbnailAssetId!==undefined)data.thumbnailAssetId=identity(d.thumbnailAssetId);
  if(d.mention_document!==undefined)data.mention_document=normalizeCanvasMentionDocument(d.mention_document,data.prompt);
  const node:CanvasNode={id:identity(n.id),type:'commerce',position:{x:number(p.x,'节点横坐标'),y:number(p.y,'节点纵坐标')},data};
  for(const key of ['width','height'] as const)if(n[key]!==undefined)node[key]=number(n[key],'节点尺寸',1,10000);return node;
 });
 const edgeIds=new Set<string>(),pairs=new Set<string>();const edges:CanvasEdge[]=v.edges.map(raw=>{const e=object(raw),d=e.data===undefined?{}:object(e.data),id=identity(e.id),source=identity(e.source),target=identity(e.target),kind=edgeType({data:d});if(edgeIds.has(id))throw Error('连线标识重复');edgeIds.add(id);const role=d.role===undefined?undefined:text(d.role,100,'引用角色');const pair=JSON.stringify([source,target,kind,...(kind==='reference'?[role||'']:[])]);if(pairs.has(pair))throw Error('相同节点间已有此类型连线');pairs.add(pair);return {id,source,target,...(e.label===undefined?{}:{label:text(e.label,100,'连线名称')}),data:{edgeType:kind,...(role?{role}:{})}};});
 graphOrder(nodes,edges);const nodeIds=new Set(nodes.map(n=>n.id)),groupIds=new Set<string>(),membership=new Set<string>();
 if(v.groups!==undefined&&(!Array.isArray(v.groups)||v.groups.length>100))throw Error('分组格式无效');
 const groups:CanvasGroup[]=(v.groups||[]).map((raw:unknown)=>{const g=object(raw),id=identity(g.id),position=object(g.position),size=object(g.size),members=strings(g.nodeIds,'分组成员');if(groupIds.has(id)||nodeIds.has(id)||members.some(n=>!nodeIds.has(n)||membership.has(n)))throw Error('分组成员或标识无效');groupIds.add(id);members.forEach(n=>membership.add(n));return {id,title:text(g.title,100,'分组名称'),nodeIds:members,position:{x:number(position.x,'分组位置'),y:number(position.y,'分组位置')},size:{width:number(size.width,'分组宽度',1,1e7),height:number(size.height,'分组高度',1,1e7)}};});
 const viewport=v.viewport===undefined?defaultCanvasViewport():object(v.viewport);return {nodes,edges,groups,viewport:{x:number(viewport.x,'视口位置'),y:number(viewport.y,'视口位置'),zoom:number(viewport.zoom,'视口缩放',.1,4)}};
}
