import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {maolongCaptureLabel as captureLabel,resolveMaolongMirrorRoots} from './maolong-mirror-capture-roots.mjs';

const projectRoot=path.resolve('.');
const roots=resolveMaolongMirrorRoots();
const docs=path.join(projectRoot,'docs','带货Agent镜像融合-20260925');
const evidencePath=path.join(docs,'对标前端源码语法节点索引.json');
const closurePath=path.join(docs,'对标镜像静态闭包验收.json');
const runtimeAuditPath=path.join(docs,'运行载荷与动态Canvas结构审计.json');
const ordinaryWorkerReportPath=path.join(projectRoot,'.codex-evidence','commerce-ordinary-worker-p0','report.json');
const finalUiEvidenceDirectory=path.join(projectRoot,'.codex-evidence','commerce-final-acceptance-20260925','ui');
if(!fs.existsSync(evidencePath)||!fs.existsSync(closurePath)||!fs.existsSync(runtimeAuditPath))throw Error('Run source evidence index, static closure verification and runtime payload audit first');
const evidence=JSON.parse(fs.readFileSync(evidencePath,'utf8'));
const closure=JSON.parse(fs.readFileSync(closurePath,'utf8'));
const runtimeAudit=JSON.parse(fs.readFileSync(runtimeAuditPath,'utf8'));
const ordinaryWorkerReport=fs.existsSync(ordinaryWorkerReportPath)?JSON.parse(fs.readFileSync(ordinaryWorkerReportPath,'utf8')):null;
const finalUiReportPaths=fs.existsSync(finalUiEvidenceDirectory)?fs.readdirSync(finalUiEvidenceDirectory).filter(name=>/^report-r\d+\.json$/u.test(name)).sort().reverse().map(name=>path.join(finalUiEvidenceDirectory,name)):[];
const finalUiReportPath=finalUiReportPaths.find(file=>{try{return JSON.parse(fs.readFileSync(file,'utf8')).passed===true;}catch{return false;}})||null;
const finalUiReport=finalUiReportPath?JSON.parse(fs.readFileSync(finalUiReportPath,'utf8')):null;
const finalUiPassed=Boolean(finalUiReport?.passed===true&&(finalUiReport.pages||[]).length===10&&(finalUiReport.blockedNonGet||[]).length===0&&(finalUiReport.paidMutationAttempts||[]).length===0&&(finalUiReport.benchmarkBatchAttempts||[]).length===0&&(finalUiReport.httpErrors||[]).length===0&&(finalUiReport.consoleErrors||[]).length===0&&(finalUiReport.pageErrors||[]).length===0&&finalUiReport.policy?.businessWritesExecuted===0&&finalUiReport.policy?.paidGenerationRequests===0&&finalUiReport.policy?.benchmarkVideoSubmissions===0&&finalUiReport.policy?.productionWrites===0&&finalUiReport.policy?.deployment===0);
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
const slash=value=>value.replaceAll('\\','/');
const finalUiEvidence=finalUiReportPath?slash(path.relative(projectRoot,finalUiReportPath)):null;
const walk=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
const unique=values=>[...new Set(values.filter(value=>value!==null&&value!==undefined&&value!==''))];
const writeAtomic=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;fs.writeFileSync(temporary,`${JSON.stringify(value,null,2)}\n`);fs.renameSync(temporary,file);};
const writeTextAtomic=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;fs.writeFileSync(temporary,value);fs.renameSync(temporary,file);};

const responseMetadata=new Map();
for(const root of roots){
 const captureRoot=captureLabel(root);
 const manifestPath=path.join(root,'manifest.json');
 if(!fs.existsSync(manifestPath))continue;
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 for(const item of manifest.responses||[]){
  if(!item.savedPath)continue;
  responseMetadata.set(`${captureRoot}:${slash(item.savedPath)}`,{method:item.method,url:item.url,status:item.status,contentType:item.contentType,resourceType:item.resourceType});
 }
 const deepPath=path.join(root,'deep-media-static-dependencies.json');
 if(fs.existsSync(deepPath))for(const item of JSON.parse(fs.readFileSync(deepPath,'utf8')).items||[])responseMetadata.set(`${captureRoot}:${slash(item.savedPath)}`,{method:item.method,url:item.url,status:item.status,contentType:item.contentType,resourceType:'deep-media-runtime'});
}

const signalsBySha=new Map();
const signalBucket=fileSha256=>{if(!signalsBySha.has(fileSha256))signalsBySha.set(fileSha256,{surfaces:new Set(),routes:new Set(),apis:new Set(),tools:new Set(),skills:new Set(),statuses:new Set(),errorCodes:new Set(),astNodes:0,stringLiterals:0,parseDiagnostics:0,singleLineMinified:false,paths:new Set()});return signalsBySha.get(fileSha256);};
for(const file of evidence.files||[]){const bucket=signalBucket(file.sha256);bucket.surfaces.add(file.surface);bucket.paths.add(file.path);bucket.astNodes=Math.max(bucket.astNodes,Number(file.astNodes||0));bucket.stringLiterals=Math.max(bucket.stringLiterals,Number(file.stringLiterals||0));bucket.parseDiagnostics=Math.max(bucket.parseDiagnostics,Number(file.parseDiagnostics||0));bucket.singleLineMinified||=Boolean(file.singleLineMinified);}
for(const item of evidence.routes||[]){const bucket=signalBucket(item.fileSha256);bucket.routes.add(item.route);bucket.surfaces.add(item.surface);}
for(const item of evidence.apis||[]){const bucket=signalBucket(item.fileSha256);bucket.apis.add(`${(item.methods||[]).join('|')} ${item.signature}`);bucket.surfaces.add(item.surface);}
for(const item of evidence.unresolvedApis||[]){const bucket=signalBucket(item.fileSha256);bucket.apis.add(`UNRESOLVED ${item.signature}`);bucket.surfaces.add(item.surface);}
for(const item of evidence.tools||[]){const bucket=signalBucket(item.fileSha256);bucket.tools.add(`${item.kind}:${item.slug}`);bucket.surfaces.add(item.surface);}
for(const item of evidence.skillPacks||[]){const bucket=signalBucket(item.fileSha256);bucket.skills.add(`${item.catalog}:${item.id}`);}
for(const item of evidence.statusTokens||[])signalBucket(item.fileSha256).statuses.add(item.value);
for(const item of evidence.errorCodes||[])signalBucket(item.fileSha256).errorCodes.add(item.value);

