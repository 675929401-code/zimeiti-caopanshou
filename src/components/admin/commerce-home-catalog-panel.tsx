'use client';
import { useCallback, useEffect, useState } from 'react';

type Row = Record<string, unknown>;
type EntryRow = {
  entryKind: 'scenario' | 'image_skill' | 'quick_tool';
  entryKey: string;
  draftPayload: Row | null;
  publishedPayload: Row | null;
  publishedVersion: number;
  status: 'active' | 'disabled';
  changeNote: string;
  updatedAt: string;
  publishedAt: string | null;
};
type OverviewItem = { key: string; baseline: Row; entry: EntryRow | null };
type OverviewGroup = { kind: EntryRow['entryKind']; items: OverviewItem[] };
type Overview = { groups: OverviewGroup[]; unknownEntries: EntryRow[] };

type DraftForm = {
  name: string; description: string; image: string; prompt: string;
  stages: string; category: string; sortOrder: string; hidden: boolean; changeNote: string;
};

const box = 'rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5';
const input = 'w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]';
const button = 'rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--accent)] disabled:opacity-50';
const primary = 'rounded-xl bg-[var(--primary)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50';

const GROUP_LABEL: Record<EntryRow['entryKind'], string> = {
  scenario: '首页场景卡',
  image_skill: 'AI 图片技能卡',
  quick_tool: '快捷工具',
};
const KIND_FIELDS: Record<EntryRow['entryKind'], readonly string[]> = {
  scenario: ['name', 'description', 'image', 'prompt', 'stages', 'sortOrder', 'hidden'],
  image_skill: ['name', 'description', 'category', 'sortOrder', 'hidden'],
  quick_tool: ['name', 'sortOrder', 'hidden'],
};

function emptyForm(kind: EntryRow['entryKind'], baseline: Row, entry: EntryRow | null): DraftForm {
  const source = entry?.draftPayload || entry?.publishedPayload || {};
  const stages = Array.isArray(source.stages) ? source.stages.map(String) : Array.isArray(baseline.stages) ? (baseline.stages as unknown[]).map(String) : [];
  return {
    name: String(source.name ?? baseline.name ?? ''),
    description: String(source.description ?? baseline.description ?? ''),
    image: String(source.image ?? ''),
    prompt: String(source.prompt ?? (kind === 'scenario' ? baseline.prompt ?? '' : '')),
    stages: stages.join('\n'),
    category: String(source.category ?? baseline.category ?? ''),
    sortOrder: source.sortOrder !== undefined ? String(source.sortOrder) : '',
    hidden: source.hidden === true,
    changeNote: '',
  };
}

function payloadOf(kind: EntryRow['entryKind'], form: DraftForm): Row {
  const payload: Row = {};
  const fields = KIND_FIELDS[kind];
  if (fields.includes('name')) payload.name = form.name;
  if (fields.includes('description')) payload.description = form.description;
  if (fields.includes('image') && form.image.trim()) payload.image = form.image.trim();
  if (fields.includes('prompt')) payload.prompt = form.prompt;
  if (fields.includes('stages')) payload.stages = form.stages.split('\n').map((line) => line.trim()).filter(Boolean);
  if (fields.includes('category')) payload.category = form.category;
  if (fields.includes('sortOrder') && form.sortOrder.trim() !== '') payload.sortOrder = Number(form.sortOrder);
  if (fields.includes('hidden') && form.hidden) payload.hidden = true;
  return payload;
}

function entryStatus(item: OverviewItem): { label: string; tone: string } {
  const entry = item.entry;
  if (!entry) return { label: '基线展示', tone: 'text-[var(--muted-foreground)]' };
  if (entry.status === 'disabled') return { label: '已停用', tone: 'text-red-500' };
  if (entry.draftPayload) return { label: entry.publishedPayload ? `已发布 v${entry.publishedVersion} · 有新草稿` : '草稿待发布', tone: 'text-amber-600' };
  if (entry.publishedPayload) return { label: `已发布 v${entry.publishedVersion}`, tone: 'text-emerald-600' };
  return { label: '基线展示', tone: 'text-[var(--muted-foreground)]' };
}

