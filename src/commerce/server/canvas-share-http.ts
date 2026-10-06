import {CanvasConflict} from './canvas-storage';
import {CanvasShareUnavailable} from './canvas-sharing';
import {json} from './http';
export function shareError(error:unknown){const message=error instanceof Error?error.message:'';if(error instanceof CanvasShareUnavailable)return json({error:message},404);if(message==='UNAUTHORIZED'||message==='FORBIDDEN')return json({error:message},message==='UNAUTHORIZED'?401:403);if(error instanceof CanvasConflict)return json({error:message},409);return json({error:/^[\u3400-\u9fff]/.test(message)?message:'分享请求未完成，请重试'},400);}
export const shareHeaders={'Cache-Control':'no-store, max-age=0','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};

