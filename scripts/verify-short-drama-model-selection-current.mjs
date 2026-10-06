import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const published = [{id:'current-published',displayName:'Current'},{id:'pm_xHhTgrkOC_yQmUqKQ44onpP4',displayName:'Legacy'}];
let models = published;
let defaultModelId = 'current-published';
let databaseError = null;
const query = {select(){return query;},eq(key,value){assert.equal(key,'is_active');assert.equal(value,true);return query;},async order(){return {data:[],error:databaseError};}};
const context = {exports:{},Error,require(name){
  if(name==='@/lib/manga-agent-model-policy')return {buildMangaAgentModelCatalog:()=>({models,policy:{defaultModelId}})};
  if(name==='@/storage/database/supabase-client')return {getSupabaseClient:()=>({from(table){assert.equal(table,'llm_models');return query;}})};
  throw new Error(`Unexpected dependency ${name}`);
}};
runInNewContext(ts.transpileModule(readFileSync('src/lib/short-drama/text-model-selection.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
const select = context.exports.selectShortDramaTextModel;
assert.equal((await select()).id,'current-published');
assert.equal((await select('pm_xHhTgrkOC_yQmUqKQ44onpP4')).id,'pm_xHhTgrkOC_yQmUqKQ44onpP4');
await assert.rejects(()=>select('not-published'),{code:'SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE'});
defaultModelId='removed-default';assert.equal((await select()).id,'current-published');
models=[];await assert.rejects(()=>select(),{code:'SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE'});
models=published;databaseError={code:'503'};await assert.rejects(()=>select(),{code:'SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE'});
console.log(JSON.stringify({passed:true,cases:6,actualSelectionFunction:true,providerCalls:0,databaseWrites:0}));
