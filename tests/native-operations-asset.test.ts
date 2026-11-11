import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthUser, getSupabase } from "../src/lib/api-middleware";
import { readNativePublishingAsset, nativeAssetRange } from "../src/lib/server/native-operations-asset";
const id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const row = { id, owner_id: owner, connection_id: "connection-a", state: "ready", public_url: "https://assets.aitoearn.cn/owned.png", size: 4, mime: "image/png", file_name: "owned.png", sha256: "a".repeat(64) };
function database(value: Record<string, unknown> = row) {
  const filters: Record<string, unknown> = {};
  const builder = { select() { return builder; }, eq(key: string, value: unknown) { filters[key] = value; return builder; }, async maybeSingle() { return { data: Object.entries(filters).every(([k,v])=>value[k]===v) ? value : null, error: null }; } };
  return { from(table: string) { assert.equal(table, "pub3_assets"); return builder; } } as unknown as ReturnType<typeof getSupabase>;
}
const user = { id: owner } as AuthUser;
const configuration = () => ({ namespace: "connection-a" });
const request = (range?: string) => new Request("http://127.0.0.1:5000/api/native-operations/assets/"+id+"/content", { headers: range ? { Range: range, Authorization: "Bearer never-forward" } : { Authorization: "Bearer never-forward" } });
test("native asset content is owner and connection scoped before network access", async () => {
  let calls=0; const fetchAsset=async()=>{calls++; throw new Error("UNEXPECTED_NETWORK");};
  await assert.rejects(readNativePublishingAsset(request(),{id:"foreign"} as AuthUser,database(),id,{configuration,fetchAsset}),{code:"NATIVE_ASSET_UNAVAILABLE"});
  await assert.rejects(readNativePublishingAsset(request(),user,database(),id,{configuration:()=>({namespace:"connection-b"}),fetchAsset}),{code:"NATIVE_ASSET_UNAVAILABLE"});
  assert.equal(calls,0);
});
test("native asset Range is normalized and upstream receives no member or vendor authorization", async () => {
  const response=await readNativePublishingAsset(request("bytes=1-2"),user,database(),id,{configuration,fetchAsset:async(url,options)=>{
    assert.equal(url,row.public_url); assert.equal(options?.networkPolicy,"system-dns-pinned");
    const headers=new Headers(options?.headers);assert.equal(headers.get("range"),"bytes=1-2");assert.equal(headers.get("authorization"),null);assert.equal(headers.get("cookie"),null);
    return {finalUrl:String(url),response:new Response(new Uint8Array([1,2]),{status:206,headers:{"Content-Type":"image/png","Content-Length":"2","Content-Range":"bytes 1-2/4"}})};
  }});
  assert.equal(response.status,206);assert.equal(response.headers.get("cache-control"),"private, no-store, max-age=0");assert.equal(response.headers.get("x-content-type-options"),"nosniff");assert.equal((await response.arrayBuffer()).byteLength,2);
  assert.deepEqual(nativeAssetRange("bytes=-2",4),{start:2,end:3});
});
test("invalid range and nonofficial stored URL never trigger a request", async () => {
  let calls=0;const fetchAsset=async()=>{calls++;throw new Error("UNEXPECTED_NETWORK");};
  assert.equal((await readNativePublishingAsset(request("bytes=8-9"),user,database(),id,{configuration,fetchAsset})).status,416);
  await assert.rejects(readNativePublishingAsset(request(),user,database({...row,public_url:"https://attacker.example/owned.png"}),id,{configuration,fetchAsset}),{code:"NATIVE_ASSET_UNAVAILABLE"});
  assert.equal(calls,0);
});
test("redirect, incorrect media type and inconsistent byte length fail closed", async () => {
  for(const response of [new Response(null,{status:302,headers:{Location:"https://attacker.example/"}}),new Response(new Uint8Array(4),{headers:{"Content-Type":"text/html"}}),new Response(new Uint8Array(4),{headers:{"Content-Type":"image/png","Content-Length":"3"}})]){
    await assert.rejects(readNativePublishingAsset(request(),user,database(),id,{configuration,fetchAsset:async()=>({finalUrl:row.public_url,response})}),{code:"NATIVE_ASSET_UNAVAILABLE"});
  }
  const response=await readNativePublishingAsset(request(),user,database(),id,{configuration,fetchAsset:async()=>({finalUrl:row.public_url,response:new Response(new Uint8Array(5),{headers:{"Content-Type":"image/png"}})})});
  await assert.rejects(response.arrayBuffer(),/NATIVE_ASSET_SIZE_MISMATCH/);
});
