'use client';

import {useEffect} from 'react';

export default function CommerceError({error,reset}:{error:Error&{digest?:string};reset:()=>void}){
  useEffect(()=>{
    window.dispatchEvent(new CustomEvent('client-error',{detail:{scope:'commerce',digest:error.digest||''}}));
  },[error]);
  return <div className="commerce-root" data-testid="commerce-error-boundary">
    <div className="ca-empty" role="alert">
      <p>带货 Agent 页面暂时没有完成加载，当前草稿仍保留在浏览器中。</p>
      <div className="ca-actions">
        <button type="button" onClick={reset}>重新加载工作台</button>
        <button type="button" onClick={()=>window.location.reload()}>刷新页面</button>
      </div>
    </div>
  </div>;
}
