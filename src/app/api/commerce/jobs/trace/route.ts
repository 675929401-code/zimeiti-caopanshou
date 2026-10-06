import {requireIdentity} from '../../../../../commerce/server/auth';
import {job} from '../../../../../commerce/server/jobs';
import {json,errorResponse} from '../../../../../commerce/server/http';
import {publicJobTrace} from '../../../../../commerce/server/public-job-trace';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const user=requireIdentity(request);const value=job(new URL(request.url).searchParams.get('id')||'',user.id);if(!value)return json({error:'任务不存在'},404);return json(publicJobTrace(value));}catch(e){return errorResponse(e);}}
