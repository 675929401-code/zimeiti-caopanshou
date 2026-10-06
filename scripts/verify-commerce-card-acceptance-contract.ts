import assert from 'node:assert/strict';
import { cardAcceptanceKey, cardContractHash, cardQualityDimensions, currentPassedCardAcceptanceRows, validateCardQualityScorecard } from '../src/commerce/server/card-acceptance';
import { directorRevisionQualityIssues } from '../src/commerce/server/card-canary';
import { directorCanaryQualityIssues, parseDirectorOutput } from '../src/commerce/server/director-output';

const card={id:'11111111-1111-4111-8111-111111111111',card_id:'22222222-2222-4222-8222-222222222222',version:3,display:{name:'测试编导'},material_slots:[{id:'product',mediaTypes:['image'],minCount:1,maxCount:3}],input_fields:[],executor_type:'director',prompt_version_id:'33333333-3333-4333-8333-333333333333',knowledge_document_ids:[],output_contract:{schema:'director-script/v2'},quality_rules:{minimumScore:90},model_policy:{operationId:'director.test'},video_defaults:{durationSeconds:15}};
const hash=cardContractHash(card);assert.match(hash,/^[a-f0-9]{64}$/u);assert.equal(cardContractHash({...card,status:'draft',validation_result:{qualityScore:1},test_cases:[{status:'failed'}]}),hash);
assert.notEqual(cardContractHash({...card,output_contract:{schema:'director-script/v3'}}),hash);
const dimensions=cardQualityDimensions('director');assert.equal(dimensions.length,13);assert.equal(dimensions.includes('revisionPreservation'),false);
const revisionDimensions=cardQualityDimensions('director','revision');assert.equal(revisionDimensions.length,14);assert.equal(revisionDimensions.includes('revisionPreservation'),true);
const passing=validateCardQualityScorecard(card,{scores:Object.fromEntries(dimensions.map((key)=>[key,92])),hardErrors:[],reviewerNote:'逐项核对事实、素材职责、镜头时间轴和转化收尾，未发现硬性合同错误。'});
assert.equal(passing.overallScore,92);assert.equal(Object.keys(passing.scores).length,13);
assert.throws(()=>validateCardQualityScorecard(card,{scores:Object.fromEntries(dimensions.slice(1).map((key)=>[key,95])),hardErrors:[],reviewerNote:'逐项核对事实、素材职责、镜头时间轴和转化收尾，未发现硬性合同错误。'}),/完整包含/u);
assert.throws(()=>validateCardQualityScorecard(card,{scores:Object.fromEntries(dimensions.map((key)=>[key,key==='facts'?79:99])),hardErrors:[],reviewerNote:'逐项核对事实、素材职责、镜头时间轴和转化收尾，未发现硬性合同错误。'}),/每个质量维度/u);
assert.throws(()=>validateCardQualityScorecard(card,{scores:Object.fromEntries(dimensions.map((key)=>[key,95])),hardErrors:['虚构商品价格'],reviewerNote:'逐项核对事实、素材职责、镜头时间轴和转化收尾，发现硬性合同错误。'}),/硬性质量错误/u);
const key=cardAcceptanceKey(card.id,hash);const events=[
  {card_version_id:card.id,card_contract_hash:hash,status:'invalidated' as const,verified_at:'2026-09-15T02:00:00Z'},
  {card_version_id:card.id,card_contract_hash:hash,status:'passed' as const,verified_at:'2026-09-15T01:00:00Z'},
];
assert.equal(cardAcceptanceKey(card.id,hash),key);assert.equal(currentPassedCardAcceptanceRows(events).length,0);
assert.equal(currentPassedCardAcceptanceRows([...events].reverse()).length,1);
const scenarioEvents=[...events,{card_version_id:card.id,card_contract_hash:hash,scenario_kind:'revision' as const,status:'passed' as const,verified_at:'2026-09-15T03:00:00Z'}];
assert.equal(currentPassedCardAcceptanceRows(scenarioEvents).length,1);assert.notEqual(cardAcceptanceKey(card.id,hash,'revision'),key);
const reply=parseDirectorOutput(JSON.stringify({schema:'director-script/v2',replyType:'script',skillKey:'default-director',durationSeconds:5,spokenLanguage:'中文',generateAudio:true,questions:[],script:{title:'测试',creativeDirection:'中性展示',factLedger:[{fact:'白色杯身',source:'user',evidence:'用户明确输入'}],story:'展示杯子',setting:'固定桌面',characters:[],materials:[],productContinuity:['保持白色杯身'],shots:[{id:'镜头1｜展示外观',start:0,end:5,visual:'杯子固定在桌面展示',camera:'固定近景',referenceNumbers:[],speech:'主播：看看白色杯身',ambient:'室内环境声',foley:'',music:''}],conversionClose:'展示结束',preserve:['保持白色杯身'],forbid:['不增加商品事实']}}),{skillKey:'default-director',selections:{},spokenLanguage:'中文',durationSeconds:5,generateAudio:true},[],'director-script/v2');
assert.deepEqual(directorCanaryQualityIssues(reply),[]);
const ambiguous={...reply,script:{...reply.script!,shots:[{...reply.script!.shots[0],visual:'杯盖盖回或搭在杯沿一侧'}]}};
assert.match(directorCanaryQualityIssues(ambiguous).join('；'),/二选一/u);
const ambiguousSetting={...reply,script:{...reply.script!,setting:'浅灰或浅米色背景'}};
assert.match(directorCanaryQualityIssues(ambiguousSetting).join('；'),/全片设定/u);
const negativeEnumeration={...reply,script:{...reply.script!,setting:'固定浅灰背景，不出现价格牌、促销贴纸或认证标识'}};
assert.deepEqual(directorCanaryQualityIssues(negativeEnumeration),[]);
const overlong={...reply,script:{...reply.script!,shots:[{...reply.script!.shots[0],speech:'主播：这是一段明显超过五秒自然口播上限而且没有给动作留出停顿时间的台词'}]}};
assert.match(directorCanaryQualityIssues(overlong).join('；'),/口播/u);
const audioPlaceholders={...reply,script:{...reply.script!,shots:[{...reply.script!.shots[0],speech:'（无台词）',foley:'无'}]}};
assert.match(directorCanaryQualityIssues(audioPlaceholders).join('；'),/台词使用无内容占位词/u);
assert.match(directorCanaryQualityIssues(audioPlaceholders).join('；'),/拟音使用无内容占位词/u);
const explicitSilence={...reply,script:{...reply.script!,shots:[{...reply.script!.shots[0],speech:'',foley:''}]}};
assert.deepEqual(directorCanaryQualityIssues(explicitSilence),[]);
const revised={...reply,script:{...reply.script!,shots:[{...reply.script!.shots[0],speech:'主播：查看商品详情'}]}};
const revisionContext={skillKey:'default-director',selections:{},spokenLanguage:'中文',durationSeconds:5,generateAudio:true};
assert.deepEqual(directorRevisionQualityIssues(JSON.stringify(reply),JSON.stringify(revised),{shotId:'镜头1｜展示外观',field:'speech',replacement:'主播：查看商品详情'},revisionContext),[]);
const drifted={...revised,script:{...revised.script!,setting:'被意外改写的场景'}};
assert.match(directorRevisionQualityIssues(JSON.stringify(reply),JSON.stringify(drifted),{shotId:'镜头1｜展示外观',field:'speech',replacement:'主播：查看商品详情'},revisionContext).join('；'),/目标字段之外/u);
const revisedWithClose={...revised,script:{...revised.script!,conversionClose:'最后口播只说“查看商品详情”'}};
assert.deepEqual(directorRevisionQualityIssues(JSON.stringify(reply),JSON.stringify(revisedWithClose),{shotId:'镜头1｜展示外观',field:'speech',replacement:'主播：查看商品详情'},revisionContext),[]);
const badClose={...revisedWithClose,script:{...revisedWithClose.script!,conversionClose:'最后口播变成另一个未经指定的句子'}};
assert.match(directorRevisionQualityIssues(JSON.stringify(reply),JSON.stringify(badClose),{shotId:'镜头1｜展示外观',field:'speech',replacement:'主播：查看商品详情'},revisionContext).join('；'),/转化摘要/u);
console.log(JSON.stringify({suite:'commerce-card-acceptance-contract',passed:29,networkCalls:0,providerCalls:0,databaseWrites:0}));
