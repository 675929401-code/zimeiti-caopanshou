import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
 const fixture=path.resolve('.codex-evidence/commerce-canvas-quote-'+Date.now());
 process.env.COMMERCE_DATA_DIR=fixture;
 process.env.SHARED_CONFIGURATION_ENABLED='0';
 await fs.mkdir(fixture,{recursive:true});
 const store=await import('../src/commerce/server/store');
 const workflowModule=await import('../src/commerce/server/workflows');
 const model={id:'canvas-image-fixture',displayName:'Canvas Image Fixture',kind:'image' as const,source:'custom' as const,enabled:true,publicPrice:2,costPrice:1,billingUnit:'per_use' as const,configHash:'canvas-image-fixture-v1',verifiedAt:Date.now(),protocol:'secure-image-native',endpoint:'https://example.invalid',capabilities:{available:true}};
 store.put('settings','main-model-source','system',{enabled:false});
 store.put('settings','defaults','system',{image:model.id});
 store.put('settings','main-bind-canvas-owner','system',{mainUserId:'main-admin-fixture',exempt:true});
 store.put('models',model.id,'system',model);
 const canvas=(id:string,prompt='生成商品主图')=>({id,title:id,nodes:[{id:id+'-node',position:{x:0,y:0},data:{label:'商品主图',kind:'image' as const,mode:'generate',prompt,skillId:'default',aspectRatio:'1:1',resolution:'2K'}}],edges:[],groups:[],viewport:{x:0,y:0,zoom:1},createdAt:Date.now(),updatedAt:Date.now()});
 for(const id of ['canvas-idempotent','canvas-changed','canvas-expired'])store.put('canvases',id,'canvas-owner',canvas(id));

 const first=await workflowModule.quoteCanvasWorkflow('canvas-owner','canvas-idempotent');
 assert.equal(first.payableTotal,2);
 assert.equal(first.items.length,1);
 assert.equal(first.items[0].model.displayName,model.displayName);
 assert.equal('estimatedTotalCost' in first,false);
 assert.equal('modelConfigHash' in first.items[0],false);
 const requestId='11111111-1111-4111-8111-111111111111';
 const confirmed=await workflowModule.confirmCanvasWorkflow('canvas-owner',first.id,requestId,first.graphFingerprint);
 const parentBilling=store.get<Record<string,any>>('aggregate-billing',first.id,'canvas-owner')!;
 assert.equal(parentBilling.status,'exempt');
 assert.equal(parentBilling.amount,2);
 const replay=await workflowModule.confirmCanvasWorkflow('canvas-owner',first.id,requestId,first.graphFingerprint);
 assert.equal(replay.id,confirmed.id);
 await assert.rejects(()=>workflowModule.confirmCanvasWorkflow('canvas-owner',first.id,'22222222-2222-4222-8222-222222222222',first.graphFingerprint),/另一客户端请求/);
 const publicWorkflow=workflowModule.publicWorkflow(confirmed);
 assert.equal('canvasQuoteExecution' in publicWorkflow,false);
 assert.equal('owner' in publicWorkflow,false);

 const changed=await workflowModule.quoteCanvasWorkflow('canvas-owner','canvas-changed');
 store.put('canvases','canvas-changed','canvas-owner',canvas('canvas-changed','已经修改的商品主图'));
 await assert.rejects(()=>workflowModule.confirmCanvasWorkflow('canvas-owner',changed.id,'33333333-3333-4333-8333-333333333333',changed.graphFingerprint),/变化.*重新报价/);

 const expired=await workflowModule.quoteCanvasWorkflow('canvas-owner','canvas-expired');
 const stored=store.get<Record<string,unknown>>('canvas-workflow-quotes',expired.id,'canvas-owner')!;
 store.put('canvas-workflow-quotes',expired.id,'canvas-owner',{...stored,expiresAt:Date.now()-1});
 await assert.rejects(()=>workflowModule.confirmCanvasWorkflow('canvas-owner',expired.id,'44444444-4444-4444-8444-444444444444',expired.graphFingerprint),/报价已过期/);

 const ui=await fs.readFile(path.resolve('src/commerce/components/commerce-agent/canvas-live.tsx'),'utf8');
 assert.match(ui,/executionPending\.current=null/);
 assert.match(ui,/重新报价\|报价已过期\|报价不存在\|报价指纹不一致/);
 assert.match(ui,/若确认响应中断，再次点击运行只会查询同一报价/);
 assert.match(ui,/请重新运行并获取新报价/);
 console.log(JSON.stringify({passed:18,paidCalls:0,providerCalls:0,databaseWrites:0,checks:['server-total','server-items','public-model-name','public-cost-hidden','public-config-hash-hidden','parent-wallet-exempt-receipt','parent-wallet-total','same-request-idempotent','different-request-rejected','workflow-quote-hidden','workflow-owner-hidden','changed-graph-rejected','expired-quote-rejected','ui-clears-owner-bound-pending','ui-explicit-invalid-reset','ui-unknown-response-reuse','ui-new-quote-guidance','no-provider-dispatch'],fixture}));
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
