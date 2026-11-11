import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import sharp from 'sharp';
export async function main(args=[]){
 const arg=k=>args.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3);
 const origin='http://127.0.0.1:5000',token=process.env.LOCAL_NAV_ADMIN_TOKEN,user=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY).user;
 assert.equal(process.env.LOCAL_NAV_ORIGIN,origin);assert.ok(token&&user.id);
 const root='.codex-evidence/cover-paid-20261106-3fd15654',dir=path.resolve(root,'compact-title-live-edit');await fs.mkdir(dir,{recursive:true});
 const original=JSON.parse(await fs.readFile(path.join(root,'four-modes/warm_relationship_layout/continuation-report.json'),'utf8'));assert.equal(original.passed,true);
 const sourceId=original.receipt.backgroundAssetId,title=original.title;
 const report={startedAt:new Date().toISOString(),scope:'real-browser-edit-existing-owned-background-no-analysis-no-image-generation',originalAssetId:original.receipt.assetId,
  backgroundAssetId:sourceId,title,counts:{preview:0,render:0,analysis:0,image:0},blocked:[],passed:false};
 const auth={Authorization:'Bearer '+token};let browser,page;
 const get=async p=>{const r=await fetch(origin+p,{headers:auth,cache:'no-store'});assert.ok(r.ok);return r.json();};
 try{
  const version=await get('/api/version');assert.equal(version.sourceVersion,arg('expected-source-version'));assert.equal(version.buildId,arg('expected-build-id'));report.runtime={sourceVersion:version.sourceVersion,buildId:version.buildId};
  try{await fs.access(path.join(dir,'save-consumed.json'));throw new Error('SAVE_ALREADY_SUBMITTED_QUERY_ORIGINAL_ONLY');}catch(e){if(e.code!=='ENOENT')throw e;}
  process.env.TEMP=path.resolve(root,'playwright-temp');process.env.TMP=process.env.TEMP;
  browser=await chromium.launch({headless:true,channel:'msedge',downloadsPath:path.join(process.env.USERPROFILE,'Downloads','CodexCoverAcceptance')});
  const context=await browser.newContext({viewport:{width:1920,height:1080},acceptDownloads:true,serviceWorkers:'block'});
  await context.addCookies([{name:'auth_token',value:token,url:origin,httpOnly:true,sameSite:'Lax'}]);
  await context.addInitScript(({token,user})=>{localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));sessionStorage.setItem('entered_app','1');},{token,user});
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort('blockedbyclient');
   if(url.pathname==='/api/auth/me'&&req.method()==='GET')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,user})});
   if(['GET','HEAD'].includes(req.method()))return route.continue();
   if(['/api/cover/preview','/api/cover/render'].includes(url.pathname)&&req.method()==='POST'){
    const body=req.postDataJSON();assert.equal(body.sourceAssetId,sourceId);assert.equal(body.plan.title,title);assert.equal(body.plan.planVersion,2);
    if(url.pathname.endsWith('/preview')){report.counts.preview++;return route.continue();}
    assert.equal(++report.counts.render,1);const response=await route.fetch({timeout:180000});const data=await response.json();
    report.save={httpStatus:response.status(),assetId:data.assetId,historyRecordId:data.historyRecordId,persisted:data.persisted,cloudStored:data.cloudStored,width:data.width,height:data.height};
    return route.fulfill({response});
   }
   if(['/api/diagnostic-logs','/api/operation-events'].includes(url.pathname))return route.continue();
   report.blocked.push({path:url.pathname,method:req.method()});return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'NO_NEW_ANALYSIS_OR_IMAGE_ALLOWED'})});
  });
  page=await context.newPage();page.setDefaultTimeout(40000);await page.goto(origin+'/cover',{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'历史作品',exact:true}).click();
  const card=page.getByRole('dialog',{name:'历史作品'}).locator(`button[data-cover-asset-id="${original.receipt.assetId}"]`);await card.waitFor();await card.click();
  await page.getByText('调整标题和排版（可选）',{exact:true}).click();
  const slider=page.locator('input[type="range"]').nth(2);report.scaleBefore=Number(await slider.inputValue());await slider.focus();await slider.press('ArrowLeft');report.scaleAfter=Number(await slider.inputValue());assert.equal(report.scaleAfter,report.scaleBefore-1);
  const download=page.getByRole('button',{name:'保存并下载',exact:true});await download.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='保存并下载'&&!x.disabled));
  await fs.writeFile(path.join(dir,'save-consumed.json'),JSON.stringify({at:new Date().toISOString(),sourceId,originalAssetId:original.receipt.assetId,title}),{flag:'wx'});
  const downloading=page.waitForEvent('download',{timeout:120000});await download.click();const delivered=await downloading;assert.equal(await delivered.failure(),null);
  const output=path.join(dir,'downloaded-compact-cover.png');await delivered.saveAs(output);const bytes=await fs.readFile(output),meta=await sharp(bytes).metadata();assert.equal(meta.width,1080);assert.equal(meta.height,1440);assert.equal(meta.format,'png');
  assert.ok(report.save.assetId&&report.save.assetId!==original.receipt.assetId);assert.ok(report.save.persisted&&report.save.cloudStored);
  const history=await get('/api/cover/history?page=1');assert.ok(history.records.some(x=>x.assetId===report.save.assetId&&x.backgroundAssetId===sourceId&&x.historyRecordId===report.save.historyRecordId));
  report.download={path:output,sha256:createHash('sha256').update(bytes).digest('hex'),width:meta.width,height:meta.height};
  await page.screenshot({path:path.join(dir,'saved-and-download.png'),fullPage:false});
  assert.equal(report.blocked.length,0);assert.equal(report.counts.render,1);assert.ok(report.counts.preview>0);report.passed=true;
 }catch(e){report.failure={code:String(e.code||'COMPACT_TITLE_EDIT_FAILED'),message:String(e.message||'').split(token).join('[redacted]').slice(0,500)};process.exitCode=1;await page?.screenshot({path:path.join(dir,'failure.png'),fullPage:false}).catch(()=>{});}
 finally{await browser?.close();report.finishedAt=new Date().toISOString();const json=JSON.stringify(report,null,2);assert.ok(!json.includes(token));await fs.writeFile(path.join(dir,'report.json'),json+'\n',{flag:'wx'});console.log(JSON.stringify(report));}
}
