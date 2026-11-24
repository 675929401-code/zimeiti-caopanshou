'use client';
import { useRef, useState } from 'react';

type Source = {id:string; file:File; count:number; pages:string};
type Result = {asset:{name:string; url:string}; pages:number};

async function submit(form:FormData) {
  const response = await fetch('/api/commerce/studio/pdf-pages',{method:'POST',body:form});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'PDF 处理失败');
  return data;
}

export function PdfPagesAction() {
  const [sources, setSources] = useState<Source[]>([]);
  const [name, setName] = useState('整理文档');
  const [result, setResult] = useState<Result|null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  function change(next:Source[]) { setSources(next); setResult(null); setError(''); }
  function move(index:number, delta:number) {
    const next = [...sources], other = index + delta;
    [next[index],next[other]] = [next[other],next[index]];
    change(next);
  }
  async function inspect(files:File[]) {
    if (!files.length || lock.current) return;
    lock.current=true; setBusy(true); setError(''); setResult(null);
    try {
      if (sources.length+files.length>12||[...sources.map(s=>s.file),...files].reduce((n,f)=>n+f.size,0)>24*1024*1024) throw Error('每次可处理 1 至 12 份 PDF，合计最多 24 MB');
      const form=new FormData(); form.set('action','inspect');
      files.forEach(f=>form.append('file',f));
      const counts:number[]=(await submit(form)).pages;
      setSources(current=>[...current,...files.map((file,i)=>({id:crypto.randomUUID(),file,count:counts[i],pages:''}))]);
    } catch (e) { setError((e as Error).message); }
    finally { lock.current=false; setBusy(false); }
  }
  async function exportFile() {
    if (!sources.length || lock.current) return;
    lock.current=true; setBusy(true); setError(''); setResult(null);
    try {
      const form=new FormData(); form.set('action','export'); form.set('name',name);
      for(const source of sources) { form.append('file',source.file); form.append('pages',source.pages); }
      setResult(await submit(form));
    } catch (e) { setError((e as Error).message); }
    finally { lock.current=false; setBusy(false); }
  }
  return <section className="cs-pdf-pages" aria-label="整理 PDF 页面">
    <fieldset disabled={busy}><label>添加 PDF <input type="file" multiple accept="application/pdf,.pdf" onChange={e=>{void inspect(Array.from(e.target.files||[]));e.target.value='';}}/></label>
    {sources.length>0&&<><p>留空保留全部页面。输入 3,1-2 可按指定顺序提取并合并。</p>
    <ol>{sources.map((source,i)=><li key={source.id}>
      <strong>{source.file.name}</strong><small>{source.count} 页</small>
      <input aria-label={source.file.name+' 的页序'} value={source.pages} placeholder="全部页" onChange={e=>change(sources.map(s=>s.id===source.id?{...s,pages:e.target.value}:s))}/>
      <button type="button" aria-label={'上移 '+source.file.name} disabled={i===0} onClick={()=>move(i,-1)}>上移</button>
      <button type="button" aria-label={'下移 '+source.file.name} disabled={i===sources.length-1} onClick={()=>move(i,1)}>下移</button>
      <button type="button" aria-label={'移除 '+source.file.name} onClick={()=>change(sources.filter(s=>s.id!==source.id))}>移除</button>
    </li>)}</ol>
    <label>文件名 <input aria-label="PDF 文件名" value={name} maxLength={100} onChange={e=>{setName(e.target.value);setResult(null);}}/></label>
    <button type="button" onClick={()=>void exportFile()}>导出 PDF</button></>}</fieldset>
    {busy&&<span role="status">正在处理 PDF…</span>}
    {error&&<span role="alert">{error}</span>}
    {result&&<a download={result.asset.name} href={result.asset.url+'?download=1'}>下载 {result.asset.name}（{result.pages} 页）</a>}
  </section>;
}
