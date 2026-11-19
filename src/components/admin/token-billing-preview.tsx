"use client";
import {useState} from "react";

type Props = {token?: string; input: string; cache: string; output: string; margin: string};

export function TokenBillingPreview({token,input,cache,output,margin}: Props) {
  const [sample,setSample] = useState({prompt: "1000",hit: "400",completion: "200"});
  const [result,setResult] = useState({key: "", text: ""});
  const [busy,setBusy] = useState(false);
  const query = new URLSearchParams({input,cache,output,margin,...sample}).toString();
  async function preview() {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/billing-preview?"+query,{headers: {Authorization: "Bearer "+token},cache: "no-store",signal: AbortSignal.timeout(10000)});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "当前无法试算");
      setResult({key: query,text: `上游成本 ¥${data.cost}，售价 ¥${data.sale}，按 1 元兑换 ${data.creditsPerYuan} 积分，本次模型用量扣 ${data.credits} 积分。`});
    } catch(error) {
      setResult({key: query,text: error instanceof Error ? error.message : "当前无法试算"});
    } finally { setBusy(false); }
  }
  return <details className="rounded-lg border p-3 text-sm"><summary>按用量试算积分</summary>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      {([["prompt","总输入 Token"],["hit","其中缓存命中"],["completion","输出 Token"]] as const).map(([field,label]) =>
        <label key={field} className="grid gap-1 text-xs">{label}<input type="number" min="0" step="1" value={sample[field]} onChange={event=>setSample({...sample,[field]:event.target.value})} className="w-28 rounded border p-2"/></label>)}
      <button type="button" className="rounded border px-3 py-2" disabled={busy || !token} onClick={()=>void preview()}>{busy ? "试算中…" : "试算"}</button>
    </div>
    {result.key === query && <p role="status" className="mt-2">{result.text}</p>}
  </details>;
}
