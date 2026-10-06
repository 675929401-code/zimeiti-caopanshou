import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {list,remove} from '../../../../commerce/server/store';
import {saveCanvas,CanvasConflict} from '../../../../commerce/server/canvas-storage';
import {json,errorResponse} from '../../../../commerce/server/http';
import type {CanvasDocument} from '../../../../commerce/shared/canvas-schema';
export const runtime='nodejs';export const dynamic='force-dynamic';
function publicCanvas<T extends {nodes?:Array<{data?:Record<string,unknown>}>}>(canvas:T){return {...canvas,nodes:(canvas.nodes||[]).map((node)=>node.data?.kind==='video'?node:{...node,data:Object.fromEntries(Object.entries(node.data||{}).filter(([key])=>key!=='modelId'))})};}
export async function GET(request:Request){try{const ownerId=requireIdentity(request).id;return json({ownerId,canvases:list<CanvasDocument>('canvases',ownerId).map(publicCanvas)});}catch(e){return errorResponse(e);}}
export async function POST(request:Request){try{sameOrigin(request);const user=requireIdentity(request);if(Number(request.headers.get('content-length'))>2000000)throw Error('画布文件过大');const value=await request.json();if(Buffer.byteLength(JSON.stringify(value),'utf8')>2000000)throw Error('画布文件过大');return json({canvas:publicCanvas(saveCanvas(user.id,value))});}catch(e){return e instanceof CanvasConflict?json({error:e.message},409):errorResponse(e);}}
export async function DELETE(request:Request){try{sameOrigin(request);const user=requireIdentity(request);const {id}=await request.json();remove('canvases',id,user.id);return json({ok:true});}catch(e){return errorResponse(e);}}
