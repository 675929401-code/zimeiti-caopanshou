import {readCanvasShareMedia,assertCanvasShareMediaActive} from '../../../../../../../../commerce/server/canvas-sharing';
import {shareError,shareHeaders} from '../../../../../../../../commerce/server/canvas-share-http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{token:string;assetRef:string}>}){
 try{const {token,assetRef}=await params;const {bytes,type,name}=await readCanvasShareMedia(token,assetRef);assertCanvasShareMediaActive(token,assetRef);const headers:Record<string,string>={...shareHeaders,'Content-Type':type,'Accept-Ranges':'bytes','Content-Security-Policy':"default-src 'none'; sandbox"};
 if(new URL(request.url).searchParams.has('download'))headers['Content-Disposition']="attachment; filename*=UTF-8''"+encodeURIComponent(name);
 const range=request.headers.get('range');if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);let start=0,end=bytes.length-1;if(!match||!match[1]&&!match[2])return new Response(null,{status:416,headers:{...headers,'Content-Range':'bytes */'+bytes.length}});if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}else start=Math.max(0,bytes.length-Number(match[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=bytes.length)return new Response(null,{status:416,headers:{...headers,'Content-Range':'bytes */'+bytes.length}});return new Response(new Uint8Array(bytes.subarray(start,end+1)),{status:206,headers:{...headers,'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':String(end-start+1)}});}
 return new Response(new Uint8Array(bytes),{headers:{...headers,'Content-Length':String(bytes.length)}});
 }catch(e){return shareError(e);}
}
export async function HEAD(request:Request,context:{params:Promise<{token:string;assetRef:string}>}){const response=await GET(request,context);return new Response(null,{status:response.status,headers:response.headers});}
