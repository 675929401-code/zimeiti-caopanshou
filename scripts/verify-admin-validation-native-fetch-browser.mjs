import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const ts=require('typescript'),{chromium}=require('playwright');
const source=fs.readFileSync(path.join(root,'src/lib/admin-image-validation-reference.ts'),'utf8');
const tree=ts.createSourceFile('helper.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const selected=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&['sameAdminValidationReferenceScope','resolveAdminValidationReference'].includes(node.name?.text));
assert.equal(selected.length,2);
const actualCode=ts.transpileModule(selected.map(node=>node.getText(tree).replace(/^export\s+/u,'')).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const browser=await chromium.launch({headless:true,executablePath:'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe'});
const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
let ownerGets=0,fixturePosts=0,blockedRequests=0;
const origin='http://receiver-fixture.invalid';
await context.route('**/*',async route=>{
 const request=route.request(),url=new URL(request.url());
 if(url.origin!==origin){blockedRequests++;return route.abort();}
 if(request.method()==='GET'&&url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Isolated fetch receiver regression</title>'});
 if(request.method()==='GET'&&url.pathname==='/probe')return route.fulfill({status:200,body:'ok'});
 if(request.method()==='GET'&&url.pathname==='/api/storyboard/image'){
  ownerGets++;assert.equal(url.searchParams.get('storageKey'),'images/fixture.png');
  return route.fulfill({status:200,json:{assetId:'bb548089-56fe-4ca3-872c-83fd47cb6456',storageKey:'images/fixture.png',url:'https://image-fixture.invalid/fixture.png?signature=full'}});
 }
 if(request.method()==='POST'&&url.pathname==='/api/storage/upload'){
  fixturePosts++;return route.fulfill({status:200,json:{success:true,file:{key:'images/fixture.png',url:''}}});
 }
 blockedRequests++;return route.abort();
});
try{
 await page.goto(origin);
 const results=await page.evaluate(async code=>{
  const native=window.fetch;let invalidReceiver='';
  try{await({fetcher:native}).fetcher('/probe');}catch(error){invalidReceiver=error.message;}
  const detached=native;const detachedResult=await(await detached('/probe')).text();
  const resolve=new Function(code+';return resolveAdminValidationReference;')();
  const scope={userId:'fixture-owner',modelId:'fixture-model',configurationHash:'a'.repeat(64),index:0};
  const records=[];
  const base={scope,token:'fixture-token',fetcher:native,persist:receipt=>records.push(receipt),stillCurrent:()=>true,decode:async()=>{}};
  const read=await resolve({...base,pending:{...scope,status:'uploaded',storageKey:'images/fixture.png'}});
  const uploaded=await resolve({...base,file:new File([new Uint8Array([1,2,3])],'fixture.png',{type:'image/png'})});
  return{invalidReceiver,detachedResult,readAssetId:read.assetId,uploadedAssetId:uploaded.assetId,records:records.map(item=>({status:item.status,storageKey:item.storageKey}))};
 },actualCode);
 assert.match(results.invalidReceiver,/Illegal invocation/u);
 assert.equal(results.detachedResult,'ok');
 assert.equal(results.readAssetId,'bb548089-56fe-4ca3-872c-83fd47cb6456');
 assert.equal(results.uploadedAssetId,results.readAssetId);
 assert.equal(ownerGets,2);assert.equal(fixturePosts,1);assert.equal(blockedRequests,0);
 assert.ok(results.records.some(item=>item.status==='uploaded'&&item.storageKey==='images/fixture.png'));
 console.log(JSON.stringify({status:'PASS',checks:6,scope:'Real Chromium native Window.fetch, actual extracted product helper; all HTTP intercepted in isolated .invalid fixture context; no app/login/network/provider/DB execution',negativeMemberReceiver:results.invalidReceiver,actualHelperOwnerGets:ownerGets,fixtureUploadPosts:fixturePosts,realUploads:0,realProviderCalls:0,realDatabaseWrites:0}));
}finally{await context.close();await browser.close();}
