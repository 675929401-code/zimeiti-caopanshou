import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDirectory=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(scriptDirectory,'..');
const docs=path.join(projectRoot,'docs','带货Agent镜像融合-20260925');
const indexPath=path.join(docs,'对标前端源码语法节点索引.json');
const closurePath=path.join(docs,'对标镜像静态闭包验收.json');
const runtimeAuditPath=path.join(docs,'运行载荷与动态Canvas结构审计.json');
const index=JSON.parse(fs.readFileSync(indexPath,'utf8'));
const closure=JSON.parse(fs.readFileSync(closurePath,'utf8'));
const runtimeAudit=JSON.parse(fs.readFileSync(runtimeAuditPath,'utf8'));
const knownShas=new Set((index.files||[]).map(item=>item.sha256));
const now=new Date().toISOString();
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const writeAtomic=(target,value)=>{fs.mkdirSync(path.dirname(target),{recursive:true});const temporary=`${target}.${process.pid}.tmp`;fs.writeFileSync(temporary,typeof value==='string'?value:`${JSON.stringify(value,null,2)}\n`,'utf8');fs.renameSync(temporary,target);};
const local=(file,needle)=>{
 const absolute=path.join(projectRoot,file);
 if(!fs.existsSync(absolute)||!fs.statSync(absolute).isFile())return{file,line:null,exists:false,needle,needleFound:false};
 const lines=fs.readFileSync(absolute,'utf8').split(/\r?\n/u);
 const index=lines.findIndex(value=>value.includes(needle));
 return{file,line:index>=0?index+1:null,exists:true,needle,needleFound:index>=0};
};
const bench=(fileSha256,byteStart,byteEnd,file)=>{
 const prefix=fileSha256.slice(0,8);
 const matches=[...knownShas].filter(candidate=>candidate.startsWith(prefix));
 const resolved=knownShas.has(fileSha256)?fileSha256:matches.length===1?matches[0]:fileSha256;
 return{file,fileSha256:resolved,byteStart,byteEnd,offsetContract:'UTF-8 half-open [byteStart,byteEnd)',shaPresentInIndex:knownShas.has(resolved)};
};

const benchmark={
 toolbox:bench('f8687d0001dc2b97aee05deb931876b9f6c949326a018088296b2325d766700d',0,839650,'app/(workspace)/toolbox/[toolSlug]/page-a3292bb727f8d22f.js'),
 canvas:bench('f6fb56ce00000000000000000000000000000000000000000000000000000000',7119,221684,'chunks/2722-ef6046d3b6683067.js'),
 canvasDynamic:bench('7546917fecfbd526f3d32758e052c1b54aa2d4151e1c21cdc74791bb81055147',0,736224,'app/(workspace)/canvas/[canvasId]/page-c51169a83d03a317.js'),
 canvasGraph:bench('dee0abd831fbc8f8e5c28946b5981a5d6c3ac1cd4de1f8417a4751a95ac270b9',0,1449682,'chunks/91dbc596-3ff73c92dac65eab.js'),
 canvasShare:bench('18c423cfc5afbebfcdf6696dd76cd62edde2149cc470e5d65add618d9fe5c814',0,31683,'chunks/5405-073b3d8ddfbc5f2d.js'),
 canvasDetail:bench('a82fa7ca0ad840b2c57d37816c4ff00e8caf96b760aa198359b3b6e1dd37ba60',0,484,'api/v1/canvases/{id}.json'),
 canvasPageNotFound:bench('1345d90621991a6277ec4cef891e971083f20d8fe551bc4593e2fe2b01dddc4d',32977,32992,'canvas/{id}.html'),
 heifWasm2Js:bench('356068bb64947a76f1490ee139b2cab52f62e5e60d1945413aed9ab94c09e754',2517,3013645,'image-decode/heif-1.22.2-v1/libheif.js'),
 imageHistoryDetail:bench('7f697e897ce7a851caa4283eeb3eab8115737a75e58273a70991cd88c30d7eae',0,6934,'api/v1/batches/{image-id}.json'),
 videoHistoryDetail:bench('47ab032c5d7ab398cf9c705f5808a71b2d166b660caded087fcbdbffa0a4e61f',0,49510,'api/v1/batches/{video-id}.json'),
 usageLedger:bench('a82fc35a7077ca0ec9275779a5bdfd04ea2fed780ed6219ab485f1fb0b786616',0,13055,'api/v1/usage/ledger.json'),
 usageSummary:bench('8ad447799e72a4506b62d71969d90daee319ddaa22c6f0e43f1ad8d51462ed3e',0,7188,'api/v1/usage/summary.json'),
 api:bench('a9a5dab600000000000000000000000000000000000000000000000000000000',337,23242,'chunks/9614-bf3c574bcd443d05.js'),
 editor:bench('154f83b900000000000000000000000000000000000000000000000000000000',6567,397617,'chunks/7958-117b0a3bee948bdf.js'),
};
// Prefix-only SHA values are expanded from the index so the report remains
// deterministic while still rejecting a missing or ambiguous compiled file.
for(const value of Object.values(benchmark)){
 if(knownShas.has(value.fileSha256))continue;
 const prefix=value.fileSha256.slice(0,8);
 const matches=[...knownShas].filter(candidate=>candidate.startsWith(prefix));
 value.fileSha256=matches.length===1?matches[0]:value.fileSha256;
 value.shaPresentInIndex=matches.length===1;
}

