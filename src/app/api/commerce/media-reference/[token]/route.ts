import {verifyReference} from '../../../../../commerce/server/media-reference';
import {assetBytes} from '../../../../../commerce/server/assets';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(_:Request,{params}:{params:Promise<{token:string}>}){const {token}=await params;const asset=await verifyReference(token);if(!asset)return new Response('Not found',{status:404});return new Response(new Uint8Array(await assetBytes(asset)),{headers:{'Content-Type':asset.type,'Content-Length':String(asset.size),'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'}});}
