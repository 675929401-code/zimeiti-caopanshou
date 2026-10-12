import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {isIP} from 'node:net';
import ts from 'typescript';
import {z} from 'zod';

function load(file,dependencies){
 const module={exports:{}};
 const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 runInNewContext(code,{module,exports:module.exports,URL,Buffer,Headers,Response,Request,AbortController,AbortSignal,setTimeout,clearTimeout,process:{env:{}},require:name=>{assert(Object.hasOwn(dependencies,name),'UNMOCKED_DEPENDENCY');return dependencies[name];}});
 return module.exports;
}
let dnsReads=0;
const safe=load('src/lib/safe-fetch.ts',{
 'node:dns/promises':{lookup:async()=>{dnsReads++;return [{address:'198.18.0.17',family:4}];}},
 'node:net':{isIP},
 './safe-fetch-public-dns':{usesDevelopmentPublicDns:()=>false},
});
const provider=load('src/lib/image-provider-delivery.ts',{
 '@/lib/safe-fetch':safe,'@/lib/autodl-h3-selfhost':{},'@/lib/provider-secret':{},
 '@/lib/generated-media-delivery':{},'@/storage/database/supabase-client':{},
});
const refs=load('src/lib/generated-image-reference.ts',{zod:{z}});
const publicUrls=load('src/lib/video-public-url.ts',{});
let current={state:'completed',delivery_state:'delivered',response:{deliveryMode:'provider_url',providerUrl:'https://flow.secure-skill.com/result.png?signature=RAM_FIXTURE'}};
const owner='owner';
const server=load('src/lib/server/generated-image-reference.ts',{
 '@/lib/generated-image-reference':refs,'@/lib/video-public-url':publicUrls,'@/lib/safe-fetch':safe,
 '@/lib/image-provider-delivery':provider,'@/storage/database/supabase-client':{getSupabaseAdminClient:()=>({from:()=>{
  let selectedOwner;const query={select:()=>query,eq:(key,value)=>{if(key==='user_id')selectedOwner=value;return query;},maybeSingle:async()=>({data:selectedOwner===owner?current:null})};return query;
 }})},
});
const reference={schema:'generated_image_ref.v1',recordId:'a'.repeat(64)};
assert.equal(await server.resolveGeneratedImageReference({userId:owner,reference}),current.response.providerUrl);
assert.equal(dnsReads,0,'APPROVED_HTTPS_PROVIDER_REUSES_READER_HOST_POLICY');
await assert.rejects(server.resolveGeneratedImageReference({userId:'other',reference}),error=>error.code==='GENERATED_IMAGE_NOT_OWNED');
for(const url of ['http://flow.secure-skill.com/a','https://flow.secure-skill.com.evil.invalid/a','https://unapproved.invalid/a']){
 await assert.rejects(provider.validateProviderImageUrl(url),error=>error.code==='IP_FORBIDDEN');
}
for(const url of ['http://127.0.0.1/a','https://192.168.1.1/a','https://[::1]/a','https://flow.secure-skill.com:8443/a','file:///a']){
 await assert.rejects(provider.validateProviderImageUrl(url),error=>error instanceof safe.SafeFetchError);
}
const credentialUrl=new URL('https://flow.secure-skill.com/a');
credentialUrl.username='invalid-fixture-user';credentialUrl.password='invalid-fixture-password';
await assert.rejects(provider.validateProviderImageUrl(credentialUrl.href),error=>error.code==='URL_CREDENTIALS_FORBIDDEN');
current={...current,response:{...current.response,providerUrl:'https://unapproved.invalid/a'}};
await assert.rejects(server.resolveGeneratedImageReference({userId:owner,reference}),error=>error.code==='GENERATED_IMAGE_URL_UNSAFE'&&error.status===422);
await assert.rejects(server.resolveGeneratedImageReference({userId:owner,reference},{findOwned:async()=>current,validateUrl:async()=>{throw new safe.SafeFetchError('fixture','DNS_LOOKUP_FAILED',502);}}),error=>error.code==='GENERATED_IMAGE_URL_CHECK_UNAVAILABLE'&&error.status===503);
current={...current,response:{...current.response,sourceExpiredAt:'confirmed'}};
await assert.rejects(server.resolveGeneratedImageReference({userId:owner,reference}),error=>error.code==='GENERATED_IMAGE_NOT_AVAILABLE');
console.log(JSON.stringify({kind:'generated-image-provider-url-policy-zero-network.v1',passed:true,actualModules:['safe-fetch','image-provider-delivery','generated-image-reference'],coverage:['same exact provider HTTPS policy','fake system DNS does not reject approved HTTPS provider','unapproved/fake-IP/private/credentials/port guards preserved','owner and expiry retained','unsafe and transient errors distinguished'],networkCalls:0,databaseCalls:0,providerGenerationCalls:0}));
