'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Plus, X } from 'lucide-react';
import { blankFacts, factKeys, factLabels, groupBuyScene, type Facts, type StoreProject, type StudioVersion } from './group-buy';
type Recent = {id:string;title:string;revision:number};
type Saved = {project:StoreProject;versions:StudioVersion[];canvasId?:string};
const api='/api/commerce/studio/projects';
async function read<T>(url:string,init?:RequestInit):Promise<T>{
  const res=await fetch(url,{cache:'no-store',...init}),data=await res.json();
  if(!res.ok)throw Error(data.error||'读取失败');return data;
}
function studioUrl(id?:string){return '/commerce/toolbox/video-generation?scene='+groupBuyScene+(id?'&projectId='+encodeURIComponent(id):'');}

export function GroupBuyEditor({initialId,initialImages=[],initialBrief='',onNavigate,leaveGuard}:{leaveGuard:RefObject<null|(()=>boolean)>;initialId:string;initialImages?:string[];initialBrief?:string;onNavigate:(path:string)=>void}){
  const [id]=useState(()=>initialId||crypto.randomUUID());
  const [brief,setBrief]=useState(initialBrief);
  const [facts,setFacts]=useState<Facts>({...blankFacts}),[images,setImages]=useState<string[]>(initialImages);
  const [revision,setRevision]=useState(0),[history,setHistory]=useState<StudioVersion[]>([]),[selected,setSelected]=useState('');
  const [recent,setRecent]=useState<Recent[]>([]),[busy,setBusy]=useState(false),[ready,setReady]=useState(!initialId);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[dirty,setDirty]=useState(false);
  const locked=useRef(false),retry=useRef({body:'',key:''}),upload=useRef<HTMLInputElement>(null);
  const [edit,setEdit]=useState<{index:number;field:'visual'|'speech'|'subtitle';text:string}|null>(null);
  const stage=history.find(v=>v.id===selected);
  function restore(s:Saved){
    setBrief(s.project.brief||'');setFacts(s.project.facts);setImages(s.project.imageIds);setRevision(s.project.revision);
    const version=s.versions.find(v=>v.id===s.project.versionId);
    const matchesCurrent=version&&factKeys.every(k=>version.facts[k]===s.project.facts[k])&&
      (version.brief||'')===(s.project.brief||'')&&JSON.stringify(version.imageIds)===JSON.stringify(s.project.imageIds);
    setEdit(null);setHistory(s.versions);setSelected(version&&(matchesCurrent||version.revision===s.project.revision)?version.id:'');setDirty(false);
  }
  useEffect(()=>{
    const controller=new AbortController(),opts={signal:controller.signal};
    void read<{projects:Recent[]}>(api,opts).then(data=>setRecent(data.projects)).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    if(initialId)void read<Saved>(api+'?projectId='+encodeURIComponent(initialId),opts).then(s=>{restore(s);setReady(true);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[initialId]);
  useEffect(()=>{function guard(e:BeforeUnloadEvent){if(dirty||busy)e.preventDefault();}window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty,busy]);
  useEffect(()=>{leaveGuard.current=()=>!busy&&(!dirty||window.confirm('团购资料尚未保存，确定离开？'));return ()=>{leaveGuard.current=null;};},[dirty,busy,leaveGuard]);
  function update(){setDirty(true);setNotice('');setError('');}
  async function save(action:'save'|'plan'|'revise'|'canvas'){
    if(locked.current||!ready)return;
    const missing=factKeys.filter(key=>!facts[key].trim());
    if(action==='plan'&&missing.length){setError('请补充'+missing.map(key=>factLabels[key]).join('、'));return;}
    locked.current=true;setBusy(true);setError('');
    const input={action,projectId:id,revision,facts,brief,imageIds:images,versionId:selected,...(action==='revise'?{edit}:{})};
    const body=JSON.stringify(input);
    if(retry.current.body!==body)retry.current={body,key:crypto.randomUUID()};
    try{
      const s=await read<Saved>(api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,requestId:retry.current.key})});
      restore(s);retry.current={body:'',key:''};
      window.history.replaceState(window.history.state,'',studioUrl(id));
      setRecent(prev=>[{id,title:s.project.facts.store||'未命名团购',revision:s.project.revision},...prev.filter(p=>p.id!==id)]);
      setNotice(action==='plan'?'分镜草案已按当前资料保存':action==='canvas'?'分镜已存到画布':'团购资料已保存');
      if(action==='canvas'&&s.canvasId){leaveGuard.current=null;onNavigate('/commerce/canvas?open='+encodeURIComponent(s.canvasId));}
    } catch(e){setError((e as Error).message);}finally{locked.current=false;setBusy(false);}
  }
  async function attach(files:File[]){
    if(!files.length||locked.current)return;
    if(files.some(f=>!f.type.startsWith('image/'))||files.length+images.length>9){setError('请选择图片，合计最多九张');return;}
    locked.current=true;setBusy(true);setError('');
    try{for(const file of files){const form=new FormData();form.append('file',file);const {asset}=await read<{asset:{id:string}}>('/api/commerce/assets',{method:'POST',body:form});setImages(prev=>prev.includes(asset.id)?prev:[...prev,asset.id]);update();}}
    catch(e){setError((e as Error).message);}finally{locked.current=false;setBusy(false);}
  }
  const go=(path:string)=>{if(!busy&&(!dirty||window.confirm('当前团购资料尚未保存，确定离开？')))window.location.assign(path);};
  return <div className="cs-group-grid">
    <section className="cs-group-editor"><header><h2>同城团购</h2><button disabled={busy} onClick={()=>go(studioUrl())}>＋ 新建</button></header>
      <div className="cs-group-scroll"><h3>菜品参考</h3><div className="cs-group-images">{images.map((asset,i)=><span key={asset}><img src={'/api/commerce/assets/'+asset} alt={'菜品图 '+(i+1)}/><button aria-label={'移除菜品图 '+(i+1)} disabled={busy||!ready} onClick={()=>{setImages(images.filter(a=>a!==asset));update();}}><X size={12}/></button></span>)}<button aria-label="上传菜品图" disabled={busy||!ready||images.length>=9} onClick={()=>upload.current?.click()}><Plus size={19}/></button></div>
      <input hidden ref={upload} type="file" accept="image/*" multiple onChange={e=>{void attach(Array.from(e.target.files||[]));e.target.value='';}}/>
      <label>创作要求<textarea maxLength={10000} value={brief} disabled={busy||!ready} onChange={e=>{setBrief(e.target.value);update();}}/></label>
      {factKeys.map(key=><label key={key}>{factLabels[key]}<input maxLength={240} disabled={busy||!ready} value={facts[key]} onChange={e=>{setFacts({...facts,[key]:e.target.value});update();}}/></label>)}
      </div><footer>{error&&<p role="alert">{error}</p>}{notice&&<span role="status">{notice}</span>}
        <button disabled={busy||!ready} onClick={()=>save('save')}>保存团购资料</button><button className="cs-primary" disabled={busy||!ready} onClick={()=>save('plan')}>生成分镜草案</button>{revision>0&&!dirty&&<button disabled={busy} onClick={()=>onNavigate(studioUrl(id)+'&mode=director'+(stage?'&versionId='+encodeURIComponent(stage.id):''))}>带入平台编导{stage?' · v'+stage.revision:''}</button>}</footer>
    </section><section className="cs-group-preview"><header><h2>分镜预览</h2>{history.length>0&&<select aria-label="脚本版本" value={selected} onChange={e=>{setEdit(null);setSelected(e.target.value);}}><option value="">仅用当前团购资料</option>{history.map(v=><option key={v.id} value={v.id}>v{v.revision} · {v.facts.store}</option>)}</select>}</header>
    {stage?<><p>{stage.origin==='member-edit'?'会员改稿':'本地资料编排'} · v{stage.revision}</p>{stage.shots.map((shot,i)=><article key={i}><h3>{i+1} · {shot.title}</h3><p>{shot.visual}</p><p>口播　{shot.speech}</p><p>字幕　{shot.subtitle}</p><small>事实依据　{shot.sources.map(k=>factLabels[k]).join('、')}</small> <button disabled={busy||dirty} onClick={()=>setEdit({index:i,field:'speech',text:shot.speech})}>修改本镜</button>{edit?.index===i&&<div className="cs-shot-edit"><select aria-label="改稿字段" value={edit.field} onChange={e=>{const field=e.target.value as typeof edit.field;setEdit({...edit,field,text:shot[field]});}}><option value="speech">口播</option><option value="subtitle">字幕</option><option value="visual">画面提示词</option></select><textarea aria-label="本镜改稿" maxLength={2000} value={edit.text} onChange={e=>setEdit({...edit,text:e.target.value})}/><button disabled={busy||!edit.text.trim()} onClick={()=>save('revise')}>保存独立版本</button><button onClick={()=>setEdit(null)}>取消</button></div>}</article>)}<button disabled={busy||dirty} onClick={()=>save('canvas')}>{stage.canvasId?'打开已保存画布':'存到可编辑画布'}</button></>:<p>填写套餐和核销条件后，可在这里核对逐镜画面、口播与字幕。</p>}
    </section><aside className="cs-group-recent"><h2>最近项目</h2>{recent.length?recent.map(p=><button key={p.id} disabled={busy} onClick={()=>go(studioUrl(p.id))}>{p.title}<small>v{p.revision}</small></button>):<p>暂无团购项目</p>}</aside>
  </div>;
}
