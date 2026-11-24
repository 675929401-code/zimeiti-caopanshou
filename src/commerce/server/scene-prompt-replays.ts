import {createHash} from 'node:crypto';
import {get,list,put,transaction} from './store';
import {primePublishedCommerceConfiguration} from './configuration-platform';
import {scenePromptWorkbench} from './scene-prompt-workbench';

export type SceneReplay={id:string;recordedBy:string;kind:'对标会员实测'|'本站实测';input:string;output:string;finding:string;createdAt:string};
const bucket='scene-prompt-replays';
function scope(id:unknown){
 if(typeof id!=='string'||id.length>130||!scenePromptWorkbench().some(e=>e.id===id))throw Error('场景不存在，请重新选择。');
 return 'commerce-scene:'+id;
}
export async function sceneReplays(id:unknown){await primePublishedCommerceConfiguration({required:false});return list<SceneReplay>(bucket,scope(id)).slice(0,12);}
export async function saveSceneReplay(actor:string,raw:Record<string,unknown>){
 await primePublishedCommerceConfiguration({required:false});
 const owner=scope(raw.sceneId);
 function field(key:string,limit:number){const value=raw[key];if(typeof value!=='string'||!value.trim()||value.length>limit)throw Error('请输入完整的实测资料并核对字数。');return value.trim();}
 const kind=raw.source;if(kind!=='对标会员实测'&&kind!=='本站实测')throw Error('请选择实测来源。');
 const input=field('input',2400),output=field('output',20000),finding=field('finding',2000);
 const id=createHash('sha256').update(JSON.stringify([owner,kind,input,output,finding])).digest('hex');
 return transaction(()=>{const existing=get<SceneReplay>(bucket,id,owner);if(existing)return existing;
  const row:SceneReplay={id,recordedBy:actor,kind,input,output,finding,createdAt:new Date().toISOString()};
  put(bucket,id,owner,row);return row;});
}
