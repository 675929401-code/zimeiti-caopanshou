import {createHash} from 'node:crypto';
import {assertCanvasExecutionAllowed} from './canvas-import-review';
import {get,put,transaction} from './store';
import {CanvasConflict,saveCanvasWithinTransaction,verifyCanvasAssets} from './canvas-storage';
import {normalizeCanvasGraph,type CanvasDocument} from '../shared/canvas-schema';
import {cloneGraph} from '../shared/canvas-graph-operations';
type CopyInput={canvasId:string;expectedRevision:number;operationId:string;selected?:string[];title?:string};
export function copyCanvas(owner:string,input:CopyInput){
 if(!/^[a-f0-9-]{36}$/.test(input.operationId))throw Error('复制操作标识无效');const key=owner+':'+input.operationId,fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 return transaction(()=>{
  assertCanvasExecutionAllowed(owner,input.canvasId);
  const prior=get<{fingerprint:string;canvas:CanvasDocument;copiedNodeIds:string[]}>('canvas-copy-operations',key,owner);if(prior){if(prior.fingerprint!==fingerprint)throw Error('同一复制操作不能用于不同内容');const current=get<CanvasDocument>('canvases',prior.canvas.id,owner);if(!current)throw Error('已复制的画布已被删除，请从原画布发起新复制');return {...prior,canvas:current,replayed:true};}
  const source=get<CanvasDocument>('canvases',input.canvasId,owner);if(!source)throw Error('画布不存在或不属于当前账号');if(source.revision!==input.expectedRevision)throw new CanvasConflict('画布版本已变化，请读取最新版本后复制');
  const graph=normalizeCanvasGraph(source);verifyCanvasAssets(owner,graph);if(input.selected!==undefined&&(!Array.isArray(input.selected)||!input.selected.length||input.selected.length>100||input.selected.some(id=>typeof id!=='string')))throw Error('请选择有效节点复制');
  const cloned=cloneGraph(graph,input.selected,input.selected?40:0),id=input.selected?source.id:crypto.randomUUID();
  const next=input.selected?{nodes:[...graph.nodes,...cloned.graph.nodes],edges:[...graph.edges,...cloned.graph.edges],groups:[...graph.groups,...cloned.graph.groups],viewport:graph.viewport}:cloned.graph;
  const canvas=saveCanvasWithinTransaction(owner,{id,ownerId:owner,expectedRevision:input.selected?source.revision:0,title:input.selected?source.title:input.title||source.title+' 副本',...next});const copiedNodeIds=cloned.graph.nodes.map(n=>n.id),result={fingerprint,canvas,copiedNodeIds};put('canvas-copy-operations',key,owner,result);return {...result,replayed:false};
 });
}
