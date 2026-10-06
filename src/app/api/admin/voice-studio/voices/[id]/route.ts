import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/api-middleware';
import { readVoiceCatalog, updateVoiceCatalog } from '@/lib/voice-studio/catalog';
type Context={params:Promise<{id:string}>};
export async function GET(request:NextRequest,{params}:Context){return withAdminAuth(request,async()=>{const {id}=await params;const voice=readVoiceCatalog(true).find(v=>v.adminId===id);return NextResponse.json(voice?{success:true,data:voice}:{success:false,message:'音色不存在'},{status:voice?200:404});})}
export async function PUT(request:NextRequest,{params}:Context){return withAdminAuth(request,async()=>{try{
  const {id}=await params,body=await request.json();if(!body||Array.isArray(body)||typeof body!=='object')throw Error('INPUT');
  const keys=Object.keys(body);if(!keys.length||keys.some(k=>!['isActive','isRecommended','name','description'].includes(k)))throw Error('INPUT');
  for(const key of keys){if(key==='isActive'||key==='isRecommended'){if(typeof body[key]!=='boolean')throw Error('INPUT');}else if(typeof body[key]!=='string'||body[key].length>(key==='name'?100:2000)||!body[key].trim())throw Error('INPUT');}
  const changed=updateVoiceCatalog(id,body);return NextResponse.json({success:changed,message:changed?'更新成功':'音色不存在'},{status:changed?200:404});
}catch(error){const invalid=error instanceof SyntaxError||(error instanceof Error&&error.message==='INPUT');return NextResponse.json({success:false,message:invalid?'音色设置格式无效':'音色保存失败，请重试'},{status:invalid?400:503});}})}
// Built-in identities and user favorites must survive removal from selection.
export async function DELETE(request:NextRequest,{params}:Context){return withAdminAuth(request,async()=>{const {id}=await params;const changed=updateVoiceCatalog(id,{isActive:false});return NextResponse.json({success:changed,message:changed?'音色已下架，历史与收藏保留':'音色不存在'},{status:changed?200:404});})}
