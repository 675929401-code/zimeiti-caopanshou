import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import {createHash} from 'node:crypto';
let owned=true,reads=0,bytes=Buffer.from('film');
const validAsset={id:'asset',jobId:'job',assetRole:'export',shotId:null,provider:'tencent_cos',objectKey:'owned/final.mp4',stableUri:'object://tencent_cos/owned%2Ffinal.mp4',byteSize:4,checksumSha256:createHash('sha256').update(bytes).digest('hex')};
let assets=[validAsset],jobs=[{id:'job',stage:'final_assembly',state:'succeeded'}];
class ProductionError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const context={exports:{},Buffer,require(name){
 if(name==='node:crypto')return {createHash};
 if(name==='@/storage/object')return {storageManager:{async read(key,provider){assert.equal(key,'owned/final.mp4');assert.equal(provider,'tencent_cos');reads++;return bytes;}}};
 if(name==='./repository')return {ShortDramaProjectRepository:class{async getProject(user,project){assert.equal(user,'owner');assert.equal(project,'project');return owned?{}:null;}}};
 if(name==='./production-repository')return {ShortDramaProductionError:ProductionError,ShortDramaProductionRepository:{fromAuth(){return {async listProduction(user,project){assert.equal(user,'owner');assert.equal(project,'project');return {assets,jobs};}}}}};
 throw new Error(name);
}};
vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/short-drama/production-download.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
const read=()=>context.exports.readOwnedFilmExport({userId:'owner',db:{}},'project','asset');
assert.equal((await read()).toString(),'film');assert.equal(reads,1);
owned=false;await assert.rejects(read,{code:'PROJECT_NOT_FOUND'});owned=true;
assets=[];await assert.rejects(read,{code:'FILM_EXPORT_NOT_FOUND'});assets=[validAsset];
jobs=[{id:'job',stage:'final_assembly',state:'running'}];await assert.rejects(read,{code:'FILM_EXPORT_NOT_FOUND'});jobs=[{id:'job',stage:'final_assembly',state:'succeeded'}];
assets=[{...validAsset,stableUri:'object://tencent_cos/another.mp4'}];await assert.rejects(read,{code:'FILM_EXPORT_NOT_FOUND'});assets=[validAsset];
assets=[{...validAsset,byteSize:129*1024*1024}];await assert.rejects(read,{code:'FILM_EXPORT_TOO_LARGE'});assert.equal(reads,1);
assets=[{...validAsset,byteSize:null}];await assert.rejects(read,{code:'FILM_EXPORT_UNAVAILABLE'});assert.equal(reads,1);
assets=[validAsset];bytes=Buffer.from('bad');await assert.rejects(read,{code:'FILM_EXPORT_SIZE_MISMATCH'});
bytes=Buffer.from('fake');await assert.rejects(read,{code:'FILM_EXPORT_CHECKSUM_MISMATCH'});
console.log(JSON.stringify({passed:true,cases:9,actualOwnerCheckedDownloadHelper:true,providerGenerationCalls:0}));
