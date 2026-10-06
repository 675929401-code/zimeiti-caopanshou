import {NextRequest,NextResponse} from 'next/server';
import {createHash,timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Job} from '@/commerce/server/jobs';
import {chargeJobAtDispatch,getJobBillingState,publicBillingState,recordJobRevenue,refundFailedJob} from '@/commerce/server/billing';
import {get,runtimeDir} from '@/commerce/server/store';
import type {Kind,Model} from '@/commerce/server/models';
import {GET as imageCatalog} from '@/app/api/cover-models/route';
import {GET as videoCatalog} from '@/app/api/video/models/route';
import {GET as textCatalog} from '@/app/api/llm-models/route';
import {getSupabaseAdminClient} from '@/storage/database/supabase-client';
import {findModelByPublicId} from '@/lib/public-model-dto';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const keyFile=()=>process.env.COMMERCE_GATEWAY_KEY_FILE?.trim()||path.join(runtimeDir(),'main-gateway.key');
const json=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
const allowedFields=new Set(['action','owner','jobId','kind','modelId','duration','status']);

async function allowed(request:Request){
  if(request.headers.has('origin'))return false;
  try{
    const expected=(await fs.readFile(keyFile(),'utf8')).trim();
    const given=(request.headers.get('authorization')||'').replace(/^Bearer /,'');
    return expected.length>=40&&given.length===expected.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(given));
  }catch{return false;}
}

async function authoritativeModel(request:Request,kind:Kind,modelId:string):Promise<Model>{
  const local=get<Model>('models',modelId,'system');
  if(process.env.SHARED_CONFIGURATION_ENABLED!=='1'&&local?.enabled&&local.kind===kind)return {...local,secret:undefined};
  const pathname=kind==='image'?'/api/cover-models?surface=commerce-agent':kind==='video'?'/api/video/models?surface=commerce-agent':'/api/llm-models';
  const catalogRequest=new Request(new URL(pathname,request.url));
  const response=await (kind==='image'?imageCatalog(catalogRequest):kind==='video'?videoCatalog(catalogRequest):textCatalog(catalogRequest));
  const payload=await response.json() as {models?:Record<string,unknown>[]};
  const row=payload.models?.find(value=>value.id===modelId);
  if(!response.ok||!row||row.capabilities&&typeof row.capabilities==='object'&&(row.capabilities as Record<string,unknown>).available===false)throw Error('模型价格未在主站权威目录中启用');
  const publicPrice=Number(row.publicPrice);
  if(!Number.isFinite(publicPrice)||publicPrice<0)throw Error('主站模型价格配置无效');
  const table=kind==='image'?'cover_models':kind==='video'?'video_models':'llm_models';
  const publicKind=kind==='image'?'cover':kind==='video'?'video':'llm';
  const {data,error}=await getSupabaseAdminClient().from(table).select('*').eq('is_active',true);
  if(error)throw Error('主站模型成本配置不可用');
  const internal=findModelByPublicId(publicKind,data||[],modelId) as Record<string,unknown>|null;
  if(!internal)throw Error('主站模型成本配置不存在');
  const rawCost=internal.cost_price??internal.cost_price_yuan;
  const costPrice=rawCost===null||rawCost===undefined?null:Number(rawCost);
  const capabilities=row.capabilities&&typeof row.capabilities==='object'?row.capabilities as Record<string,unknown>:{};
  const billingUnit=capabilities.billingUnit==='output_second'?'output_second':'per_use';
  const configHash=createHash('sha256').update(JSON.stringify({kind,id:internal.id,modelName:internal.model_name,publicPrice,costPrice,billingUnit,capabilities})).digest('hex');
  return {id:modelId,displayName:String(row.displayName||modelId),kind,source:'main',publicPrice,costPrice,billingUnit,configHash,capabilities};
}

async function billingJob(request:Request,body:Record<string,unknown>):Promise<Job>{
  if(Object.keys(body).some(key=>!allowedFields.has(key)))throw Error('UNSUPPORTED_BILLING_FIELD');
  const kind=String(body.kind||'') as Kind,modelId=String(body.modelId||''),status=String(body.status||'');
  if(!['agent','image','video'].includes(kind)||!modelId||modelId.length>200||/[\u0000-\u001f\u007f]/u.test(modelId))throw Error('INVALID_MODEL_CLAIM');
  if(!['queued','running','processing','saving','succeeded','failed','unknown','save_failed'].includes(status))throw Error('INVALID_JOB_STATUS');
  const duration=body.duration===undefined?undefined:Number(body.duration);
  if(duration!==undefined&&(!Number.isFinite(duration)||duration<=0||duration>60))throw Error('INVALID_DURATION');
  const model=await authoritativeModel(request,kind,modelId);
  return {id:String(body.jobId),owner:String(body.owner),input:{requestId:String(body.jobId),kind,modelId,prompt:'',...(duration===undefined?{}:{duration})},model,status:status as Job['status'],createdAt:0,updatedAt:0,assetIds:[],promptVersion:0,compiledPrompt:''};
}

export async function POST(request:NextRequest){
  if(!await allowed(request))return json({error:'BILLING_CAPABILITY_REQUIRED'},401);
  try{
    const raw=await request.text();
    if(Buffer.byteLength(raw,'utf8')>4096)return json({error:'REQUEST_TOO_LARGE'},413);
    const body=JSON.parse(raw) as Record<string,unknown>;
    const action=String(body.action||'');
    const owner=String(body.owner||'');
    const jobId=String(body.jobId||'');
    if(!['charge','refund','revenue','status'].includes(action)||!owner||owner.length>100||!/^[a-f0-9-]{36}$/.test(jobId))return json({error:'INVALID_INPUT'},400);
    const value=await billingJob(request,body);
    if(action==='charge'&&!['running','queued'].includes(value.status))return json({error:'JOB_NOT_DISPATCHABLE'},409);
    if(action==='refund'&&value.status!=='failed')return json({error:'JOB_NOT_CONFIRMED_FAILED'},409);
    if(action==='revenue'&&value.status!=='succeeded')return json({error:'JOB_NOT_SUCCEEDED'},409);
    const state=action==='charge'?await chargeJobAtDispatch(value):action==='refund'?await refundFailedJob(value):action==='revenue'?await recordJobRevenue(value):getJobBillingState(value);
    return json({ok:true,billing:state?publicBillingState(state):null});
  }catch(error){
    const message=error instanceof Error?error.message:'主站账务服务失败';
    return json({error:'BILLING_OPERATION_FAILED',message},409);
  }
}
