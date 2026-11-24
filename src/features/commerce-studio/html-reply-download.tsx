'use client';
import {memberHtmlDocument} from '@/commerce/shared/member-html';
export function HtmlReplyDownload({text,id}:{text:string;id:string}) {
  const source=memberHtmlDocument(text);
  if (!source) return null;
  function download() {
    const url=URL.createObjectURL(new Blob([source!],{type:'application/octet-stream'}));
    const link=document.createElement('a');
    link.href=url;link.download='网页-'+id.slice(0,8)+'.html';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  return <button type="button" onClick={download}>下载独立 HTML 网页</button>;
}
