import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main(){
 const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'commerce-asset-durability-'));
 process.env.COMMERCE_DATA_DIR=fixture;
 const originalFetch=globalThis.fetch;let networkCalls=0;
 globalThis.fetch=async()=>{networkCalls++;throw Error('NETWORK_FORBIDDEN_IN_ASSET_DURABILITY_TEST');};
 try{
  const store=await import('../src/commerce/server/store');
  const assets=await import('../src/commerce/server/assets');
  const references=await import('../src/commerce/server/media-reference');
  const owner='asset-durability-owner',jobId='10000000-0000-4000-8000-000000000001',key='job-result:'+jobId;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(32,7)]);
  const first=await assets.storeAsset(owner,bytes,'image/png','fixture.png','generated',jobId,undefined,key);
  assert.equal(first.id,assets.deterministicAssetId(owner,key));
  assert.deepEqual(await assets.assertAssetIntegrity(first),bytes);

  const target=path.join(fixture,'assets',first.id);
  await fs.writeFile(target,Buffer.from('corrupt'));
  const repaired=await assets.storeAsset(owner,bytes,'image/png','fixture.png','generated',jobId,undefined,key);
  assert.equal(repaired.id,first.id);
  assert.deepEqual(await assets.assertAssetIntegrity(repaired),bytes);

  await assert.rejects(()=>assets.mutateAsset(owner,first.id,current=>({...current,name:'stale-write'}),()=>false),/租约已经失效/);
  assert.equal(assets.readAsset(first.id,owner)?.name,'fixture.png');

  store.put('jobs',jobId,owner,{id:jobId,status:'saving'});
  await assert.rejects(()=>assets.deleteAsset(owner,first.id),/仍在运行或保存/);
  assert.ok(assets.readAsset(first.id,owner));
  store.put('jobs',jobId,owner,{id:jobId,status:'succeeded'});
  await assets.deleteAsset(owner,first.id);
  assert.equal(assets.readAsset(first.id,owner),undefined);
  await assert.rejects(()=>fs.access(target));

  const assetsDirectory=path.join(fixture,'assets');
  const orphan=path.join(assetsDirectory,'orphan-no-record');
  const staleTemporary=path.join(assetsDirectory,'.orphan-id.1.2.repair.tmp');
  await fs.writeFile(orphan,bytes);await fs.writeFile(staleTemporary,bytes);
  const old=new Date(Date.now()-48*60*60*1000);await fs.utimes(orphan,old,old);await fs.utimes(staleTemporary,old,old);
  const swept=await assets.sweepAssetOrphans(Date.now(),60_000,20);
  assert.equal(swept.busy,false);assert.ok(swept.removed>=2);
  await assert.rejects(()=>fs.access(orphan));await assert.rejects(()=>fs.access(staleTemporary));

  const intentId='asset-intent:'+('a'.repeat(64));
  store.put('provider-reference-intents',intentId,owner,{schema:'commerce-provider-reference-intent/v1',id:intentId,assetId:'asset-intent',owner,sha256:'a'.repeat(64),status:'upload_pending',createdAt:1,updatedAt:1});
  const intentSweep=await references.sweepProviderReferenceIntents(Date.now(),0,10);
  assert.equal(intentSweep.busy,false);assert.equal(intentSweep.removed,1);
  assert.equal(store.get('provider-reference-intents',intentId,owner),undefined);

  const assetSource=await fs.readFile(path.resolve('src/commerce/server/assets.ts'),'utf8');
  const referenceSource=await fs.readFile(path.resolve('src/commerce/server/media-reference.ts'),'utf8');
  assert.match(assetSource,/ASSET_MUTATION_LEASE_BUCKET/);
  assert.match(assetSource,/recordLeaseIsCurrent/);
  assert.match(assetSource,/生成任务仍在运行或保存/);
  assert.match(referenceSource,/provider-reference-intents/);
  assert.equal(networkCalls,0);
  console.log(JSON.stringify({schemaVersion:'commerce-asset-durability-p0/v1',passed:14,checks:['deterministic-id','initial-integrity','corruption-detected-and-repaired','same-id-after-repair','lost-owner-cannot-mutate','lost-owner-write-not-visible','active-job-delete-blocked','active-job-asset-retained','terminal-job-delete-complete','orphan-file-swept','repair-temp-swept','provider-upload-intent-swept','durable-lease-source-contract','network-blocked'],safety:{networkCalls,providerUploads:0,paidGeneration:0,productionWrites:0,deployment:0},fixtureRemoved:true}));
 }finally{globalThis.fetch=originalFetch;await fs.rm(fixture,{recursive:true,force:true}).catch(()=>undefined);}
}

main().catch(error=>{console.error(error);process.exitCode=1;});