export function CommerceHomeCatalogPanel({ token, canManage }: { token: string; canManage: boolean }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ kind: EntryRow['entryKind']; key: string; form: DraftForm } | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/admin/commerce/home-catalog', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || '读取失败');
    setOverview(body.overview as Overview);
  }, [token]);
  useEffect(() => { void load().catch((error) => setNotice((error as Error).message)); }, [load]);

  async function mutate(body: Row, success: string) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/admin/commerce/home-catalog', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || '操作失败');
      setNotice(success);
      setEditing(null);
      await load();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!overview) return <section className={box}><p className="text-sm text-[var(--muted-foreground)]">正在读取首页配置…</p></section>;

  return (
    <div className="grid gap-4">
      <section className={box}>
        <h3 className="font-semibold">首页配置</h3>
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">
          场景卡、图片技能卡、快捷工具的名称、简介、图片、提示语与排序在这里改；先存草稿再发布，发布后约 15 秒内对会员生效。功能合同（入口、素材槽、路由）仍由平台代码保证，新增功能卡片请走卡片中心。
        </p>
        {notice && <p role="status" className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-600">{notice}</p>}
      </section>
      {overview.groups.map((group) => (
        <section key={group.kind} className={box}>
          <h4 className="font-semibold">{GROUP_LABEL[group.kind]} <span className="ml-2 text-xs font-normal text-[var(--muted-foreground)]">{group.items.length} 项</span></h4>
          <div className="mt-3 space-y-2">
            {group.items.map((item) => {
              const status = entryStatus(item);
              const open = editing?.kind === group.kind && editing.key === item.key;
              return (
                <div key={item.key} className="rounded-xl border border-[var(--border)] p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm">{String(item.entry?.publishedPayload?.name || item.baseline.name || item.key)}</strong>
                    <code className="text-xs text-[var(--muted-foreground)]">{item.key}</code>
                    <span className={`text-xs ${status.tone}`}>{status.label}</span>
                    <span style={{ flex: 1 }} />
                    {canManage && <button className={button} disabled={busy} onClick={() => setEditing(open ? null : { kind: group.kind, key: item.key, form: emptyForm(group.kind, item.baseline, item.entry) })}>{open ? '收起' : '编辑'}</button>}
                    {canManage && item.entry?.draftPayload && <button className={primary} disabled={busy} onClick={() => void mutate({ action: 'publish', kind: group.kind, key: item.key }, `「${item.key}」已发布，会员端约 15 秒内生效。`)}>发布</button>}
                    {canManage && item.entry && (item.entry.status === 'active'
                      ? <button className={button} disabled={busy} onClick={() => void mutate({ action: 'setStatus', kind: group.kind, key: item.key, status: 'disabled' }, `「${item.key}」已停用，会员端回退为基线展示。`)}>停用</button>
                      : <button className={button} disabled={busy} onClick={() => void mutate({ action: 'setStatus', kind: group.kind, key: item.key, status: 'active' }, `「${item.key}」已恢复启用。`)}>启用</button>)}
                    {canManage && item.entry && <button className={button} disabled={busy} onClick={() => { if (window.confirm(`确认把「${item.key}」恢复为代码基线展示？草稿与已发布内容都会被清除。`)) void mutate({ action: 'reset', kind: group.kind, key: item.key }, `「${item.key}」已恢复默认。`); }}>恢复默认</button>}
                  </div>
                  {open && editing && (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <label className="text-sm">名称<input className={input} value={editing.form.name} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, name: e.target.value } })} /></label>
                      {KIND_FIELDS[group.kind].includes('category') && <label className="text-sm">分类<input className={input} value={editing.form.category} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, category: e.target.value } })} /></label>}
                      {KIND_FIELDS[group.kind].includes('description') && <label className="text-sm md:col-span-2">简介<input className={input} value={editing.form.description} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, description: e.target.value } })} /></label>}
                      {KIND_FIELDS[group.kind].includes('image') && <label className="text-sm md:col-span-2">卡片图片（站内路径，可先到素材库上传）<input className={input} placeholder="/api/commerce/shared-media/…" value={editing.form.image} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, image: e.target.value } })} /></label>}
                      {KIND_FIELDS[group.kind].includes('prompt') && <label className="text-sm md:col-span-2">点击卡片带入的提示语<textarea className={`${input} min-h-20`} value={editing.form.prompt} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, prompt: e.target.value } })} /></label>}
                      {KIND_FIELDS[group.kind].includes('stages') && <label className="text-sm md:col-span-2">创作步骤（每行一步）<textarea className={`${input} min-h-24`} value={editing.form.stages} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, stages: e.target.value } })} /></label>}
                      <label className="text-sm">排序（0-999，留空保持原顺序）<input className={input} type="number" min={0} max={999} value={editing.form.sortOrder} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, sortOrder: e.target.value } })} /></label>
                      <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.form.hidden} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, hidden: e.target.checked } })} /> 对会员隐藏</label>
                      <label className="text-sm md:col-span-2">变更说明<input className={input} value={editing.form.changeNote} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, changeNote: e.target.value } })} /></label>
                      <div className="md:col-span-2">
                        <button className={primary} disabled={busy} onClick={() => {
                          try {
                            void mutate({ action: 'saveDraft', kind: group.kind, key: item.key, payload: payloadOf(group.kind, editing.form), changeNote: editing.form.changeNote }, `「${item.key}」草稿已保存，发布后才会对会员生效。`);
                          } catch (error) { setNotice((error as Error).message); }
                        }}>保存草稿</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {overview.unknownEntries.length > 0 && (
        <section className={box}>
          <h4 className="font-semibold text-amber-600">已失效的配置项</h4>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">这些条目已不在代码基线中，不会再影响前台；可忽略，恢复默认会清除它们。</p>
          <div className="mt-2 space-y-1 text-xs">
            {overview.unknownEntries.map((entry) => <p key={`${entry.entryKind}:${entry.entryKey}`}><code>{entry.entryKind}:{entry.entryKey}</code></p>)}
          </div>
        </section>
      )}
    </div>
  );
}
