import assert from 'node:assert/strict';
import {commerceV2DirectorDefinition, publicCommerceV2DirectorCatalog} from '../src/commerce-v2/server/director-registry';

async function verify() {
  // Use the same in-process published snapshot the configuration loader would expose.
  const card = (key:string, promptId:string) => ({
    stableKey:key, executorType:'director', status:'published', promptVersionId:promptId,
    display:{name:key,description:'测试',category:'电商带货',recommended:false,icon:'',sortOrder:1},
    materialSlots:[],inputFields:[],
  });
  const prompt = (key:string, id:string) => ({id,promptKey:'director.'+key,version:1,name:key,content:'仅服务端可见 '+id});
  const route = (key:string) => ({operationId:'director.'+key,label:key,modelKind:'agent',version:1,primaryModelId:'fixture'});
  const session = (globalThis as unknown as {commerceConfigurationCache:{value:unknown;checkedAt:number;error?:string}}).commerceConfigurationCache;
  session.value = {cards:[card('alpha','a1')],prompts:[prompt('alpha','a1')],routes:[route('alpha')]};
  session.checkedAt=Date.now();
  const [alpha]=await publicCommerceV2DirectorCatalog();
  assert.equal(alpha.key,'alpha');
  assert.equal('prompt' in alpha,false);
  assert.equal(alpha.configurationIssue,'');
  session.value = {cards:[card('beta','b1'),card('alpha','a2'),card('orphan','missing')],prompts:[prompt('alpha','a1'),prompt('alpha','a2'),prompt('beta','b1')],routes:[route('alpha'),route('beta')]};
  const updated=await publicCommerceV2DirectorCatalog();
  assert.deepEqual(updated.map(row=>row.key),['beta','alpha','orphan']);
  assert.notEqual(updated[1].promptVersion,alpha.promptVersion);
  assert.ok(updated[2].configurationIssue);
  await assert.rejects(commerceV2DirectorDefinition('alpha',alpha.registryVersion,alpha.promptVersion));
  await assert.rejects(commerceV2DirectorDefinition('orphan',updated[2].registryVersion,updated[2].promptVersion));
  const current=await commerceV2DirectorDefinition('alpha',updated[1].registryVersion,updated[1].promptVersion);
  assert.equal(current.prompt,'仅服务端可见 a2');
  session.value={cards:[],routes:[],prompts:[]};
  assert.deepEqual(await publicCommerceV2DirectorCatalog(),[]);
  console.log('Published registry passed: add, reorder, exact prompt binding, stale draft, isolated invalid card, empty directory and private prompt redaction.');
}
verify().catch(e=>{console.error(e);process.exitCode=1;});
