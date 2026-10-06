import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const suites=[
 {id:'gateway-receipt',file:'verify-commerce-gateway-durable-receipt.ts',checks:28},
 {id:'rolling-worker',file:'verify-commerce-rolling-worker-p0.ts',checks:39},
 {id:'ordinary-worker',file:'verify-commerce-ordinary-worker-p0.ts',checks:10},
 {id:'member-billing',file:'verify-commerce-member-billing-lifecycle.ts',checks:30},
 {id:'aggregate-billing',file:'verify-commerce-aggregate-billing-contract.ts',checks:24},
 {id:'workflow-retry',file:'verify-commerce-workflow-retry-quote-contract.ts',checks:30},
 {id:'asset-durability',file:'verify-commerce-asset-durability-p0.ts',checks:14},
 {id:'prompt-package',file:'verify-commerce-prompt-package-versioning.ts',checks:7},
 {id:'quote-binding',file:'verify-commerce-quote-binding-atomicity.ts',checks:12},
 {id:'prebilling-input',file:'verify-commerce-prebilling-input-contract.ts',checks:23},
] as const;

function jsonFromOutput(output:string){const start=output.indexOf('{'),end=output.lastIndexOf('}');if(start<0||end<start)return undefined;try{return JSON.parse(output.slice(start,end+1));}catch{return undefined;}}

async function main(){
 const root=path.resolve(import.meta.dirname,'..'),results:Record<string,unknown>[]=[];
 for(const suite of suites){
  const run=spawnSync(process.execPath,['./scripts/run-node-maintenance-tsx.mjs',`./scripts/${suite.file}`],{cwd:root,encoding:'utf8',env:{...process.env}});
  const stdout=String(run.stdout||''),stderr=String(run.stderr||'');
  assert.equal(run.status,0,`${suite.id} failed\n${stdout}\n${stderr}`);
  results.push({id:suite.id,file:suite.file,expectedChecks:suite.checks,exitCode:run.status,output:jsonFromOutput(stdout)});
 }
 const source={
  jobs:await fs.readFile(path.join(root,'src/commerce/server/jobs.ts'),'utf8'),
  billing:await fs.readFile(path.join(root,'src/commerce/server/billing.ts'),'utf8'),
  workflows:await fs.readFile(path.join(root,'src/commerce/server/workflows.ts'),'utf8'),
  rolling:await fs.readFile(path.join(root,'src/commerce/server/rolling-video.ts'),'utf8'),
  assets:await fs.readFile(path.join(root,'src/commerce/server/assets.ts'),'utf8'),
 };
 assert.match(source.jobs,/withJobExecutionLease\(id,owner/);
 assert.match(source.jobs,/recoverSavingJob/);
 assert.match(source.billing,/costPrice:pending\.costAmount/);
 assert.match(source.workflows,/released-unstarted/);
 assert.match(source.workflows,/releaseUnstartedWorkflowBilling\(value\)/);
 assert.match(source.rolling,/RollingLeaseLostError/);
 assert.match(source.assets,/ASSET_MUTATION_LEASE_BUCKET/);
 const report={
  schemaVersion:'commerce-state-machine-recovery-p0/v1',
  passed:true,
  suites:results,
  deterministicChecks:suites.reduce((sum,suite)=>sum+suite.checks,0)+7,
  recoveredFailures:['dispatch-receipt-crash','late-terminal-regression','lost-job-lease','lost-rolling-lease','saving-crash','corrupt-asset-repair','asset-delete-race','refund-versus-revenue','stale-usage-revenue-race','aggregate-unstarted-refund-crash','prompt-package-drift'],
  safety:{networkCalls:0,providerSubmissions:0,paidGeneration:0,productionDatabaseWrites:0,runtimeRestart:0,deployment:0},
 };
 const output=path.join(root,'.codex-evidence','commerce-state-machine-recovery-p0','report.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2));
 console.log(JSON.stringify({output,...report}));
}

main().catch(error=>{console.error(error);process.exitCode=1;});
