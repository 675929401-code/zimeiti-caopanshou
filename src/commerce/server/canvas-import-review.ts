import {createHash} from 'node:crypto';
import {get,put} from './store';
import type {CanvasGraph,CanvasImportReview} from '../shared/canvas-schema';

const bucket='canvas-import-review-gates',nodeBucket='canvas-import-review-node-origins';
type Gate={canvasId:string;review:CanvasImportReview;inheritedFrom:string[]};
const nodeKey=(owner:string,id:string)=>createHash('sha256').update(owner+'\0'+id).digest('hex');
export class CanvasImportReviewRequired extends Error {
 readonly code='CANVAS_IMPORT_REVIEW_REQUIRED';
 constructor(){super('这是待适配画布审查副本，可重新打开查看原图和问题；尚不能运行、复制或分享。更换模型不会解除审查。');}
}
export function readCanvasImportReview(owner:string,canvasId:string){return get<Gate>(bucket,canvasId,owner)?.review;}
/** Internal only. Invoke in the caller's transaction; no HTTP accepts this metadata. */
export function registerCanvasImportReview(owner:string,canvasId:string,review:CanvasImportReview,nodeIds:string[],inheritedFrom:string[]=[]){
 const old=get<Gate>(bucket,canvasId,owner);
 if(old&&old.review.sourceSha256!==review.sourceSha256)throw Error('原画布审查来源不可替换');
 const record=old||{canvasId,review:structuredClone(review),inheritedFrom};
 put(bucket,canvasId,owner,record);
 for(const id of nodeIds){const key=nodeKey(owner,id),origins=get<{canvasIds:string[]}>(nodeBucket,key,owner)?.canvasIds||[];put(nodeBucket,key,owner,{canvasIds:[...new Set([...origins,canvasId])]});}
 return record.review;
}
/** A saved copy using original imported node identities retains its origin. Asset reuse alone does not. */
export function retainCanvasImportReview(owner:string,canvasId:string,graph:Pick<CanvasGraph,'nodes'>){
 const existing=readCanvasImportReview(owner,canvasId);
 if(existing)return registerCanvasImportReview(owner,canvasId,existing,graph.nodes.map(n=>n.id));
 const sources=[...new Set(graph.nodes.flatMap(n=>get<{canvasIds:string[]}>(nodeBucket,nodeKey(owner,n.id),owner)?.canvasIds||[]))];
 const first=sources.map(id=>readCanvasImportReview(owner,id)).find(Boolean);
 if(!first)return undefined;
 return registerCanvasImportReview(owner,canvasId,{...first,representationReady:false,issues:[...first.issues,{severity:'execution',code:'IMPORTED_NODE_ORIGIN_RETAINED',path:'canvas',message:'该副本含待适配原图节点，须继续核对原始语义；另存或修改模型不会解除审查。'}]},graph.nodes.map(n=>n.id),sources);
}
export function assertCanvasExecutionAllowed(owner:string,canvasId:string,nodes?:{id:string}[]){
 if(readCanvasImportReview(owner,canvasId)||(nodes||[]).some(n=>(get<{canvasIds:string[]}>(nodeBucket,nodeKey(owner,n.id),owner)?.canvasIds||[]).some(id=>!!readCanvasImportReview(owner,id))))throw new CanvasImportReviewRequired();
}
