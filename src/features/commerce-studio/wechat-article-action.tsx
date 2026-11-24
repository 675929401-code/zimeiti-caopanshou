'use client';

import {useRef,useState} from 'react';
import {api} from '@/commerce/components/commerce-agent/runtime-ui';

const formats={
  guide:{name:'方法教程',heading:'怎么做',intro:'可以从下面的步骤入手。',closing:'实际操作时，可以按上面的步骤逐项核对，再根据自己的情况调整。'},
  experience:{name:'体验记录',heading:'有哪些细节值得看',intro:'下面从实际关心的几个细节说起。',closing:'回到使用场景，最值得保留的，是适合自己需要的做法。'},
  event:{name:'活动介绍',heading:'参与前要知道什么',intro:'参加之前，可以先把几件事弄清楚。',closing:'准备参加的读者，可以对照上面的安排确认自己的计划。'},
} as const;
type Format=keyof typeof formats;
type Asset={name:string;url:string};

function compose(topic:string,audience:string,points:string,format:Format){
  const preset=formats[format],subject=topic.trim();
  const sections=points.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map((line,index)=>{
    const split=line.search(/[：:]/);
    if(split>0&&split<42&&split<line.length-1)return '## '+line.slice(0,split).trim()+'\n\n'+line.slice(split+1).trim();
    return '## '+(format==='guide'?'步骤':format==='event'?'安排':'观察')+' '+(index+1)+'\n\n'+line;
  });
  return ['# '+subject+'：'+preset.heading,(audience.trim()?'如果你是'+audience.trim()+'，':'关于'+subject+'，')+preset.intro,...sections,'## 写在最后',preset.closing].join('\n\n');
}

export function WechatArticleAction(){
  const [topic,setTopic]=useState(''),[audience,setAudience]=useState(''),[points,setPoints]=useState('');
  const [format,setFormat]=useState<Format>('guide'),[draft,setDraft]=useState(''),[saved,setSaved]=useState<Asset|null>(null);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');const lock=useRef(false);
  function edit(text:string){setDraft(text);setSaved(null);setNotice('');}
  async function save(){
    if(lock.current||!draft.trim())return;
    lock.current=true;setBusy(true);setNotice('');
    try{
      const title=draft.split(/\r?\n/).find(line=>line.trim())?.replace(/^#+\s*/,'').trim()||topic.trim();
      const result=await api<{asset:Asset}>('/api/commerce/studio/markdown-word',{name:title,text:draft});
      setSaved(result.asset);
    }catch(error){setNotice((error as Error).message);}
    finally{lock.current=false;setBusy(false);}
  }
  return <div className="cs-word-actions cs-wechat-offline" aria-label="公众号文章草稿">
    <fieldset disabled={busy}><label>文章主题<input maxLength={100} value={topic} onChange={e=>setTopic(e.target.value)}/></label>
      <label>读者（可选）<input maxLength={80} value={audience} onChange={e=>setAudience(e.target.value)}/></label>
      <label>文章类型<select value={format} onChange={e=>setFormat(e.target.value as Format)}>{(Object.keys(formats) as Format[]).map(k=><option key={k} value={k}>{formats[k].name}</option>)}</select></label>
      <label>文章要点<textarea rows={3} maxLength={12000} value={points} placeholder="每行一节，可按「小标题：已确认的事实或步骤」填写" onChange={e=>setPoints(e.target.value)}/></label>
      <button type="button" disabled={!topic.trim()||!points.trim()} onClick={()=>edit(compose(topic,audience,points,format))}>{draft?'按要点重新排稿':'生成图文草稿'}</button>
    </fieldset>
    {draft!==''&&<><label>草稿正文<textarea rows={7} maxLength={32000} value={draft} disabled={busy} onChange={e=>edit(e.target.value)}/></label>
      <button type="button" disabled={busy||!draft.trim()} onClick={()=>void save()}>{busy?'正在保存…':'保存到资产库并导出 Word'}</button>
    </>}
    {saved&&<a href={saved.url+'?download=1'} download={saved.name}>下载文章 Word 稿</a>}
    {notice&&<span role="status">{notice}</span>}
  </div>;
}
