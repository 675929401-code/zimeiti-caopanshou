'use client';
import { useCallback, useEffect, useState } from 'react';
import { UNCONFIGURED_MODEL_LABEL } from '@/commerce/shared/operation-model-mapping';
import type { PromptCardAdminItem } from '@/commerce/shared/prompt-card-registry';

const box = 'rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5';
const button = 'rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-2 text-sm font-medium hover:bg-[var(--accent)] disabled:opacity-50';

type CardsResponse = { ok?: boolean; items?: unknown; fieldNamesStatus?: string; error?: string };

function safeItems(value: unknown): PromptCardAdminItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PromptCardAdminItem => Boolean(item) && typeof item === 'object' && typeof (item as PromptCardAdminItem).cardId === 'string');
}

/** 纯展示：一张卡一行；不展开提示词正文；operationId 列只在管理后台出现。 */
export function PromptCardRegistryTable({ items }: { items: PromptCardAdminItem[] }) {
  if (!items.length) return <p className="mt-3 text-sm text-[var(--muted-foreground)]">暂无提示词卡片。</p>;
  return <div className="mt-3 max-h-[720px] overflow-auto"><table className="w-full text-left text-sm" data-testid="prompt-card-table"><thead><tr><th>卡片</th><th>板块</th><th>功能</th><th>提示词版本</th><th>sha256 前 8 位</th><th>品控状态</th><th>测试状态</th><th>放行</th><th data-admin-only="true">operationId（仅管理员）</th><th data-admin-only="true">id 状态</th><th>主模型</th></tr></thead><tbody>{items.map((item) => <tr key={item.cardId} className="border-t border-[var(--border)]" data-card-id={item.cardId}><td className="py-2 font-mono text-xs">{item.cardId}</td><td>{item.section}</td><td>{item.featureName}</td><td>{item.prompt.exists ? item.prompt.version : '无'}</td><td className="font-mono text-xs">{item.prompt.sha8 || '—'}</td><td title={item.qcSource}>{item.qcStatusDisplay}</td><td>{item.testStatus}</td><td>{item.releaseStatus}</td><td className="font-mono text-xs" data-admin-only="true">{item.mount.operationIds.length ? item.mount.operationIds.join('、') : item.mount.match}</td><td data-admin-only="true">{item.mount.idStatus}</td><td>{item.mount.configured ? <span className="font-mono text-xs">{item.mount.displayModel}</span> : <span className="text-[var(--muted-foreground)]">{UNCONFIGURED_MODEL_LABEL}</span>}</td></tr>)}</tbody></table></div>;
}

/** 管理员只读面板：提示词卡片登记。读取失败只提示，不抛错；本面板不提供编辑、开跑或付费按钮。 */
export function PromptCardRegistryPanel({ token }: { token: string }) {
  const [items, setItems] = useState<PromptCardAdminItem[]>([]);
  const [notice, setNotice] = useState('正在读取提示词卡片…');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/admin/commerce/prompt-cards', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as CardsResponse;
      if (!response.ok || data.ok !== true) { setItems([]); setNotice(data.error || `读取失败（HTTP ${response.status}）`); return; }
      setItems(safeItems(data.items));
      setNotice(data.fieldNamesStatus ? `字段名：${data.fieldNamesStatus}` : '');
    } catch {
      setItems([]); setNotice('提示词卡片暂不可读取。');
    } finally { setBusy(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  return <section className={box} data-testid="prompt-card-panel"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">提示词卡片（只读）</h3><p className="mt-1 text-sm text-[var(--muted-foreground)]">一张卡对应一个前台功能，只登记提示词文件的版本与 sha256，正文以文件为准；全部未放行上线。</p></div><button className={button} onClick={() => void load()} disabled={busy}>重新读取</button></div>{notice && <p role="status" className="mt-3 text-sm text-[var(--muted-foreground)]">{notice}</p>}<PromptCardRegistryTable items={items} /></section>;
}
