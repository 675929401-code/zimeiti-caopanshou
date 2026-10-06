import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IMAGE_SKILLS} from '../src/commerce/components/commerce-agent/catalog';
import {baselineDirectorCatalog} from '../src/commerce/server/director-catalog';
import {baselinePromptTemplates} from '../src/commerce/server/prompts';
import {commercePromptPackageCatalogCoverage,resolveCommercePromptPackageIdentity,sameCommercePromptPackageIdentity} from '../src/commerce/server/prompt-package-identity';

const prompts=baselinePromptTemplates();
const results:{name:string;passed:boolean}[]=[];
const check=(name:string,run:()=>void)=>{run();results.push({name,passed:true});};

check('all 16 image packages freeze observed and independent identities',()=>{
 assert.equal(IMAGE_SKILLS.length,16);
 const packages=IMAGE_SKILLS.map(skill=>{
  const prompt=prompts.find(item=>item.id===skill.id);
  assert.ok(prompt,`missing prompt ${skill.id}`);
  return resolveCommercePromptPackageIdentity({kind:'image',skillId:skill.id},{prompt,authority:'curated-main-catalog'});
 });
 assert.equal(new Set(packages.map(item=>item.localSkillId)).size,16);
 assert.equal(new Set(packages.map(item=>item.benchmarkReference?.configVersion)).size,16);
 assert.equal(new Set(packages.map(item=>item.benchmarkReference?.versionId)).size,16);
 assert.ok(packages.every(item=>item.skillKind==='image-skill'&&item.benchmarkReference?.contractOnly===true&&/^[a-f0-9]{64}$/u.test(item.packageSha256)));
});

check('all 19 director packages freeze observed and independent identities',()=>{
 const cards=baselineDirectorCatalog();
 assert.equal(cards.length,19);
 const packages=cards.map(card=>{
  const prompt=prompts.find(item=>item.id===`director.${card.key}`);
  assert.ok(prompt,`missing prompt ${card.key}`);
  return resolveCommercePromptPackageIdentity({kind:'agent',purpose:'director',director:card.key},{prompt,authority:'curated-main-catalog'});
 });
 assert.equal(new Set(packages.map(item=>item.localSkillId)).size,19);
 assert.equal(new Set(packages.map(item=>item.benchmarkReference?.configVersion)).size,19);
 assert.ok(packages.every(item=>item.skillKind==='director-skill'&&item.benchmarkReference?.contractOnly===true&&/^[a-f0-9]{64}$/u.test(item.packageSha256)));
});

check('catalog coverage is exact',()=>{
 assert.deepEqual(commercePromptPackageCatalogCoverage(),{image:{local:16,benchmark:16,identified:16},director:{local:19,benchmark:19,identified:19}});
});

check('prompt mutation invalidates package identity',()=>{
 const prompt=prompts.find(item=>item.id==='change-face')!;
 const before=resolveCommercePromptPackageIdentity({kind:'image',skillId:'change-face'},{prompt,authority:'curated-main-catalog'});
 const after=resolveCommercePromptPackageIdentity({kind:'image',skillId:'change-face'},{prompt:{...prompt,content:prompt.content+' changed'},authority:'curated-main-catalog'});
 assert.notEqual(before.promptContentSha256,after.promptContentSha256);
 assert.notEqual(before.packageSha256,after.packageSha256);
 assert.equal(sameCommercePromptPackageIdentity(before,after),false);
});

check('tampered snapshot fails self-verification',()=>{
 const prompt=prompts.find(item=>item.id==='director.ecommerce-spoken-selling')!;
 const value=resolveCommercePromptPackageIdentity({kind:'agent',purpose:'director',director:'ecommerce-spoken-selling'},{prompt,authority:'curated-main-catalog'});
 assert.equal(sameCommercePromptPackageIdentity(value,value),true);
 assert.equal(sameCommercePromptPackageIdentity(value,{...value,promptVersion:value.promptVersion+1}),false);
});

check('shared authority cannot revive legacy saved prompt overlay',()=>{
 const source=readFileSync(new URL('../src/commerce/server/prompts.ts',import.meta.url),'utf8');
 assert.match(source,/if\(sharedConfigurationEnabled\(\)\)return baselinePromptTemplates\(\);const saved=/u);
 assert.match(source,/currentPublishedCommerceConfiguration\(\)\|\|sharedConfigurationEnabled\(\)/u);
});

check('quote job and public readback carry exact package snapshot',()=>{
 const quotes=readFileSync(new URL('../src/commerce/server/quotes.ts',import.meta.url),'utf8');
 const jobs=readFileSync(new URL('../src/commerce/server/jobs.ts',import.meta.url),'utf8');
 assert.match(quotes,/promptPackage=resolveCommercePromptPackageIdentity/u);
 assert.match(quotes,/quotedPromptPackage:quote\.promptPackage/u);
 assert.match(quotes,/promptPackage: quote\.promptPackage/u);
 assert.match(jobs,/quotedPromptPackage\?:CommercePromptPackageIdentity/u);
 assert.match(jobs,/promptPackage:configurationSnapshot\.promptPackage/u);
 assert.match(jobs,/sameCommercePromptPackageIdentity\(internalContext\.quotedPromptPackage,promptPackage\)/u);
});

console.log(JSON.stringify({schemaVersion:'commerce-prompt-package-versioning-test/v1',passed:results.length,total:results.length,checks:results,effects:{databaseWrites:0,networkCalls:0,providerCalls:0,paidGeneration:0,deployment:0}},null,2));
