'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

type Row = Record<string, unknown>;
type Model = { id: string; displayName: string; kind: 'agent' | 'image' | 'video'; publicPrice: number; costPrice: number | null; available: boolean };
type Media = { id: string; name: string; type: string; size: number; url: string; createdAt: number };

const box = 'rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5';
const input = 'w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]';
const button = 'rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--accent)] disabled:opacity-50';
const primary = 'rounded-xl bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50';

const KIND_LABEL: Record<string, string> = { agent: '对话模型', image: '拆解生图模型', video: '视频模型' };
const VISIBILITY_LABEL: Record<string, string> = { members: '会员可见', admins: '仅管理员', hidden: '已隐藏' };

function latestBy(rows: Row[], key: string): Row[] {
  const map = new Map<string, Row>();
  for (const row of rows) {
    const id = String(row[key] || '');
    if (!id) continue;
    const prior = map.get(id);
    if (!prior || Number(row.version) > Number(prior.version)) map.set(id, row);
  }
  return [...map.values()];
}

async function request<T>(url: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data;
}

/** 卡片可能关联的功能路由：编导对话 + 图片技能生图。视频生成走全局共享路由，单列展示。 */
function routeOperationIds(stableKey: string, executorType: string): { operationId: string; kind: Model['kind'] }[] {
  const result: { operationId: string; kind: Model['kind'] }[] = [];
  if (executorType === 'director') result.push({ operationId: `director.${stableKey}`, kind: 'agent' });
  if (executorType === 'image_skill') result.push({ operationId: `image.${stableKey}`, kind: 'image' });
  return result;
}

function formatSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

