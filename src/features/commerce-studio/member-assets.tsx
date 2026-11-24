'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowDownUp,Check,ChevronDown,Download,FileText,Folder,Image as ImageIcon,Layers,MoreHorizontal,Music,Pencil,Plus,Search,Trash2,UserRound,Video,X} from 'lucide-react';
import {api,type Runtime,type UIAsset} from '@/commerce/components/commerce-agent/runtime-ui';
import {CharacterCreate,CharacterProfileDetail} from './character-create';
import './member-assets.css';
type Group={id:string;name:string;kind?:string;assetIds:string[]};
type Props={runtime:Runtime;onUse:(asset:UIAsset)=>void;manage:(roles:boolean)=>void;go:(path:string)=>void;roles:boolean;onNotice:(text:string)=>void};
const assetTime = new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function formatAssetTime(value:number){
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? assetTime.format(date) : '';
}
const panelLabels:Record<string,string>={preview:'素材预览',rename:'编辑素材','new-group':'新建资产库',delete:'删除素材','delete-group':'删除资产库',import:'导入链接',attach:'加入资产库'};
const filters=[['全部',Layers],['图片',ImageIcon],['视频',Video],['音频',Music],['文档',FileText],['角色',UserRound]] as const;
const assetSources=[['','全部来源'],['upload','我上传的'],['generated','AI生成的']] as const;
function AssetSourceMenu({value,choose}:{value:string;choose:(v:string)=>void}){
  const el=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{const outside=(e:PointerEvent)=>{if(el.current?.open&&!el.current.contains(e.target as Node))el.current.open=false;};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[]);
  function close(){if(el.current){el.current.open=false;el.current.querySelector('summary')?.focus();}}
  return <details ref={el} className="cs-source-menu" onBlur={e=>{if(e.relatedTarget&&!e.currentTarget.contains(e.relatedTarget as Node))e.currentTarget.open=false;}} onKeyDown={e=>{
    if(e.key==='Escape'){e.preventDefault();close();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
    e.preventDefault();e.currentTarget.open=true;const options=Array.from(e.currentTarget.querySelectorAll('button'));const i=options.indexOf(document.activeElement as HTMLButtonElement);
    const index=e.key==='Home'?0:e.key==='End'?options.length-1:e.key==='ArrowUp'?(i<=0?options.length-1:i-1):(i+1)%options.length;options[index]?.focus();
  }}><summary role="button" aria-label="素材来源" aria-haspopup="menu">{assetSources.find(x=>x[0]===value)?.[1]}<ChevronDown size={14}/></summary><div role="menu" aria-label="选择素材来源">{assetSources.map(([key,label])=><button role="menuitemradio" aria-checked={key===value} key={key} onClick={()=>{choose(key);close();}}>{label}{key===value&&<Check size={14}/>}</button>)}</div></details>;
}
function mediaKind(a:UIAsset){if(a.type.startsWith('image/'))return '图片';if(a.type.startsWith('video/'))return '视频';if(a.type.startsWith('audio/'))return '音频';return '文档';}
function Media({asset,full=false}:{asset:UIAsset;full?:boolean}){
  const kind=mediaKind(asset);
  if(kind==='图片')return <img src={asset.url} alt={asset.name} loading="lazy"/>;
  if(kind==='视频')return <video src={asset.url} controls={full} muted={!full} preload="metadata"/>;
  if(kind==='音频')return full?<audio src={asset.url} controls/>:<Music size={32}/>;
  return <FileText size={32}/>;
}
export function MemberAssets({runtime,onUse,manage,roles,go,onNotice}:Props){
  const [kind,setKind]=useState('全部'),[source,setSource]=useState(''),[query,search]=useState(''),[asc,ascending]=useState(false);
  const [groups,setGroups]=useState<Group[]>([]),[group,setGroup]=useState(''),[refresh,refreshGroups]=useState(0);
  const [batch,setBatch]=useState(false),[ids,setIds]=useState<string[]>([]),[panel,show]=useState(''),[name,rename]=useState(''),[selected,select]=useState<UIAsset|null>(null);
  const [characterMethod,setCharacterMethod]=useState<'image'|'camera'|null>(null),[methodMenu,setMethodMenu]=useState(false);
  const [groupKind,setGroupKind]=useState('普通');
  const [importUrl,setUrl]=useState(''),[importKind,setImportKind]=useState('image'),[error,report]=useState(''),[busy,setBusy]=useState(false);
  const input=useRef<HTMLInputElement>(null),dialog=useRef<HTMLDialogElement>(null),lock=useRef(false);
  useEffect(()=>{let live=true;api<{groups:Group[]}>('/api/commerce/v1/asset-groups').then(d=>{if(live)setGroups(d.groups);}).catch(e=>{if(live)report(e.message);});return()=>{live=false;};},[refresh]);
  useEffect(()=>{if(!panel)return;const el=dialog.current!;el.showModal();return()=>el.close();},[panel]);
  function close(){if(!lock.current){show('');select(null);report('');}}
  async function run(action:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);report('');try{await action();}catch(e){report((e as Error).message);}finally{lock.current=false;setBusy(false);}}
  const current=groups.find(g=>g.id===group),filter=roles?'角色':kind;
  const rows=runtime.assets.filter(a=>(!current||current.assetIds.includes(a.id))&&(roles||!source||source===a.source)&&a.name.toLowerCase().includes(query.trim().toLowerCase())&&(filter==='全部'||(filter==='角色'?a.collection==='roles':filter===mediaKind(a)))).sort((a,b)=>(asc?1:-1)*(a.createdAt-b.createdAt)||a.id.localeCompare(b.id));
  function chooseFilter(value:string){setMethodMenu(false);setIds([]);setBatch(false);setKind(value==='角色'?'全部':value);if(roles!==(value==='角色'))go('/assets'+(value==='角色'?'?tab=roles':''));}
  function openPanel(id:string,asset:UIAsset|null=null){if(id==='new-group')setGroupKind('普通');report('');select(asset);rename(id==='rename'?asset?.name||'':'');show(id);}
  function changeGroup(value:string){setGroup(value);setIds([]);}
  async function submit(){
    if(panel==='new-group'){const result=await api<{group:Group}>('/api/commerce/v1/asset-groups',{name,kind:groupKind});setGroup(result.group.id);refreshGroups(v=>v+1);}
    else if(panel==='rename'&&selected){await api('/api/commerce/asset-library',{ids:[selected.id],name},'PATCH');await runtime.refresh();}
    else if(panel==='delete'&&selected){await api('/api/commerce/assets',{id:selected.id},'DELETE');await runtime.refresh();}
    else if(panel==='delete-group'&&current){await api('/api/commerce/v1/asset-groups/'+current.id,null,'DELETE');changeGroup('');refreshGroups(v=>v+1);}
    else if(panel==='import'){await api('/api/commerce/assets/import',{url:importUrl,kind:importKind});await runtime.refresh();setUrl('');}
    show('');
  }
  const groupCard=(id:string,label:string,detail:string,add=false)=><button key={id} className="cs-asset-folder" aria-label={label} onClick={()=>{if(add){openPanel('new-group');return;}if(id==='generated'){setSource(s=>s==='generated'?'':'generated');changeGroup('');}else changeGroup(group===id?'':id);}} aria-pressed={!add&&(id==='generated'?source==='generated':group===id)}><span className={'cs-folder-art'+(add?' cs-new-folder':'')}>{add?<Plus size={28}/>:<Folder size={25}/>}</span><strong>{label}</strong><small>{detail}</small></button>;
  return <main className="cs-member-assets"><header><h1>我的资产</h1><details className="cs-assets-more"><summary aria-label="更多资产操作"><MoreHorizontal size={18}/></summary><div>
    <button onClick={()=>manage(roles)}>素材选择与文件夹管理</button><button onClick={()=>openPanel('import')}>导入链接</button><button onClick={()=>{void runtime.refresh();refreshGroups(v=>v+1);}}>刷新</button>
    {['works','recent','favorites'].map((t,i)=><button key={t} onClick={()=>go('/assets?tab='+t)}>{['作品','最近','收藏'][i]}</button>)}{current&&<button onClick={()=>openPanel('delete-group')}>删除当前资产库</button>}</div></details></header>
    <div className="cs-asset-folders">{groupCard('new','新建资产库','',true)}{groupCard('generated','生成结果','图片 / 视频 / 音频')}{groups.map(g=>groupCard(g.id,g.name,(g.kind&&g.kind!=='普通'?g.kind+' · ':'')+g.assetIds.length+' 个素材'))}</div>
    <div className="cs-asset-toolbar" data-roles={roles}><nav aria-label="素材类型">{filters.map(([label,Icon])=><button key={label} aria-pressed={filter===label} onClick={()=>chooseFilter(label)}><Icon size={14}/>{label}</button>)}</nav>
      {!roles&&<AssetSourceMenu value={source} choose={v=>{setSource(v);setIds([]);}}/>}
      <label><Search size={15}/><input placeholder="关键词搜索" aria-label="关键词搜索" value={query} onChange={e=>{search(e.target.value);setIds([]);}}/></label>
      <button aria-pressed={batch} onClick={()=>{setBatch(!batch);setIds([]);}}><Check size={15}/>{batch?'退出批量操作':'批量操作'}</button><button onClick={()=>ascending(!asc)} aria-label={'按创建时间'+(asc?'降序':'升序')}><ArrowDownUp size={14}/>{asc?'升序':'降序'}</button></div>
    {current&&<button className="cs-asset-crumb" onClick={()=>changeGroup('')}>{current.name} <X size={13}/></button>}
    {batch&&<div className="cs-assets-batch"><button onClick={()=>setIds(ids.length===rows.length?[]:rows.map(a=>a.id))}>{ids.length&&ids.length===rows.length?'取消全选':'全选'}</button><span>已选 {ids.length} 项</span><button disabled={!ids.length||busy} onClick={()=>openPanel('attach')}>加入资产库</button></div>}
    <input ref={input} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav" onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';void run(async()=>{const added:string[]=[];for(const file of files){const a=await runtime.upload(file);added.push(a.id);if(current)await api('/api/commerce/v1/asset-groups/'+current.id+'/attach-assets',{assetIds:[a.id]});}if(current)refreshGroups(v=>v+1);if(added.length)onNotice('素材已保存');});}}/>
    {error&&!panel&&<p role="alert">{error} <button onClick={()=>refreshGroups(v=>v+1)}>重新读取</button></p>}
    <section className="cs-media-grid" aria-label="资产列表"><article className="cs-role-entry"><button className="cs-asset-add" disabled={busy} aria-expanded={roles?methodMenu:undefined} onClick={()=>roles?setMethodMenu(!methodMenu):input.current?.click()}><Plus size={26}/>{roles?'创建角色':'添加'}</button><div className="cs-asset-details"><strong>{roles?'创建角色':'添加资产'}</strong><small><span>{roles?'创建角色':'本地上传'}</span><span>—</span></small></div>{roles&&methodMenu&&<div className="cs-role-methods" aria-label="创建方式" onKeyDown={e=>{if(e.key==='Escape')setMethodMenu(false);}}><small>创建方式</small>{(['image','camera'] as const).map((method,i)=><button key={method} onClick={()=>{setMethodMenu(false);setCharacterMethod(method);}}>{i?'录制视频创建':'选择图片创建'}</button>)}</div>}</article>
      {rows.map(a=><article key={a.id}><button className="cs-asset-preview" aria-label={(batch?'选择：':'预览：')+a.name} aria-pressed={batch?ids.includes(a.id):undefined} onClick={()=>batch?setIds(curr=>curr.includes(a.id)?curr.filter(i=>i!==a.id):[...curr,a.id]):openPanel('preview',a)}><Media asset={a}/><span>{a.collection==='roles'?'角色':mediaKind(a)}</span></button>
        <div className="cs-asset-details">
          <div className="cs-asset-caption"><strong title={a.name}>{a.name}</strong><div className="cs-asset-actions"><button aria-label={'编辑 '+a.name} onClick={()=>openPanel('rename',a)}><Pencil size={14}/></button><a href={a.url+'?download=1'} title="下载"><Download size={14}/></a><button aria-label={'删除 '+a.name} onClick={()=>openPanel('delete',a)}><Trash2 size={14}/></button></div></div>
          <small><span>{a.source==='generated'?'生成结果':'上传素材'}</span><time dateTime={Number.isFinite(a.createdAt)?new Date(a.createdAt).toISOString():undefined}>{formatAssetTime(a.createdAt)}</time></small>
        </div></article>)}</section>
    {characterMethod&&<CharacterCreate method={characterMethod} runtime={runtime} close={()=>setCharacterMethod(null)} saved={()=>{setCharacterMethod(null);onNotice('角色参考已保存');}}/>}
    {panel&&<dialog ref={dialog} className="cs-asset-dialog" onCancel={e=>{e.preventDefault();close();}} aria-label={panelLabels[panel]}>
      <header><h2>{panel==='preview'?selected?.name:panel==='delete'?'删除素材':panel==='delete-group'?'删除资产库':panel==='attach'?'加入资产库':panel==='new-group'?'新建资产库':panel==='rename'?'编辑素材':'导入链接'}</h2><button aria-label="关闭" onClick={close} disabled={busy}><X size={17}/></button></header>
      {panel==='preview'&&selected?<><Media asset={selected} full/>{selected.collection==='roles'&&<CharacterProfileDetail id={selected.id}/>}<footer><a href={selected.url+'?download=1'}>下载</a><button onClick={()=>{show('');onUse(selected);}}>用于创作</button></footer></>:panel==='attach'?<>{groups.map(g=><button key={g.id} disabled={busy} onClick={()=>void run(async()=>{await api('/api/commerce/v1/asset-groups/'+g.id+'/attach-assets',{assetIds:ids});refreshGroups(v=>v+1);setBatch(false);setIds([]);show('');})}>{g.name}</button>)}{!groups.length&&<p>先新建一个资产库，再加入所选素材。</p>}</>:<form onSubmit={e=>{e.preventDefault();void run(submit);}}>
      {(panel==='new-group'||panel==='rename')&&<label>{panel==='new-group'?'资产库名称':'名称'}<input autoFocus required placeholder={panel==='new-group'?'例如：品牌虚拟人像 / 主播授权库':undefined} value={name} maxLength={panel==='rename'?80:60} onChange={e=>rename(e.target.value)}/></label>}
      {panel==='new-group'&&<fieldset className="cs-asset-types"><legend>资产库类型</legend><div className="cs-type-choices">{['普通','虚拟人','真人'].map(value=><label key={value}><input type="radio" name="assetGroupType" checked={groupKind===value} onChange={()=>setGroupKind(value)}/>{value}</label>)}</div></fieldset>}
      {panel==='import'&&<><select aria-label="导入素材类型" value={importKind} onChange={e=>setImportKind(e.target.value)}><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select><input required type="url" aria-label="公开 HTTPS 素材地址" placeholder="公开 HTTPS 素材地址" value={importUrl} onChange={e=>setUrl(e.target.value)}/></>}
      {(panel==='delete'||panel==='delete-group')&&<p>确认删除「{selected?.name||current?.name}」？</p>}<footer><button type="button" onClick={close} disabled={busy}>取消</button><button disabled={busy}>{panel.startsWith('delete')?'删除':panel==='new-group'?'创建资产库':'保存'}</button></footer></form>}{error&&<p role="alert">{error}</p>}</dialog>}</main>;
}