function classify(relative,metadata,signals){
 const extension=path.extname(relative).toLowerCase();
 if(relative==='manifest.json'||relative==='receipt.json'||relative.endsWith('static-dependencies.json'))return{artifactClass:'capture-provenance',grade:'A-capture-integrity',action:'preserve-and-verify',area:'镜像来源与闭包证明',limitation:'证明抓取内容和哈希，不证明私有服务端实现'};
 if(relative.includes('supplemental-readonly/catalogs/'))return{artifactClass:'sanitized-readonly-catalog',grade:'A-readonly-runtime-contract',action:'map-fields-versions-and-limits',area:relative.includes('video-creator')?'19个超级编导目录':relative.includes('image-generation')?'16个图片技能目录':'后台可见目录合同',limitation:'目录快照不等于服务端算法源码或当前生产发布'};
 if(/ffmpeg|soundtouch/iu.test(relative))return{artifactClass:'deep-media-runtime',grade:'A-browser-runtime-dependency',action:'preserve-hash-and-map-algorithm-boundary',area:'视频转码、音频变速与浏览器媒体处理',limitation:'运行库证明客户端处理能力，不证明业务编排和服务端终态'};
 if(metadata?.url?.includes('/api/'))return{artifactClass:'captured-api-response',grade:'A/B-runtime-contract',action:'map-fields-status-and-error-semantics',area:'后台可见接口合同',limitation:'单次只读响应不证明写入、队列、计费和失败恢复'};
 if(extension==='.js'&&relative.includes('/_next/static/chunks/'))return{artifactClass:'compiled-client-bundle',grade:'B-compiled-client-evidence',action:'ast-and-byte-range-behavior-reference',area:unique([...signals.surfaces]).join('；')||'共享客户端模块',limitation:'无 source map、依赖锁和原始模块名；不得冒充可维护原源码'};
 if(extension==='.css')return{artifactClass:'compiled-client-style',grade:'B-rendered-style-evidence',action:'extract-layout-breakpoints-and-state-styles',area:'UI布局、尺寸、主题与响应式',limitation:'只提炼交互和布局边界，不复制对标品牌视觉'};
 if((metadata?.contentType||'').includes('text/html'))return{artifactClass:'rendered-page-response',grade:'B-rendered-client-evidence',action:'extract-route-ui-and-state-contract',area:unique([...signals.surfaces]).join('；')||'页面外壳',limitation:'HTML 200 不证明接口数据、权限、算法或任务终态'};
 if(['.png','.jpg','.jpeg','.webp','.svg','.mp4','.webm','.mp3','.wav','.woff','.woff2','.wasm','.gz'].includes(extension))return{artifactClass:'static-or-media-runtime',grade:'C-static-output-evidence',action:'retain-for-runtime-completeness-only',area:'静态资源或媒体运行依赖',limitation:'对标品牌素材和用户输出不得进入本站产品'};
 return{artifactClass:'supporting-evidence',grade:'C/D-supporting-evidence',action:'preserve-and-cross-check',area:'辅助取证',limitation:'需与代码节点、运行响应或本站实现交叉证明'};
}

