import type {MaterialSlot} from './catalog';
export type SelectionAsset={id:string;serverId?:string;name:string;type:string;size:number;slot?:string};
export type SelectionLimits={total:number;byKind:Partial<Record<'image'|'video'|'audio',number>>};
const DEFAULT_LIMITS:SelectionLimits={total:15,byKind:{image:9,video:3,audio:3}};
export function selectionError(existing:SelectionAsset[],added:SelectionAsset[],item:SelectionAsset,slot:MaterialSlot,limits:SelectionLimits=DEFAULT_LIMITS){
 const kind=item.type.split('/')[0] as 'image'|'video'|'audio';if(!slot.kinds.includes(kind))return '当前素材位置不支持此文件类型';
 if(item.size>(kind==='image'?20:100)*1024*1024)return `文件过大，${kind==='image'?'图片上限 20 MB':'音视频上限 100 MB'}`;
 if(existing.some(value=>(value.serverId||value.id)===item.id&&value.slot===slot.id)||added.some(value=>value.id===item.id))return '此素材已添加';
 if(existing.filter(value=>value.slot===slot.id).length+added.length>=slot.max)return `${slot.label}最多选择 ${slot.max} 个`;
 const all=[...existing,...added];if(all.length>=limits.total)return `参考素材总数最多 ${limits.total} 个`;const kindLimit=Number(limits.byKind[kind]??0);if(kindLimit>=0&&all.filter(value=>value.type.startsWith(kind+'/')).length>=kindLimit)return `${kind==='image'?'图片':kind==='video'?'视频':'音频'}数量已达上限`;
 return '';
}
