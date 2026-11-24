import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main(){
 const fixture=path.resolve('.codex-evidence/commerce-canvas-quote-'+Date.now());
 process.env.COMMERCE_DATA_DIR=fixture;
 process.env.SHARED_CONFIGURATION_ENABLED='0';
 process.env.COZE_SUPABASE_URL='https://commerce-wallet-fixture.invalid';
 process.env.COZE_SUPABASE_SERVICE_ROLE_KEY='isolated-wallet-fixture';
 const walletKeys:string[]=[];
 globalThis.fetch=async(url,init)=>{
   assert.equal(String(url),'https://commerce-wallet-fixture.invalid/rest/v1/rpc/apply_wallet_operation_atomic');
   const body=JSON.parse(String(init?.body));
   assert.equal(body.p_user_id,'main-admin-fixture');
   assert.equal(body.p_operation_kind,'cash_charge');
   assert.equal(body.p_amount,2);
   walletKeys.push(body.p_idempotency_key);
   return Response.json({success:true,operation_id:'canvas-wallet-fixture',wallet:'cash',operation_kind:'cash_charge',amount:2,delta:-2,balance_before:20,balance_after:18,already_fulfilled:false});
 };
 await fs.mkdir(fixture,{recursive:true});
 const store=await import('../src/commerce/server/store');
 const workflowModule=await import('../src/commerce/server/workflows');
 const model={id:'gpt-image-2-chA-1',internalModelId:'gpt-image-2-chA-1',modelName:'gpt-image-2',provider:'openai_compat',displayName:'Canvas Image Fixture',kind:'image' as const,source:'main' as const,enabled:true,publicPrice:2,costPrice:1,billingUnit:'per_use' as const,configHash:'a'.repeat(64),verifiedAt:Date.now(),protocol:'openai-image',endpoint:'https://example.invalid',capabilities:{available:true,executionSupported:true,credentialsConfigured:true,endpointConfigured:true,protocolConfigured:true,aspectRatios:['1:1'],resolutionOptions:['2K']}};
 store.put('settings','main-model-source','system',{enabled:false});
 store.put('settings','defaults','system',{image:model.id});
 store.put('settings','main-bind-canvas-owner','system',{mainUserId:'main-admin-fixture',mainRole:'admin',exempt:false});
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
 assert.equal(parentBilling.status,'charged');
 assert.equal(parentBilling.amount,2);
 const replay=await workflowModule.confirmCanvasWorkflow('canvas-owner',first.id,requestId,first.graphFingerprint);
 assert.equal(replay.id,confirmed.id);
 assert.equal(walletKeys.length,1);
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
 console.log(JSON.stringify({passed:18,paidCalls:0,providerCalls:0,databaseWrites:0,checks:['server-total','server-items','public-model-name','public-cost-hidden','public-config-hash-hidden','parent-wallet-charge-receipt','parent-wallet-total','same-request-idempotent','different-request-rejected','workflow-quote-hidden','workflow-owner-hidden','changed-graph-rejected','expired-quote-rejected','ui-clears-owner-bound-pending','ui-explicit-invalid-reset','ui-unknown-response-reuse','ui-new-quote-guidance','no-provider-dispatch'],fixture}));
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