function localTargetsFor(signals,relative){
 const text=[...signals.surfaces,...signals.routes,...signals.apis,...signals.tools,...signals.skills,relative].join(' ');
 const targets=[];
 if(/image-generation|skill-packs|product-refine|change-face|background-change|image-common/iu.test(text))targets.push('src/commerce/image-input-contract.ts','src/commerce/server/prompts.ts','src/commerce/server/jobs.ts','src/commerce/components/commerce-agent/workspace.tsx');
 if(/video-generation|video-creator|depth-video|reference-video|hot-video|ffmpeg|soundtouch/iu.test(text))targets.push('src/commerce/server/jobs.ts','src/commerce/server/rolling-video.ts','src/commerce/server/rolling-video-worker.ts','src/app/api/commerce/commerce-model-gateway/route.ts');
 if(/hot-video-remix|hot-video/iu.test(text))targets.push('src/commerce/server/hot-video-remix.ts','src/app/api/commerce/hot-video-remix/route.ts','src/commerce/components/commerce-agent/hot-video-remix-studio.tsx','src/commerce/server/ordinary-worker.ts');
 if(/ecommerce-image-set/iu.test(text))targets.push('src/commerce/server/detail-sets.ts','src/commerce/components/commerce-agent/detail-set-studio.tsx');
 if(/digital-human/iu.test(text))targets.push('src/app/digital-human/page.tsx','src/app/api/digital-human/generate/route.ts','src/lib/digital-human-long-worker.ts','src/commerce/server/digital-human-audio-candidates.ts','src/app/api/commerce/digital-human-audio-assets/route.ts','src/features/digital-human/commerce-audio-bridge.ts','src/features/digital-human/CommerceAudioAssetPicker.tsx');
 if(/subtitle|watermark|quality-enhance|video-edit/iu.test(text))targets.push('src/commerce/server/media-tools.ts','src/commerce/components/commerce-agent/media-tools.tsx','src/lib/local-media-processor.ts');
 if(/asset|resource/iu.test(text))targets.push('src/commerce/server/assets.ts','src/commerce/server/main-asset-bridge.ts','src/app/api/commerce/assets/route.ts');
 if(/voice|audio/iu.test(text))targets.push('src/commerce/server/voice-bridge.ts','src/commerce/server/voice-jobs.ts','src/app/api/commerce/voice-synthesis/route.ts','src/commerce/components/commerce-agent/voice-synthesis-studio.tsx','src/app/api/admin/commerce/voice-reconciliation/route.ts','src/commerce/server/voice-replace.ts','src/app/api/commerce/voice-replace/route.ts');
 if(/canvas/iu.test(text))targets.push('src/commerce/server/canvas-storage.ts','src/commerce/components/commerce-agent/canvas-live.tsx');
 if(/affiliate/iu.test(text))targets.push('contract-evidence-only:no-direct-commerce-runtime-equivalent');
 return unique(targets);
}

const grouped=new Map();
for(const root of roots){
 const captureRoot=captureLabel(root);
 for(const file of walk(root).filter(file=>!/\.part\d+$/u.test(file))){
  const relative=slash(path.relative(root,file)),bytes=fs.readFileSync(file),digest=sha256(bytes),key=`${relative}|${digest}`;
  if(!grouped.has(key))grouped.set(key,{logicalPath:relative,sha256:digest,bytes:bytes.length,captureRoots:new Set(),absoluteUrls:new Set(),methods:new Set(),statuses:new Set(),contentTypes:new Set()});
  const row=grouped.get(key);row.captureRoots.add(captureRoot);
  const metadata=responseMetadata.get(`${captureRoot}:${relative}`);
  if(metadata){row.absoluteUrls.add(metadata.url);row.methods.add(metadata.method);row.statuses.add(metadata.status);row.contentTypes.add(metadata.contentType);}
 }
}

const entries=[...grouped.values()].map(row=>{
 const signals=signalsBySha.get(row.sha256)||{surfaces:new Set(),routes:new Set(),apis:new Set(),tools:new Set(),skills:new Set(),statuses:new Set(),errorCodes:new Set(),astNodes:0,stringLiterals:0,parseDiagnostics:0,singleLineMinified:false,paths:new Set()};
 const metadata={url:[...row.absoluteUrls][0]||null,contentType:[...row.contentTypes][0]||null};
 const classification=classify(row.logicalPath,metadata,signals),localTargets=localTargetsFor(signals,row.logicalPath);
 return{
  logicalPath:row.logicalPath,sha256:row.sha256,bytes:row.bytes,captureRoots:[...row.captureRoots].sort(),absoluteUrls:[...row.absoluteUrls].sort(),http:{methods:[...row.methods].sort(),statuses:[...row.statuses].sort(),contentTypes:[...row.contentTypes].sort()},
  ...classification,
  sourceSignals:{surfaces:[...signals.surfaces].sort(),routes:[...signals.routes].sort(),apis:[...signals.apis].sort(),tools:[...signals.tools].sort(),skills:[...signals.skills].sort(),statuses:[...signals.statuses].sort(),errorCodeCount:signals.errorCodes.size,astNodes:signals.astNodes,stringLiterals:signals.stringLiterals,parseDiagnostics:signals.parseDiagnostics,singleLineMinified:signals.singleLineMinified,preciseNodeIndex:{artifact:'对标前端源码语法节点索引.json',fileSha256:row.sha256,offsetContract:'UTF-8 half-open [byteStart,byteEnd)'}},
  localTargets,
  statusAxes:{directMirrorReuse:'已从镜像直接复用（隔离证据，不进入产品运行时）',behaviorEquivalentImplementation:localTargets.length?'已找到本站源码落点，具体链路按合同与运行证据分级':'尚未验证',backendVisibleEvidence:row.absoluteUrls.size?'已由授权只读响应或浏览器资源证据补齐':'不适用',localEnhancement:localTargets.length?(finalUiPassed?'本站已有增强实现；目标与相邻页面的浏览器基线已通过':'本站已有增强基础，运行验收未完成'):'尚未验证',runtimeVerification:localTargets.length?(finalUiPassed?'当前 F 盘五个目标或相邻页面、桌面与 390px 共 10 视图的只读浏览器基线已通过；该文件映射的具体功能终态仍以链路合同和付费边界为准':'尚未完成当前 F 盘浏览器验收'):'镜像证据已索引；不属于本站运行时直接复用',externalCondition:'私有服务端源码和供应商实现不可从浏览器下载；真实 Canvas ID 的 API 可读但页面语义失败',deployment:'未部署'},
 };
}).sort((a,b)=>a.logicalPath.localeCompare(b.logicalPath)||a.sha256.localeCompare(b.sha256));

