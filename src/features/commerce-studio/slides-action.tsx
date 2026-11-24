'use client';
import {useRef,useState} from 'react';
import {api} from '@/commerce/components/commerce-agent/runtime-ui';

const example={title:'新品试用复盘',slides:[
  {type:'text',title:'试用反馈',points:['整理买家的使用场景','确认最常被提及的产品特点']},
  {type:'table',title:'试用安排',rows:[['渠道','人数'],['门店',12],['线上',18]]},
  {type:'chart',title:'每周试用人数',chart:'bar',labels:['第一周','第二周'],series:[{name:'人数',values:[12,18]}]},
  {type:'timeline',title:'下一轮计划',steps:[{date:'周一',label:'收集反馈'},{date:'周五',label:'复盘并确认下一轮安排'}]},
]};
type Export={asset:{url:string;name:string};pages:number};
export function SlidesAction(){
  const [source,setSource]=useState(''),[error,setError]=useState(''),[result,setResult]=useState<Export|null>(null),[busy,setBusy]=useState(false);
  const lock=useRef(false);
  function change(text:string){setSource(text);setResult(null);setError('');}
  async function create(){
    if(lock.current)return;
    lock.current=true;setBusy(true);setResult(null);setError('');
    try{
      let spec;try{spec=JSON.parse(source);}catch{throw Error('JSON 格式有误，请检查引号、逗号和括号');}
      setResult(await api<Export>('/api/commerce/studio/slides',spec));
    }catch(e){setError((e as Error).message);}
    finally{lock.current=false;setBusy(false);}
  }
  return <div className="cs-word-actions cs-slides-action" aria-label="PPT 演示文稿">
    <label>演示稿 JSON<textarea value={source} rows={6} maxLength={100000} disabled={busy} onChange={e=>change(e.target.value)} placeholder="粘贴含标题和页面的 JSON，或载入可修改的四页示例"/></label>
    <button type="button" disabled={busy} onClick={()=>change(JSON.stringify(example,null,2))}>载入四页示例</button>
    <button type="button" disabled={busy||!source.trim()} onClick={()=>void create()}>{busy?'正在生成…':'生成并保存 PPTX'}</button>
    {result&&<a href={result.asset.url+'?download=1'} download={result.asset.name}>下载可编辑 PPTX（{result.pages} 页）</a>}
    {error&&<span role="alert">{error}</span>}
  </div>;
}
