import {after} from 'next/server';
import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {edits,createEdit,runEdit} from '../../../../commerce/server/media-tools';
import {json,errorResponse} from '../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=300;
export async function GET(request:Request){try{const user=requireIdentity(request);return json({jobs:edits(user.id).map(({owner,...j})=>j)});}catch(e){return errorResponse(e);}}
export async function POST(request:Request){try{sameOrigin(request);const user=requireIdentity(request);const value=createEdit(user.id,await request.json());after(()=>runEdit(value.id,user.id));const {owner,...job}=value;return json({job},202);}catch(e){return errorResponse(e);}}