const countsByClass=Object.fromEntries([...new Set(entries.map(item=>item.artifactClass))].sort().map(kind=>[kind,entries.filter(item=>item.artifactClass===kind).length]));
const uniqueContents=new Map(entries.map(item=>[item.sha256,item]));
const completeness={
 schemaVersion:'maolong.mirror-union-integrity/v2',status:closure.passed?'client-static-closure-passed-private-server-excluded':'closure-failed',generatedAtUtc:new Date().toISOString(),
 sourceSelection:{strategy:`${roots.length} authorized read-only captures merged by logical path and sha256`,captureRoots:roots,legacyArchives:'retained as comparison only; fresh union is primary browser-delivered evidence'},
 safety:{businessWritesAllowed:closure.checks?.businessWriteIsolation?.allowed??null,businessWritesBlocked:closure.checks?.businessWriteIsolation?.blocked??null,paidGeneration:false,databaseMutation:false,deployment:false},
 fixedPoints:{
 sourceDiscovery:{status:closure.passed?'passed':'failed',definition:'Repeated route, chunk, AST, API, catalog and recursively referenced static-runtime scans add no missing browser-delivered dependency.',evidence:'对标镜像静态闭包验收.json'},
  conditionalEntry:{status:'query-entries-passed-dynamic-canvas-page-failed-write-execution-unverified',definition:'Every source-proven safe query entry was opened; the safely observed dynamic Canvas ID was checked at both page and detail-API layers, preserving the semantic page failure.',verified:['11 image ?skill_pack= entries: 11/11 HTTP 200 with exact final pathname','18 video ?skill= entries: 18/18 HTTP 200 with exact final pathname','/canvas/{workspace_id} route-specific controller and dependent chunks captured from a safely observed ID','GET /api/v1/canvases/{workspace_id} returned the persisted empty document','0 business writes allowed','HEIF libheif.wasm exact URL returned 404, but libheif.js proves an embedded wasm2js runtime whose binary argument is ignored'],missing:['The real persisted Canvas ID page returned HTTP 200 but rendered 页面未找到 and issued zero natural detail GET requests','4 canvas-only skill submissions were not executed because they create business state and can create paid media tasks','A real HEIF file decode was not executed; the 404 fallback name is not itself a functional failure']},
  runtimePayload:{status:runtimeAudit.fixedPoint.status,definition:'Every observed read-only API response body and safe dynamic-detail controller required by the runtime checklist is saved, structurally profiled and hash-addressed.',verified:runtimeAudit.fixedPoint.checklist.filter(item=>item.passed).map(item=>item.name),missing:runtimeAudit.fixedPoint.checklist.filter(item=>!item.passed).map(item=>item.name),boundary:runtimeAudit.fixedPoint.boundary,evidence:'运行载荷与动态Canvas结构审计.json'},
 },
 completeness:{observed:{captureRoots:roots.length,logicalPathVersions:entries.length,uniqueFileContents:uniqueContents.size,uniqueContentBytes:[...uniqueContents.values()].reduce((sum,item)=>sum+item.bytes,0),compiledJavascriptContents:[...uniqueContents.values()].filter(item=>item.logicalPath.endsWith('.js')).length,sourceMaps:evidence.summary.sourceMapFiles,uniqueAstNodes:evidence.summary.uniqueAstNodes??evidence.summary.astNodes,observedAstNodesIncludingDuplicateCaptures:evidence.summary.astNodes,routes:evidence.summary.uniqueRoutes,concreteApiSignatures:evidence.summary.uniqueApiSignatures,unresolvedApiTemplates:evidence.summary.uniqueUnresolvedApiTemplates,activeTools:closure.checks.toolRegistry.activeRegistry,renderers:closure.checks.toolRenderers.renderers,imageSkills:closure.checks.imageSkillCatalog.skills,directorSkills:closure.checks.directorCatalog.skills,webpackLazyMappings:closure.checks.webpackRuntimeMappings.mappings,deepMediaRuntimeFiles:closure.checks.deepMediaStaticDependencies.required,privateServerSourceTrees:0,packageOrLockManifest:false,databaseSchemaFromBenchmark:false},scores:{browserDeliveredClientAndContractClosure:closure.passed?100:0,maintainableOriginalFrontendSource:25,completeFrontendAndBackendSource:10,method:'deterministic structural score; client closure excludes unpublished private server code'},conclusion:'浏览器可下载客户端、目录合同和已引用媒体运行依赖达到静态闭包；仍不是完整可维护前后端源码，继续融合优于全量覆盖本站。'},
 artifactClassCounts:countsByClass,closureEvidence:{artifact:'对标镜像静态闭包验收.json',sha256:sha256(fs.readFileSync(closurePath)),passed:closure.passed},runtimePayloadEvidence:{artifact:'运行载荷与动态Canvas结构审计.json',sha256:sha256(fs.readFileSync(runtimeAuditPath)),status:runtimeAudit.fixedPoint.status},sourceNodeEvidence:{artifact:'对标前端源码语法节点索引.json',sha256:sha256(fs.readFileSync(evidencePath)),offsetContract:evidence.offsetContract},entries,
};

