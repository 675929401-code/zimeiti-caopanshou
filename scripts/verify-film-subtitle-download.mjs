import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require=createRequire(import.meta.url),{NextRequest,NextResponse}=require('next/server'),{z}=require('zod');
const projectId='5c9786fe-64a9-4123-96a1-ddbca89e7108',videoId='00000000-0000-4000-8000-000000000001',subtitleId='00000000-0000-4000-8000-000000000002';
let owned=true,authenticated=true,reads=0,authCalls=0,bytes;
const srt=Buffer.from('1\n00:00:00,000 --> 00:00:10,000\n字幕归属验证\n','utf8');
const video={id:videoId,jobId:'job',assetRole:'export',shotId:null,provider:'tencent_cos',objectKey:'owned/final.mp4',stableUri:'object://tencent_cos/owned%2Ffinal.mp4',byteSize:4,metadata:{subtitleAssetId:subtitleId}};
const subtitle={id:subtitleId,jobId:'job',assetRole:'subtitle',shotId:null,provider:'tencent_cos',objectKey:'owned/final.srt',stableUri:'object://tencent_cos/owned%2Ffinal.srt',mimeType:'application/x-subrip; charset=utf-8',byteSize:srt.length,checksumSha256:createHash('sha256').update(srt).digest('hex'),metadata:{format:'srt'}};
let assets,jobs;
function reset(){owned=true;authenticated=true;bytes=srt;assets=[video,subtitle];jobs=[{id:'job',stage:'final_assembly',state:'succeeded'}];}
class ProductionError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const helperContext={exports:{},Buffer,TextDecoder,require(name){
 if(name==='node:crypto')return {createHash};
 if(name==='@/storage/object')return {storageManager:{async read(key,provider){assert.equal(provider,'tencent_cos');assert.ok(['owned/final.srt','owned/final.mp4'].includes(key));reads++;return bytes;}}};
 if(name==='./repository')return {ShortDramaProjectRepository:class{async getProject(user,project){assert.equal(user,'owner');assert.equal(project,projectId);return owned?{}:null;}}};
 if(name==='./production-repository')return {ShortDramaProductionError:ProductionError,ShortDramaProductionRepository:{fromAuth(){return {async listProduction(user,project){assert.equal(user,'owner');assert.equal(project,projectId);return {assets,jobs};}}}}};
 throw new Error(name);
}};
const compile=file=>ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(compile('src/lib/short-drama/production-download.ts'),helperContext);
const read=(id=subtitleId)=>helperContext.exports.readOwnedFilmDownload({userId:'owner',db:{}},projectId,id);
const checks=[];
reset();let download=await read();assert.equal(download.bytes.toString(),srt.toString());assert.equal(download.extension,'srt');assert.equal(download.contentType,'application/x-subrip; charset=utf-8');checks.push('owned completed paired SRT downloads original UTF-8 bytes');
for(const [name,mutate,code] of [
 ['foreign project',()=>{owned=false},'PROJECT_NOT_FOUND'],
 ['wrong role',()=>{assets=[video,{...subtitle,assetRole:'image'}]},'FILM_EXPORT_NOT_FOUND'],
 ['incomplete final job',()=>{jobs=[{id:'job',stage:'final_assembly',state:'running'}]},'FILM_EXPORT_NOT_FOUND'],
 ['other job reference',()=>{assets=[{...video,jobId:'other'},subtitle]},'FILM_SUBTITLE_NOT_FOUND'],
 ['not referenced by final',()=>{assets=[{...video,metadata:{subtitleAssetId:videoId}},subtitle]},'FILM_SUBTITLE_NOT_FOUND'],
 ['unpaired subtitle',()=>{assets=[subtitle]},'FILM_SUBTITLE_NOT_FOUND'],
 ['invalid stable URI',()=>{assets=[video,{...subtitle,stableUri:'https://private.invalid/file'}]},'FILM_EXPORT_NOT_FOUND'],
 ['invalid MIME',()=>{assets=[video,{...subtitle,mimeType:'text/html'}]},'FILM_SUBTITLE_NOT_FOUND'],
 ['size exceeds subtitle bound',()=>{assets=[video,{...subtitle,byteSize:1024*1024+1}]},'FILM_EXPORT_TOO_LARGE'],
]){reset();mutate();const before=reads;await assert.rejects(read,{code});assert.equal(reads,before);checks.push(`${name} rejected before storage read`);}
reset();bytes=Buffer.from('bad');await assert.rejects(read,{code:'FILM_EXPORT_SIZE_MISMATCH'});checks.push('incomplete file fails stored byte-size check');
reset();bytes=Buffer.alloc(srt.length,65);await assert.rejects(read,{code:'FILM_EXPORT_CHECKSUM_MISMATCH'});checks.push('same-size corrupt file fails stored SHA-256');
reset();bytes=Buffer.from('<html>not subtitles</html>');assets=[video,{...subtitle,byteSize:bytes.length,checksumSha256:createHash('sha256').update(bytes).digest('hex')}];await assert.rejects(read,{code:'FILM_SUBTITLE_INVALID'});checks.push('non-SRT attachment rejected even when declared type and checksum match');
reset();await assert.rejects(()=>helperContext.exports.readOwnedFilmExport({userId:'owner',db:{}},projectId,subtitleId),{code:'FILM_EXPORT_NOT_FOUND'});checks.push('legacy video-only helper remains video-only');
const routeContext={exports:{},Uint8Array,require(name){
 if(name==='next/server')return {NextRequest,NextResponse};if(name==='zod')return {z};
 if(name==='@/lib/short-drama/contracts')return {ShortDramaProjectParamsSchema:z.object({projectId:z.string().uuid()})};
 if(name==='@/lib/short-drama/permissions')return {async authorizeShortDramaRequest(){authCalls++;if(!authenticated)throw new ProductionError(401,'UNAUTHORIZED','登录后下载');return {userId:'owner',db:{}};}};
 if(name==='@/lib/short-drama/production-download')return helperContext.exports;
 if(name==='@/lib/short-drama/http')return {shortDramaErrorResponse(error){return NextResponse.json({code:error.code||'VALIDATION_ERROR'},{status:error.status||(error instanceof z.ZodError?400:500)});}};
 throw new Error(name);
}};
vm.runInNewContext(compile('src/app/api/short-drama/projects/[projectId]/production/download/route.ts'),routeContext);
const get=assetId=>routeContext.exports.GET(new NextRequest(`http://127.0.0.1:5002/api/short-drama/projects/${projectId}/production/download?assetId=${assetId}`),{params:Promise.resolve({projectId})});
reset();let response=await get(subtitleId);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/x-subrip; charset=utf-8');assert.equal(response.headers.get('content-length'),String(srt.length));assert.match(response.headers.get('content-disposition'),/attachment; filename="film-[\w-]+\.srt"/);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),srt);checks.push('actual GET handler returns SRT attachment and private/no-sniff headers');
reset();bytes=Buffer.from('film');response=await get(videoId);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'video/mp4');assert.match(response.headers.get('content-disposition'),/\.mp4"$/);checks.push('actual GET handler retains MP4 download contract');
reset();authenticated=false;const before=reads;response=await get(subtitleId);assert.equal(response.status,401);assert.equal(reads,before);checks.push('anonymous handler request fails before any asset storage read');
reset();response=await get('https://private.invalid');assert.equal(response.status,400);assert.equal(reads,before);checks.push('handler accepts only UUID asset IDs and no arbitrary download URL');
const report={passed:true,cases:checks.length,checks,actualHelperAndHandler:true,authorizationRepositoryAndStorageMocked:true,authCalls,networkRequests:0,businessWrites:0,providerGenerationCalls:0};
mkdirSync('.codex-evidence/film-subtitle-download-20260903',{recursive:true});writeFileSync('.codex-evidence/film-subtitle-download-20260903/helper-handler-fixture.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
