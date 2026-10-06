import observed from '../components/commerce-agent/observed-catalog.json';
import {createHash} from 'node:crypto';
import {get,put} from './store';
import {currentPublishedCommerceConfiguration,publicCommerceCard} from './configuration-platform';
import type {CommerceInputField} from '../shared/configuration-types';
import {sharedConfigurationEnabled} from '../../storage/database/configuration-source';

export type DirectorSlot={key:string;label:string;responsibility?:string;min:number;max:number;kinds:string[];maxFileBytes?:number;minDurationSeconds?:number;maxDurationSeconds?:number;cover:string};
export type DirectorCard={key:string;name:string;description:string;category:string;recommended:boolean;default?:boolean;icon:string;options:string[];inputFields?:CommerceInputField[];slots:DirectorSlot[];catalogVersion?:string;benchmarkConfigVersion?:string;sortOrder?:number;recommendationOrder?:number};
export type DirectorEdit={name?:string;description?:string;recommended?:boolean};
export type DirectorOverlay={disabled:string[];custom:DirectorCard[];edits:Record<string,DirectorEdit>};

const BUCKET='director-catalog',ID='state',OWNER='system';
function normalizeObservedCard(card:DirectorCard):DirectorCard{
 // The captured public catalog contains two rows whose slot label and audio
 // cover say “声音” but whose media kind is `image`. Preserve the raw capture
 // and correct the executable contract at this boundary.
 return {...card,slots:card.slots.map(slot=>slot.label.trim()==='声音'?{...slot,kinds:['audio']}:{...slot,kinds:[...slot.kinds]})};
}
function versioned(card:DirectorCard):DirectorCard{
 const stable={key:card.key,name:card.name,description:card.description,category:card.category,recommended:card.recommended,default:card.default===true,icon:card.icon,options:card.options,inputFields:card.inputFields||[],slots:card.slots.map(slot=>({...slot,kinds:[...slot.kinds]}))};
 return {...card,catalogVersion:createHash('sha256').update(JSON.stringify(stable)).digest('hex')};
}
const base=(observed.directors as DirectorCard[]).map(normalizeObservedCard).map(versioned);
export function baselineDirectorCatalog():DirectorCard[]{return base.map(card=>versioned({...card,slots:card.slots.map(slot=>({...slot}))}));}
const clean=(s:string)=>s.replace(/[\u200b\u200c\u200d\ufeff]/g,'').trim();
const identity=(v:string)=>/^[a-z0-9][a-z0-9-]{2,39}$/i.test(v);

function overlay():DirectorOverlay{
 const raw=get<Partial<DirectorOverlay>>(BUCKET,ID,OWNER)||{};
 return {disabled:Array.isArray(raw.disabled)?raw.disabled.filter(k=>typeof k==='string'):[] ,custom:Array.isArray(raw.custom)?raw.custom:[],edits:raw.edits&&typeof raw.edits==='object'?raw.edits:{}};
}
function saveOverlay(o:DirectorOverlay){put(BUCKET,ID,OWNER,o);}

/** 后台目录合并：基础卡 − 停用 + 编辑 + 自定义追加。后台未设置时返回与静态基线完全一致。 */
export function directorCatalog():DirectorCard[]{
 const published=currentPublishedCommerceConfiguration();
 if(published){
 return published.cards.filter(card=>card.executorType==='director'&&card.status==='published'&&card.display.visibility!=='hidden')
   .map(card=>{const value=publicCommerceCard(card);return versioned({key:value.key,name:value.name,description:value.description,category:value.category,recommended:value.recommended,default:value.key==='default-director',icon:value.icon,options:value.inputFields.filter(field=>field.type==='select').flatMap(field=>field.options||[]),inputFields:value.inputFields,sortOrder:value.sortOrder,slots:value.slots.map(slot=>({key:slot.key,label:slot.label,responsibility:slot.responsibility,min:slot.min,max:slot.max,kinds:slot.kinds,maxFileBytes:slot.maxFileBytes,minDurationSeconds:slot.minDurationSeconds,maxDurationSeconds:slot.maxDurationSeconds,cover:slot.cover}))});});
 }
 // Once the shared configuration authority is enabled, a missing published
 // release means there is no authoritative overlay. Keep drafting available
 // from the immutable baseline without reviving the legacy local catalogue.
 if(sharedConfigurationEnabled())return baselineDirectorCatalog();
 const o=overlay();
 const merged=base.filter(d=>!o.disabled.includes(d.key)).map(d=>versioned({...d,...(o.edits[d.key]||{})}));
 const custom=o.custom.filter(d=>!o.disabled.includes(d.key)).map(d=>versioned({...d,...(o.edits[d.key]||{})}));
 return [...merged,...custom];
}
export function findDirectorCard(keyOrName:string):DirectorCard|undefined{
 const v=clean(keyOrName);
 const cards=directorCatalog();
 return cards.find(d=>d.key===v||d.name===v)||(v==='默认编导'?cards.find(d=>d.default):undefined);
}
export function directorOverlayReadonly():DirectorOverlay{return overlay();}

