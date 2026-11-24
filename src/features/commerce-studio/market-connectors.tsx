'use client';
import {useEffect,useRef,useState} from 'react';
import {MoreHorizontal,Plus,Search,X} from 'lucide-react';
import {api} from '@/commerce/components/commerce-agent/runtime-ui';

type Connector={id:string;name:string;url:string};
const services=[{name:'钉钉',icon:'/commerce/dingtalk-mark.png',description:'连接钉钉团队的工作内容与协作应用。'},{name:'飞书',icon:'/commerce/feishu-mark.png',description:'连接飞书或 Lark 工作空间中的文档与协作工具。'}];
export function MarketConnectors({query}:{query:string}){
  const [panel,show]=useState(()=>{const service=typeof window==='undefined'?'':new URLSearchParams(window.location.search).get('service');return services.find(s=>s.name===service)?.name||''}),[adding,setAdding]=useState(false),[filter,search]=useState(''),[name,setName]=useState(''),[url,setUrl]=useState('');
  const [items,setItems]=useState<Connector[]>([]),[problem,report]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[reads,reload]=useState(0);
  const dlg=useRef<HTMLDialogElement>(null),inFlight=useRef(false);
  useEffect(()=>{if(!panel)return;const el=dlg.current!;el.showModal();return ()=>el.close();},[panel]);
  useEffect(()=>{if(panel!=='custom')return;let live=true;setLoading(true);report('');
    api<Connector[]>('/api/commerce/studio/connectors').then(data=>{if(live)setItems(data);}).catch(e=>{if(live)report(e.message);}).finally(()=>{if(live)setLoading(false);});return ()=>{live=false;};
  },[panel,reads]);
  function close(){if(!inFlight.current){show('');setAdding(false);search('');setName('');setUrl('');report('');}}
  async function save(){
    if(inFlight.current)return;inFlight.current=true;setBusy(true);report('');
    try{const result=await api<Connector[]>('/api/commerce/studio/connectors',{name:name.trim(),url:url.trim()});setItems(result);setAdding(false);setName('');setUrl('');}
    catch(e){report((e as Error).message);}finally{inFlight.current=false;setBusy(false);}
  }
  const selectedService=services.find(service=>service.name===panel);
  const filtered=services.filter(s=>(s.name+s.description).includes(query.trim()));
  return <><form id="cs-custom-connector-launch" onSubmit={e=>{e.preventDefault();show('custom');}}/>
    <div className="cs-market-grid">{filtered.map(s=><article key={s.name} className="cs-market-card"><img className="cs-connector-glyph" src={s.icon} width={48} height={48} alt=""/>
      <button className="cs-market-info" aria-label={'查看 '+s.name+' 详情'} onClick={()=>show(s.name)}><strong>{s.name}</strong><small>{s.description}</small></button>
      <button className="cs-market-action" aria-label={'连接 '+s.name} onClick={()=>show(s.name)}><span className="cs-connector-switch"/></button></article>)}{!filtered.length&&<p>没有匹配的连接器</p>}</div>
    {panel&&<dialog ref={dlg} className={'cs-connector-dialog '+(panel==='custom'?'cs-custom-connectors':'cs-service-dialog')} aria-label={panel==='custom'?'自定义连接器':'连接 '+panel} onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target!==dlg.current)return;const r=dlg.current.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}}>
      <button className="cs-connector-close" aria-label="关闭" disabled={busy} onClick={close}><X size={16}/></button>{panel==='custom'?<><h2>自定义连接器</h2><p>管理 Agent 的公开 HTTPS MCP 服务地址。</p>
      <div className="cs-connector-tools"><label><Search size={16}/><input aria-label="搜索自定义连接器" placeholder="搜索自定义连接器" value={filter} onChange={e=>search(e.target.value)}/></label><button onClick={()=>setAdding(true)}><Plus size={15}/> 添加</button></div>
      {adding&&<form className="cs-connector-form" onSubmit={e=>{e.preventDefault();void save();}}><label>名称<input required maxLength={60} placeholder="例如：团队知识库" value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>MCP URL<input required type="url" maxLength={1024} placeholder="https://example.com/mcp" value={url} onChange={e=>setUrl(e.target.value)}/></label><footer><button type="button" disabled={busy} onClick={()=>setAdding(false)}>取消</button><button className="cs-market-dark" disabled={busy||loading||!name.trim()||!url.trim()}>保存</button></footer></form>}
      {loading?<p role="status">正在读取…</p>:items.filter(i=>(i.name+i.url).includes(filter.trim())).map(i=><div key={i.id} className="cs-connector-record"><strong>{i.name}</strong><small>{i.url}</small><span>已保存地址 · 未连接</span></div>)}
      {!loading&&!problem&&!items.some(i=>(i.name+i.url).includes(filter.trim()))&&<p className="cs-market-empty">{filter?'没有匹配的连接器':'暂无自定义连接器'}</p>}{problem&&<p role="alert">{problem} <button onClick={()=>reload(v=>v+1)}>重新读取</button></p>}</>:selectedService&&<><div className="cs-connector-identities" aria-hidden="true"><img src="/brand/platform-logo-display-256.webp" alt=""/><MoreHorizontal size={28}/><img src={selectedService.icon} alt=""/></div><h2>连接 {selectedService.name}</h2><p>{selectedService.description}<br/>本站尚未配置此服务的授权。</p><button className="cs-market-dark" disabled>连接</button></>}</dialog>}</>;
}