/** 平台共享素材库：上传、选择、删除（有卡片引用时服务端拒绝删除）。 */
function MediaLibrary({ token, onPick, notify }: { token: string; onPick?: (url: string) => void; notify: (message: string) => void }) {
  const [media, setMedia] = useState<Media[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try { const data = await request<{ media: Media[] }>('/api/admin/commerce/media', token); setMedia(data.media); }
    catch (error) { notify((error as Error).message); setMedia([]); }
  }
  useEffect(() => { void load(); }, []);

  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/admin/commerce/media', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      notify(`已上传 ${file.name}`);
      await load();
      if (onPick && data.media?.url) onPick(String(data.media.url));
    } catch (error) { notify((error as Error).message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={button} disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? '上传中…' : '上传素材（图片 / 视频 ≤150MB）'}</button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/ogg" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      <span className="text-xs text-[var(--muted-foreground)]">上传后即可被卡片图标、封面引用；被引用的素材不能删除。</span>
    </div>
    {media === null && <p className="text-xs text-[var(--muted-foreground)]">正在读取素材库…</p>}
    {media && !media.length && <p className="text-xs text-[var(--muted-foreground)]">素材库还是空的，先上传一张图片。</p>}
    {media && media.length > 0 && <div className="grid max-h-64 grid-cols-2 gap-2 overflow-auto sm:grid-cols-4">
      {media.map(item => <div key={item.id} className="group relative rounded-xl border border-[var(--border)] p-1.5">
        <button type="button" className="block w-full" title={`${item.name} · ${formatSize(item.size)}`} onClick={() => onPick?.(item.url)}>
          {item.type.startsWith('image/')
            ? <img src={item.url} alt={item.name} className="h-16 w-full rounded-lg object-cover" />
            : <span className="flex h-16 w-full items-center justify-center rounded-lg bg-[var(--accent)] text-xs text-[var(--muted-foreground)]">{item.type.startsWith('video/') ? '视频' : '音频'}</span>}
          <span className="mt-1 block truncate text-xs text-[var(--foreground)]">{item.name}</span>
        </button>
        <button type="button" className="absolute right-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-white opacity-0 transition group-hover:opacity-100" onClick={() => void (async () => {
          if (!window.confirm(`确定删除「${item.name}」？被卡片引用的素材会被服务端拦截。`)) return;
          try {
            const response = await fetch('/api/admin/commerce/media', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
            notify(`已删除 ${item.name}`);
            await load();
          } catch (error) { notify((error as Error).message); }
        })()}>删</button>
      </div>)}
    </div>}
  </div>;
}

function CardEditor({ row, token, models, latestPrompts, latestRoutes, modelById, canManageCards, canEditPrompts, canManageModels, busy, run }: {
  row: { card: Row; version: Row | undefined; display: Row; executorType: string; promptRow: Row | undefined; routes: { operationId: string; kind: Model['kind']; route: Row | undefined }[] };
  token: string; models: Model[]; latestPrompts: Row[]; latestRoutes: Row[]; modelById: Map<string, Model>;
  canManageCards: boolean; canEditPrompts: boolean; canManageModels: boolean; busy: boolean;
  run: (action: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const stableKey = String(row.card.stable_key || '');
  const [promptKey, setPromptKey] = useState(String(row.promptRow?.prompt_key || (row.executorType === 'director' ? `director.${stableKey}` : '')));
  const [promptName, setPromptName] = useState(String(row.promptRow?.name || row.display.name || ''));
  const [promptContent, setPromptContent] = useState('');
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [visibility, setVisibility] = useState(String(row.display.visibility || 'admins'));
  const [routeDrafts, setRouteDrafts] = useState<Record<string, { primary: string; fallbacks: string }>>({});
  const [info, setInfo] = useState({ name: String(row.display.name || ''), description: String(row.display.description || ''), category: String(row.display.category || '自定义'), sortOrder: String(row.display.sortOrder ?? 0), icon: String(row.display.icon || '/commerce/reference/director-custom.png') });
  const [pickerOpen, setPickerOpen] = useState(false);

  // 展开即展示提示词正文，不需要再点一次（管理员核心诉求：看得见）。
  useEffect(() => {
    if (row.promptRow && !promptLoaded) { setPromptContent(String(row.promptRow.content || '')); setPromptLoaded(true); }
  }, [row.promptRow, promptLoaded]);

  function routeDraft(operationId: string, kind: Model['kind'], route: Row | undefined) {
    return routeDrafts[operationId] || { primary: String(route?.primary_model_id || ''), fallbacks: (Array.isArray(route?.fallback_model_ids) ? route.fallback_model_ids : []).join(',') };
  }
  const infoDirty = info.name !== String(row.display.name || '') || info.description !== String(row.display.description || '') || info.category !== String(row.display.category || '自定义') || info.sortOrder !== String(row.display.sortOrder ?? 0) || info.icon !== String(row.display.icon || '/commerce/reference/director-custom.png') || visibility !== String(row.display.visibility || 'admins');

  function saveCardDisplay(changeNote: string) {
    const version = row.version;
    if (!version) throw Error('此卡还没有版本，请先在「功能卡片」保存首个版本');
    return request('/api/admin/commerce/cards', token, {
      card: {
        stableKey,
        display: { ...row.display, name: info.name.trim(), description: info.description.trim(), category: info.category.trim() || '自定义', sortOrder: Number(info.sortOrder) || 0, icon: info.icon.trim() || '/commerce/reference/director-custom.png', visibility },
        executorType: row.executorType,
        promptVersionId: version.prompt_version_id || '',
        materialSlots: version.material_slots || [],
        inputFields: version.input_fields || [],
        outputContract: version.output_contract || {},
        qualityRules: version.quality_rules || {},
        testCases: version.test_cases || [],
        knowledgeDocumentIds: version.knowledge_document_ids || [],
        modelPolicy: version.model_policy || {},
        videoDefaults: version.video_defaults || {},
        changeNote,
      },
    });
  }

  return <div className="grid gap-4 border-t border-[var(--border)] px-4 py-4 lg:grid-cols-2">
    <section className="space-y-3">
      <h4 className="text-sm font-semibold">基础信息</h4>
      <div className="flex items-start gap-3">
        <img src={info.icon || '/commerce/reference/director-custom.png'} alt="" className="h-14 w-14 rounded-xl border border-[var(--border)] object-cover" />
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <input className={input} value={info.icon} onChange={event => setInfo({ ...info, icon: event.target.value })} placeholder="图标 URL（可用下方素材库上传或选择）" />
            <button type="button" className={`${button} shrink-0`} onClick={() => setPickerOpen(!pickerOpen)}>{pickerOpen ? '收起素材库' : '素材库'}</button>
          </div>
        </div>
      </div>
      {pickerOpen && <MediaLibrary token={token} notify={() => undefined} onPick={url => { setInfo(current => ({ ...current, icon: url })); }} />}
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={input} value={info.name} onChange={event => setInfo({ ...info, name: event.target.value })} placeholder="卡片名称" />
        <input className={input} value={info.category} onChange={event => setInfo({ ...info, category: event.target.value })} placeholder="分组（如 电商带货 / 剧情短片）" />
      </div>
      <textarea className={`${input} min-h-16`} value={info.description} onChange={event => setInfo({ ...info, description: event.target.value })} placeholder="卡片简介（会员在卡片上看到的两句话）" />
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${input} max-w-28`} type="number" value={info.sortOrder} onChange={event => setInfo({ ...info, sortOrder: event.target.value })} placeholder="排序" title="同组内排序，小的在前" />
        <select className={`${input} max-w-36`} value={visibility} onChange={event => setVisibility(event.target.value)}>
          {Object.entries(VISIBILITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {canManageCards && <button type="button" className={primary} disabled={busy || !infoDirty || !info.name.trim() || !info.description.trim()} onClick={() => void run(() => saveCardDisplay('卡片中心修订基础信息'), '基础信息已保存为草稿，发布后生效。')}>保存基础信息</button>}
      </div>

      <h4 className="pt-2 text-sm font-semibold">提示词（{row.promptRow ? `${String(row.promptRow.name)} · v${String(row.promptRow.version)}` : '未绑定'}）</h4>
      {!editingPrompt && <div className="space-y-2">
        <p className="text-xs text-[var(--muted-foreground)]">键：{promptKey || '未设置'}</p>
        {promptLoaded && <textarea readOnly className={`${input} min-h-48 font-mono text-xs`} value={promptContent} />}
        {canEditPrompts && <button type="button" className={button} onClick={() => setEditingPrompt(true)}>{row.promptRow ? '编辑并保存为新版本' : '为此卡创建提示词'}</button>}
      </div>}
      {editingPrompt && canEditPrompts && <div className="space-y-2">
        <input className={input} value={promptKey} onChange={event => setPromptKey(event.target.value)} placeholder="提示词键（编导卡必须是 director.卡片键）" readOnly={row.executorType === 'director'} />
        <input className={input} value={promptName} onChange={event => setPromptName(event.target.value)} placeholder="提示词名称" />
        <textarea className={`${input} min-h-56 font-mono text-xs`} value={promptContent} onChange={event => setPromptContent(event.target.value)} placeholder="提示词正文" />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={primary} disabled={busy || !promptKey.trim() || !promptName.trim() || !promptContent.trim()} onClick={() => void run(async () => {
            const saved = await request<{ version: Row }>('/api/admin/commerce/prompts', token, { kind: 'prompt', promptKey: promptKey.trim(), name: promptName.trim(), content: promptContent, changeNote: '卡片中心修订' });
            if (row.executorType === 'director' && row.version?.id) {
              await request('/api/admin/commerce/cards', token, { action: 'bind-director-prompt', cardVersionId: String(row.version.id), promptVersionId: String(saved.version.id) });
            }
          }, '提示词新版本已保存并绑定为草稿，发布后生效。')}>保存并绑定草稿</button>
          <button type="button" className={button} onClick={() => setEditingPrompt(false)}>取消</button>
        </div>
      </div>}
    </section>
    <section className="space-y-3">
      <h4 className="text-sm font-semibold">模型配置</h4>
      {row.routes.length === 0 && <p className="text-xs text-[var(--muted-foreground)]">此卡类型没有专属模型路由，执行时使用发布版本的默认模型。视频模型的会员可选列表在模型池（带货 Agent 项目）维护。</p>}
      {row.routes.map(item => {
        const draft = routeDraft(item.operationId, item.kind, item.route);
        const candidates = models.filter(model => model.kind === item.kind);
        return <div key={item.operationId} className="space-y-2 rounded-xl border border-[var(--border)] p-3">
          <p className="text-sm font-medium">{KIND_LABEL[item.kind]}<span className="ml-2 text-xs font-normal text-[var(--muted-foreground)]">{item.operationId}{item.route ? ` · 路由 v${String(item.route.version)}` : ' · 未配置，走发布默认'}</span></p>
          <select className={input} value={draft.primary} disabled={!canManageModels} onChange={event => setRouteDrafts(current => ({ ...current, [item.operationId]: { ...draft, primary: event.target.value } }))}>
            <option value="">选择主模型</option>
            {candidates.map(model => <option key={model.id} value={model.id} disabled={!model.available}>{model.displayName} · 售 ¥{model.publicPrice}{model.costPrice === null ? ' · 成本未配' : ` · 成本 ¥${model.costPrice}`}{!model.available ? ' · 待验证' : ''}</option>)}
          </select>
          <input className={input} placeholder="候补模型 ID，逗号分隔（可空）" value={draft.fallbacks} disabled={!canManageModels} onChange={event => setRouteDrafts(current => ({ ...current, [item.operationId]: { ...draft, fallbacks: event.target.value } }))} />
          {canManageModels && <button type="button" className={button} disabled={busy || !draft.primary} onClick={() => void run(async () => {
            await request('/api/admin/commerce/routes', token, {
              operationId: item.operationId,
              label: `${String(row.display.name || stableKey)} · ${KIND_LABEL[item.kind]}`,
              modelKind: item.kind,
              primaryModelId: draft.primary,
              fallbackModelIds: draft.fallbacks.split(',').map(value => value.trim()).filter(Boolean),
              userSelectable: false,
              capabilityRequirements: (item.route?.capability_requirements || {}) as Record<string, unknown>,
            });
            setRouteDrafts(current => { const next = { ...current }; delete next[item.operationId]; return next; });
          }, `${KIND_LABEL[item.kind]}路由已保存为草稿，发布后生效。`)}>保存{KIND_LABEL[item.kind]}路由</button>}
        </div>;
      })}
      <div className="rounded-xl border border-dashed border-[var(--border)] p-3 text-xs text-[var(--muted-foreground)]">
        视频模型：编导卡成片走全局共享路由 video.generate，会员可选范围由模型池「带货 Agent」项目维护；需要调整请到「模型路由」标签或模型池。
      </div>
    </section>
  </div>;
}

/** 复制现有卡片为模板新建：服务端合同校验与旧卡一致，避免管理员手写 JSON 配置。 */
function NewCardForm({ rows, token, busy, run }: { rows: { card: Row; version: Row | undefined; display: Row; executorType: string }[]; token: string; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const templates = rows.filter(row => row.version);
  const [templateKey, setTemplateKey] = useState('');
  const [stableKey, setStableKey] = useState('');
  const [name, setName] = useState('');
  const template = templates.find(row => String(row.card.stable_key) === templateKey);

  return <div className="space-y-2 rounded-xl border border-[var(--border)] p-3">
    <div className="grid gap-2 sm:grid-cols-3">
      <select className={input} value={templateKey} onChange={event => setTemplateKey(event.target.value)}>
        <option value="">选择模板卡片</option>
        {templates.map(row => <option key={String(row.card.id)} value={String(row.card.stable_key || '')}>{String(row.display.name || row.card.stable_key)}（{String(row.display.category || '')}）</option>)}
      </select>
      <input className={input} value={stableKey} onChange={event => setStableKey(event.target.value)} placeholder="新卡唯一键，如 denim-jacket" />
      <input className={input} value={name} onChange={event => setName(event.target.value)} placeholder="新卡名称" />
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={primary} disabled={busy || !template || !stableKey.trim() || !name.trim()} onClick={() => void run(async () => {
        const version = template!.version!;
        await request('/api/admin/commerce/cards', token, {
          card: {
            stableKey: stableKey.trim(),
            display: { ...(version.display as Row), name: name.trim(), visibility: 'admins' },
            executorType: String(version.executor_type || 'director'),
            promptVersionId: version.prompt_version_id || '',
            materialSlots: version.material_slots || [],
            inputFields: version.input_fields || [],
            outputContract: version.output_contract || {},
            qualityRules: version.quality_rules || {},
            testCases: version.test_cases || [],
            knowledgeDocumentIds: version.knowledge_document_ids || [],
            modelPolicy: version.model_policy || {},
            videoDefaults: version.video_defaults || {},
            changeNote: `以 ${templateKey} 为模板新建`,
          },
        });
      }, '新卡片草稿已创建（默认仅管理员可见），请在卡片中心继续配置提示词与模型，验收后发布。')}>以模板创建新卡草稿</button>
      <span className="text-xs text-[var(--muted-foreground)]">复制模板卡的素材槽、输入字段、合同与质检配置；新卡默认「仅管理员可见」，发布前记得调整。</span>
    </div>
  </div>;
}

export function CommerceCardCenterPanel({ token, data, canManageCards, canEditPrompts, canManageModels, reload }: {
  token: string;
  data: { cards: Row[]; cardVersions: Row[]; prompts: Row[]; routes: Row[]; models: Model[]; current: Row | null };
  canManageCards: boolean; canEditPrompts: boolean; canManageModels: boolean;
  reload: () => Promise<void>;
}) {
  const [openKey, setOpenKey] = useState('');
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [batchModelId, setBatchModelId] = useState('');
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const latestPrompts = useMemo(() => latestBy(data.prompts, 'prompt_key'), [data.prompts]);
  const latestRoutes = useMemo(() => latestBy(data.routes, 'operation_id'), [data.routes]);
  const modelById = useMemo(() => new Map(data.models.map(model => [model.id, model])), [data.models]);

  const rows = useMemo(() => {
    const versions = latestBy(data.cardVersions, 'card_id');
    return data.cards.map(card => {
      const version = versions.find(item => item.card_id === card.id);
      const display = (version?.display || {}) as Row;
      const executorType = String(version?.executor_type || 'director');
      const promptRow = data.prompts.find(item => item.id === version?.prompt_version_id);
      const routes = routeOperationIds(String(card.stable_key || ''), executorType).map(candidate => {
        const route = latestRoutes.find(item => item.operation_id === candidate.operationId);
        return { ...candidate, route };
      });
      return { card, version, display, executorType, promptRow, routes };
    }).filter(row => {
      if (!filter.trim()) return true;
      const haystack = `${row.display.name || ''} ${row.display.category || ''} ${row.card.stable_key || ''}`;
      return haystack.toLowerCase().includes(filter.trim().toLowerCase());
    }).sort((left, right) => String(left.display.category || '').localeCompare(String(right.display.category || ''), 'zh') || Number(left.display.sortOrder || 0) - Number(right.display.sortOrder || 0));
  }, [data, filter, latestRoutes]);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try { await action(); setNotice(message); await reload(); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  const agentModels = useMemo(() => data.models.filter(model => model.kind === 'agent' && model.available), [data.models]);
  const selectedDirectorRows = useMemo(() => rows.filter(row => row.executorType === 'director' && row.card.stable_key && selectedKeys.includes(String(row.card.stable_key))), [rows, selectedKeys]);
  const directorKeys = useMemo(() => rows.filter(row => row.executorType === 'director').map(row => String(row.card.stable_key || '')).filter(Boolean), [rows]);
  const toggleSelection = (stableKey: string) => setSelectedKeys(current => current.includes(stableKey) ? current.filter(key => key !== stableKey) : [...current, stableKey]);
  const toggleSelectAll = () => setSelectedKeys(current => {
    const keys = rows.filter(row => row.executorType === 'director').map(row => String(row.card.stable_key || '')).filter(Boolean);
    return keys.length > 0 && keys.every(key => current.includes(key)) ? [] : keys;
  });
  async function applyBatchModel() {
    if (batchBusy || !batchModelId) return;
    if (!selectedDirectorRows.length) {
      setNotice('所选卡片里没有编导卡；对话模型只对编导卡生效。');
      setBatchConfirmOpen(false);
      return;
    }
    setBatchBusy(true);
    try {
      const operationIds = selectedDirectorRows.map(row => `director.${String(row.card.stable_key)}`);
      const result = await request<{ ok: boolean; results: { operationId: string; version?: number; error?: string }[] }>('/api/admin/commerce/routes', token, {
        action: 'batch',
        operationIds,
        primaryModelId: batchModelId,
        changeNote: '卡片中心批量设置对话模型',
      });
      const failed = (result.results || []).filter(item => item.error);
      const skipped = selectedKeys.length - selectedDirectorRows.length;
      setNotice(failed.length
        ? `已保存 ${selectedDirectorRows.length - failed.length} 张卡片的对话模型草稿；${failed.length} 个失败：${failed.map(item => `${item.operationId}（${item.error}）`).join('；')}`
        : `已为 ${selectedDirectorRows.length} 张卡片保存对话模型路由草稿${skipped > 0 ? `（另有 ${skipped} 张非编导卡已跳过）` : ''}；到「发布与回滚」发布后生效。`);
      setSelectedKeys([]);
      setBatchModelId('');
      setBatchConfirmOpen(false);
      await reload();
    } catch (error) { setNotice((error as Error).message); }
    finally { setBatchBusy(false); }
  }

  return <section className={box} aria-label="卡片中心">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="font-semibold">卡片中心</h3>
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">每张卡的名称、图标、提示词、对话模型、拆解生图模型与可见性集中在这里；修改保存为草稿，到「发布与回滚」创建候选并发布后对会员生效。视频模型为全局共享路由与模型池自选列表，不在单卡内修改。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative block">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round" /></svg>
          <input className={`${input} w-64 pl-9`} placeholder="搜索卡片名称 / 分组 / 标识" value={filter} onChange={event => setFilter(event.target.value)} aria-label="搜索卡片" />
        </label>
        {canManageCards && (
          <button
            type="button"
            data-testid="commerce-card-new"
            onClick={() => setCreating(!creating)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm font-medium transition ${creating ? 'border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--accent)]' : 'border-transparent bg-[var(--primary)] text-white shadow-[0_1px_2px_rgba(47,107,255,0.3)] hover:brightness-105'}`}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 transition-transform ${creating ? 'rotate-45' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
            {creating ? '收起新建' : '新建卡片'}
          </button>
        )}
      </div>
    </div>
    {notice && <p role="status" className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-600">{notice}</p>}
    {creating && canManageCards && <div className="mt-4"><NewCardForm rows={rows} token={token} busy={busy} run={run} /></div>}
    {selectedKeys.length > 0 && (
      <div data-testid="commerce-card-batch-bar" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#c7d7fe] bg-[#eff4ff] px-3 py-2">
        <span className="text-xs font-medium text-[#175cd3]">
          已选 {selectedKeys.length} 张卡片 · 其中编导卡 {selectedDirectorRows.length} 张
          <span className="ml-1 text-[#667085]">（对话模型仅编导卡生效）</span>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <select
            data-testid="commerce-card-batch-model"
            aria-label="批量设置对话模型"
            className="h-9 w-56 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
            value={batchModelId}
            onChange={event => setBatchModelId(event.target.value)}
          >
            <option value="">选择对话模型</option>
            {agentModels.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}
          </select>
          <button type="button" data-testid="commerce-card-batch-apply" disabled={!batchModelId || batchBusy || selectedDirectorRows.length === 0} onClick={() => setBatchConfirmOpen(true)} className="rounded-xl bg-[var(--primary)] px-3.5 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">批量设置</button>
          <button type="button" onClick={() => { setSelectedKeys([]); setBatchModelId(''); }} className="px-2 py-1.5 text-xs text-[#175cd3]">清除</button>
        </div>
      </div>
    )}
    {batchConfirmOpen && (
      <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-4" role="presentation">
        <div role="dialog" aria-modal="true" aria-label="确认批量设置对话模型" className={`${box} w-full max-w-md`}>
          <h3 className="font-semibold">批量设置对话模型</h3>
          <p className="mt-2 text-sm text-[var(--muted-foreground)]">将为 <b className="text-[var(--foreground)]">{selectedDirectorRows.length}</b> 张编导卡保存对话模型路由草稿：</p>
          <p className="mt-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold">{agentModels.find(model => model.id === batchModelId)?.displayName || '未选择模型'}</p>
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">只改主对话模型，不动提示词、图片模型与可见性；保存后需到「发布与回滚」发布才生效。</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={button} onClick={() => setBatchConfirmOpen(false)} disabled={batchBusy}>取消</button>
            <button type="button" data-testid="commerce-card-batch-confirm" className={primary} onClick={() => void applyBatchModel()} disabled={batchBusy}>{batchBusy ? '设置中…' : '确认设置'}</button>
          </div>
        </div>
      </div>
    )}
    <div className="mt-4 space-y-2">
      <label className="flex items-center gap-1.5 px-1 text-xs text-[var(--muted-foreground)]">
        <input type="checkbox" data-testid="commerce-card-select-all" checked={directorKeys.length > 0 && directorKeys.every(key => selectedKeys.includes(key))} onChange={toggleSelectAll} className="rounded border-[var(--border)]" />
        全选当前列表的编导卡
      </label>
      {rows.map(row => {
        const stableKey = String(row.card.stable_key || '');
        const open = openKey === stableKey;
        const status = String(row.version?.status || row.card.status || '');
        const visibility = String(row.display.visibility || 'admins');
        return <div key={String(row.card.id)} className={`rounded-xl border transition-colors ${selectedKeys.includes(stableKey) ? 'border-[#c7d7fe] bg-[#f8faff]' : 'border-[var(--border)]'}`}>
          <div className="flex items-center gap-3 px-3 py-2">
            <input
              type="checkbox"
              data-testid={`commerce-card-select-${stableKey}`}
              aria-label={`选择卡片 ${String(row.display.name || stableKey)}`}
              checked={selectedKeys.includes(stableKey)}
              onChange={() => toggleSelection(stableKey)}
              disabled={row.executorType !== 'director'}
              title={row.executorType === 'director' ? '选择以批量设置对话模型' : '非编导卡没有对话模型'}
              className="shrink-0 rounded border-[var(--border)] disabled:opacity-30"
            />
            <button type="button" className="flex min-w-0 flex-1 flex-wrap items-center gap-3 py-1 text-left" onClick={() => setOpenKey(open ? '' : stableKey)}>
            <img src={String(row.display.icon || '/commerce/reference/director-custom.png')} alt="" className="h-10 w-10 rounded-lg object-cover" />
            <span className="min-w-40 flex-1">
              <b className="text-sm">{String(row.display.name || stableKey)}</b>
              <span className="ml-2 text-xs text-[var(--muted-foreground)]">{String(row.display.category || '')} · {VISIBILITY_LABEL[visibility] || visibility} · {status === 'published' ? '已发布' : `草稿 v${String(row.version?.version || '-')}`}</span>
              <span className="mt-0.5 block truncate text-xs text-[var(--muted-foreground)]">{String(row.display.description || '')}</span>
            </span>
            <span className="text-xs text-[var(--muted-foreground)]">
              提示词：{row.promptRow ? `${String(row.promptRow.name)} · v${String(row.promptRow.version)}` : '未绑定'}
            </span>
            <span className="text-xs text-[var(--muted-foreground)]">
              {row.routes.map(item => `${KIND_LABEL[item.kind]}：${item.route ? (modelById.get(String(item.route.primary_model_id))?.displayName || String(item.route.primary_model_id)) : '走发布默认'}`).join('　') || '模型走发布默认'}
            </span>
            <span className="text-xs text-[var(--muted-foreground)]">{open ? '收起 ▲' : '配置 ▼'}</span>
          </button>
          </div>
          {open && <CardEditor row={row} token={token} models={data.models} latestPrompts={latestPrompts} latestRoutes={latestRoutes} modelById={modelById}
            canManageCards={canManageCards} canEditPrompts={canEditPrompts} canManageModels={canManageModels} busy={busy} run={run} />}
        </div>;
      })}
      {!rows.length && <p className="px-2 py-6 text-center text-sm text-[var(--muted-foreground)]">没有匹配的卡片。</p>}
    </div>
  </section>;
}
