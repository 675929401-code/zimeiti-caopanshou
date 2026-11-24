import sharp from 'sharp';
import {redNoteShare,resolveRedNote,downloadRedNote,downloadRedNoteMedia,isRedNoteMedia} from './rednote-video';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {deductCash,refundCash} from '@/lib/billing';
import {recordRevenue} from '@/lib/revenue';
import {parseCozeWorkflowResult} from '@/lib/coze-extraction-result';
import {inspectCozeSourceIdentity} from '@/lib/coze-source-identity';
import {safeFetch,SafeFetchError} from '@/lib/safe-fetch';
import {claimRecordLease,get,list,put,recordLeaseIsCurrent,releaseRecordLease,runtimeDir} from './store';
import {readIdempotentAsset,storeAsset,publicAsset} from './assets';
import type {AuthorizedCommerceMainAccount} from './main-account-access';

type Provider={endpoint:string;key:string;price:number;cost:number};
type Status='quoted'|'charging'|'dispatching'|'polling'|'unknown'|'saving'|'settling'|'done'|'refunding'|'failed';
type Job={platform?:'xiaohongshu';mediaLink?:boolean;notePage?:string;id:string;owner:string;workId:string;created:number;status:Status;price:number;cost:number;providerVersion:string;providerOrigin:string;
 mainUserId?:string;userRole?:'admin'|'student';task?:string;error?:string;title?:string;caption?:string;likes?:number;cover?:string;media?:string;asset?:ReturnType<typeof publicAsset>;charged?:boolean};
