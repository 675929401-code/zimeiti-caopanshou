import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {toPublicModelId} from '../src/lib/public-model-dto';
import {
  assertCuratedMainCatalogExecutionReady,
  classifyCommerceCuratedModel,
  commerceCuratedProfilesForModels,
  curatedMainCatalogExecutionReadiness,
  curatedModelPriority,
  isCuratedConfigurationSelectable,
  usesCuratedMainCatalogDirectExecution,
} from '../src/commerce/server/commerce-curated-model-profiles';
import {modelMatchesIdentifier,type Kind,type Model} from '../src/commerce/server/models';

const fixture=(kind:Kind,id:string,displayName:string,modelName?:string,provider?:string):Model=>({
  id,internalModelId:id,displayName,modelName,provider,kind,source:'main',publicPrice:1,costPrice:0.5,
  billingUnit:'per_use',configHash:'a'.repeat(64),capabilities:{available:true,executionSupported:true,credentialsConfigured:true,endpointConfigured:true,protocolConfigured:true},
});

async function source(file:string){return fs.readFile(path.resolve(file),'utf8');}

async function main(){
  let passed=0;
  const check=(name:string,work:()=>void)=>{work();passed+=1;console.log(`PASS ${name}`);};
  const claude=fixture('agent','3a998bfc-aab4-4f8f-9128-b27498894a7b','Claude Sonnet 4.6','claude-sonnet-4-6');
  const sol=fixture('agent','9b177ccc-4afc-4d49-96bb-fdd01f09bf89','GPT-5.6-Sol','gpt-5.6-sol');
  const seedream=fixture('image','cover-model-seedream-5-pro','豆包 Seedream 5.0 Pro','doubao-seedream-5-0-pro-260628','volcengine');
  const gpt2=fixture('image','gpt-image-2-chA-1','GPT Image 2','gpt-image-2','openai_compat');
  const sunburst=fixture('image','gpt-image-25-sunburst-chA','GPT Image 2.5 Sunburst','gpt-image-2.5-sunburst','openai_compat');
  const flare=fixture('image','gpt-image-25-flare-chA','GPT Image 2.5 Flare','gpt-image-2.5-flare','openai_compat');
  const banana=fixture('image','gemini-3-1-flash-image-chA','Nano Banana 2','gemini-3.1-flash-image','secure_skill_chat');

  check('只识别标准 Claude 与 GPT-5.6-Sol 稳定身份',()=>{
    assert.equal(classifyCommerceCuratedModel(claude),'agent-claude-sonnet-4-6');
    assert.equal(classifyCommerceCuratedModel(sol),'agent-gpt-5-6-sol');
    assert.equal(classifyCommerceCuratedModel(fixture('agent','different-max-channel','Claude Max','claude-sonnet-4-6')),null);
    assert.equal(classifyCommerceCuratedModel(fixture('agent','different-story-channel','Sol 长输出','gpt-5.6-sol')),null);
  });
  check('生图白名单绑定当前稳定内部身份',()=>{
    assert.deepEqual([seedream,gpt2,sunburst,banana].map(classifyCommerceCuratedModel),[
      'image-seedream-5-pro','image-gpt-image-2','image-gpt-image-2-5','image-nano-banana-2',
    ]);
  });
  check('同族 Flare 只作内部候补且不可由用户选择',()=>{
    assert.equal(classifyCommerceCuratedModel(flare),'image-gpt-image-2-5-flare-fallback');
    assert.equal(isCuratedConfigurationSelectable('image',flare.id),false);
  });
  check('Gemini 旗舰严格要求官方 gemini-3-pro-image 身份',()=>{
    assert.equal(classifyCommerceCuratedModel(fixture('image','legacy-gemini','Gemini 3.0','gemini-3.0-pro-image','lconai')),null);
    assert.equal(classifyCommerceCuratedModel(fixture('image','legacy-banana-pro','Nano Banana Pro','nano-banana-pro','lconai')),null);
    assert.equal(classifyCommerceCuratedModel(fixture('image','future-official','Gemini 3 Pro','gemini-3-pro-image','lconai')),'image-gemini-3-pro-flagship');
    assert.equal(isCuratedConfigurationSelectable('image','future-official'),false);
  });
  check('公开模型 ID 由稳定内部 ID 动态派生而非硬编码',()=>{
    const publicClaude=toPublicModelId('llm',claude.id),publicSunburst=toPublicModelId('cover',sunburst.id);
    assert.equal(isCuratedConfigurationSelectable('agent',publicClaude),true);
    assert.equal(isCuratedConfigurationSelectable('image',publicSunburst),true);
    assert.equal(modelMatchesIdentifier({...claude,id:publicClaude},claude.id),true);
    assert.equal(modelMatchesIdentifier({...sunburst,id:publicSunburst},sunburst.id),true);
  });
  check('稳定 ID 若被重绑到错误 modelName 会被拒绝',()=>{
    assert.equal(classifyCommerceCuratedModel({...sunburst,modelName:'gpt-image-2.5-flare'}),null);
    assert.equal(classifyCommerceCuratedModel({...claude,modelName:'claude-sonnet-4-6-max'}),null);
  });
  check('用户只看到一个 GPT Image 2.5 产品项并看到 Gemini 待接入画像',()=>{
    const profiles=commerceCuratedProfilesForModels('image',[seedream,gpt2,sunburst,flare,banana]);
    assert.equal(profiles.find(item=>item.id==='image-gpt-image-2-5')?.userVisible,true);
    assert.equal(profiles.find(item=>item.id==='image-gpt-image-2-5-flare-fallback')?.userVisible,false);
    assert.equal(profiles.find(item=>item.id==='image-gemini-3-pro-flagship')?.status,'pending');
    assert.equal(profiles.find(item=>item.id==='image-gemini-3-pro-flagship')?.boundModelId,null);
    assert.doesNotMatch(profiles.filter(item=>item.userVisible).map(item=>item.statusMessage).join('\n'),/canary|验收/u);
  });
  check('默认优先级固定为 Claude；生图按是否有参考图固定排序',()=>{
    assert.ok(curatedModelPriority('agent-claude-sonnet-4-6')>curatedModelPriority('agent-gpt-5-6-sol'));
    assert.ok(curatedModelPriority('image-seedream-5-pro',0)>curatedModelPriority('image-gpt-image-2-5',0));
    assert.ok(curatedModelPriority('image-gpt-image-2-5',1)>curatedModelPriority('image-gpt-image-2',1));
    assert.ok(curatedModelPriority('image-gpt-image-2',1)>curatedModelPriority('image-nano-banana-2',1));
  });
  check('已启用主站白名单对话与生图模型无需额外 Commerce acceptance',()=>{
    for(const model of [claude,sol,seedream,gpt2,sunburst,banana]){
      assert.equal(curatedMainCatalogExecutionReadiness(model).ready,true);
      assert.doesNotThrow(()=>assertCuratedMainCatalogExecutionReady(model));
    }
    assert.equal(usesCuratedMainCatalogDirectExecution('agent'),true);
    assert.equal(usesCuratedMainCatalogDirectExecution('image'),true);
    assert.equal(usesCuratedMainCatalogDirectExecution('video'),false);
  });
  check('缺凭据、接口、协议或配置哈希时目录直通保持关闭',()=>{
    assert.equal(curatedMainCatalogExecutionReadiness({...claude,capabilities:{...claude.capabilities,credentialsConfigured:false}}).ready,false);
    assert.equal(curatedMainCatalogExecutionReadiness({...claude,capabilities:{...claude.capabilities,endpointConfigured:false}}).ready,false);
    assert.equal(curatedMainCatalogExecutionReadiness({...claude,capabilities:{...claude.capabilities,protocolConfigured:false}}).ready,false);
    assert.equal(curatedMainCatalogExecutionReadiness({...claude,configHash:''}).ready,false);
    assert.equal(curatedMainCatalogExecutionReadiness(flare).ready,false);
  });
  check('未精确绑定的视频模型不会进入 curated 目录直通',()=>{
    const seedance=fixture('video','seedance-pending','Seedance 2.5','doubao-seedance-2-5','secure_video');
    const h3=fixture('video','h3-ref2va-pending','MiniMax H3 Ref2VA','minimax-h3-ref2va','autodl');
    assert.equal(curatedMainCatalogExecutionReadiness(seedance).ready,false);
    assert.equal(curatedMainCatalogExecutionReadiness(h3).ready,false);
  });

  const [api,routing,quotes,jobs,gateway,configuration,workflows,agentPlans,detailSets,profilesSource]=await Promise.all([
    source('src/app/api/commerce/models/route.ts'),source('src/commerce/server/operation-routing.ts'),
    source('src/commerce/server/quotes.ts'),source('src/commerce/server/jobs.ts'),
    source('src/app/api/commerce-model-gateway/route.ts'),source('src/commerce/server/configuration-platform.ts'),
    source('src/commerce/server/workflows.ts'),source('src/commerce/server/agent-plans.ts'),
    source('src/commerce/server/detail-sets.ts'),source('src/commerce/server/commerce-curated-model-profiles.ts'),
  ]);
  check('API 保持目录选择与付费生成准入分离',()=>{
    assert.match(api,/selectionAvailable/u);assert.match(api,/configurationSelectable/u);assert.match(api,/generationReady/u);
    assert.match(api,/commerceCuratedProfilesForModels/u);assert.match(api,/internalModelId:________/u);
    assert.match(api,/curatedMainCatalogExecutionReadiness/u);
    assert.match(api,/configurationReady:usesCuratedMainCatalogDirectExecution/u);
    assert.match(api,/usesCuratedMainCatalogDirectExecution\(kind\)\?policy\?\.userSelectable!==false/u);
    assert.match(api,/:curatedCandidates;/u);
  });
  check('路由与报价拒绝白名单外模型并绑定公开模型快照',()=>{
    const jobCreate=jobs.slice(jobs.indexOf('export async function createJob'));
    assert.match(routing,/所选模型不在带货 Agent 已审核白名单/u);
    assert.match(routing,/sameCuratedModelProfile/u);
    assert.match(quotes,/所选模型未通过带货 Agent 白名单身份核对/u);
    assert.match(quotes,/model: \{ id: quote\.modelId/u);
    assert.match(quotes,/model\.id !== quote\.modelId/u);
    assert.match(quotes,/required: !catalogDirect && process\.env\.SHARED_CONFIGURATION_ENABLED/u);
    assert.match(quotes,/if \(published && !catalogDirect\) await requireCommerceModelAcceptance/u);
    assert.match(quotes,/const published = catalogDirect \? null : currentPublishedCommerceConfiguration\(\)/u);
    assert.match(jobs,/classifyCommerceCuratedModel/u);
    assert.match(jobs,/required:!adminCanary&&!catalogDirect&&process\.env\.SHARED_CONFIGURATION_ENABLED/u);
    assert.match(jobs,/if\(catalogDirect\)assertCuratedMainCatalogExecutionReady\(model\)/u);
    assert.match(jobs,/const published=catalogDirect\?null:currentPublishedCommerceConfiguration\(\)/u);
    assert.ok(quotes.indexOf('if(catalogDirect)assertCuratedMainCatalogExecutionReady(model)')<quotes.indexOf("put('commerce-quotes'"));
    assert.ok(jobCreate.indexOf('if(catalogDirect)assertCuratedMainCatalogExecutionReady(model)')<jobCreate.indexOf('return transaction(()=>'));
    assert.doesNotMatch(quotes,/if \(published && catalogDirect\) await requireCommerceModelAcceptance/u);
  });
  check('详情、计划与画布重试保持目录直通，视频仍保留发布门禁',()=>{
    assert.match(detailSets,/assertCuratedMainCatalogExecutionReady\(model\)/u);
    assert.doesNotMatch(detailSets,/profitAmount:[^\r\n]*\.\.\.\(published\?/u);
    assert.match(agentPlans,/const needsPublishedVideo=value\.selected\.some/u);
    assert.match(agentPlans,/published=needsPublishedVideo\?currentPublishedCommerceConfiguration\(\):undefined/u);
    assert.match(workflows,/const needsPublishedVideo=failed\.some/u);
    assert.match(workflows,/if\(catalogDirect\)assertCuratedMainCatalogExecutionReady\(model\)/u);
    assert.match(workflows,/if\(published&&!catalogDirect\)await requireCommerceModelAcceptance/u);
    assert.doesNotMatch(profilesSource,/pendingMessage:'[^']*(?:canary|验收)/u);
  });
  check('内部网关提供精确身份且公开模型 API 剥离内部字段',()=>{
    assert.match(gateway,/internalModelId:String\(config\?\.id\|\|''\)/u);
    assert.match(gateway,/modelName:String\(config\?\.model_name\|\|''\)/u);
    assert.match(gateway,/credentialsConfigured/u);
    assert.match(gateway,/endpointConfigured/u);
    assert.match(gateway,/protocolConfigured/u);
    assert.match(configuration,/isCuratedConfigurationSelectable/u);
  });
  console.log(JSON.stringify({passed,networkCalls:0,paidCalls:0,databaseWrites:0}));
}

main().catch(error=>{console.error(error);process.exitCode=1;});