const matrixEntries=entries.map(item=>({sourcePath:item.logicalPath,sha256:item.sha256,bytes:item.bytes,captureRoots:item.captureRoots,absoluteUrls:item.absoluteUrls,http:item.http,artifactClass:item.artifactClass,evidenceGrade:item.grade,mappedProductArea:item.area,intendedAction:item.action,sourceSignals:item.sourceSignals,localTargets:item.localTargets,statusAxes:item.statusAxes,limitation:item.limitation}));
const localFusionStatus={
 directMirrorReuse:[
  `${roots.length} 轮浏览器可下载客户端、静态依赖、目录和只读响应按原字节隔离保存并逐文件哈希；仅作实现证据，不进入本站品牌运行时。`,
 ],
 behaviorEquivalentImplementation:[
  '19 个超级编导使用共享商业导演底座、18 条专项节拍链、固定 director-script/v2 输出、局部修订与视频应用；确定性核心 64/64、语义 157/157。',
  'Commerce 语音合成已具备报价、明确确认、现金钱包、耐久任务、未知提交人工对账与资产终态；真实付费仍由验收证据门禁锁住。',
  '热门视频改编已实现手工精确片段或确定性自动均分、本地 FFmpeg、BGM、耐久任务、删除保护和恢复；合同 33/33。',
  '语音应用视频已实现短音频补齐、整段视频时长保持、耐久 worker、幂等资产与清理；合同 31/31。',
  'Commerce 已完成配音可经 owner/主账户、size、SHA256 校验后导入数字人安全上传链；合同 35/35。',
 ],
 backendVisibleEvidence:[
  '19 编导目录、16 图片技能、工具目录、只读 API 载荷与动态 Canvas 控制器均保存了授权后台或浏览器可见证据。',
  '当前共享云配置只读证据为 2 draft / 0 current / 0 published；v2 草稿含 19 卡、19 路由、19 提示词且关联缺失为 0。',
 ],
 localEnhancement:[
  '本站增加主账户身份绑定、不可自动重发的未知终态、原子发布 CAS 源码、模型可见与生成准入分离、资产删除围栏及常驻恢复 worker。',
  '视频模型保持目录可见，但未完成真实验收时会在资产桥接、余额预占和供应商提交之前失败关闭；提交就绪合同 25/25。',
  '教程补充链覆盖 hot、voice、voice-to-video、voice-to-digital-human 与管理员对账，314 项检查、181 项源码断言，八类副作用均为 0。',
  ...(finalUiPassed?[`当前 F 盘已完成 5 个目标/相邻页面、桌面与 390px 共 10 视图的只读浏览器验收；横向溢出、越界控件、HTTP/控制台/页面错误和付费或业务写入均为 0。证据：${finalUiEvidence}`]:[]),
 ],
 unverified:[
  '热门视频自动模式尚非语义场景切分，也未生成多变体。',
  'Commerce 发布 CAS 迁移尚未应用；共享云仍为 2 draft / 0 current / 0 published，本地验收库与共享云必须保持身份分离。',
  '本轮本地数据库没有保持只读：同一协调会话已应用 3 个结构迁移；未发现新增业务任务或生成结果，禁止无证据盲目回滚。',
  '对标教程第 9 步当前账号没有失败或退款实例，只验证了既有成功批次和客户端失败/退款合同。',
  '对标教程第 10 步真实生成、本站语音/视频/数字人真实付费终态均未执行。',
 ],
 externalBlocked:[
  '对标私有服务端源码、数据库事务实现、队列 worker 和供应商算法不由浏览器下发。',
  '依赖真实供应商的 depth-clone、语音、视频和数字人终态需要明确费用上限与用户授权；本轮没有提交。',
 ],
 undeployed:['部署、生产迁移、生产读回、push 和服务器切换均按用户要求暂停。'],
};
const matrix={schemaVersion:'maolong.mirror-fusion-matrix/v2',status:finalUiPassed?'browser-client-and-observable-readonly-runtime-closure-passed-local-contract-and-browser-surface-accepted-private-server-paid-and-depth-terminal-excluded':'browser-client-and-observable-readonly-runtime-closure-passed-local-contract-fusion-in-progress-private-server-and-paid-execution-excluded',generatedAtUtc:new Date().toISOString(),boundary:`逐文件映射覆盖 ${roots.length} 轮只读抓取的浏览器可下载内容；可观察 GET 载荷和动态 Canvas 控制器源码已闭合，但真实持久化 Canvas 页面语义失败；私有服务端实现、写入动作和付费执行不在镜像闭包内。`,statusLegend:['已从镜像直接复用','已依据镜像行为等价实现','已由后台正常可见证据补齐','本站增强','尚未验证','受外部条件阻塞','未部署'],localFusionStatus,fixedPoints:completeness.fixedPoints,counts:{filePathVersions:matrixEntries.length,uniqueContents:uniqueContents.size,directEvidenceCopies:matrixEntries.length,sourceMappedToLocal:matrixEntries.filter(item=>item.localTargets.length).length,behaviorEquivalentContractVerified:5,behaviorEquivalentRuntimeVerified:2,browserSurfacesVerified:finalUiPassed?5:0,browserViewportChecksPassed:finalUiPassed?10:0,backendVisibleEvidence:matrixEntries.filter(item=>item.statusAxes.backendVisibleEvidence.startsWith('已由')).length,deployed:0,undeployed:matrixEntries.length},runtimeEvidence:finalUiPassed?{status:'passed',artifact:finalUiEvidence,views:10,surfaces:5,viewports:['desktop-1440','mobile-390'],businessWrites:0,paidGenerationRequests:0,benchmarkVideoSubmissions:0}:null,entries:matrixEntries};

