import {safeFetch, SafeFetchError, type SafeFetchOptions} from '@/lib/safe-fetch';
import {readPublicRedNoteDocument} from './rednote-document';
import {assertCompleteVideoMp4} from '@/lib/video-provider-result';

// This HTML parser ships with the pinned Next.js runtime. It never runs page scripts.
const {parse} = require('next/dist/compiled/node-html-parser') as {
  parse(html:string):{querySelectorAll(selector:string):Array<{rawText:string;getAttribute(name:string):string|undefined}>};
};
const shortHosts=new Set(['xhslink.com','www.xhslink.com','xhslink.cn','www.xhslink.cn']);
const noteHosts=new Set(['xiaohongshu.com','www.xiaohongshu.com','rednote.com','www.rednote.com']);
const noteId=(url:URL)=>url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase();

function checkPage(url:URL) {
  if(url.protocol!=='https:'||url.username||url.password||url.port||!(noteHosts.has(url.hostname)||shortHosts.has(url.hostname)))throw Error('小红书分享链接的目的地址无效');
}
const mediaHost=(host:string)=>/^(?:sns-v\d+|sns-video(?:-[a-z0-9]+)*)\.(?:rednotecdn\.com|xhscdn\.(?:com|net))$/i.test(host);
export function isRedNoteMedia(url:URL){return mediaHost(url.hostname);}
export function redNoteShare(input:string) {
  const links=input.match(/https?:\/\/[^\s，。！？、<>"“”]+/gi)||[];
  let found:URL|undefined;
  for(const raw of links){
    let url:URL;
    try{url=new URL(raw.replace(/[)）】\].,;；]+$/u,''));}catch{continue;}
    if(!noteHosts.has(url.hostname)&&!shortHosts.has(url.hostname)&&!mediaHost(url.hostname))continue;
    if(links.length!==1)throw Error('请每次提交一条作品链接');
    if(url.protocol==='http:'&&!url.port)url.protocol='https:';
    if(mediaHost(url.hostname)){if(!videoUrl(url.href,url.href))throw Error('小红书媒体文件地址无效');}
    else checkPage(url);
    found=url;
  }
  return found;
}
export async function resolveRedNote(url:URL){
  for(let hop=0;hop<4;hop++){
    checkPage(url);
    const id=noteId(url);
    if(id&&noteHosts.has(url.hostname))return {id,url:url.href};
    if(!shortHosts.has(url.hostname))break;
    const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(8000)});
    const location=response.headers.get('location');
    await response.body?.cancel();
    if(!location||response.status<300||response.status>=400)break;
    url=new URL(location,url);
  }
  throw Error('小红书分享链接已失效或没有返回笔记编号');
}