const mediaRows=[
 {id:'browser-multitrack-editor',trigger:'任务结果编辑、资产编辑或恢复本地剪辑任务',benchmarkEvidence:[{...benchmark.editor,byteStart:6567,byteEnd:397617}],browserAlgorithm:'多轨视频/音频、拆分/修剪/重排/裁剪/音量/变速/静音/音视频分离；FFmpeg WASM 导出；IndexedDB 草稿与中断恢复',coordination:'本地编辑状态→导出→上传→资产回读；远端 batch 另行结算',localEvidence:[local('src/lib/local-media-processor.ts','export async function processLocalMedia')],status:'镜像浏览器引擎直接证据；本站只有服务端局部媒体处理，未等价复建完整编辑器',gap:'入口挂载、浏览器导出、CORS、远端 batch/计费终态未验收',priority:'P1'},
 {id:'video-segment-retake',trigger:'视频编辑器选择片段后重拍',benchmarkEvidence:[{...benchmark.editor,byteStart:6567,byteEnd:31137}],browserAlgorithm:'不足4秒扩展 handle；非整段先 FFmpeg 裁私有 reference MP4；上传后报价并创建任务',coordination:'prepare→cut→upload→quote→confirm→queued/processing/succeeded/failed；本地中断任务下次标失败',localEvidence:[local('src/commerce/server/jobs.ts','export async function runJob')],status:'镜像行为合同已取证；本站无同等片段重拍工作台闭环',gap:'provider、资产终态、扣费与失败退款未验证',priority:'P1'},
 {id:'subtitle-erase',trigger:'/toolbox/video-subtitle-erase',benchmarkEvidence:[{...benchmark.toolbox,byteStart:683597,byteEnd:692882}],browserAlgorithm:'框选字幕区并交给服务端媒体处理任务',coordination:'上传→任务→轮询→结果资产/历史',localEvidence:[local('src/commerce/server/media-tools.ts',"tool:'trim'|'enhance'|'watermark'|'subtitle'|'mosaic'"),local('src/commerce/server/media-tools.ts','filters.push(`delogo=')],status:'本站可执行 FFmpeg delogo 局部实现；不等同对标服务端处理',gap:'对标 provider/修复算法、报价和计费终态不可见',priority:'P1'},
 {id:'watermark-remove',trigger:'/toolbox/video-watermark-remove',benchmarkEvidence:[{...benchmark.toolbox,byteStart:692883,byteEnd:703217}],browserAlgorithm:'框选水印区域并提交服务端 inpaint 类任务',coordination:'区域校验→任务→结果资产',localEvidence:[local('src/commerce/server/media-tools.ts',"if(tool==='watermark'"),local('src/commerce/server/media-tools.ts','delogo=x=')],status:'本站局部可用；算法不等价',gap:'delogo 不能标成 inpaint/provider 等价复用',priority:'P0'},
 {id:'video-quality-enhance',trigger:'/toolbox/video-quality-enhance',benchmarkEvidence:[{...benchmark.toolbox,byteStart:703218,byteEnd:714864}],browserAlgorithm:'1080p/插帧等增强参数进入服务端任务；当前只读模型路由无 active profile',coordination:'报价/创建→队列→资产',localEvidence:[local('src/commerce/server/media-tools.ts','hqdn3d=1.5:1.5:3:3')],status:'本站 FFmpeg 降噪+缩放+锐化增强；对标运行配置本身未就绪',gap:'不得把界面 renderer 写成对标可执行，也不得把 FFmpeg filter 写成 provider 等价',priority:'P0'},
 {id:'reference-video-split',trigger:'内部 renderer reference-video-split；非顶层导航卡',benchmarkEvidence:[{...benchmark.toolbox,byteStart:669013,byteEnd:683596}],browserAlgorithm:'智能拆条、分段参数和结果预览',coordination:'source upload→split task→clip assets',localEvidence:[local('src/commerce/server/depth-video-preprocess.ts','export')],status:'镜像隐藏 renderer 已取证；本站仅有切镜证据帧/PCM 保留基础',gap:'尚未生成带音频连续性的分段视频资产；worker/临时清理未闭环',priority:'P0'},
 {id:'hot-video-remix',trigger:'/toolbox/hot-video-remix',benchmarkEvidence:[{...benchmark.toolbox,byteStart:647970,byteEnd:669012}],browserAlgorithm:'最多3个源视频、选片、BGM、自动拆分后重组',coordination:'多源上传→分析/拆分→生成→资产',localEvidence:[local('src/commerce/server/jobs.ts','export async function runJob')],status:'镜像客户端流程已取证；本站无完整等价执行链',gap:'clip 编排、BGM 连续、durable queue、计费和资产终态缺失',priority:'P0'},
 {id:'keyframe-extraction',trigger:'视频参考、画布关键帧拆解或导演素材分析',benchmarkEvidence:[bench('b5a056d671b53b35fee03cbb0b75cc3ed0a45a634c72445dc8af11e682affe22',0,143043,'chunks/185.7ed0a50dafb3a2e8.js')],browserAlgorithm:'Mediabunny/浏览器媒体读取与关键帧提取懒模块',coordination:'文件探测→时间点/帧→引用素材',localEvidence:[local('src/commerce/server/creative-video-evidence.ts','frame')],status:'双方均有基础；尚未做同一视频确定性对照',gap:'音频转写、时间轴一致性与大文件取消需验收',priority:'P1'},
 {id:'browser-h264-transcode',trigger:'上传兼容和编辑器导出',benchmarkEvidence:[bench('c4b9675c644a23d7ebe0f17776be9929908b2e041e0fc8d38168a20a7ff4835d',0,6919,'chunks/3093.06205bf76a974e9f.js')],browserAlgorithm:'偶数宽高、libx264、veryfast、crf23、yuv420p、可选 AAC128、faststart；支持取消与临时清理',coordination:'init→transcode→cancel/release',localEvidence:[local('src/lib/local-media-processor.ts','libx264'),local('src/commerce/server/media-tools.ts',"'-movflags','+faststart'")],status:'镜像参数直接证据；本站服务端 FFmpeg 参数相近但非同一浏览器链',gap:'Mediabunny/FFmpeg.wasm 上传兼容尚未接入 Commerce UI',priority:'P1'},
 {id:'heif-browser-decode',trigger:'HEIF/HEIC 图片进入浏览器素材链',benchmarkEvidence:[benchmark.heifWasm2Js],browserAlgorithm:'worker 加载 libheif.js；该文件以 EMSCRIPTEN_START_ASM 内嵌 wasm2js 实现，重定义 WebAssembly.Module 为空构造并设置 isWasm2js=true、wasmBinary=[]；libheif.wasm 精确 URL 虽返回 404，但同步实例化的 binary 参数被 shim 忽略',coordination:'file→worker→embedded wasm2js decoder→bitmap/result',localEvidence:[local('package.json','"sharp": "0.35.0"')],status:'静态运行依赖闭包通过；404 是死回退文件名，不能据此判定解码失败',gap:'尚未用真实 HEIF 样本验证解码、内存上限、取消和失败清理；本站 Sharp 是否支持目标 HEIF 编码需单独运行验收',priority:'P1'},
 {id:'soundtouch-audio',trigger:'编辑器音频变速/变调',benchmarkEvidence:[bench('54b199ccf77e4c2b81f263b3e2c7f4dc8d91039959ae962407688ff88d94d999',0,31661,'soundtouch-processor.88137476.js')],browserAlgorithm:'AudioWorklet SoundTouch 时长与音高处理',coordination:'worklet load→stream process→release',localEvidence:[local('src/lib/local-media-processor.ts','export async function processLocalMedia')],status:'镜像运行文件完整保存；本站未提供同等交互能力',gap:'变调/变速质量、长音频连续性和取消释放未验证',priority:'P1'},
 {id:'asr-and-subtitle-timeline',trigger:'参考视频理解、字幕编辑和配音对齐',benchmarkEvidence:[benchmark.editor],browserAlgorithm:'编辑器时间轴与字幕/音轨状态；私有 ASR 服务端不可见',coordination:'audio extract→ASR→timed segments→edit/burn/export',localEvidence:[local('src/lib/extract-transcript.ts','export')],status:'主站已有 ASR 能力线索；Commerce 参考链未桥接且审计标记未执行',gap:'参考音频转写、字幕时间轴和导演输入未闭环',priority:'P1'},
 {id:'depth-video-clone',trigger:'/toolbox/depth-video-clone / Commerce 深度复刻',benchmarkEvidence:[{...benchmark.toolbox,byteStart:714865,byteEnd:743436}],browserAlgorithm:'人物/产品/背景/声音多槽位、不可变报价、任务结果',coordination:'refs→quote→confirm→batch→asset/history',localEvidence:[local('src/commerce/server/depth-video-clone-model-profiles.ts','executionConnected'),local('src/app/api/commerce-model-gateway/route.ts','autodl')],status:'本站 schema/规划/报价基础存在；真实 source-video 执行未接通',gap:'Ref2VA executionConnected=false；普通 H3 明确不能冒充 source-video',priority:'P0'},
 {id:'rolling-long-video',trigger:'30/60/70/80秒 Commerce 视频',benchmarkEvidence:[{...benchmark.toolbox,byteStart:743437,byteEnd:823505},benchmark.videoHistoryDetail],browserAlgorithm:'一个历史 default-director 成功样本记录 planner→4段生成→3次尾帧续接→stitch，结果 60.133 秒，临时连续帧组 deleted=true',coordination:'本站 parent→segments→真实尾帧续接→stitch→cleanup/retry',localEvidence:[local('src/commerce/server/rolling-video-worker.ts','claimCommerceRollingLease'),local('src/commerce/server/rolling-video.ts','cleanupRollingTailAssets')],status:'对标历史 60 秒任务级样本已取证；本站增强已有 durable lease worker 和清理重试源码',gap:'单个历史样本不证明19编导或30/70/80秒；本站当前构建、真实模型、音频连续性与30/60/70/80秒运行验收未完成',priority:'P0'},
 {id:'benchmark-video-route-drift',trigger:'历史 60 秒任务的逻辑路由与真实段执行身份',benchmarkEvidence:[benchmark.videoHistoryDetail],browserAlgorithm:'input_summary 声明 video.mini / mini-260615；四段 provider 请求记录 260128；planner 为 Gemini 3.7 Flash',coordination:'quote route identity→planner identity→segment request model→result/ledger lineage',localEvidence:[local('src/commerce/server/jobs.ts','modelConfigHash:string'),local('src/commerce/server/quotes.ts','modelConfigHash: model.configHash')],status:'已发现对标历史样本内逻辑路由与执行模型 ID 不一致',gap:'对标未给解释；本站必须把报价模型、实际提交模型和每段回执逐级绑定，不能只保存显示名',priority:'P0'},
 {id:'ordinary-commerce-jobs',trigger:'普通 agent/image/video/media/frame/depth 作业',benchmarkEvidence:[benchmark.api],browserAlgorithm:'对标客户端展示 batch queue/status/error；私有 worker 不可见',coordination:'本站常驻 worker 扫描普通任务、媒体编辑、抽帧和深度准备；数据库 lease/fencing；与请求 after()/轮询的原子 claim 互斥',localEvidence:[local('src/commerce/server/ordinary-worker.ts','claimCommerceOrdinaryLease'),local('src/lib/media-queue-worker-runtime.ts','startCommerceOrdinaryWorker'),local('scripts/verify-commerce-ordinary-worker-p0.ts','candidate scan covers all four durable Commerce families')],status:'本站增强已实现；10/10 零费用租约、去重和恢复合同通过',gap:'当前数据库只读核对、worker 进程重启恢复和 runningLatest 构建验收尚未执行',priority:'P0'},
 {id:'digital-human',trigger:'/toolbox/digital-human / 主站数字人',benchmarkEvidence:[{...benchmark.toolbox,byteStart:823506,byteEnd:839650}],browserAlgorithm:'图片说话/视频口型、音色选择/合成、报价、任务、历史',coordination:'主站已有普通队列和长数字人 worker；Commerce gateway 未桥接',localEvidence:[local('src/lib/digital-video-queue-worker.ts','startDigitalVideoQueueWorker'),local('src/lib/digital-human-long-worker.ts','startDigitalHumanLongWorker'),local('src/app/api/commerce-model-gateway/route.ts','digital_human')],status:'主站增强基础较强；Commerce 一体化未完成',gap:'分句边界、声音资产、Commerce→主站任务/历史/计费桥接未验证',priority:'P0'},
 {id:'voice-catalog-and-tts',trigger:'数字人/配音/声音选择',benchmarkEvidence:[{...benchmark.toolbox,byteStart:823506,byteEnd:839650}],browserAlgorithm:'系统/克隆/合成声音目录、合成请求；只读快照仅证明48个系统音色',coordination:'catalog→quote/billing→synthesis→audio asset/history',localEvidence:[local('src/app/api/commerce/voice-synthesis/route.ts','VOICE_BILLING_NOT_READY'),local('src/app/api/voice/tts/route.ts','VOICE_PRICE_NOT_CONFIGURED')],status:'主站 TTS 链较完整；Commerce 入口硬 503',gap:'Commerce 目录、报价、扣费、生成、资产读回缺闭环；0 用户音色证据',priority:'P0'},
 {id:'voice-clone-design-policy',trigger:'声音克隆/声音设计',benchmarkEvidence:[benchmark.api],browserAlgorithm:'客户端合同存在 voice profile create/delete/synthesize',coordination:'本站主站相关训练入口按当前策略返回 410',localEvidence:[local('src/app/api/voice/clone/route.ts','VOICE_FEATURE_RETIRED'),local('src/app/api/voice/design/route.ts','VOICE_FEATURE_RETIRED')],status:'产品策略未对齐',gap:'需明确继续退役还是恢复；不能把保留源码写成可用',priority:'P0'},
 {id:'minimax-h3',trigger:'本站增强模型配置',benchmarkEvidence:[],browserAlgorithm:'对标 bundle 无 MiniMax/H3 证据',coordination:'本站 H3 可用于其真实声明的多图/音频能力；source-video 另需专用执行器',localEvidence:[local('src/commerce/server/depth-video-clone-model-profiles.ts','MiniMax H3 Ref2VA'),local('src/app/api/commerce-model-gateway/route.ts','VIDEO_REFERENCE_UNSUPPORTED')],status:'本站增强，非镜像复用',gap:'按真实 capability GET/本地合同验收；Ref2VA executionConnected=false 时禁止宣称视频参考已接通',priority:'P0'},
 {id:'asset-identity-bridge',trigger:'主站素材进入 Commerce；Commerce 结果回主站',benchmarkEvidence:[benchmark.api],browserAlgorithm:'对标统一 assets/groups/history 客户端合同',coordination:'本站 main→Commerce 有属主校验/有界读取/去重记录；反向桥接缺失',localEvidence:[local('src/commerce/server/main-asset-bridge.ts','mainSourceId'),local('src/commerce/server/assets.ts','export async function storeAsset')],status:'单向已实现，双向未闭环',gap:'Commerce→主站资产、历史、声音、数字人统一身份和幂等写入缺失',priority:'P0'},
 {id:'billing-and-terminal-state',trigger:'任何付费模型任务',benchmarkEvidence:[benchmark.api,benchmark.imageHistoryDetail,benchmark.videoHistoryDetail,benchmark.usageLedger,benchmark.usageSummary],browserAlgorithm:'历史图像和60秒视频详情保存 estimated=actual、refund=0；近期 video-creator 账本保存 freeze→consume→settled；客户端另有 quote/create/status/error 分支',coordination:'报价快照→授权/冻结→provider→资产→消费/退款/成本',localEvidence:[local('src/commerce/server/jobs.ts','applyTerminalBilling'),local('src/app/api/voice/tts/route.ts','VOICE_RESULT_NOT_DELIVERABLE')],status:'对标已有有限成功和结算样本；本站已有多条计费基础，跨 Commerce/主站终态未统一验收',gap:'没有当前 quote POST/quote_receipt、失败退款、SSE或19/16技能逐项 lineage；历史批次详情也未与近期 video-creator 账本串成同一链',priority:'P0'},
 {id:'temporary-asset-lifecycle',trigger:'滚动尾帧、分段视频、编辑器临时导出和失败任务',benchmarkEvidence:[benchmark.editor,benchmark.videoHistoryDetail],browserAlgorithm:'客户端有取消/release/local cleanup；历史60秒样本记录连续帧临时组 deleted=true；全局服务端 reaper仍不可见',coordination:'create temp→refcount/ownership→terminal cleanup→retry/reaper',localEvidence:[local('src/commerce/server/assets.ts',"temporary?:{kind:'rolling-tail'"),local('src/commerce/server/rolling-video-worker.ts','temporaryAssetsCleanupStatus')],status:'对标单任务尾帧清理和本站滚动尾帧专项清理均有证据；全局孤儿资产策略未闭环',gap:'片段/上传/浏览器草稿/COS 对象的 TTL、refcount、孤儿 reaper 缺统一合同',priority:'P1'},
];