function uniqueName(o:DirectorOverlay,name:string,ignoreKey?:string){
 const taken=new Set([...base.map(d=>d.name),...o.custom.filter(c=>c.key!==ignoreKey).map(c=>c.name)]);
 if(taken.has(name))throw Error('编导名称已存在');
 return name;
}
const defaultSlots=():DirectorSlot[]=>(base.find(d=>d.key==='ecommerce-spoken-selling')!.slots).map(s=>({...s}));
/** 新增或更新自定义编导卡（后台管理）。 */
export function saveCustomDirectorCard(input:{key?:string;name:string;description:string;categoryLabel?:string;recommended?:boolean;icon?:string}):DirectorCard{
 const name=clean(input.name);
 if(!name||name.length>40)throw Error('编导名称无效');
 const description=clean(input.description||'');
 if(!description||description.length>120)throw Error('编导简介无效');
 const o=overlay();
 let key=clean(input.key||'');
 if(key){
  if(!identity(key))throw Error('编导标识格式无效');
  if(base.some(d=>d.key===key))throw Error('自定义编导不能覆盖内置标识');
 }else{
  key=/^[a-z0-9-]{3,40}$/i.test(name)?name.toLowerCase():'card-'+createHash('sha256').update(name).digest('hex').slice(0,8);
 }
 const existing=o.custom.find(c=>c.key===key);
 uniqueName(o,name,existing?.key);
 const card:DirectorCard={key,name,description,category:clean(input.categoryLabel||'自定义'),recommended:input.recommended===true,default:false,icon:clean(input.icon||'')||'/commerce/reference/director-custom.png',options:[],slots:existing?.slots||defaultSlots()};
 o.custom=[...o.custom.filter(c=>c.key!==key),card];
 saveOverlay(o);
 return versioned(card);
}
/** 停用/恢复任意卡（内置卡只能停用不能删除）。 */
export function toggleDirectorCard(key:string,disabled:boolean){
 const o=overlay();
 if(!disabled)o.disabled=o.disabled.filter(k=>k!==key);
 else{
  if(![...base,...o.custom].some(d=>d.key===key))throw Error('编导卡不存在');
  if(!o.disabled.includes(key))o.disabled.push(key);
 }
 saveOverlay(o);
 return {key,disabled};
}
/** 删除自定义卡；内置卡返回不可删。 */
export function deleteCustomDirectorCard(key:string){
 const o=overlay();
 if(base.some(d=>d.key===key))throw Error('内置编导不能删除，只能停用');
 const before=o.custom.length;
 o.custom=o.custom.filter(c=>c.key!==key);
 if(o.custom.length===before)throw Error('自定义编导不存在');
 delete o.edits[key];
 o.disabled=o.disabled.filter(k=>k!==key);
 saveOverlay(o);
 return {key,deleted:true};
}
/** 编辑卡名称/简介/推荐位（内置与自定义均可）。 */
export function editDirectorCard(key:string,edit:DirectorEdit){
 const o=overlay();
 if(![...base,...o.custom].some(d=>d.key===key))throw Error('编导卡不存在');
 const patch:DirectorEdit={};
 if(edit.name!==undefined){const name=clean(edit.name);if(!name||name.length>40)throw Error('编导名称无效');uniqueName(o,name,key);patch.name=name;}
 if(edit.description!==undefined){const description=clean(edit.description);if(!description||description.length>120)throw Error('编导简介无效');patch.description=description;}
 if(edit.recommended!==undefined)patch.recommended=edit.recommended===true;
 if(!Object.keys(patch).length)throw Error('没有需要修改的字段');
 o.edits[key]={...(o.edits[key]||{}),...patch};
 saveOverlay(o);
 const card=directorCatalog().find(d=>d.key===key);
 if(!card)throw Error('编导卡当前处于停用状态');
 return card;
}
