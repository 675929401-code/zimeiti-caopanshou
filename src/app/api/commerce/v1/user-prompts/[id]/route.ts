import {sameOrigin} from '../../../../../../commerce/server/auth';
import {promptRequestOwner} from '../../../../../../commerce/server/user-prompt-http';
import {json,errorResponse} from '../../../../../../commerce/server/http';
import {readUserPrompt,updateUserPrompt,deleteUserPrompt,UserPromptError} from '../../../../../../commerce/server/user-prompts';
export const runtime='nodejs';export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
const failure=(e:unknown)=>e instanceof UserPromptError?json({error:e.message,code:e.code},e.status):errorResponse(e);
export async function GET(request:Request,context:Context){try{return json(readUserPrompt(promptRequestOwner(request),(await context.params).id));}catch(e){return failure(e);}}
export async function PATCH(request:Request,context:Context){try{sameOrigin(request);return json(updateUserPrompt(promptRequestOwner(request),(await context.params).id,await request.json()));}catch(e){return failure(e);}}
export async function DELETE(request:Request,context:Context){try{sameOrigin(request);const owner=promptRequestOwner(request),{expected_revision}=await request.json();return json(deleteUserPrompt(owner,(await context.params).id,expected_revision));}catch(e){return failure(e);}}
