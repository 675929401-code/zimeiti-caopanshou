import {db,get,put,remove,transaction} from './store';
import {mutateAssets,publicAsset,type Asset} from './assets';

export type AssetFolder={id:string;name:string;createdAt:number};
export type LibraryAsset=Asset&{folderId?:string;collection?:'assets'|'roles'};
const nameValue=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw Error('名称须为 1–80 个字符');return value.trim();};
export function assetFolders(owner:string){return db().prepare("SELECT value FROM records WHERE bucket='asset-folders' AND owner=? ORDER BY updated DESC,id DESC").all(owner).map(row=>JSON.parse(String(row.value)) as AssetFolder);}
export function saveAssetFolder(owner:string,input:{id?:string;name:unknown}){return transaction(()=>{const name=nameValue(input.name);if(input.id&&!get('asset-folders',input.id,owner))throw Error('文件夹不存在');if(assetFolders(owner).some(f=>f.id!==input.id&&f.name.toLocaleLowerCase()===name.toLocaleLowerCase()))throw Error('已有同名文件夹');const folder={id:input.id||crypto.randomUUID(),name,createdAt:input.id?get<AssetFolder>('asset-folders',input.id,owner)!.createdAt:Date.now()};put('asset-folders',folder.id,owner,folder);return folder;});}
export function deleteAssetFolder(owner:string,id:string){return transaction(()=>{if(!get('asset-folders',id,owner))throw Error('文件夹不存在');const occupied=db().prepare("SELECT id FROM records WHERE bucket='assets' AND owner=? AND json_extract(value,'$.folderId')=? LIMIT 1").get(owner,id);if(occupied)throw Error('请先移出文件夹中的素材，再删除空文件夹');remove('asset-folders',id,owner);});}
export const publicLibraryAsset=(asset:LibraryAsset)=>publicAsset(asset);
export function queryAssetLibrary(owner:string,params:URLSearchParams){
 const clauses=["bucket='assets'",'owner=?'];const args:unknown[]=[owner];
 if(params.has('ids')){const ids=[...new Set((params.get('ids')||'').split(','))];if(!ids.length||ids.length>100||ids.some(id=>!id||id.length>100))throw Error('素材 ID 列表无效');clauses.push('id IN ('+ids.map(()=>'?').join(',')+')');args.push(...ids);}
 const collection=params.get('collection');if(collection==='roles'){clauses.push("json_extract(value,'$.collection')='roles'");}else if(collection&&collection!=='assets')throw Error('素材库类型无效');
 const folder=params.get('folder');if(folder==='ungrouped'){clauses.push("COALESCE(json_extract(value,'$.folderId'),'')=''");}else if(folder){if(!get('asset-folders',folder,owner))throw Error('文件夹不存在');clauses.push("json_extract(value,'$.folderId')=?");args.push(folder);}
 const kinds=params.get('kinds')?.split(',').filter(Boolean)||[];if(kinds.some(kind=>!['image','video','audio'].includes(kind)))throw Error('素材类型无效');if(kinds.length){clauses.push('('+kinds.map(()=>"json_extract(value,'$.type') LIKE ?").join(' OR ')+')');args.push(...kinds.map(kind=>kind+'/%'));}
 const query=(params.get('q')||'').trim();if(query.length>160)throw Error('搜索词过长');if(query){clauses.push("instr(lower(json_extract(value,'$.name')),lower(?))>0");args.push(query);}
 const source=params.get('source');if(source&&source!=='all'){if(!['upload','generated'].includes(source))throw Error('素材来源无效');clauses.push("json_extract(value,'$.source')=?");args.push(source);}
 const limit=Number(params.get('limit')||30),offset=Number(params.get('offset')||0);if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw Error('分页参数无效');
 const where=clauses.join(' AND ');const total=Number(db().prepare(`SELECT count(*) AS total FROM records WHERE ${where}`).get(...args)?.total||0);
 const rows=db().prepare(`SELECT value FROM records WHERE ${where} ORDER BY json_extract(value,'$.createdAt') DESC,id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
 return {assets:rows.map(row=>publicLibraryAsset(JSON.parse(String(row.value)) as LibraryAsset)),folders:assetFolders(owner),total,nextOffset:offset+rows.length<total?offset+rows.length:null};
}
export async function updateLibraryAssets(owner:string,input:{ids:unknown;folderId?:unknown;collection?:unknown;name?:unknown}){
 if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>100||input.ids.some(id=>typeof id!=='string'))throw Error('请选择 1–100 个素材');
 const ids=[...new Set(input.ids)] as string[];const hasFolder=Object.hasOwn(input,'folderId');if(hasFolder&&input.folderId!==null&&(typeof input.folderId!=='string'||!get('asset-folders',input.folderId,owner)))throw Error('文件夹不存在');
 if(input.collection!==undefined&&!['assets','roles'].includes(String(input.collection)))throw Error('素材库类型无效');if(input.name!==undefined&&ids.length!==1)throw Error('请逐个重命名素材');const name=input.name===undefined?undefined:nameValue(input.name);
 const assertTarget=()=>{if(hasFolder&&input.folderId!==null&&(typeof input.folderId!=='string'||!get('asset-folders',input.folderId,owner)))throw Error('文件夹不存在');};
 const items=await mutateAssets(owner,ids,current=>current.map(value=>{const item=value as LibraryAsset;if(input.collection==='roles'&&!item.type.startsWith('image/'))throw Error('角色库只接受人物参考图片');const next:LibraryAsset={...item,...(name?{name}:{}),...(input.collection?{collection:input.collection as LibraryAsset['collection']}:{})};if(hasFolder){if(input.folderId)next.folderId=String(input.folderId);else delete next.folderId;}return next;}),undefined,assertTarget);
 return items.map(item=>publicLibraryAsset(item as LibraryAsset));
}
