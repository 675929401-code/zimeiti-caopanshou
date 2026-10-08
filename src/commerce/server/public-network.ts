import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Readable} from 'node:stream';

export function isPrivateAddress(address:string){
 if(address.includes(':'))return address==='::1'||address==='::'||/^f[cd]|^fe[89ab]|^::ffff:/i.test(address);
 const p=address.split('.').map(Number);return p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&(p[1]===168||p[1]===0))||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===198&&(p[1]===18||p[1]===19));
}
export async function publicAddresses(hostname:string){
 const host=hostname.replace(/^\[|\]$/g,'');
 if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local'))throw Error('禁止访问本地或私有网络地址');
 if(isIP(host)){if(isPrivateAddress(host))throw Error('禁止访问本地或私有网络地址');return [{address:host,family:isIP(host)}];}
 const local=await lookup(host,{all:true}).catch(()=>[]);
 if(local.length&&local.every(a=>!isPrivateAddress(a.address)))return local;
 // A local proxy may return benchmark/ULA addresses for public hosts. Resolve
 // public DNS separately, then pin the verified address for the HTTPS socket.
 const dnsURL=new URL('https://cloudflare-dns.com/dns-query');dnsURL.searchParams.set('name',host);dnsURL.searchParams.set('type','A');
 const response=await fetch(dnsURL,{headers:{Accept:'application/dns-json'},redirect:'error',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error('无法核验公网媒体地址');
 const data=await response.json();const addresses=(Array.isArray(data.Answer)?data.Answer:[]).filter((a:{type:number;data:string})=>a.type===1&&isIP(a.data)===4).map((a:{data:string})=>({address:a.data,family:4}));
 if(!addresses.length||addresses.some((a:{address:string})=>isPrivateAddress(a.address)))throw Error('禁止访问本地或私有网络地址');return addresses;
}
export async function fetchPublic(url:string,init:RequestInit={}){
 const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password)throw Error('地址必须为公开 HTTPS 地址');
 const addresses=await publicAddresses(target.hostname);const address=addresses.find((a:{family:number})=>a.family===4)||addresses[0];const headers=Object.fromEntries(new Headers(init.headers));headers['accept-encoding']='identity';
 if(init.body!=null&&typeof init.body!=='string')throw Error('此接口仅支持 JSON 请求');if(typeof init.body==='string')headers['content-length']=String(Buffer.byteLength(init.body));
 return new Promise<Response>((resolve,reject)=>{
  const request=https.request(target,{method:init.method||'GET',headers,signal:init.signal||AbortSignal.timeout(240000),lookup:((_host:unknown,options:unknown,callback:(err:Error|null,address?:string|ReadonlyArray<{address:string;family:number}>,family?:number)=>void)=>{if((options as {all?:boolean})?.all)callback(null,[address]);else callback(null,address.address,address.family);}) as never},response=>{
   const resultHeaders=new Headers();for(const [name,value] of Object.entries(response.headers))if(value&&name!=='set-cookie')resultHeaders.set(name,Array.isArray(value)?value.join(', '):value);
   const status=response.statusCode||502;if(status>=300&&status<400){response.resume();reject(Error('媒体地址发生重定向，请使用最终的公开链接'));return;}
   resolve(new Response([204,205,304].includes(status)?null:Readable.toWeb(response) as ReadableStream,{status,headers:resultHeaders}));
  });request.on('error',()=>reject(Error('公网模型或媒体连接失败')));if(init.body)request.write(init.body);request.end();
 });
}
