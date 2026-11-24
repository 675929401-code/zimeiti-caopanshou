export async function readOwnedMedia<T>(url:string,signal:AbortSignal):Promise<T>{
 for(let attempt=0;;attempt++){
  signal.throwIfAborted();
  const response=await fetch(url,{cache:'no-store',signal}),result=await response.json();
  if(response.ok)return result;
  if(response.status!==429||attempt>=2)throw Error(result.error||'素材读取失败');
  const seconds=Number(response.headers.get('Retry-After')||result.retryAfter||2);
  const delay=Number.isFinite(seconds)?Math.max(1,Math.min(60,seconds)):2;
  await new Promise<void>((resolve,reject)=>{
   const stop=()=>{clearTimeout(timer);reject(signal.reason);};
   const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},delay*1000+200);
   signal.addEventListener('abort',stop,{once:true});
   if(signal.aborted)stop();
  });
 }
}
