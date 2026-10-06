import { NextRequest, NextResponse } from 'next/server';
import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
export const runtime='nodejs';
export async function POST(request:NextRequest){
 const auth=await authorizeCurrentApiUser(request);if(!auth.ok)return auth.response;
 let body;try{body=await request.json();}catch{return NextResponse.json({error:'任务参数无效'},{status:400});}
 if(!/^vt_[a-f0-9]{40}$/.test(String(body.taskId||'')))return NextResponse.json({error:'任务参数无效'},{status:400});
 const {data,error}=await getSupabaseAdminClient().rpc('cancel_queued_digital_video',{p_task_id:body.taskId,p_user_id:auth.user.userId});
 if(error)return NextResponse.json({error:'暂时无法确认取消结果，请刷新任务状态'},{status:503});
 if(data==='not_found')return NextResponse.json({error:'任务不存在'},{status:404});
 if(data!=='cancelled')return NextResponse.json({error:'任务已开始处理，请继续查看原任务'},{status:409});
 return NextResponse.json({status:'cancelled',priceCharged:0,message:'已取消排队，本次未扣费'});
}