const uiRows=[
 {id:'workspace-shell',route:'/(workspace)/*',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'间接',runtimeAccepted:false,layout:'desktop >=lg 72px sidebar；mobile bottom nav + safe area；min-height 100dvh',benchmarkEvidence:[bench('1d66538e000000000000000000000000000000000000000000000000000000',10267,28032,'app/(workspace)/layout-4636b17f0b338f53.js')],gap:'桌面与390px computed-style 验收待执行'},
 {id:'toolbox-catalog',route:'/toolbox',capturedPage:true,routeController:true,sharedRenderer:false,apiContract:'客户端目录常量',runtimeAccepted:false,layout:'1列→sm 2列；视频处理 xl 4列',benchmarkEvidence:[bench('745f059800000000000000000000000000000000000000000000000000000000',599,15764,'app/(workspace)/toolbox/page-2819cb933e6431dc.js')],gap:'9张顶层卡不能代表全部内嵌技能'},
 {id:'toolbox-shared-shell',route:'/toolbox/[toolSlug]',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'按工具注入',runtimeAccepted:false,layout:'桌面三栏；mobile panel h=min(66dvh,34rem)',benchmarkEvidence:[benchmark.editor],gap:'需逐工具 desktop+390 溢出/折叠验收'},
 {id:'image-generation',route:'/toolbox/image-generation',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'skill-packs/model-routes/batches/assets',runtimeAccepted:false,layout:'共享三栏+目录驱动表单',benchmarkEvidence:[{...benchmark.toolbox,byteStart:584577,byteEnd:621087}],gap:'provider worker/quote settlement/asset terminal 私有'},
 {id:'ecommerce-image-set',route:'/toolbox/ecommerce-image-set',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'analysis-row/row-quote/row-generations/regenerations',runtimeAccepted:false,layout:'分析行列表/表格+预览队列',benchmarkEvidence:[{...benchmark.toolbox,byteStart:621088,byteEnd:647969}],gap:'分析 worker、逐图资产与计费终态不可见'},
 {id:'video-processors',route:'/toolbox/{hot-video-remix,subtitle,watermark,enhance,depth}',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'batches/assets/model routes',runtimeAccepted:false,layout:'共享编辑/预览/队列壳',benchmarkEvidence:[{...benchmark.toolbox,byteStart:647970,byteEnd:743436}],gap:'私有 split/edit/provider workers 不可见'},
 {id:'video-generation-director',route:'/toolbox/video-generation',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'video-creator conversations/script stream/batches/quote',runtimeAccepted:false,layout:'生成表单+导演聊天+任务/草稿/预览',benchmarkEvidence:[{...benchmark.toolbox,byteStart:743437,byteEnd:823505}],gap:'应用脚本仅证明回填生成表单；19个运行发布ID/读回待核'},
 {id:'digital-human',route:'/toolbox/digital-human',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'voice-profiles/system voices/batches/assets',runtimeAccepted:false,layout:'模式 tabs+媒体/声音选择器',benchmarkEvidence:[{...benchmark.toolbox,byteStart:823506,byteEnd:839650}],gap:'客户端意图不证明声音/口型服务可用'},
 {id:'assets-workspace',route:'/assets and /assets/generated',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'upload-policy/complete/assets/groups/auth',runtimeAccepted:false,layout:'grid 3→sm4→lg5→xl6；fixed batch bar',benchmarkEvidence:[benchmark.api],gap:'对象存储权限、生命周期与清理私有'},
 {id:'canvas-list',route:'/canvas',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'canvas CRUD/duplicate/snapshot/share',runtimeAccepted:false,layout:'grid 3→sm4→lg5→xl6；预览1280/720',benchmarkEvidence:[bench('854de860000000000000000000000000000000000000000000000000000000',386,27678,'app/(workspace)/canvas/page-a614fd1be9318067.js')],gap:'列表和一个真实详情 GET 已取证；本站仍需当前构建浏览器验收'},
 {id:'canvas-dynamic-editor',route:'/canvas/{workspace_id}',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'canvas detail/nodes/edges/groups/runs/templates/media derivatives/share',runtimeAccepted:false,layout:'stage/节点/边/组/小地图/缩放/拖放/预览和多轨编辑集成',benchmarkEvidence:[benchmark.canvasDynamic,benchmark.canvasGraph,benchmark.canvasShare,benchmark.canvasDetail,benchmark.canvasPageNotFound,benchmark.canvas,benchmark.api],gap:'真实持久化 ID 的 detail API 200，但精确页面正文为“页面未找到”且自然 detail GET=0；控制器源码存在，实获画布 revision=0 且 nodes/edges/groups 为空；页面接线、写操作、非空持久化、协作冲突和任务终态未通过'},
 {id:'canvas-skill-composer',route:'/canvas/{workspace_id}',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'skill catalog→composer payload→run/task→asset/node insertion',runtimeAccepted:false,layout:'@素材与/技能浮层、富文本编辑器、节点结果插入',benchmarkEvidence:[benchmark.canvasDynamic,{...benchmark.canvas,byteStart:130011,byteEnd:198741}],gap:'4 个 canvas-only 技能的 UI/控制器合同已取证；提交会写业务状态且可能付费，未执行'},
 {id:'shared-video-stitch-editor',route:'共享结果/资产编辑入口',capturedPage:false,routeController:'部分入口未知',sharedRenderer:true,apiContract:'batches/assets/segment-retake',runtimeAccepted:false,layout:'full workspace z2231；left320；timeline 34vh；mobile drawers',benchmarkEvidence:[benchmark.editor],gap:'引擎存在不等于所有入口挂载或服务器终态可用'},
 {id:'admin-video-director-skills',route:'/admin/video-creator-skills',capturedPage:true,routeController:true,sharedRenderer:false,apiContract:'draft/validate/preview/publish/versions/rollback/enable',runtimeAccepted:false,layout:'max-w-7xl；editor h92vh',benchmarkEvidence:[bench('94d0e12d000000000000000000000000000000000000000000000000000000',121,60229,'app/(admin)/admin/video-creator-skills/page-0d5138efbfb637eb.js')],gap:'common policy→category root→child skill；当前 published pointer 未证明'},
 {id:'admin-image-skill-packages',route:'/admin/skill-packages',capturedPage:true,routeController:true,sharedRenderer:false,apiContract:'common prompts/package draft/validate/preview/publish/versions/rollback',runtimeAccepted:false,layout:'editors max-w-5xl/7xl、82–92vh',benchmarkEvidence:[bench('b423e1a50000000000000000000000000000000000000000000000000000000',64,63204,'app/(admin)/admin/skill-packages/page-2e47260eee323fb6.js')],gap:'数据库 published prompt/model route/原子切换未证明'},
 {id:'affiliate-user-admin',route:'/affiliate/* and /admin/affiliate/*',capturedPage:true,routeController:true,sharedRenderer:true,apiContract:'KYC/referral/commission/settlement/recharge cards/proof/bank reveal',runtimeAccepted:false,layout:'desktop sidebar260；mobile select；tables 760–900px',benchmarkEvidence:[benchmark.api],gap:'金融/KYC/RBAC/支付幂等服务端不可见'},
];

