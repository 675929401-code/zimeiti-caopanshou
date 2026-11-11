import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function main(){
 const taskTemp=path.resolve('.codex-evidence/cover-paid-20261106-3fd15654/playwright-temp');await fs.mkdir(taskTemp,{recursive:true});process.env.TEMP=taskTemp;process.env.TMP=taskTemp;
 const nativeDownloads=path.join(process.env.USERPROFILE,'Downloads','CodexCoverAcceptance');await fs.mkdir(nativeDownloads,{recursive:true});
 const browser=await chromium.launch({headless:true,channel:'msedge',downloadsPath:nativeDownloads});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 const report={scope:'browser-blob-download-only-no-product-or-model',cases:[],browser:chromium.executablePath()};
 try{
  const downloadPath=path.resolve('.codex-evidence/cover-paid-20261106-3fd15654/original-download/browser-downloads');await fs.mkdir(downloadPath,{recursive:true});
  const cdp=await context.newCDPSession(page);const {targetInfo}=await cdp.send('Target.getTargetInfo');
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allowAndName',browserContextId:targetInfo.browserContextId,downloadPath:nativeDownloads,eventsEnabled:true});
  await page.goto('http://127.0.0.1:5000/version.json');
  await page.setContent('<button id="test">download</button>');
  for(const name of ['plain.txt','封面-测试.txt']){
   await page.evaluate(name=>{document.querySelector('#test').onclick=()=>{const anchor=document.createElement('a');anchor.href=URL.createObjectURL(new Blob(['local download diagnostic'],{type:'text/plain'}));anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();};},name);
   const waiting=page.waitForEvent('download');await page.click('#test');const item=await waiting;
   const failure=await item.failure();let saved=false;
   if(!failure){await item.saveAs('.codex-evidence/cover-paid-20261106-3fd15654/original-download/'+name);saved=true;}
   report.cases.push({name,failure,saved,urlProtocol:new URL(item.url()).protocol});
  }
  await page.evaluate(()=>{document.querySelector('#test').onclick=()=>{const a=document.createElement('a');a.href='/version.json';a.download='version.json';document.body.append(a);a.click();a.remove();};});
  const waiting=page.waitForEvent('download');await page.click('#test');const item=await waiting;report.cases.push({name:'http-version.json',failure:await item.failure(),urlProtocol:new URL(item.url()).protocol});
 }finally{await browser.close();await fs.writeFile('.codex-evidence/cover-paid-20261106-3fd15654/original-download/download-environment-diagnostic.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
}
