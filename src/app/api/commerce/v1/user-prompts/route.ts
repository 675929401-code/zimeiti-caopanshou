import {sameOrigin} from '../../../../../commerce/server/auth';
import {promptRequestOwner} from '../../../../../commerce/server/user-prompt-http';
import {json,errorResponse} from '../../../../../commerce/server/http';
import {createUserPrompt,listUserPrompts,UserPromptError} from '../../../../../commerce/server/user-prompts';
export const runtime='nodejs';export const dynamic='force-dynamic';
const failure=(e:unknown)=>e instanceof UserPromptError?json({error:e.message,code:e.code},e.status):errorResponse(e);
export async function GET(request:Request){try{return json(listUserPrompts(promptRequestOwner(request),new URL(request.url).searchParams));}catch(e){return failure(e);}}
export async function POST(request:Request){try{sameOrigin(request);const owner=promptRequestOwner(request);return json(createUserPrompt(owner,await request.json()),201);}catch(e){return failure(e);}}
