'use client';
import {useRef,useState} from 'react';
import {documentExtensions,memberDocumentActions,type MemberDocumentSkill} from '@/commerce/shared/member-documents';

type Report={text:string;region?:string;sheets?:string[];sheet?:string;asset?:{name:string;url:string};error?:string};
export function MemberDocumentAction({kind,onAnalyze}:{kind:MemberDocumentSkill;onAnalyze:(sample:string)=>void}){
  const actions=Object.entries(memberDocumentActions[kind]);
  const [action,choose]=useState(actions[0][0]),[file,setFile]=useState<File>(),[name,setName]=useState('');
  const [content,setContent]=useState(''),[find,setFind]=useState(''),[paragraph,setParagraph]=useState('1');
  const [sheet,setSheet]=useState(''),[sheets,setSheets]=useState<string[]>([]),[range,setRange]=useState('');
  const [first,setFirst]=useState('1'),[last,setLast]=useState('1'),[format,setFormat]=useState('txt'),[url,setUrl]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[report,setReport]=useState<Report>();
  const lock=useRef(false);
  async function run(){
    if(lock.current)return;
    lock.current=true;setBusy(true);setError('');setReport(undefined);
    try{
      const data=new FormData();
      for(const [key,value] of Object.entries({kind,action,name,content,find,paragraph,sheet,range,first,last,format,url}))data.set(key,value);
      if(file && action!=='url')data.set('file',file);
      const res=await fetch('/api/commerce/studio/member-documents',{method:'POST',body:data});
      const result:Report=await res.json();
      if(!res.ok)throw Error(result.error||'操作失败');
      setReport(result);
      if(result.sheets){setSheets(result.sheets);setSheet(result.sheet||'');}
    }catch(e){setError(e instanceof Error?e.message:'文件处理失败');}
    finally{lock.current=false;setBusy(false);}
  }
  const excel=kind==='spreadsheets'||kind==='sheet-analysis';
  const hasOutput=kind==='wechat-docx'||kind==='pdf-ocr'||action!=='read';
  return <section className="cs-document-action" aria-label="文档工作区">
    <fieldset disabled={busy} onChange={()=>{setReport(undefined);setError('');}}>
      {actions.length>1&&<label>操作<select value={action} onChange={e=>choose(e.target.value)}>{actions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}
      {action==='url'?<label>公众号文章链接<input type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://mp.weixin.qq.com/s/…"/></label>:
      <label>源文件<input type="file" accept={documentExtensions[kind].map(x=>'.'+x).join(',')} onChange={e=>{const f=e.target.files?.[0];setFile(f);setName(f?.name.replace(/\.[^.]+$/,'')||'');setSheet('');setSheets([]);}}/></label>}
      {excel&&<>{sheets.length>0?<label>工作表<select value={sheet} onChange={e=>setSheet(e.target.value)}>{sheets.map(s=><option key={s}>{s}</option>)}</select></label>:<label>工作表<input value={sheet} placeholder="默认第一张" onChange={e=>setSheet(e.target.value)}/></label>}
      {action==='read'?<label>读取范围<input value={range} onChange={e=>setRange(e.target.value)} placeholder="如 A1:D20，默认前 30 行、12 列"/></label>:
      <label>单元格修改（JSON）<textarea value={content} onChange={e=>setContent(e.target.value)} placeholder={'{"A1":"销量","A2":8,"A3":12,"A4":"=SUM(A2:A3)"}'}/></label>}</>}
      {kind==='word-tools'&&action!=='read'&&<>{action==='replace'&&<label>查找原文<input value={find} onChange={e=>setFind(e.target.value)}/></label>}
      {action==='comment'&&<label>段落序号<input type="number" min={1} value={paragraph} onChange={e=>setParagraph(e.target.value)}/></label>}
      <label>{action==='comment'?'批注':action==='replace'?'替换为':'新段落'}<textarea value={content} onChange={e=>setContent(e.target.value)}/></label></>}
      {kind==='pdf-ocr'&&<><label>从第几页<input type="number" min={1} value={first} onChange={e=>setFirst(e.target.value)}/></label><label>至第几页<input type="number" min={first} value={last} onChange={e=>setLast(e.target.value)}/></label><label>导出格式<select value={format} onChange={e=>setFormat(e.target.value)}><option>txt</option><option>md</option><option>json</option></select></label></>}
      {hasOutput&&<label>输出文件名<input value={name} maxLength={92} onChange={e=>setName(e.target.value)} placeholder="文档"/></label>}
      <button type="button" onClick={()=>void run()}>{busy?'正在处理…':hasOutput?'生成文件':'读取内容'}</button>
    </fieldset>
    {error&&<p role="alert">{error}</p>}
    {report&&<><pre tabIndex={0}>{report.text}</pre>{report.asset&&<a href={report.asset.url+'?download=1'} download={report.asset.name}>下载 {report.asset.name}</a>}
      {kind==='sheet-analysis'&&report.text&&<button type="button" disabled={report.text.length>14500} title={report.text.length>14500?'请缩小范围再分析':undefined} onClick={()=>onAnalyze(report.text)}>将当前范围用于分析</button>}</>}
  </section>;
}