async function fetchPublic(url:string,options:SafeFetchOptions){
  try{return await safeFetch(url,{...options,networkPolicy:'system-dns-pinned'});}
  catch(error){
    if(!(error instanceof SafeFetchError)||!['DNS_LOOKUP_FAILED','IP_FORBIDDEN'].includes(error.code))throw error;
    return safeFetch(url,{...options,networkPolicy:'fixed-public-dns-pinned'});
  }
}
function videoUrl(value:string,base:string){
  try{
    const url=new URL(value,base);
    if(url.protocol==='http:'&&!url.port&&mediaHost(url.hostname))url.protocol='https:';
    if(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&mediaHost(url.hostname)&&url.pathname!=='/')return url.href;
  }catch{}
  return undefined;
}
type PageNote = {noteId?:string;type?:string;title?:string;video?:{media?:{stream?:Record<string,Array<{masterUrl?:string;backupUrls?:string[]}>>}}};
function playerNote(scripts:Array<{rawText:string}>,id:string):PageNote|undefined {
  for(const script of scripts){
    const match=script.rawText.trim().match(/^window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);?\s*$/);
    if(!match)continue;
    try {
      // Keep string literals intact. Some server-rendered pages use undefined for empty values.
      const json=match[1].replace(/"(?:\\.|[^"\\])*"|\bundefined\b/g,value=>value==='undefined'?'null':value);
      const note:PageNote|undefined=JSON.parse(json)?.note?.noteDetailMap?.[id]?.note;
      if(note&&(!note.noteId||note.noteId===id))return note;
    }catch{}
  }
}
export function readRedNotePage(final:string,id:string,html:string){
  const page=new URL(final);
  if(!noteHosts.has(page.hostname))throw Error('分享页已离开小红书，无法核对原笔记');
  if(page.pathname.startsWith('/login'))throw Error('小红书要求登录后查看该笔记');
  if(page.pathname.startsWith('/404')){
    const code=page.searchParams.get('error_code');
    throw Error('小红书提示当前笔记暂时无法浏览'+(code&&/^\d{1,8}$/.test(code)?'（'+code+'）':''));
  }
  if(noteId(page)!==id)throw Error('分享页返回的笔记编号与原链接不一致');
  const doc=parse(html),metadata=new Map<string,string>();
  for(const tag of doc.querySelectorAll('meta')){
    const key=tag.getAttribute('property')||tag.getAttribute('name'),value=tag.getAttribute('content');
    if(key&&value&&!metadata.has(key))metadata.set(key,value);
  }
  const canonical=metadata.get('og:url')||doc.querySelectorAll('link[rel="canonical"]')[0]?.getAttribute('href');
  if(canonical){const u=new URL(canonical,page);if(!noteHosts.has(u.hostname)||noteId(u)!==id)throw Error('笔记声明的作品编号与分享链接不一致');}
  const note=playerNote(doc.querySelectorAll('script'),id);
  if(note?.type&&note.type!=='video')throw Error('这条小红书笔记是图文，未提供原视频');
  const streams=note?.video?.media?.stream||{};
  const playerUrls=[streams.h264,...Object.entries(streams).filter(([key])=>key!=='h264').map(([,list])=>list)]
    .filter(Array.isArray).flatMap(list=>list.flatMap(item=>[item?.masterUrl,...(Array.isArray(item?.backupUrls)?item.backupUrls:[])]));
  const sources=[...playerUrls,metadata.get('og:video:secure_url'),metadata.get('og:video:url'),metadata.get('og:video'),...doc.querySelectorAll('video[src], video source[src]').map(tag=>tag.getAttribute('src'))];
  const media=sources.map(value=>value&&videoUrl(value,page.href)).find(Boolean);
  if(!media)throw Error('该笔记公开页面未提供可核实的视频文件');
  return {media,title:(typeof note?.title==='string'&&note.title||metadata.get('og:title')||'小红书视频').slice(0,220)};
}
export async function downloadRedNote(url:string,id:string){
  const source=new URL(url);
  checkPage(source);
  if(noteId(source)!==id)throw Error('分享页返回的笔记编号与原链接不一致');
  const publicDocument=await readPublicRedNoteDocument(source);
  let document;
  if(publicDocument!==undefined){
    document=readRedNotePage(url,id,publicDocument);
  }else{
    const page=await fetchPublic(url,{timeoutMs:12000,maxBytes:5*1024*1024,maxRedirects:4,allowedContentTypes:['text/html','application/xhtml+xml']});
    document=readRedNotePage(page.url,id,page.buffer.toString('utf8'));
  }
  const {media,title}=document;
  return {title,bytes:await downloadRedNoteMedia(media!)};
}
export async function downloadRedNoteMedia(media:string){
  const source=videoUrl(media,media);
  if(!source)throw Error('无法确认小红书媒体文件来源');
  const file=await fetchPublic(source,{timeoutMs:45000,maxBytes:120*1024*1024,maxRedirects:2,allowedContentTypes:['video/mp4','application/mp4','application/octet-stream']});
  if(!videoUrl(file.url,source)||file.buffer.length<12||file.buffer.toString('ascii',4,8)!=='ftyp')throw Error('小红书返回的媒体未通过原视频格式核对');
  try{assertCompleteVideoMp4(file.buffer);}catch{throw Error('小红书视频文件不完整');}
  return file.buffer;
}

