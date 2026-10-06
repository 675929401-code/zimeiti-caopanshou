import {db,get,put,transaction} from './store';
import {retainCanvasImportReview,CanvasImportReviewRequired} from './canvas-import-review';
import {readAsset} from './assets';
import {normalizeCanvasGraph,type CanvasDocument,type CanvasGraph} from '../shared/canvas-schema';
export class CanvasConflict extends Error{}
export function verifyCanvasAssets(owner:string,graph:Pick<CanvasGraph,'nodes'>){
 for(const node of graph.nodes){
  for(const id of [...(node.data.assetIds||[]),...(node.data.resultAssetIds||[])]){const asset=readAsset(id,owner);if(!asset)throw Error(`“${node.data.label}”的素材不存在或不属于当前账号`);if(!asset.type.startsWith(node.data.kind+'/'))throw Error(`“${node.data.label}”的素材类型不匹配`);}
  if(node.data.thumbnailAssetId){const image=readAsset(node.data.thumbnailAssetId,owner);if(!image||!image.type.startsWith('image/'))throw Error('画布缩略图不存在、不属于当前账号或类型不匹配');}
  for(const mention of node.data.mention_document?.mentions||[]){if(mention.status!=='resolved')continue;if(mention.assetId&&!readAsset(mention.assetId,owner))throw Error('画布引用素材不存在或不属于当前账号');if(mention.sourceNodeId){const source=graph.nodes.find(n=>n.id===mention.sourceNodeId);if(!source||mention.assetId&&![...(source.data.assetIds||[]),...(source.data.resultAssetIds||[])].includes(mention.assetId))throw Error('画布引用节点与素材不匹配');}}
  if(node.data.resultJobId){const original=get<{input:{kind:string};assetIds:string[]}>('jobs',node.data.resultJobId,owner);if(!original||original.input.kind!==(node.data.kind==='text'?'agent':node.data.kind)||(node.data.resultAssetIds||[]).some(id=>!original.assetIds.includes(id)))throw Error('节点结果任务不存在或与当前账号、素材不匹配');}
  for(const id of node.data.frameExtractions||[]){const task=get<{input:{assetId:string};status:string}>('frame-extractions',id,owner);const assetIds=node.data.mode==='input'?node.data.assetIds:node.data.resultAssetIds;if(!task||task.status!=='succeeded'||!assetIds?.includes(task.input.assetId))throw Error('节点提帧记录与原视频或当前账号不匹配');}
 }
}
// Call only while the caller owns the synchronous SQLite transaction.
export function saveCanvasWithinTransaction(owner:string,value:Record<string,any>):CanvasDocument{
 if(value.ownerId!==owner)throw Error('FORBIDDEN');
 if(!Number.isInteger(value.expectedRevision)||value.expectedRevision<0)throw Error('请携带当前画布版本后保存');
 if(typeof value.id!=='string'||!/^[a-f0-9-]{36}$/.test(value.id))throw Error('画布参数无效');
 const row=db().prepare("SELECT owner FROM records WHERE bucket='canvases' AND id=?").get(value.id);if(row&&row.owner!==owner)throw Error('FORBIDDEN');
 const previous=get<CanvasDocument>('canvases',value.id,owner);if(value.expectedRevision!==(previous?.revision||0))throw new CanvasConflict('画布已在其他页面修改，请保留本机修改并核对服务器版本');
 const normalized=normalizeCanvasGraph(value);
 const graph={...normalized,nodes:normalized.nodes.map((node)=>node.data.kind==='video'?node:{...node,data:Object.fromEntries(Object.entries(node.data).filter(([key])=>key!=='modelId')) as typeof node.data})};verifyCanvasAssets(owner,graph);
 const importReview=retainCanvasImportReview(owner,value.id,graph);
 if(value.importReview&&!importReview)throw Error('导入审查信息须由原始案例创建，不能从客户端伪造');
 if(importReview&&!importReview.representationReady&&(graph.nodes.length||graph.edges.length||graph.groups.length))throw new CanvasImportReviewRequired();
 const canvas:CanvasDocument={schemaVersion:2,revision:(previous?.revision||0)+1,id:value.id,...(importReview?{importReview}:{}),title:String(value.title||'未命名画布').slice(0,100),...graph,createdAt:previous?.createdAt||Date.now(),updatedAt:Date.now()};put('canvases',value.id,owner,canvas);return canvas;
}
export function saveCanvas(owner:string,value:Record<string,any>):CanvasDocument{return transaction(()=>saveCanvasWithinTransaction(owner,value));}
