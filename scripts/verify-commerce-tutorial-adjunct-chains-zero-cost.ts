import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

type TutorialStep=2|6|7|8|9;
type SourceLayer='ui'|'api'|'service'|'storage';

type SourceContract={
  file:string;
  purpose:string;
  mustMatch:readonly RegExp[];
  mustNotMatch?:readonly RegExp[];
};

type AdjunctCapability={
  id:string;
  label:string;
  steps:readonly TutorialStep[];
  evidence:Record<SourceLayer,readonly SourceContract[]>;
};

type EffectCounters={
  network:number;
  provider:number;
  wallet:number;
  browser:number;
  database:number;
  production:number;
  paidGeneration:number;
  benchmarkVideoSubmissions:number;
};

const LAYERS=['ui','api','service','storage'] as const;
const EXPECTED_STEPS=[2,6,7,8,9] as const;
const contract=(file:string,purpose:string,mustMatch:readonly RegExp[],mustNotMatch:readonly RegExp[]=[]):SourceContract=>({file,purpose,mustMatch,mustNotMatch});

/**
 * Local capability-to-tutorial map. The benchmark tutorial supplies workflow
 * checkpoints only; all contracts below point to this product's own source.
 */
export const COMMERCE_TUTORIAL_ADJUNCT_MAP:readonly AdjunctCapability[]=[
  {
    id:'hot-video-remix',
    label:'爆款视频本地二创',
    steps:[2,6,7,8,9],
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/hot-video-remix-studio.tsx','素材选择、确定性片段计划、零元确认、历史预览和下载',[
        /const sourceSlot:MaterialSlot=.*min:1,max:3,kinds:\['video'\]/u,
        /type ClipMode='automatic'\|'manual'/u,
        /action:'quote'.*sourceAssetIds/su,
        /生成 0 元处理报价/u,
        /window\.confirm\(`本次任务使用本机 FFmpeg 处理/u,
        /action:'confirm'/u,
        /download=1/u,
      ])],
      api:[contract('src/app/api/commerce/hot-video-remix/route.ts','账号隔离的报价、确认和原任务读回调度',[
        /sameOrigin\(request\)/u,
        /requireIdentity\(request\)\.id/u,
        /body\.action==='quote'/u,
        /body\.action==='confirm'/u,
        /readHotVideoRemix\(id,owner\)/u,
        /after\(async\(\)=>/u,
      ])],
      service:[contract('src/commerce/server/hot-video-remix.ts','冻结素材与片段、租约执行、输出校验和失败恢复',[
        /export async function quoteHotVideoRemix/u,
        /const clipPlan=exactPlan\(input,sourceSnapshots,settings\)\|\|automaticPlan/u,
        /export function confirmHotVideoRemix/u,
        /export async function runHotVideoRemix/u,
        /export function recoverStaleHotVideoRemix/u,
        /assertOutputMatches\(value,probe\)/u,
        /current\.status='failed'/u,
      ],[/\bdeductCash\b/u,/\brefundCash\b/u,/\bsynthesizeSpeech\b/u])],
      storage:[contract('src/commerce/server/hot-video-remix.ts','报价、任务、探测缓存、租约和幂等成片持久化',[
        /HOT_VIDEO_REMIX_QUOTE_BUCKET='hot-video-remix-quotes'/u,
        /HOT_VIDEO_REMIX_JOB_BUCKET='hot-video-remix-jobs'/u,
        /HOT_VIDEO_REMIX_LEASE_BUCKET='hot-video-remix-leases'/u,
        /claim\(requestKey,inputFingerprint,id\)/u,
        /put\(HOT_VIDEO_REMIX_JOB_BUCKET,id,owner,job\)/u,
        /readIdempotentAsset\(owner,resultKey\)/u,
        /storeAsset\(owner,bytes,'video\/mp4'/u,
      ])],
    },
  },
  {
    id:'voice-synthesis',
    label:'现金语音合成',
    steps:[6,7,8,9],
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/voice-synthesis-studio.tsx','真实准入、准确报价、明确确认、音频结果和未知终态人工入口',[
        /action=catalog/u,
        /action:'quote'/u,
        /clientRequestId:confirmRequest\.current\.clientRequestId/u,
        /disabled=\{!!busy\|\|!selectedVoice\?\.generationReady\}/u,
        /selectedJob\.status==='submission_unknown'/u,
        /action:'retry-save'\|'request-reconciliation'/u,
        /<audio controls preload="metadata" src=\{url\}/u,
        /download=1/u,
      ])],
      api:[contract('src/app/api/commerce/voice-synthesis/route.ts','账号绑定的目录、报价、确认和显式恢复动作',[
        /authorizeCurrentCommerceIdentity\(user\)/u,
        /action==='catalog'/u,
        /body\.action==='quote'/u,
        /body\.action==='confirm'/u,
        /body\.action==='retry-save'/u,
        /body\.action==='request-reconciliation'/u,
        /body\.action==='retry-charge'/u,
        /body\.action==='cancel-pending-charge'/u,
      ])],
      service:[
        contract('src/commerce/server/voice-bridge.ts','模型、成本、售价、配置快照与真实验收门禁',[
          /export async function commerceVoiceCatalog/u,
          /generationReady=Boolean\(fingerprint&&acceptanceEvidence\(fingerprint\)\)/u,
          /export async function freezeCommerceVoiceInput/u,
          /payableTotal:amounts\.payableTotal,costAmount:amounts\.costAmount/u,
          /VOICE_ACCEPTANCE_EVIDENCE_INCOMPLETE/u,
        ]),
        contract('src/commerce/server/voice-jobs.ts','扣费后队列、派发回执、音频保存、明确失败退款和未知终态停止',[
          /export async function confirmVoice/u,
          /export async function runVoiceJob/u,
          /if\(job\.billingState==='charge_pending'\)return job/u,
          /if\(job\.status==='submission_unknown'\)return job/u,
          /executeCommerceVoice\(job\.input,attemptId\)/u,
          /storeAsset\(owner,result\.bytes,result\.type/u,
          /return settleRefund\(failed\)/u,
        ]),
      ],
      storage:[contract('src/commerce/server/voice-jobs.ts','报价、任务、主账号绑定、供应商回执和幂等音频资产持久化',[
        /const QUOTE_BUCKET='voice-quotes'/u,
        /const JOB_BUCKET='voice-jobs'/u,
        /put\(QUOTE_BUCKET,id,owner,quote\)/u,
        /put\(JOB_BUCKET,job\.id,owner,job\)/u,
        /resultAssetKey\(job\.id\)/u,
        /dispatch=\{\.\.\.current\.dispatch,state:'unknown'\}/u,
      ])],
    },
  },
  {
    id:'voice-to-video',
    label:'完成配音应用到视频',
    steps:[2,6,7,8,9],
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/voice-synthesis-studio.tsx','从成功语音选择当前账号视频，创建本地零元任务并读回成片',[
        /async function openApplyToVideo/u,
        /async function applyVoiceToVideo/u,
        /api<\{assets:CommerceVideoAsset\[\]\}>\('\/api\/commerce\/assets'\)/u,
        /\/api\/commerce\/voice-replace/u,
        /audioAssetId:selectedJob\.asset\.id/u,
        /requestId:replaceRequest\.current\.requestId/u,
        /应用到视频/u,
        /确认应用（本地处理 ¥0）/u,
        /replaceJob\.resultAsset\.url\}\?download=1/u,
      ])],
      api:[contract('src/app/api/commerce/voice-replace/route.ts','同源账号内创建、原任务读回和后台续跑',[
        /sameOrigin\(request\)/u,
        /const identity=requireIdentity\(request\);await authorizeCurrentCommerceIdentity\(identity\)/u,
        /export async function GET/u,
        /readVoiceReplacement\(id,owner\)/u,
        /listVoiceReplacements\(owner\)/u,
        /body\.action!=='create'/u,
        /createVoiceReplacement\(owner/u,
        /after\(\(\)=>runVoiceReplacementJob\(id,owner\)\)/u,
      ])],
      service:[contract('src/commerce/server/voice-replace.ts','只接受已完成语音资产，按原视频时长对齐音频并确定性恢复',[
        /voiceJob\.status!=='succeeded'\|\|voiceJob\.assetId!==audio\.id/u,
        /export async function createVoiceReplacement/u,
        /execution:\{engine:'local-ffmpeg',networkRequired:false,walletRequired:false,payableTotal:0\}/u,
        /\[1:a:0\]apad,atrim=duration=\$\{duration\}/u,
        /'-t',duration/u,
        /export async function runVoiceReplacementJob/u,
        /Math\.abs\(probe\.duration-value\.videoSnapshot\.duration\)>0\.25/u,
        /export function recoverStaleVoiceReplacement/u,
      ],[/-shortest/u,/\bdeductCash\b/u,/\brefundCash\b/u,/\bexecuteCommerceVoice\b/u])],
      storage:[
        contract('src/commerce/server/voice-replace.ts','请求幂等、任务租约、成片幂等资产与终态持久化',[
          /VOICE_REPLACE_JOB_BUCKET='voice-replace-jobs'/u,
          /VOICE_REPLACE_LEASE_BUCKET='voice-replace-leases'/u,
          /claim\(requestKey,requestFingerprint,id\)/u,
          /put\(VOICE_REPLACE_JOB_BUCKET,id,owner,value\)/u,
          /readIdempotentAsset\(job\.owner,resultAssetKey\(job\.id\)\)/u,
          /storeAsset\(owner,bytes,'video\/mp4'/u,
        ]),
        contract('src/commerce/server/ordinary-worker.ts','普通媒体 worker 扫描并恢复已持久化任务',[
          /kind:'voice-replacement'/u,
          /voiceReplacementCandidates\(cap,now\)/u,
          /runVoiceReplacementJob\(candidate\.id,candidate\.owner\)/u,
          /sweepVoiceReplacementWorkdirs\(now\)/u,
        ]),
        contract('src/commerce/server/assets.ts','任务活动期间保护输入与输出资产',[
          /bucket='voice-replace-jobs'/u,
          /const voiceReplaceJob=get<\{status\?:string\}>\('voice-replace-jobs'/u,
          /activeVoiceReplaceReference/u,
          /任务结束前不能删除/u,
        ]),
      ],
    },
  },
  {
    id:'voice-to-digital-human',
    label:'完成配音桥接数字人',
    steps:[2,6,7,8],
    evidence:{
      ui:[
        contract('src/features/digital-human/CommerceAudioAssetPicker.tsx','选择当前账号已完成配音，校验复制后只回填数字人音频输入',[
          /fetch\('\/api\/commerce\/digital-human-audio-assets'/u,
          /transferCommerceAudioToDigitalHuman\(candidate,token/u,
          /onAudio\(value\)/u,
          /onBusyChange\?\.\(true\)/u,
          /未触发配音或视频生成/u,
          /不触发模型生成或本站扣费/u,
        ]),
        contract('src/app/digital-human/page.tsx','数字人页面接入桥接并在复制期间禁止提交生成',[
          /import \{ CommerceAudioAssetPicker \}/u,
          /const \[commerceAudioPending, setCommerceAudioPending\]/u,
          /pending \|\| commerceAudioPending \|\| storageError/u,
          /\{backHref==='\/commerce'&&<CommerceAudioAssetPicker/u,
          /<CommerceAudioAssetPicker/u,
          /onAudio=\{acceptSpeech\}/u,
          /onBusyChange=\{setCommerceAudioPending\}/u,
          /生成数字人视频/u,
        ]),
      ],
      api:[
        contract('src/app/api/commerce/digital-human-audio-assets/route.ts','账号与固定主账号复核后的只读候选接口',[
          /export async function GET/u,
          /requireIdentity\(request\)/u,
          /authorizeCurrentCommerceIdentity\(identity\)/u,
          /listDigitalHumanAudioCandidates\(identity\.id\)/u,
          /'Cache-Control':'private, no-store'/u,
        ]),
        contract('src/app/api/digital-human/upload-ticket/route.ts','主站账号内确定性上传票据与幂等已完成读回',[
          /export async function POST/u,
          /digitalHumanUploadTicketId\(auth\.user\.userId, input\.requestId\)/u,
          /\.eq\('id', ticketId\)\.eq\('user_id', auth\.user\.userId\)/u,
          /mode: 'completed'.*ownedDigitalHumanAsset/su,
        ]),
        contract('src/app/api/digital-human/upload-session/route.ts','上传完成会话按 user 与 request identity 固化数字人音频资产',[
          /export async function POST/u,
          /requestIdentity\(body, auth\.user\.userId\)/u,
          /assertDigitalHumanUploadRecord\(record, auth\.user\.userId/u,
          /uploadState: 'completed'/u,
          /ownedDigitalHumanAsset\(auth\.user\.userId, record\.id\)/u,
        ]),
      ],
      service:[
        contract('src/commerce/server/digital-human-audio-candidates.ts','只暴露 owner 内持久音频；生成音频必须匹配成功语音任务',[
          /COMMERCE_DIGITAL_HUMAN_AUDIO_BRIDGE_VERSION='commerce-digital-human-audio-bridge\/v1'/u,
          /asset\.owner===owner/u,
          /job\.owner===owner&&job\.status==='succeeded'/u,
          /voiceJob\.id!==asset\.jobId\|\|voiceJob\.assetId!==asset\.id/u,
          /DIGITAL_HUMAN_AUDIO_MAX_BYTES/u,
        ]),
        contract('src/features/digital-human/commerce-audio-bridge.ts','读回字节校验大小与 SHA-256，以稳定 requestId 复制到现有上传链',[
          /export function commerceAudioUploadRequestId/u,
          /export async function transferCommerceAudioToDigitalHuman/u,
          /sourceBytes\.byteLength!==candidate\.size/u,
          /await sha256\(sourceBytes\)!==candidate\.sha256/u,
          /\/api\/digital-human\/upload-ticket/u,
          /\/api\/digital-human\/upload-session/u,
          /'Idempotency-Key':requestId/u,
        ],[/\/api\/digital-human\/generate/u,/\/api\/voice\/tts/u,/\/cash|billing/u]),
      ],
      storage:[
        contract('src/commerce/server/digital-human-audio-candidates.ts','候选来自已有 Commerce 资产与语音任务持久记录',[
          /selectDigitalHumanAudioCandidates\(owner,assets\(owner\),voiceJobs\(owner\)\)/u,
          /completionEvidence:voiceJob\?'voice-job-succeeded':'persisted-upload'/u,
        ]),
        contract('src/app/api/digital-human/upload-ticket/route.ts','上传票据与 user_files 记录绑定当前主账号',[
          /\.from\('user_files'\)/u,
          /user_id: auth\.user\.userId/u,
          /file_category: input\.category/u,
          /file_size: input\.size/u,
        ]),
        contract('src/app/api/digital-human/upload-session/route.ts','完成态和幂等回放均从 owner 绑定资产读回',[
          /uploadState: 'completed'/u,
          /idempotentReplay: true/u,
          /idempotentReplay: !updated\.data/u,
          /\.eq\('id', record\.id\)\.eq\('user_id', auth\.user\.userId\)/u,
        ]),
      ],
    },
  },
  {
    id:'voice-admin-reconciliation',
    label:'语音未知终态人工对账',
    steps:[8,9],
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/voice-synthesis-studio.tsx','用户只可检查原幂等资产或申请人工对账',[
        /系统不会自动重发，也不会自动退款/u,
        /action:'retry-save'\|'request-reconciliation'/u,
        /提交人工对账申请/u,
        /未知终态不会自动轮询/u,
      ])],
      api:[contract('src/app/api/admin/commerce/voice-reconciliation/route.ts','管理员鉴权后按证据明确成功或失败终态',[
        /requireCommerceAdmin\(request,true\)/u,
        /'resolve-success','resolve-failed'/u,
        /resolveVoiceReconciliation/u,
        /providerTaskId/u,
        /resultAssetId/u,
      ])],
      service:[contract('src/commerce/server/voice-jobs.ts','未知终态不自动重试；人工成功记收入，人工明确失败才退款',[
        /export async function retryVoiceAssetRecovery/u,
        /export function requestVoiceReconciliation/u,
        /export async function resolveVoiceReconciliation/u,
        /initial\.status!=='submission_unknown'\|\|initial\.billingState!=='reconciliation_required'/u,
        /if\(input\.outcome==='success'\)/u,
        /return settleRevenue\(succeeded\)/u,
        /return settleRefund\(failed\)/u,
      ])],
      storage:[contract('src/commerce/server/voice-jobs.ts','仅保存证据哈希、供应商任务号和租约保护的终态',[
        /evidenceHash=hash\(\{schema:'commerce-voice-reconciliation-evidence\/v1'/u,
        /claimRecordLease\(LEASE_BUCKET,input\.id,input\.owner/u,
        /outcome:'success',evidenceHash,providerTaskId/u,
        /outcome:'failed',evidenceHash,providerTaskId/u,
        /voiceReconciliationJobs\(\)/u,
      ])],
    },
  },
];

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

function sourceFor(file:string,cache:Map<string,string>){
  const absolute=path.resolve(repoRoot,...file.split('/'));
  assert.ok(absolute.startsWith(`${repoRoot}${path.sep}`),`源码合同路径越界：${file}`);
  let value=cache.get(file);
  if(value===undefined){value=readFileSync(absolute,'utf8');cache.set(file,value);}
  return value;
}

function section(source:string,start:string,end:string){
  const from=source.indexOf(start);
  assert.ok(from>=0,`缺少函数起点：${start}`);
  const to=source.indexOf(end,from+start.length);
  assert.ok(to>from,`缺少函数终点：${end}`);
  return source.slice(from,to);
}

function isDirectExecution(){
  const entry=process.argv[1];
  return Boolean(entry)&&path.resolve(entry).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase();
}

export function verifyCommerceTutorialAdjunctChainsZeroCost(){
  let passed=0;
  let sourceAssertions=0;
  const check=(condition:unknown,message:string)=>{assert.ok(condition,message);passed+=1;};
  const effects:EffectCounters={network:0,provider:0,wallet:0,browser:0,database:0,production:0,paidGeneration:0,benchmarkVideoSubmissions:0};
  const cache=new Map<string,string>();

  const suiteSource=readFileSync(fileURLToPath(import.meta.url),'utf8');
  const imports=[...suiteSource.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(match=>match[1]);
  check(imports.every(value=>['node:assert/strict','node:fs','node:path','node:url'].includes(value)),'零费用合同测试不得导入产品、数据库、供应商或浏览器模块');
  check(!/\bfetch\s*\(/u.test(suiteSource),'零费用合同测试不得主动发起网络请求');
  check(!/\b(?:spawn|execFile|execSync)\s*\(/u.test(suiteSource),'零费用合同测试不得启动子进程');

  check(COMMERCE_TUTORIAL_ADJUNCT_MAP.length>=5,'补充链路能力数量异常下降');
  check(new Set(COMMERCE_TUTORIAL_ADJUNCT_MAP.map(item=>item.id)).size===COMMERCE_TUTORIAL_ADJUNCT_MAP.length,'补充链路能力 ID 必须唯一');
  const mappedSteps=[...new Set(COMMERCE_TUTORIAL_ADJUNCT_MAP.flatMap(item=>item.steps))].sort((a,b)=>a-b);
  check(JSON.stringify(mappedSteps)===JSON.stringify(EXPECTED_STEPS),'必须覆盖教程步骤 2/6/7/8/9');

  const matrix=[];
  for(const capability of COMMERCE_TUTORIAL_ADJUNCT_MAP){
    check(capability.steps.length>0,`${capability.label} 缺少教程步骤映射`);
    check(capability.steps.every(step=>EXPECTED_STEPS.includes(step)),`${capability.label} 出现越界教程步骤`);
    const layers={} as Record<SourceLayer,{files:string[];assertions:number}>;
    for(const layer of LAYERS){
      const contracts=capability.evidence[layer];
      check(contracts.length>0,`${capability.label} 缺少 ${layer} 证据`);
      const files=[] as string[];
      let assertions=0;
      for(const item of contracts){
        check(item.file.startsWith('src/'),`${capability.label} 的 ${layer} 必须引用产品源码`);
        check(item.purpose.trim().length>=8,`${capability.label} 的 ${layer} 缺少审计用途`);
        check(item.mustMatch.length>0,`${capability.label} 的 ${layer} 缺少正向合同`);
        const source=sourceFor(item.file,cache);
        for(const pattern of item.mustMatch){check(pattern.test(source),`${capability.label} ${layer} 合同不匹配：${item.file} ${pattern}`);sourceAssertions+=1;assertions+=1;}
        for(const pattern of item.mustNotMatch||[]){check(!pattern.test(source),`${capability.label} ${layer} 命中禁止合同：${item.file} ${pattern}`);sourceAssertions+=1;assertions+=1;}
        files.push(item.file);
      }
      layers[layer]={files:[...new Set(files)],assertions};
    }
    matrix.push({id:capability.id,label:capability.label,steps:capability.steps,layers});
  }

  const voiceJobs=sourceFor('src/commerce/server/voice-jobs.ts',cache);
  const recovery=section(voiceJobs,'export async function recoverVoiceJobs','export async function retryVoiceAssetRecovery');
  const retrySave=section(voiceJobs,'export async function retryVoiceAssetRecovery','export function requestVoiceReconciliation');
  const requestReconciliation=section(voiceJobs,'export function requestVoiceReconciliation','export function voiceReconciliationJobs');
  const resolveReconciliation=section(voiceJobs,'export async function resolveVoiceReconciliation','\n}');
  const voiceRoute=sourceFor('src/app/api/commerce/voice-synthesis/route.ts',cache);
  const readScheduling=section(voiceRoute,'const workerEligible=','if(workerEligible)');
  const voiceReplaceRoute=sourceFor('src/app/api/commerce/voice-replace/route.ts',cache);
  const voiceReplaceRead=section(voiceReplaceRoute,'export async function GET','export async function POST');
  check(!recovery.includes("submission_unknown"),'后台恢复候选不得包含 submission_unknown');
  check(!readScheduling.includes("submission_unknown"),'只读任务接口不得调度 submission_unknown');
  check(!retrySave.includes('executeCommerceVoice'),'未知任务检查已有资产不得重提供应商');
  check(!retrySave.includes('settleRefund'),'未知任务检查已有资产不得退款');
  check(!requestReconciliation.includes('executeCommerceVoice'),'申请人工对账不得重提供应商');
  check(!requestReconciliation.includes('settleRefund'),'申请人工对账不得退款');
  check(!/reconciliation=\{[^}]*\bevidence:/su.test(resolveReconciliation),'人工对账不得把原始证据写入任务记录');
  check(!voiceReplaceRead.includes('schedule('),'应用配音 GET 只能读回原任务，不得在轮询请求内执行媒体任务');

  const uniqueFiles=[...cache.keys()].sort();
  check(uniqueFiles.length>=8,'补充链路没有形成足够的独立源码证据');
  check(Object.values(effects).every(value=>value===0),'零费用合同测试出现外部副作用');
  return {suite:'commerce-tutorial-adjunct-chains-zero-cost',passed,sourceAssertions,steps:mappedSteps,capabilities:matrix,sourceFiles:uniqueFiles,effects};
}

async function main(){
  const effects={network:0};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{effects.network+=1;throw new Error('ZERO_COST_NETWORK_FORBIDDEN');};
  try{
    const result=verifyCommerceTutorialAdjunctChainsZeroCost();
    assert.equal(effects.network,0,'验收过程中发生了网络请求');
    console.log(JSON.stringify(result));
  }finally{globalThis.fetch=originalFetch;}
}

if(isDirectExecution())main().catch(error=>{console.error(error);process.exitCode=1;});
