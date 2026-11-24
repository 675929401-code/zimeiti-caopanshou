'use client';
import {useEffect,useRef,useState} from 'react';
import {ChevronDown,ChevronUp,Plus,Redo2,Scissors,Trash2,Undo2,ZoomIn} from 'lucide-react';
import {type ClipRange} from './clip-sequence';

type Props={segments:ClipRange[];change:(v:ClipRange[])=>void;add:()=>boolean;canAdd:boolean;locked:boolean;seek:(seconds:number)=>void};
export function ClipTimeline({segments,change,add,canAdd,locked,seek}:Props){
 const [height,setHeight]=useState(200),[open,setOpen]=useState(true),[cursor,setCursor]=useState(0),[zoom,setZoom]=useState(1);
 const [past,setPast]=useState<ClipRange[][]>([]),[future,setFuture]=useState<ClipRange[][]>([]);
 const drag=useRef<{y:number;height:number}|null>(null);
 const manualHeight=useRef(false);
 useEffect(()=>{
  const fit=()=>{if(!manualHeight.current)setHeight(Math.max(220,Math.min(360,window.innerHeight*.34)));};
  fit();window.addEventListener('resize',fit);return()=>window.removeEventListener('resize',fit);
 },[]);
 const resize=(v:number)=>{manualHeight.current=true;setHeight(Math.max(140,Math.min(360,v)));};
 const total=segments.reduce((sum,c)=>sum+c.end-c.start,0),time=Math.min(cursor,total);
 let offset=0;const clips=segments.map((clip,i)=>{const start=offset;offset+=clip.end-clip.start;return {clip,i,start,end:offset};});
 const selected=clips.find(c=>time<c.end-0.0001)||clips.at(-1);
 const cut=selected?Math.round((selected.clip.start+time-selected.start)*100)/100:0;
 function remember(){setPast(p=>[...p.slice(-29),segments]);setFuture([]);}
 function commit(values:ClipRange[]){if(locked)return;remember();change(values);}
 function jump(v:number){const t=Math.max(0,Math.min(total,v)),c=clips.find(c=>t<c.end)||clips.at(-1);setCursor(t);if(c)seek(Math.max(c.clip.start,Math.min(c.clip.end,c.clip.start+t-c.start)));}
 function move(index:number,delta:number){const to=index+delta;if(to<0||to>=segments.length)return;const next=[...segments];[next[to],next[index]]=[next[index],next[to]];commit(next);}
 function undo(){const last=past.at(-1);if(!last||locked)return;setPast(p=>p.slice(0,-1));setFuture(f=>[...f,segments]);change(last);}
 function redo(){const next=future.at(-1);if(!next||locked)return;setFuture(f=>f.slice(0,-1));setPast(p=>[...p,segments]);change(next);}
 const ticks=10,span=Math.max(5,Math.ceil(total)),clock=(n:number)=>Math.floor(n/60).toString().padStart(2,'0')+':'+(n%60).toFixed(2).padStart(5,'0');
 return <section className="cs-clip-timeline" aria-label="剪辑时间线" style={{height:open?height:42}}>
 {open&&<div className="cs-clip-separator" role="separator" aria-label="调整时间线高度" aria-orientation="horizontal" aria-valuemin={140} aria-valuemax={360} aria-valuenow={height} tabIndex={0}
 onPointerDown={e=>{drag.current={y:e.clientY,height};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(drag.current)resize(drag.current.height+drag.current.y-e.clientY);}}
 onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onKeyDown={e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();resize(height+(e.key==='ArrowUp'?10:-10));}}}/>}
 <header className="cs-clip-tools"><button aria-label="撤销剪辑" title="撤销" disabled={locked||!past.length} onClick={undo}><Undo2/></button><button aria-label="重做剪辑" title="重做" disabled={locked||!future.length} onClick={redo}><Redo2/></button>
 <button aria-label="在播放头处分割片段" title="分割" disabled={locked||!selected||segments.length>=16||cut<=selected.clip.start||cut>=selected.clip.end} onClick={()=>{if(selected){const next=[...segments];next.splice(selected.i,1,{start:selected.clip.start,end:cut},{start:cut,end:selected.clip.end});commit(next);}}}><Scissors/></button>
 <button aria-label="删除当前片段" title="删除" disabled={locked||!selected} onClick={()=>commit(segments.filter((_,i)=>i!==selected?.i))}><Trash2/></button>
 <button aria-label="将所选时间加入剪辑列表" title="将所选时间加入剪辑列表" disabled={locked||!canAdd||segments.length>=16} onClick={()=>{if(add())remember();}}><Plus/></button>
 <output aria-label="播放头和总时长">{clock(time)} / {clock(total)}</output><label><ZoomIn/><input aria-label="时间线缩放" type="range" min={1} max={5} step={0.25} value={zoom} onChange={e=>setZoom(Number(e.target.value))}/></label><button aria-expanded={open} aria-label={open?'收起时间线':'展开时间线'} onClick={()=>setOpen(!open)}>{open?<ChevronDown/>:<ChevronUp/>}</button></header>
 {open&&<div className="cs-clip-scroll"><div className="cs-clip-track" style={{width:zoom*100+'%'}}><div className="cs-clip-ruler">{Array.from({length:ticks+1},(_,i)=><small key={i}>{Math.round(span*i/ticks*10)/10}s</small>)}</div>
 <input className="cs-clip-scrub" type="range" aria-label="时间线播放头" min={0} max={span} step={0.01} value={time} disabled={!segments.length} onChange={e=>jump(Number(e.target.value))}/>
 <i className="cs-clip-playhead" style={{left:time/span*100+'%'}}/><ol>{clips.map(({clip,i,start,end})=><li key={i} data-selected={i===selected?.i} style={{width:(end-start)/span*100+'%'}}><button className="cs-clip-range" aria-label={'选择第 '+(i+1)+' 段'} onClick={()=>jump(start)}>第 {i+1} 段 · {clip.start}–{clip.end} 秒</button><div><button aria-label={'上移第 '+(i+1)+' 段'} disabled={locked||i===0} onClick={()=>move(i,-1)}>上移</button><button aria-label={'下移第 '+(i+1)+' 段'} disabled={locked||i===segments.length-1} onClick={()=>move(i,1)}>下移</button><button aria-label={'移除第 '+(i+1)+' 段'} disabled={locked} onClick={()=>commit(segments.filter((_,j)=>j!==i))}>移除</button></div></li>)}</ol>
 {!segments.length&&<p>选择视频和播放范围，将片段加入时间线。</p>}</div></div>}</section>;
}
