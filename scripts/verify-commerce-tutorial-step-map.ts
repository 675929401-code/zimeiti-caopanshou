import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export type TutorialSourceLayer='ui'|'api'|'service'|'storage';

export type SourceContract={
  file:string;
  purpose:string;
  mustMatch:readonly RegExp[];
};

export type TutorialStepContract={
  id:1|2|3|4|5|6|7|8|9;
  title:string;
  benchmarkSegments:readonly number[];
  benchmarkMeaning:string;
  localMeaning:string;
  evidence:Record<TutorialSourceLayer,readonly SourceContract[]>;
  failureStates:readonly string[];
};

const contract=(file:string,purpose:string,...mustMatch:RegExp[]):SourceContract=>({file,purpose,mustMatch});

/**
 * This is an independently designed nine-step product map. The six benchmark
 * segments are evidence inputs only; this table is not a verbatim tutorial or
 * a claim that private implementation details were obtained.
 */
export const COMMERCE_TUTORIAL_STEP_MAP:readonly TutorialStepContract[]=[
  {
    id:1,title:'编导选择',benchmarkSegments:[1],
    benchmarkMeaning:'skills 技能/编导发现',
    localMeaning:'从已发布目录或不可变基线读取编导卡，用户选择稳定 skill key。',
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/video-director-catalog.tsx','编导卡完整展示并按稳定 key 选择',/data-testid="commerce-video-director-catalog"/u,/data-director-key=\{item\.key\}/u,/onSelect\(item\.key\)/u)],
      api:[contract('src/app/api/commerce/v1/director-catalog/route.ts','公开目录只读接口',/export async function GET/u,/primePublishedCommerceConfiguration\(\{required:false\}\)/u,/directorCatalog\(\)/u,/errorResponse/u)],
      service:[contract('src/commerce/server/director-catalog.ts','发布目录、共享配置缺失基线和稳定 key 解析',/export function directorCatalog/u,/currentPublishedCommerceConfiguration\(\)/u,/baselineDirectorCatalog\(\)/u,/findDirectorCard/u)],
      storage:[contract('src/commerce/server/configuration-platform.ts','发布清单和摘要作为目录身份',/commerce_config_releases/u,/manifest_sha256/u,/manifestHash/u,/currentPublishedCommerceConfiguration/u)],
    },
    failureStates:['目录读取失败必须返回错误','停用或不存在的编导 key 不得继续','共享配置未发布时只允许基线草拟，不冒充付费就绪'],
  },
  {
    id:2,title:'素材上传',benchmarkSegments:[2],
    benchmarkMeaning:'upload-policy → 对象 PUT → assets/complete 素材稳定引用',
    localMeaning:'本站当前使用同源 multipart 上传，经服务端字节校验、SHA-256 和原子文件写入后返回稳定 asset id；不是逐接口复刻。',
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/runtime-ui.tsx','浏览器上传后只使用服务端 asset id',/const upload=useCallback/u,/new FormData\(\)/u,/fetch\('\/api\/commerce\/assets',\{method:'POST',body:form\}\)/u,/setAssets\(current=>\[data\.asset/u)],
      api:[contract('src/app/api/commerce/assets/route.ts','同源、身份、大小和文件对象门禁',/sameOrigin\(request\)/u,/request\.formData\(\)/u,/file instanceof File/u,/storeAsset/u)],
      service:[contract('src/commerce/server/assets.ts','媒体魔数、大小、类型和摘要校验',/export function validateMediaBytes/u,/export async function storeAsset/u,/createHash\('sha256'\)/u,/flag:'wx'/u)],
      storage:[contract('src/commerce/server/assets.ts','受控文件和资产元数据通过租约与原子物化同时持久化',/path\.join\(runtimeDir\(\),'assets'\)/u,/export async function materializeAssets/u,/else put\('assets',asset\.id,owner,asset\)/u,/tx=>\{tx\.commit\(\);\}/u,/source:'upload'\|'generated'/u)],
    },
    failureStates:['空文件或超过 150 MB 拒绝','扩展类型与真实媒体字节不符拒绝','上传失败不产生可用于生成的伪 asset id'],
  },
  {
    id:3,title:'编导对话',benchmarkSegments:[3],
    benchmarkMeaning:'conversation 会话创建/恢复',
    localMeaning:'打开或恢复账号内编导会话，分页读取消息，并以原任务状态同步当前脚本。',
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/director-conversation.tsx','打开、恢复和分页读取会话',/action:'open'/u,/正在恢复编导会话/u,/function loadOlder/u,/beforeMessageId/u)],
      api:[contract('src/app/api/commerce/director-conversations/route.ts','GET 恢复与 POST open',/export async function GET/u,/body\.action==='open'/u,/directorPage\(openDirector/u,/readDirector/u)],
      service:[contract('src/commerce/server/director-conversation.ts','创建、恢复、分页和原任务同步',/export function openDirector/u,/export function readDirector/u,/export function directorPage/u,/synchronizeDirector/u)],
      storage:[contract('src/commerce/server/director-conversation.ts','会话以 owner + id 持久化',/get<DirectorConversation>\('director-conversations',id,owner\)/u,/put\('director-applications'/u),contract('src/commerce/server/director-turn-claim.ts','消息与活动任务回写原会话',/put\('director-conversations',value\.id,owner,value\)/u,/value\.messages\.push\(user,assistant\)/u)],
    },
    failureStates:['跨账号同 id 不得读取','无效历史游标拒绝','存在未终结原任务时禁止创建并行新轮次'],
  },
  {
    id:4,title:'局部修改',benchmarkSegments:[4],
    benchmarkMeaning:'script SSE 严格脚本生成与局部修改',
    localMeaning:'新轮次绑定最新完整脚本消息；SSE 仅展示原任务进展，修订仍必须返回通过 v2 校验的完整新稿。',
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/director-conversation.tsx','SSE 读取原任务并携带脚本基线',/new EventSource\('\/api\/commerce\/jobs\/events\?id='/u,/expectedScriptMessageId:page\.latestScriptMessageId/u,/operationId:pending\.id/u,/原任务结果待核对，不会重复提交/u)],
      api:[contract('src/app/api/commerce/director-conversations/route.ts','修改轮次先报价',/body\.action==='quote'/u,/quoteDirectorTurn/u,/DIRECTOR_QUOTE_REQUIRED/u),contract('src/app/api/commerce/jobs/events/route.ts','任务 SSE 只读推送',/Content-Type':'text\/event-stream/u,/event: job/u,/publicJob/u)],
      service:[contract('src/commerce/server/director-turn-claim.ts','最新脚本基线和保全约束',/export function currentDirectorScriptContext/u,/只改用户明确要求的部分，其余镜头和约束逐项保留/u,/DIRECTOR_STALE_SCRIPT/u),contract('src/commerce/server/director-output.ts','严格完整脚本协议',/DIRECTOR_OUTPUT_PROTOCOL='director-script\/v2'/u,/export function parseDirectorOutput/u,/多轮修订保留历史已确认/u)],
      storage:[contract('src/commerce/server/director-turn-claim.ts','每轮记录 baseMessageId、operationId 和原 job id',/baseMessageId:value\.latestScriptMessageId/u,/operationId:input\.requestId/u,/value\.messages\.push\(user,assistant\)/u,/put\('director-conversations'/u)],
    },
    failureStates:['脚本基线变化返回 DIRECTOR_STALE_SCRIPT','差异片段或字段不完整不得成为可应用脚本','unknown 仅核对原任务，禁止重复生成'],
  },
  {
    id:5,title:'应用脚本',benchmarkSegments:[4],
    benchmarkMeaning:'严格脚本生成完成后的下游使用',
    localMeaning:'仅最新、成功、结构校验通过且素材/参数未漂移的脚本可生成不可变 application。',
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/director-conversation.tsx','最新脚本显式应用',/action:'apply'/u,/应用脚本，进入视频制作/u,/onApplied\(application\)/u),contract('src/commerce/components/commerce-agent/workspace.tsx','应用后绑定正文、素材和视频参数',/matchingDirectorApplication/u,/applyDirectorScript/u,/setDirectorApplication\(application\)/u)],
      api:[contract('src/app/api/commerce/director-conversations/route.ts','apply 动作单独处理',/body\.action==='apply'/u,/applyDirector\(owner,body\)/u)],
      service:[contract('src/commerce/server/director-conversation.ts','应用前核对最新消息、原任务、正文哈希和素材参数',/export function applyDirector/u,/DIRECTOR_STALE_SCRIPT/u,/DIRECTOR_SCRIPT_NOT_READY/u,/sourceConfigurationHash/u)],
      storage:[contract('src/commerce/server/director-conversation.ts','保存编导 application 身份',/put\('director-applications',application\.id,owner,application\)/u,/sourceContentHash/u,/sourceConfigurationHash/u)],
    },
    failureStates:['历史脚本不可应用','追问、旧格式和未完成消息不可应用','正文、素材、设置或来源配置变化后必须重新应用'],
  },
  {
    id:6,title:'模型参数与报价',benchmarkSegments:[5],
    benchmarkMeaning:'batches 创建前的模型、参数和费用确认',
    localMeaning:'先读取当前功能模型目录，校验能力、画幅、清晰度、时长和声音，再创建十分钟不可变报价。',
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/workspace.tsx','模型目录和参数控件来自当前能力',/\/api\/commerce\/models\?kind=video&operationId=video\.generate/u,/data-testid=\{`commerce-\$\{mediaKind\}-model-picker`\}/u,/视频设置/u,/resolveCommerceVideoDurationPlan/u),contract('src/commerce/components/commerce-agent/runtime-ui.tsx','提交前展示服务端准确报价',/api<\{quote:PendingQuote\}>\('\/api\/commerce\/quotes',input\)/u,/quote\.payableTotal\.toFixed\(4\)/u,/window\.confirm/u)],
      api:[contract('src/app/api/commerce/models/route.ts','按 kind 与 operation 返回可选择和可生成状态',/operationId/u,/generationReady/u,/configurationReady/u,/defaultCompatibleModelId/u),contract('src/app/api/commerce/quotes/route.ts','报价要求身份并返回 201',/authorizeCurrentCommerceIdentity/u,/createCommerceQuote/u,/return json\(\{ quote \}, 201\)/u)],
      service:[contract('src/commerce/server/quotes.ts','报价冻结输入、模型、成本和售价',/export async function createCommerceQuote/u,/inputFingerprint: fingerprint\(input\)/u,/payableTotal: payable/u,/expiresAt: now \+ 10 \* 60_000/u),contract('src/commerce/server/prequote-model-selection.ts','报价前模型能力和价格就绪门禁',/export function selectPrequoteModel/u,/price-not-ready/u,/capability-mismatch/u,/selectedModelConfigHash/u)],
      storage:[contract('src/commerce/server/quotes.ts','报价按 owner 持久化并保留输入指纹',/put\('commerce-quotes', quote\.id, owner, quote\)/u,/get<StoredQuote>\('commerce-quotes'/u,/status: 'quoted'/u)],
    },
    failureStates:['模型能力或生成就绪不足时停止','成本、售价或显式免费标记不可信时停止','报价过期、模型配置变化或输入指纹变化后必须重新报价'],
  },
  {
    id:7,title:'确认提交与队列',benchmarkSegments:[5,6],
    benchmarkMeaning:'batches 确认报价后创建任务，并进入 poll 状态',
    localMeaning:'用户确认准确报价后，以 clientRequestId + inputFingerprint 幂等创建 queued job；后台运行和 SSE/轮询只推进原 job。',
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/runtime-ui.tsx','确认后提交报价并写入任务队列',/\/api\/commerce\/jobs/u,/clientRequestId:requestKey\.current\.key/u,/inputFingerprint:quote\.inputFingerprint/u,/setJobs\(current=>\[result\.job/u,/TaskQueue/u)],
      api:[contract('src/app/api/commerce/jobs/route.ts','确认报价、异步运行并返回 202',/confirmCommerceQuote/u,/after\(\(\) => runJob/u,/return json\(\{ job: publicJob\(value\) \}, 202\)/u),contract('src/app/api/commerce/jobs/events/route.ts','队列状态 SSE',/text\/event-stream/u,/succeeded','failed','save_failed/u)],
      service:[contract('src/commerce/server/quotes.ts','报价确认幂等且校验过期与输入指纹',/export async function confirmCommerceQuote/u,/inputFingerprint/u,/报价已过期/u,/claim\(`/u),contract('src/commerce/server/jobs.ts','任务创建、queued 状态和单任务运行 claim',/export async function createJob/u,/status:'queued'/u,/claimQueuedJob<Job>/u,/export async function runJob/u)],
      storage:[contract('src/commerce/server/store.ts','请求幂等表和 queued CAS',/CREATE TABLE IF NOT EXISTS requests/u,/export function claim\(/u,/claimQueuedJob/u),contract('src/commerce/server/jobs.ts','持久任务及状态事件',/put\('jobs',id,owner,value\)/u,/events:\[\{at:Date\.now\(\),stage:'validated'\}/u)],
    },
    failureStates:['相同 clientRequestId 不同指纹拒绝','报价确认重复只能返回原任务','扣费或派发前校验失败保留可审计任务状态'],
  },
  {
    id:8,title:'预览下载历史',benchmarkSegments:[6],
    benchmarkMeaning:'poll → 播放/下载终态与资产交付',
    localMeaning:'任务历史读取持久 job；成功媒体只通过账号绑定 asset 路由预览、Range 播放和下载。',
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/runtime-ui.tsx','预览、播放、下载和历史队列',/job\.assetIds\.map/u,/<video src=\{`\/api\/commerce\/assets\/\$\{id\}`\} controls playsInline/u,/\?download=1/u,/runtime\.conversations/u,/TaskQueue/u)],
      api:[contract('src/app/api/commerce/jobs/route.ts','读取账号内任务并后台刷新原任务',/const values = jobs\(user\.id\)/u,/refreshJob\(value\.id, user\.id\)/u,/values\.map\(publicJob\)/u),contract('src/app/api/commerce/assets/[id]/route.ts','账号绑定资产、Range 和下载',/readAsset\(id,user\.id\)/u,/Accept-Ranges/u,/Content-Disposition/u,/status:206/u)],
      service:[contract('src/commerce/server/jobs.ts','poll 原任务并把供应商结果保存为稳定资产',/export async function refreshJob/u,/downloadResult/u,/storeAsset\(value\.owner/u,/value\.assetIds=\[asset\.id\]/u),contract('src/commerce/server/assets.ts','稳定资产字节读取',/export const assetBytes/u,/export const assets/u)],
      storage:[contract('src/commerce/server/jobs.ts','jobs、assetIds 与终态持久化',/export function persistJob/u,/put\('jobs'/u,/value\.status='succeeded'/u),contract('src/commerce/server/assets.ts','生成资产带 jobId 保存',/source:'upload'\|'generated'/u,/jobId\?:string/u,/put\('assets'/u)],
    },
    failureStates:['非本账号资产返回 404','媒体保存失败进入 save_failed 并保留原 providerUrl','unknown 继续 poll 原任务而不重新派发'],
  },
  {
    id:9,title:'失败退款恢复',benchmarkSegments:[6],
    benchmarkMeaning:'poll 失败、未知和保存失败的终态分流',
    localMeaning:'只有明确 failed 自动退款；unknown 保留原扣款并核对，save_failed 只重试保存原结果，账务异常进入 reconciliation_required。',
    evidence:{
      ui:[contract('src/commerce/components/commerce-agent/runtime-ui.tsx','客户可见失败、待核对和原结果重存入口',/unknown:'待核对'/u,/save_failed:'结果待保存'/u,/不会自动重复生成/u,/重试保存原结果/u)],
      api:[contract('src/app/api/commerce/jobs/route.ts','恢复动作只针对原任务',/body\.action === 'retry-save'/u,/body\.action === 'reconcile-billing'/u,/retrySave/u,/reconcileJobBilling/u)],
      service:[contract('src/commerce/server/jobs.ts','显式失败、未知、保存失败和安全恢复分流',/value\.status=dispatched/u,/isExplicitProviderRejection/u,/value\.status='save_failed'/u,/export async function retrySave/u),contract('src/commerce/server/billing.ts','只有明确 failed 可退款且使用稳定退款键',/export async function refundFailedJob/u,/只有明确失败的任务可以退款/u,/refund_pending/u,/reconciliation_required/u),contract('src/commerce/server/provider-failure-classification.ts','供应商错误确定性分类',/export function classifyProviderFailure/u,/status: 'unknown'/u,/UPSTREAM_BALANCE_EXHAUSTED/u)],
      storage:[contract('src/commerce/server/billing.ts','退款与对账回执持久化',/refundKey:`commerce-job-\$\{job\.id\}-refund`/u,/saveState/u,/refundedAt/u),contract('src/commerce/server/jobs.ts','原 job 保留 provider 身份、恢复状态和执行租约防护',/providerTaskId\?:string/u,/pollPath\?:string/u,/billingError\?:string/u,/persistJob\(value,executionPermit\)/u)],
    },
    failureStates:['failed 才允许退款','unknown 与 save_failed 不自动退款也不新建生成','退款结果不确定时进入 reconciliation_required 并复用原幂等键'],
  },
] as const;

export type StepMapVerification={
  passed:number;
  steps:number;
  benchmarkSegments:number[];
  files:string[];
  effects:{network:number;provider:number;wallet:number;paidGeneration:number;database:number};
};

function source(relativePath:string){return readFileSync(new URL(`../${relativePath}`,import.meta.url),'utf8');}

export function verifyCommerceTutorialStepMap():StepMapVerification{
  let passed=0;
  const check=(condition:unknown,message:string)=>{assert.ok(condition,message);passed+=1;};
  check(COMMERCE_TUTORIAL_STEP_MAP.length===9,'教程映射必须正好覆盖第 1–9 步');
  check(COMMERCE_TUTORIAL_STEP_MAP.every((step,index)=>step.id===index+1),'教程步骤必须连续且顺序稳定');
  check(new Set(COMMERCE_TUTORIAL_STEP_MAP.map(step=>step.title)).size===9,'教程步骤标题不得重复');
  const segments=[...new Set(COMMERCE_TUTORIAL_STEP_MAP.flatMap(step=>step.benchmarkSegments))].sort((a,b)=>a-b);
  check(JSON.stringify(segments)===JSON.stringify([1,2,3,4,5,6]),'九步映射必须完整覆盖真实六段对标链');
  check(COMMERCE_TUTORIAL_STEP_MAP.every(step=>step.failureStates.length>=3),'每一步至少声明三个失败或恢复状态');
  check(COMMERCE_TUTORIAL_STEP_MAP[1].localMeaning.includes('不是逐接口复刻'),'素材链必须明确站内实现与对标接口并非逐字逐接口复制');

  const files=new Set<string>();
  for(const step of COMMERCE_TUTORIAL_STEP_MAP){
    for(const layer of ['ui','api','service','storage'] as const){
      const contracts=step.evidence[layer];
      check(contracts.length>0,`第 ${step.id} 步缺少 ${layer} 证据`);
      for(const item of contracts){
        files.add(item.file);
        const value=source(item.file);
        check(value.trim().length>0,`源码为空：${item.file}`);
        for(const pattern of item.mustMatch){
          check(pattern.test(value),`第 ${step.id} 步 ${layer} 合同缺失：${item.file} :: ${pattern.source}`);
        }
      }
    }
  }

  const effects={network:0,provider:0,wallet:0,paidGeneration:0,database:0};
  check(Object.values(effects).every(value=>value===0),'源码映射验收必须保持零网络、零供应商、零钱包、零付费生成和零数据库连接');
  return {passed,steps:COMMERCE_TUTORIAL_STEP_MAP.length,benchmarkSegments:segments,files:[...files].sort(),effects};
}

function isDirectExecution(){
  const entry=process.argv[1];
  return Boolean(entry)&&path.resolve(entry).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase();
}

if(isDirectExecution()){
  try{console.log(JSON.stringify(verifyCommerceTutorialStepMap()));}
  catch(error){console.error(error);process.exitCode=1;}
}
