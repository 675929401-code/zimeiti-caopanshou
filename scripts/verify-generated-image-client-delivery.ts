import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import {resolveGeneratedImageClientDelivery,projectGeneratedImageClientReceipt,projectGeneratedImageDocument} from "../src/lib/generated-image-client-delivery";
import {WorkflowNodeDataSchema,WorkflowImageDeliveryReceiptSchema} from "../src/lib/workflow-schema";
import {updateImageValidationReceipt,saveImageValidationAttempt,readImageValidationAttempt,submitImageValidation,recoverImageValidation,imageValidationIsTerminal,fetchImageValidationRecord,type ImageValidationAttempt,type ImageValidationDto} from "../src/components/admin-image-validation-state";
async function main(){
let checks=0;const check=(value:unknown)=>{assert.ok(value);checks++;};
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwqkAAAAASUVORK5CYII=","base64");
const recordId="a".repeat(64), key="iav_"+"b".repeat(64);
const receipt={recordId,deliveryMode:"inline_ephemeral" as const,cashCharged:0.2,billingReferenceId:"image:fixture",sha256:createHash("sha256").update(png).digest("hex"),byteLength:png.length,contentType:"image/png",width:1,height:1};
const first={...receipt,success:true,status:"completed",traceId:key,modelIdUsed:"pm_fixture",images:[{url:"data:image/png;base64,"+png.toString("base64"),recordId,deliveryMode:"inline_ephemeral"}]};
const one=await resolveGeneratedImageClientDelivery(first),two=await resolveGeneratedImageClientDelivery({...first,recordId:"c".repeat(64),images:[{...first.images[0],recordId:"c".repeat(64)}]});
check(one.url.startsWith("blob:") && one.blob?.size===png.length);check(one.url!==two.url);
one.revoke();one.revoke();await assert.rejects(fetch(one.url));check((await (await fetch(two.url)).arrayBuffer()).byteLength===png.length);two.revoke();
const durable=projectGeneratedImageClientReceipt({...first,secret:"fixture-private",base64:png.toString("base64")})!;
check(!JSON.stringify(durable).includes("base64")&&!JSON.stringify(durable).includes("data:")&&!JSON.stringify(durable).includes("private"));
check(durable.mediaAvailable===false&&durable.canRecover===false&&durable.cashCharged===0.2);
const replay=await resolveGeneratedImageClientDelivery({...receipt,images:[]});check(replay.url===""&&!replay.blob);
for(const changed of [{sha256:"0".repeat(64)},{byteLength:1},{recordId:"d".repeat(64)},{cashCharged:-1}]) {await assert.rejects(resolveGeneratedImageClientDelivery({...first,...changed}));checks++;}
const direct=await resolveGeneratedImageClientDelivery({recordId,deliveryMode:"provider_url",cashCharged:0.3,images:[{recordId,deliveryMode:"provider_url",url:"https://untrusted.invalid/private"}]});check(direct.imageRef?.recordId===recordId&&direct.url.startsWith("/api/media-history/content?")&&!direct.blob);
const expired=await resolveGeneratedImageClientDelivery({recordId,deliveryMode:"provider_url",cashCharged:0.3,state:"expired",images:[]});check(!expired.url);
const legacy=await resolveGeneratedImageClientDelivery({images:[{url:"https://owned.invalid/legacy.png",assetId:"asset_legacy",storageKey:"owned/legacy.png"}]});check(legacy.kind==="legacy_owned"&&legacy.assetId==="asset_legacy");
const prompt="请展示 metadata: 字段和 blob: 文本，保留这段自由描述";
const document={session:{nodes:[{data:{prompt,outputUrl:"",imagePreviewUrl:"blob:fixture",imageDeliveryReceipt:{...durable,base64:"forbidden"},history:[{imagePreviewUrl:"blob:fixture",outputUrl:"data:image/png;base64,forbidden",imageDeliveryReceipt:durable}]}}]},runHistory:[{nodes:[{data:{outputUrl:"blob:fixture",prompt}}]}]};
const projected=projectGeneratedImageDocument(document),serialized=JSON.stringify(projected);
check(!serialized.includes("blob:fixture")&&!serialized.includes("data:image")&&!serialized.includes("forbidden"));check(projected.session.nodes[0].data.prompt===prompt);
check(WorkflowImageDeliveryReceiptSchema.safeParse(durable).success&&!WorkflowImageDeliveryReceiptSchema.safeParse({...durable,base64:"forbidden"}).success);
check(WorkflowNodeDataSchema.parse({kind:"image",title:"fixture",imageDeliveryReceipt:durable}).imageDeliveryReceipt?.cashCharged===0.2);
const attempt:ImageValidationAttempt={version:1,userId:"fixture-user",model:{id:"fixture",publicId:"pm_fixture",name:"fixture",upstream:"fixture"},proof:{validationKey:key,configurationHash:"e".repeat(64),epoch:0,clientIdempotencyKey:key,clientTraceId:key},createdAt:new Date().toISOString(),status:"processing",imageRecordId:"",assetId:"",canRecover:false,error:"",errorCode:""};
const completed=updateImageValidationReceipt(attempt,first);check(completed.status==="completed"&&completed.imageRecordId===recordId&&completed.generationCompleted&&completed.mediaAvailable&&imageValidationIsTerminal(completed));
const map=new Map<string,string>(),storage={getItem:(key:string)=>map.get(key)||null,setItem:(key:string,value:string)=>{map.set(key,value);}};
saveImageValidationAttempt(storage,completed);const restored=readImageValidationAttempt(storage,"fixture-user","fixture")!;check(restored.status==="completed"&&restored.mediaAvailable===false&&!JSON.stringify([...map.values()]).includes("data:image"));
assert.throws(()=>updateImageValidationReceipt({...attempt,imageRecordId:"f".repeat(64)},first));checks++;
let previewGets=0;
const previewFetcher=(async(url:unknown,init?:RequestInit)=>{previewGets++;assert.equal(String(url),'/api/media-history/content?recordId='+recordId);assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer fixture-session');assert.notEqual(init?.method,'POST');return new Response(png,{headers:{'content-type':'image/png'}});}) as typeof fetch;
check((await fetchImageValidationRecord(recordId,'fixture-session',previewFetcher)).blob.size===png.length&&previewGets===1);
await assert.rejects(fetchImageValidationRecord('bad-owner-reference','fixture-session',previewFetcher));check(previewGets===1);
await assert.rejects(fetchImageValidationRecord(recordId,'fixture-session',(async()=>new Response('',{status:410})) as typeof fetch));checks++;
const dto={modelId:"fixture",publicModelId:"pm_fixture",name:"fixture",modelName:"fixture",busy:false,credentialReady:true,priceReady:true,confirmation:"RUN_SINGLE_REAL_IMAGE_VALIDATION",configurationHash:attempt.proof.configurationHash,epoch:0,validationKey:key,clientIdempotencyKey:key,clientTraceId:key,capabilities:{defaultResolution:"1K",resolutionOptions:["1K"],supportsReferenceInput:false,maxReferenceImages:0}} as unknown as ImageValidationDto;
const freshMap=new Map<string,string>(),freshStorage={getItem:(key:string)=>freshMap.get(key)||null,setItem:(key:string,value:string)=>{freshMap.set(key,value);}};
let posts=0,gets=0,deliveries=0;
const fetcher=(async (_url:unknown,init?:RequestInit)=>{if(init?.method==="POST")posts++;else gets++;return Response.json(init?.method==="POST"?first:{...receipt,state:"completed",images:[],mediaAvailable:false,canRecover:false});}) as typeof fetch;
const submitted=await submitImageValidation(dto,{prompt:"fixture",resolution:"1K",aspectRatio:"1:1",referenceMode:false,referenceImageUrls:[]},"fixture-user",{storage:freshStorage,token:"fixture-session",fetcher,onDelivery:delivery=>{deliveries++;delivery.revoke();}});
check(submitted.status==="completed"&&posts===1&&deliveries===1);
await submitImageValidation(dto,{prompt:"fixture",resolution:"1K",aspectRatio:"1:1",referenceMode:false,referenceImageUrls:[]},"fixture-user",{storage:freshStorage,token:"fixture-session",fetcher});
check(posts===1);
const recovered=await recoverImageValidation(submitted,{storage:freshStorage,token:"fixture-session",fetcher});
check(recovered.status==="completed"&&posts===1&&gets===1&&!JSON.stringify([...freshMap.values()]).includes("base64"));

// Execute the production workbench union branch, including its early continue,
// rather than reproducing the branch in a fixture implementation.
const source=readFileSync("src/components/image-workbench.tsx","utf8");
const start=source.indexOf("          const clientReceipt=projectGeneratedImageClientReceipt(data);");
const end=source.indexOf("          const generatedUrl =",start);
assert.ok(start>=0&&end>start);
const branch=source.slice(start,end);
const state:{jobs:Array<Record<string,unknown>>;persistCalls:number;receipts:Map<string,number>;releases:Map<string,()=>void>}={jobs:[{id:"job-one",status:"generating"}],persistCalls:0,receipts:new Map(),releases:new Map()};
const compiled=ts.transpileModule("module.exports=async function(){for(let i=0;i<1;i++){"+branch+"state.persistCalls++;}}",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
async function runWorkbench(data:unknown){const workbenchModule={exports:undefined as unknown};runInNewContext(compiled,{module:workbenchModule,state,data,response:{ok:true},job:{id:"job-one"},requestPayload:{resolution:"1K"},projectGeneratedImageClientReceipt,resolveGeneratedImageClientDelivery,completedReceipts:state.receipts,transientImageReleases:{current:state.releases},transientImageBlobs:{current:new Map()},deliveryMounted:{current:true},setJobs:(fn:(jobs:typeof state.jobs)=>typeof state.jobs)=>{state.jobs=fn(state.jobs);},setCashBalance:()=>{},isImageResolution:()=>true});await (workbenchModule.exports as ()=>Promise<void>)();}
await runWorkbench(first);check(state.jobs[0].status==="done"&&String(state.jobs[0].imageUrl).startsWith("blob:")&&state.persistCalls===0);
await runWorkbench({...receipt,images:[],status:"completed"});check(state.jobs[0].status==="done"&&!state.jobs[0].imageUrl&&state.persistCalls===0);
check(state.receipts.size===1&&[...state.receipts.values()][0]===0.2);
for(const release of state.releases.values())release();
const statusSource=readFileSync("src/app/api/image/status/route.ts","utf8"),statusStart=statusSource.indexOf('    if (record.state === "completed" && record.response) {'),statusEnd=statusSource.indexOf('    const checkpoint =',statusStart);
assert.ok(statusStart>=0 && statusEnd>statusStart);
const statusModule={exports:undefined as unknown};let resumeCalls=0;
runInNewContext(ts.transpileModule('module.exports=function(record){'+statusSource.slice(statusStart,statusEnd)+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:statusModule,user:{id:"fixture-user"},isImageEphemeralReceipt:()=>false,response:(value:unknown)=>value,imageProviderEvidenceProjection:()=>({}),parseImageFailureRequestSnapshot:()=>({quotedPriceYuan:0.3}),imageFailureBillingReferenceId:()=>"image:fixture",resumeInput:()=>{resumeCalls++;return{};}});
const refreshStart=source.indexOf('        if (["completed","expired"].includes('),refreshEnd=source.indexOf('        if (checkedJob.result?.state === "rejected"',refreshStart),refreshModule={exports:undefined as unknown};
assert.ok(refreshStart>=0 && refreshEnd>refreshStart);
runInNewContext(ts.transpileModule('module.exports=function(job,checkedJob){'+source.slice(refreshStart,refreshEnd)+'return job;}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:refreshModule,projectGeneratedImageClientReceipt});
for(const expired of [false,true]){
 const status=(statusModule.exports as (record:unknown)=>Record<string,unknown>)({recordId,clientIdempotencyKey:key,state:"completed",deliveryState:"delivered",response:{deliveryMode:"provider_url",providerUrl:"https://owned.invalid/image.png",...(expired?{sourceExpiredAt:"fixture"}:{})}});
 check(status.generationCompleted===true&&status.canRecover===false&&status.cashCharged===0.3&&!status.resumeInput);
 const restored=(refreshModule.exports as (job:unknown,result:unknown)=>Record<string,unknown>)({id:"status-job",status:"unknown"},{result:status});
 check(restored.status==="done"&&restored.cashCharged===0.3&&Boolean(restored.imageUrl)===!expired);
 const validation=updateImageValidationReceipt(attempt,status);check(validation.status==="completed"&&imageValidationIsTerminal(validation));
}
check(resumeCalls===0);
const canvasSource=readFileSync("src/components/manual-canvas.tsx","utf8"),canvasStart=canvasSource.lastIndexOf('          if(generatedDelivery?.receipt) {',canvasSource.indexOf('if(!deliveryPageActiveRef.current')),canvasEnd=canvasSource.indexOf('          if (!generatedUrl)',canvasStart);
assert.ok(canvasStart>=0&&canvasEnd>canvasStart);
const canvasModule={exports:undefined as unknown},canvasDelivery=await resolveGeneratedImageClientDelivery(first),canvasNodes=[{id:"canvas-node",data:{kind:"image"}}],canvasReleases=new Map<string,()=>void>();
runInNewContext(ts.transpileModule('module.exports=function(){let runtime=nodesRef.current,outputUrl="",completedAt,taskId,billingReferenceId,assetId,storageKey,historyRecordId;for(let index=0;index<1;index++){'+canvasSource.slice(canvasStart,canvasEnd)+'throw new Error("new mode must not enter legacy persistence");}return runtime;}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:canvasModule,generatedDelivery:canvasDelivery,deliveryPageActiveRef:{current:true},deliveryCanvasRef:{current:"canvas-one"},imageRunCanvasId:"canvas-one",nodesRef:{current:canvasNodes},nodeId:"canvas-node",imageDeliveryReleases:{current:canvasReleases},crypto,model:{id:"fixture"},publicModelName:"fixture",generatedTraceId:key,clientTraceId:key,actualCost:0.2,cashRemaining:1,generatedHistory:[],replaceRuntimeNode:(runtime:typeof canvasNodes,id:string,patch:Record<string,unknown>)=>runtime.map(node=>node.id===id?{...node,data:{...node.data,...patch}}:node)});
const canvasResult=(canvasModule.exports as ()=>Array<{data:Record<string,unknown>}>)();
check(canvasResult[0].data.outputUrl===""&&String(canvasResult[0].data.imagePreviewUrl).startsWith("blob:")&&canvasResult[0].data.taskId===key);
check(JSON.stringify(projectGeneratedImageDocument(canvasResult)).includes('"cashCharged":0.2')&&!JSON.stringify(projectGeneratedImageDocument(canvasResult)).includes('blob:'));
for(const release of canvasReleases.values())release();
const pushStart=source.indexOf('    if(jobs.some(job=>job.status==='),pushEnd=source.indexOf('  }, [jobs, videoPushMode]);',pushStart);
assert.ok(pushStart>=0&&pushEnd>pushStart);
const pushCode=ts.transpileModule('module.exports=function(){'+source.slice(pushStart,pushEnd)+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let pushed:Array<Record<string,unknown>>=[];
const invokePush=(jobs:unknown[],videoPushMode:string)=>{const pushModule={exports:undefined as unknown};runInNewContext(pushCode,{module:pushModule,jobs,videoPushMode,setNotice:()=>{},normalizeImageUrl:(url:string)=>url,mergeVideoWorkflowDraft:(updates:Array<Record<string,unknown>>)=>{pushed=updates;return{updatedAt:1};},window:{location:{assign:()=>{}}}});(pushModule.exports as ()=>void)();};
invokePush([{status:"done",imageUrl:"/api/media-history/content?recordId="+recordId,prompt:"first",deliveryReceipt:{...durable,deliveryMode:"provider_url"}},{status:"done",imageUrl:"/api/media-history/content?recordId="+recordId,prompt:"last",deliveryReceipt:{...durable,recordId:"f".repeat(64),deliveryMode:"provider_url"}}],"first-last");
check(pushed.length===2&&pushed[0].imageTarget==="first-frame"&&pushed[1].imageTarget==="last-frame"&&!pushed[0].imageUrl&&(pushed[0].imageRef as {recordId:string}).recordId===recordId);
pushed=[];invokePush([{status:"done",imageUrl:"blob:fixture",deliveryReceipt:durable}],"reference");check(pushed.length===0);
const feeStart=source.indexOf('{(job.taskId || job.deliveryReceipt?.recordId) ? ('),feeEnd=source.indexOf(') : null}',feeStart)+9,feeModule={exports:undefined as unknown};
assert.ok(feeStart>=0 && feeEnd>feeStart);
runInNewContext(ts.transpileModule('module.exports=function(job){return <>'+source.slice(feeStart,feeEnd)+'</>}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React},fileName:'fee.tsx'}).outputText,{module:feeModule,React:{Fragment:'fragment',createElement:(_tag:unknown,_props:unknown,...children:unknown[])=>children},selectedResolution:"1K"});
check(JSON.stringify((feeModule.exports as (job:unknown)=>unknown)({deliveryReceipt:durable,cashCharged:0.2})).includes('0.20'));
console.log(JSON.stringify({ok:true,checks,realNetworkCalls:0,realDatabaseCalls:0,paidCalls:0,actualWorkbenchBranch:true,actualAdminSubmitRecovery:true,actualCanvasSchema:true}));

}
void main().catch(error=>{console.error(error);process.exitCode=1;});
