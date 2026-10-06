import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const context={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/short-drama/film-video-capabilities.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
const {filmVideoUnavailableReason:reason,canSubmitFilmVideo:canSubmit,buildFilmVideoSubmission:build,filmJobModelLabel:label}=context.exports;
const model=(capabilities={})=>({id:'chosen-public-model',capabilities:{available:true,supportsImageInput:true,maxReferenceImages:1,...capabilities}});
assert.equal(reason(model()),'');assert.equal(canSubmit(model(),''),true);
const request=build({model:model(),shotId:'shot',clientRequestId:'one-fixed-key',resolution:'',duration:10});
assert.equal(request.modelId,'chosen-public-model');assert.equal(request.clientRequestId,'one-fixed-key');assert.equal('resolution' in request,false);
for(const c of [{available:false},{requiresSourceVideo:true},{supportsImageInput:false},{maxReferenceImages:0},{requiresLastFrame:true},{minReferenceImages:2},{minReferenceAudios:1}]){
 assert.notEqual(reason(model(c)),'');assert.equal(canSubmit(model(c),''),false);
 assert.throws(()=>build({model:model(c),shotId:'shot',clientRequestId:'key',resolution:'',duration:10}));
}
assert.equal(canSubmit(model({resolutionOptions:['720p','1080p']}),'1080p'),true);
assert.equal(canSubmit(model({resolutionOptions:['720p','1080p']}),''),false);
assert.equal(canSubmit(model({resolutionOptions:['720p','1080p']}),'4K'),false);
assert.equal(canSubmit(model({defaultResolution:'1080p'}),'1080p'),true);
assert.equal(label('old-job-model',[{id:'new-selection',displayName:'New'}]),'old-job-model');
assert.equal(label('old-job-model',[{id:'old-job-model',displayName:'Original'}]),'Original');
console.log(JSON.stringify({passed:true,capabilityCases:13,originalTaskModelBinding:true,providerCalls:0}));
