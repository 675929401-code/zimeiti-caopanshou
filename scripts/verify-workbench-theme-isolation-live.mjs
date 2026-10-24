import {createRequire} from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL, fileURLToPath} from "node:url";
const repo=fileURLToPath(new URL("../",import.meta.url));
const require=createRequire(pathToFileURL(repo+"/package.json"));
const {chromium}=require("playwright");
const sharp=require("sharp");
const origin="http://127.0.0.1:5000";
const evidence=path.resolve(process.env.THEME_ISOLATION_EVIDENCE_DIR || path.join(repo,"../运行日志/主题视觉验收"));
const buildId=(await fs.readFile(repo+"/.next/BUILD_ID","utf8")).trim();
const sourceVersion=JSON.parse(await fs.readFile(repo+"/public/version.json","utf8")).sourceVersion;
const out=path.join(evidence,"visual-matrix-"+sourceVersion+"-"+Date.now());
await fs.mkdir(out,{recursive:true});
const themes=[{id:"lattice",mode:"dark",rgb:"rgb(16, 36, 58)"},{id:"soft-white",mode:"light",rgb:"rgb(243, 244, 239)"},{id:"crystal-aurora",mode:"dark",rgb:"rgb(5, 7, 10)"}];
const routes=[
{path:"/tools",root:'[data-page="tools"]',primary:true},
{path:"/storyboard-workbench",root:".sbw-root:not(.sbw-model-dialog)",primary:true},
{path:"/image-workbench",root:".image-workbench-root",primary:true},
{path:"/video",root:".secondary-workbench",primary:true},
{path:"/voice-studio/workspace",root:".vs-studio-shell",primary:true},
{path:"/cover",root:".cover-rebuild-shell",primary:true},
{path:"/tools/utility",root:'[data-page="tools-utility"]'},
{path:"/media-history",root:".media-history-page"},
{path:"/help",root:".help-page"},
{path:"/announcements",root:'[data-testid="announcement-reading-center"]'},
{path:"/creation-center",root:'[data-page="creation-center"]'},
{path:"/tools/video/video-edit",root:'[data-testid="local-video-editor"]'},
{path:"/tools/video/aliyun-erase-subtitles",root:'[data-testid="subtitle-remover-workbench"]'},
{path:"/tools/image",root:'[data-official-tool-directory="true"]'},
{path:"/youcai/tools/video/video-edit",root:'[data-testid="local-video-editor"]',excluded:true},
{path:"/commerce/rebuild",root:".commerce-root",excluded:true}
];
const user={id:"theme-matrix-fixture",username:"theme_matrix",displayName:"视觉验收会话",role:"admin",status:"active",is_active:true,credits:0};
const permission={permission:{userId:user.id,role:"admin",featureNavigationKeys:["marketplace","toolbox","storyboard_workbench","image_workbench","create","voice","cover","youcai","commerce_agent"],agentNavigationKeys:["商业IP定位","task:影像编导","task:文案创作","task:获客转化","自用"],revision:1,checksum:"theme-matrix",integrityValid:true,authorityStatus:"admin"}};
const report={buildId,sourceVersion,fixture:true,realCatalogReads:true,realGenerationTested:false,providerCalls:0,serverWrites:0,routes:[],failures:[],blockedRequests:[],pageErrors:[],consoleErrors:[],httpErrors:[]};
const browser=await chromium.launch({headless:true});

async function gridPoints(page,selector){
 return page.evaluate(selector=>{
  const root=document.querySelector(selector);if(!root)return [];
  const points=[];
  for(let y=64;y<Math.min(innerHeight-20,860);y+=16){
   for(let x=4;x<innerWidth-20;x+=16){
    let e=document.elementFromPoint(x,y),clear=true;
    while(e&&e!==root){
     const s=getComputedStyle(e);
     if(s.backgroundImage!=="none"||s.backgroundColor!=="rgba(0, 0, 0, 0)"||s.backdropFilter!=="none"){clear=false;break;}
     e=e.parentElement;
    }
    if(e===root&&clear)points.push({x,y});
   }
  }
  // Sample the rendered field itself, avoiding the scrollbar.
  return points;
 },selector);
}
async function compareFieldPixels(before,after,beforePoints,afterPoints){
 const visible=new Set(afterPoints.map(p=>p.x+":"+p.y));
 const points=beforePoints.filter(p=>visible.has(p.x+":"+p.y));
 const a=await sharp(before).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const b=await sharp(after).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 let changed=0;
 for(const p of points){const i=(p.y*a.info.width+p.x)*4,j=(p.y*b.info.width+p.x)*4;if([0,1,2].some(k=>Math.abs(a.data[i+k]-b.data[j+k])>3))changed++;}
 return {samples:points.length,changed,changedFraction:points.length?changed/points.length:null};
}

