'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,Blocks,BookOpen,Clapperboard,FileText,FolderDown,Image as ImageIcon,Link2,MessageCircle,PanelLeftClose,PanelLeftOpen,Plus,Search,SquarePen,Video} from 'lucide-react';
import {builtinSkills,type MemberSkill,type SkillLibrary} from './member-skills';
import {MarketConnectors} from './market-connectors';

const categories=['全部','图片','视频','文档','开发','其他'];
const allSkills=[...builtinSkills].sort((a,b)=>(a.sort??0)-(b.sort??0));
const icons=[Clapperboard,ImageIcon,Video,FolderDown,FileText,Blocks,BookOpen];
export function SkillGlyph({item}:{item:MemberSkill}){
  if(item.icon)return <img className="cs-market-glyph cs-market-artwork" alt="" src={'/commerce/market-icons/'+item.icon}/>;
  const index=item.sort??5,Icon=icons[index%icons.length];
  return <span aria-hidden="true" className={'cs-market-glyph tone-'+index%6}><Icon size={24}/></span>;
}
type Props={library:SkillLibrary|null;history:{id:string;title:string}[];openChat:(id?:string)=>void;busy:boolean;connectorEntry?:boolean;create:()=>void;open:(id:string,opener:HTMLElement)=>void;install:(s:MemberSkill)=>void;apply:(s:MemberSkill)=>void;back:()=>void};
export function SkillMarket({library,history,openChat,busy,create,open,install,apply,back,connectorEntry}:Props){
  const [tab,setTab]=useState<'skills'|'installed'|'connectors'>(connectorEntry?'connectors':'skills'),[query,search]=useState(''),[category,setCategory]=useState('全部'),[collapsed,collapse]=useState(false);
  const scroll=useRef<HTMLDivElement>(null);
  useEffect(()=>{scroll.current?.scrollTo(0,0);},[category,query,tab]);
  const owned=library?.custom||[], installed=library?.installed||[],items=[...owned,...allSkills];
  function switchTab(value:typeof tab){setTab(value);search('');setCategory('全部');}
  const matching=(skill:MemberSkill)=>(skill.name+' '+skill.description).toLowerCase().includes(query.trim().toLowerCase());
  function grid(rows:MemberSkill[],label:string){
    return <div className="cs-market-grid" aria-label={label}>{rows.map(item=>{
      const used=installed.includes(item.id);
      return <article className="cs-market-card" key={item.id}><SkillGlyph item={item}/>
        <button className="cs-market-info" aria-label={'查看 '+item.name+' 详情'} onClick={e=>open(item.id,e.currentTarget)}>
          <strong>{item.name}</strong><small>{item.description}</small><span>{item.instruction?'自建技能':library?.stats?.[item.id]?library.stats[item.id].installs+' 人正在使用':'—'}</span></button>
        <button className="cs-market-action" aria-label={(used?'使用 ':'安装 ')+item.name} disabled={!library||busy} onClick={()=>used?apply(item):install(item)}>{used?<MessageCircle size={18}/>:<Plus size={18}/>}</button>
      </article>;})}{!rows.length&&<p className="cs-market-empty">{query?'没有匹配的技能':tab==='installed'?'暂无已安装技能':'暂无技能'}</p>}</div>;
  }
  const installedRows=items.filter(s=>installed.includes(s.id)&&matching(s));
  return <div className="cs-market-layout">{!collapsed&&<aside className="cs-market-side"><header>Agent<button aria-label="收起面板" onClick={()=>collapse(true)}><PanelLeftClose size={16}/></button></header>
    <button onClick={()=>openChat()}><SquarePen size={16}/>新任务</button><button className="selected" onClick={()=>switchTab('skills')}><Blocks size={16}/>技能·连接器</button>
    <h3>最近</h3>{history.map(row=><button key={row.id} className="cs-market-thread" onClick={()=>openChat(row.id)}>{row.title}</button>)}<button className="cs-market-scene-back" onClick={back}>返回创作技能</button></aside>}
    <div className="cs-market-main"><header className="cs-market-bar">{collapsed&&<button aria-label="展开面板" onClick={()=>collapse(false)}><PanelLeftOpen size={16}/></button>}
      {tab==='installed'?<button onClick={()=>switchTab('skills')}><ArrowLeft size={16}/>已安装技能（{installed.length}）</button>:<nav aria-label="技能与连接器"><button aria-pressed={tab==='skills'} onClick={()=>switchTab('skills')}><Blocks size={16}/>技能</button><button aria-pressed={tab==='connectors'} onClick={()=>switchTab('connectors')}><Link2 size={16}/>连接器</button></nav>}
      <label className="cs-market-search"><Search size={16}/><input aria-label={tab==='connectors'?'搜索连接器':'搜索技能'} placeholder={tab==='connectors'?'搜索连接器':tab==='installed'?'搜索已安装的技能':'搜索技能'} value={query} onChange={e=>search(e.target.value)}/></label>
      {tab==='skills'&&<><button className="cs-market-outline" onClick={()=>switchTab('installed')}><FolderDown size={16}/>已安装（{installed.length}）</button><button className="cs-market-dark" disabled={busy} onClick={create}><Plus size={16}/>创建技能</button></>}
      {tab==='connectors'&&<button className="cs-market-dark" form="cs-custom-connector-launch" type="submit"><SquarePen size={16}/>自定义连接器</button>}</header>
      <div className="cs-market-scroll" ref={scroll}>{tab==='connectors'?<MarketConnectors query={query}/>:tab==='installed'?<><h2>来自市场（{installedRows.filter(i=>!i.instruction).length}）</h2>{grid(installedRows.filter(i=>!i.instruction),'已安装市场技能')}{installedRows.some(i=>i.instruction)&&<><h2>我的技能</h2>{grid(installedRows.filter(i=>i.instruction),'自建技能')}</>}</>:<>
      {!query.trim()&&<section><h2>推荐</h2>{grid(builtinSkills.slice(0,5),'推荐技能')}</section>}
      <nav className="cs-market-categories" aria-label="技能分类">{categories.map(c=><button key={c} aria-pressed={c===category} onClick={()=>setCategory(c)}>{c}</button>)}</nav>
      {grid(allSkills.filter(i=>(category==='全部'||(i.category||'其他')===category)&&matching(i)),'技能目录')}</>}</div>
    </div></div>;
}
