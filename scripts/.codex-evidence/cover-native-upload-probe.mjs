import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {chromium} from 'playwright';
export async function main(){
 const origin='http://127.0.0.1:5000',token=process.env.LOCAL_NAV_ADMIN_TOKEN,user=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY).user;
 assert.equal(process.env.LOCAL_NAV_ORIGIN,origin);const root='.codex-evidence/cover-paid-20261106-3fd15654';process.env.TEMP=path.resolve(root,'playwright-temp');process.env.TMP=process.env.TEMP;
 const browser=await chromium.launch({headless:true,channel:'msedge'});const report={at:new Date().toISOString(),scope:'one-native-browser-upload-no-prepare-or-paid-analysis',counts:{upload:0,blockedOtherWrites:0},passed:false};
 try{const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});await context.addCookies([{name:'auth_token',value:token,url:origin,httpOnly:true,sameSite:'Lax'}]);
 await context.addInitScript(({token,user})=>{localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));sessionStorage.setItem('entered_app','1');},{token,user});
 await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==origin)return route.abort();if(u.pathname==='/api/auth/me')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,user})});
  if(u.pathname==='/api/cover/materials'&&req.method()==='POST'){assert.equal(++report.counts.upload,1);const b=req.postDataBuffer(),s=b?.subarray(0,300).toString('latin1');report.multipart={bytes:b?.length,hasFileField:/name="file"; filename="[^"]+"/u.test(s||''),mime:req.headers()['content-type']?.split(';')[0]};return route.continue();}
  if(!['GET','HEAD'].includes(req.method())){report.counts.blockedOtherWrites++;return route.abort();}return route.continue();});
 const page=await context.newPage();await page.goto(origin+'/cover',{waitUntil:'networkidle'});await page.getByRole('button',{name:'参考封面',exact:true}).click();
 const uploading=page.waitForResponse(r=>r.url().endsWith('/api/cover/materials')&&r.request().method()==='POST');await page.locator('input[type="file"]').setInputFiles(path.resolve(root,'four-modes/warm_story/downloaded-cover.png'));const response=await uploading;const b=await response.json();report.response={httpStatus:response.status(),success:b.success,error:b.error,code:b.code,assetId:b.assetId,width:b.width,height:b.height};
 report.passed=response.ok()&&b.success===true;
 }finally{await browser.close();const text=JSON.stringify(report,null,2);assert.ok(!text.includes(token));await fs.writeFile(path.join(root,'native-upload-probe.json'),text+'\n',{flag:'wx'});console.log(JSON.stringify(report));}
}
