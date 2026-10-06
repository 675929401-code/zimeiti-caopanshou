import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {StorageProviderType} from '../src/storage/object';
import type {Asset} from '../src/commerce/server/assets';
import {
 MAX_MAIN_ASSET_BYTES,createMainAssetBridge,parseMainAssetImportRequest,parseMainAssetListInput,
 publicImportedAsset,type MainAssetBridgeDependencies,type MainAssetImportRecord,type MainAssetSourceRow,
} from '../src/commerce/server/main-asset-bridge';

const mainUserId='main-user-a',owner='commerce-owner-a';
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
const source=(id='source-a',overrides:Partial<MainAssetSourceRow>={}):MainAssetSourceRow=>({
 id,user_id:mainUserId,storage_key:`private/${id}.png`,storage_provider:'tencent_cos',file_name:'商品主图.png',
 file_category:'image',file_size:png.length,content_type:'image/png',created_at:'2026-09-25T00:00:00.000Z',...overrides,
});
const asset=(id:string,bytes=png):Asset=>({
 id,owner,name:'商品主图.png',type:'image/png',size:bytes.length,
 sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:1_700_000_000_000,source:'upload',
});

let networkCalls=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=(async()=>{networkCalls+=1;throw Error('main asset bridge regression must remain zero-network');}) as typeof fetch;

