import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync('src/lib/video-persistence.ts','utf8');
const bytes=Buffer.from('UNMODIFIED FULL NATIVE VIDEO FIXTURE');
const state={downloads:0,uploads:[],trims:0,removals:0};
const exports={};
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(compiled,{exports,Buffer,URL,console,require:name=>{
 if(name==='fs')return{readFileSync(){throw Error('FILESYSTEM_FORBIDDEN');}};
 if(name==='node:dns/promises')return{lookup(){throw Error('DNS_FORBIDDEN');}};
 if(name==='@/storage/object')return{storageManager:{upload:async(buffer,fileName,contentType,options)=>{assert.equal(buffer,bytes);state.uploads.push({fileName,contentType,options});return{provider:'tencent_cos',key:options.prefix+fileName,url:'https://fixture.invalid/native.mp4'};}}};
 if(name==='@/lib/file-upload-security')return{validateUploadBuffer:(buffer)=>{assert.equal(buffer,bytes);return{contentType:'video/mp4',extension:'mp4'};}};
 if(name==='@/lib/safe-fetch')return{safeFetch:async()=>{state.downloads++;return{buffer:bytes,contentType:'video/mp4'};}};
 if(name==='@/lib/video-postprocess')return{downloadAndTrimVideo:async()=>{state.trims++;throw Error('AUTOMATIC_TRIM_FORBIDDEN');},removeVideoTempDir:async()=>{state.removals++;}};
 if(name==='@/lib/autodl-h3-selfhost')return{AUTODL_H3_SELFHOST_PROTOCOL:'autodl_h3_selfhost',isAutodlH3Selfhost:()=>false};
 if(name==='@/lib/video-autodl-comfyui-workflow')return{isAutodlComfyuiHostedProtocol:()=>false};
 return new Proxy({},{get(){return()=>{throw Error('UNEXPECTED_IO:'+name);};}});
}});
for(const persist of [exports.persistVideoFromUrl,exports.persistStableVideoFromUrl]){
 const result=await persist('https://fixture.invalid/full-native.mp4','fixture-task','fixture-owner',{storageScope:'model-acceptance',trimDurationSeconds:3.5,sourceDurationSeconds:15});
 assert.match(result,/^object:\/\/tencent_cos\//);
}
assert.equal(state.downloads,2);assert.equal(state.uploads.length,2);assert.equal(state.trims,0);assert.equal(state.removals,0);
assert.doesNotMatch(source,/downloadAndTrimVideo|trimDurationSeconds|sourceDurationSeconds/);
const generator=fs.readFileSync('src/app/api/video/generate/route.ts','utf8');assert.doesNotMatch(generator,/auto_trim_required|auto_trimmed/);
const compiler=fs.readFileSync('src/app/api/canvas/compile-script/route.ts','utf8');assert.doesNotMatch(compiler,/allowDurationTrim/);
console.log(JSON.stringify({passed:7,failed:0,scope:'Actual persistence functions with legacy JS options persist identical original bytes; provider/network/storage stubbed; independent editing untouched',realProviderRequests:0,databaseWrites:0,trims:state.trims}));
