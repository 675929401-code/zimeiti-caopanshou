'use client';
import { useCallback, useEffect, useState } from 'react';
import { UNCONFIGURED_MODEL_LABEL, type OperationModelMappingEntry } from '@/commerce/shared/operation-model-mapping';

const box = 'rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5';
const button = 'rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-2 text-sm font-medium hover:bg-[var(--accent)] disabled:opacity-50';
const KIND_LABEL: Record<string, string> = { agent: '对话', image: '图片', video: '视频' };

type MappingResponse = { ok?: boolean; entries?: unknown; releaseId?: string | null; published?: boolean; error?: string };

function safeEntries(value: unknown): OperationModelMappingEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is OperationModelMappingEntry => Boolean(item) && typeof item === 'object' && typeof (item as OperationModelMappingEntry).operationId === 'string');
}

/** 纯展示：未配置的功能只显示「未配置模型」，不当作错误。 */
export function OperationModelMappingTable({ entries }: { entries: OperationModelMappingEntry[] }) {
  if (!entries.length) return <p className="mt-3 text-sm text-[var(--muted-foreground)]">暂无功能登记。</p>;
  return <div className="mt-3 max-h-[640px] overflow-auto"><table className="w-full text-left text-sm" data-testid="operation-model-mapping-table"><thead><tr><th>功能</th><th>operationId</th><th>类型</th><th>主模型</th><th>版本</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.operationId} className="border-t border-[var(--border)]" data-configured={entry.configured ? 'true' : 'false'}><td className="py-2">{entry.label || entry.operationId}</td><td className="font-mono text-xs">{entry.operationId}</td><td>{entry.modelKind ? KIND_LABEL[entry.modelKind] || entry.modelKind : '—'}</td><td>{entry.configured ? <span className="font-mono text-xs">{entry.primaryModelId}</span> : <span className="text-[var(--muted-foreground)]">{UNCONFIGURED_MODEL_LABEL}</span>}</td><td>{entry.routeVersion === null ? '—' : `v${entry.routeVersion}`}</td></tr>)}</tbody></table></div>;
}

/** 管理员只读面板：功能→模型映射（来源 commerce_operation_routes 已发布版本）。读取失败只提示，不抛错。 */
export function OperationModelMappingPanel({ token }: { token: string }) {
  const [entries, setEntries] = useState<OperationModelMappingEntry[]>([]);
  const [notice, setNotice] = useState('正在读取功能→模型映射…');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/admin/commerce/operation-models', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as MappingResponse;
      if (!response.ok || data.ok !== true) { setEntries([]); setNotice(data.error || `读取失败（HTTP ${response.status}）`); return; }
      setEntries(safeEntries(data.entries));
      setNotice(data.published ? '' : '带货配置尚无已发布版本，全部功能按「未配置模型」显示。');
    } catch {
      setEntries([]); setNotice('功能→模型映射暂不可读取。');
    } finally { setBusy(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  return <section className={box} data-testid="operation-model-mapping-panel"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">功能→模型映射（只读）</h3><p className="mt-1 text-sm text-[var(--muted-foreground)]">主模型来自已发布的功能路由；主模型为空的功能显示「{UNCONFIGURED_MODEL_LABEL}」。修改请用下方「保存路由新版本」并发布。</p></div><button className={button} onClick={() => void load()} disabled={busy}>重新读取</button></div>{notice && <p role="status" className="mt-3 text-sm text-[var(--muted-foreground)]">{notice}</p>}<OperationModelMappingTable entries={entries} /></section>;
}
