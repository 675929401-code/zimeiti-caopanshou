import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/api-middleware';
import { readVoiceCatalog } from '@/lib/voice-studio/catalog';
export async function GET(request:NextRequest){ return withAdminAuth(request,async()=>{try{
  const q=new URL(request.url).searchParams,page=Math.max(1,parseInt(q.get('page')||'1')||1),limit=Math.min(500,Math.max(1,parseInt(q.get('limit')||'50')||50)),search=(q.get('search')||'').toLowerCase();
  const list=readVoiceCatalog(true).filter(v=>(v.name+' '+v.speakerId+' '+v.description).toLowerCase().includes(search)).map(v=>({...v,id:v.adminId}));
  return NextResponse.json({success:true,data:{voices:list.slice((page-1)*limit,page*limit),total:list.length,page,limit,totalPages:Math.ceil(list.length/limit)}},{headers:{'Cache-Control':'no-store'}});
}catch{return NextResponse.json({success:false,message:'音色目录暂时无法读取'},{status:503})}})}
