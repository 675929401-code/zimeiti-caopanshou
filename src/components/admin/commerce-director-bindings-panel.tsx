'use client';

import { useMemo, useState } from 'react';

export type CommerceDirectorBinding = {
  key: string;
  name: string;
  category: string;
  operationId: string;
  prompt: { id: string; name: string; content: string; version: number; versionId: string | null } | null;
  releaseId: string | null;
  cardVersionId: string | null;
  primaryModelId: string;
  fallbackModelIds: string[];
  routeVersion: number | null;
  capabilityRequirements: Record<string, unknown>;
};

export function CommerceDirectorBindingsPanel({ bindings, modelNames, agentModels, busy, onPrompt, onModel, onBatchModel }: {
  bindings: CommerceDirectorBinding[];
  modelNames: Record<string, string>;
  agentModels?: { id: string; displayName: string; available: boolean }[];
  busy?: boolean;
  onPrompt?: (binding: CommerceDirectorBinding) => void;
  onModel?: (binding: CommerceDirectorBinding) => void;
  onBatchModel?: (operationIds: string[], primaryModelId: string) => Promise<void>;
}) {
  const [selectedKey, setSelectedKey] = useState('');
  const [batchKeys, setBatchKeys] = useState<Set<string>>(new Set());
  const [batchModelId, setBatchModelId] = useState('');
  const [batching, setBatching] = useState(false);
  const selected = bindings.find(row => row.key === selectedKey) ?? bindings[0];
  const modelName = (id: string) => modelNames[id] ?? id;
  const selectableModels = useMemo(() => (agentModels ?? []).filter(model => model.available), [agentModels]);
  const grouped = useMemo(() => {
    const map = new Map<string, CommerceDirectorBinding[]>();
    for (const row of bindings) { const list = map.get(row.category) ?? []; list.push(row); map.set(row.category, list); }
    return [...map.entries()];
  }, [bindings]);
  if (!selected) return <p className="text-sm">当前目录没有可查看的编导。</p>;

  const toggleBatch = (key: string) => setBatchKeys(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const applyBatch = async () => {
    if (!onBatchModel || !batchKeys.size || !batchModelId || batching) return;
    const operationIds = bindings.filter(row => batchKeys.has(row.key)).map(row => row.operationId);
    setBatching(true);
    try { await onBatchModel(operationIds, batchModelId); setBatchKeys(new Set()); }
    finally { setBatching(false); }
  };

  return <section className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5" aria-label="编导配置">
    {onBatchModel && <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-4" aria-label="批量设置对话模型">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">批量设置对话模型</h3>
        <div className="flex gap-2 text-xs">
          <button type="button" className="rounded-lg border border-[var(--border)] px-2 py-1" onClick={() => setBatchKeys(new Set(bindings.map(row => row.key)))}>全选</button>
          <button type="button" className="rounded-lg border border-[var(--border)] px-2 py-1" onClick={() => setBatchKeys(new Set())}>清空</button>
        </div>
      </div>
      <p className="text-xs text-[var(--muted-foreground)]">勾选多张编导卡，统一替换主对话模型；各卡的候补模型与能力要求保持不变。保存后生成路由草稿，请到「发布与回滚」创建候选并发布后生效。</p>
      <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-[var(--border)] p-2">
        {grouped.map(([category, rows]) => <div key={category}>
          <p className="px-1 py-1 text-xs font-medium text-[var(--muted-foreground)]">{category}</p>
          {rows.map(row => <label key={row.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--accent)]">
            <input type="checkbox" checked={batchKeys.has(row.key)} onChange={() => toggleBatch(row.key)} />
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <span className="max-w-40 truncate text-xs text-[var(--muted-foreground)]">{row.primaryModelId ? modelName(row.primaryModelId) : '待配置'}</span>
          </label>)}
        </div>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="批量主对话模型" className="min-w-56 flex-1 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm" value={batchModelId} onChange={event => setBatchModelId(event.target.value)}>
          <option value="">选择统一的主对话模型</option>
          {selectableModels.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}
        </select>
        <button type="button" className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || batching || !batchKeys.size || !batchModelId} onClick={() => void applyBatch()}>
          {batching ? '保存中…' : `一键保存 ${batchKeys.size} 张卡`}
        </button>
      </div>
    </div>}
    <label className="block text-sm font-medium">选择编导
      <select className="mt-2 block w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2" value={selected.key} onChange={event => setSelectedKey(event.target.value)}>
        {bindings.map(row => <option key={row.key} value={row.key}>{row.category} · {row.name}</option>)}
      </select>
    </label>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(14rem,22rem)]">
      <div className="space-y-2">
        <h3 className="font-semibold">{selected.releaseId ? '已发布提示词' : '当前基线提示词'}</h3>
        <p className="text-sm text-[var(--muted-foreground)]">{selected.prompt ? `${selected.prompt.name} · v${selected.prompt.version}` : '缺少提示词绑定'}</p>
        {selected.prompt && <textarea aria-label="编导提示词正文" readOnly value={selected.prompt.content} className="min-h-80 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm leading-6" />}
        {onPrompt && <button type="button" className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium" onClick={() => onPrompt(selected)}>编辑提示词草稿</button>}
        {selected.cardVersionId && <p className="text-sm text-[var(--muted-foreground)]">保存后可将该版本绑定到编导卡片草稿，再进入验收与配置发布。</p>}
      </div>
      <div className="space-y-3 rounded-lg border border-[var(--border)] p-4 text-sm">
        <h3 className="font-semibold">主站模型路由</h3>
        <dl className="space-y-2">
          <div><dt>主模型</dt><dd className="break-words text-[var(--muted-foreground)]">{selected.primaryModelId ? modelName(selected.primaryModelId) : '待配置'}</dd></div>
          <div><dt>候补模型</dt><dd className="break-words text-[var(--muted-foreground)]">{selected.fallbackModelIds.map(modelName).join('、') || '未配置'}</dd></div>
          <div><dt>功能标识</dt><dd className="break-all text-[var(--muted-foreground)]">{selected.operationId}</dd></div>
        </dl>
        {onModel && <button type="button" className="rounded-lg border border-[var(--border)] px-3 py-2 font-medium" onClick={() => onModel(selected)}>调整模型路由</button>}
      </div>
    </div>
  </section>;
}
