import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getVoiceDb } from '@/lib/voice-studio/db';
import { OFFICIAL_VOICES } from '@/lib/vs/voices-data';
import { isChineseVoice, RECOMMENDED_VOICE_IDS, VOICE_CURATION_DATE } from '@/lib/vs/voice-curation';
import { withAdminAuth } from '@/lib/api-middleware';
export async function POST(request:Request){return withAdminAuth(request,async()=>{try{
  const db=getVoiceDb(), now=Date.now(), target=OFFICIAL_VOICES.filter(isChineseVoice),added:Array<Record<string,unknown>>=[];
  db.transaction(()=>{const insert=db.prepare('INSERT OR IGNORE INTO Voice (id,name,speakerId,category,gender,language,type,description,tags,isActive,isRecommended,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(const v of target){const result=insert.run(randomUUID(),v.name,v.speakerId,v.category,v.gender,v.language,v.type,v.description,JSON.stringify(v.tags),1,RECOMMENDED_VOICE_IDS.includes(v.speakerId)?1:0,now,now);if(result.changes)added.push({speakerId:v.speakerId,name:v.name,gender:v.gender,scene:v.category});}
  })();
  return NextResponse.json({success:true,data:{timestamp:new Date(now).toISOString(),catalogDate:VOICE_CURATION_DATE,official:OFFICIAL_VOICES.length,matched:target.length,added:added.length,updated:0,skipped:OFFICIAL_VOICES.length-target.length,addedVoices:added,updatedVoices:[],skippedDetails:{nonChinese:OFFICIAL_VOICES.length-target.length,nonRealistic:0,other:0}}});
}catch{return NextResponse.json({success:false,message:'音色同步失败，请重试'},{status:503})}})}
export async function GET(request:Request){return withAdminAuth(request,async()=>NextResponse.json({success:false,message:'请使用同步按钮提交操作'},{status:405,headers:{Allow:'POST'}}))}
