'use client';
// 保持已有分组顺序，并显示后台目录中新增的分组。
import {PanelLeftClose,PanelLeftOpen} from 'lucide-react';
import {DIRECTOR_GROUPS} from './catalog';

export type DirectorNavCard={key:string;name:string;description:string;category:string;icon?:string;default?:boolean};
const GROUP_ORDER=Object.keys(DIRECTOR_GROUPS);

export function DirectorNav({cards,activeKey,collapsed,onToggle,onPick,issue,onRetry}:{cards:DirectorNavCard[];activeKey:string;collapsed:boolean;onToggle:()=>void;onPick:(key:string)=>void;issue:string;onRetry:()=>void}){
  if(collapsed)return <aside className="ca-director-nav ca-director-nav-collapsed" aria-label="AI 视频编导导航（已收起）"><button type="button" className="ca-director-nav-toggle" title="展开 AI 视频栏" aria-label="展开 AI 视频栏" aria-expanded={false} onClick={onToggle}><PanelLeftOpen size={18}/></button></aside>;
  const visible=cards.filter(card=>!card.default);
  const categoryOrder = new Set([...GROUP_ORDER, ...visible.map(card => card.category)]);
  const groups = [...categoryOrder]
    .map(name => ({ name, items: visible.filter(card => card.category === name) }))
    .filter(group => group.items.length);
  return <aside className="ca-director-nav" aria-label="AI 视频编导导航">
    <header><strong>AI 视频</strong><button type="button" className="ca-director-nav-toggle" title="收起 AI 视频栏" aria-label="收起 AI 视频栏" aria-expanded onClick={onToggle}><PanelLeftClose size={18}/></button></header>
    <div className="ca-director-nav-body">
      {issue&&<p role="status">{issue} <button type="button" onClick={onRetry}>重新读取</button></p>}
      {groups.map(group=><section key={group.name} aria-label={group.name}><h3>{group.name}</h3><ul>{group.items.map(card=><li key={card.key}><button type="button" className={activeKey===card.key?'active':''} aria-current={activeKey===card.key?'page':undefined} data-director-key={card.key} onClick={()=>onPick(card.key)}>{card.icon?<img src={card.icon} alt="" loading="lazy"/>:<span className="ca-director-nav-thumb"/>}<span><strong>{card.name}</strong><small>{card.description}</small></span></button></li>)}</ul></section>)}
    </div>
  </aside>;
}