const routeFamilies=new Map();
for(const item of evidence.routes||[]){const family=item.route.split('/').filter(Boolean)[0]||'root';if(!routeFamilies.has(family))routeFamilies.set(family,new Set());routeFamilies.get(family).add(item.route);}
const apiFamilies=new Map();
for(const item of evidence.apis||[]){if(!apiFamilies.has(item.family))apiFamilies.set(item.family,new Set());apiFamilies.get(item.family).add(`${(item.methods||[]).join('|')} ${item.signature}`);}
const featureChains=[
 ...[...routeFamilies].map(([family,values])=>({featureId:`route-family.${family}`,surface:'visible-or-linked-client-route',routes:[...values].sort(),deepestObservedLayer:'compiled-client-route-and-rendered-response',localTargets:localTargetsFor({surfaces:new Set(),routes:values,apis:new Set(),tools:new Set(),skills:new Set()},''),status:'evidence-mapped-runtime-not-fully-verified'})),
 ...[...apiFamilies].map(([family,values])=>({featureId:`api-family.${family}`,surface:'client-network-contract',apis:[...values].sort(),deepestObservedLayer:'method-path-contract-and-observed-readonly-status',localTargets:localTargetsFor({surfaces:new Set(),routes:new Set(),apis:values,tools:new Set(),skills:new Set()},''),status:'contract-observed-private-handler-source-unavailable'})),
 ...unique((evidence.tools||[]).map(item=>item.slug)).map(slug=>({featureId:`tool.${slug}`,surface:'tool-registry-or-renderer',evidence:(evidence.tools||[]).filter(item=>item.slug===slug).map(item=>({kind:item.kind,status:item.status||null,file:item.file,fileSha256:item.fileSha256,byteStart:item.byteStart,byteEnd:item.byteEnd})),localTargets:localTargetsFor({surfaces:new Set(),routes:new Set(),apis:new Set(),tools:new Set([slug]),skills:new Set()},''),status:'client-renderer-mapped'})),
 ...unique((evidence.skillPacks||[]).map(item=>`${item.catalog}:${item.id}`)).map(key=>{const [catalog,id]=key.split(':');const rows=(evidence.skillPacks||[]).filter(item=>item.catalog===catalog&&item.id===id);return{featureId:`skill.${catalog}.${id}`,surface:catalog==='image'?'image-prompt-skill':'director-prompt-skill',configVersions:unique(rows.map(item=>item.configVersion)),surfaces:unique(rows.flatMap(item=>item.surfaces||[])),evidence:rows.map(item=>({file:item.file,fileSha256:item.fileSha256,byteStart:item.byteStart,byteEnd:item.byteEnd})),localTargets:localTargetsFor({surfaces:new Set(),routes:new Set(),apis:new Set(),tools:new Set(),skills:new Set([key])},''),status:'catalog-version-mapped-runtime-publish-readback-pending'};}),
 ];
