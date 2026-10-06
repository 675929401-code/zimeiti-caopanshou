import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {convertDiscoveryCanvas} from '../src/commerce/shared/discovery-canvas-import';
import {certifyMaterializedCanvas} from '../src/commerce/server/discovery-canvas-certification';
import type {DiscoveryCatalog,DiscoveryItem} from '../src/commerce/shared/discovery-catalog-types';
import type {DiscoveryOwnedAssetMap} from '../src/commerce/shared/discovery-canvas-import-schema';

type GapPhase='map-model-and-bind-references'|'adapt-reference-order'|'replace-nonpublic-semantics'|'restore-public-assets'|'certify-layout-and-execution';
const phaseFor=(code:string):GapPhase=>{
  if(code==='MODEL_MAPPING_REQUIRED'||code==='REFERENCE_BINDING_UNRESOLVED'||code==='IMAGE_SKILL_REQUIRES_MAPPING')return 'map-model-and-bind-references';
  if(code.startsWith('REFERENCE_ORDER_'))return 'adapt-reference-order';
  if(['GENERATION_PROMPT_NOT_PUBLIC','DERIVATIVE_NOT_PORTABLE','OUTPUT_TEXT_REFERENCES_REQUIRE_REVIEW'].includes(code))return 'replace-nonpublic-semantics';
  if(code==='MISSING_PUBLIC_ASSET')return 'restore-public-assets';
  return 'certify-layout-and-execution';
};
const phasePriority:Record<GapPhase,number>={
  'map-model-and-bind-references':1,
  'adapt-reference-order':2,
  'replace-nonpublic-semantics':3,
  'restore-public-assets':4,
  'certify-layout-and-execution':5,
};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const stableId=(seed:string)=>{const value=sha(seed);return `${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-8${value.slice(17,20)}-${value.slice(20,32)}`;};