async function main(){
 assert.deepEqual(parseMainAssetImportRequest({id:'source-a'}),{id:'source-a'});
 for(const body of [
  {id:'source-a',url:'https://attacker.invalid/a.png'},
  {id:'source-a',storage_key:'other-user/private.png'},
  {id:'source-a',userId:'victim'},
 ])assert.throws(()=>parseMainAssetImportRequest(body),/只接受素材 ID/u);
 assert.throws(()=>parseMainAssetImportRequest({id:'../secret'}),/素材 ID 无效/u);
 assert.deepEqual(parseMainAssetListInput(new URLSearchParams('kinds=image,video&q=商品&offset=30&limit=20')),{kinds:['image','video'],query:'商品',offset:30,limit:20});

 const imports=new Map<string,MainAssetImportRecord>(),commerceAssets=new Map<string,Asset>();
 let sourceLookups=0,reads=0,stores=0,discards=0,savedRecord:MainAssetImportRecord|undefined;
 const dependencies:MainAssetBridgeDependencies={
  async listOwnedSources(){return {rows:[source(),source('wrong-owner',{user_id:'another-user'}),source('pdf',{file_category:'document',content_type:'application/pdf'}),source('huge',{file_size:MAX_MAIN_ASSET_BYTES+1})],total:1};},
  async findOwnedSource(requestedUser,id){sourceLookups+=1;assert.equal(requestedUser,mainUserId);return source(id);},
  async readBounded(key,maxBytes,timeoutMs,provider){reads+=1;assert.match(key,/^private\/source-/u);assert.equal(maxBytes,MAX_MAIN_ASSET_BYTES);assert.equal(timeoutMs,120_000);assert.equal(provider,'tencent_cos');return png;},
  findImport(_owner,_main,id){return imports.get(id);},
  findCommerceAsset(_owner,id){return commerceAssets.get(id);},
  async storeCommerceAsset(requestedOwner,bytes,type,name){stores+=1;assert.equal(requestedOwner,owner);assert.equal(bytes,png);assert.equal(type,'image/png');assert.equal(name,'商品主图.png');await Promise.resolve();const value=asset(`commerce-${stores}`,bytes);commerceAssets.set(value.id,value);return value;},
  saveImport(_owner,_main,id,value){savedRecord=value;imports.set(id,value);},
  async discardCommerceAsset(_owner,id){discards+=1;commerceAssets.delete(id);},
  now:()=>1_800_000_000_000,
 };
 const bridge=createMainAssetBridge(dependencies);
 const listed=await bridge.list(mainUserId,{kinds:['image'],query:'',offset:0,limit:30});
 assert.equal(listed.assets.length,1);
 assert.deepEqual(Object.keys(listed.assets[0]).sort(),['createdAt','id','name','size','source','type','url']);
 assert.equal(listed.assets[0].url,'/api/storage/files/source-a/content');
 for(const secret of ['user_id','storage_key','storage_provider','meta','is_public'])assert.equal(JSON.stringify(listed).includes(secret),false,`列表不得泄露 ${secret}`);

 const first=await bridge.importOne(owner,mainUserId,'source-a');
 const replay=await bridge.importOne(owner,mainUserId,'source-a');
 assert.equal(replay.id,first.id);
 assert.equal(sourceLookups,2,'幂等回放仍须重新执行 id + user_id 归属查询');
 assert.equal(reads,1);assert.equal(stores,1);
 assert.equal(savedRecord?.mainSourceId,'source-a');
 assert.equal(savedRecord?.mainUserId,mainUserId);
 assert.equal(savedRecord?.sha256,first.sha256);
 const publicAsset=publicImportedAsset(first);
 assert.deepEqual(Object.keys(publicAsset).sort(),['createdAt','id','name','size','source','type','url']);
 for(const secret of ['owner','sha256','mainSourceId','mainUserId','storage_key','storage_provider','providerReferenceKey'])assert.equal(JSON.stringify(publicAsset).includes(secret),false,`导入响应不得泄露 ${secret}`);

 const concurrent=await Promise.all([bridge.importOne(owner,mainUserId,'source-b'),bridge.importOne(owner,mainUserId,'source-b')]);
 assert.equal(concurrent[0].id,concurrent[1].id);
 assert.equal(stores,2,'同一来源并发导入只能产生一个 Commerce 资产');

 let unauthorizedReads=0;
 const unauthorized=createMainAssetBridge({...dependencies,async findOwnedSource(_user,id){return source(id,{user_id:'victim'});},async readBounded(){unauthorizedReads+=1;return png;}});
 await assert.rejects(()=>unauthorized.importOne(owner,mainUserId,'source-c'),/不存在或无权访问/u);
 assert.equal(unauthorizedReads,0);

 let rejectedReads=0;
 const oversized=createMainAssetBridge({...dependencies,async findOwnedSource(_user,id){return source(id,{file_size:MAX_MAIN_ASSET_BYTES+1});},async readBounded(){rejectedReads+=1;return png;}});
 await assert.rejects(()=>oversized.importOne(owner,mainUserId,'source-d'),/150 MB/u);
 const nonMedia=createMainAssetBridge({...dependencies,async findOwnedSource(_user,id){return source(id,{file_category:'document',content_type:'application/pdf'});},async readBounded(){rejectedReads+=1;return png;}});
 await assert.rejects(()=>nonMedia.importOne(owner,mainUserId,'source-e'),/图片、视频或音频/u);
 assert.equal(rejectedReads,0);

 let cleanupCalls=0;
 const atomicFailure=createMainAssetBridge({...dependencies,findImport:()=>undefined,saveImport(){throw Error('mapping write failed');},async discardCommerceAsset(){cleanupCalls+=1;}});
 await assert.rejects(()=>atomicFailure.importOne(owner,mainUserId,'source-f'),/mapping write failed/u);
 assert.equal(cleanupCalls,1,'来源映射写入失败必须回收刚创建的 Commerce 资产');

 const bridgeSource=readFileSync(new URL('../src/commerce/server/main-asset-bridge.ts',import.meta.url),'utf8');
 const routeSource=readFileSync(new URL('../src/app/api/commerce/main-assets/route.ts',import.meta.url),'utf8');
 const contentRouteSource=readFileSync(new URL('../src/app/api/storage/files/[id]/content/route.ts',import.meta.url),'utf8');
 const pickerSource=readFileSync(new URL('../src/commerce/components/commerce-agent/asset-picker.tsx',import.meta.url),'utf8');
 assert.match(bridgeSource,/\.eq\('id',id\)\.eq\('user_id',mainUserId\)/u,'生产查询必须同时约束 id 与 user_id');
 assert.match(bridgeSource,/storageManager\.readBounded/u);
 assert.match(bridgeSource,/storeAsset\(owner,bytes,type,name\)/u);
 assert.match(routeSource,/sameOrigin\(request\)[\s\S]*authorizeCurrentCommerceIdentity/u);
 assert.match(routeSource,/parseMainAssetImportRequest/u);
 assert.doesNotMatch(routeSource,/body\.(?:url|storage_key|userId)/u);
 assert.match(contentRouteSource,/lookupQuery = lookupQuery\.eq\("user_id", user\.userId\)/u,'同源内容 URL 必须再次按主站用户验权');
 assert.match(contentRouteSource,/"Cache-Control": "private, no-store"/u);
 assert.match(pickerSource,/>主站资产</u);
 assert.match(pickerSource,/\/api\/commerce\/main-assets/u);
 assert.match(pickerSource,/selectedAsset\.source==='main'[\s\S]*\.asset/u,'主站素材必须先导入为 Commerce 资产再回传');
 assert.equal(networkCalls,0);
 console.log(JSON.stringify({
  passed:36,networkCalls,databaseReads:0,databaseWrites:0,providerCalls:0,paidCalls:0,
  checks:['exact-id-only-request','id-and-user-double-ownership','current-account-route-guard','media-only','150mb-limit','bounded-server-key-read','magic-sha-store-wiring','idempotent-replay','concurrent-idempotency','atomic-mapping-cleanup','safe-list-response','safe-import-response','picker-import-before-select'],
 }));
}

main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{globalThis.fetch=originalFetch;});
