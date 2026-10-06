import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {copyCanvas} from '../../../../commerce/server/canvas-copy';
import {CanvasConflict} from '../../../../commerce/server/canvas-storage';
import {json,errorResponse} from '../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(request:Request){try{sameOrigin(request);const user=requireIdentity(request);const body=await request.json();if(Buffer.byteLength(JSON.stringify(body))>20000)throw Error('复制请求过大');if(body.action!=='duplicate'&&body.action!=='duplicate-selection')throw Error('未知画布操作');if(body.action==='duplicate-selection'&&(!Array.isArray(body.selected)||!body.selected.length))throw Error('请选择有效节点复制');const result=copyCanvas(user.id,{canvasId:body.canvasId,expectedRevision:body.expectedRevision,operationId:body.operationId,...(body.action==='duplicate-selection'?{selected:body.selected}:{title:body.title})});return json({canvas:result.canvas,copiedNodeIds:result.copiedNodeIds,replayed:result.replayed});}catch(error){return error instanceof CanvasConflict?json({error:error.message},409):errorResponse(error);}}