async function main(){
  const root=path.resolve(import.meta.dirname,'..');
  const catalogPath=path.resolve(process.env.COMMERCE_DISCOVERY_CATALOG||'F:\\总项目文件\\Skill存储系统\\运行数据\\自媒体操盘手\\local-data-20260902\\preview-runtime\\commerce-discovery\\catalog.json');
  const raw=(await fs.readFile(catalogPath,'utf8')).replace(/^\ufeff/u,'');
  const catalog=JSON.parse(raw) as DiscoveryCatalog;
  const canvases=catalog.items.filter((item):item is DiscoveryItem=>item.kind==='canvas');
  if(canvases.length!==18)throw Error(`公开画布数量漂移：预期 18，实际 ${canvases.length}`);
  let networkCalls=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{networkCalls+=1;throw Error('NETWORK_FORBIDDEN_IN_CANVAS_GAP_MATRIX');};
  try{
    const rows=canvases.map(item=>{
      const nodes=Array.isArray(item.snapshot.nodes)?item.snapshot.nodes as {local_id:string}[]:[];
      const edges=Array.isArray(item.snapshot.edges)?item.snapshot.edges as {local_id:string}[]:[];
      const groups=Array.isArray(item.snapshot.groups)?item.snapshot.groups as {local_id:string}[]:[];
      const ids={
        nodes:Object.fromEntries(nodes.map(row=>[row.local_id,stableId(`${item.id}:node:${row.local_id}`)])),
        edges:Object.fromEntries(edges.map(row=>[row.local_id,stableId(`${item.id}:edge:${row.local_id}`)])),
        groups:Object.fromEntries(groups.map(row=>[row.local_id,stableId(`${item.id}:group:${row.local_id}`)])),
      };
      const assetMap=Object.fromEntries(item.assets.map(asset=>[asset.assetRef,{
        id:stableId(`${item.id}:asset:${asset.assetRef}`),
        kind:asset.kind==='video'?'video':asset.kind==='audio'?'audio':'image',
      }])) as DiscoveryOwnedAssetMap;
      const converted=convertDiscoveryCanvas(item.snapshot,{ids,assetMap});
      const sourceSha256=sha(JSON.stringify(item));
      const certification=certifyMaterializedCanvas(item,sourceSha256,converted,assetMap,1)?.certification;
      const occurrenceCounts=converted.issues.reduce<Record<string,number>>((all,issue)=>(all[issue.code]=(all[issue.code]||0)+1,all),{});
      if(!certification)occurrenceCounts.DISCOVERY_CANVAS_EXECUTION_NOT_ADAPTED=occurrenceCounts.DISCOVERY_CANVAS_EXECUTION_NOT_ADAPTED||1;
      const gaps=Object.entries(occurrenceCounts).sort(([left],[right])=>left.localeCompare(right)).map(([code,occurrences])=>({code,occurrences,phase:phaseFor(code)}));
      return {
        itemId:item.id,
        title:item.title,
        sourceSha256,
        structure:{nodes:nodes.length,edges:edges.length,groups:groups.length,assets:item.assets.length},
        snapshotRecovery:{ready:Boolean(certification),mode:certification?'materialized-snapshot':'review-required',billingMode:certification?.billingMode||null},
        regeneration:{ready:false,providerVerified:false,jobVerified:false,billingVerified:false},
        executionBlockers:certification?[]:gaps,
        regenerationBlockers:gaps,
        nextSafePhase:gaps.map(gap=>gap.phase).sort((left,right)=>phasePriority[left]-phasePriority[right])[0]||'certify-layout-and-execution',
      };
    });
    const blockerTotals=new Map<string,{code:string;cases:number;occurrences:number;phase:GapPhase}>();
    for(const row of rows)for(const gap of row.regenerationBlockers){const current=blockerTotals.get(gap.code)||{code:gap.code,cases:0,occurrences:0,phase:gap.phase};current.cases+=1;current.occurrences+=gap.occurrences;blockerTotals.set(gap.code,current);}
    const result={
      schemaVersion:'commerce-canvas-gap-matrix/v1',
      generatedAt:new Date().toISOString(),
      source:{catalogPath,catalogSha256:sha(raw),capturedAt:catalog.capturedAt},
      summary:{publicCanvasCases:rows.length,snapshotRecoveryReady:rows.filter(row=>row.snapshotRecovery.ready).length,executionBlocked:rows.filter(row=>!row.snapshotRecovery.ready).length,regenerationReady:rows.filter(row=>row.regeneration.ready).length,providerRequests:0,jobsCreated:0,paidCalls:0,networkCalls},
      closureOrder:[
        {order:1,phase:'map-model-and-bind-references',safeWithoutProvider:true},
        {order:2,phase:'adapt-reference-order',safeWithoutProvider:true},
        {order:3,phase:'replace-nonpublic-semantics',safeWithoutProvider:true},
        {order:4,phase:'restore-public-assets',safeWithoutProvider:true},
        {order:5,phase:'certify-layout-and-execution',safeWithoutProvider:true},
        {order:6,phase:'real-member-provider-canary',safeWithoutProvider:false,requiresExplicitPaidAuthorization:true},
      ],
      blockerTotals:[...blockerTotals.values()].sort((left,right)=>right.cases-left.cases||right.occurrences-left.occurrences||left.code.localeCompare(right.code)),
      rows,
    };
    if(networkCalls!==0)throw Error(`生成矩阵时发生了 ${networkCalls} 次网络调用`);
    const serialized=JSON.stringify(result,null,2)+'\n';
    const outputArg=process.argv.find(arg=>arg.startsWith('--output='));
    if(outputArg){
      const outputPath=path.resolve(root,outputArg.slice('--output='.length));
      const relative=path.relative(root,outputPath);
      if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('输出文件必须位于当前项目目录');
      await fs.mkdir(path.dirname(outputPath),{recursive:true});
      await fs.writeFile(outputPath,serialized,'utf8');
      console.log(JSON.stringify({ok:true,outputPath,sha256:sha(serialized),summary:result.summary}));
      return;
    }
    process.stdout.write(serialized);
  }finally{
    globalThis.fetch=originalFetch;
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
