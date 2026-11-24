'use client';
import {SceneReplayEditor} from './scene-replay-editor';
import {useState} from 'react';
import type {ScenePromptEntry} from '@/commerce/shared/scene-prompt-workbench';
import './scene-prompt-workbench.css';
type Row=Record<string,unknown>;
type Props={models:{id:string;displayName:string;available?:boolean;sourceVideoProfile?:string|null}[];token:string;entries:ScenePromptEntry[];versions:Row[];release:number;canEdit:boolean;save:(row:ScenePromptEntry,content:string)=>Promise<Row>};

const navigation=[
 ['首页','分发需求到所选创作工具，首页输入沿用目标工具的提示词。'],
 ['Agent','多轮创作读取当前会话；执行图片或视频时再调用对应工具。'],
 ['AI 视频','场景编导拆解脚本，确认后交给视频生成。帮我写、创意复刻和商详各有独立步骤。'],
 ['AI 图片','按所选图片技能绑定参考槽位及输出要求。'],
 ['画布','文字、图片与视频节点分别调用对应能力；四项专用图片技能单列。普通连线、保存与回放在本地逻辑处理。'],
 ['资产','上传、收藏、查找和下载使用素材库。'],
 ['展开或收起场景栏','改变导航状态。'],
 ['创作技能','内置卡跳转到同一个执行入口；会员自建技能使用本人保存的说明。']
] as const;
const groupNames=['视频场景','图片场景','画布专用','共用能力'] as const;
export function ScenePromptWorkbench({entries,models,versions,release,canEdit,save,token}:Props){
 const [group,setGroup]=useState<ScenePromptEntry['group']>('视频场景'),[search,setSearch]=useState(''),[id,setId]=useState('');
 const [edits,setEdits]=useState<Record<string,string>>({}),[saving,setSaving]=useState(false),[notice,setNotice]=useState('');
 const [saved,setSaved]=useState<Record<string,Row>>({});
 const visible=entries.filter(e=>e.group===group&&[e.name,e.category,e.operation].some(s=>s.toLowerCase().includes(search.trim().toLowerCase())));
 const row=visible.find(e=>e.id===id)||visible[0];
 const draft=row?[...versions,...Object.values(saved)].filter(v=>v.prompt_key===row.key&&v.status==='draft').sort((a,b)=>Number(b.version)-Number(a.version))[0]:undefined;
 const value=row?(edits[row.id]??(draft?String(draft.content):row.proposed)):'';
 function edit(text:string){if(row){setEdits(prev=>({...prev,[row.id]:text}));setNotice('');}}
 async function persist(){
  if(!row||!canEdit||!value.trim()||saving)return;
  const entry=row;setSaving(true);setNotice('');
  try{
   const same=versions.concat(Object.values(saved)).find(v=>v.prompt_key===entry.key&&v.status==='draft'&&v.content===value.trim());
   const result=same||await save(entry,value.trim());
   setSaved(prev=>({...prev,[entry.key]:result}));setNotice(entry.name+' · 草稿 v'+result.version+' 已保存。');
  }catch(e){setNotice((e as Error).message);}finally{setSaving(false);}
 }
 return <section className="cs-prompt-lab" aria-label="场景提示词工作台"><header><h2>场景提示词</h2><p>从教程、会员可见示例和输出样本反推的本站规则。编辑后保存为草稿，发布版本由「发布与回滚」管理。</p></header>
 <details className="cs-prompt-nav"><summary>左侧八个导航入口与实际调用</summary><dl>{navigation.map(([n,description])=><div key={n}><dt>{n}</dt><dd>{description}</dd></div>)}</dl></details>
 <div className="cs-prompt-groups" aria-label="场景类型">{groupNames.map(g=><button type="button" key={g} aria-pressed={g===group} onClick={()=>{setGroup(g);setId('');setSearch('');setNotice('');}}>{g} · {entries.filter(e=>e.group===g).length}</button>)}</div>
 <div className="cs-prompt-layout"><aside><input type="search" aria-label="搜索场景提示词" placeholder="搜索卡片或操作" value={search} onChange={e=>setSearch(e.target.value)}/><nav aria-label="可配置的提示词">{visible.map(e=><button key={e.id} type="button" aria-current={row?.id===e.id?'true':undefined} onClick={()=>{setId(e.id);setNotice('');}}>{e.name}<small>{e.category}</small></button>)}</nav></aside>
 {row?<article key={row.id}><header><h3>{row.name}</h3><p>执行操作 <code>{row.operation}</code>　{row.effectiveVersion}　配置 v{release||'—'}</p></header>
 <section aria-label="生产调用链"><h4>生产调用链</h4><p>当前场景规则 <code>{row.key}</code> · {row.effectiveVersion}</p>{row.calls?.map(step=><details key={step.id} open={step.id===row.operation}><summary>{step.label} · {step.kind==='agent'?'分析与编导模型':step.kind==='image'?'出图模型':step.kind==='video'?'视频模型':'缺少绑定'}</summary><dl className="cs-call-chain"><dt>发起条件</dt><dd>{step.when}</dd><dt>输入</dt><dd>{step.input}</dd><dt>交付结果</dt><dd>{step.output}</dd><dt>发布路由</dt><dd><code>{step.id}</code> · {step.revision?'v'+step.revision:'尚未配置'}</dd><dt>主模型</dt><dd>{models.find(m=>m.id===step.primary)?.displayName||step.primary||'按模型选择策略解析'}</dd>{step.fallbacks.length>0&&<><dt>候选模型</dt><dd>{step.fallbacks.map(id=>models.find(m=>m.id===id)?.displayName||id).join('、')}</dd></>}{step.id==='depth-video-clone.generate'&&<><dt>原片能力</dt><dd>{models.some(m=>m.available!==false&&[step.primary,...step.fallbacks].includes(m.id)&&m.sourceVideoProfile)?'发布路由中有支持原片参考、替换图与声音开关的候选，生成时还会核对专项验收。':'当前发布路由缺少可用的原片参考候选，请在模型路由中配置并完成专项验收。'}</dd></>}<dt>选择方式</dt><dd>{step.selectable?'在该操作允许的模型范围内选择':'按发布路由绑定'}，以该次任务报价和快照为准。</dd><dt>步骤</dt><dd>{step.stages.join(' → ')}</dd></dl></details>)}</section>
 <section><h4>取证与验收</h4><p>{row.teacher}</p>{row.guide.length>0&&<p>会员引导 · {row.guide.join(' / ')}</p>}{row.evidence.map(line=><p key={line}>{line}</p>)}
 {row.example&&<div className="cs-prompt-examples">{row.example.images.map((src,i)=><a href={src} key={src} target="_blank" rel="noreferrer"><img src={src} alt={row.example!.title+' '+(i+1)}/></a>)}</div>}
 {row.sample&&<details><summary>查看历史输出依据</summary><p>{row.sample.observed}</p><p>{row.sample.file}</p><code>{row.sample.sha256}</code></details>}
 {row.auxiliaryTrial&&<details><summary>{row.auxiliaryTrial.title}</summary><p>{row.auxiliaryTrial.input}</p><p>{row.auxiliaryTrial.status}</p><p>{row.auxiliaryTrial.observed}</p>{row.auxiliaryTrial.picture&&<div className="cs-prompt-examples">{row.auxiliaryTrial.sourcePicture&&<figure><img src={row.auxiliaryTrial.sourcePicture} alt="本轮输入原图"/><figcaption>输入原图</figcaption></figure>}<figure><img src={row.auxiliaryTrial.picture} alt="本轮实测结果"/><figcaption>实测结果</figcaption></figure></div>} {row.auxiliaryTrial.reply&&<pre>{row.auxiliaryTrial.reply}</pre>}</details>}
 {row.trials?.length?<details><summary>本轮对标实测 · {row.trials.length} 次回复</summary><p>{row.trials.every(t=>t.costBasis==='balance-delta')?'会员实测，目标 15 秒。积分取自每次提交前后刷新后的余额差。':'输入商品为橙色左侧线圈本，中文，目标 15 秒。积分为各次回复后会话显示的累计值。'}</p>
 <div className={row.trials.length>1?'cs-prompt-trial-pair':''}>{row.trials.map(t=><section key={t.variant} className="cs-prompt-trial"><h4>{t.label||(t.variant==='A'?'首次提交':'同会话局部改稿')}</h4>{t.referenceName&&<p>参考物件 · {t.referenceName}</p>}<p>{t.input}</p><p>{t.shots} 镜 · {t.continuous?'时间轴连续到 15 秒':'时间轴待核'} · {t.cost.toFixed(2)} 积分 · {t.apply?'已出现应用脚本':'等待补充输入'}</p><pre>{t.reply}</pre></section>)}</div>
 {row.id==='video/advertising-brand-story'&&row.trials.length>1&&<p>逐镜比较：第一、四镜正文相同。第二镜改成沿线圈移动的近景，第三镜同步移除了依赖上一镜的「折叠后」；四个时间段均保留。</p>}</details>:null}
 <SceneReplayEditor key={row.id} sceneId={row.id} token={token} canEdit={canEdit}/>
 <p><b>单项改动验收</b>　{row.test}</p></section>
 <details><summary>查看当前执行正文、模型与步骤</summary><p>{row.key} · {row.model||'按当前模型选择策略'}</p><p>{row.stages.join(' → ')}</p><pre>{row.effective||'当前未解析到有效提示词。'}</pre>{row.executorPrompt&&<details><summary>共用编导基础正文 v{row.executorPrompt.version}</summary><pre>{row.executorPrompt.content}</pre></details>}</details>
 <section><h4>反推提示词草稿</h4><p>{edits[row.id]!==undefined?'编辑中的正文':draft?'已载入草稿 v'+draft.version:'已载入反推方案'} · 配置键 <code>{row.key}</code></p>
 <div className="cs-prompt-actions"><button type="button" disabled={saving} onClick={()=>edit(row.proposed)}>载入反推方案</button>{draft&&<button type="button" disabled={saving} onClick={()=>edit(String(draft.content))}>载入已存草稿 v{String(draft.version)}</button>}</div>
 <textarea aria-label={row.name+'反推提示词'} value={value} readOnly={!canEdit} onChange={e=>edit(e.target.value)} spellCheck={false} maxLength={50000}/>
 {canEdit&&<button type="button" className="cs-prompt-save" disabled={saving||!value.trim()} onClick={()=>void persist()}>{saving?'保存中…':'保存为新草稿'}</button>}
 {notice&&<p role="status">{notice}</p>}</section></article>:<p>没有匹配的场景。</p>}</div></section>;
}
