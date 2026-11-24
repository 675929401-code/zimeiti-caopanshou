'use client';

import {useEffect, useState} from 'react';
import {api} from './runtime-ui';
import {PromptAssist} from './prompt-assist';
import type {ComponentProps} from 'react';

export function ReferenceProjectEntry({initialProjectId,onBatch,approach='shots',...props}: Omit<ComponentProps<typeof PromptAssist>, 'id'> & {initialProjectId?:string;onBatch?:()=>void;approach?:'shots'|'original'}) {
  const [id, setId] = useState('');
  const [error, setError] = useState('');
  const [projects,setProjects]=useState<Array<{id:string;title:string;createdAt:number}>>([]);
  const [request,setRequest]=useState<{projectId?:string;newRequestId?:string}>(initialProjectId?{projectId:initialProjectId}:{});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    api<{session:{id:string};projects:typeof projects}>('/api/commerce/prompt-assist', {action:'open-reference',approach,...request})
      .then(data => { if (live) {setProjects(data.projects);setId(data.session.id);const url=new URL(window.location.href);url.searchParams.set('projectId',data.session.id);window.history.replaceState(window.history.state,'',url.pathname+url.search);} })
      .catch(reason => { if (live) setError(reason.message); });
    return () => { live = false; };
  }, [attempt,request,approach]);
  if (id) return <PromptAssist key={id} id={id} {...props} projectMenu={<><label>创作项目 <select aria-label="创作项目" value={id} onChange={e=>{const target=e.target.value;setId('');setRequest(target==='new'?{newRequestId:crypto.randomUUID()}:{projectId:target});}}>{projects.map((p,i)=><option key={p.id} value={p.id}>{projects.length-i} · {p.title}</option>)}<option value="new">＋ 新建项目</option></select></label>{onBatch&&<button type="button" onClick={onBatch}>批量剪辑</button>}</>}/>;
  return <div className="ca-assist-overlay"><section className="ca-assist-dialog" role="dialog" aria-label="参考视频拆解"><header><strong>参考视频拆解</strong><button onClick={props.onClose}>关闭</button></header><main>
    {error ? <><p role="alert">{error}</p><button onClick={() => setAttempt(n => n + 1)}>重新读取</button></> : <p role="status">正在读取参考视频项目…</p>}
  </main></section></div>;
}