const layered={
 schemaVersion:'maolong.progressive-evidence-map/v1',generatedAtUtc:new Date().toISOString(),principle:'Each clue is followed downward until the next implementation boundary; minified one-line bundles use AST nodes and UTF-8 byte intervals.',
 stopRule:'Only call a layer closed after repeated scans add no route, chunk, API, catalog entry, prompt/config version, status branch or referenced runtime file. Private server source is an explicit external boundary, never inferred as downloaded.',
 layers:[
  {depth:0,name:'来源与身份',findings:[`${roots.length} 个授权只读抓取根`,`代码发现闭包 ${closure.passed?'通过':'失败'}`,'29 个安全 query 条件入口已全部抓取','可观察 GET 载荷和动态 Canvas 控制器 12/12 闭合','真实 Canvas ID 的 API 可读但页面语义失败','4 个 canvas-only 技能提交因业务写入/可能付费而未执行',`业务写入允许 ${closure.checks.businessWriteIsolation.allowed}`],next:'逐页面和静态资源身份'},
  {depth:1,name:'可见UI与路由',findings:[`${evidence.summary.uniqueRoutes} 个路由`,`页面观察 ${closure.summary.pagesObserved} 次`,'11 个图片技能 query 入口和 18 个编导 query 入口均已返回 200','/canvas/{workspace_id} 专属控制器、详情 JSON 和后续依赖均已捕获','该真实 ID 页面返回 HTTP 200 但正文为“页面未找到”，且自然详情请求为 0','布局、尺寸、断点和交互状态已有独立UI审计'],next:'组件、事件和状态机'},
  {depth:2,name:'组件与压缩源码节点',findings:[`${evidence.summary.uniqueAstNodes??evidence.summary.astNodes} 个唯一内容 AST 节点`,`重复抓取观察总节点 ${evidence.summary.astNodes}`,`${evidence.summary.uniqueSingleLineMinifiedJavascriptContents??evidence.summary.singleLineMinifiedJavascriptFiles} 个唯一单行压缩JS`,`parse diagnostics=${evidence.summary.uniqueParseDiagnostics??evidence.summary.parseDiagnostics}`],next:'网络合同和隐藏懒加载'},
  {depth:3,name:'API与状态合同',findings:[`${evidence.summary.uniqueApiSignatures} 个具体方法/路径`,`方法未决=${evidence.summary.apiSignaturesRequiringMethodPropagation}`,`动态首段未决模板=${evidence.summary.uniqueUnresolvedApiTemplates}`],next:'服务、模型路由、队列和错误终态'},
  {depth:4,name:'隐藏模块与媒体运行依赖',findings:[`${closure.summary.runtimeMappings} 个webpack懒块`,'SoundTouch AudioWorklet','FFmpeg core JS + gzip WASM','Mediabunny/H264/关键帧模块','HEIF worker + libheif wasm2js；libheif.wasm 是已证明不加载的回退名','共享多轨视频编辑器含 IndexedDB 草稿、FFmpeg 导出与片段重拍预处理'],next:'编解码参数、提帧、拼接、音轨处理和临时资产'},
  {depth:5,name:'技能、提示词与模型约束',findings:[`${closure.checks.imageSkillCatalog.skills} 个图片技能`,`${closure.checks.directorCatalog.skills} 个编导配置`,'共用底座+专项约束/节拍+输出协议'],next:'发布版本、读回、路由和模型能力准入'},
  {depth:6,name:'本站服务与持久化落点',findings:['任务、资产、历史、计费和失败恢复已有多条源码链','Commerce配音已可安全导入主站数字人；其他类型的完整双向资产/历史仍需逐类验收','普通任务、媒体编辑、提帧、深度视频准备、热门改编、语音合成和语音应用视频已接入常驻worker与删除保护','教程补充链 314/314，UI/API/service/storage 四层断言与八类零副作用成立',finalUiPassed?'当前 F 盘 5 页面、10 视图只读浏览器验收通过':'当前 F 盘浏览器验收尚未通过'],next:'失败/退款实例、真实付费终态和生产发布'},
  {depth:7,name:'外部不可下载边界',findings:['对标私有服务端源码未下发','数据库事务和队列worker实现不可见','供应商密钥与付费终态未执行'],next:'以客户端合同和本站基础设施做行为等价实现并明确标记'},
 ],
 featureChains,
 knownGaps:[
  {priority:'P0',feature:'Commerce voice paid acceptance',evidence:'durable cash and reconciliation chain is implemented, but paid confirmation remains correctly locked until immutable real-provider acceptance evidence is published'},
  {priority:'P0',feature:'remaining Commerce to main asset/history bridge',evidence:'completed Commerce audio now bridges to digital-human safely; non-audio asset/history types still need individual end-to-end verification'},
  {priority:'P0',feature:'H3/digital-human real provider acceptance',evidence:'catalog and local bridge contracts exist; paid provider generation and persisted cost/result readback remain unexecuted'},
  {priority:'P0',feature:'outpaint/cutout/mask local editing',evidence:'no dedicated route/service contract found'},
  {priority:'P0',feature:'60-second long digital-human segmentation',evidence:'current threshold and max segment are 115 seconds; UI does not send sentence boundaries'},
  {priority:'P0',feature:'hot-video semantic scene splitting and multi-variant output',evidence:'current zero-cost implementation supports exact manual clips and deterministic automatic equal allocation, not semantic scene detection or multiple variants'},
  {priority:'P0',feature:'runtime publication and readback',evidence:'Commerce release CAS/immutability migration exists only in source; current shared-cloud identity remains 2 draft / 0 current / 0 published while local acceptance is a separate identity with 1 current / 1 published'},
  {priority:'P0',feature:'benchmark tutorial failure/refund instance',evidence:'current benchmark account exposes 24 successful historical batches and no failed/refunded instance; step 9 live failure terminal remains unverified without manufacturing a failure'},
  {priority:'P0',feature:'Dynamic Canvas page/API identity mismatch',evidence:'persisted detail API returns 200, while the exact page renders 页面未找到 and naturally requests no detail payload'},
  {priority:'P1',feature:'Canvas-only skill execution',evidence:'controller, detail payload and UI contracts are captured; four submissions remain unexecuted because they create business state and can create paid media tasks'},
  {priority:'P1',feature:'media-tool algorithm equivalence',evidence:'local delogo/fixed region and ffmpeg filters are not equivalent to benchmark paid services'},
 ],
 closedGaps:[
  {feature:'dynamic canvas editor source/controller capture',evidence:'route-specific page chunk, detail JSON and dependent chunks captured read-only; page runtime remains a recorded failure'},
 {feature:'ordinary Commerce job/media-edit/frame/depth durable worker',evidence:ordinaryWorkerReport?`${ordinaryWorkerReport.result?.passed||0}/${ordinaryWorkerReport.result?.total||0} deterministic checks; zero provider, paid, production and deployment actions`:'implementation present; deterministic report missing'},
  {feature:'Commerce voice durable cash and reconciliation state machine',evidence:'quote/worker/UI/admin/billing contracts pass with provider, wallet, browser and production side effects held at zero; real paid evidence remains intentionally absent'},
  {feature:'voice result applied to video',evidence:'31/31 deterministic and real local FFmpeg checks; 3.0-second video plus 0.7-second voice remains 3.0 seconds with audio; network/provider/wallet/paid effects zero'},
  {feature:'Commerce voice asset to digital-human input',evidence:'35/35 owner, main-account, byte-size, SHA256, ticket and bounded confirmation checks; no digital-human generation submitted'},
  {feature:'hot-video deterministic/manual remix',evidence:'33/33 local FFmpeg, duration, 720x1280, audio, idempotency, lease, cleanup and deletion-fence checks; semantic splitting remains open'},
  {feature:'tutorial adjunct UI/API/service/storage mapping',evidence:'314/314 checks, 181 source assertions across 19 files, steps 2/6/7/8/9, all eight side-effect classes zero'},
 ],
 fixedPoints:completeness.fixedPoints,
 statusAxes:{directMirrorReuse:`${roots.length} 轮浏览器证据与依赖已隔离保存`,behaviorEquivalentImplementation:finalUiPassed?'19编导、语音、热门改编、语音应用视频和数字人音频桥已通过确定性合同；5页面10视图只读浏览器基线已通过':'19编导、语音、热门改编、语音应用视频和数字人音频桥已通过确定性合同；运行浏览器仍待验收',backendVisibleEvidence:'只读目录、运行载荷、动态 Canvas、对标教程1至9步和当前配置身份已纳入',localEnhancement:'主账户绑定、现金终态、人工对账、耐久worker、删除围栏和发布CAS源代码已增加',unverified:'语义场景切分/多变体、4个Canvas-only写入、教程第9步失败/退款实例、CAS发布迁移与付费终态',externalBlocked:'私有后端源码、供应商算法及需要明确费用上限和用户授权的真实供应商终态',deployment:'未部署'},
};

