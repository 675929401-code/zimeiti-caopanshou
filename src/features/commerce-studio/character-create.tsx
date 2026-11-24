'use client';
import {useEffect,useRef,useState} from 'react';
import {Check,Folder,Image as ImageIcon,Mic,Square,Upload,X} from 'lucide-react';
import {AssetPicker} from '@/commerce/components/commerce-agent/asset-picker';
import {api,type Runtime,type UIAsset} from '@/commerce/components/commerce-agent/runtime-ui';
import {characterImageSlots,type CharacterProfile} from '@/commerce/shared/character-profile';
import './character-create.css';

export function CharacterProfileDetail({id}:{id:string}){
 const [profile,setProfile]=useState<CharacterProfile|null>(null),[error,setError]=useState('');
 useEffect(()=>{let mounted=true;setProfile(null);setError('');api<{profile:CharacterProfile|null}>('/api/commerce/characters?id='+encodeURIComponent(id)).then(data=>{if(mounted)setProfile(data.profile);}).catch(e=>{if(mounted)setError(e.message);});return()=>{mounted=false;};},[id]);
 if(error)return <p role="alert">{error}</p>;
 if(!profile)return null;
 return <section className="cs-recorded-character" aria-label="已保存的角色参考"><div>{profile.images.map((asset,i)=>asset&&<figure key={i}><img src={'/api/commerce/assets/'+asset} alt={characterImageSlots[i]}/><figcaption>{characterImageSlots[i]}</figcaption></figure>)}</div>{profile.audioId&&<audio controls src={'/api/commerce/assets/'+profile.audioId} aria-label="已保存的角色声音"/>}{profile.videoId&&<video controls src={'/api/commerce/assets/'+profile.videoId} aria-label="已保存的角色录像"/>}</section>;
}

type Method='image'|'camera';
type Props={method:Method;runtime:Runtime;close:()=>void;saved:()=>void};
const emptySlots=()=>Array<UIAsset|null>(characterImageSlots.length).fill(null);

