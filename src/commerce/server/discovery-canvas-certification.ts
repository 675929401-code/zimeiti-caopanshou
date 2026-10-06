import {createHash} from 'node:crypto';
import {get,put} from './store';
import {canvasAssetIds,normalizeCanvasGraph,type CanvasDocument,type CanvasGraph} from '../shared/canvas-schema';
import type {DiscoveryCanvasImportResult,DiscoveryOwnedAssetMap} from '../shared/discovery-canvas-import-schema';
import type {DiscoveryItem} from '../shared/discovery-catalog-types';

export type MaterializedCanvasCertification={
 schemaVersion:1;
 status:'certified';
 sourceItemId:string;
 sourceSha256:string;
 graphSha256:string;
 executionReady:true;
 executionMode:'materialized-snapshot';
 regenerationReady:false;
 billingMode:'zero-cost-owned-assets';
 nodes:number;
 edges:number;
 groups:number;
 assets:number;
 sourceIssueCounts:Record<string,number>;
 certifiedAt:number;
};

type Profile={sha256:string;nodes:number;edges:number;groups:number;assets:number;issueCounts:Record<string,number>};
const profiles:Record<string,Profile>={
 'e4c34e3a-4c29-49ae-860a-20545e4b5bd3':{sha256:'9401e847b077a6b962a42e02ef5fa2bf2eaea128329a0b8d2c0224f749a6c4c6',nodes:5,edges:10,groups:1,assets:5,issueCounts:{REFERENCE_ORDER_NOT_PUBLIC:5,MODEL_MAPPING_REQUIRED:3,GENERATION_PROMPT_NOT_PUBLIC:3,LAYOUT_PROVENANCE_SIDECAR:1,PUBLIC_WORKFLOW_NOT_EXECUTION_CERTIFIED:1}},
 'c6ee02ae-09b3-45d9-9dc3-268f89141ede':{sha256:'3e4bab820700760e767eeb174ce20c6cfed39c19ac0b8e623af722774d7f9f87',nodes:2,edges:1,groups:1,assets:3,issueCounts:{REFERENCE_ORDER_NOT_PUBLIC:2,MODEL_MAPPING_REQUIRED:2,LAYOUT_PROVENANCE_SIDECAR:1,PUBLIC_WORKFLOW_NOT_EXECUTION_CERTIFIED:1}},
 '6ca453a1-57c1-4577-bdfc-7e07dce4adc6':{sha256:'fd113bdbdda2373213be3659b8651d3d78997c9c595b9adb7bd7d3634ce5a2cb',nodes:22,edges:41,groups:3,assets:15,issueCounts:{REFERENCE_ORDER_NOT_PUBLIC:22,MODEL_MAPPING_REQUIRED:21,GENERATION_PROMPT_NOT_PUBLIC:21,OUTPUT_TEXT_REFERENCES_REQUIRE_REVIEW:1,LAYOUT_PROVENANCE_SIDECAR:1,PUBLIC_WORKFLOW_NOT_EXECUTION_CERTIFIED:1}},
};
const bucket='discovery-canvas-materialized-certifications';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Mirrors canvas-storage: non-video model IDs are server-owned and never persisted from a public canvas. */
function storageGraph(graph:CanvasGraph):CanvasGraph{
 const normalized=normalizeCanvasGraph(graph);
 return {...normalized,nodes:normalized.nodes.map(node=>node.data.kind==='video'?node:{...node,data:Object.fromEntries(Object.entries(node.data).filter(([key])=>key!=='modelId')) as typeof node.data})};
}
const graphDigest=(graph:CanvasGraph)=>digest(JSON.stringify(storageGraph(graph)));
const counts=(result:DiscoveryCanvasImportResult)=>result.issues.reduce<Record<string,number>>((all,issue)=>(all[issue.code]=(all[issue.code]||0)+1,all),{});
const sameCounts=(left:Record<string,number>,right:Record<string,number>)=>JSON.stringify(Object.entries(left).sort())===JSON.stringify(Object.entries(right).sort());

