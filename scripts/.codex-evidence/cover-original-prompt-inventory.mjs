import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

export async function main() {
  const base=process.env.COZE_SUPABASE_URL;
  assert.equal(new URL(base).origin,'http://127.0.0.1:54321');
  const service=process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  assert.ok(service);
  const read=async(table,select)=>{
    const result=[];
    for(let offset=0;;offset+=500){
      const u=new URL('/rest/v1/'+table,base);
      u.searchParams.set('select',select);u.searchParams.set('limit','500');u.searchParams.set('offset',String(offset));u.searchParams.set('order','id.asc');
      const r=await fetch(u,{headers:{apikey:service,Authorization:'Bearer '+service}});
      assert.ok(r.ok,'READ_ONLY_'+table+'_'+r.status);
      const rows=await r.json();result.push(...rows);if(rows.length<500)break;
      assert.ok(offset<10000,'BOUNDED_INVENTORY_LIMIT');
    }
    return result;
  };
  const [agents,versions]=await Promise.all([
    read('agents','id,name,description,system_prompt,config_revision,deleted_at'),
    read('prompt_versions','id,agent_id,prompt,agent_revision,prompt_hash,created_at')
  ]);
  const names=new Map(agents.map(x=>[x.id,x.name]));
  const clean=s=>String(s||'').replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED_JWT]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[REDACTED_KEY]');
  const score=s=> (s.match(/好运降临|哈尼有话讲/g)||[]).length*10 +(s.match(/封面/g)||[]).length + (s.includes('内在逻辑')?4:0);
  const candidates=[];
  for(const row of [...agents.map(x=>({...x,kind:'agent',agent_id:x.id,prompt:x.system_prompt})),...versions.map(x=>({...x,kind:'version',name:names.get(x.agent_id)}))]){
    const text=String(row.prompt||'');const combined=String(row.name||'')+'\n'+text;
    if(!/好运降临|哈尼有话讲|封面/.test(combined))continue;
    const keyHits=[...new Set((combined.match(/好运降临|哈尼有话讲|封面|摘要|重点|内在逻辑|口播|标题/g)||[]))];
    const snippets=[];const re=/好运降临|哈尼有话讲|封面|内在逻辑/g;let m;
    while((m=re.exec(combined))&&snippets.length<6)snippets.push(clean(combined.slice(Math.max(0,m.index-90),m.index+210)));
    candidates.push({kind:row.kind,id:row.id,agentId:row.agent_id,name:row.name,revision:row.agent_revision||row.config_revision,createdAt:row.created_at||null,deleted:!!row.deleted_at,length:text.length,sha256:createHash('sha256').update(text).digest('hex'),score:score(combined),keyHits,snippets});
  }
  candidates.sort((a,b)=>b.score-a.score);
  const report={queriedAt:new Date().toISOString(),target:'local_loopback_database',readOnly:true,agentCount:agents.length,versionCount:versions.length,candidates};
  const dest='.codex-evidence/cover-paid-20261106-3fd15654/original-prompt-local-db-inventory.json';
  await fs.writeFile(dest,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({readOnly:true,agentCount:agents.length,versionCount:versions.length,candidateCount:candidates.length,topCandidates:candidates.slice(0,12),report:dest}));
}