export function CharacterCreate({method,runtime,close,saved}:Props){
 const dialog=useRef<HTMLDialogElement>(null),preview=useRef<HTMLVideoElement>(null);
 const stream=useRef<MediaStream|null>(null),recorder=useRef<MediaRecorder|null>(null),active=useRef(true),locked=useRef(false),attempt=useRef(0);
 const [images,setImages]=useState(emptySlots),[audio,setAudio]=useState<UIAsset|null>(null),[clip,setClip]=useState<UIAsset|null>(null);
 const [slot,setSlot]=useState<number|null>(null),[consent,setConsent]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [camera,setCamera]=useState(method==='camera'),[ready,setReady]=useState(false),[recording,setRecording]=useState(false),[voice,setVoice]=useState(false);
 function release(){attempt.current++;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;}
 useEffect(()=>{active.current=true;const el=dialog.current!;el.showModal();return()=>{active.current=false;const r=recorder.current;if(r&&r.state!=='inactive')r.stop();release();el.close();};},[]);
 async function connect(video:boolean){
   const id=++attempt.current;setError('');setReady(false);
   try{
     if(!navigator.mediaDevices?.getUserMedia)throw Error('设备接口不可用');
     const value=await navigator.mediaDevices.getUserMedia({video,audio:true});
     if(!active.current||id!==attempt.current){value.getTracks().forEach(t=>t.stop());return;}
     stream.current?.getTracks().forEach(t=>t.stop());stream.current=value;
     if(video&&preview.current){preview.current.srcObject=value;await preview.current.play();}
     setReady(true);return value;
   }catch{if(active.current&&id===attempt.current)setError(video?'未检测到摄像头或麦克风，请连接设备后':'无法读取麦克风，请允许使用麦克风或选择音频文件');}
 }
 useEffect(()=>{if(method==='camera')void connect(true);},[method]);
 async function takeCover(){
   const player=preview.current;if(!player?.videoWidth)throw Error('请等待摄像头画面加载');
   const canvas=document.createElement('canvas');canvas.width=player.videoWidth;canvas.height=player.videoHeight;const context=canvas.getContext('2d');if(!context)throw Error('无法读取录像封面');
   context.drawImage(player,0,0);
   const blob=await new Promise<Blob>((yes,no)=>canvas.toBlob(b=>b?yes(b):no(Error('无法保存录像封面')),'image/jpeg',.9));
   return new File([blob],'角色正脸-'+Date.now()+'.jpg',{type:'image/jpeg'});
 }
 async function begin(video:boolean){
   if(locked.current||recording)return;locked.current=true;setBusy(true);setError('');
   try{
     const media=video?stream.current:await connect(false);if(!media)return;
     if(typeof MediaRecorder==='undefined')throw Error('当前浏览器不支持录制');
     const types=video?['video/webm','video/mp4']:['audio/webm','audio/mp4','audio/ogg'];const mime=types.find(t=>MediaRecorder.isTypeSupported(t));
     if(!mime)throw Error('此设备没有可用的录制格式');
     const image=video?await takeCover():null;if(!active.current)return;
     const device=new MediaRecorder(media,{mimeType:mime}),parts:Blob[]=[];recorder.current=device;
     device.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};
     device.onerror=()=>{if(active.current)setError('录制中断，请重新录制');};
     device.onstop=async()=>{release();if(!active.current)return;setRecording(false);setBusy(true);locked.current=true;try{
       if(!parts.length)throw Error('未录到有效素材');
       const name='角色'+(video?'录像':'声音')+'-'+Date.now()+'.'+mime.split('/')[1];
       const mediaAsset=await runtime.upload(new File(parts,name,{type:mime}));if(!active.current)return;
       if(video&&image){const cover=await runtime.upload(image);if(!active.current)return;setClip(mediaAsset);setImages([cover,...emptySlots().slice(1)]);setCamera(false);}
       else setAudio(mediaAsset);
     }catch(e){if(active.current)setError((e as Error).message);}finally{if(active.current){setReady(false);setVoice(false);setBusy(false);locked.current=false;}}};
     device.start();setRecording(true);setVoice(!video);
   }catch(e){release();setReady(false);if(active.current)setError((e as Error).message);}
   finally{locked.current=false;if(active.current)setBusy(false);}
 }
 function stop(){if(recorder.current?.state==='recording')recorder.current.stop();}
 async function submit(){
   if(!images[0]||!consent||locked.current||recording)return;locked.current=true;setBusy(true);setError('');
   try{await api('/api/commerce/characters',{images:images.map(x=>x?.id||null),audioId:audio?.id||null,videoId:clip?.id||null,consent});await runtime.refresh();if(active.current)saved();}
   catch(e){if(active.current)setError((e as Error).message);}
   finally{locked.current=false;if(active.current)setBusy(false);}
 }
 const label=camera?'录制视频创建':'选择图片创建';
 return <dialog ref={dialog} className={'cs-character-dialog'+(camera?' cs-character-camera':'')} aria-label={label} onCancel={e=>{e.preventDefault();if(slot!==null)setSlot(null);else if(!busy)close();}}>
 {camera?<><button aria-label="退出录制" className="cs-camera-exit" onClick={close} disabled={busy}><X size={20}/></button><video ref={preview} muted autoPlay playsInline hidden={!ready}/><div className="cs-camera-controls">{!ready?<><p>{error||'正在检查摄像头和麦克风…'}</p>{error&&<button onClick={()=>void connect(true)}>点击重试</button>}</>:<><p>请面对摄像头，清晰读出 123 456 789</p><button onClick={()=>recording?stop():void begin(true)} disabled={busy}>{recording?'完成录制':'开始录制'}</button>{error&&<p role="alert">{error}</p>}</>}</div></>:<>
 <header><h2>选择图片创建</h2><button aria-label="关闭" onClick={close} disabled={busy}><X size={17}/></button></header>
 <section className="cs-character-slots">{characterImageSlots.map((name,i)=><div key={i}><button disabled={busy||recording} onClick={()=>setSlot(i)} aria-label={'选择'+name+(i>2?' '+(i-2):'')}>{images[i]?<img src={images[i]!.url} alt={name}/>:<ImageIcon size={48} strokeWidth={.8}/>}<Upload size={17} className="cs-character-upload"/></button><small>{name}{i>0?'（可选）':''}</small></div>)}</section>
 <div className="cs-character-audio"><button disabled={busy||recording&&!voice} onClick={()=>voice?stop():void begin(false)}>{voice?<Square size={15}/>:<Mic size={15}/>} {voice?'完成录音':'录制声音'}</button><button disabled={busy||recording} onClick={()=>setSlot(-1)}><Folder size={15}/> 选择音频</button></div>
 {voice&&<p>请读出下方文字　123 456 789</p>}{audio&&<audio controls aria-label="角色声音" src={audio.url}/>}
 <label className="cs-character-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>我确认对提交的人脸、形象和声音拥有使用权或已获得授权，同意保存为本账号的角色参考素材。</label>
 {error&&<p role="alert">{error}</p>}
 <footer><small>{clip?'录像和封面将保存至角色参考库':'保存至本站角色参考库'}</small><button disabled={!images[0]||!consent||busy||recording} onClick={()=>void submit()}><Check size={14}/>{busy?'正在保存':'创建角色'}</button></footer>
 {slot!==null&&<AssetPicker runtime={runtime} existing={[]} slot={{id:'character-reference',label:slot===-1?'声音':characterImageSlots[slot],min:1,max:1,kinds:[slot===-1?'audio':'image']}} onClose={()=>setSlot(null)} onSelect={assets=>{const asset=assets[0];if(asset){if(slot===-1)setAudio(asset);else setImages(old=>old.map((a,i)=>i===slot?asset:a));}setSlot(null);}}/>}</>}
 </dialog>;
}
