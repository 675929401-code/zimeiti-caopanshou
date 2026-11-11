import {chromium}from'playwright';import fs from'node:fs/promises';import path from'node:path';import crypto from'node:crypto';
export async function main(){
 const taskTemp=path.resolve('.codex-evidence/cover-paid-20261106-3fd15654/playwright-temp');await fs.mkdir(taskTemp,{recursive:true});process.env.TEMP=taskTemp;process.env.TMP=taskTemp;
 const destination=path.join(process.env.USERPROFILE,'Downloads','CodexCoverAcceptance');await fs.mkdir(destination,{recursive:true});
 const profile=path.join(taskTemp,'persistent-'+crypto.randomUUID());
 const context=await chromium.launchPersistentContext(profile,{headless:true,channel:'msedge',acceptDownloads:true,downloadsPath:destination});
 try{const page=context.pages()[0];await page.goto('http://127.0.0.1:5000/version.json');await page.setContent('<button>download</button>');await page.evaluate(()=>document.querySelector('button').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['diagnostic'],{type:'text/plain'}));a.download='cover-diagnostic.txt';a.click();});
 const wait=page.waitForEvent('download');await page.click('button');const item=await wait;const failure=await item.failure();if(!failure)await item.saveAs(path.resolve('.codex-evidence/cover-paid-20261106-3fd15654/original-download/native-download-proof.txt'));
 console.log(JSON.stringify({scope:'normal-profile-default-download-folder-no-model',failure,filename:item.suggestedFilename(),saved:!failure}));
 }finally{await context.close();}
}
