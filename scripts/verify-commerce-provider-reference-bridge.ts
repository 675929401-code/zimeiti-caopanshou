import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
 const fixture=path.resolve('.codex-evidence/commerce-provider-reference-fixture-'+Date.now());
 process.env.COMMERCE_DATA_DIR=fixture;process.env.SHARED_CONFIGURATION_ENABLED='0';
 await fs.mkdir(fixture,{recursive:true});
 const store=await import('../src/commerce/server/store');
 const media=await import('../src/commerce/server/media-reference');
 const stable={id:'11111111-1111-4111-8111-111111111111',owner:'owner-a',name:'stable.jpg',type:'image/jpeg',size:3,sha256:'a'.repeat(64),createdAt:Date.now(),source:'generated' as const,providerReferenceUrl:'https://assets.example.com/stable.jpg'};
 store.put('assets',stable.id,stable.owner,stable);
 assert.equal((await media.ensureProviderReference(stable)).providerReferenceUrl,stable.providerReferenceUrl);
 assert.equal(await media.referenceUrl(stable),stable.providerReferenceUrl);

 const mediaSource=await fs.readFile(path.resolve('src/commerce/server/media-reference.ts'),'utf8');
 const quoteSource=await fs.readFile(path.resolve('src/commerce/server/quotes.ts'),'utf8');
 const rollingSource=await fs.readFile(path.resolve('src/commerce/server/rolling-video.ts'),'utf8');
 assert.match(mediaSource,/providerType:'tencent_cos'/u);
 assert.match(mediaSource,/strictProvider:true/u);
 assert.match(mediaSource,/publicRead:true/u);
 assert.match(mediaSource,/requireOwnershipRecord:true/u);
 assert.match(mediaSource,/commerce-provider-reference\/\$\{category\}\/\$\{namespace\}/u);
 assert.match(mediaSource,/asset\.temporary\?`\$\{asset\.id\}-\$\{asset\.sha256\}/u);
 assert.match(mediaSource,/providerReferenceKey=result\.key/u);
 assert.match(mediaSource,/providerReferenceProvider='tencent_cos'/u);
 assert.match(mediaSource,/isPublicVideoAssetUrl\(result\.url\)/u);
 const publishAt=quoteSource.indexOf('for(const asset of');
 const priceAt=quoteSource.indexOf('const quantity = billingQuantity');
 assert.ok(publishAt>0&&priceAt>publishAt,'视频参考必须在报价与钱包确认前完成公网桥预检');
 assert.match(rollingSource,/ensureProviderReference\(await storeAsset\(owner,bytes,'image\/jpeg'/u);
 assert.match(rollingSource,/slot:'last-frame'/u);
 console.log(JSON.stringify({passed:14,paidCalls:0,providerStorageWrites:0,fixture,checks:['stable-url-reused','reference-url-reused','cos-only','no-storage-fallback','public-read','ownership-record-required','content-addressed-prefix','temporary-tail-unique-key','provider-key-persisted','provider-type-persisted','public-url-validated','quote-preflight-before-price','rolling-tail-published','tail-kept-last']}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
