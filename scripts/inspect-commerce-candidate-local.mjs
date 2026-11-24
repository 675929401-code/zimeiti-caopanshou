import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function main(args=process.argv.slice(2)) {
  const origin=process.env.LOCAL_NAV_ORIGIN, token=process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.equal(origin,'http://127.0.0.1:5000');
  assert.ok(token,'需要本机验收会话');
  const arg=key=>args.find(value=>value.startsWith(key+'='))?.slice(key.length+1);
  const releaseId=arg('--release'), output=arg('--output');
  assert.match(releaseId||'',/^[\da-f-]{36}$/i);
  const headers={Authorization:'Bearer '+token, ...(process.env.LOCAL_ADMIN_STEP_UP_TOKEN?{'x-admin-step-up':process.env.LOCAL_ADMIN_STEP_UP_TOKEN}:{})};
  async function request(url,body){
    const response=await fetch(origin+url,{method:body?'POST':'GET',headers:{...headers,'Content-Type':'application/json',Origin:origin},body:body?JSON.stringify(body):undefined,cache:'no-store',redirect:'error'});
    const data=await response.json().catch(()=>({}));
    return {status:response.status,data};
  }
  const cash=await request('/api/cash/balance'), overview=await request('/api/admin/commerce');
  const report={checkedAt:new Date().toISOString(),instance:origin,walletStatus:cash.status,balance:cash.data.balance??null,adminStatus:overview.status,adminError:overview.data.error||null,releaseId};
  if(overview.status===200){
    const models=overview.data.models||[];
    const rows=Array.isArray(models)?models:Object.values(models).flat();
    report.models=rows.map(m=>({id:m.id,name:m.name||m.displayName,kind:m.kind,publicPrice:m.publicPrice,costPrice:m.costPrice,unit:m.billingUnit,enabled:m.enabled}));
    const current=overview.data.current;report.currentVersion=current?.release_version||overview.data.runtime?.releaseVersion;
    const target=arg('--model');
    if(target){
      const quote=await request('/api/admin/commerce/models/canary',{action:'quote',kind:'agent',modelId:target});
      report.quote={status:quote.status,error:quote.data.error||null,...quote.data.quote};
    }
  }
  assert.ok(output&&path.isAbsolute(output));
  await fs.writeFile(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({walletStatus:cash.status,balance:report.balance,adminStatus:report.adminStatus,adminError:report.adminError,modelCount:report.models?.length,quote:report.quote||null}));
}
if(process.env.LOCAL_ADMIN_STEP_UP_TOKEN&&process.argv[1]?.endsWith('inspect-commerce-candidate-local.mjs')) main().catch(err=>{console.error(err.message);process.exitCode=1;});
