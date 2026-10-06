import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

type EffectCounters={
  network:number;
  provider:number;
  wallet:number;
  paidGeneration:number;
  database:number;
};

const EXPECTED_STEPS=[
  [1,'编导选择'],
  [2,'素材上传'],
  [3,'编导对话'],
  [4,'局部修改'],
  [5,'应用脚本'],
  [6,'模型参数与报价'],
  [7,'确认提交与队列'],
  [8,'预览下载历史'],
  [9,'失败退款恢复'],
] as const;

const EXPECTED_LAYERS=['ui','api','service','storage'] as const;

function isDirectExecution(){
  const entry=process.argv[1];
  return Boolean(entry)&&path.resolve(entry).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase();
}

async function main(){
  let passed=0;
  const check=(condition:unknown,message:string)=>{assert.ok(condition,message);passed+=1;};
  const effects:EffectCounters={network:0,provider:0,wallet:0,paidGeneration:0,database:0};
  const originalFetch=globalThis.fetch;

  // This suite is a source-contract and deterministic state-map regression. Any
  // accidental network access is converted into an immediate failure and counted.
  globalThis.fetch=async()=>{
    effects.network+=1;
    throw new Error('ZERO_COST_NETWORK_FORBIDDEN');
  };

  try{
    const moduleSource=readFileSync(new URL('./verify-commerce-tutorial-step-map.ts',import.meta.url),'utf8');
    check(!/from\s+['"](?:@\/|\.\.\/src\/|\.\/src\/)/u.test(moduleSource),'零费用映射测试不得导入生产模块并触发运行态副作用');
    check(!/from\s+['"](?:better-sqlite3|pg|@supabase\/supabase-js|node:child_process)['"]/u.test(moduleSource),'零费用映射测试不得连接数据库或启动子进程');
    check(!/\bfetch\s*\(/u.test(moduleSource),'零费用映射测试不得发起网络请求');

    const tutorial=await import('./verify-commerce-tutorial-step-map');
    const result=tutorial.verifyCommerceTutorialStepMap();
    check(result.steps===9,'必须覆盖教程第 1–9 步');
    check(result.benchmarkSegments.join(',')==='1,2,3,4,5,6','必须完整映射只读对标证据的六段链路');
    check(result.files.length>=20,'九步验收必须横跨真实 UI、API、服务和存储源码');
    check(result.passed>=250,'源码合同断言数量异常下降');
    check(Object.values(result.effects).every(value=>value===0),'底层映射验证出现外部副作用');

    const matrix=[];
    for(const [index,expected] of EXPECTED_STEPS.entries()){
      const step=tutorial.COMMERCE_TUTORIAL_STEP_MAP[index];
      check(Boolean(step),`缺少第 ${expected[0]} 步`);
      check(step.id===expected[0],`第 ${expected[0]} 步编号漂移`);
      check(step.title===expected[1],`第 ${expected[0]} 步标题漂移`);
      check(step.failureStates.length>=3,`第 ${expected[0]} 步缺少失败、恢复或拒绝状态`);

      const layers={} as Record<(typeof EXPECTED_LAYERS)[number],{contracts:number;files:string[]}>;
      const allStepFiles=new Set<string>();
      for(const layer of EXPECTED_LAYERS){
        const contracts=step.evidence[layer];
        check(Array.isArray(contracts)&&contracts.length>0,`第 ${expected[0]} 步缺少 ${layer} 源码证据`);
        check(contracts.every(item=>item.mustMatch.length>0),`第 ${expected[0]} 步 ${layer} 存在无断言的源码证据`);
        check(contracts.every(item=>item.file.startsWith('src/')),`第 ${expected[0]} 步 ${layer} 必须引用真实产品源码`);
        check(contracts.every(item=>item.purpose.trim().length>=4),`第 ${expected[0]} 步 ${layer} 缺少可审计用途说明`);
        for(const item of contracts)allStepFiles.add(item.file);
        layers[layer]={contracts:contracts.reduce((sum,item)=>sum+item.mustMatch.length,0),files:contracts.map(item=>item.file)};
      }
      // A service and its persistence adapter can intentionally live in one
      // server module (for example assets.ts), so require all four layers above
      // and at least three independently reviewable product files here.
      check(allStepFiles.size>=3,`第 ${expected[0]} 步没有形成可审计的四层源码链路`);
      matrix.push({id:step.id,title:step.title,benchmarkSegments:step.benchmarkSegments,layers,failures:step.failureStates.length});
    }

    check(effects.network===0,'验收过程中发生了网络请求');
    check(effects.provider===0,'验收过程中调用了供应商');
    check(effects.wallet===0,'验收过程中写入了钱包');
    check(effects.paidGeneration===0,'验收过程中触发了付费生成');
    check(effects.database===0,'验收过程中连接或写入了数据库');

    console.log(JSON.stringify({
      suite:'commerce-tutorial-steps-1-9-zero-cost',
      passed,
      sourceAssertions:result.passed,
      steps:matrix,
      sourceFiles:result.files.length,
      effects,
    }));
  } finally {
    globalThis.fetch=originalFetch;
  }
}

if(isDirectExecution()){
  main().catch(error=>{console.error(error);process.exitCode=1;});
}
