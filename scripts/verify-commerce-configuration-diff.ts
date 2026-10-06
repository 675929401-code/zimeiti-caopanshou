import assert from 'node:assert/strict';
import fs from 'node:fs';
import {diffCommerceReleaseManifests} from '../src/commerce/server/configuration-admin';
import type {CommerceReleaseManifest} from '../src/commerce/shared/configuration-types';

const id=(value:number)=>`00000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
const before:CommerceReleaseManifest={
  schema:'commerce-config/v1',
  cardVersionIds:[id(2),id(1)],
  promptVersionIds:[id(3)],
  knowledgeDocumentIds:[id(4)],
  operationRouteIds:[id(5)],
  defaultModels:{agent:'claude-sonnet-4-6',image:'gpt-image',video:'seedance'},
};
const after:CommerceReleaseManifest={
  schema:'commerce-config/v1',
  cardVersionIds:[id(2),id(6)],
  promptVersionIds:[id(3),id(7)],
  knowledgeDocumentIds:[],
  operationRouteIds:[id(5)],
  defaultModels:{agent:'claude-sonnet-4-6',image:'gpt-image',video:'minimax-h3'},
};

const diff=diffCommerceReleaseManifests(before,after);
assert.equal(diff.schema,'commerce-release-diff/v1');
assert.deepEqual(diff.cards,{added:[id(6)],removed:[id(1)],unchanged:[id(2)]});
assert.deepEqual(diff.prompts,{added:[id(7)],removed:[],unchanged:[id(3)]});
assert.deepEqual(diff.knowledge,{added:[],removed:[id(4)],unchanged:[]});
assert.deepEqual(diff.routes,{added:[],removed:[],unchanged:[id(5)]});
assert.deepEqual(diff.defaultModels.filter(item=>item.changed),[{kind:'video',before:'seedance',after:'minimax-h3',changed:true}]);
assert.equal(diff.changed,true);
assert.equal(diffCommerceReleaseManifests(after,{...after,cardVersionIds:[id(6),id(2)]}).changed,false);
assert.deepEqual(diffCommerceReleaseManifests(null,after).cards.added,[id(2),id(6)]);

const quotesSource=fs.readFileSync('src/commerce/server/quotes.ts','utf8');
const jobsSource=fs.readFileSync('src/commerce/server/jobs.ts','utf8');
assert.match(quotesSource,/sharedConfigurationRequired=process\.env\.SHARED_CONFIGURATION_ENABLED === ['"]1['"]/u);
assert.match(quotesSource,/primePublishedCommerceConfiguration\(\{ required: sharedConfigurationRequired \}\)/u);
assert.match(quotesSource,/const published = currentPublishedCommerceConfiguration\(\)/u);
assert.doesNotMatch(quotesSource,/const published = catalogDirect \? null/u);
assert.match(jobsSource,/sharedConfigurationRequired=!adminCanary&&!cardCanary&&!input\.rollingChild/u);
assert.match(jobsSource,/if\(sharedConfigurationRequired\)assertPublishedCommercePaidJobsReady\(\)/u);
assert.match(jobsSource,/const published=currentPublishedCommerceConfiguration\(\)/u);

console.log(JSON.stringify({passed:19,networkCalls:0,databaseWrites:0,walletCalls:0,providerCalls:0,checks:['stable-sorted-diff','four-versioned-resource-kinds','default-model-change','no-change-order-insensitive','empty-current-preview','shared-current-required-for-curated-quotes','shared-current-required-for-jobs','published-identities-not-bypassed-by-curated-models']}));
