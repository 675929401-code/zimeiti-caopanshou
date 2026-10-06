import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { findModelByPublicId } from '@/lib/public-model-dto';
import { resolveProviderSecret } from '@/lib/provider-secret';
import { buildOpenAIEndpoint } from '@/lib/api-endpoints';
import { LLMProxy } from '@/lib/llm-proxy';
import {llmProxyBindingConfig,resolveLlmProviderBinding} from '@/lib/llm-provider-contract';
import {commerceChatImageBody,commerceChatImageResult} from '@/lib/commerce-image-protocol';
import { submitVideoTask, pollVideoTask, type VideoModelConfig } from '@/lib/video-adapter';
import { GET as imageCatalog } from '@/app/api/cover-models/route';
import { GET as videoCatalog } from '@/app/api/video/models/route';
import { GET as textCatalog } from '@/app/api/llm-models/route';
import {runtimeDir} from '@/commerce/server/store';
import {inspectVideoModelActivationReadiness, stripClientActivationGate} from '@/lib/model-activation-gate';
import {classifyProviderFailure,isExplicitImageProviderRejection} from '@/commerce/server/provider-failure-classification';
import {commerceModelPricing} from '@/commerce/server/main-site-model-pricing';
import {resolveImageProviderContract} from '@/lib/image-provider-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
type Row = Record<string, unknown>;
type DispatchPhase = 'dispatch_intent' | 'request_sent' | 'acknowledged' | 'submission_unknown';
type ProviderAttestation = {
  logical: string;
  internal: string;
  submitted: string;
  reported: string | null;
  provider: string;
  protocol: string;
  endpointHost: string;
  configHash: string;
  taskId: string | null;
};
type ReceiptReconciliation = {
  state: 'required';
  reason: string;
  retryAllowed: false;
  since: number;
  guidance: string;
};
type Receipt = {
  id: string;
  fingerprint: string;
  kind: string;
  modelId: string;
  modelConfigHash: string;
  status: string;
  revision: number;
  fencingGeneration: number;
  dispatchPhase: DispatchPhase;
  createdAt: number;
  updatedAt: number;
  requestSentAt?: number;
  acknowledgedAt?: number;
  terminalAt?: number;
  result?: Row;
  error?: string;
  providerAttestation?: ProviderAttestation;
  reconciliation?: ReceiptReconciliation;
};
type ReceiptLease = {
  receiptId: string;
  owner: string;
  token: string;
  generation: number;
  purpose: 'create' | 'transition' | 'poll' | 'reconcile';
  acquiredAt: number;
  expiresAt: number;
};
const keyFile = () => process.env.COMMERCE_GATEWAY_KEY_FILE?.trim() || path.join(runtimeDir(), 'main-gateway.key');
const receipts = () => path.join(path.dirname(keyFile()), '带货Agent调用回执');
const receiptPath = (id: string) => path.join(receipts(), `${id}.json`);
const receiptVersionsPath = (id: string) => path.join(receipts(), `${id}.versions`);
const leasePath = (id: string) => path.join(receipts(), `${id}.lease.json`);
const legacyLockPath = (id: string) => path.join(receipts(), `${id}.lock`);
const RECEIPT_LEASE_MS = 45_000;
const DISPATCH_INTENT_TIMEOUT_MS = 90_000;
const PROVIDER_ACK_TIMEOUT_MS = 6 * 60_000;
async function allowed(request: Request) {
  // Dedicated model capability; never accepts a main-site user/admin JWT.
  if (request.headers.has('origin')) return false;
  try { const expected = (await fs.readFile(keyFile(), 'utf8')).trim(); const given = (request.headers.get('authorization') || '').replace(/^Bearer /, ''); return expected.length >= 40 && given.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given)); } catch { return false; }
}
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
async function atomicWriteJson(dest: string, value: unknown) {
  const temporary = `${dest}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, dest);
}

function normalizeReceipt(value: Receipt | (Omit<Receipt, 'revision' | 'fencingGeneration' | 'dispatchPhase'> & Partial<Pick<Receipt, 'revision' | 'fencingGeneration' | 'dispatchPhase'>>)): Receipt {
  const status = String(value.status || 'unknown');
  const inferredPhase: DispatchPhase = value.dispatchPhase
    || (status === 'dispatching'
      ? 'request_sent'
      : status === 'unknown'
        ? 'submission_unknown'
        : 'acknowledged');
  return {
    ...value,
    revision: Number.isInteger(value.revision) && Number(value.revision) >= 1 ? Number(value.revision) : 1,
    fencingGeneration:Number.isInteger(value.fencingGeneration)&&Number(value.fencingGeneration)>=0?Number(value.fencingGeneration):0,
    dispatchPhase: inferredPhase,
  } as Receipt;
}

async function writeReceipt(value: Receipt,lease:ReceiptLease) {
  const fenced:Receipt={...value,fencingGeneration:lease.generation};
  const versionDir=receiptVersionsPath(value.id);
  await fs.mkdir(versionDir,{recursive:true,mode:0o700});
  const versionName=`${String(lease.generation).padStart(20,'0')}-${String(value.revision).padStart(20,'0')}-${lease.token}.json`;
  await fs.writeFile(path.join(versionDir,versionName),JSON.stringify(fenced),{mode:0o600,flag:'wx'});
  await atomicWriteJson(receiptPath(value.id),fenced);
  return fenced;
}

async function load(id: string): Promise<Receipt> {
  const candidates:Receipt[]=[];
  try{candidates.push(normalizeReceipt(JSON.parse(await fs.readFile(receiptPath(id),'utf8')) as Receipt));}catch{}
  try{
    const names=(await fs.readdir(receiptVersionsPath(id))).filter(name=>name.endsWith('.json')).sort().reverse();
    for(const name of names){
      try{candidates.push(normalizeReceipt(JSON.parse(await fs.readFile(path.join(receiptVersionsPath(id),name),'utf8')) as Receipt));break;}catch{}
    }
  }catch{}
  if(!candidates.length)throw Object.assign(new Error('RECEIPT_NOT_FOUND'),{code:'ENOENT'});
  return candidates.sort((left,right)=>right.fencingGeneration-left.fencingGeneration||right.revision-left.revision)[0];
}

async function readLease(id: string): Promise<ReceiptLease | null> {
  try {
    const value = JSON.parse(await fs.readFile(leasePath(id), 'utf8')) as ReceiptLease;
    return value?.receiptId === id && typeof value.token === 'string' && Number.isFinite(value.expiresAt)
      ?{...value,generation:Number.isInteger(value.generation)&&value.generation>=1?value.generation:1}
      :null;
  } catch {
    return null;
  }
}

async function acquireReceiptLease(id: string, purpose: ReceiptLease['purpose'], now = Date.now()): Promise<ReceiptLease> {
  await fs.mkdir(receipts(), { recursive: true, mode: 0o700 });
  let minimumGeneration=0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const latest=await load(id).catch(()=>null);
    const lease: ReceiptLease = {
      receiptId: id,
      owner: `${process.pid}:${crypto.randomUUID()}`,
      token: crypto.randomUUID(),
      generation:Math.max(minimumGeneration,latest?.fencingGeneration||0)+1,
      purpose,
      acquiredAt: now,
      expiresAt: now + RECEIPT_LEASE_MS,
    };
    try {
      const handle = await fs.open(leasePath(id), 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(lease), 'utf8');
      } finally {
        await handle.close();
      }
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const observed = await readLease(id);
    if (observed && observed.expiresAt > Date.now()) {
      throw Object.assign(new Error('RECEIPT_LEASE_ACTIVE'), { code: 'RECEIPT_LEASE_ACTIVE' });
    }
    minimumGeneration=Math.max(minimumGeneration,observed?.generation||0);
    const quarantine = `${leasePath(id)}.expired.${observed?.token || 'invalid'}.${crypto.randomUUID()}`;
    try {
      await fs.rename(leasePath(id), quarantine);
      let moved:Partial<ReceiptLease>|null=null;
      try{moved=JSON.parse(await fs.readFile(quarantine,'utf8')) as Partial<ReceiptLease>;}catch{}
      if (observed?.token && moved?.token !== observed.token) {
        await fs.rename(quarantine, leasePath(id)).catch(() => {});
        throw Object.assign(new Error('RECEIPT_LEASE_CHANGED'), { code: 'RECEIPT_LEASE_CHANGED' });
      }
      await fs.unlink(quarantine).catch(() => {});
    } catch (error) {
      if (!['ENOENT', 'RECEIPT_LEASE_CHANGED'].includes(String((error as NodeJS.ErrnoException & { code?: string }).code || ''))) throw error;
    }
    now = Date.now();
  }
  throw Error('RECEIPT_LEASE_UNAVAILABLE');
}

async function assertLeaseOwner(lease: ReceiptLease) {
  const current = await readLease(lease.receiptId);
  if (!current || current.token !== lease.token || current.owner !== lease.owner || current.expiresAt <= Date.now()) {
    throw Error('RECEIPT_LEASE_LOST');
  }
}

async function releaseReceiptLease(lease: ReceiptLease) {
  const current = await readLease(lease.receiptId);
  if (current?.token === lease.token && current.owner === lease.owner) {
    await fs.unlink(leasePath(lease.receiptId)).catch(() => {});
  }
}

const terminalReceipt = (value: Pick<Receipt, 'status'>) => ['success', 'failed', 'manual_reconciliation'].includes(value.status);
const receiptStateRank = (value:Pick<Receipt,'status'>) => ({dispatching:0,queued:1,processing:2,unknown:3,success:4,failed:4,manual_reconciliation:4}[value.status] ?? 0);

function mergeReceiptObservation(current: Receipt, candidate: Receipt, expectedRevision: number): Receipt {
  if (terminalReceipt(current)) return current;
  const candidateTerminal = terminalReceipt(candidate);
  if (current.revision !== expectedRevision && !candidateTerminal && receiptStateRank(candidate)<=receiptStateRank(current)) return current;
  const nextPhase = candidate.dispatchPhase === 'acknowledged' || current.dispatchPhase === 'acknowledged'
    ? 'acknowledged'
    : candidate.dispatchPhase;
  const now = Date.now();
  return {
    ...current,
    ...candidate,
    id: current.id,
    fingerprint: current.fingerprint,
    kind: current.kind,
    modelId: current.modelId,
    modelConfigHash: current.modelConfigHash,
    createdAt: current.createdAt,
    dispatchPhase: nextPhase,
    revision: current.revision + 1,
    updatedAt: now,
    ...(candidateTerminal ? { terminalAt: candidate.terminalAt || now } : {}),
  };
}

async function commitReceiptObservation(id: string, expectedRevision: number, candidate: Receipt, purpose: ReceiptLease['purpose'] = 'transition') {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let lease:ReceiptLease;
    try{
      lease=await acquireReceiptLease(id,purpose);
    }catch(error){
      if((error as NodeJS.ErrnoException & {code?:string}).code==='RECEIPT_LEASE_ACTIVE'){
        await new Promise(resolve=>setTimeout(resolve,Math.min(5+attempt*5,50)));
        continue;
      }
      throw error;
    }
    try {
      await assertLeaseOwner(lease);
      const current = await load(id);
      const next = mergeReceiptObservation(current, candidate, expectedRevision);
      if (next === current) return current;
      await assertLeaseOwner(lease);
      return await writeReceipt(next,lease);
    } finally {
      await releaseReceiptLease(lease);
    }
  }
  throw Error('RECEIPT_LEASE_UNAVAILABLE');
}

async function createReceipt(value: Omit<Receipt, 'revision' | 'fencingGeneration' | 'dispatchPhase' | 'updatedAt'>): Promise<{ created: boolean; receipt: Receipt }> {
  const lease = await acquireReceiptLease(value.id, 'create');
  try {
    await assertLeaseOwner(lease);
    try {
      const previous = await load(value.id);
      return { created: false, receipt: previous };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const now = Date.now();
    const receipt: Receipt = { ...value, revision: 1, fencingGeneration:lease.generation, dispatchPhase: 'dispatch_intent', updatedAt: now };
    return { created: true, receipt:await writeReceipt(receipt,lease) };
  } finally {
    await releaseReceiptLease(lease);
  }
}

function reconciliation(reason: string, since = Date.now()): ReceiptReconciliation {
  return {
    state: 'required',
    reason,
    retryAllowed: false,
    since,
    guidance: '上游请求可能已接收，但本站未取得可确认回执。系统不会自动重发；请按回执中的模型身份、任务 ID 和时间窗口人工对账。',
  };
}

async function reconcileStaleReceipt(value: Receipt, now = Date.now()) {
  if (terminalReceipt(value)) return value;
  if (value.dispatchPhase === 'dispatch_intent' && now - value.updatedAt >= DISPATCH_INTENT_TIMEOUT_MS) {
    return commitReceiptObservation(value.id, value.revision, {
      ...value,
      status: 'failed',
      error: 'DISPATCH_INTENT_EXPIRED_NOT_SENT',
      terminalAt: now,
    }, 'reconcile');
  }
  if (value.dispatchPhase === 'request_sent' && now - (value.requestSentAt || value.updatedAt) >= PROVIDER_ACK_TIMEOUT_MS) {
    return commitReceiptObservation(value.id, value.revision, {
      ...value,
      status: 'manual_reconciliation',
      dispatchPhase: 'submission_unknown',
      error: 'PROVIDER_ACK_TIMEOUT',
      terminalAt: now,
      reconciliation: reconciliation('PROVIDER_ACK_TIMEOUT', now),
    }, 'reconcile');
  }
  return value;
}

function endpointHost(endpoint: string) {
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
}

function providerAttestation(receipt: Receipt, model: Row, endpoint: string, reported?: unknown, taskId?: unknown): ProviderAttestation | undefined {
  if (!['image', 'video'].includes(receipt.kind)) return undefined;
  return {
    logical: receipt.modelId,
    internal: String(model.id || ''),
    submitted: String(model.model_name || ''),
    reported: typeof reported === 'string' && reported.trim() ? reported : null,
    provider: String(model.provider || ''),
    protocol: String(model.protocol_type || model.provider || ''),
    endpointHost: endpointHost(endpoint),
    configHash: receipt.modelConfigHash,
    taskId: typeof taskId === 'string' && taskId.trim() ? taskId : null,
  };
}

async function markProviderRequestSent(receipt:Receipt,attestation?:ProviderAttestation){
  const now=Date.now();
  const next=await commitReceiptObservation(receipt.id,receipt.revision,{
    ...receipt,
    status:'dispatching',
    dispatchPhase:'request_sent',
    requestSentAt:now,
    ...(attestation?{providerAttestation:attestation}:{}),
  });
  if(next.revision!==receipt.revision+1||next.dispatchPhase!=='request_sent'||next.status!=='dispatching'||next.requestSentAt!==now)throw Error('DISPATCH_OWNERSHIP_LOST');
  return next;
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
async function catalog(kind: string, request: Request) {
  const req = new Request(new URL(kind === 'image' ? '/api/cover-models?surface=commerce-agent' : kind === 'video' ? '/api/video/models?surface=commerce-agent' : '/api/llm-models', request.url));
  return (await (kind === 'image' ? imageCatalog(req) : kind === 'video' ? videoCatalog(req) : textCatalog(req))).json();
}
async function modelFor(kind: string, id: string, request: Request): Promise<Row> {
  const visible = await catalog(kind, request);
  const entry = visible.models?.find((item: Row) => item.id === id);
  if (!entry || entry.capabilities?.available === false) throw Error('MODEL_UNAVAILABLE');
  const { data, error } = await getSupabaseClient().from(kind === 'image' ? 'cover_models' : kind === 'video' ? 'video_models' : 'llm_models').select('*').eq('is_active', true);
  if (error) throw Error('MODEL_CONFIGURATION_UNAVAILABLE');
  const model = findModelByPublicId(kind === 'image' ? 'cover' : kind === 'video' ? 'video' : 'llm', data || [], id);
  if (!model) throw Error('MODEL_CONFIGURATION_UNAVAILABLE');
  return { ...model, _capabilities: entry.capabilities, _commerceSnapshot: pricingSnapshot(kind, model, entry) };
}
function stable(value:unknown):unknown {
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Row).sort(([left],[right])=>left.localeCompare(right)).map(([key,nested])=>[key,stable(nested)]));
  return value;
}
function credentialHash(reference:unknown){try{const secret=resolveProviderSecret(String(reference||'')).trim();return secret?createHash('sha256').update(secret).digest('hex'):'missing';}catch{return 'unresolved';}}
function providerConfigurationReadiness(kind:string,config:Row|undefined){
  if(!config)return {credentialsConfigured:false,endpointConfigured:false,protocolConfigured:false};
  let credentialsConfigured=false;
  try{credentialsConfigured=Boolean(resolveProviderSecret(String(config.api_key||'')).trim());}catch{}
  const endpointConfigured=Boolean(String(config.api_endpoint||config.proxy_url||'').trim());
  // Agent dispatch has one explicit LLMProxy protocol and is fully identified
  // by endpoint + credential + model_name. Image adapters use provider (or the
  // legacy protocol_type); video dispatch requires video-adapter protocol_type.
  const protocolConfigured=kind==='agent'
    ?Boolean(String(config.model_name||'').trim())
    :kind==='image'
      ?Boolean(String(config.provider||config.protocol_type||'').trim())
      :Boolean(String(config.protocol_type||'').trim());
  return {credentialsConfigured,endpointConfigured,protocolConfigured};
}
function commerceCanary(protocol:Row,kind:string,modelId:string,configHash:string){
  const gate=(protocol.__commerce_acceptance_gate&&typeof protocol.__commerce_acceptance_gate==='object'?protocol.__commerce_acceptance_gate:{}) as Row;
  return gate.state==='evidence_ready'&&gate.kind===kind&&String(gate.model_id||'')===modelId&&String(gate.config_hash||'')===configHash&&typeof gate.verified_at==='string'&&Number.isFinite(Date.parse(gate.verified_at))?String(gate.verified_at):null;
}
function pricingSnapshot(kind: string, config: Row, entry: Row) {
  const protocol = (config.api_protocol_config && typeof config.api_protocol_config === 'object' ? config.api_protocol_config : {}) as Row;
  const { billingUnit, costPrice, publicPrice } = commerceModelPricing(kind as 'agent'|'image'|'video', config, entry);
  const protocolWithoutEvidence=stripClientActivationGate(protocol);delete protocolWithoutEvidence.__commerce_acceptance_gate;
  const configHash = createHash('sha256').update(JSON.stringify(stable({kind,id:config.id,modelName:config.model_name,provider:config.provider,protocol:config.protocol_type,endpoint:config.api_endpoint||config.proxy_url||'',credentialHash:credentialHash(config.api_key),protocolConfig:protocolWithoutEvidence,billingUnit,costPrice,publicPrice,capabilities:entry.capabilities||{}}))).digest('hex');
  let verifiedAt=commerceCanary(protocol,kind,String(config.id||''),configHash);
  if(!verifiedAt&&kind==='video'){
    const readiness=inspectVideoModelActivationReadiness({id:String(config.id||''),model_name:config.model_name,provider:config.provider,protocol_type:config.protocol_type,api_endpoint:config.api_endpoint,api_key:config.api_key,api_protocol_config:config.api_protocol_config});
    const gate=(protocol.__model_activation_gate&&typeof protocol.__model_activation_gate==='object'?protocol.__model_activation_gate:{}) as Row;
    const evidence=(gate.evidence&&typeof gate.evidence==='object'?gate.evidence:{}) as Row;
    if(readiness.gated&&readiness.ready&&typeof evidence.issued_at==='string')verifiedAt=String(evidence.issued_at);
  }
  return { costPrice, publicPrice, billingUnit, configHash, verifiedAt };
}
function supportsCommerceGenerateAudioToggle(config:Row|undefined):boolean{
  if(!config)return false;
  const protocol=String(config.protocol_type||''),protocolConfig=(config.api_protocol_config&&typeof config.api_protocol_config==='object'?config.api_protocol_config:{}) as Row;
  return protocolConfig.supports_generate_audio_toggle===true||['secure_skill_doubao_seedance','newapi_video','gaorui_video'].includes(protocol);
}
export async function GET(request: NextRequest) {
  if (!await allowed(request)) return json({ error: 'MODEL_CAPABILITY_REQUIRED' }, 401);
  const kind=request.nextUrl.searchParams.get('kind');
  if(kind&&['image','video','agent'].includes(kind)){
    const visible=await catalog(kind,request);
    const db=getSupabaseClient();
    const {data,error}=await db.from(kind==='image'?'cover_models':kind==='video'?'video_models':'llm_models').select('*').eq('is_active',true);
    if(error) return json({error:'MODEL_CONFIGURATION_UNAVAILABLE'},503);
    const prepared=(visible.models||[]).map((entry:Row)=>{const config=findModelByPublicId(kind==='image'?'cover':kind==='video'?'video':'llm',(data||[]) as Array<Record<string,unknown>>,String(entry.id));return {entry,config,snapshot:config?pricingSnapshot(kind,config,entry):{costPrice:null,publicPrice:null,billingUnit:'per_use',configHash:'',verifiedAt:null}};});
    const hashes=prepared.map((item:{snapshot:{configHash:string}})=>item.snapshot.configHash).filter(Boolean);
    let accepted=new Map<string,string>();
    if(kind==='video'&&hashes.length){
      const evidence=await db.from('commerce_model_acceptance_evidence').select('model_kind,model_id,model_config_hash,verified_at').eq('model_kind',kind).eq('status','passed').in('model_config_hash',hashes);
      if(!evidence.error)accepted=new Map((evidence.data||[]).map((row:Row)=>[`${row.model_kind}:${row.model_id}:${row.model_config_hash}`,String(row.verified_at||'')]));
    }
    return json({models:prepared.map(({entry,config,snapshot}:{entry:Row;config:Row|undefined;snapshot:{costPrice:number|null;publicPrice:number|null;billingUnit:string;configHash:string;verifiedAt:string|null}})=>{const unsupported=kind==='video'?/autodl|digital_human|retalk|wan_s2v/i.test(String(config?.protocol_type)):kind==='image'?/autodl/i.test(String(config?.provider)):false;const configuration=providerConfigurationReadiness(kind,config);const verifiedAt=accepted.get(`${kind}:${String(entry.id||'')}:${snapshot.configHash}`)||snapshot.verifiedAt;return {...entry,...snapshot,internalModelId:String(config?.id||''),modelName:String(config?.model_name||''),provider:String(config?.provider||''),verifiedAt:verifiedAt||null,capabilities:{...entry.capabilities as Row,...configuration,executionSupported:!!config&&!unsupported&&configuration.credentialsConfigured&&configuration.endpointConfigured&&configuration.protocolConfigured,...(kind==='video'?{supportsGenerateAudioToggle:supportsCommerceGenerateAudioToggle(config)}:{}),...(unsupported?{available:false,availabilityMessage:'该协议尚未接通主站模型桥接'}:{})}};})});
  }
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return json({ application: 'main-model-capability', connected: true, shares: ['model-inference'], sharesBusinessData: false });
  if (!validId(id)) return json({error:'INVALID_REQUEST_ID'},400);
  try {
    let receipt = await reconcileStaleReceipt(await load(id));
    if (receipt.status === 'unknown' && isExplicitImageProviderRejection(receipt.error)) {
      receipt = await commitReceiptObservation(receipt.id, receipt.revision, {
        ...receipt,
        status: 'failed',
        dispatchPhase: 'acknowledged',
        terminalAt: Date.now(),
      }, 'reconcile');
    }
    return json(receipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: string }).code === 'RECEIPT_LEASE_ACTIVE') {
      try { return json(await load(id)); } catch {}
    }
    return json({error:'REQUEST_NOT_FOUND'},404);
  }
}
export async function POST(request: NextRequest) {
  if (!await allowed(request)) return json({ error: 'MODEL_CAPABILITY_REQUIRED' }, 401);
  let receipt: Receipt | undefined;
  try {
    if (Number(request.headers.get('content-length')) > 35_000_000) return json({error:'REQUEST_TOO_LARGE'},413);
    const raw = await request.text(); if (Buffer.byteLength(raw) > 35_000_000) return json({error:'REQUEST_TOO_LARGE'},413);
    const input = JSON.parse(raw);
    if (!validId(input.id) || !['image','video','agent'].includes(input.kind) || typeof input.modelId !== 'string') return json({error:'INVALID_INPUT'},400);
    if(input.action==='probe'){
      const model=await modelFor(input.kind,input.modelId,request);
      const endpoint=String(model.api_endpoint||model.proxy_url||'');const key=resolveProviderSecret(String(model.api_key||''));
      if(!key)return json({connected:false,keyConfigured:false});
      const response=await fetch(buildOpenAIEndpoint(endpoint,'models'),{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
      let names:string[]=[];try{const data=await response.json();names=(Array.isArray(data.data)?data.data:[]).map((m:Row)=>String(m.id||'')).filter(Boolean);}catch{}
      return json({connected:response.ok,status:response.status,keyConfigured:true,configuredModel:String(model.model_name||''),endpointHost:new URL(endpoint).host,modelListed:names.includes(String(model.model_name)),models:names,generationSubmitted:false});
    }
    if (input.action === 'poll') {
      receipt = await reconcileStaleReceipt(await load(input.id));
      if (receipt.kind !== input.kind || receipt.modelId !== input.modelId) return json({error:'REQUEST_MISMATCH'},409);
      if (!['image','video'].includes(receipt.kind) || receipt.dispatchPhase !== 'acknowledged' || !['processing','queued'].includes(receipt.status) || !receipt.result?.taskId) return json(receipt);
      const observed = receipt;
      const model = await modelFor(receipt.kind, receipt.modelId, request);
      if(String((model._commerceSnapshot as Row | undefined)?.configHash||'')!==receipt.modelConfigHash){
        receipt=await commitReceiptObservation(receipt.id,receipt.revision,{...receipt,status:'manual_reconciliation',error:'MODEL_CONFIGURATION_CHANGED',terminalAt:Date.now(),reconciliation:reconciliation('MODEL_CONFIGURATION_CHANGED')},'poll');
        return json(receipt);
      }
      if(receipt.kind==='image'){
        const endpoint=String(model.api_endpoint||'');const taskId=encodeURIComponent(String(receipt.result.taskId));
        const response=await fetch(buildOpenAIEndpoint(endpoint,`images/generations/${taskId}`),{headers:{Authorization:`Bearer ${resolveProviderSecret(String(model.api_key||''))}`},signal:AbortSignal.timeout(30000)});
        if(!response.ok&&response.status!==202){
          receipt=await commitReceiptObservation(observed.id,observed.revision,{...observed,status:observed.status,error:`IMAGE_PROVIDER_POLL_HTTP_${response.status}`},'poll');
          return json(receipt);
        }
        const data=await response.json();const url=data.data?.[0]?.url;
        if(!url&&data.status!=='failed')return json(receipt);
        const taskIdValue=String(receipt.result.taskId);
        const candidate:Receipt=url
          ?{...observed,status:'success',result:{...observed.result,url,usage:data.usage},acknowledgedAt:observed.acknowledgedAt||Date.now(),terminalAt:Date.now(),providerAttestation:providerAttestation(observed,model,endpoint,data.model,taskIdValue)}
          :{...observed,status:'failed',error:'IMAGE_PROVIDER_FAILED',terminalAt:Date.now(),providerAttestation:providerAttestation(observed,model,endpoint,data.model,taskIdValue)};
        receipt=await commitReceiptObservation(observed.id,observed.revision,candidate,'poll');return json(receipt);
      }
      const result = await pollVideoTask({ ...model, api_key: resolveProviderSecret(String(model.api_key || '')) } as unknown as VideoModelConfig, String(receipt.result.taskId), typeof receipt.result.contentUrl === 'string' ? receipt.result.contentUrl : undefined);
      const cleanResult:Row={...result};delete cleanResult.error;
      const nextStatus=String(result.status||observed.status);
      const candidate:Receipt={...observed,status:nextStatus,result:{...observed.result,...cleanResult},...(result.error?{error:'VIDEO_PROVIDER_POLL_UNCONFIRMED'}:{}),...(['success','failed'].includes(nextStatus)?{terminalAt:Date.now()}:{}),providerAttestation:providerAttestation(observed,model,String(model.api_endpoint||model.proxy_url||''),cleanResult.reportedModel||cleanResult.model,String(observed.result?.taskId||''))};
      if(nextStatus==='failed')candidate.error='VIDEO_PROVIDER_FAILED';
      receipt=await commitReceiptObservation(observed.id,observed.revision,candidate,'poll'); return json(receipt);
    }
    if (input.action !== 'invoke') return json({error:'INVALID_ACTION'},400);
    // Voice synthesis must not bypass the shared model catalog, immutable quote,
    // cash-wallet precharge, and provider receipt state machine. The legacy
    // provider branch used a hard-coded model lookup, so it remains fail-closed
    // until voice models become first-class entries in the main model catalog.
    if (input.purpose === 'voice-synthesis') {
      return json({error:'VOICE_MODEL_CATALOG_NOT_READY'},503);
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 40000) return json({error:'PROMPT_REQUIRED'},400);
    if(input.responseFormat!==undefined&&(input.kind!=='agent'||input.responseFormat!=='json_object'||input.stream===true))return json({error:'INVALID_RESPONSE_FORMAT'},400);
    const model = await modelFor(input.kind, input.modelId, request);
    const currentConfigHash=String((model._commerceSnapshot as Row | undefined)?.configHash||'');
    if(typeof input.modelConfigHash!=='string'||!input.modelConfigHash||input.modelConfigHash!==currentConfigHash)throw Error('MODEL_CONFIGURATION_CHANGED');
    const endpoint = String(model.api_endpoint || model.proxy_url || '');
    const key = resolveProviderSecret(String(model.api_key || ''));
    if (!key || !endpoint) throw Error('PROVIDER_CONFIGURATION_MISSING');
    const fingerprint = createHash('sha256').update(raw).digest('hex');
    let legacyPermanentClaim=false;
    try{await fs.stat(legacyLockPath(input.id));legacyPermanentClaim=true;}catch{}
    let claimed:{created:boolean;receipt:Receipt};
    try{
      claimed=await createReceipt({id:input.id,fingerprint,kind:input.kind,modelId:input.modelId,modelConfigHash:currentConfigHash,status:'dispatching',createdAt:Date.now()});
    }catch(error){
      if((error as NodeJS.ErrnoException & {code?:string}).code==='RECEIPT_LEASE_ACTIVE'){
        try{const previous=await load(input.id);return previous.fingerprint===fingerprint?json(previous):json({error:'IDEMPOTENCY_CONFLICT'},409);}catch{return json({error:'REQUEST_CLAIM_PENDING'},409);}
      }
      throw error;
    }
    receipt=claimed.receipt;
    if(!claimed.created){
      if(legacyPermanentClaim)await fs.unlink(legacyLockPath(input.id)).catch(()=>{});
      return receipt.fingerprint===fingerprint?json(await reconcileStaleReceipt(receipt)):json({error:'IDEMPOTENCY_CONFLICT'},409);
    }
    if(legacyPermanentClaim){
      receipt=await commitReceiptObservation(receipt.id,receipt.revision,{...receipt,status:'manual_reconciliation',dispatchPhase:'submission_unknown',error:'LEGACY_CLAIM_WITHOUT_RECEIPT',terminalAt:Date.now(),reconciliation:reconciliation('LEGACY_CLAIM_WITHOUT_RECEIPT')},'reconcile');
      await fs.unlink(legacyLockPath(input.id)).catch(()=>{});
      return json(receipt);
    }
    if (input.kind === 'agent') {
      const llmProviderBinding=resolveLlmProviderBinding(model);
      const messages = Array.isArray(input.messages) ? input.messages.slice(-24).filter((m: Row) => ['system','user','assistant'].includes(String(m.role)) && (typeof m.content === 'string' || Array.isArray(m.content))) : [{role:'user',content:input.prompt}];
      if(input.stream===true){
        receipt=await markProviderRequestSent(receipt);
        let fullText='',usage:unknown,streamStatus:'processing'|'success'|'failed'='processing',streamError='';
        // request_sent 在唯一一次 provider POST 前持久化。连接或首帧失败后不再重开流，
        // 因为未收到内容不等于上游未执行；恢复只读原回执，不会重复提交。
        const stream=await new LLMProxy({apiBase:endpoint,apiKey:key,defaultModel:String(model.model_name),timeout:240,retryCount:0,...llmProxyBindingConfig(llmProviderBinding)}).chatStream({model:String(model.model_name),messages,max_tokens:Math.min(Number(input.maxTokens)||4096,12000),enable_thinking:false},{onContent:delta=>{fullText+=delta;},onUsage:value=>{usage=value;},onDone:content=>{streamStatus=content.trim()?'success':'failed';streamError=content.trim()?'':'EMPTY_TEXT_RESULT';fullText=content;},onError:()=>{streamStatus='failed';streamError='TEXT_STREAM_INTERRUPTED';}});
        receipt=await commitReceiptObservation(receipt.id,receipt.revision,{...receipt,status:'processing',dispatchPhase:'acknowledged',acknowledgedAt:Date.now()});
        const streamRevision=receipt.revision;
        const reader=stream.getReader();
        const buffered:Uint8Array[]=[];
        for(;;){
          const step=await reader.read();
          if(step.done)throw Error('TEXT_STREAM_INCOMPLETE');
          const frame=Buffer.from(step.value).toString('utf8');
          if(frame.includes('"error"'))throw Error('TEXT_STREAM_INTERRUPTED');
          buffered.push(step.value);
          if(/^data: \{/m.test(frame)&&!frame.includes('[DONE]'))break;
        }
        return new Response(new ReadableStream<Uint8Array>({async start(controller){
          controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
          for(const chunk of buffered)controller.enqueue(chunk);
          try{
            for(;;){
              const step=await reader.read();
              if(step.done)break;
              controller.enqueue(step.value);
            }
          }catch{streamStatus='failed';streamError='TEXT_STREAM_INTERRUPTED';}
          if(streamStatus==='processing'){streamStatus='failed';streamError='TEXT_STREAM_INCOMPLETE';}
          const latest=await load(receipt!.id);
          await commitReceiptObservation(latest.id,streamRevision,{...latest,status:streamStatus,error:streamError||undefined,result:{text:fullText,usage,reportedModel:String(model.model_name)},dispatchPhase:'acknowledged',...(streamStatus==='success'||streamStatus==='failed'?{terminalAt:Date.now()}:{} )}).catch(()=>{});
          controller.close();
        },async cancel(){
          await reader.cancel().catch(()=>{});
          const latest=await load(receipt!.id).catch(()=>receipt!);
          await commitReceiptObservation(latest.id,streamRevision,{...latest,status:'manual_reconciliation',error:'TEXT_STREAM_DISCONNECTED',result:{text:fullText,usage},dispatchPhase:'acknowledged',terminalAt:Date.now(),reconciliation:reconciliation('TEXT_STREAM_DISCONNECTED')}).catch(()=>{});
        }}),{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'}});
      }
      receipt=await markProviderRequestSent(receipt);
      const result = await new LLMProxy({apiBase:endpoint,apiKey:key,defaultModel:String(model.model_name),timeout:240,retryCount:0,...llmProxyBindingConfig(llmProviderBinding)}).chat({model:String(model.model_name),messages,max_tokens:Math.min(Number(input.maxTokens)||4096,12000),enable_thinking:false,...(input.responseFormat==='json_object'?{response_format:{type:'json_object'}}:{})});
      if (!result.content?.trim()) throw Error('EMPTY_TEXT_RESULT');
      receipt=await commitReceiptObservation(receipt.id,receipt.revision,{...receipt,result:{text:result.content,usage:result.usage,reportedModel:result.model},status:'success',dispatchPhase:'acknowledged',acknowledgedAt:Date.now(),terminalAt:Date.now()});
    } else if (input.kind === 'image') {
      if (/autodl/i.test(String(model.provider))) throw Error('IMAGE_PROTOCOL_NOT_CONNECTED');
      const references = Array.isArray(input.images) ? input.images.filter((v: unknown) => typeof v === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(v)).slice(0,9) : [];
      const caps=model._capabilities as Row;
      if (references.length && !caps.supportsReferenceInput && !caps.supportsImageInput) throw Error('MODEL_REFERENCE_INPUT_UNSUPPORTED');
      if (references.length > Number(caps.maxReferenceImages || 1)) throw Error('TOO_MANY_REFERENCE_IMAGES');
      const ratios: Record<string,string>={'1:1':'2048x2048','9:16':'1440x2560','16:9':'2560x1440','3:4':'1728x2304','4:3':'2304x1728','4:5':'1792x2240','5:4':'2240x1792','2:3':'1664x2496','3:2':'2496x1664'};
      const ratio=String(input.aspectRatio||'1:1'); const resolution=String(input.resolution||'2K');
      const imageContract=resolveImageProviderContract(model);
      const chatImage=imageContract.requestProtocol==='chat_completions';
      const nativeGemini=imageContract.requestProtocol==='google_generate_content';
      const asyncImages=imageContract.requestProtocol==='images_generations_async';
      if(imageContract.requestProtocol==='images_edits')throw Error('IMAGE_PROTOCOL_NOT_CONNECTED');
      if(asyncImages&&references.length)throw Error('IMAGE_PROTOCOL_REFERENCE_NOT_CONNECTED');
      const body=nativeGemini ? {contents:[{role:'user',parts:[{text:input.prompt},...references.map((url:string)=>{const match=url.match(/^data:([^;]+);base64,(.+)$/)!;return {inlineData:{mimeType:match[1],data:match[2]}};})]}],generationConfig:{responseModalities:['IMAGE'],imageConfig:{aspectRatio:ratio,imageSize:resolution}}} : {model:model.model_name,prompt:input.prompt,n:1,size:ratios[ratio]||ratios['1:1'],image_size:resolution,aspect_ratio:ratio,...(!asyncImages?{response_format:'url'}:{}),...(references.length?{image:references}:{}),...(!asyncImages?{watermark:false}:{})};
      const target=chatImage?buildOpenAIEndpoint(endpoint,'chat/completions'):nativeGemini?new URL(`/v1beta/models/${encodeURIComponent(String(model.model_name))}:generateContent`,endpoint).href:buildOpenAIEndpoint(endpoint,'images/generations');
      receipt=await markProviderRequestSent(receipt,providerAttestation(receipt,model,endpoint));
      const response=await fetch(target,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`,...(nativeGemini?{'x-goog-api-key':key}:{}),'Idempotency-Key':input.id},body:JSON.stringify(chatImage?commerceChatImageBody(String(model.model_name),input.prompt,references,ratio,resolution):body),signal:AbortSignal.timeout(240000)});
      if (!response.ok) throw Error(`IMAGE_PROVIDER_HTTP_${response.status}`);
      const data=await response.json(); let url=data.data?.[0]?.url || (data.data?.[0]?.b64_json?`data:image/png;base64,${data.data[0].b64_json}`:'');
      if(nativeGemini){const part=data.candidates?.[0]?.content?.parts?.find((p:Row)=>p.inlineData||p.inline_data);const inline=part?.inlineData||part?.inline_data;if(inline)url=`data:${inline.mimeType||inline.mime_type||'image/png'};base64,${inline.data}`;}
      if(chatImage)url=commerceChatImageResult(data);
      if(!url&&data.id&&['in_progress','queued','processing'].includes(data.status)){
        const taskId=String(data.id);
        receipt=await commitReceiptObservation(receipt.id,receipt.revision,{...receipt,result:{taskId},status:'processing',dispatchPhase:'acknowledged',acknowledgedAt:Date.now(),providerAttestation:providerAttestation(receipt,model,endpoint,data.model,taskId)});
      }else{
        if(!url)throw Error('EMPTY_IMAGE_RESULT');
        receipt=await commitReceiptObservation(receipt.id,receipt.revision,{...receipt,result:{url,usage:data.usage},status:'success',dispatchPhase:'acknowledged',acknowledgedAt:Date.now(),terminalAt:Date.now(),providerAttestation:providerAttestation(receipt,model,endpoint,data.model,data.id)});
      }
    } else {
      if (/autodl|digital_human|retalk|wan_s2v/i.test(String(model.protocol_type))) throw Error('VIDEO_PROTOCOL_NOT_CONNECTED');
      const caps=model._capabilities as Row; const images=Array.isArray(input.images)?input.images:[];
      const audios=Array.isArray(input.audios)?input.audios:[];const videos=Array.isArray(input.videos)?input.videos:[];
      if(images.length>15||audios.length>3||videos.length>1||images.length+audios.length+videos.length>15)throw Error('REFERENCE_MEDIA_COUNT_INVALID');
      if (caps.requiresImage && !images.length) throw Error('REFERENCE_IMAGE_REQUIRED');
      if (images.length<Number(caps.minReferenceImages??0)||images.length>Number(caps.maxReferenceImages??9))throw Error('REFERENCE_IMAGE_COUNT_INVALID');
      if (caps.requiresLastFrame&&images.length<2)throw Error('LAST_FRAME_REQUIRED');
      if (audios.length&&!caps.supportsAudioInput)throw Error('AUDIO_REFERENCE_UNSUPPORTED');
      if (audios.length>Number(caps.maxReferenceAudios??0))throw Error('AUDIO_REFERENCE_COUNT_INVALID');
      if (videos.length&&!caps.supportsSourceVideoInput)throw Error('VIDEO_REFERENCE_UNSUPPORTED');
      if (caps.requiresSourceVideo&&!videos.length)throw Error('SOURCE_VIDEO_REQUIRED');
      if([...images,...audios,...videos].some((url:unknown)=>typeof url!=='string'||!url.startsWith('https://')))throw Error('PUBLIC_REFERENCE_URL_REQUIRED');
      receipt=await markProviderRequestSent(receipt,providerAttestation(receipt,model,endpoint));
      const result=await submitVideoTask({...model,api_key:key} as unknown as VideoModelConfig,{prompt:input.prompt,imageUrl:images[0],imageUrls:images,lastFrameUrl:caps.showLastFrame?images[1]:undefined,sourceVideoUrl:videos[0],audioUrl:audios[0],audioUrls:audios,duration:Number(input.duration)||5,aspectRatio:String(input.aspectRatio||'9:16'),resolutionTier:String(input.resolution||'720p').toLowerCase(),generateAudio:input.generateAudio===undefined?undefined:input.generateAudio===true,idempotencyKey:input.id});
      const cleanResult:Row={...result};delete cleanResult.error;
      const taskId=String(cleanResult.taskId||cleanResult.id||'')||undefined;
      if(result.submissionOutcome==='unknown'){
        receipt=await commitReceiptObservation(receipt.id,receipt.revision,{...receipt,result:cleanResult,status:'manual_reconciliation',dispatchPhase:'submission_unknown',error:'VIDEO_SUBMISSION_UNCONFIRMED',terminalAt:Date.now(),providerAttestation:providerAttestation(receipt,model,endpoint,cleanResult.reportedModel||cleanResult.model,taskId),reconciliation:reconciliation('VIDEO_SUBMISSION_UNCONFIRMED')});
      }else{
        const status=String(result.status||'processing');
        receipt=await commitReceiptObservation(receipt.id,receipt.revision,{...receipt,result:cleanResult,status,dispatchPhase:'acknowledged',acknowledgedAt:Date.now(),...(status==='success'||status==='failed'?{terminalAt:Date.now()}:{}),...(result.error?{error:'VIDEO_PROVIDER_FAILED'}:{}),providerAttestation:providerAttestation(receipt,model,endpoint,cleanResult.reportedModel||cleanResult.model,taskId)});
      }
    }
    return json(receipt);
  } catch(error) {
    const failure=classifyProviderFailure(error);
    if(receipt){
      const now=Date.now();
      const requestMayHaveReachedProvider=['request_sent','acknowledged','submission_unknown'].includes(receipt.dispatchPhase);
      const explicitProviderResponse=failure.status==='failed';
      const candidate:Receipt=requestMayHaveReachedProvider&&!explicitProviderResponse
        ?{...receipt,status:'manual_reconciliation',dispatchPhase:receipt.dispatchPhase==='acknowledged'?'acknowledged':'submission_unknown',error:failure.error,terminalAt:now,reconciliation:reconciliation(failure.error,now)}
        :{...receipt,status:'failed',dispatchPhase:requestMayHaveReachedProvider?'acknowledged':receipt.dispatchPhase,error:failure.error,terminalAt:now};
      try{receipt=await commitReceiptObservation(receipt.id,receipt.revision,candidate);}catch{try{receipt=await load(receipt.id);}catch{}}
    }
    return json(receipt||{error:failure.error},receipt?200:400);
  }
}
