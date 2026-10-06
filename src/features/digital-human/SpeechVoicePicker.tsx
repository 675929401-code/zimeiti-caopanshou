'use client';
import {useEffect,useRef,useState} from 'react';
import {Search,ChevronDown,Play,Square,Heart,LoaderCircle} from 'lucide-react';
import VoicePortrait from '@/components/vs/VoicePortrait';
import {useVoiceFavorites} from '@/hooks/use-voice-favorites';
import {loadPreview,clearCachedPreview} from '@/lib/vs/preview-cache';
import styles from '@/app/digital-human/workspace.module.css';
type Voice={id:string;name:string;speakerId:string;description:string;gender?:string;group:string;engine:string};
export function SpeechVoicePicker({userId,token,voices,value,disabled,onChange}:{userId:string;token:string;voices:Voice[];value:string;disabled:boolean;onChange:(value:string)=>void}){
 const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[tab,setTab]=useState('all'),[playing,setPlaying]=useState(''),[loading,setLoading]=useState(''),[error,setError]=useState('');
 const {favorites,favoriteError,toggleFavorite}=useVoiceFavorites(userId,token);const audio=useRef<HTMLAudioElement|null>(null),sequence=useRef(0),trigger=useRef<HTMLButtonElement>(null);
 function stop(){sequence.current++;const current=audio.current;if(current){current.pause();if(current.src.startsWith('blob:'))URL.revokeObjectURL(current.src);current.src='';audio.current=null;}setPlaying('');setLoading('');}
 useEffect(()=>()=>{sequence.current++;audio.current?.pause();if(audio.current?.src.startsWith('blob:'))URL.revokeObjectURL(audio.current.src);},[]);
 useEffect(()=>{if(disabled){stop();setOpen(false);}},[disabled]);
 async function preview(voice:Voice){if(playing===voice.id||loading===voice.id){stop();return;}stop();setError('');const ticket=++sequence.current;setLoading(voice.id);
  try{const result=await loadPreview(voice.speakerId);if(ticket!==sequence.current){if(result.audioUrl.startsWith('blob:'))URL.revokeObjectURL(result.audioUrl);return;}const player=new Audio(result.audioUrl);audio.current=player;player.onended=()=>{if(ticket===sequence.current)stop();};player.onerror=()=>{if(ticket===sequence.current){stop();void clearCachedPreview(voice.speakerId);setError('音频暂时无法播放，请重新试听');}};await player.play();if(ticket===sequence.current){setPlaying(voice.id);setLoading('');}}
  catch(error){if(ticket===sequence.current){stop();setError(error instanceof Error?error.message:'试听暂不可用');}}
 }
 const selected=voices.find(v=>v.id===value);const filtered=voices.filter(v=>(tab!=='favorites'||favorites.has(v.speakerId))&&(tab!=='mine'||v.group==='我的音色')&&(!search||(v.name+' '+v.speakerId).toLowerCase().includes(search.toLowerCase())));
 return <div className={styles.voicePicker} onKeyDown={event=>{if(event.key==='Escape'){setOpen(false);stop();trigger.current?.focus();}}}>
  <span className={styles.voiceLabel}>选择音色</span>
  <div className={styles.voiceSelection}><button type="button" ref={trigger} className={styles.voiceTrigger} aria-label="选择配音音色" aria-expanded={open} aria-controls="digital-voice-options" disabled={disabled} onClick={()=>{if(open)stop();setOpen(!open);}}>{selected&&<span className={styles.voiceThumb}><VoicePortrait speakerId={selected.speakerId} name={selected.name} gender={selected.gender}/></span>}<span>{selected?.name||'请选择音色'}</span><ChevronDown size={16}/></button>{selected&&<button type="button" className={styles.voicePlay} aria-label={playing===selected.id?'停止试听所选音色':'试听所选音色'} disabled={disabled} onClick={()=>void preview(selected)}>{loading===selected.id?<LoaderCircle className="animate-spin" size={16}/>:playing===selected.id?<Square size={16}/>:<Play size={16}/>}</button>}</div>
  {open&&<div id="digital-voice-options" className={styles.voiceOptions}>
   <div className={styles.voiceSearch}><Search size={16}/><input autoFocus aria-label="搜索配音音色" placeholder="搜索音色名称或ID" value={search} onChange={event=>setSearch(event.target.value)}/></div>
   <div className={styles.voiceFilters}>{[['all','全部音色'],['favorites','收藏音色'],['mine','我的音色']].map(([id,label])=><button key={id} type="button" aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}{id==='favorites'?' '+favorites.size:''}</button>)}</div>
   <div role="listbox" aria-label="可选配音音色" className={styles.voiceList}>{filtered.map(voice=><div key={voice.id} className={styles.voiceOptionRow}><button type="button" role="option" aria-selected={voice.id===value} className={styles.voiceOption} onClick={()=>{onChange(voice.id);stop();setOpen(false);trigger.current?.focus();}}><span className={styles.voiceThumb}><VoicePortrait speakerId={voice.speakerId} name={voice.name} gender={voice.gender}/></span><span><strong>{voice.name}</strong><small>{voice.description}</small></span></button><button type="button" className={styles.voicePlay} aria-label={(playing===voice.id?'停止试听 ':'试听 ')+voice.name} onClick={()=>void preview(voice)}>{loading===voice.id?<LoaderCircle className="animate-spin" size={16}/>:playing===voice.id?<Square size={16}/>:<Play size={16}/>}</button><button type="button" className={styles.voicePlay} aria-label={(favorites.has(voice.speakerId)?'取消收藏 ':'收藏 ')+voice.name} aria-pressed={favorites.has(voice.speakerId)} onClick={()=>void toggleFavorite({speakerId:voice.speakerId,name:voice.name,gender:voice.gender,engine:voice.engine,language:'zh-cn'})}><Heart size={16} fill={favorites.has(voice.speakerId)?'currentColor':'none'}/></button></div>)}{!filtered.length&&<p className={styles.hint}>{tab==='favorites'?'暂无匹配的收藏音色，点击音色旁的爱心即可收藏。':'未找到匹配音色。'}</p>}</div>
  </div>}
  {(error||favoriteError)&&<p role="alert" className={styles.inlineError}>{error||favoriteError}</p>}
 </div>;
}
