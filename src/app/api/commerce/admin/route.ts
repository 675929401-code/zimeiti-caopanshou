import { NextResponse } from 'next/server';
export const runtime='nodejs'; export const dynamic='force-dynamic';
const retired=()=>NextResponse.json({ok:false,code:'COMMERCE_ADMIN_MOVED',error:'带货后台已迁入主站管理员后台 /admin?tab=commerce；旧独立管理员接口已停止。'},{status:410,headers:{'Cache-Control':'no-store'}});
export async function GET(){return retired();}
export async function POST(){return retired();}
