import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import 'server-only';
import { isIP } from 'node:net';
import { isBlockedIpAddress } from '../safe-fetch';
import { fetchPinnedPublicAddress, lookupFixedPublicDns } from '../safe-fetch-public-dns';
export const ORIGIN='https://zyuani8.com';
export const routes=Object.freeze({
  version:'/api/version', agents:'/api/bots?shape=agents', categories:'/api/categories',
  branding:'/api/branding', appearance:'/api/settings/appearance', layout:'/api/settings/layout',
  navigation:'/api/nav-items', shortcuts:'/api/shortcuts', site:'/api/site-config',
  settings:'/api/settings', manju:'/api/youcai/runtime-config?environment=production', help:'/api/help',chatModels:'/api/chat-models',
  imageWorkbench:'/api/cover-models?surface=image-workbench', videoPage:'/api/video/models?surface=video-page',
  storyboardImages:'/api/cover-models?surface=storyboard-workbench', storyboardVideo:'/api/video/models?surface=storyboard-workbench',
  voicePrices:'/api/voice/pricing',
});
const maximum=2*1024*1024, ageLimit=90000;
const forbidden=new Set(['systemprompt','admintoken','adminnotes','cozecodingapitoken','apikey','apisecret','password','passwordhash','secret','accesstoken','refreshtoken','authorization','sessionid','tokenhash','privatekey','servicerolekey','useremail','walletbalance','proxyurl','clientsecret','cookie','setcookie','databaseurl','connectionstring','credentials','jwtsecret','secretaccesskey']);
export const canonical=x=>JSON.stringify(x,(_,y)=>y && typeof y==='object' && !Array.isArray(y)?Object.fromEntries(Object.keys(y).sort().map(k=>[k,y[k]])):y);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function publicFields(x){
  if(typeof x==='string')assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]+|\bsk-[A-Za-z0-9]{16,}/iu.test(x),'PROTECTED_VALUE_IN_PUBLIC_PROJECTION');
  if(typeof x==='string')assert.ok(!/[?&](?:sig|signature|token|access_token|api[-_]?key|x-amz-[a-z-]+|x-goog-[a-z-]+)=/iu.test(x),'SIGNED_OR_CREDENTIAL_URL_IN_PUBLIC_PROJECTION');
  if(!x||typeof x!=='object')return;
  for(const [key,value] of Object.entries(x)){
    assert.ok(!forbidden.has(key.toLowerCase().replace(/[^a-z0-9]/g,'')),'PROTECTED_FIELD_IN_PUBLIC_PROJECTION');
    publicFields(value);
  }
}
export function project(kind,body){
  assert.ok(Object.hasOwn(routes,kind) && body && typeof body==='object','INVALID_PUBLISHED_SECTION');
  publicFields(body);
  const array=(key)=>{assert.ok(Array.isArray(body[key]),'INVALID_ARRAY_'+kind);return body[key];};
  if(kind==='version'){
    const pick=Object.fromEntries(['sourceVersion','buildId','releaseId','deployCommitSha'].map(k=>[k,body[k]]));
    assert.ok(Object.values(pick).every(v=>typeof v==='string'&&v.trim())&&/^[a-f0-9]{40}$/.test(pick.deployCommitSha),'UNSIGNED_RELEASE_IDENTITY');
    return pick;
  }
  if(kind==='agents'){
    assert.equal(body.navigationKeys,null,'FORMAL_PUBLIC_AUDIENCE_REQUIRED');
    const rows=array('agents');
    assert.ok(new Set(rows.map(x=>x.id)).size===rows.length && rows.every(x=>typeof x.id==='string' && typeof x.name==='string' && typeof x.category==='string' && x.category!=='自用' && x.user_access!=='hidden' && x.deleted_at===null),'PROTECTED_OR_DUPLICATE_AGENT');
    return {agents:rows,navigationKeys:null};
  }
  if(kind==='categories'){
    const rows=array('categories');
    assert.ok(rows.every(x=>x.is_active===true&&x.name!=='自用'&&['normal','view_only'].includes(x.visibility)) && new Set(rows.map(x=>x.id)).size===rows.length,'PROTECTED_OR_DUPLICATE_CATEGORY');
    return {categories:rows};
  }
  if(kind==='appearance'){assert.ok(body.authority?.authoritative===true&&typeof body.settings?.theme==='string','APPEARANCE_NOT_AUTHORITATIVE');return body;}
  if(kind==='branding'){assert.ok(body.ok===true && body.branding?.brand && body.branding?.source==='published' && body.branding.displayScope==='platform' && body.branding.revisionId,'BRAND_NOT_PUBLISHED');return body;}
  if(kind==='layout'){assert.ok(body.layout?.card&&body.layout?.nav&&body.layout?.category,'INVALID_LAYOUT');return {layout:body.layout};}
  if(kind==='settings'){
    const keys=new Set('theme theme_mode theme_primary_color theme_accent_color theme_gradient_start theme_gradient_mid theme_gradient_end page_layout card_layout video_page_config platform_name platform_cover welcome_message'.split(' '));
    assert.ok(body.settings && Object.keys(body.settings).every(k=>keys.has(k)) && body.authorities?.branding?.source==='published' && body.authorities?.general?.source==='platform_settings','SETTINGS_NOT_PUBLIC');
    const settings={...body.settings},unreadableStructuredSettings=[...(body.unreadableStructuredSettings??[])];
    assert.ok(Array.isArray(body.unreadableStructuredSettings??[])&&unreadableStructuredSettings.every(k=>['page_layout','card_layout','video_page_config'].includes(k)),'INVALID_UNREADABLE_PUBLIC_SETTINGS');
    for(const k of ['page_layout','card_layout','video_page_config'])if(settings[k]){
      let parsed;
      try{parsed=JSON.parse(settings[k]);}catch{delete settings[k];unreadableStructuredSettings.push(k);continue;}
      publicFields(parsed);
    }
    return {settings,authorities:body.authorities,unreadableStructuredSettings};
  }
  if(kind==='manju'){
    assert.ok(body.ok===true && body.state==='ready' && body.environment==='production' && body.etag && Object.keys(body.domains||{}).sort().join(',')==='content,feature_flags,media' && Array.isArray(body.domains.content.navigation),'MANJU_NOT_PUBLISHED');
    return {environment:body.environment,domains:body.domains,etag:body.etag,storage_mode:body.storage_mode,storage_generations:body.storage_generations};
  }
  if(kind==='help'){assert.ok(body.preview===false && Array.isArray(body.articles) && Array.isArray(body.categories) && Array.isArray(body.media),'HELP_NOT_PUBLISHED');return body;}
  if(kind==='chatModels'){assert.ok(Array.isArray(body.models)&&Array.isArray(body.unavailableModels),'CHAT_MODEL_CATALOG_INVALID');return {models:body.models,unavailableModels:body.unavailableModels};}
  if(kind==='navigation')return {navItems:array('navItems')};
  if(kind==='shortcuts')return {shortcuts:array('shortcuts')};
  if(kind==='site'||kind==='voicePrices'){assert.ok(body.success===true && body.data,'INVALID_SECTION_'+kind);return {success:true,data:body.data};}
  // Preserve published surface ordering and current selectability exactly as the public controller produced them.
  assert.ok(Array.isArray(body.models)||Array.isArray(body.data)||Array.isArray(body.data?.models),'INVALID_MEDIA_SURFACE_'+kind);
  return body;
}
export function verifiedResponse(kind,status,headers,bytes,now=Date.now()){
  assert.equal(status,200,'FORMAL_PUBLIC_ENDPOINT_UNAVAILABLE');
  assert.ok(String(headers['content-type']||'').includes('application/json') && bytes.length<=maximum,'INVALID_PUBLIC_RESPONSE');
  const date=Date.parse(headers.date||''),age=Number(headers.age||0);
  assert.ok(Number.isFinite(date)&&Math.abs(now-date)<=ageLimit&&Number.isFinite(age)&&age>=0&&age*1000<=ageLimit,'STALE_PUBLISHED_RESPONSE');
  return project(kind,JSON.parse(bytes.toString('utf8')));
}
/**
 * @param {Readonly<Record<string,string|undefined>>} [env]
 * @param {{lookup?: typeof lookupFixedPublicDns, transport?: typeof fetchPinnedPublicAddress}} [dependencies]
 */
