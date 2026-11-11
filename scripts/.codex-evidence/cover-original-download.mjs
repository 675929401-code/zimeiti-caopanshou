import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import sharp from 'sharp';

export async function main() {
  const origin='http://127.0.0.1:5000';
  assert.equal(process.env.LOCAL_NAV_ORIGIN,origin);
  const token=process.env.LOCAL_NAV_ADMIN_TOKEN;
  const identity=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY||'null');
  assert.ok(token&&identity?.user?.id);
  const operationId='aa965c59-85fe-4826-b7b7-a28eb6182cab';
  const key='coverwb_'+operationId;
  const dir=path.resolve('.codex-evidence/cover-paid-20261106-3fd15654/original-download');
  await fs.mkdir(dir,{recursive:true});
  const report={at:new Date().toISOString(),scope:'original-paid-operation-readback-and-download-only',operationId,key,passed:false,modelSubmissions:0,blockedWrites:[],pageErrors:[]};
  let browser;
  const read=async p=>{const r=await fetch(origin+p,{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.timeout(60000)});const b=await r.json();assert.ok(r.ok,'ORIGINAL_READ_FAILED');return b;};
  try {
    const parent=await read('/api/cover/prepare?operationId='+operationId);
    assert.equal(parent.operationId,operationId);
    const browserTemp=path.resolve('.codex-evidence/cover-paid-20261106-3fd15654/playwright-temp');await fs.mkdir(browserTemp,{recursive:true});process.env.TEMP=browserTemp;process.env.TMP=browserTemp;
    const nativeDownloads=path.join(process.env.USERPROFILE,'Downloads','CodexCoverAcceptance');await fs.mkdir(nativeDownloads,{recursive:true});
    browser=await chromium.launch({headless:true,channel:'msedge',downloadsPath:nativeDownloads});
    const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block',acceptDownloads:true});
    await context.addCookies([{name:'auth_token',value:token,url:origin,httpOnly:true,sameSite:'Lax'}]);
    await context.addInitScript(({token,user,parent,operationId})=>{
      localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));sessionStorage.setItem('entered_app','1');
      const m=parent.materials;
      localStorage.setItem('cover-workbench-draft-v2:'+user.id,JSON.stringify({schemaVersion:'cover-browser-draft/2',userId:user.id,text:m.text,title:parent.renderPlan?.title||'',manualTitle:Boolean(m.manualTitle),styleKey:m.styleKey,ratio:m.outputRatio,modelId:m.modelId,resolution:m.resolution,assets:[],materialRevision:m.materialRevision}));
      localStorage.setItem('cover-workbench-operation-v2:'+user.id,JSON.stringify({operationId,clientRequestId:m.clientRequestId,materialRevision:m.materialRevision,phase:'generation'}));
    },{token,user:identity.user,parent,operationId});
    let browserCompleted=false, deliveryFailure;
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==origin)return route.abort('blockedbyclient');
      if(url.pathname==='/api/auth/me'&&request.method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,user:identity.user})});
      if(!['GET','HEAD'].includes(request.method())){
        report.blockedWrites.push({path:url.pathname,method:request.method()});
        return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'READ_ONLY_ORIGINAL_DOWNLOAD_NO_WRITES'})});
      }
      if(url.pathname==='/api/cover/attempt'){
        assert.equal(url.searchParams.get('clientIdempotencyKey'),key);assert.equal(url.searchParams.get('clientTraceId'),key);
        const response=await route.fetch({maxRedirects:0,timeout:180000});const b=await response.json();
        report.deliveryResponse={httpStatus:response.status(),code:b.code,completed:b.completed,state:b.activeAttempt?.state};
        if(!response.ok())deliveryFailure=/^[A-Z0-9_]+$/.test(b.code||'')?b.code:'ORIGINAL_DELIVERY_HTTP_FAILED';
        if(b.completed===true&&b.result?.persisted===true&&b.result?.cloudStored===true)browserCompleted=true;
        return route.fulfill({response});
      }
      return route.continue();
    });
    const page=await context.newPage();page.setDefaultTimeout(180000);
    page.on('pageerror',()=>report.pageErrors.push('PAGE_RUNTIME_ERROR'));
    await page.goto(origin+'/cover',{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'封面工作台',exact:true}).waitFor();
    await page.getByRole('button',{name:'查询原任务状态',exact:true}).click();
    const deadline=Date.now()+180000;
    while(!browserCompleted&&!deliveryFailure&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,500));
    if(deliveryFailure)throw new Error(deliveryFailure);
    assert.equal(browserCompleted,true,'REAL_UI_ORIGINAL_DELIVERY_NOT_COMPLETED');
    report.recovery={initiatedFromRealBrowser:true,button:'查询原任务状态',sameOperationAndKeys:true,providerSubmissions:0};
    const original=await read('/api/cover/attempt?'+new URLSearchParams({clientIdempotencyKey:key,clientTraceId:key}));
    const result=original.result||{};
    report.parent={state:parent.status,billing:{credits_charged:parent.billing?.credits_charged,operation_id:parent.billing?.operation_id,token_usage:parent.billing?.token_usage},title:parent.renderPlan?.title};
    report.original={completed:original.completed,code:original.code,state:original.activeAttempt?.state,
      assetId:result.assetId,historyRecordId:result.historyRecordId,backgroundAssetId:original.backgroundAssetId,
      persisted:result.persisted,cloudStored:result.cloudStored,width:result.width,height:result.height,
      outputKind:result.outputKind,planVersion:result.planVersion,temporary:original.temporary===true,
      errorCode:original.activeAttempt?.errorCode};
    console.log(JSON.stringify({event:'original-cover-readback',parentState:parent.status,original:report.original}));
    assert.equal(original.completed,true,'ORIGINAL_NOT_COMPLETED');
    assert.equal(result.persisted,true,'ORIGINAL_NOT_PERSISTED');
    assert.equal(result.cloudStored,true,'ORIGINAL_NOT_CLOUD_STORED');
    assert.equal(result.width,1080);assert.equal(result.height,1440);
    const history=await read('/api/cover/history?page=1');
    const matches=(history.records||[]).filter(r=>r.assetId===result.assetId&&r.historyRecordId===result.historyRecordId);
    assert.equal(matches.length,1,'EXACT_OWNED_HISTORY_MISSING');
    const saved=matches[0];
    assert.equal(saved.cloudStored,true);assert.ok(['done','display_pending'].includes(saved.status));
    assert.equal(saved.backgroundAssetId,original.backgroundAssetId);
    report.history={assetId:saved.assetId,historyRecordId:saved.historyRecordId,status:saved.status,outputWidth:saved.outputWidth,outputHeight:saved.outputHeight,backgroundMatches:true};
    await page.getByRole('button',{name:'历史作品',exact:true}).waitFor({state:'visible'});
    await page.getByRole('button',{name:'历史作品',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'历史作品',exact:true});
    const card=dialog.locator(`button[data-cover-asset-id="${saved.assetId}"][data-cover-history-id="${saved.historyRecordId}"]`);
    await card.first().waitFor({state:'visible',timeout:30000});
    assert.equal(await card.count(),1,'HISTORY_CARD_AMBIGUOUS');
    await card.click();
    const download=page.getByRole('button',{name:'下载封面',exact:true});
    await download.waitFor({state:'visible'});
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='下载封面'&&!n.disabled));
    const downloaded=page.waitForEvent('download',{timeout:60000});await download.click();
    const event=await downloaded;assert.equal(await event.failure(),null);
    const imagePath=path.join(dir,'downloaded-cover-1080x1440.png');await event.saveAs(imagePath);
    const bytes=await fs.readFile(imagePath);const meta=await sharp(bytes).metadata();
    assert.equal(meta.format,'png');assert.equal(meta.width,1080);assert.equal(meta.height,1440);
    report.download={path:imagePath,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),format:meta.format,width:meta.width,height:meta.height};
    await page.screenshot({path:path.join(dir,'actual-saved-cover.png'),fullPage:false});
    assert.deepEqual(report.pageErrors,[]);
    report.passed=true;
  } catch(e) {report.failure={code:/^[A-Z0-9_]+$/.test(e.message)?e.message:String(e.code||'ORIGINAL_DOWNLOAD_VERIFICATION_FAILED'),message:String(e.message||'').split(token).join('[redacted]').slice(0,500)};process.exitCode=1;}
  finally {if(browser)await browser.close();const out=JSON.stringify(report,null,2)+'\n';assert.ok(!out.includes(token));await fs.writeFile(path.join(dir,'report.json'),out);}
  console.log(JSON.stringify({passed:report.passed,failure:report.failure,operationId,modelSubmissions:0,report:path.join(dir,'report.json'),image:report.download?.path}));
}