const bucket='social-video-jobs';
function config():Provider {
 let config:Provider;
 try{config=JSON.parse(readFileSync(path.join(runtimeDir(),'private-providers','social-video.json'),'utf8'));}catch{throw Error('作品解析渠道尚未配置');}
 const url=new URL(config.endpoint);
 if(url.protocol!=='https:'||!url.hostname.endsWith('.coze.site')||url.port||url.username||url.password||url.search||url.hash||!config.key||typeof config.price!=='number'||!Number.isFinite(config.price)||config.price<0.01||Math.round(config.price*100)/100!==config.price||!Number.isFinite(config.cost)||config.cost<0||config.cost>config.price)throw Error('作品解析渠道配置无效');
 return config;
}
async function workIdFrom(value:string) {
 const input=value.trim();if(/^\d{15,22}$/.test(input))return input;
 const links=input.match(/https:\/\/[^\s，。]+/g)||[];if(links.length!==1)throw Error('请提供一个抖音作品链接或作品号');
 let url=new URL(links[0]);for(let hop=0;hop<4;hop++){
  if(url.protocol!=='https:'||url.port||url.username||url.password||!['v.douyin.com','www.douyin.com','douyin.com','www.iesdouyin.com'].includes(url.hostname))throw Error('当前解析渠道仅接受抖音作品');
  const id=url.pathname.match(/^\/(?:share\/)?(?:video|note)\/(\d{15,22})(?:\/|$)/)?.[1];if(id)return id;
  if(url.hostname!=='v.douyin.com')break;
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8000)});const dest=response.headers.get('location');await response.body?.cancel();
  if(!dest||response.status<300||response.status>=400)break;url=new URL(dest,url);
 }throw Error('短链接未返回原作品编号，请使用完整作品链接');
}
const version=(p:Provider)=>createHash('sha256').update(JSON.stringify([p.endpoint,p.key,p.price,p.cost])).digest('hex');
const root=(p:Provider)=>p.endpoint.replace(/\/run\/?$/,'').replace(/\/$/,'');
const source=(j:Job)=>'https://www.douyin.com/video/'+j.workId;
async function fetchOriginalMedia(url:string,maxBytes=120*1024*1024){
 const options={timeoutMs:45000,maxBytes,maxRedirects:2};
 try{return await safeFetch(url,{...options,networkPolicy:'system-dns-pinned'});}
 catch(error){
  if(!(error instanceof SafeFetchError)||!['DNS_LOOKUP_FAILED','IP_FORBIDDEN'].includes(error.code))throw error;
  // A local DNS proxy may return a reserved address for a public CDN. Resolve
  // independently and validate every address and redirect on the second lookup.
  return safeFetch(url,{...options,networkPolicy:'fixed-public-dns-pinned'});
 }
}
function pub(j:Job){return {id:j.id,platform:j.platform||'douyin',mediaLink:j.mediaLink,workId:j.workId,created:j.created,status:j.status,price:j.price,error:j.error,charged:j.charged===true,...(j.status==='done'?{title:j.title,caption:j.caption,likes:j.likes,asset:j.asset}:{})};}
export function socialHistory(owner:string){return list<Job>(bucket,owner).filter(j=>j.status!=='quoted').slice(0,30).map(pub);}
export async function socialCover(owner:string,id:string){
 const job=get<Job>(bucket,id,owner);
 if(!job||job.status!=='done'||!job.task)throw Error('请先打开已完成的作品解析记录');
 const key='social-cover:'+job.id,stored=readIdempotentAsset(owner,key);
 if(stored)return publicAsset(stored);
 const provider=config();if(root(provider)!==job.providerOrigin)throw Error('原解析渠道已变化');
 const response=await fetch(root(provider)+'/task/'+encodeURIComponent(job.task),{headers:{Authorization:'Bearer '+provider.key},redirect:'error',signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error('无法读取供应商原单');
 const data=await response.json();
 if(data.status!=='completed'||data.error||(data.task_id&&data.task_id!==job.task))throw Error('无法核对原单封面');
 const result=parseCozeWorkflowResult(data.result),cover=result.captions?.[0]?.cover;
 if(inspectCozeSourceIdentity(source(job),'video',result).status!=='verified'||!cover)throw Error('原作品未提供封面');
 const url=new URL(cover);
 if(url.protocol!=='https:'||url.port||url.username||url.password||!/(^|\.)(douyinpic|byteimg|douyinvod|zjcdn)\.com$/i.test(url.hostname))throw Error('原作品封面地址未能核实');
 const {buffer}=await fetchOriginalMedia(url.href,12*1024*1024);
 const bytes=await sharp(buffer,{limitInputPixels:24_000_000}).rotate().jpeg({quality:90}).toBuffer();
 return publicAsset(await storeAsset(owner,bytes,'image/jpeg',job.workId+'-封面.jpg','generated',id,undefined,key));
}
export async function quoteSocialVideo(owner:string,input:string,allowRedNote=false){
 const share=redNoteShare(input);
 if(share){
  if(!allowRedNote)throw Error('请在「抖音红书视频下载器」中打开小红书分享链接');
  const mediaLink=isRedNoteMedia(share);
  const note=mediaLink?{id:'media-'+createHash('sha256').update(share.origin+share.pathname).digest('hex').slice(0,24),url:share.href}:await resolveRedNote(share);
  const job:Job={platform:'xiaohongshu',mediaLink,id:randomUUID(),owner,workId:note.id,notePage:note.url,created:Date.now(),status:'quoted',price:0,cost:0,providerOrigin:'xiaohongshu',providerVersion:mediaLink?'public-page-v1':'public-document-v2'};
  put(bucket,job.id,owner,job);return pub(job);
 }
 const p=config(),workId=await workIdFrom(input),j:Job={id:randomUUID(),owner,workId,created:Date.now(),status:'quoted',price:p.price,cost:p.cost,providerOrigin:root(p),providerVersion:version(p)};
 put(bucket,j.id,owner,j);return pub(j);
}
export async function advanceSocialVideo(owner:string,account:AuthorizedCommerceMainAccount,id:string,confirm:boolean){
 const lease=claimRecordLease('social-video-leases',id,owner,randomUUID(),Date.now(),180000);
 const read=()=>{const j=get<Job>(bucket,id,owner);if(!j)throw Error('作品解析记录不存在');return j;};
 if(!lease)return pub(read());const current=()=>recordLeaseIsCurrent(lease);
 try{
  const j=read();const save=()=>{if(!current())throw Error('原任务正在处理');put(bucket,j.id,owner,j);};
  if(['done','failed','unknown'].includes(j.status))return pub(j);
  if(j.platform==='xiaohongshu'){
   if(j.status==='quoted'){
    if(!confirm)return pub(j);
    if(Date.now()-j.created>600000)throw Error('分享链接确认已过期，请重新解析');
    j.mainUserId=account.mainUserId;j.status='saving';save();
   }
   if(j.mainUserId!==account.mainUserId||!j.notePage||j.status!=='saving')throw Error('原笔记任务状态不匹配');
   const key='social-video:'+j.id;
   let asset=readIdempotentAsset(owner,key);
   if(!asset){
    try{
     const result=j.mediaLink?{title:'小红书视频原文件',bytes:await downloadRedNoteMedia(j.notePage)}:await downloadRedNote(j.notePage,j.workId);
     j.title=result.title;save();
     asset=await storeAsset(owner,result.bytes,'video/mp4',j.workId+'.mp4','generated',j.id,undefined,key,current);
    }catch(error){
     if(!current())throw error;
     const reason=error instanceof SafeFetchError?(error.upstreamStatus?'来源返回 HTTP '+error.upstreamStatus:'未能读取来源页面或视频文件'):error instanceof Error?error.message:'原视频未交付';
     j.status='failed';j.error=reason+'。未扣费';delete j.notePage;save();return pub(j);
    }
   }
   j.asset=publicAsset(asset);j.status='done';delete j.notePage;save();return pub(j);
  }
  const p=config();if(root(p)!==j.providerOrigin)throw Error('原解析渠道已变化，请管理员核对原单');
  if(j.status==='quoted'){
   if(!confirm)return pub(j);
   if(Date.now()-j.created>600000||version(p)!==j.providerVersion)throw Error('报价已过期或渠道配置已变化，请重新报价');
   j.mainUserId=account.mainUserId;j.userRole=account.role==='admin'?'admin':'student';j.status='charging';save();
  }
  if(j.mainUserId!==account.mainUserId)throw Error('原单钱包不匹配');
  if(j.status==='charging'){
   const debit=await deductCash(account.mainUserId,j.price,'带货创作 · 抖音作品解析','commerce-social-'+j.id);
   if(!debit.success){j.error='原单扣款未完成，请检查余额后刷新';save();return pub(j);}
   j.charged=true;j.error=undefined;j.status='dispatching';save();
   let response:Response;
   try{response=await fetch(root(p)+'/async_run',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+p.key,'Content-Type':'application/json'},body:JSON.stringify({share_text:source(j),mode:'video',max_count:1,min_likes:0}),signal:AbortSignal.timeout(20000)});}
   catch{j.status='unknown';j.error='供应商接单状态待核对，请保留原记录';save();return pub(j);}
   if(!response.ok){
    j.status=[400,401,402,403,404,413,422,429].includes(response.status)?'refunding':'unknown';j.error='供应商返回 HTTP '+response.status;save();
   }else{
    const data=await response.json().catch(()=>({}));if(typeof data.task_id!=='string'||!/^[a-z\d_-]{1,128}$/i.test(data.task_id)){j.status='unknown';j.error='供应商未返回可核对的任务号';}
    else{j.task=data.task_id;j.status='polling';}save();return pub(j);
   }
  }else if(j.status==='dispatching'){j.status='unknown';j.error='提交中断，需核对原单';save();return pub(j);}
  if(j.status==='polling'){
   const res=await fetch(root(p)+'/task/'+encodeURIComponent(j.task!),{headers:{Authorization:'Bearer '+p.key},redirect:'error',signal:AbortSignal.timeout(12000)});
   if(!res.ok)throw Error('无法查询供应商原单，请稍后刷新');const data=await res.json();
   if(data.task_id&&data.task_id!==j.task)throw Error('供应商返回的任务号与原单不符');
   if(data.status==='completed'&&!data.error){
    try{const result=parseCozeWorkflowResult(data.result),item=result.captions?.[0];if(!item||item.error||inspectCozeSourceIdentity(source(j),'video',result).status!=='verified'||!item.video_url)throw Error();
     const video=new URL(item.video_url);if(video.protocol!=='https:'||video.username||video.password||video.port||!/(^|\.)(douyinvod|douyin|bytecdn|bytedance|zjcdn)\.com$/i.test(video.hostname))throw Error();
     j.media=video.href;j.title=String(item.desc||'抖音作品').slice(0,220);j.caption=String(item.caption||'').slice(0,30000);j.likes=typeof item.digg_count==='number'?item.digg_count:undefined;j.status='saving';
    }catch{j.status='refunding';j.error='原作品身份或视频文件未能核实';}
   }else if(['failed','cancelled','canceled','completed'].includes(data.status)){j.status='refunding';j.error='供应商未交付该作品';}
   save();
  }
  if(j.status==='saving'){
   const key='social-video:'+id;let a=readIdempotentAsset(owner,key);
   if(!a){const media=await fetchOriginalMedia(j.media!);if(media.buffer.length<12||media.buffer.subarray(4,8).toString()!=='ftyp')throw Error('原文件暂不可保存，请刷新原单');a=await storeAsset(owner,media.buffer,'video/mp4',j.workId+'.mp4','generated',id,undefined,key,current);}
   j.asset=publicAsset(a);j.media=undefined;j.status='settling';save();
  }
  if(j.status==='settling'){await recordRevenue({userId:account.mainUserId,userRole:j.userRole!,modelId:'commerce-social-video',taskId:'commerce-social-'+id,costPrice:j.cost,sellingPrice:j.price,cashCharged:j.price,recordType:'extract'});j.status='done';j.error=undefined;save();}
  if(j.status==='refunding'){const refund=await refundCash(account.mainUserId,j.price,'带货创作 · 作品解析失败退款','commerce-social-'+id+'-refund');if(!refund.success)throw Error('原单退款待核对，请刷新');j.status='failed';j.charged=false;save();}
  return pub(j);
 }finally{releaseRecordLease(lease);}
}
