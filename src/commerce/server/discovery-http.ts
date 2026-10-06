import {requireIdentity,sameOrigin} from './auth';
import {json,errorResponse} from './http';
import {DiscoveryError} from './discovery';
export function discoveryMutationOwner(request:Request){sameOrigin(request);const user=requireIdentity(request);if(request.headers.get('x-commerce-owner-key')!=='commerce-agent:owner:'+user.id+':v2')throw Error('FORBIDDEN');return user.id;}
export async function discoveryBody(request:Request){if(Number(request.headers.get('content-length'))>4096)throw new DiscoveryError('BODY_TOO_LARGE','请求内容过大');const text=await request.text();if(Buffer.byteLength(text)>4096)throw new DiscoveryError('BODY_TOO_LARGE','请求内容过大');try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,unknown>;}catch{throw new DiscoveryError('INVALID_BODY','请求格式无效');}}
export function discoveryError(error:unknown){return error instanceof DiscoveryError?json({error:error.message,code:error.code,issues:error.issues,...(error.detail?{detail:error.detail}:{})},error.status):errorResponse(error);}
