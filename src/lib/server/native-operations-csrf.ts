import "server-only";
import { createHash,createHmac,randomBytes,timingSafeEqual } from "node:crypto";
/** Explicit dependency keeps local tests entirely outside the credential reader. */
export function createNativeCsrfCodec(secret:string,now:()=>number=Date.now){
 if(secret.length<32)throw new Error("NATIVE_CSRF_SIGNING_KEY_INVALID");
 const signature=(owner:string,session:string,nonce:string,expires:string,permission:string)=>createHmac("sha256",secret).update(["native-csrf-v1",owner,createHash("sha256").update(session).digest("hex"),nonce,expires,permission].join("\n")).digest("base64url");
 return {
  mint(owner:string,session:string,permission:string){const nonce=randomBytes(24).toString("base64url"),expires=String(now()+20*60*1000);return `${nonce}.${expires}.${signature(owner,session,nonce,expires,permission)}`;},
  verify(owner:string,session:string,header:string,cookie:string,permission:string){if(header!==cookie||header.length>300)return false;const match=header.match(/^([A-Za-z0-9_-]{32})\.(\d{13})\.([A-Za-z0-9_-]{43})$/);if(!match||Number(match[2])<=now()||Number(match[2])>now()+20*60*1000)return false;return timingSafeEqual(Buffer.from(match[3]),Buffer.from(signature(owner,session,match[1],match[2],permission)));},
 };
}
export function createNativeSelectionCodec(secret:string,now:()=>number=Date.now){
 if(secret.length<32)throw new Error("NATIVE_SELECTION_SIGNING_KEY_INVALID");
 const canonical=(entry:unknown):unknown=>Array.isArray(entry)?entry.map(canonical):entry&&typeof entry==="object"?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>[key,canonical(value)])):entry;
 const digest=(owner:string,items:unknown,expires:string)=>createHmac("sha256",secret).update(JSON.stringify(["native-filter-selection-v1",owner,expires,canonical(items)])).digest("hex");
 return {
  mint(owner:string,items:unknown){const expires=String(now()+20*60*1000);return `native-selection.v1.${expires}.${digest(owner,items,expires)}`;},
  verify(owner:string,items:unknown,value:string){const match=value.match(/^native-selection\.v1\.(\d{13})\.([a-f0-9]{64})$/);if(!match||Number(match[1])<=now()||Number(match[1])>now()+20*60*1000)return false;return timingSafeEqual(Buffer.from(match[2]),Buffer.from(digest(owner,items,match[1])));},
 };
}
