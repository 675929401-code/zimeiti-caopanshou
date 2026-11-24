import {randomUUID} from 'node:crypto';
import {get,put,transaction} from './store';
import {readAssist} from './prompt-assist';
import {saveCanvasWithinTransaction} from './canvas-storage';
import {validateEditedScript} from './reference-video-schema';
import type {CanvasDocument,CanvasNode,CanvasEdge} from '../shared/canvas-schema';

export function canvasFromAssist(owner:string,id:string,revision:number) {
  return transaction(()=>{
    const session=readAssist(owner,id);
    if(session.revision!==revision || session.activeJobId) throw Error('项目已更新，请读取最新脚本');
    const version=session.versions?.find(v=>v.id===session.currentVersionId);
    if(!version || version.script!==session.script || version.sourceAnalysisJobId!==session.analysisJobId) throw Error('请先保存当前商品脚本');
    validateEditedScript(version.script,version.references,version.videoSettings);
    const previous=get<{id:string}>('assist-version-canvases',version.id,owner);
    if(previous && get<CanvasDocument>('canvases',previous.id,owner)) return previous;

    const nodes:CanvasNode[]=[];
    const edges:CanvasEdge[]=[];
    function add(data:CanvasNode['data'],x:number,y:number) {
      const node={id:randomUUID(),data,position:{x,y}};
      nodes.push(node);
      return node.id;
    }
    function connect(source:string,target:string,edgeType:'instruction'|'reference'|'derived',label:string) {
      edges.push({id:randomUUID(),source,target,label,data:{edgeType,...(edgeType==='reference'?{role:'reference'}:{})}});
    }
    const script=add({kind:'text',label:'已确认脚本',mode:'input',prompt:version.script},440,40);
    const video=add({kind:'video',label:'按脚本制作视频',mode:'generate',prompt:'',...version.videoSettings},850,40);
    connect(script,video,'instruction','脚本');
    if(session.referenceVideo && version.sourceBreakdownJobId && session.breakdown) {
      const source=add({kind:'video',label:'参考原片',mode:'input',assetIds:[session.referenceVideo.assetId],prompt:''},20,40);
      const breakdown=add({kind:'text',label:'参考镜头与节奏',mode:'input',prompt:[session.breakdown.script,...session.breakdown.shots.map(shot=>shot.start+'–'+shot.end+' 秒 · '+shot.action)].join('\n')},20,320);
      connect(source,breakdown,'derived','拆解来源');
      connect(breakdown,script,'derived','节奏来源');
    }
    const product=version.analysis?.product||'商品';
    const productFacts=add({kind:'text',label:'已核对的商品资料',mode:'input',prompt:[product,...(version.analysis?.productFeatures||[]),...(version.analysis?.sellingPoints||[])].join('\n')},440,320);
    connect(productFacts,script,'derived','商品事实');
    version.references.forEach((ref,i)=>{
      const image=add({kind:'image',label:'商品图 '+(i+1),mode:'input',prompt:'',assetIds:[ref.id]},440+(i%3)*350,600+Math.floor(i/3)*280);
      connect(image,productFacts,'derived','素材来源');
      connect(image,video,'reference','商品参考');
    });
    const canvas=saveCanvasWithinTransaction(owner,{id:randomUUID(),ownerId:owner,expectedRevision:0,
      title:product+' · 分镜画布',nodes,edges,groups:[],viewport:{x:20,y:30,zoom:0.72}});
    canvas.scriptSource={sessionId:id,versionId:version.id,analysisJobId:version.sourceAnalysisJobId,
      breakdownJobId:version.sourceBreakdownJobId,scriptJobId:version.scriptJobId};
    put('canvases',canvas.id,owner,canvas);
    const result={id:canvas.id};
    put('assist-version-canvases',version.id,owner,result);
    return result;
  });
}
