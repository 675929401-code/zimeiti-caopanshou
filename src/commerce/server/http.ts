import {NextResponse} from 'next/server';
export const json=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
export function errorResponse(error:unknown){
 const message=error instanceof Error?error.message:'操作未完成';
 const accessError=error instanceof Error&&'code' in error&&'status' in error
  ? error as Error&{code?:unknown;status?:unknown}
  : undefined;
 if(accessError&&typeof accessError.code==='string'&&accessError.code.startsWith('COMMERCE_')&&[401,403,503].includes(Number(accessError.status))){
  return json({error:message,code:accessError.code},Number(accessError.status));
 }
 if(message==='UNAUTHORIZED')return json({error:'请先登录主站账号',code:'AUTH_REQUIRED'},401);
 if(message==='FORBIDDEN')return json({error:'无权执行此操作',code:'FORBIDDEN'},403);
 if(message.startsWith('COMMERCE_CONFIG_'))return json({error:'带货配置尚未发布或当前版本不完整，请稍后重试',code:message},503);
 return json({error:message},400);
}
