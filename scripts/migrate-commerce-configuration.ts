import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

dotenv.config({path:path.resolve(process.cwd(),'.env.local'),quiet:true});

const stamp=()=>new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
const sha=(value:Buffer|string)=>crypto.createHash('sha256').update(value).digest('hex');
function uuid(scope:string){const h=sha('commerce-config-migration/v1:'+scope);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function stable(value:unknown):string{if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;return JSON.stringify(value);}
function configuredId(name:string,fallback=''){return String(process.env[name]||fallback).trim();}
function configuredIds(name:string){return [...new Set(String(process.env[name]||'').split(',').map((value)=>value.trim()).filter(Boolean))];}

async function copyIfPresent(source:string,target:string){try{const data=await fs.readFile(source);await fs.writeFile(target,data);return {name:path.basename(target),bytes:data.length,sha256:sha(data)};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}

async function main(){
  const apply=process.argv.includes('--apply');
  const output=path.resolve('运行日志','Commerce统一实施-20260914','configuration-migration-'+stamp());
  await fs.mkdir(output,{recursive:true});
  const [{directorCatalog,baselineDirectorCatalog,directorOverlayReadonly},{templates},{operations},{IMAGE_SKILLS},{get,runtimeDir,db},{manifestHash}]=await Promise.all([
    import('../src/commerce/server/director-catalog'),import('../src/commerce/server/prompts'),import('../src/commerce/server/operation-routing'),
    import('../src/commerce/components/commerce-agent/catalog'),import('../src/commerce/server/store'),import('../src/commerce/server/configuration-platform'),
  ]);
  db().exec('PRAGMA wal_checkpoint(PASSIVE)');
  const sqliteBase=path.join(runtimeDir(),'commerce.sqlite');
  const sqliteFiles=(await Promise.all(['','-wal','-shm'].map((suffix)=>copyIfPresent(sqliteBase+suffix,path.join(output,'commerce.sqlite'+suffix))))).filter(Boolean);
  const overlay=directorOverlayReadonly();
  const active=new Map(directorCatalog().map((card)=>[card.key,card]));
  const all=new Map([...baselineDirectorCatalog(),...overlay.custom].map((card)=>[card.key,active.get(card.key)||card]));
  const promptRows=templates().map((prompt)=>({
    id:uuid(`prompt:${prompt.id}:v${prompt.version}`),prompt_key:prompt.id,version:prompt.version,name:prompt.name,content:prompt.content,
    source:'independent-implementation',change_note:'从带货业务 SQLite 迁入首个共享配置草稿',status:'draft',
  }));
  const promptIds=new Map(promptRows.map((row)=>[row.prompt_key,row.id]));
  const directorCards=[...all.values()].map((card,index)=>{
    const cardId=uuid(`card:${card.key}`),versionId=uuid(`card-version:${card.key}:v1`),disabled=overlay.disabled.includes(card.key);
    return {identity:{id:cardId,stable_key:card.key,status:disabled?'disabled':'draft'},version:{
      id:versionId,card_id:cardId,version:1,display:{name:card.name,description:card.description,category:card.category,icon:card.icon,recommended:card.recommended,sortOrder:index,visibility:disabled?'hidden':'members'},
      material_slots:card.slots.map((slot)=>({id:slot.key,label:slot.label,responsibility:`仅承担“${slot.label}”素材职责，不得与其他槽位互换`,mediaTypes:slot.kinds,minCount:slot.min,maxCount:slot.max,cover:slot.cover})),
      input_fields:[
        {id:'spokenLanguage',type:'select',title:'语言',required:true,defaultValue:'中文',options:['中文','英文','泰国','马来西亚','巴西','不限']},
        {id:'scriptDuration',type:'number',title:'脚本时长（秒）',required:true,defaultValue:15,validation:{min:4,max:80}},
        {id:'generateAudio',type:'boolean',title:'生成声音',required:false,defaultValue:true},
      ],executor_type:'director',prompt_version_id:promptIds.get(`director.${card.key}`)||promptIds.get('director')||null,knowledge_document_ids:[],
      output_contract:{schema:'director-script/v2',requiredSections:['素材职责','事实台账','整体设定','人物关系','连续时间轴','镜头动作','机位运镜','声音','商品一致性','禁止项','转化收尾'],applicationRequired:true},
      quality_rules:{hardErrors:['虚构商品事实','素材职责互换','时间轴断裂','局部修改覆盖未要求镜头'],minimumScore:90},model_policy:{operationId:`director.${card.key}`},video_defaults:{durationSeconds:15,aspectRatio:'9:16',resolution:'720p',generateAudio:true},
      test_cases:[{id:'minimum-input',kind:'minimum'},{id:'standard-product',kind:'standard'},{id:'same-session-revision',kind:'revision'}],
      status:disabled?'disabled':'draft',validation_result:{qualityScore:0,canaryPassed:false,migrationBaseline:true},change_note:'从现有编导目录迁入首个共享配置草稿',
    }};
  });
  const imageCards=IMAGE_SKILLS.map((skill,index)=>{
    const stableKey=`image.${skill.id}`,cardId=uuid(`card:${stableKey}`),versionId=uuid(`card-version:${stableKey}:v1`);
    return {identity:{id:cardId,stable_key:stableKey,status:'draft'},version:{
      id:versionId,card_id:cardId,version:1,display:{name:skill.name,description:skill.description,category:`AI图片/${skill.category}`,icon:'/commerce/image-icon.png',recommended:skill.id==='default',sortOrder:directorCards.length+index,visibility:'members'},
      material_slots:skill.slots.map((slot)=>({id:slot.id,label:slot.label,responsibility:`仅承担“${slot.label}”素材职责，不得与其他槽位互换`,mediaTypes:slot.kinds,minCount:slot.min,maxCount:slot.max})),
      input_fields:[
        {id:'prompt',type:'textarea',title:'创作要求',required:skill.promptRequired===true,defaultValue:''},
        {id:'aspectRatio',type:'select',title:'画幅',required:true,defaultValue:'1:1',options:['1:1','3:4','4:3','9:16','16:9']},
        {id:'resolution',type:'select',title:'分辨率',required:true,defaultValue:'2K',options:['1K','2K','4K']},
        {id:'outputFormat',type:'select',title:'输出格式',required:true,defaultValue:'png',options:['png','jpg','webp']},
      ],executor_type:'image_skill',prompt_version_id:promptIds.get(skill.id)||null,knowledge_document_ids:[],
      output_contract:{schema:'commerce-image/v1',outputCount:1,assetRequired:true,versionedRedo:true},
      quality_rules:{hardErrors:['素材职责互换','商品或人物身份漂移','输出数量与合同不符'],minimumScore:90},model_policy:{operationId:`image.${skill.id}`},video_defaults:{},
      test_cases:[{id:'minimum-input',kind:'minimum'},{id:'maximum-input',kind:'maximum'},{id:'invalid-material-role',kind:'invalid'}],
      status:'draft',validation_result:{qualityScore:0,canaryPassed:false,migrationBaseline:true},change_note:'从现有图片技能目录迁入首个共享配置草稿',
    }};
  });
  const cards=[...directorCards,...imageCards];
  const storedDefaults=get<Record<string,string>>('settings','defaults','system')||{};
  const defaults={
    agent:configuredId('COMMERCE_CONFIG_DEFAULT_AGENT_MODEL_ID',storedDefaults.agent),
    image:configuredId('COMMERCE_CONFIG_DEFAULT_IMAGE_MODEL_ID',storedDefaults.image),
    video:configuredId('COMMERCE_CONFIG_DEFAULT_VIDEO_MODEL_ID',storedDefaults.video),
  };
  const fallbackModels={
    agent:configuredIds('COMMERCE_CONFIG_FALLBACK_AGENT_MODEL_IDS'),
    image:configuredIds('COMMERCE_CONFIG_FALLBACK_IMAGE_MODEL_IDS'),
    video:configuredIds('COMMERCE_CONFIG_FALLBACK_VIDEO_MODEL_IDS'),
  };
  const routeRows=operations().map((route)=>({
    id:uuid(`route:${route.id}:v${route.revision}`),operation_id:route.id,version:route.revision,label:route.label,model_kind:route.kind,
    primary_model_id:route.modelId||defaults[route.kind]||'',fallback_model_ids:[...new Set([...(route.fallbackModelIds||[]),...fallbackModels[route.kind]])].filter((id)=>id!==(route.modelId||defaults[route.kind]||'')),capability_requirements:route.capabilityRequirements||(/^image\./.test(route.id)?(()=>{const skill=IMAGE_SKILLS.find((entry)=>`image.${entry.id}`===route.id);const maxReferences=skill?.slots.reduce((sum,item)=>sum+item.max,0)||0;return maxReferences?{supportsReferenceInput:true,maxReferenceImages:maxReferences}:{};})():{}),
    user_selectable:route.kind==='video'&&route.userSelectable===true,status:'draft',change_note:'从带货业务 SQLite 迁入首个共享配置草稿',
  }));
  const migration={
    schema:'commerce-config-migration/v1',createdAt:new Date().toISOString(),source:{runtimeDir:runtimeDir(),sqliteFiles,overlay},
    counts:{cards:cards.length,directorCards:directorCards.length,imageSkillCards:imageCards.length,imageSkills:IMAGE_SKILLS.length,prompts:promptRows.length,routes:routeRows.length},
    defaults:{agent:defaults.agent,image:defaults.image,video:defaults.video},cards,prompts:promptRows,knowledge:[],routes:routeRows,
  };
  // Bind the approval hash to configuration content and the authoritative
  // SQLite file, excluding timestamps and volatile WAL/SHM evidence.
  const migrationPayload={schema:migration.schema,source:{sqliteFiles:sqliteFiles.filter((file)=>file?.name==='commerce.sqlite'),overlay},counts:migration.counts,defaults:migration.defaults,cards,prompts:promptRows,knowledge:[],routes:routeRows};
  const migrationSha=sha(stable(migrationPayload));
  await fs.writeFile(path.join(output,'commerce-configuration.json'),JSON.stringify(migration,null,2));
  const manifest={schema:'commerce-config/v1' as const,cardVersionIds:cards.filter((row)=>row.version.status!=='disabled').map((row)=>row.version.id),promptVersionIds:promptRows.map((row)=>row.id),knowledgeDocumentIds:[] as string[],operationRouteIds:routeRows.map((row)=>row.id),defaultModels:migration.defaults};
  const release={manifest,manifestSha256:manifestHash(manifest),validation:{migrationBaseline:true,productionCanaryComplete:false,issues:[...(!migration.defaults.agent?['缺少 agent 默认模型']:[]),...(!migration.defaults.image?['缺少 image 默认模型']:[]),...(!migration.defaults.video?['缺少 video 默认模型']:[]),...routeRows.filter((row)=>!row.primary_model_id).map((row)=>`路由 ${row.operation_id} 缺少主模型`)]}};
  await fs.writeFile(path.join(output,'release-candidate.json'),JSON.stringify(release,null,2));
  const inventory={schema:'commerce-config-migration-receipt/v1',createdAt:new Date().toISOString(),migrationSha256:migrationSha,releaseManifestSha256:release.manifestSha256,counts:migration.counts,sqliteFiles,applyRequested:apply};
  await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(inventory,null,2));
  if(apply){
    if(process.env.COMMERCE_CONFIG_MIGRATION_ACK!==migrationSha)throw Error(`应用迁移前必须把 COMMERCE_CONFIG_MIGRATION_ACK 设置为本次迁移哈希 ${migrationSha}`);
    const {getSupabaseAdminClient}=await import('../src/storage/database/supabase-client');const shared=getSupabaseAdminClient();
    for(const row of cards){const existing=await shared.from('commerce_cards').select('id').eq('stable_key',row.identity.stable_key).maybeSingle();if(existing.error)throw Error(`预检卡片身份失败：${existing.error.message}`);if(existing.data&&existing.data.id!==row.identity.id)throw Error(`迁移预检拒绝覆盖已有卡片 ${row.identity.stable_key}：身份 ID 与迁移快照不同`);}
    for(const row of promptRows){const existing=await shared.from('commerce_prompt_versions').select('id').eq('prompt_key',row.prompt_key).eq('version',row.version).maybeSingle();if(existing.error)throw Error(`预检提示词失败：${existing.error.message}`);if(existing.data&&existing.data.id!==row.id)throw Error(`迁移预检拒绝覆盖已有提示词 ${row.prompt_key} v${row.version}`);}
    for(const row of routeRows){const existing=await shared.from('commerce_operation_routes').select('id').eq('operation_id',row.operation_id).eq('version',row.version).maybeSingle();if(existing.error)throw Error(`预检路由失败：${existing.error.message}`);if(existing.data&&existing.data.id!==row.id)throw Error(`迁移预检拒绝覆盖已有路由 ${row.operation_id} v${row.version}`);}
    for(const row of promptRows){const result=await shared.from('commerce_prompt_versions').upsert(row,{onConflict:'id'});if(result.error)throw Error(`写入提示词失败：${result.error.message}`);}
    for(const row of cards){const result=await shared.from('commerce_cards').upsert(row.identity,{onConflict:'stable_key'});if(result.error)throw Error(`写入卡片身份失败：${result.error.message}`);}
    for(const row of cards){const result=await shared.from('commerce_card_versions').upsert(row.version,{onConflict:'id'});if(result.error)throw Error(`写入卡片版本失败：${result.error.message}`);}
    for(const row of routeRows){const result=await shared.from('commerce_operation_routes').upsert(row,{onConflict:'id'});if(result.error)throw Error(`写入路由失败：${result.error.message}`);}
    const latest=await shared.from('commerce_config_releases').select('release_version').order('release_version',{ascending:false}).limit(1);if(latest.error)throw Error(`读取发布序号失败：${latest.error.message}`);
    const priorRelease=await shared.from('commerce_config_releases').select('id').eq('manifest_sha256',release.manifestSha256).eq('status','draft').limit(1).maybeSingle();if(priorRelease.error)throw Error(`核对迁移发布草稿失败：${priorRelease.error.message}`);
    const releasePayload={manifest,manifest_sha256:release.manifestSha256,validation_result:{...release.validation,migrationSha256:migrationSha},change_note:'迁移基线，仅供管理员验证，不自动发布'};
    const inserted=priorRelease.data
      ?await shared.from('commerce_config_releases').update(releasePayload).eq('id',priorRelease.data.id).eq('status','draft').select('id').single()
      :await shared.from('commerce_config_releases').insert({release_version:Number(latest.data?.[0]?.release_version||0)+1,status:'draft',is_current:false,...releasePayload}).select('id').single();
    if(inserted.error)throw Error(`写入迁移发布草稿失败：${inserted.error.message}`);
    await fs.writeFile(path.join(output,'apply-receipt.json'),JSON.stringify({releaseId:inserted.data.id,reusedExistingDraft:Boolean(priorRelease.data),appliedAt:new Date().toISOString(),migrationSha256:migrationSha},null,2));
  }
  console.log(JSON.stringify({ok:true,applied:apply,output,migrationSha256:migrationSha,releaseManifestSha256:release.manifestSha256,counts:migration.counts,issues:release.validation.issues}));
}

main().catch((error)=>{console.error(error);process.exitCode=1;});