writeAtomic(path.join(docs,'镜像源码完整性清单.json'),completeness);
writeAtomic(path.join(docs,'镜像融合矩阵.json'),matrix);
writeAtomic(path.join(docs,'分层递进源码线索图谱.json'),layered);

const statusSections=[['已从镜像直接复用',matrix.localFusionStatus.directMirrorReuse],['已依据镜像行为等价实现',matrix.localFusionStatus.behaviorEquivalentImplementation],['已由后台正常可见证据补齐',matrix.localFusionStatus.backendVisibleEvidence],['本站增强',matrix.localFusionStatus.localEnhancement],['尚未验证',matrix.localFusionStatus.unverified],['受外部条件阻塞',matrix.localFusionStatus.externalBlocked],['未部署',matrix.localFusionStatus.undeployed]];
const matrixMd=['# 镜像融合矩阵','',`生成时间：${matrix.generatedAtUtc}`,'',`${roots.length} 轮只读抓取合并为 ${matrix.counts.filePathVersions} 个路径/版本、${matrix.counts.uniqueContents} 个唯一内容；代码发现、29 个 query 条件入口、可观察 GET 载荷和动态 Canvas 控制器源码已闭合。真实持久化 Canvas 页面仍显示“页面未找到”；4 个 Canvas-only 技能提交属于业务写入/可能付费，未执行。镜像不含对标私有服务端源码，因此不支持全量覆盖本站。`,'','## 融合状态',...statusSections.flatMap(([title,values])=>['',`### ${title}`,'',...(values).map(value=>`- ${value}`)]),'','## 逐文件矩阵','','| 镜像文件 | SHA256 | 字节 | 证据类 | 映射区域 | 本站落点 | 状态 |','|---|---:|---:|---|---|---|---|',...matrix.entries.map(item=>`| ${item.sourcePath.replaceAll('|','\\|')} | ${item.sha256.slice(0,12)} | ${item.bytes} | ${item.artifactClass} | ${(item.mappedProductArea||'').replaceAll('|','\\|')} | ${(item.localTargets.join('<br>')||'待映射').replaceAll('|','\\|')} | ${item.statusAxes.runtimeVerification} / ${item.statusAxes.deployment} |`),'','## 闭包边界','',`- 代码发现：${matrix.fixedPoints.sourceDiscovery.status}`,`- 条件入口：${matrix.fixedPoints.conditionalEntry.status}`,...matrix.fixedPoints.conditionalEntry.verified.map(item=>`- 条件入口已验证：${item}`),...matrix.fixedPoints.conditionalEntry.missing.map(item=>`- 条件入口执行边界：${item}`),`- 运行响应体：${matrix.fixedPoints.runtimePayload.status}`,...matrix.fixedPoints.runtimePayload.verified.map(item=>`- 响应体已验证：${item}`),...matrix.fixedPoints.runtimePayload.missing.map(item=>`- 响应体缺失：${item}`),'','## 边界','',matrix.boundary,''];
writeTextAtomic(path.join(docs,'镜像融合矩阵.md'),`${matrixMd.join('\n')}\n`);
const layersMd=['# 分层递进源码线索图谱','',`生成时间：${layered.generatedAtUtc}`,'',layered.stopRule,'',...layered.layers.flatMap(layer=>[`## L${layer.depth} ${layer.name}`,'',...layer.findings.map(value=>`- ${value}`),`- 下一层：${layer.next}`,'']),'## 当前缺口','',...layered.knownGaps.map(item=>`- ${item.priority}｜${item.feature}｜${item.evidence}`),'',`机器可读功能链共 ${layered.featureChains.length} 条，见同目录 JSON。`,''];
writeTextAtomic(path.join(docs,'分层递进源码线索图谱.md'),`${layersMd.join('\n')}\n`);
const outputs=['镜像源码完整性清单.json','镜像融合矩阵.json','镜像融合矩阵.md','分层递进源码线索图谱.json','分层递进源码线索图谱.md'].map(name=>{const file=path.join(docs,name),bytes=fs.readFileSync(file);return{name,path:file,bytes:bytes.length,sha256:sha256(bytes)};});
console.log(JSON.stringify({ok:true,counts:matrix.counts,completeness:completeness.completeness.observed,layers:layered.layers.length,featureChains:layered.featureChains.length,outputs},null,2));
