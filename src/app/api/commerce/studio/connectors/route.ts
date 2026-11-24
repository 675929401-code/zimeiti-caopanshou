import {createHash} from 'node:crypto';
import {requireIdentity,sameOrigin} from '@/commerce/server/auth';
import {authorizeCurrentCommerceIdentity} from '@/commerce/server/main-account-access';
import {json,errorResponse} from '@/commerce/server/http';
import {list,put,transaction} from '@/commerce/server/store';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const bucket='studio-connector-addresses';
type Connector={id:string;name:string;url:string};

async function owner(request:Request){
  const identity=requireIdentity(request);await authorizeCurrentCommerceIdentity(identity);return identity.id;
}
export async function GET(request:Request){
  try{return json(list<Connector>(bucket,await owner(request)));}catch(error){return errorResponse(error);}
}
export async function POST(request:Request){
  try{
    sameOrigin(request);
    const id=await owner(request),raw=await request.text();
    if(raw.length>4000)throw Error('连接器资料过大');
    const data=JSON.parse(raw),name=typeof data?.name==='string'?data.name.trim():'';
    if(!name||name.length>60||typeof data.url!=='string'||data.url.length>1024)throw Error('请填写名称和 HTTPS 服务地址');
    let url:URL;try{url=new URL(data.url);}catch{throw Error('请输入完整的 HTTPS 服务地址');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('请填写不含凭据或查询参数的 HTTPS 服务地址');
    const key=createHash('sha256').update(JSON.stringify([id,url.href])).digest('hex');
    return json(transaction(()=>{
      const items=list<Connector>(bucket,id);
      if(items.length>=200&&!items.some(v=>v.id===key))throw Error('自定义连接器已达 200 项');
      put(bucket,key,id,{id:key,name,url:url.href});return list<Connector>(bucket,id);
    }));
  }catch(error){return errorResponse(error);}
}
