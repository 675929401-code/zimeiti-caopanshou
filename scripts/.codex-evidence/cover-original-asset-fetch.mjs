import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';
export async function main(){
  const origin=process.env.LOCAL_NAV_ORIGIN;assert.equal(origin,'http://127.0.0.1:5000');
  const token=process.env.LOCAL_NAV_ADMIN_TOKEN;assert.ok(token);const auth={Authorization:'Bearer '+token};
  const h=await fetch(origin+'/api/cover/history?page=1',{headers:auth,cache:'no-store'});assert.ok(h.ok);const history=await h.json();
  const saved=history.records.find(x=>x.assetId==='32160d6e-d5be-4630-b2f0-8bccb47aaebf'&&x.historyRecordId==='b04e9a4d-cc4a-55ad-9143-c68013514961');assert.ok(saved?.cloudStored);
  const r=await fetch(origin+'/api/storage/files/'+saved.assetId+'/content',{headers:auth});assert.ok(r.ok);const bytes=Buffer.from(await r.arrayBuffer());
  const meta=await sharp(bytes).metadata();assert.equal(meta.width,1080);assert.equal(meta.height,1440);
  const out='.codex-evidence/cover-paid-20261106-3fd15654/original-download/actual-saved-cover.png';await fs.writeFile(out,bytes);
  console.log(JSON.stringify({passed:true,method:'owned-file-content-GET-only',modelSubmissions:0,assetId:saved.assetId,width:meta.width,height:meta.height,file:out}));
}
