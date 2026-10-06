import { getVoiceDb, getVoiceReadonlyDb } from './db';
import { OFFICIAL_VOICES } from '@/lib/vs/voices-data';
import { isChineseVoice, RECOMMENDED_VOICE_IDS } from '@/lib/vs/voice-curation';

type Stored = { id:string; speakerId:string; name:string; language:string; gender:string; category:string; description:string; tags:string; type:string; isActive:number; isRecommended:number };
type Override = { speakerId:string; isActive:number|null; isRecommended:number|null; name:string|null; description:string|null };
export function readVoiceCatalog(includeDisabled = false) {
  const db = getVoiceReadonlyDb();
  const rows = db.prepare('SELECT id,speakerId,name,language,gender,category,description,tags,type,isActive,isRecommended FROM Voice').all() as Stored[];
  const stored = new Map(rows.map(row => [row.speakerId,row]));
  const hasOverrides = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='VoiceCatalogOverride'").get();
  const overrides = new Map((hasOverrides ? db.prepare('SELECT * FROM VoiceCatalogOverride').all() as Override[] : []).map(row => [row.speakerId,row]));
  const parseTags = (value:string):string[] => { try { const tags = JSON.parse(value); return Array.isArray(tags) ? tags.filter(t => typeof t==='string') : []; } catch { return []; } };
  const officialIds = new Set(OFFICIAL_VOICES.map(v=>v.speakerId));
  const candidates = [
    ...OFFICIAL_VOICES.map(v=>({...v,id:'v2-'+v.speakerId})),
    ...rows.filter(v=>v.category==='模拟真人'&&!officialIds.has(v.speakerId)).map(v=>({...v,tags:parseTags(v.tags)})),
  ];
  const seen = new Set<string>();
  return candidates.filter(isChineseVoice).filter(v=>{if(seen.has(v.speakerId))return false;seen.add(v.speakerId);return true;}).map(v=>{
    const row=stored.get(v.speakerId), override=overrides.get(v.speakerId);
    return {...v, id:v.id, adminId:row?.id||v.id, engine:'volcano', isPublic:true,
      name:override?.name??v.name, description:override?.description??v.description,
      isActive:override?.isActive!==null&&override?.isActive!==undefined?!!override.isActive:row?.isActive!==0,
      isRecommended:override?.isRecommended!==null&&override?.isRecommended!==undefined?!!override.isRecommended:RECOMMENDED_VOICE_IDS.includes(v.speakerId),
      styleTags:v.tags||[],
    };
  }).filter(v=>includeDisabled||v.isActive);
}

export function updateVoiceCatalog(id:string, patch:Record<string,unknown>) {
  const current=readVoiceCatalog(true).find(v=>v.adminId===id);
  if(!current)return false;
  const db=getVoiceDb();
  db.transaction(()=>{
    db.exec('CREATE TABLE IF NOT EXISTS VoiceCatalogOverride (speakerId TEXT PRIMARY KEY,isActive INTEGER,isRecommended INTEGER,name TEXT,description TEXT,updatedAt INTEGER NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO VoiceCatalogOverride (speakerId,updatedAt) VALUES (?,?)').run(current.speakerId,Date.now());
    const keys=Object.keys(patch).filter(k=>['isActive','isRecommended','name','description'].includes(k));
    if(keys.length)db.prepare('UPDATE VoiceCatalogOverride SET '+keys.map(k=>k+'=?').join(',')+',updatedAt=? WHERE speakerId=?').run(...keys.map(k=>typeof patch[k]==='boolean'?(patch[k]?1:0):patch[k]),Date.now(),current.speakerId);
  })();
  return true;
}