const skillSurfaces={
 topLevelTools:{count:9,ids:['ecommerce-image-set','digital-human','depth-video-clone','hot-video-remix','video-subtitle-erase','video-watermark-remove','video-quality-enhance','video-generation','image-generation'],status:'all exact page GET 200 in existing captures'},
 queryEntries:{status:'passed-readonly-page-capture-29-of-29',imageCount:11,videoCount:18,imageParameter:'skill_pack',videoParameter:'skill',result:'all HTTP 200 with exact final pathname; no new business JavaScript executor; no business writes'},
 canvasOnlyImageSkills:{count:4,ids:['script-storyboard','storyboard-element-replace','video-reference-first-frame','product-consistency-reference'],status:'real dynamic Canvas controller and composer contract captured; submissions intentionally unexecuted because they write business state and can create paid tasks'},
 hiddenDefaults:{count:2,ids:['default','default-director'],status:'configuration substrate; excluded from user-facing cards'},
 internalActionFamilies:{ids:['video-segment-retake','video-creator','prompt-generator','canvas-video-keyframe-breakdown','reference-video-split'],status:'ledger/renderer/action names; not presented as independent toolbox pages'},
};

function validateRows(rows){
 const missingLocal=rows.flatMap(row=>(row.localEvidence||[]).filter(item=>!item.exists||!item.needleFound).map(item=>({row:row.id,file:item.file,needle:item.needle,exists:item.exists,needleFound:item.needleFound})));
 const missingSha=rows.flatMap(row=>(row.benchmarkEvidence||[]).filter(item=>!item.shaPresentInIndex).map(item=>({row:row.id,file:item.file,sha:item.fileSha256})));
 return{passed:missingLocal.length===0&&missingSha.length===0,missingLocal,missingSha};
}
const mediaValidation=validateRows(mediaRows);
const uiValidation=validateRows(uiRows);
const commonBoundary={
 sourceDiscoveryFixedPoint:closure.passed,
 conditionalEntryFixedPoint:'query-entries-passed-dynamic-canvas-page-failed-write-execution-unverified',
 runtimePayloadFixedPoint:runtimeAudit.fixedPoint.status,
 privateServerSourceDownloaded:false,
 buildOrBrowserAcceptanceThisAudit:false,
 paidGeneration:false,
 deployment:false,
};
const mediaReport={schemaVersion:'maolong.deep-media-chain-audit/v1',generatedAtUtc:now,status:mediaValidation.passed?'evidence-validated-runtime-pending':'evidence-validation-failed',boundary:commonBoundary,verdict:'浏览器媒体内核、动态 Canvas 和请求状态机覆盖很深；本站已补普通 Commerce 常驻协调，但供应商适配、对标私有 worker、数据库事务、计费终态、统一资产与全局临时清理仍不能从镜像推断。继续融合本站，不全量覆盖。',rows:mediaRows,validation:mediaValidation};
const uiReport={schemaVersion:'maolong.ui-backend-chain-audit/v1',generatedAtUtc:now,status:uiValidation.passed?'evidence-validated-runtime-pending':'evidence-validation-failed',boundary:commonBoundary,verdict:'前端 bundle、共享组件、29 个 query 条件入口、可观察 GET 载荷和 /canvas/{workspace_id} 控制器源码已闭合；真实持久化 Canvas 的页面语义仍失败，4 个 canvas-only 提交和真实桌面/390px本站运行验收仍缺。',skillSurfaces,rows:uiRows,validation:uiValidation};

