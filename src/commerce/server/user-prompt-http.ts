import {requireIdentity} from './auth';
export function promptRequestOwner(request:Request){const user=requireIdentity(request),expected=request.headers.get('x-commerce-owner-key');if(expected&&expected!=='commerce-agent:owner:'+user.id+':v2')throw Error('FORBIDDEN');return user.id;}
