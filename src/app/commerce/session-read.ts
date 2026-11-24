'use client';
/** Deduplicate the layout and workspace checks for the current main-site token. */
export type CommerceSessionRead={status:number;user?:{id:string};workspaceStorage?:{legacyOwner:boolean};retryAfter?:number};
let recent:{token:string;until:number;result:Promise<CommerceSessionRead>}|undefined;
export function readCommerceSession(token:string):Promise<CommerceSessionRead>{
 if(recent?.token===token&&Date.now()<recent.until)return recent.result;
 const result=(async()=>{
  const response=await fetch('/api/commerce/session',{cache:'no-store',headers:{Authorization:'Bearer '+token}});
  const body=await response.json().catch(()=>({}));const seconds=Number(response.headers.get('retry-after')||body.retryAfter||2);
  const retryAfter=response.status===429?Math.max(1,Number.isFinite(seconds)?seconds:2):0;
  return {status:response.status,user:body.user,workspaceStorage:body.workspaceStorage,retryAfter};
 })();
 const entry={token,until:Infinity,result};recent=entry;
 void result.then(value=>{entry.until=Date.now()+(value.status===429?(value.retryAfter||2)*1000:value.status===200?2000:0);},()=>{entry.until=0;});
 return result;
}
