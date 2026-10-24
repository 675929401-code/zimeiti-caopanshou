import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { buildStoryboardThreeViewPrompt } from '../src/lib/storyboard-visual-asset-three-view.ts';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

// All business writes below stay in browser RAM. These are engineering fixtures, not generated media.
export async function main() {
  const origin=process.env.LOCAL_NAV_ORIGIN;
  const token=process.env.LOCAL_NAV_ADMIN_TOKEN;
  const user=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY).user;
  assert.equal(origin,'http://127.0.0.1:5000'); assert.ok(token);
  const fixtureRoot='.codex-evidence/director-refinement-20261023';
  const energy=process.argv.includes('--energy-check');
  const directory=`${fixtureRoot}/${energy?'energy-followup':'mode-followup'}`;
  const output=`${directory}/mode-browser`;
  await fs.mkdir(output,{recursive:true});
  const pins=JSON.parse(await fs.readFile('.next/local-source-fingerprint.v1.json','utf8'));
  assert.equal(pins.fingerprint,computeLocalBuildFingerprint(process.cwd()).fingerprint);
  const template=JSON.parse(await fs.readFile(`${fixtureRoot}/mode-followup/browser-fixture-template.json`,'utf8')).document;
  const ordinaryPackage=JSON.parse(await fs.readFile(`${energy?directory:fixtureRoot}/prompt-ordinary-example.json`,'utf8'));
  const image='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#d7dde4"/><g fill="#566978"><circle cx="160" cy="235" r="65"/><circle cx="480" cy="235" r="65"/><circle cx="800" cy="235" r="65"/></g><text x="480" y="440" text-anchor="middle" font-size="28">ENGINEERING FIXTURE</text></svg>').toString('base64');
  const projects=new Map();
  const report={scope:'isolated_browser_engineering_fixtures_not_live_generation',startedAt:new Date().toISOString(),checks:[],pages:[],blockedGenerationRequests:0,serverBusinessWrites:0,errors:[]};
  let failNextSave=false;
  function make(id,legacy=false) {
    const document=structuredClone(template);
    document.id=id; document.title='工程回放｜导演模式';
    document.createdAt=Date.now(); document.updatedAt=Date.now();
    document.directorIntake.confirmedAssets=[];
    document.visualAssetWorkspace.candidates=document.visualAssetPlan.assets.map((asset,index)=>{
      delete asset.source;
      const historyRecordId=(index?'b':'a').repeat(64);
      const candidate={assetId:`generated_${historyRecordId}`,historyRecordId,planId:asset.id,role:asset.role,name:asset.name,
        prompt:buildStoryboardThreeViewPrompt(asset.role,undefined,asset.referencePrompts.find(ref=>ref.kind==='turnaround').prompt,false),projectId:id,saved:false};
      if(legacy){candidate.assetId=`174631a8-8b13-45f5-b072-f9919b12273${index}`;candidate.storageKey=`engineering/legacy-${index}.png`;asset.source={kind:'generated-image-history',assetId:candidate.assetId,historyRecordId,storageKey:candidate.storageKey};}
      return candidate;
    });
    const project={id,title:document.title,revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),cardCount:document.cards.length,document};
    projects.set(id,project); return project;
  }
  const assets=make('storyboard-run_engineering-confirm-assets');
  const legacy=make('storyboard-run_engineering-confirm-legacy',true);
  const ordinary=make('storyboard-run_engineering-confirm-ordinary');
  delete ordinary.document.directorIntake;
  ordinary.document.visualAssetPlan={mode:'off',assets:[]}; ordinary.document.visualAssetWorkspace={drafts:[],candidates:[]};
  ordinary.document.imageRatio=ordinaryPackage.input.aspect_ratio;
  ordinary.document.cards[0].visualAssetRefs=[];
  ordinary.document.cards[0].imagePrompt=ordinaryPackage.segments[0].storyboard_image_prompt;
  ordinary.document.cards[0].videoPrompt=ordinaryPackage.segments[0].image_to_video_prompt;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block',permissions:['clipboard-read','clipboard-write']});
  await context.addInitScript(({token,user})=>{localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));localStorage.setItem('active_view','marketplace');sessionStorage.setItem('entered_app','1');},{token,user});
  await context.addCookies([{name:'auth_token',value:token,url:origin,httpOnly:true,sameSite:'Lax'}]);
  await context.route('**/api/**',async route=>{
    const request=route.request(); const url=new URL(request.url());
    const respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/auth/me')return respond({user:{...user,credits:0,reservedCredits:0,is_active:true,status:'active',memberStatus:'inactive',allowedCategories:[],themePreference:null,themeModePreference:null,themePreferenceStatus:'missing'}});
    if(request.method()==='POST'&&/\/api\/(?:llm|image\/generate|video\/generate|video\/submit)$/u.test(url.pathname)){report.blockedGenerationRequests++;return route.abort('blockedbyclient');}
    if(url.pathname==='/api/storyboard/projects') {
      if(request.method()==='GET'){const id=url.searchParams.get('id');return id?respond({project:projects.get(id)},projects.has(id)?200:404):respond({projects:[...projects.values()].map(({document,...summary})=>summary),nextOffset:null});}
      if(request.method()==='POST'){
        if(failNextSave){failNextSave=false;return respond({code:'FIXTURE_SAVE_FAILED',error:'工程回放：本次采用保存失败'},503);}
        const {document}=request.postDataJSON(); const previous=projects.get(document.id); assert.ok(previous);
        projects.set(document.id,{...previous,document:structuredClone(document),title:document.title,revision:previous.revision+1});return respond({project:{...projects.get(document.id),document:undefined}});
      }
      return respond({error:'Fixture blocks other project mutations'},403);
    }
    if(url.pathname==='/api/storyboard/director-assets/original'){
      const project=projects.get(url.searchParams.get('projectId')); const asset=project?.document.visualAssetPlan.assets.find(item=>item.id===url.searchParams.get('assetId'));
      if(!asset?.source?.historyRecordId)return respond({error:'Original unavailable'},404);
      const historyRecordId=asset.source.historyRecordId;
      return respond({candidate:{assetId:`generated_${historyRecordId}`,historyRecordId,planId:asset.id,role:asset.role,name:asset.name,
        prompt:buildStoryboardThreeViewPrompt(asset.role,undefined,asset.referencePrompts.find(ref=>ref.kind==='turnaround').prompt,false),projectId:project.id,saved:false,previewUrl:image}});
    }
    if(url.pathname==='/api/storyboard/visual-assets'){
      if(request.method()==='GET')return respond(url.searchParams.has('recordId')?{reference:{recordId:url.searchParams.get('recordId'),previewUrl:image}}:{assets:[],nextOffset:null});
      const value=request.postDataJSON();return respond({asset:{...value,previewUrl:image,saved:true}});
    }
    if(url.pathname==='/api/image-workbench/persist'&&request.method()==='POST')return respond({assetId:'engineering-library-copy',key:'engineering/library-copy.png',url:image});
    if(request.method()!=='GET'&&request.method()!=='HEAD')return respond({ok:true});
    return route.continue();
  });
  const page=await context.newPage();
  page.on('pageerror',error=>report.errors.push(error.message.slice(0,300)));
  const open=async id=>{await page.goto(`${origin}/storyboard-workbench?projectId=${id}`,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'添加分镜',exact:true}).waitFor({state:'visible',timeout:15000});};
  const current=project=>projects.get(project.id).document;
  const slot=role=>page.locator(`.svad-reference-slot[data-role="${role}"]`);
  const capture=async name=>{
    const layout=await page.evaluate(()=>({viewportWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,
      referenceImages:[...document.querySelectorAll('.svad-slot-result img')].map(element=>({fit:getComputedStyle(element).objectFit,loaded:element.complete&&element.naturalWidth>0})),
      frames:[...document.querySelectorAll('.sbw-shared-media-frame')].map(element=>({aspectRatio:getComputedStyle(element).aspectRatio,width:element.clientWidth,height:element.clientHeight}))}));
    assert.ok(layout.documentWidth<=layout.viewportWidth+2,`${name}: horizontal page overflow`);
    assert.ok(layout.referenceImages.every(item=>item.loaded),`${name}: fixture reference image unreadable`);
    report.pages.push({name,url:new URL(page.url()).pathname,...layout});
    await page.screenshot({path:`${output}/${name}.png`});
  };
  try {
    await open(ordinary.id);
    assert.equal(await page.getByTestId('director-assets-first-stage').count(),0);
    assert.equal(await page.getByRole('textbox',{name:'分段1生图提示词',exact:true}).inputValue(),ordinaryPackage.segments[0].storyboard_image_prompt);
    assert.equal(await page.getByRole('textbox',{name:'分段1视频提示词',exact:true}).inputValue(),ordinaryPackage.segments[0].image_to_video_prompt);
    report.checks.push('ordinary mode directly displays its image and video prompts without an asset stage');
    await capture('ordinary');
    await open(assets.id);
    await slot('character').getByRole('button',{name:'使用这张',exact:true}).waitFor({timeout:10000});
    assert.equal(await page.locator('.sbw-shot-card').count(),0);
    await page.getByRole('button',{name:'复制续写卡',exact:true}).click();
    assert.match(await page.locator('body').innerText(),/明确选择采用|确认/u);
    const originalPrompt=current(assets).visualAssetWorkspace.candidates[0].prompt;
    await slot('character').getByRole('button',{name:'保存到图库',exact:true}).click();
    await page.waitForTimeout(500);
    assert.equal(current(assets).visualAssetWorkspace.candidates.find(item=>item.role==='character').prompt,originalPrompt);
    assert.equal(current(assets).visualAssetPlan.assets[0].source,undefined);
    await slot('character').getByRole('button',{name:'使用这张',exact:true}).click();
    await page.waitForTimeout(400);
    assert.equal(current(assets).directorIntake.confirmedAssets.length,1);
    report.checks.push('generated candidates stay unconfirmed; saving the first image to the library preserves the original proof before explicit Apply');
    failNextSave=true;
    await slot('pet').getByRole('button',{name:'使用这张',exact:true}).click();
    await page.waitForTimeout(500);
    assert.equal(current(assets).directorIntake.confirmedAssets.length,1);
    assert.equal(current(assets).visualAssetPlan.assets[1].source,undefined);
    await slot('pet').getByRole('button',{name:'使用这张',exact:true}).click();
    await page.waitForTimeout(400);
    assert.equal(current(assets).directorIntake.confirmedAssets.length,2);
    const confirmed=structuredClone(current(assets).directorIntake.confirmedAssets);
    await slot('pet').getByRole('button',{name:'保存到图库',exact:true}).click();
    await page.waitForTimeout(500);
    assert.deepEqual(current(assets).directorIntake.confirmedAssets,confirmed);
    assert.ok(current(assets).visualAssetPlan.assets.every(asset=>asset.source.assetId===`generated_${asset.source.historyRecordId}`&&!asset.source.storageKey));
    await page.getByRole('button',{name:'复制续写卡',exact:true}).click();
    assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/director_assets_receipt/u);
    report.checks.push('failed Apply save retains previous confirmation; both explicit confirmations enable resume; library export after confirmation retains canonical sources');
    await page.reload({waitUntil:'domcontentloaded'});await page.waitForTimeout(600);
    assert.equal(current(assets).directorIntake.confirmedAssets.length,2);
    await capture('confirmed-assets');
    await open(legacy.id);
    await page.getByRole('button',{name:'恢复原生成图',exact:true}).click({timeout:10000});
    await page.waitForTimeout(600);
    assert.ok(current(legacy).visualAssetWorkspace.candidates.every(item=>item.assetId===`generated_${item.historyRecordId}`&&!item.storageKey));
    assert.equal(current(legacy).directorIntake.confirmedAssets.length,0);
    assert.ok(current(legacy).visualAssetPlan.assets.every(asset=>asset.source.assetId.startsWith('174631a8-')));
    await slot('character').getByRole('button',{name:'使用这张',exact:true}).click();await page.waitForTimeout(300);
    await slot('pet').getByRole('button',{name:'使用这张',exact:true}).click();await page.waitForTimeout(300);
    assert.equal(current(legacy).directorIntake.confirmedAssets.length,2);
    report.checks.push('legacy library sources recover original generation previews and still require separate explicit Apply');
    await capture('recovered-assets');
    for(const [name,path] of [['history','/storyboard-workbench/history'],['video','/video']]){
      await page.goto(origin+path,{waitUntil:'domcontentloaded'});
      await page.getByRole('heading',{name:name==='history'?'分镜历史':'AI 视频创作台',exact:true}).waitFor({state:'visible',timeout:15000});
      await page.waitForTimeout(300);await capture(name);
    }
    assert.equal(report.blockedGenerationRequests,0);assert.deepEqual(report.errors,[]);
    assert.equal(pins.fingerprint,computeLocalBuildFingerprint(process.cwd()).fingerprint);
    report.runtime=await(await context.request.get(`${origin}/api/version`)).json();report.passed=true;
  } catch(error) {
    report.failure=error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error);
    await page.screenshot({path:`${output}/failure.png`}).catch(()=>undefined);
    throw error;
  } finally {
    report.finishedAt=new Date().toISOString();await fs.writeFile(`${output}/result.json`,JSON.stringify(report,null,2));await browser.close();
  }
  console.log(JSON.stringify(report,null,2));
}
