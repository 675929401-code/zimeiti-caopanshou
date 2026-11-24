import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {deductCash,refundCash} from '@/lib/billing';
import {recordRevenue} from '@/lib/revenue';
import {calculateVoiceCost} from '@/lib/vs/pricing';
import {synthesizeSpeech} from '@/lib/vs/volcengine';
import {generateAudio} from '@/lib/vs/seed-audio-1.0';
import {safeFetch} from '@/lib/safe-fetch';
import {isDubSkill,type DubSkill,type DubLanguage,type DubView} from '../shared/dubbing';
import {parseSubtitles,renderSrt,type Caption} from '../shared/member-captions';
import {assetBytes,publicAsset,readAsset,readIdempotentAsset,storeAsset} from './assets';
import type {AuthorizedCommerceMainAccount} from './main-account-access';
import {claimRecordLease,get,list,put,recordLeaseIsCurrent,releaseRecordLease,runtimeDir} from './store';
import {mediaInfo,renderDub,voiceReference} from './dubbing-media';

type Status='quoted'|'charging'|'ready'|'sending'|'unknown'|'rendering'|'settling'|'done'|'refunding'|'failed';
type Job={id:string;owner:string;skill:DubSkill;lang:DubLanguage;source:string;duration:number;rows:Caption[];index:number;status:Status;created:number;price:number;cost:number;rates:number[];
 mainUserId?:string;role?:'admin'|'student';charged?:boolean;error?:string;receipts:string[];video?:DubView['video'];subtitles?:DubView['subtitles']};
