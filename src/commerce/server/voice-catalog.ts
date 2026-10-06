import observed from '../components/commerce-agent/observed-catalog.json';
import {get,put} from './store';

/** 系统音色——来源：对标站公开接口 /api/v1/voice-profiles/system-voices（2026-09-09 捕获）。
 * `model` is observed catalog metadata. It is not an executable main-site
 * model binding until a published voice route resolves it server-side. */
export type SystemVoice={
  voice:string;display_name:string;description:string;gender:'female'|'male';language_hint:string;model:string;
};
export type VoiceCatalogState={disabled:string[];edits:Record<string,{display_name?:string;description?:string}>};

const BUCKET='voice-catalog',ID='state',OWNER='system';

const base:SystemVoice[]=[
  {voice:'Cherry',display_name:'芊悦',description:'阳光积极、亲切自然小姐姐',gender:'female',language_hint:'普通话 / 多语言',model:'qwen3-tts-flash'},
  {voice:'Serena',display_name:'苏瑶',description:'温柔小姐姐',gender:'female',language_hint:'普通话',model:'qwen3-tts-flash'},
  {voice:'Ethan',display_name:'晨煦',description:'标准普通话，带部分北方口音。阳光、温暖、治愈男声',gender:'male',language_hint:'普通话',model:'qwen3-tts-flash'},
  {voice:'Chelsie',display_name:'千雪',description:'二次元虚拟女友',gender:'female',language_hint:'普通话',model:'qwen3-tts-flash'},
  {voice:'Momo',display_name:'茉兔',description:'撒娇搞怪，逗你开心',gender:'female',language_hint:'普通话',model:'qwen3-tts-flash'},
];

function state():VoiceCatalogState{
  const raw=get<Partial<VoiceCatalogState>>(BUCKET,ID,OWNER)||{};
  return {disabled:Array.isArray(raw.disabled)?raw.disabled.filter(k=>typeof k==='string'):[],edits:raw.edits&&typeof raw.edits==='object'?raw.edits:{}};
}

/** 后台目录合并：基线音色 − 停用 + 编辑。后台未设置时返回基线。 */
export function voiceCatalog():SystemVoice[]{
  const s=state();
  return base.filter(v=>!s.disabled.includes(v.voice)).map(v=>({...v,...(s.edits[v.voice]||{})}));
}
export function findVoice(voiceId:string):SystemVoice|undefined{
  return voiceCatalog().find(v=>v.voice===voiceId);
}
export function setVoiceDisabled(voiceId:string,disabled:boolean){
  const s=state();
  if(!base.some(v=>v.voice===voiceId))throw Error('音色不存在');
  s.disabled=disabled?[...new Set([...s.disabled,voiceId])]:s.disabled.filter(v=>v!==voiceId);
  put(BUCKET,ID,OWNER,s);
  return s;
}
export function editVoice(voiceId:string,edit:{display_name?:string;description?:string}){
  const s=state();
  if(!base.some(v=>v.voice===voiceId))throw Error('音色不存在');
  const patch:any={};
  if(edit.display_name!==undefined){if(!edit.display_name.trim()||edit.display_name.length>30)throw Error('音色名称无效');patch.display_name=edit.display_name.trim();}
  if(edit.description!==undefined){if(!edit.description.trim()||edit.description.length>120)throw Error('音色描述无效');patch.description=edit.description.trim();}
  if(!Object.keys(patch).length)throw Error('没有需要修改的字段');
  s.edits[voiceId]={...(s.edits[voiceId]||{}),...patch};
  put(BUCKET,ID,OWNER,s);
  return voiceCatalog().find(v=>v.voice===voiceId)!;
}
