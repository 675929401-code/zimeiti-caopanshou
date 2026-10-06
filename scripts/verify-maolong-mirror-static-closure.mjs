import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {maolongCaptureLabel as captureLabel,resolveMaolongMirrorRoots} from './maolong-mirror-capture-roots.mjs';

const roots=resolveMaolongMirrorRoots();
const evidencePath=path.resolve(process.env.MAOLONG_EVIDENCE_INDEX||'docs/带货Agent镜像融合-20260925/对标前端源码语法节点索引.json');
const outputPath=path.resolve(process.env.MAOLONG_CLOSURE_OUTPUT||'docs/带货Agent镜像融合-20260925/对标镜像静态闭包验收.json');
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
const slash=value=>value.replaceAll('\\','/');
const walk=directory=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const manifests=roots.map(root=>({root,manifestPath:path.join(root,'manifest.json')})).filter(item=>fs.existsSync(item.manifestPath)).map(item=>({...item,manifest:readJson(item.manifestPath)}));
if(!manifests.length)throw Error('No mirror manifests found');
if(!fs.existsSync(evidencePath))throw Error(`Missing source evidence index: ${evidencePath}`);
const evidence=readJson(evidencePath);

const unionResponses=[];
const unionPages=[];
const bodyIntegrityFailures=[];
const savedResourceFiles=new Map();
let businessWriteRequestsAllowed=0,businessWriteRequestsBlocked=0;
for(const {root,manifest} of manifests){
 businessWriteRequestsAllowed+=Number(manifest.access?.businessWriteRequestsAllowed||0);
 businessWriteRequestsBlocked+=Number(manifest.access?.businessWriteRequestsBlocked||0);
 for(const page of manifest.pages||[])unionPages.push({...page,captureRoot:captureLabel(root)});
 for(const response of manifest.responses||[]){
  const row={...response,captureRoot:captureLabel(root)};
  unionResponses.push(row);
  if(!response.savedPath)continue;
  const file=path.join(root,response.savedPath);
  if(!fs.existsSync(file)){bodyIntegrityFailures.push({...row,reason:'saved-path-missing'});continue;}
  const bytes=fs.readFileSync(file),actualSha256=sha256(bytes);
  if(bytes.length!==Number(response.bytes)||actualSha256!==response.sha256)bodyIntegrityFailures.push({...row,reason:'size-or-sha-mismatch',actualBytes:bytes.length,actualSha256});
  else if(Number(response.status)===200&&!savedResourceFiles.has(response.url))savedResourceFiles.set(response.url,file);
 }
}

const deepMediaReports=roots.map(root=>path.join(root,'deep-media-static-dependencies.json')).filter(file=>fs.existsSync(file)).map(file=>({file,report:readJson(file)}));
for(const {file,report} of deepMediaReports){
 const root=path.dirname(file);
 for(const item of report.items||[]){
  unionResponses.push({...item,captureRoot:captureLabel(root),supplementalDeepMedia:true});
  const target=path.join(root,item.savedPath||'');
  if(!item.savedPath||!fs.existsSync(target)){bodyIntegrityFailures.push({...item,captureRoot:captureLabel(root),reason:'deep-media-path-missing'});continue;}
  const bytes=fs.readFileSync(target),actualSha256=sha256(bytes);
  if(bytes.length!==Number(item.bytes)||actualSha256!==item.sha256)bodyIntegrityFailures.push({...item,captureRoot:captureLabel(root),reason:'deep-media-size-or-sha-mismatch',actualBytes:bytes.length,actualSha256});
  else if(Number(item.status)===200&&!savedResourceFiles.has(item.url))savedResourceFiles.set(item.url,target);
 }
}

