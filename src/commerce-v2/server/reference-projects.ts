import {createHash} from 'node:crypto';
import {get,put,list,transaction} from '../../commerce/server/store';
import {readAssist,type AssistSession} from '../../commerce/server/prompt-assist';
import {defaultAssistConfig} from '../../commerce/server/prompt-assist-schema';

export function openReferenceProject(owner:string, projectId?:string, newRequestId?:string, approach:'shots'|'original'='shots') {
 if(!['shots','original'].includes(approach))throw Error('复刻方式无效');
 if(projectId!==undefined&&(typeof projectId!=='string'||!/^[a-f0-9]{64}$/.test(projectId)))throw Error('项目编号无效');
 if(newRequestId!==undefined&&(typeof newRequestId!=='string'||!/^[a-f0-9-]{36}$/.test(newRequestId)))throw Error('新建请求编号无效');
 if(projectId&&newRequestId)throw Error('请选择一个项目操作');
 return transaction(()=>{
  const initial=createHash('sha256').update('reference-project/v1/'+owner+(approach==='original'?'/original':'')).digest('hex');
  const id=newRequestId?createHash('sha256').update(owner+'/'+newRequestId).digest('hex'):projectId||get<{id:string}>('reference-project-current',initial,owner)?.id||initial;
  const existing=get<AssistSession>('prompt-assists',id,owner);
  if(projectId&&!existing?.referenceFirst)throw Error('当前账号不可读取该项目');
  if(!existing||!!existing.originalApproach===(approach==='original'))put('reference-project-current',initial,owner,{id});
  if(existing)return readAssist(owner,id);
  const now=Date.now();
  put('reference-project-index',id,owner,{id,createdAt:now});
  const project:AssistSession={id,owner,contextId:id,fingerprint:id,revision:1,createdAt:now,updatedAt:now,references:[],videoSettings:{duration:15,resolution:'720p',aspectRatio:'9:16',generateAudio:true},analysisEdited:false,config:{...defaultAssistConfig},history:[],referenceFirst:true,...(approach==='original'?{originalApproach:true}:{}),generationMode:'reference'};
  put('prompt-assists',id,owner,project);
  return project;
 });
}
export function referenceProjects(owner:string) {
 return list<{id:string;createdAt:number}>('reference-project-index',owner).map(row=>{
  const s=get<AssistSession>('prompt-assists',row.id,owner);
  return {id:row.id,title:s?.referenceVideo?.fileName||'未选原片',createdAt:row.createdAt};
 });
}
