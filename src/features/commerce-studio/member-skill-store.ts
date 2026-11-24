import {createHash} from 'node:crypto';
import {db,get,list,put,remove,transaction} from '@/commerce/server/store';
import {builtinSkills,type MemberSkill,type SkillLibrary} from './member-skills';

const customBucket='studio-custom-skills', installBucket='studio-skill-installs';
const customId=/^custom-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function recordId(owner:string,id:string){return createHash('sha256').update(JSON.stringify([owner,id])).digest('hex');}
export function readSkillLibrary(owner:string):SkillLibrary{
  const custom=list<MemberSkill>(customBucket,owner);
  const stats:NonNullable<SkillLibrary['stats']>=Object.fromEntries([...builtinSkills,...custom].map(s=>[s.id,{installs:0,opens:0}]));
  for(const row of db().prepare('SELECT json_extract(value,\'$\') AS skill,count(*) AS total FROM records WHERE bucket=? GROUP BY skill').all(installBucket)){
    const entry=stats[String(row.skill)];if(entry)entry.installs=Number(row.total);
  }
  for(const row of db().prepare("SELECT json_extract(value,'$.skill') AS skill,sum(json_extract(value,'$.count')) AS total FROM records WHERE bucket=? GROUP BY skill").all('studio-skill-opens')){
    const entry=stats[String(row.skill)];if(entry)entry.opens=Number(row.total);
  }
  return {custom,installed:list<string>(installBucket,owner),stats};
}
export function changeSkill(owner:string,body:Record<string,unknown>):SkillLibrary{
  const id=body.id;if(typeof id!=='string'||id.length>100)throw Error('技能标识无效');
  const key=recordId(owner,id);
  return transaction(()=>{
    if(body.action==='create'){
      if(!customId.test(id)||typeof body.name!=='string'||!body.name.trim()||body.name.length>60||typeof body.instruction!=='string'||!body.instruction.trim()||body.instruction.length>4000)throw Error('请填写技能名称（最多 60 字）和创作指令（最多 4000 字）');
      const prior=get<MemberSkill>(customBucket,key,owner);
      const name=body.name.trim(),instruction=body.instruction.trim();
      if(prior&&(prior.name!==name||prior.instruction!==instruction))throw Error('此技能已创建，请重新打开');
      if(!prior){
        if(list(customBucket,owner).length>=200)throw Error('自建技能已达 200 项');
        put(customBucket,key,owner,{id,name,instruction,description:instruction.slice(0,100)});
        put(installBucket,key,owner,id);
      }
    }else{
      const skill=builtinSkills.find(item=>item.id===id)||get<MemberSkill>(customBucket,key,owner);
      if(!skill)throw Error('未找到这个技能');
      if(body.action==='install')put(installBucket,key,owner,id);
      else if(body.action==='uninstall')remove(installBucket,key,owner);
      else if(body.action==='open'){
        if(!get(installBucket,key,owner))throw Error('请先安装技能');
        const attempt=body.requestId;
        if(typeof attempt!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(attempt))throw Error('使用记录标识无效');
        const bucket='studio-skill-opens',old=get<{count:number;recent:string[]}>(bucket,key,owner);
        if(!old?.recent.includes(attempt))put(bucket,key,owner,{skill:id,count:(old?.count||0)+1,recent:[...(old?.recent||[]).slice(-63),attempt]});
      }
      else throw Error('技能操作无效');
    }
    return readSkillLibrary(owner);
  });
}
