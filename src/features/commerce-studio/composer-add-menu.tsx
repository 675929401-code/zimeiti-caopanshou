'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Blocks, ChevronRight, FolderUp, Inbox, Link2, Search, Upload} from 'lucide-react';
import './composer-add-menu.css';
import {AnchoredPanel} from '@/commerce/components/commerce-agent/reference-ui';
import {builtinSkills,type MemberSkill,type SkillLibrary} from './member-skills';

type Branch='skills'|'connectors'|'';
type Props={
  close:()=>void;upload:()=>void;assets:()=>void;manage:()=>void;
  loadLibrary:()=>Promise<SkillLibrary>;pick:(skill:MemberSkill)=>void;connector:(name:string)=>void;
};

export function ComposerAddMenu({close,upload,assets,manage,loadLibrary,pick,connector}:Props){
  const [branch,setBranch]=useState<Branch>(''),[query,search]=useState('');
  const [library,setLibrary]=useState<SkillLibrary|null>(null),[issue,report]=useState(''),[attempt,retry]=useState(0);
  const panel=useRef<HTMLDivElement>(null),child=useRef<HTMLDivElement>(null);
  const load=useRef(loadLibrary);load.current=loadLibrary;
  useEffect(()=>{
    if(branch!=='skills'||library)return;
    let live=true;report('');
    load.current().then(data=>{if(live)setLibrary(data)}).catch(e=>{if(live)report(e instanceof Error?e.message:'技能读取失败')});
    return ()=>{live=false};
  },[branch,library,attempt]);
  function reveal(next:Branch){if(next!==branch){setBranch(next);search('')}}
  function choose(action:()=>void){close();action()}
  const skills=library?[...library.custom,...builtinSkills].filter(s=>library.installed.includes(s.id)):[];
  const results=skills.filter(s=>(s.name+s.description).toLowerCase().includes(query.trim().toLowerCase()));
  const services=['钉钉','飞书'].filter(n=>n.includes(query.trim()));
  useLayoutEffect(()=>{
    const anchor=panel.current,sub=child.current;if(!anchor||!sub)return;
    function place(){
      if(!anchor||!sub)return;
      const rect=anchor.parentElement!.getBoundingClientRect();
      const bottom=rect.bottom-(branch==='skills'?45:9);
      const top=Math.max(8,Math.min(innerHeight-8-sub.offsetHeight,bottom-sub.offsetHeight));
      sub.style.top=(top-rect.top-1)+'px';
      sub.style.left=(rect.right+sub.offsetWidth<=innerWidth-8?rect.width-2:-sub.offsetWidth)+'px';
    }
    place();const observer=new ResizeObserver(place);observer.observe(sub);window.addEventListener('resize',place);
    return ()=>{observer.disconnect();window.removeEventListener('resize',place)};
  },[branch]);
  return <AnchoredPanel label="添加素材、技能或连接器" className="cs-composer-add" onClose={close}><div className="cs-add-rows" ref={panel}>
    <button onPointerEnter={()=>reveal('')} onFocus={()=>reveal('')} onClick={()=>choose(upload)}><Upload/>从本地上传</button>
    <button onPointerEnter={()=>reveal('')} onFocus={()=>reveal('')} onClick={()=>choose(assets)}><FolderUp/>从素材库选择</button>
    <hr/>
    {(['skills','connectors'] as const).map(key=><button key={key} aria-expanded={branch===key} aria-haspopup="dialog" onPointerEnter={()=>reveal(key)} onFocus={()=>reveal(key)} onClick={()=>reveal(key)} onKeyDown={e=>{if(e.key==='ArrowRight'){e.preventDefault();reveal(key);requestAnimationFrame(()=>child.current?.querySelector<HTMLElement>('button,input')?.focus())}}}>
      {key==='skills'?<Blocks/>:<Link2/>}{key==='skills'?'技能':'连接器'}<ChevronRight/></button>)}
    {branch&&<div className="cs-add-sub" ref={child} role="dialog" aria-label={branch==='skills'?'选择技能':'选择连接器'}>
      {branch==='skills'&&<header><button onClick={()=>choose(manage)}><Inbox/>管理技能</button></header>}
      <div className="cs-add-list">{branch==='skills'?<>
        {issue?<p role="alert">{issue} <button onClick={()=>retry(v=>v+1)}>重试</button></p>:!library?<p role="status">正在读取技能…</p>:results.length===0?<p>{query?'没有匹配的技能':'暂无已安装技能'}</p>:results.map(s=><button className="cs-add-skill" key={s.id} onClick={()=>choose(()=>pick(s))}><Blocks/><span><b>{s.name}</b><small>{s.description}</small></span></button>)}
      </>:services.length?services.map(name=><button className="cs-add-service" key={name} aria-label={'连接 '+name} onClick={()=>choose(()=>connector(name))}><Link2/>{name}<i aria-hidden="true"/></button>):<p>没有匹配的连接器</p>}</div>
      <label><Search/><input value={query} onChange={e=>search(e.target.value)} aria-label={branch==='skills'?'搜索技能':'搜索连接器'} placeholder={branch==='skills'?'搜索技能':'搜索连接器'}/></label>
    </div>}
  </div></AnchoredPanel>
}