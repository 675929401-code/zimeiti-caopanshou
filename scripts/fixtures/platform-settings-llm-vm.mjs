#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), ts=require('typescript'), root=path.resolve('');
const sha256=value=>createHash('sha256').update(value).digest('hex');
const checks=[]; const effects={database:0,provider:0,reserve:0,search:0,secret:0};
const forbidden=()=>{effects.database++;throw new Error('OFFLINE_EFFECT_FORBIDDEN');};
let rpcAdapter, readonlyAdapter;
let offlineFetch;
export function setOfflineFetch(handler) { offlineFetch = handler; }
const cache=new Map();
export function load(relative) {
  const absolute=path.resolve(root,relative); if(cache.has(absolute))return cache.get(absolute).exports;
  if(absolute.endsWith('.json'))return JSON.parse(fs.readFileSync(absolute,'utf8'));
  const module={exports:{}};cache.set(absolute,module);
  let source=fs.readFileSync(absolute,'utf8');
  if(relative.endsWith('quote-llm-standard-request-readonly.ts')) {
    source=source.replace('path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")',JSON.stringify(root));
    source=source.slice(0,source.indexOf('if (process.argv[1]'));
  }
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const customRequire=specifier=>{
    if(specifier==='@/lib/server-runtime-env')return {ensureServerRuntimeEnvLoaded(){}};
    if(specifier==='@/storage/database/supabase-client')return {getSupabaseAdminClient:()=>rpcAdapter||readonlyAdapter?{rpc:rpcAdapter,from:readonlyAdapter}:forbidden(),getSupabaseClient:forbidden};
    if(specifier==='./db' && path.basename(absolute)==='billing.ts')return {getDb:forbidden};
    if(specifier.startsWith('node:'))return require(specifier);
    if(!specifier.startsWith('@/') && !specifier.startsWith('.'))return require(specifier);
    let target=specifier.startsWith('@/')?path.join(root,'src',specifier.slice(2)):path.resolve(path.dirname(absolute),specifier);
    if(!path.extname(target))target+='.ts';
    return load(path.relative(root,target));
  };
    vm.runInNewContext(compiled,{module,exports:module.exports,require:customRequire,__dirname:path.dirname(absolute),Buffer,URL,Response,Headers,AbortController,fetch:(...args)=>{if(offlineFetch)return offlineFetch(...args);throw new Error('OFFLINE_FETCH_FORBIDDEN');},console:{log(){},warn(){}},process:{argv:[],env:{}},setTimeout,clearTimeout},{filename:absolute});
  return module.exports;
}