const check=(condition,message)=>{if(!condition)report.failures.push(message);};
try{
 for(const ri of routes.filter(r=>!process.env.THEME_ISOLATION_ROUTES || process.env.THEME_ISOLATION_ROUTES.split(",").includes(r.path))){
  let theme=themes[0];let showCoverHistoryRecord=false;
  const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:"block"});
  await context.addInitScript(({user})=>{localStorage.setItem("auth_token","visual-theme-fixture");localStorage.setItem("auth_user",JSON.stringify(user));localStorage.setItem("entered_app","1");sessionStorage.setItem("entered_app","1");localStorage.setItem("platform_theme","lattice");localStorage.setItem("platform_theme_mode","dark");},{user});
  const page=await context.newPage();
  page.on("response",r=>{if(r.status()>=400)report.httpErrors.push({route:ri.path,url:r.url(),status:r.status()})});
  page.on("pageerror",e=>report.pageErrors.push({route:ri.path,message:e.message}));
  page.on("console",m=>{if(m.type()==="error")report.consoleErrors.push({route:ri.path,message:m.text()})});
  await page.route("**/*",async route=>{
    const req=route.request(),u=new URL(req.url());
    if(u.origin!==origin&&/^https?:$/.test(u.protocol))return route.abort("blockedbyclient");
    if(!u.pathname.startsWith("/api/"))return route.continue();
    if(req.method()!=="GET"){
      if(!["/api/product-usage/events","/api/client-error-report"].includes(u.pathname))report.blockedRequests.push({path:u.pathname,method:req.method(),route:ri.path});
      return route.fulfill({status:204,body:""});
    }
    if(["/api/cover-models","/api/video/models","/api/voice/pricing","/api/voice/list","/api/help"].includes(u.pathname))return route.continue();
    let body={};
    if(u.pathname==="/api/auth/me")body={user:{...user,themePreference:theme.id,themeModePreference:theme.mode,themePreferenceExpiresAt:"2099-01-01T00:00:00.000Z"}};
    else if(u.pathname==="/api/member-permissions")body=permission;
    else if(u.pathname==="/api/settings"||u.pathname==="/api/settings/appearance")body={settings:{theme:theme.id,theme_mode:theme.mode}};
    else if(u.pathname==="/api/version")return route.continue();
    else if(u.pathname==="/api/credits")body={credits:0,cash_balance:0};
    else if(u.pathname==="/api/cash/balance")body={balance:0,cashBalance:0};
    else if(u.pathname==="/api/bots")body={agents:[],navigationKeys:permission.permission.agentNavigationKeys};
    else if(u.pathname==="/api/help")body={articles:[],categories:[],media:[]};
    else if(u.pathname==="/api/tools/runtime-catalog")body={items:{text:{available:true,service:"视觉验收配置",unitPrice:0,currency:"CNY",unit:"次"},video:{available:true,service:"视觉验收配置",unitPrice:0,currency:"CNY",unit:"次"}}};
    else if(u.pathname==="/api/categories")body={categories:[]};
    else if(u.pathname==="/api/nav-items")body={items:[]};
    else if(u.pathname.includes("models"))body={models:[]};
    else if(u.pathname==="/api/notifications")body={notifications:[]};
    else if(u.pathname==="/api/announcements")body={announcements:[]};
    else if(u.pathname==="/api/extract/history")body={records:[],next:null,retryReady:true};
    else if(u.pathname==="/api/formatter/history")body={records:[],history:[]};
    else if(u.pathname==="/api/segmenter/history")body={history:[]};
    else if(u.pathname==="/api/image-workbench/history"||u.pathname==="/api/image-workbench/failure-history")body={records:[],nextPage:null};
    else if(u.pathname==="/api/cover/history")body={records:showCoverHistoryRecord?[{...{"id":"theme-cover-failed-fixture","ratio":"16:9","title":"主题验收记录","subtitle":"仅展示","prompt":"主题视觉验收 fixture","source":"生成","taskNo":1,"status":"failed","error":"仅用于配色验收的展示记录","failureRecordId":"0000000000000000000000000000000000000000000000000000000000000000","publicModelId":"pm_theme_fixture","modelName":"主题验收模型","resolution":"2K","referenceAssetRefs":[],"referenceCount":0,"quotedPriceYuan":0,"billing":{"state":"not_charged","referenceId":"fixture-only-no-charge"},"canLoadForRetry":false,"retryBlockReason":"仅展示记录，不可载入或重试","cancellable":false,"cloudStored":false},createdAt:new Date().toISOString()}]:[],activeAttempt:null,activeAttempts:[],activeAttemptReady:true,failureHistory:{ready:true},nextPage:null};
    else if(u.pathname==="/api/voice/history")body={success:true,data:{items:[],total:0}};
    else if(u.pathname==="/api/commerce/v2/catalog")body={schema:"commerce-catalog/v2",workspaceKey:"theme-acceptance",directors:[],models:{video:[],image:[],agent:[]},boundaries:{paidSubmissionEnabled:false,reason:"主题验收fixture"}};
    else if(u.pathname==="/api/commerce/v2/assets")body={schema:"commerce-assets/v2",assets:[]};
    else if(u.pathname.includes("history"))body={tasks:[],items:[],nextOffset:null};
    else if(u.pathname.includes("projects"))body={projects:[],nextOffset:null};
    else if(u.pathname.includes("assets")||u.pathname.includes("presets"))body={assets:[],presets:[]};
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
  });
  const response=await page.goto(origin+ri.path,{waitUntil:"domcontentloaded",timeout:45000});
  await page.waitForTimeout(1100);
  const rr={path:ri.path,http:response.status(),themes:[]};
  for(const next of themes){
   theme=next;
   // The fixture emulates an already-saved preference; wait out the 1500ms auth bootstrap cache.
   await page.waitForTimeout(1600);
   await page.evaluate(()=>window.dispatchEvent(new Event("theme-updated")));
   await page.waitForFunction(({id,mode})=>document.documentElement.dataset.theme===id&&document.documentElement.dataset.mode===mode,theme,{timeout:15000}).catch(e=>report.failures.push(ri.path+" switch "+theme.id+": "+e.message));
   await page.waitForTimeout(550);
   const view=await page.evaluate(({selector})=>{
     const root=document.querySelector(selector),header=document.querySelector(".sub-page-header,.vs-studio-header,.cover-rebuild-topbar");
     const style=e=>{if(!e)return null;const s=getComputedStyle(e);return {background:s.backgroundColor,image:s.backgroundImage,size:s.backgroundSize,attachment:s.backgroundAttachment,position:s.backgroundPosition,color:s.color,border:s.borderTopColor,opacity:s.opacity,transform:s.transform,animation:s.animationName};};
     const canvas=document.createElement("canvas");canvas.width=canvas.height=1;const ctx=canvas.getContext("2d");
     const color=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
     const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
     const contrast=e=>{const s=getComputedStyle(e),fg=color(s.color),bg=color(s.backgroundColor);if(bg[3]<250)return null;const a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
     const buttons=[...document.querySelectorAll("button,a[role=button]")].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<900&&r.bottom>0;}).map(e=>({text:e.textContent.trim().slice(0,35),class:e.className,disabled:e.disabled||e.getAttribute("aria-disabled")==="true",active:e.getAttribute("data-active")||e.getAttribute("aria-pressed"),contrast:contrast(e),backgroundLuminance:lum(color(getComputedStyle(e).backgroundColor)),...style(e)}));
     return {theme:document.documentElement.dataset.theme,mode:document.documentElement.dataset.mode,root:style(root),header:style(header),rootClass:root?.className,text:document.body.innerText.length,overflow:document.documentElement.scrollWidth>innerWidth+2,buttons,innerFields:[...document.querySelectorAll(".workspace-depth-frame,.toolbox-embedded-workspace,.vs-studio-main .secondary-workbench")].map(style),dialogCount:document.querySelectorAll("dialog[open],[role=dialog]").length};
   },{selector:ri.root});
   const key=theme.id+ri.path.replaceAll("/","_");
   const mainFile=path.join(out,key+".png");
   await page.screenshot({path:mainFile,fullPage:false});
   check(view.theme===theme.id,ri.path+" "+theme.id+" theme mismatch");
   check(view.text>20,ri.path+" "+theme.id+" empty page");
   check(!view.overflow,ri.path+" "+theme.id+" horizontal overflow");
   if(!ri.excluded){
    check(!!view.root,ri.path+" "+theme.id+" root missing");
    check(view.root?.background===theme.rgb,ri.path+" "+theme.id+" field color "+view.root?.background);
    check(view.root?.size==="64px 64px, 64px 64px, 100% 100%, 100% 100%",ri.path+" "+theme.id+" grid size "+view.root?.size);
    check(view.root?.attachment.split(", ").every(v=>v==="fixed"),ri.path+" "+theme.id+" grid not fixed");
    for(const b of view.buttons.filter(b=>String(b.class).includes("sub-page-open")||String(b.class).includes("sub-page-nav-button")&&b.active!=="true")){
     if(theme.mode==="light"){
       check(b.backgroundLuminance>=.45,ri.path+" "+theme.id+" dark secondary button "+b.text+" "+b.background);
     }
    }
    for(const b of view.buttons.filter(b=>!b.disabled&&b.opacity==="1"&&/bg-\[var\(--(?:vs-)?primary\)\]/.test(String(b.class))&&b.contrast!==null))check(b.contrast>=4.5,ri.path+" "+theme.id+" primary contrast "+b.text+" "+b.contrast);
    for(const inner of view.innerFields)check(inner.image==="none"&&inner.background==="rgba(0, 0, 0, 0)",ri.path+" "+theme.id+" nested field paints background");
   }
   let interactions={};
   if(ri.primary){
    const button=page.locator(".sub-page-open,.vs-studio-home,.cover-rebuild-topbar button").first();
    if(await button.count()){
      await button.hover();await page.waitForTimeout(220);interactions.hover=await button.evaluate(e=>({bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,border:getComputedStyle(e).borderColor}));
      await button.focus();await page.waitForTimeout(180);interactions.focus=await button.evaluate(e=>({outline:getComputedStyle(e).outline,boxShadow:getComputedStyle(e).boxShadow}));
      await page.screenshot({path:path.join(out,key+"-focus.png")});
      await page.locator("body").click({position:{x:1435,y:875},force:true}).catch(()=>{});
    }
    // Isolate the rendered background without changing layout or scroll dimensions.
    // This avoids treating moving card shadows, text and cursors as moving grid pixels.
    const fieldProbe=await page.addStyleTag({content:ri.root+" > *, "+ri.root+" > * * { visibility: hidden !important; }"});
    const pointsBefore=await gridPoints(page,ri.root);
    const before=await page.screenshot({path:path.join(out,key+"-grid-before.png")});
    await page.mouse.move(720,780);
    await page.waitForTimeout(300);
    const afterPointer=await page.screenshot({path:path.join(out,key+"-grid-pointer.png")});
    interactions.gridAfterPointer=await compareFieldPixels(before,afterPointer,pointsBefore,await gridPoints(page,ri.root));
    check(interactions.gridAfterPointer.samples>=3,ri.path+" "+theme.id+" insufficient visible-grid samples");
    check(interactions.gridAfterPointer.changed===0,ri.path+" "+theme.id+" visible grid moved after pointer");
    interactions.scroll=await page.evaluate(()=>{
      const candidates=[document.scrollingElement,...document.querySelectorAll("main,section,div")].filter(e=>{const r=e.getBoundingClientRect();return r.width>200&&r.height>200&&e.scrollHeight>e.clientHeight+60&&(/auto|scroll/.test(getComputedStyle(e).overflowY)||e===document.scrollingElement);});
      for(const e of candidates.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))){const before=e.scrollTop;e.scrollTop=before+180;if(e.scrollTop!==before)return {available:true,before,after:e.scrollTop,tag:e.className||e.tagName};}return {available:false};
    });
    await page.waitForTimeout(250);
    const after=await page.screenshot({path:path.join(out,key+"-grid-scroll.png")});
    interactions.gridAfterScroll=await compareFieldPixels(before,after,pointsBefore,await gridPoints(page,ri.root));
    check(interactions.gridAfterScroll.samples>=3,ri.path+" "+theme.id+" insufficient grid samples after scroll");
    check(interactions.gridAfterScroll.changed===0,ri.path+" "+theme.id+" visible grid moved after scroll");
    interactions.fieldAfter=await page.locator(ri.root).first().evaluate(e=>({attachment:getComputedStyle(e).backgroundAttachment,position:getComputedStyle(e).backgroundPosition}));
    check(interactions.fieldAfter.attachment===view.root.attachment&&interactions.fieldAfter.position===view.root.position,ri.path+" "+theme.id+" background moved");
    await fieldProbe.evaluate(e=>e.remove());
    await page.screenshot({path:path.join(out,key+"-scroll.png")});
    await page.evaluate(()=>{for(const e of [document.scrollingElement,...document.querySelectorAll("main,section,div")])if(e.scrollTop)e.scrollTop=0;});
   }

   if(ri.primary){
    const history=ri.path==="/voice-studio/workspace" ? page.locator('button[aria-controls="voice-generation-history-content"]') : page.getByRole("button",{name:/^历史(记录)?$/}).first();
    check(await history.count()>0,ri.path+" "+theme.id+" history entry missing");
    if(await history.count()){
      await history.hover();await page.waitForTimeout(180);
      interactions.historyHover=await history.evaluate(e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}));
      await history.click();await page.waitForTimeout(600);
      interactions.historyOpen=await page.evaluate(()=>({dialogCount:document.querySelectorAll('[role="dialog"],dialog[open]').length,activeNavigation:[...document.querySelectorAll('.sub-page-nav-button[data-active="true"]')].map(e=>({text:e.textContent,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor})),panels:[...document.querySelectorAll('[role="dialog"],dialog[open]')].map(e=>({text:e.textContent.slice(0,80),color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}))}));
      if(ri.path==="/voice-studio/workspace")await page.locator('#voice-generation-history-content').scrollIntoViewIfNeeded();
      const historyVisible=await page.evaluate(()=>{
        const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=="hidden";
        return [...document.querySelectorAll('[role="dialog"],#voice-generation-history-content,h2,h3,p,[data-active="true"]')].some(e=>visible(e)&&/历史|记录/.test(e.textContent))||[...document.querySelectorAll('button')].some(e=>visible(e)&&/清空历史|清空记录/.test(e.textContent));
      });
      check(historyVisible,ri.path+" "+theme.id+" history content not visible");
      const historyText=await page.locator("body").innerText();
      check(!/生成历史返回的数据格式异常|历史读取失败|历史暂时无法读取|失败历史状态缺失/.test(historyText),ri.path+" "+theme.id+" history fixture failed to render");
      await page.screenshot({path:path.join(out,key+"-history.png")});
      if(ri.path==="/cover"){
        showCoverHistoryRecord=true;
        await page.getByRole("button",{name:"刷新历史",exact:true}).click();await page.waitForTimeout(450);
        const historyItem=page.locator(".cover-task-strip button").first();
        check(await historyItem.count()>0,theme.id+" cover history item missing");
        if(await historyItem.count()){
          await historyItem.click();await page.waitForTimeout(200);
          interactions.coverHistoryItem=await historyItem.evaluate(e=>({class:e.className,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,text:e.textContent}));
        }
        await page.screenshot({path:path.join(out,key+"-history-record.png")});
        showCoverHistoryRecord=false;
      }
      await page.reload({waitUntil:"domcontentloaded"});await page.waitForTimeout(800);
    }
   }
   rr.themes.push({theme:theme.id,view,interactions,screenshot:mainFile});
  }
  report.routes.push(rr);
  await fs.writeFile(path.join(out,"report.json"),JSON.stringify(report,null,2));
  console.log(ri.path+" "+rr.themes.map(t=>t.theme+":"+t.view.root?.background).join(" | "));
  await context.close();
 }
}finally{await browser.close();}
report.passed=report.failures.length===0&&report.pageErrors.length===0&&report.consoleErrors.length===0&&report.httpErrors.length===0&&report.blockedRequests.length===0;
await fs.writeFile(path.join(out,"report.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,buildId,sourceVersion,routeCount:report.routes.length,themeViews:report.routes.reduce((a,r)=>a+r.themes.length,0),failures:report.failures,pageErrors:report.pageErrors,consoleErrors:report.consoleErrors,httpErrors:report.httpErrors,blockedRequests:report.blockedRequests,out},null,2));

if(!report.passed)process.exitCode=1;