const mediaJson=path.join(docs,'深层媒体功能链路审计.json');
const uiJson=path.join(docs,'UI到后端功能链路审计.json');
writeAtomic(mediaJson,mediaReport);
writeAtomic(uiJson,uiReport);
const mediaMd=['# 深层媒体功能链路审计','',`生成时间：${now}`,'',mediaReport.verdict,'','| 链路 | 触发 | 当前状态 | 关键缺口 | 优先级 |','|---|---|---|---|---|',...mediaRows.map(row=>`| ${row.id} | ${row.trigger.replaceAll('|','\\|')} | ${row.status.replaceAll('|','\\|')} | ${row.gap.replaceAll('|','\\|')} | ${row.priority} |`),'','## 验证边界','',`- 代码发现闭包：${commonBoundary.sourceDiscoveryFixedPoint?'通过':'未通过'}`,'- Query 条件入口：29/29 已通过只读页面抓取','- 动态 Canvas：详情 API、专属 controller 和依赖已捕获；真实 ID 页面正文仍为“页面未找到”','- Canvas-only 提交：因业务写入/可能付费未执行',`- 运行响应体闭包：${commonBoundary.runtimePayloadFixedPoint}`,'- 付费生成：未执行','- 部署：未执行',''];
const uiMd=['# UI 到后端功能链路审计','',`生成时间：${now}`,'',uiReport.verdict,'','| Surface | Route | 页面已抓 | Controller 已抓 | Shared renderer | API contract | 运行验收 | 缺口 |','|---|---|---:|---:|---:|---|---:|---|',...uiRows.map(row=>`| ${row.id} | ${row.route.replaceAll('|','\\|')} | ${row.capturedPage?'是':'否'} | ${row.routeController===true?'是':row.routeController===false?'否':row.routeController} | ${row.sharedRenderer?'是':'否'} | ${row.apiContract} | ${row.runtimeAccepted?'是':'否'} | ${row.gap.replaceAll('|','\\|')} |`),'','## 技能入口分层','',`- 顶层工具：${skillSurfaces.topLevelTools.count}`,'- Query 入口：11 图片 + 18 视频，29/29 已只读抓取','- 仅画布内：4，UI 与 controller 合同已取证；提交未执行','- 隐藏默认配置：2','- 内部 action 家族：5',''];
writeAtomic(path.join(docs,'深层媒体功能链路审计.md'),`${mediaMd.join('\n')}\n`);
writeAtomic(path.join(docs,'UI到后端功能链路审计.md'),`${uiMd.join('\n')}\n`);

const outputs=[mediaJson,uiJson,path.join(docs,'深层媒体功能链路审计.md'),path.join(docs,'UI到后端功能链路审计.md')].map(file=>{const bytes=fs.readFileSync(file);return{file,bytes:bytes.length,sha256:sha256(bytes)};});
console.log(JSON.stringify({ok:mediaValidation.passed&&uiValidation.passed,mediaRows:mediaRows.length,uiRows:uiRows.length,mediaValidation,uiValidation,outputs},null,2));
if(!mediaValidation.passed||!uiValidation.passed)process.exitCode=1;
