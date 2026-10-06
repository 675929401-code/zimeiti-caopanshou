import {voiceCatalog} from '../../../../../commerce/server/voice-catalog';
import {json} from '../../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(){try{return json({voices:voiceCatalog()});}catch(e){return json({voices:[],error:'音色目录暂不可用'},503);}}
