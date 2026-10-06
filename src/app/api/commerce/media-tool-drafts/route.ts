import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {json,errorResponse} from '../../../../commerce/server/http';
import {mediaTool,readMediaToolDraft,saveMediaToolDraft,MediaDraftConflict} from '../../../../commerce/server/media-tool-drafts';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=requireIdentity(request),query=new URL(request.url).searchParams;return json(readMediaToolDraft(user.id,mediaTool(query.get('tool')),query.get('assetId')||''));}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{sameOrigin(request);const user=requireIdentity(request);if(Number(request.headers.get('content-length'))>40000)throw Error('草稿内容过大');const body=await request.json();if(body.ownerId!==user.id)throw Error('FORBIDDEN');return json({ownerId:user.id,draft:saveMediaToolDraft(user.id,body)});}catch(error){return error instanceof MediaDraftConflict?json({error:error.message},409):errorResponse(error);}}
