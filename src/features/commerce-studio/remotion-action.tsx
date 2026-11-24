'use client';
import {useState,useRef} from 'react';
import {api,type Runtime} from '@/commerce/components/commerce-agent/runtime-ui';
type Scene={id:string;title:string;caption:string;duration:number;imageId:string};
const blank=():Scene=>({id:crypto.randomUUID(),title:'',caption:'',duration:3,imageId:''});
export function RemotionAction({runtime}:{runtime:Runtime}){
 const [scenes,setScenes]=useState<Scene[]>(()=>[blank()]),[portrait,setPortrait]=useState(true),[color,setColor]=useState('#0471fe');
 const [asset,setAsset]=useState<{url:string;name:string}>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const lock=useRef(false);
 const update=(id:string,patch:Partial<Scene>)=>{setAsset(undefined);setScenes(all=>all.map(s=>s.id===id?{...s,...patch}:s));};
 async function run(){if(lock.current)return;lock.current=true;setBusy(true);setError('');setAsset(undefined);
  try{const result=await api<{asset:{url:string;name:string}}>('/api/commerce/studio/remotion',{portrait,color,scenes:scenes.map(s=>({title:s.title,caption:s.caption,duration:s.duration,imageId:s.imageId||undefined}))});setAsset(result.asset);}
  catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}}
 return <section className="cs-document-action" aria-label="Remotion 动画工作区"><fieldset disabled={busy} onChange={()=>setAsset(undefined)}>
 {scenes.map((s,i)=><div key={s.id}><label>第 {i+1} 幕标题<input value={s.title} maxLength={80} onChange={e=>update(s.id,{title:e.target.value})}/></label>
 <label>字幕<input value={s.caption} maxLength={180} onChange={e=>update(s.id,{caption:e.target.value})}/></label>
 <label>时长（秒）<input type="number" min="1" max="10" value={s.duration} onChange={e=>update(s.id,{duration:Number(e.target.value)})}/></label>
 <label>背景图<select value={s.imageId} onChange={e=>update(s.id,{imageId:e.target.value})}><option value="">纯色背景</option>{runtime.assets.filter(a=>a.type.startsWith('image/')).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
 {scenes.length>1&&<button type="button" onClick={()=>{setScenes(all=>all.filter(x=>x.id!==s.id));setAsset(undefined);}}>移除此幕</button>}</div>)}
 <button type="button" disabled={scenes.length>=8} onClick={()=>{setScenes(all=>[...all,blank()]);setAsset(undefined);}}>添加一幕</button>
 <label>画幅<select value={String(portrait)} onChange={e=>setPortrait(e.target.value==='true')}><option value="true">竖屏 9:16</option><option value="false">横屏 16:9</option></select></label>
 <label>主题色<input type="color" value={color} onChange={e=>setColor(e.target.value)}/></label>
 <button type="button" disabled={scenes.some(s=>!s.title.trim())} onClick={()=>void run()}>{busy?'正在渲染…':'渲染 MP4'}</button></fieldset>
 {asset&&<><video controls src={asset.url} style={{maxWidth:'100%',maxHeight:200}}/><a download={asset.name} href={asset.url+'?download=1'}>下载动画 MP4</a></>}
 {error&&<p role="alert">{error}</p>}</section>;
}
