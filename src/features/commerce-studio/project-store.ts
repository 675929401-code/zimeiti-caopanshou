import { createHash, randomUUID } from 'node:crypto';
import { get, list, put, transaction } from '@/commerce/server/store';
import { readAsset } from '@/commerce/server/assets';
import { saveCanvasWithinTransaction } from '@/commerce/server/canvas-storage';
import type { CanvasNode, CanvasEdge } from '@/commerce/shared/canvas-schema';
import { groupBuyScene, blankFacts, factKeys, factLabels, planOffer, type StoreProject, type StudioVersion } from './group-buy';

const projects='studio-group-projects', versions='studio-group-versions', writes='studio-group-requests';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function projectList(owner:string) { return list<StoreProject>(projects,owner).map(p=>({id:p.id,title:p.facts.store||'未命名团购',revision:p.revision})); }
export function loadProject(owner:string,id:string) {
  const project=get<StoreProject>(projects,id,owner);
  if (!project) throw Error('项目不存在或无权访问');
  const history=get<string[]>('studio-group-history',id,owner)||[];
  return {project,versions:history.map(key=>get<StudioVersion>(versions,key,owner)!).filter(Boolean)};
}
export function changeProject(owner:string,input:Record<string,unknown>) {
  const {action,projectId,requestId,revision}=input;
  if (!['save','plan','revise','canvas'].includes(String(action)) || typeof projectId!=='string'||!uuid.test(projectId)||typeof requestId!=='string'||!uuid.test(requestId)) throw Error('项目操作标识无效');
  const key=createHash('sha256').update(owner+'|'+requestId).digest('hex');
  const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return transaction(()=>{
    const prior=get<{projectId:string;fingerprint:string;canvasId?:string}>(writes,key,owner);
    if(prior) { if(prior.fingerprint!==fingerprint) throw Error('请求内容已变化，请重新保存'); return {...loadProject(owner,prior.projectId),canvasId:prior.canvasId}; }
    const previous=get<StoreProject>(projects,projectId,owner);
    if((previous?.revision||0)!==revision) throw Error('项目已在其他窗口更新，请重新打开核对');
    const project:StoreProject=previous||{id:projectId,scene:groupBuyScene,revision:0,facts:{...blankFacts},imageIds:[],updatedAt:0};
    // A UUID can be supplied by any caller; reserve its owner before putting a new record.
    if (!previous) {
      const reservation=get<string>('studio-group-owners',projectId,'system');
      if(reservation&&reservation!==owner) throw Error('项目不存在或无权访问');
      if(!reservation) put('studio-group-owners',projectId,'system',owner);
    }
    let canvasId:string|undefined;
    if(action==='canvas') {
      const history=get<string[]>('studio-group-history',project.id,owner)||[];
      if(typeof input.versionId!=='string'||!history.includes(input.versionId)) throw Error('请选择本项目已保存的脚本版本');
      const version=get<StudioVersion>(versions,input.versionId,owner)!;
      canvasId=version.canvasId;
      if (!canvasId || !get('canvases',canvasId,owner)) {
        const nodes:CanvasNode[]=[],edges:CanvasEdge[]=[];
        version.shots.forEach((shot,i)=>{
          const id=randomUUID();
          nodes.push({id,position:{x:380,y:i*235},data:{kind:'text',mode:'input',label:shot.title,prompt:[shot.visual,shot.speech,shot.subtitle].join('\n')}});
          shot.imageIds.forEach((assetId,j)=>{
            const imageId=randomUUID();
            nodes.push({id:imageId,position:{x:10-j*310,y:i*235},data:{kind:'image',mode:'input',label:'菜品参考 '+(j+1),prompt:'',assetIds:[assetId]}});
            edges.push({id:randomUUID(),source:imageId,target:id,data:{edgeType:'derived'},label:'菜品依据'});
          });
        });
        canvasId=saveCanvasWithinTransaction(owner,{id:randomUUID(),ownerId:owner,expectedRevision:0,title:version.facts.store+' · 团购 v'+version.revision,nodes,edges,groups:[],viewport:{x:40,y:40,zoom:0.8}}).id;
        version.canvasId=canvasId; put(versions,version.id,owner,version);
      }
    } else if(action==='revise') {
      const history=get<string[]>('studio-group-history',project.id,owner)||[];
      if(typeof input.versionId!=='string'||!history.includes(input.versionId))throw Error('原版本不存在');
      const original=get<StudioVersion>(versions,input.versionId,owner)!;
      const edit=input.edit as Record<string,unknown>|undefined;
      if(!edit||!Number.isInteger(edit.index)||!original.shots[Number(edit.index)]||!['visual','speech','subtitle'].includes(String(edit.field))||typeof edit.text!=='string'||!edit.text.trim()||edit.text.length>2000)throw Error('请选择镜头并填写 1–2000 字的改稿');
      if((original.brief||'')!==(project.brief||'')||JSON.stringify(original.facts)!==JSON.stringify(project.facts)||JSON.stringify(original.imageIds)!==JSON.stringify(project.imageIds))throw Error('项目资料已变化，请先按新资料编排再改稿');
      const id=randomUUID(),shots=original.shots.map((shot,i)=>i===edit.index?{...shot,[String(edit.field)]:String(edit.text).trim()}:shot);
      const version:StudioVersion={id,revision:project.revision+1,createdAt:Date.now(),parentId:original.id,origin:'member-edit',brief:original.brief,facts:original.facts,imageIds:original.imageIds,shots};
      put(versions,id,owner,version);put('studio-group-history',project.id,owner,[id,...history]);project.versionId=id;
    } else {
      if(input.brief!==undefined){if(typeof input.brief!=='string'||input.brief.length>10000)throw Error('创作要求最多 10000 字');project.brief=input.brief;}
      const values=input.facts as Record<string,unknown>|null;
      for(const field of factKeys) {
        const value=values?.[field];
        if(typeof value!=='string'||value.length>240) throw Error(factLabels[field]+'最多 240 字');
        project.facts[field]=value.trim();
      }
      if(!Array.isArray(input.imageIds)||input.imageIds.length>9||new Set(input.imageIds).size!==input.imageIds.length) throw Error('请选择最多九张不同的菜品图');
      project.imageIds=input.imageIds.map(id=>{if(typeof id!=='string'||!readAsset(id,owner)?.type.startsWith('image/')) throw Error('菜品图片无效或无权读取');return id;});
      if(action==='plan'){
        const shots=planOffer(project.facts,project.imageIds),id=randomUUID();
        const version:StudioVersion={id,origin:'local-plan',revision:project.revision+1,createdAt:Date.now(),brief:project.brief,facts:project.facts,imageIds:project.imageIds,shots};
        put(versions,id,owner,version);
        put('studio-group-history',project.id,owner,[id,...(get<string[]>('studio-group-history',project.id,owner)||[])]);
        project.versionId=id;
      }
    }
    project.updatedAt=Date.now(); project.revision++;
    put(projects,project.id,owner,project); put(writes,key,owner,{projectId:project.id,fingerprint,canvasId});
    return {...loadProject(owner,project.id),canvasId};
  });
}
