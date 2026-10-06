'use client';
import {useLayoutEffect,useRef,type ReactNode} from 'react';

// Keeps the existing native textarea, refs, onPaste and reference document untouched.
export function ImagePromptLine({enabled,skill,children}:{enabled:boolean;skill?:ReactNode;children:ReactNode}) {
  const root=useRef<HTMLDivElement>(null),chip=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const node=root.current,leading=chip.current,textarea=node?.querySelector('textarea');
    if(!enabled||!node||!textarea)return;
    const measure=()=>node.style.setProperty('--ca-image-chip-indent',leading?`${Math.ceil(leading.getBoundingClientRect().width)+8}px`:'0px');
    const scroll=()=>{if(leading){leading.style.transform=`translateY(-${textarea.scrollTop}px)`;leading.style.visibility=textarea.scrollTop>=24?'hidden':'visible';}};
    measure();scroll();const observer=new ResizeObserver(measure);if(leading)observer.observe(leading);observer.observe(node);
    textarea.addEventListener('scroll',scroll);return()=>{observer.disconnect();textarea.removeEventListener('scroll',scroll);};
  },[enabled,skill]);
  if(!enabled)return <>{children}</>;
  return <div className="ca-image-prompt-line" ref={root}>{skill&&<div className="ca-image-leading-skill" ref={chip}>{skill}</div>}{children}</div>;
}