/** Certifies only three byte-pinned public snapshots as owned, already-rendered
 * material. It never certifies regeneration or any private model/prompt logic. */
export function certifyMaterializedCanvas(item:DiscoveryItem,sourceSha256:string,result:DiscoveryCanvasImportResult,assetMap:DiscoveryOwnedAssetMap,now=Date.now()):{graph:CanvasGraph;certification:MaterializedCanvasCertification}|null{
 const profile=profiles[item.id];
 if(!profile||item.kind!=='canvas'||sourceSha256!==profile.sha256||!result.ok||!result.graph)return null;
 const sourceNodes=Array.isArray(item.snapshot.nodes)?item.snapshot.nodes as Record<string,unknown>[]:[],sourceEdges=Array.isArray(item.snapshot.edges)?item.snapshot.edges:[],sourceGroups=Array.isArray(item.snapshot.groups)?item.snapshot.groups:[];
 if(sourceNodes.length!==profile.nodes||sourceEdges.length!==profile.edges||sourceGroups.length!==profile.groups||item.assets.length!==profile.assets||!sameCounts(counts(result),profile.issueCounts))return null;
 if(result.graph.nodes.length!==profile.nodes||result.graph.edges.length!==profile.edges||result.graph.groups.length!==profile.groups)return null;
 for(const node of sourceNodes){const kind=node.type,payload=node.current_payload;if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;const value=payload as Record<string,unknown>;if(kind==='markdown'){if(typeof value.markdown!=='string'||!value.markdown.trim())return null;}else if(!['image','video','audio'].includes(String(kind))||typeof value.asset_ref!=='string'||!assetMap[value.asset_ref])return null;}
 let graph:CanvasGraph;
 try{graph=storageGraph({...result.graph,nodes:result.graph.nodes.map(node=>{if(node.data.kind==='text'){const text=node.data.resultText||node.data.prompt;if(!text.trim())throw Error('认证素材快照缺少文本结果');return {...node,data:{...node.data,mode:'input' as const,prompt:text,status:'succeeded'}};}const primary=node.data.resultAssetIds?.length?node.data.resultAssetIds:node.data.assetIds;if(!primary?.length)throw Error('认证素材快照缺少媒体结果');return {...node,data:{...node.data,mode:'input' as const,assetIds:[...primary],status:'succeeded'}};})});}catch{return null;}
 const mappedIds=Object.values(assetMap).map(asset=>asset.id).sort();if(JSON.stringify(canvasAssetIds(graph).sort())!==JSON.stringify(mappedIds))return null;
 const certification:MaterializedCanvasCertification={schemaVersion:1,status:'certified',sourceItemId:item.id,sourceSha256,graphSha256:graphDigest(graph),executionReady:true,executionMode:'materialized-snapshot',regenerationReady:false,billingMode:'zero-cost-owned-assets',nodes:profile.nodes,edges:profile.edges,groups:profile.groups,assets:profile.assets,sourceIssueCounts:profile.issueCounts,certifiedAt:now};
 return {graph,certification};
}

export function registerMaterializedCanvasCertification(owner:string,canvasId:string,certification:MaterializedCanvasCertification){const old=get<MaterializedCanvasCertification>(bucket,canvasId,owner);if(old&&(old.sourceSha256!==certification.sourceSha256||old.graphSha256!==certification.graphSha256))throw Error('画布素材快照认证来源不可替换');put(bucket,canvasId,owner,old||certification);return old||certification;}
export function readMaterializedCanvasCertification(owner:string,canvasId:string){const certification=get<MaterializedCanvasCertification>(bucket,canvasId,owner),canvas=get<CanvasDocument>('canvases',canvasId,owner);if(!certification||!canvas)return undefined;const graph:CanvasGraph={nodes:canvas.nodes,edges:canvas.edges,groups:canvas.groups,viewport:canvas.viewport};return graphDigest(graph)===certification.graphSha256?certification:undefined;}