const bucket='dubbing-jobs',langs={zh:'中文',en:'英语',th:'泰语',vi:'越南语'};
const folder=(j:Job)=>path.join(runtimeDir(),'dubbing-work',j.id);
const model=(skill:DubSkill)=>skill==='video-dub'?'seed-tts-2.0':'seed-audio-1.0';
function price(row:Caption,skill:DubSkill,actual?:number){const p=calculateVoiceCost([...row.text].length,model(skill),1,actual??(row.end-row.start));if(!p||!Number.isFinite(p.costPriceRmb)||!Number.isFinite(p.sellPriceRmb)||p.sellPriceRmb<=0||p.costPriceRmb<0)throw Error('配音模型价格未配置');return p;}
function pub(j:Job):DubView{return {id:j.id,status:j.status,progress:j.index,count:j.rows.length,price:j.price,charged:!!j.charged,error:j.error,...(j.status==='done'?{video:j.video,subtitles:j.subtitles}:{})};}
export function dubHistory(owner:string,skill:DubSkill){return list<Job>(bucket,owner).filter(j=>j.skill===skill&&j.status!=='quoted').slice(0,25).map(pub);}
export async function quoteDub(owner:string,input:{assetId:string;skill:DubSkill;lang:DubLanguage;srt:string;authorized:boolean}){
 const {assetId,skill,lang,srt,authorized}=input;
 if(!isDubSkill(skill)||!Object.hasOwn(langs,lang)||(skill==='voice-localize'&&lang==='zh')||(skill==='video-dub'&&lang==='zh'))throw Error('请选择可用的配音语种');
 if(skill!=='video-dub'&&authorized!==true)throw Error('使用参考音色前请确认声音使用权');
 const asset=readAsset(assetId,owner);if(!asset||!asset.type.startsWith('video/')||asset.size>120*1024*1024)throw Error('请上传自己的视频，最大 120 MB');
 const rows=parseSubtitles(srt);if(rows.length>24||srt.length>15000||rows.some((r,i)=>r.end-r.start<0.25||r.end-r.start>90||r.text.length>750||(i>0&&r.start<rows[i-1].end)))throw Error('每次可处理 1–24 个不重叠的句段，每段 0.25–90 秒、最多 750 字');
 const temp=await fs.mkdtemp(path.join(runtimeDir(),'dub-quote-'));let duration=0;
 try{await fs.writeFile(path.join(temp,'source'),await assetBytes(asset));const info=await mediaInfo(path.join(temp,'source'));duration=info.duration;if(!info.video||duration>300||rows.at(-1)!.end>duration+0.06||(skill!=='video-dub'&&!info.audio))throw Error('视频须在五分钟内，字幕须处于画面内，原音色模式需要声音轨道');}finally{await fs.rm(temp,{recursive:true,force:true});}
 const rates=rows.map(r=>price(r,skill).sellPriceRmb);
 const j:Job={id:randomUUID(),owner,source:asset.id,rows,index:0,skill,lang,status:'quoted',duration,created:Date.now(),price:Math.round(rates.reduce((a,b)=>a+b,0)*100)/100,cost:0,rates,receipts:[]};put(bucket,j.id,owner,j);return pub(j);
}
async function audioBytes(url:string,inline?:string){
 if(inline)return Buffer.from(inline,'base64');
 const m=/^data:audio\/(?:mp3|mpeg|wav|x-wav);base64,([a-z\d+/=\s]+)$/i.exec(url);if(m)return Buffer.from(m[1],'base64');
 return (await safeFetch(url,{maxBytes:24*1024*1024,timeoutMs:25000,networkPolicy:'system-dns-pinned'})).buffer;
}
async function synthesize(j:Job,row:Caption,work:string){
 if(j.skill==='video-dub'){
  const v=await synthesizeSpeech({text:row.text,speaker:j.lang==='vi'?'vi_female_f01507b_uranus_bigtts':'zh_female_shuangkuaisisi_uranus_bigtts',model:'seed-tts-2.0-expressive',resourceId:'seed-tts-2.0',additions:{explicit_language:j.lang},audioParams:{format:'mp3',sample_rate:24000}});
  if(!v.logId)throw Error('缺少外部音频回执');return {bytes:await audioBytes(v.audioUrl),receipt:v.logId,cost:price(row,j.skill).costPriceRmb};
 }
 const ref=await voiceReference(work,Math.max(0,Math.min(row.start-1,j.duration-8)),Math.min(10,j.duration));
 const v=await generateAudio({textPrompt:'使用 @音频1 中说话人的音色与自然语气，用'+langs[j.lang]+'只朗读以下文本，保留数字与专名，不添加其他声音：\n'+row.text,references:[{audioData:ref.toString('base64')}],audioConfig:{format:'mp3',sampleRate:24000}});
 if(!v.logId)throw Error('缺少参考音色原单回执');return {bytes:await audioBytes(v.audioUrl,v.audioBase64),receipt:v.logId,cost:price(row,j.skill,v.originalDuration||v.duration||row.end-row.start).costPriceRmb};
}
export async function advanceDub(owner:string,account:AuthorizedCommerceMainAccount,id:string,confirm:boolean){
 const read=()=>{const j=get<Job>(bucket,id,owner);if(!j)throw Error('配音任务不存在');return j;};
 const lease=claimRecordLease('dub-leases',id,owner,randomUUID(),Date.now(),600000);if(!lease)return pub(read());
 const current=()=>recordLeaseIsCurrent(lease);
 try{
  const j=read(),save=()=>{if(!current())throw Error('原配音任务正在处理');put(bucket,id,owner,j);};if(['failed','done','unknown'].includes(j.status))return pub(j);
  if(j.status==='quoted'){
   if(!confirm)return pub(j);if(Date.now()-j.created>600000||j.rows.some((r,i)=>price(r,j.skill).sellPriceRmb!==j.rates[i]))throw Error('配音报价过期或价格变更，请重新报价');
   j.mainUserId=account.mainUserId;j.role=account.role==='admin'?'admin':'student';j.status='charging';save();
  }
  if(j.mainUserId!==account.mainUserId)throw Error('配音原单账户不匹配');
  if(j.status==='charging'){const b=await deductCash(account.mainUserId,j.price,'带货创作 · 按句配音','commerce-dub-'+id);if(!b.success){j.error='扣款待完成，请核对钱包后刷新原单';save();return pub(j);}j.charged=true;j.status='ready';j.error=undefined;save();}
  const work=folder(j);await fs.mkdir(work,{recursive:true,mode:0o700});const src=path.join(work,'source');
  try{await fs.access(src);}catch{const asset=readAsset(j.source,owner);if(!asset){j.status='refunding';j.error='原素材已被删除';save();}else{await fs.writeFile(src,await assetBytes(asset));}}
  if(j.status==='ready'||j.status==='sending'){
   const index=j.index,row=j.rows[index],file=path.join(work,'line-'+index+'.audio'),log=path.join(work,'line-'+index+'.json');let ack:{receipt:string;cost:number}|undefined;
   try{ack=JSON.parse(await fs.readFile(log,'utf8'));await fs.access(file);}catch{ack=undefined;}
   if(!ack&&j.status==='sending'){j.status='unknown';j.error='此句的供应商原单待核对';save();return pub(j);}
   if(!ack){j.status='sending';save();try{const line=await synthesize(j,row,work);if(!line.bytes.length||line.bytes.length>24*1024*1024)throw Error('无有效音频');await fs.writeFile(file+'.part',line.bytes);await fs.rename(file+'.part',file);ack={receipt:line.receipt,cost:line.cost};await fs.writeFile(log+'.part',JSON.stringify(ack));await fs.rename(log+'.part',log);}catch(e){const message=e instanceof Error?e.message:'';j.status=/HTTP(?:错误)?[: ]+(?:400|401|402|403|404|422|429)\b|not granted|MultilingualAUCRecognizeFailed/i.test(message)?'refunding':'unknown';j.error=j.status==='refunding'?'供应商未能按所选音色生成此句':'上游原单待核对，已保留已生成句段';save();if(j.status==='unknown')return pub(j);}}
   if(ack){j.receipts[index]=ack.receipt;j.cost+=ack.cost;j.index++;j.status=j.index===j.rows.length?'rendering':'ready';save();return pub(j);}
  }
  if(j.status==='rendering'){
   const key='dub-video:'+id,subtitleKey='member-documents/dub-srt/'+id;
   const video=readIdempotentAsset(owner,key)||await storeAsset(owner,await renderDub(work,j.rows,j.duration,j.skill==='speech-correction'),'video/mp4','配音成片.mp4','generated',id,undefined,key,current);
   const captions=readIdempotentAsset(owner,subtitleKey)||await storeAsset(owner,Buffer.from(renderSrt(j.rows)),'text/plain','配音时间轴.srt','generated',id,undefined,subtitleKey,current);
   j.video=publicAsset(video);j.subtitles=publicAsset(captions);j.status='settling';save();
  }
  if(j.status==='settling'){await recordRevenue({userId:account.mainUserId,userRole:j.role!,modelId:model(j.skill),taskId:'commerce-dub-'+id,costPrice:j.cost,sellingPrice:j.price,cashCharged:j.price,recordType:'voice'});j.status='done';j.error=undefined;save();await fs.rm(work,{recursive:true,force:true}).catch(()=>{});}
  if(j.status==='refunding'){
   const refund=await refundCash(account.mainUserId,j.price,'带货创作 · 配音失败退款','commerce-dub-'+id+'-refund');if(!refund.success)throw Error('配音原单退款待核对');
   if(j.cost>0)await recordRevenue({userId:account.mainUserId,userRole:j.role!,modelId:model(j.skill),taskId:'commerce-dub-'+id+'-loss',costPrice:j.cost,sellingPrice:0,cashCharged:0,recordType:'voice'});
   j.status='failed';j.charged=false;save();await fs.rm(work,{recursive:true,force:true}).catch(()=>{});
  }return pub(j);
 }finally{releaseRecordLease(lease);}
}