const successfulUrls=new Set(unionResponses.filter(item=>Number(item.status)===200&&item.savedPath).map(item=>item.url));
const javascriptFiles=roots.flatMap(root=>{const responseRoot=path.join(root,'responses');return fs.existsSync(responseRoot)?walk(responseRoot).filter(file=>file.endsWith('.js')):[];});
const runtimeMappings=new Map(),runtimeMappingConflicts=[];
for(const file of javascriptFiles.filter(file=>/^webpack-.*\.js$/iu.test(path.basename(file)))){
 const text=fs.readFileSync(file,'utf8');
 for(const match of text.matchAll(/(?:^|[,({])(\d+):"([a-f0-9]{16})"/gu)){
  if(runtimeMappings.has(match[1])&&runtimeMappings.get(match[1])!==match[2])runtimeMappingConflicts.push({chunkId:match[1],hashes:[runtimeMappings.get(match[1]),match[2]],file:slash(file)});
  runtimeMappings.set(match[1],match[2]);
 }
}
const runtimeExpected=[...runtimeMappings].map(([chunkId,hash])=>({chunkId,hash,url:`https://daai-static.da-ai.vip/_next/static/chunks/${chunkId}.${hash}.js`}));
const runtimeMissing=runtimeExpected.filter(item=>!successfulUrls.has(item.url));
const referencedLazyIds=new Set();
for(const file of javascriptFiles){const text=fs.readFileSync(file,'utf8');for(const match of text.matchAll(/\.e\((\d+)\)/gu))referencedLazyIds.add(match[1]);}
const referencedLazyWithoutRuntimeMapping=[...referencedLazyIds].filter(id=>!runtimeMappings.has(id)).sort((a,b)=>Number(a)-Number(b));

const absoluteStaticReferences=new Set();
const absoluteStaticPattern=/https:\/\/daai-(?:static|asset)\.da-ai\.vip\/[A-Za-z0-9_./-]+(?:\.wasm\.gz|\.wasm|\.js)/gu;
for(const file of javascriptFiles){const text=fs.readFileSync(file,'utf8');for(const match of text.matchAll(absoluteStaticPattern))absoluteStaticReferences.add(match[0]);}
const missingAbsoluteStaticReferences=[...absoluteStaticReferences].filter(url=>!successfulUrls.has(url)).sort();
const requiredDeepMediaUrls=[
 'https://daai-static.da-ai.vip/_next/static/media/soundtouch-processor.88137476.js',
 'https://daai-asset.da-ai.vip/ffmpeg/ffmpeg-core.js',
 'https://daai-asset.da-ai.vip/ffmpeg/ffmpeg-core.wasm.gz',
 'https://maolong.da-ai.cc/image-decode/heif-1.22.2-v1/worker.js',
 'https://maolong.da-ai.cc/image-decode/heif-1.22.2-v1/libheif.js',
];
const missingRequiredDeepMedia=requiredDeepMediaUrls.filter(url=>!successfulUrls.has(url));
const heifLibFile=roots.map(root=>path.join(root,'responses','maolong.da-ai.cc','image-decode','heif-1.22.2-v1','libheif.js')).find(file=>fs.existsSync(file));
const heifLibText=heifLibFile?fs.readFileSync(heifLibFile,'utf8'):'';
const heifWasm2JsFallback={
 file:heifLibFile?slash(heifLibFile):null,
 isWasm2js:heifLibText.includes('isWasm2js:true'),
 primesEmptyBinary:heifLibText.includes('if(WebAssembly.isWasm2js){wasmBinary=[]}'),
 synchronousEmbeddedInstantiation:heifLibText.includes('var result=instantiateSync(wasmBinaryFile,info)'),
 optionalUnfetchedUrl:'https://maolong.da-ai.cc/image-decode/heif-1.22.2-v1/libheif.wasm',
 optionalUrlObservedStatus:unionResponses.find(item=>item.url==='https://maolong.da-ai.cc/image-decode/heif-1.22.2-v1/libheif.wasm')?.status??null,
 conclusion:'The published libheif.js is an embedded wasm2js build. It primes an empty binary and its local WebAssembly shim ignores that binary, so libheif.wasm is a dead fallback name rather than a required browser fetch.',
};
heifWasm2JsFallback.passed=Boolean(heifWasm2JsFallback.isWasm2js&&heifWasm2JsFallback.primesEmptyBinary&&heifWasm2JsFallback.synchronousEmbeddedInstantiation);

const executableReferencePatterns=[
 {kind:'module-import',pattern:/(?:from\s*|import\s*)["'`]([^"'`]+\.(?:js|wasm(?:\.gz)?))(?:[?#][^"'`]*)?["'`]/gu},
 {kind:'importScripts',pattern:/importScripts\s*\(\s*["'`]([^"'`]+\.(?:js|wasm(?:\.gz)?))(?:[?#][^"'`]*)?["'`]/gu},
 {kind:'worker',pattern:/new\s+Worker\s*\(\s*["'`]([^"'`]+\.(?:js|wasm(?:\.gz)?))(?:[?#][^"'`]*)?["'`]/gu},
 {kind:'audio-worklet',pattern:/addModule\s*\(\s*["'`]([^"'`]+\.(?:js|wasm(?:\.gz)?))(?:[?#][^"'`]*)?["'`]/gu},
 {kind:'fetch',pattern:/fetch\s*\(\s*["'`]([^"'`]+\.(?:js|wasm(?:\.gz)?))(?:[?#][^"'`]*)?["'`]/gu},
 {kind:'module-url',pattern:/new\s+URL\s*\(\s*["'`]([^"'`]+\.(?:js|wasm(?:\.gz)?))(?:[?#][^"'`]*)?["'`]\s*,\s*import\.meta\.url/gu},
];
const allowedStaticHosts=new Set(['maolong.da-ai.cc','daai-static.da-ai.vip','daai-asset.da-ai.vip']);
const resolveStaticReference=(sourceUrl,reference)=>{
 try{const resolved=new URL(reference,sourceUrl);return allowedStaticHosts.has(resolved.hostname)?resolved.href:null;}catch{return null;}
};
const recursiveStaticEdges=[];
for(const [sourceUrl,file] of savedResourceFiles){
 if(!sourceUrl.endsWith('.js')||!fs.existsSync(file))continue;
 const text=fs.readFileSync(file,'utf8');
 for(const {kind,pattern} of executableReferencePatterns){
  pattern.lastIndex=0;
  for(const match of text.matchAll(pattern)){
   const targetUrl=resolveStaticReference(sourceUrl,match[1]);
   if(targetUrl)recursiveStaticEdges.push({kind,sourceUrl,targetUrl,sourceFile:slash(file),byteStart:Buffer.byteLength(text.slice(0,match.index),'utf8'),byteEnd:Buffer.byteLength(text.slice(0,(match.index??0)+match[0].length),'utf8')});
  }
 }
}
for(const targetUrl of requiredDeepMediaUrls)recursiveStaticEdges.push({kind:'explicit-runtime-anchor',sourceUrl:null,targetUrl,sourceFile:null,byteStart:null,byteEnd:null});
if(heifLibFile&&heifLibText.includes('libheif.wasm')){
 const sourceUrl=[...savedResourceFiles].find(([,file])=>path.resolve(file)===path.resolve(heifLibFile))?.[0]||'https://maolong.da-ai.cc/image-decode/heif-1.22.2-v1/libheif.js';
 recursiveStaticEdges.push({kind:'wasm-fallback-name',sourceUrl,targetUrl:heifWasm2JsFallback.optionalUnfetchedUrl,sourceFile:slash(heifLibFile),byteStart:null,byteEnd:null});
}
const optionalStaticUrls=new Map([[heifWasm2JsFallback.optionalUnfetchedUrl,{reason:'embedded-wasm2js-dead-fallback',proved:heifWasm2JsFallback.passed}]]);
const uniqueRecursiveEdges=[...new Map(recursiveStaticEdges.map(edge=>[`${edge.kind}\0${edge.sourceUrl||''}\0${edge.targetUrl}`,edge])).values()];
const missingRecursiveStaticDependencies=uniqueRecursiveEdges.filter(edge=>!successfulUrls.has(edge.targetUrl)&&!optionalStaticUrls.get(edge.targetUrl)?.proved);
const justifiedOptionalStaticDependencies=uniqueRecursiveEdges.filter(edge=>optionalStaticUrls.get(edge.targetUrl)?.proved).map(edge=>({...edge,justification:optionalStaticUrls.get(edge.targetUrl).reason}));
const recursiveStaticDependencyGraph={
 roots:requiredDeepMediaUrls,
 edges:uniqueRecursiveEdges,
 missing:missingRecursiveStaticDependencies,
 optionalJustified:justifiedOptionalStaticDependencies,
 passed:missingRecursiveStaticDependencies.length===0,
};
const pageRequirement={route:'/affiliate/recharge-cards/new',observations:unionPages.filter(item=>item.route==='/affiliate/recharge-cards/new')};
pageRequirement.passed=pageRequirement.observations.some(item=>item.status===200&&item.finalPath==='/affiliate/recharge-cards/new');

const uniqueTools=values=>new Map(values.map(value=>[`${value.kind}:${value.slug}`,value]));
const tools=uniqueTools(evidence.tools||[]);
const activeRegistry=[...tools.values()].filter(item=>item.kind==='registry'&&item.status==='active');
const renderers=[...tools.values()].filter(item=>item.kind==='renderer');
const imageSkills=new Set((evidence.skillPacks||[]).filter(item=>item.catalog==='image').map(item=>item.id));
const directorSkills=new Set((evidence.skillPacks||[]).filter(item=>item.catalog==='video-director').map(item=>item.id));
const checks={
 manifestsPresent:{passed:manifests.length===roots.length,expected:roots.length,actual:manifests.length},
 savedBodyIntegrity:{passed:bodyIntegrityFailures.length===0,failures:bodyIntegrityFailures.length},
 businessWriteIsolation:{passed:businessWriteRequestsAllowed===0,allowed:businessWriteRequestsAllowed,blocked:businessWriteRequestsBlocked},
 rechargeCardNewPage:{passed:pageRequirement.passed},
 webpackRuntimeMappings:{passed:runtimeExpected.length>0&&runtimeMissing.length===0&&runtimeMappingConflicts.length===0,mappings:runtimeExpected.length,missing:runtimeMissing.length,conflicts:runtimeMappingConflicts.length},
 deepMediaStaticDependencies:{passed:missingRequiredDeepMedia.length===0,required:requiredDeepMediaUrls.length,missing:missingRequiredDeepMedia.length},
 heifWasm2JsFallback:{passed:heifWasm2JsFallback.passed},
 recursiveStaticDependencyGraph:{passed:recursiveStaticDependencyGraph.passed,edges:recursiveStaticDependencyGraph.edges.length,missing:recursiveStaticDependencyGraph.missing.length,optionalJustified:recursiveStaticDependencyGraph.optionalJustified.length},
 astParse:{passed:Number(evidence.summary?.uniqueParseDiagnostics??evidence.summary?.parseDiagnostics??0)===0,diagnostics:evidence.summary?.uniqueParseDiagnostics??evidence.summary?.parseDiagnostics},
 apiMethodResolution:{passed:Number(evidence.summary?.apiSignaturesRequiringMethodPropagation||0)===0,unresolvedMethods:evidence.summary?.apiSignaturesRequiringMethodPropagation},
 toolRegistry:{passed:activeRegistry.length===9,activeRegistry:activeRegistry.length},
 toolRenderers:{passed:renderers.length===10,renderers:renderers.length},
 imageSkillCatalog:{passed:imageSkills.size===16,skills:imageSkills.size},
 directorCatalog:{passed:directorSkills.size===19,skills:directorSkills.size},
};
const passed=Object.values(checks).every(check=>check.passed);
const report={
 schemaVersion:'maolong.mirror-static-closure/v1',
 generatedAt:new Date().toISOString(),
 passed,
 scope:'Authorized browser-delivered client code, rendered responses, sanitized GET catalogs and explicitly referenced media runtime files.',
 excludes:['Private server implementation source','database schema and live records beyond separately authorized read-only evidence','provider credentials','paid generation','production deployment'],
 roots,
 summary:{captureRoots:roots.length,manifestResponses:manifests.reduce((sum,item)=>sum+(item.manifest.responses||[]).length,0),unionResponseRows:unionResponses.length,successfulSavedUrls:successfulUrls.size,pagesObserved:unionPages.length,runtimeMappings:runtimeExpected.length,referencedLazyIds:referencedLazyIds.size,absoluteStaticReferences:absoluteStaticReferences.size,uniqueApiSignatures:evidence.summary?.uniqueApiSignatures,uniqueUnresolvedApiTemplates:evidence.summary?.uniqueUnresolvedApiTemplates,uniqueAstNodes:evidence.summary?.uniqueAstNodes??evidence.summary?.astNodes,observedAstNodesIncludingDuplicateCaptures:evidence.summary?.astNodes,sourceMaps:evidence.summary?.sourceMapFiles},
 checks,
 pageRequirement,
 runtime:{expected:runtimeExpected,missing:runtimeMissing,conflicts:runtimeMappingConflicts,referencedLazyWithoutRuntimeMapping},
 staticReferences:{requiredDeepMediaUrls,missingRequiredDeepMedia,heifWasm2JsFallback,recursiveStaticDependencyGraph,allAbsolute:[...absoluteStaticReferences].sort(),missingAbsoluteStaticReferences},
 catalogs:{activeRegistry:[...new Set(activeRegistry.map(item=>item.slug))].sort(),renderers:[...new Set(renderers.map(item=>item.slug))].sort(),imageSkills:[...imageSkills].sort(),directorSkills:[...directorSkills].sort()},
 integrityFailures:bodyIntegrityFailures,
 limitations:[
  'No JavaScript source maps were published, so minified bundles are indexed by AST node and UTF-8 byte interval rather than original source line.',
  'Dynamic detail pages require IDs observed in authorized list responses; absent IDs are not guessed.',
  'HTTP 200 client pages and complete static assets do not prove private server workers, database transactions, provider execution or billing terminal states.',
 ],
};
fs.mkdirSync(path.dirname(outputPath),{recursive:true});
const temporary=`${outputPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary,`${JSON.stringify(report,null,2)}\n`);
fs.renameSync(temporary,outputPath);
const bytes=fs.readFileSync(outputPath);
console.log(JSON.stringify({output:outputPath,bytes:bytes.length,sha256:sha256(bytes),passed,checks,summary:report.summary,missingAbsoluteStaticReferences},null,2));
if(!passed)process.exitCode=1;