export async function createPublishedReader(env=process.env,dependencies={}){
  const pin=env.FORMAL_CATALOG_ORIGIN_IP?.trim();
  const addresses=pin?[{address:pin,family:isIP(pin)}]:await (dependencies.lookup??lookupFixedPublicDns)(new URL(ORIGIN).hostname);
  assert.ok(addresses.length&&addresses.every(a=>isIP(a.address)===a.family&&[4,6].includes(a.family)&&!isBlockedIpAddress(a.address)),'PUBLISHED_ORIGIN_PIN_INVALID');
  const address=addresses.find(a=>a.family===4)??addresses[0];
  const transport=dependencies.transport??fetchPinnedPublicAddress;
  return async kind=>{
    assert.ok(Object.hasOwn(routes,kind),'UNAPPROVED_PUBLISHED_READ');
    const response=await transport(new URL(routes[kind],ORIGIN),address,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',headers:{Accept:'application/json','Cache-Control':'no-cache'},signal:AbortSignal.timeout(12000)});
    if(response.status!==200||!response.body){await response.body?.cancel();throw Error('PUBLISHED_RESPONSE_UNAVAILABLE');}
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw Error('PUBLISHED_RESPONSE_TOO_LARGE');}chunks.push(value);}}
    finally{reader.releaseLock();}
    return verifiedResponse(kind,response.status,Object.fromEntries(response.headers),Buffer.concat(chunks));
  };
}
export async function getPublished(kind){
  assert.ok(Object.hasOwn(routes,kind),'UNAPPROVED_PUBLISHED_READ');
  return (await createPublishedReader())(kind);
}
/** @returns {Promise<import('./published-configuration-snapshot').PublishedSnapshot>} */
export async function capture(read){
  read??=await createPublishedReader();
  const names=Object.keys(routes).filter(k=>k!=='version');
  const pool=async()=>{
    const entries={};
    let i=0,failed=false;
    const results=await Promise.allSettled(Array.from({length:4},async()=>{while(!failed&&i<names.length){const k=names[i++];try{entries[k]=await read(k);}catch(error){failed=true;throw error;}}}));
    const rejected=results.find(x=>x.status==='rejected');if(rejected)throw rejected.reason;
    return Object.fromEntries(names.map(k=>[k,entries[k]]));
  };
  const v1=await read('version'),first=await pool(),second=await pool(),v2=await read('version');
  assert.equal(canonical(v1),canonical(v2),'FORMAL_RELEASE_CHANGED_DURING_READ');
  /** @type {Record<string,string>} */
  const hashes={};
  for(const name of names){const digest=x=>sha(canonical(x));hashes[name]=digest(first[name]);assert.equal(hashes[name],digest(second[name]),'PUBLISHED_SECTION_CHANGED_'+name);}
  const categories=new Set(second.categories.categories.map(x=>x.name));
  assert.ok(second.agents.agents.every(x=>categories.has(x.category)),'PUBLIC_CATEGORY_REFERENCE_MISSING');
  return {schema:'published-preview.v1',source:ORIGIN,audience:'guest',observedAt:new Date().toISOString(),runtime:v2,fingerprint:sha(canonical({runtime:v2,hashes})),hashes,
    evidence:{readStability:'two equal reads per public section in one web release',brandingVersion:second.branding.branding.revisionId,appearanceAuthority:second.appearance.authority.source??null,layoutAuthority:'effective public route; may return site defaults',modelScope:'published public catalogue; no provider tests',privateDrafts:'independent local database'},sections:second};
}
export function validateSnapshot(value){
  assert.ok(value&&value.schema==='published-preview.v1'&&value.source===ORIGIN&&value.audience==='guest','SNAPSHOT_SCOPE_INVALID');
  assert.equal(Object.keys(value).sort().join(','),'audience,evidence,fingerprint,hashes,observedAt,runtime,schema,sections,source','SNAPSHOT_FIELDS_INVALID');
  publicFields(value);
  const names=Object.keys(routes).filter(k=>k!=='version');
  assert.equal(Object.keys(value.sections??{}).sort().join(','),names.slice().sort().join(','),'SNAPSHOT_SECTIONS_INVALID');
  assert.equal(Object.keys(value.hashes??{}).sort().join(','),names.slice().sort().join(','),'SNAPSHOT_HASHES_INVALID');
  assert.ok(Number.isFinite(Date.parse(value.observedAt))&&Date.parse(value.observedAt)<=Date.now()+90000,'SNAPSHOT_TIME_INVALID');
  const runtime=project('version',value.runtime);
  for(const name of names){
    // Stored sections are already projected. Validate their public boundary again,
    // then verify exact bytes through canonical content hashes.
    const projected=project(name,name==='manju'?{ok:true,state:'ready',...value.sections[name]}:value.sections[name]);
    assert.equal(canonical(projected),canonical(value.sections[name]),'SNAPSHOT_PUBLIC_PROJECTION_INVALID');
    assert.equal(value.hashes[name],sha(canonical(value.sections[name])),'SNAPSHOT_SECTION_DIGEST_INVALID');
  }
  const categories=new Set(value.sections.categories.categories.map(x=>x.name));
  assert.ok(value.sections.agents.navigationKeys===null&&value.sections.agents.agents.every(x=>x.deleted_at===null&&x.category!=='自用'&&x.user_access!=='hidden'&&categories.has(x.category)),'SNAPSHOT_PUBLIC_AUDIENCE_INVALID');
  assert.equal(value.fingerprint,sha(canonical({runtime,hashes:value.hashes})),'SNAPSHOT_DIGEST_INVALID');
  return value;
}
