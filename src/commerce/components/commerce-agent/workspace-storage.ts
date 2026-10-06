import {listMaterials,saveMaterial} from './material-store';
export const LEGACY_WORKSPACE_KEY='commerce-agent:independent-local:v1';
export const workspaceOwnerKey=(id:string)=>'commerce-agent:owner:'+id+':v2';
export async function migrateLegacyWorkspace(ownerKey:string,allowed:boolean){
 if(!allowed||localStorage.getItem(ownerKey+':legacy-migrated'))return;
 const sourceKeys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).filter((key):key is string=>!!key&&key.startsWith(LEGACY_WORKSPACE_KEY+':'));
 // The server identifies the original local operator. Retain the original entries as recovery evidence.
 for(const key of sourceKeys){const target=ownerKey+key.slice(LEGACY_WORKSPACE_KEY.length);if(localStorage.getItem(target)===null){const value=localStorage.getItem(key);if(value!==null)localStorage.setItem(target,value);}}
 const [legacy,current]=await Promise.all([listMaterials(),listMaterials(ownerKey)]),known=new Set(current.map(item=>item.id));
 for(const material of legacy)if(!known.has(material.id))await saveMaterial(material,ownerKey);
 localStorage.setItem(ownerKey+':legacy-migrated',new Date().toISOString());
}
