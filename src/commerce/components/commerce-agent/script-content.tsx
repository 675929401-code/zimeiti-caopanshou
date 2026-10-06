'use client';
import {memo} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Keep the original string for copy/apply; this component only presents it.
export const ScriptContent=memo(function ScriptContent({text}:{text:string}){
 return <div className="ca-script-content"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
  table:({children})=><div className="ca-script-table" tabIndex={0}><table>{children}</table></div>,
  a:({href,children})=>href?<a href={href} target="_blank" rel="noopener noreferrer">{children}</a>:<span>{children}</span>,
  img:({alt})=><span className="ca-script-reference">{alt||'参考图片'}</span>,
 }}>{text}</Markdown></div>;
});
