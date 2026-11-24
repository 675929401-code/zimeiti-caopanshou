'use client';
import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {SkillMarket, SkillGlyph} from './skill-market';
import './skill-market.css';
import {api} from '@/commerce/components/commerce-agent/runtime-ui';
import type {DirectorNavCard} from '@/commerce/components/commerce-agent/director-nav';
import {isVideoProductionSkill} from '@/commerce/shared/member-video-production';
import {isMemberDocumentSkill} from '@/commerce/shared/member-documents';
import {isMemberChatSkill} from '@/commerce/shared/member-chat-skills';
import {isSocialVideoSkill} from '@/commerce/shared/social-video';
import {sceneSkills} from './scene-skills';
import {builtinSkills,type MemberSkill,type SkillLibrary} from './member-skills';

export function SkillDirectory({apply,cards,go,startCreation,marketEntry,draft,history,openChat,connectorEntry}:{connectorEntry?:boolean;history:{id:string;title:string}[];openChat:(id?:string)=>void;apply:(skill:MemberSkill)=>void;cards:DirectorNavCard[];go:(path:string)=>void;startCreation:()=>void;marketEntry:boolean;draft:{id:string;text:string}|null}){
  const [library,setLibrary]=useState<SkillLibrary|null>(null),[error,setError]=useState(''),[attempt,retry]=useState(0);
  const market=marketEntry||!!draft;
  const [selected,select]=useState(draft?'create':'');
  const [name,setName]=useState(''),[instruction,setInstruction]=useState(draft?.text||''),[busy,setBusy]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  const pending=useRef(false),requestId=useRef(draft?.id||''),close=useRef<HTMLButtonElement>(null),opener=useRef<HTMLElement|null>(null);
  useEffect(()=>{let live=true;setError('');
    api<SkillLibrary>('/api/commerce/studio/skills').then(data=>{if(live)setLibrary(data);}).catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;};
  },[attempt]);
  useEffect(()=>{if(!selected||!dialog.current)return;const el=dialog.current;el.showModal();close.current?.focus();return ()=>el.close();},[selected]);
  const skills=[...(library?.custom||[]),...builtinSkills],skill=skills.find(item=>item.id===selected);
  const installed=(id:string)=>library?.installed.includes(id)===true;
  const creating=selected==='create';
  function launch(item:MemberSkill){
    void api<SkillLibrary>('/api/commerce/studio/skills',{action:'open',id:item.id,requestId:crypto.randomUUID()}).catch(()=>{});
    apply(item);
  }
  function open(id:string,trigger:HTMLElement){opener.current=trigger;select(id);}
  function dismiss(){if(busy)return;select('');requestAnimationFrame(()=>opener.current?.focus());}
  async function change(action:'create'|'install'|'uninstall',target?:MemberSkill){
    if(pending.current||!library)return;
    const id=creating?requestId.current:(target||skill)?.id;if(!id)return;
    setBusy(true);pending.current=true;setError('');
    try{const next=await api<SkillLibrary>('/api/commerce/studio/skills',{action,id,...(creating?{name,instruction}:{})});
      setLibrary(next);if(creating){select(id);setName('');setInstruction('');}
    }catch(e){setError((e as Error).message);}finally{setBusy(false);pending.current=false;}
  }
  return <section className={market?'cs-market-page':'cs-directory cs-record-directory cs-scene-directory'}>
    {!market&&<header><h1>创作技能</h1><button disabled={busy} onClick={startCreation}>创建技能</button></header>}
    {!market&&<><div className="cs-scene-skills" aria-label="创作场景技能">{sceneSkills(cards).map(item=><button key={item.key} onClick={()=>go(item.route)}><strong>{item.name}</strong><small>{item.description}</small></button>)}</div><footer className="cs-skills-footer"><button onClick={()=>go('/skills?view=market')}>技能广场</button></footer></>}
    {market&&<SkillMarket connectorEntry={connectorEntry} library={library} history={history} openChat={openChat} busy={busy} create={startCreation} open={open} install={item=>void change('install',item)} apply={launch} back={()=>go('/skills')}/>} 
    {error&&<p role="alert">{error} {!library&&<button onClick={()=>retry(v=>v+1)}>重新读取</button>}</p>}
    {(creating||skill)&&<div className="cs-directory-content">
      {(creating||skill)&&<dialog ref={dialog} className={'cs-directory-drawer cs-skill-drawer'+(creating?'':' cs-market-detail')} onCancel={e=>{e.preventDefault();dismiss();}} onClick={e=>{if(e.target===dialog.current){const box=dialog.current.getBoundingClientRect();if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)dismiss();}}} aria-label={(creating?'创建技能':skill?.name+'详情')} onKeyDown={e=>{if(e.key==='Escape')dismiss();}}><header>{creating&&<h2>创建技能</h2>}<button ref={close} disabled={busy} aria-label="关闭详情" onClick={dismiss}><X size={16}/></button></header>
      {creating?<form onSubmit={e=>{e.preventDefault();void change('create');}}><label>技能名称<input required maxLength={60} value={name} onChange={e=>setName(e.target.value)}/></label><label>创作指令<textarea required maxLength={4000} rows={8} value={instruction} onChange={e=>setInstruction(e.target.value)}/></label><button disabled={busy||!name.trim()||!instruction.trim()}>保存并安装</button></form>:skill&&<><div className="cs-market-detail-head"><SkillGlyph item={skill}/><div><h2>{skill.name}</h2><div className="cs-market-actions">{installed(skill.id)?<><button onClick={()=>launch(skill)}>去试试</button><button disabled={busy} onClick={()=>void change('uninstall')}>卸载</button></>:<button disabled={!library||busy} onClick={()=>void change('install')}>安装</button>}</div></div></div>
        <p className="cs-market-description">{skill.instruction||skill.detail||skill.description}{skill.id==='reverse-video'&&' 上传参考片，核对镜头证据，替换商品后生成脚本。'}{skill.id==='detail-set'&&' 上传商品参考图，确认品牌、卖点和目标平台，检查逐屏画面、文字与素材分配。保存后可以再次打开，单独修改其中一屏，并将整套方案用于后续生成。'}{!isSocialVideoSkill(skill.id)&&skill.id!=='remotion'&&skill.id!=='captions'&&!isMemberDocumentSkill(skill.id)&&!isMemberChatSkill(skill.id)&&!isVideoProductionSkill(skill.id)&&skill.id!=='wechat-editor'&&skill.id!=='slides'&&skill.id!=='pdf-tools'&&skill.id!=='markdown-docx'&&skill.id!=='video-frame'&&skill.id!=='demux'&&!skill.route&&!skill.instruction&&<span className="cs-skill-availability"> 本站尚未接入此技能的执行功能。</span>}</p>
        {installed(skill.id)&&<p className="cs-market-version">{skill.referenceVersion?'已安装版本 '+skill.referenceVersion:'已安装'}</p>}
        <dl className="cs-market-metrics">{[['版本',skill.referenceVersion?'v'+skill.referenceVersion:'自建'],['安装量',library?.stats?.[skill.id]?.installs??'—'],['使用次数',library?.stats?.[skill.id]?.opens??'—'],['开发者信息',skill.instruction?'本人':'自媒体操盘手']].map(([label,value])=><div key={label}><dt>{label}</dt><dd title={label==='使用次数'?'本站从技能广场打开此技能的累计次数':label==='安装量'?'本站当前已安装该技能的账户数':undefined}>{value}</dd></div>)}</dl><section className="cs-market-more"><h3>更多</h3><p>ID: {skill.id}</p></section></>}</dialog>}
    </div>}</section>;
}
