'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UserRound, PawPrint, Trees, Package } from 'lucide-react';
import { drawerAssetMatchesSearch, parseDrawerAssetMetadata } from '@/lib/storyboard-asset-drawer-state';
import { visibleStoryboardReference } from '@/lib/storyboard-initial-reference-adoption';
import { type StoryboardVisualAssetDraft } from '@/lib/storyboard-visual-asset-workspace';
import { storyboardFirstThreeViewInput, type StoryboardPetIdentityState, type StoryboardThreeViewInput } from '@/lib/storyboard-visual-asset-three-view';
import { sameStoryboardVisualAssetIdentity } from '@/lib/storyboard-visual-asset-binding';
import './storyboard-visual-assets-drawer.css';

export type DrawerVisualAssetRole = 'character' | 'pet' | 'environment' | 'prop';
export type DrawerVisualAsset = {
  assetId: string;
  planId: string;
  previewUrl: string;
  name: string;
  prompt?: string;
  role: DrawerVisualAssetRole;
  historyRecordId?: string;
  storageKey?: string;
  modelId?: string;
  modelName?: string;
  quotedPrice?: number;
  createdAt?: string;
  projectId?: string;
  saved: boolean;
  tags?: string[];
  customCategory?: string;
  presetId?: string;
  presetRevision?: number;
  source?: 'personal' | 'platform-preset';
  sceneId?: string;
  sceneZone?: string;
  cameraCoverage?: 'wide' | 'front' | 'side' | 'reverse' | 'detail';
  fixedAnchors?: string[];
  allowedSegmentKinds?: string[];
  derivedFromAssetId?: string;
  identityState?: StoryboardPetIdentityState;
};

export type DrawerVisualAssetMutation = { type: 'upsert'; slotId: string; asset: DrawerVisualAsset } | { type: 'remove'; slotId: string };

export type DrawerVisualAssetInput = { role: DrawerVisualAssetRole; name: string; prompt: string; planId: string; tags?: string[]; customCategory?: string; threeView?: StoryboardThreeViewInput };

export interface StoryboardVisualAssetsDrawerProps {
  open: boolean;
  presentation?: 'inline' | 'page';
  modelControls?: ReactNode;
  targetSlotId?: string;
  onOpenLibrary?: (slotId?: string, drafts?: AssetDraft[]) => void | Promise<void>;
  onLoadImportImages?: (offset: number) => Promise<{ assets: ImportReferenceImage[]; nextOffset: number | null }>;
  onImportImage?: (image: ImportReferenceImage, input: DrawerVisualAssetInput) => Promise<DrawerVisualAsset | null>;
  onUploadReference?: (file: File | undefined, input: DrawerVisualAssetInput) => Promise<DrawerVisualAsset | null>;
  pendingUploads?: Array<{ planId: string; canRead: boolean; unknown: boolean }>;
  canGenerate?: boolean;
  generationIssue?: string;
  canApply?: boolean;
  onReturn?: () => void;
  initialDrafts?: AssetDraft[];
  onVisibleCandidatesChange?: (projectId: string, ids: Record<string, string>) => void;
  onDraftsChange?: (drafts: AssetDraft[]) => void;
  onDeleteDraft?: (planId: string) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  taskCount: number;
  assetUsageCounts?: Record<string, number>;
  assetUsageSegments?: Record<string, number[]>;
  referenceLimit: number;
  modelName: string;
  priceLabel: string;
  candidates: DrawerVisualAsset[];
  selectedAssets: DrawerVisualAsset[];
  selectedSlotIds?: string[];
  requiresExplicitAdoption?: boolean;
  continuesInWorkbench?: boolean;
  loading: boolean;
  generating: boolean;
  saving: boolean;
  error: string;
  pendingRecoveryCount?: number;
  onRecoverPending?: () => Promise<void>;
  onReload: () => Promise<void>;
  hasMore?: boolean;
  onLoadMore?: () => Promise<void>;
  onGenerate: (input: DrawerVisualAssetInput) => Promise<DrawerVisualAsset | null>;
  onGenerateBatch?: (inputs: DrawerVisualAssetInput[]) => Promise<(DrawerVisualAsset | null)[]>;
  onUpdateAsset?: (asset: DrawerVisualAsset) => Promise<boolean>;
  onSaveSelected?: (assets: DrawerVisualAsset[]) => Promise<DrawerVisualAsset[]>;
  presetAssets?: DrawerVisualAsset[];
  presetsLoading?: boolean;
  onReloadPresets?: () => void | Promise<void>;
  canManagePresets?: boolean;
  onPublishPreset?: (asset: DrawerVisualAsset) => Promise<boolean>;
  onDisablePreset?: (asset: DrawerVisualAsset) => Promise<boolean>;
  onApply: (mutation: DrawerVisualAssetMutation, saveToLibrary: boolean) => Promise<boolean>;
}

export type ImportReferenceImage = { assetId: string; storageKey: string; previewUrl: string; name: string };
export type AssetDraft = StoryboardVisualAssetDraft;
const roles: { value: DrawerVisualAssetRole; label: string }[] = [
  { value: 'character', label: '人物' }, { value: 'pet', label: '宠物' },
  { value: 'environment', label: '场景' }, { value: 'prop', label: '道具 / 商品' },
];
const referenceCategories = [
  { value: 'character', label: '人物' }, { value: 'pet', label: '宠物' },
  { value: 'prop', label: '道具' }, { value: 'product', label: '产品' },
] as const;
const categoryPatch = (category: string): Pick<AssetDraft, 'role' | 'customCategory'> => ({ role: category === 'product' ? 'prop' : category as DrawerVisualAssetRole, customCategory: category === 'product' ? '产品' : '' });
const roleLabel = (role: DrawerVisualAssetRole) => roles.find(item => item.value === role)?.label || '参考';
const createDraft = (role: DrawerVisualAssetRole): AssetDraft => ({ planId: `asset_${crypto.randomUUID()}`, role, name: roleLabel(role), prompt: '', tagsText: '', customCategory: '' });
const roleIcon = (role: DrawerVisualAssetRole) => role === 'character' ? <UserRound className="svad-role-icon" /> : role === 'pet' ? <PawPrint className="svad-role-icon" /> : role === 'environment' ? <Trees className="svad-role-icon" /> : <Package className="svad-role-icon" />;

export function StoryboardVisualAssetsDrawer(props: StoryboardVisualAssetsDrawerProps) {
  const page = props.presentation === 'page';
  const scope = props.projectId + ':' + (props.targetSlotId || '');
  const activeScope = useRef(scope);
  const initializedScope = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const lock = useRef(false);
  const draftsRef = useRef<AssetDraft[]>([]);
  const [mounted, setMounted] = useState(false);
  const [drafts, setDrafts] = useState<AssetDraft[]>([]);
  const [generated, setGenerated] = useState<DrawerVisualAsset[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [creatorId, setCreatorId] = useState<string | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [newCategory, setNewCategory] = useState('character');
  const [useIdentityReferences, setUseIdentityReferences] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState('');
  const [source, setSource] = useState<'all' | 'personal' | 'platform'>('all');
  const [filter, setFilter] = useState<DrawerVisualAssetRole | 'all'>('all');
  const [search, setSearch] = useState('');
  const [metadataEdits, setMetadataEdits] = useState<Record<string, Partial<DrawerVisualAsset>>>({});
  const [preview, setPreview] = useState<{ previewUrl: string; name: string } | null>(null);
  const previewRef = useRef<HTMLDialogElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importImages, setImportImages] = useState<ImportReferenceImage[]>([]);
  const [importOffset, setImportOffset] = useState<number | null>(null);
  const [importImage, setImportImage] = useState<ImportReferenceImage | null>(null);
  const [importRole, setImportRole] = useState<DrawerVisualAssetRole | ''>('');
  const [importName, setImportName] = useState('');
  const [importPrompt, setImportPrompt] = useState('');
  const titleId = useId();
  const previewTitleId = useId();
  const busy = props.generating || props.saving || actionBusy || Boolean(busyPlan);
  const pending = props.pendingRecoveryCount || 0;
  const editable = props.canGenerate !== false && !busy;
  const sameScope = (requested: string) => mountedRef.current && activeScope.current === requested;
  useEffect(() => { mountedRef.current = true; setMounted(true); return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    activeScope.current = scope;
    if (props.canGenerate === false || initializedScope.current === scope) return;
    initializedScope.current = scope;
    const restored = props.initialDrafts !== undefined ? structuredClone(props.initialDrafts) : page ? [] : [createDraft('character'), createDraft('pet')];
    if (!page && props.initialDrafts === undefined) props.onDraftsChange?.(structuredClone(restored));
    draftsRef.current = restored; setDrafts(restored); setGenerated([]); setCollapsed(false); setCreatorId(null);
    setLocalError(''); setNotice(''); setImportOpen(false); setImportImages([]); setImportImage(null);
    setFilter('all'); setSource('all'); setSearch(''); setMetadataEdits({});
    setNewCategory('character'); setUseIdentityReferences({});
    // Parent draft updates acknowledge edits; only a context change reinitializes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, props.canGenerate]);
  useEffect(() => {
    const dialog = previewRef.current;
    if (!dialog) return;
    if (!preview || !props.open) { dialog.close(); return; }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, [preview, props.open, mounted]);
  const changeDrafts = (update: (current: AssetDraft[]) => AssetDraft[]) => {
    if (!editable) return;
    const next = update(draftsRef.current);
    if (next.length > 32) { setLocalError('最多保留32项参考草稿。'); return; }
    draftsRef.current = next; setDrafts(next); props.onDraftsChange?.(structuredClone(next));
  };
  const updateDraft = (id: string, patch: Partial<AssetDraft>) => changeDrafts(items => items.map(item => item.planId === id ? { ...item, ...patch } : item));
  const inputOf = (draft: AssetDraft): DrawerVisualAssetInput => ({ role: draft.role, prompt: draft.prompt, planId: draft.planId, ...parseDrawerAssetMetadata(draft.name.trim() || roleLabel(draft.role), draft.tagsText, draft.customCategory) });
  const { candidates: visibleCandidates, selectedAssets: visibleSelectedAssets, projectId: visibleProjectId, onVisibleCandidatesChange } = props;
  useEffect(() => {
    const ids = Object.fromEntries(drafts.flatMap(draft => {
      const candidate = visibleStoryboardReference(draft.planId, visibleProjectId, generated, visibleCandidates, visibleSelectedAssets);
      return candidate ? [[draft.planId, candidate.assetId]] : [];
    }));
    onVisibleCandidatesChange?.(visibleProjectId, ids);
  }, [drafts, generated, visibleCandidates, visibleSelectedAssets, visibleProjectId, onVisibleCandidatesChange]);
  const allAssets = [...new Map([...props.candidates, ...generated, ...props.selectedAssets, ...(props.presetAssets || []).map(asset => ({ ...asset, source: 'platform-preset' as const }))].map(asset => [asset.assetId, asset])).values()];
  const remember = (assets: DrawerVisualAsset[]) => setGenerated(items => [...items.filter(item => !assets.some(asset => asset.planId === item.planId)), ...assets]);
  const perform = async (operation: () => Promise<void>) => {
    if (lock.current || busy) return;
    lock.current = true; setActionBusy(true); setLocalError(''); setNotice('');
    const requested = scope;
    try { await operation(); }
    catch (error) {
      if (!sameScope(requested)) return;
      // 用户取消不是失败：明确告知未提交、未扣费，避免误以为出错
      if (error instanceof Error && error.message === "USER_CANCELLED") setNotice('已取消，本次未生成、未扣费。');
      else setLocalError(error instanceof Error ? error.message : '操作未确认，原内容已保留。');
    }
    finally { lock.current = false; if (sameScope(requested)) { setActionBusy(false); setBusyPlan(null); } }
  };
  const generate = (draft: AssetDraft) => {
    if (!editable || props.generationIssue || pending || props.pendingUploads?.some(item => item.planId === draft.planId) || !draft.prompt.trim()) return;
    const requested = scope;
    void perform(async () => {
      setBusyPlan(draft.planId);
      const applied = props.selectedAssets.find(asset => asset.planId === draft.planId);
      const result = await props.onGenerate(storyboardFirstThreeViewInput(inputOf(draft), undefined,
        useIdentityReferences[draft.planId] ? applied?.assetId : undefined));
      if (!sameScope(requested)) return;
      if (!result?.previewUrl) throw new Error('结果尚未确认，候选保留。请查询原请求。');
      remember([result]); setNotice('参考图已生成；图片下方显示实际关联的分段，可另存图库。');
    });
  };
  const upload = (draft: AssetDraft, file?: File) => {
    if (!editable || !props.onUploadReference) return;
    const requested = scope;
    // Register stable default slots before the parent freezes the upload context.
    props.onDraftsChange?.(structuredClone(draftsRef.current));
    void perform(async () => {
      setBusyPlan(draft.planId);
      const result = await props.onUploadReference!(file, inputOf(draft));
      if (!sameScope(requested)) return;
      if (!result) throw new Error('上传图尚未登记为候选；原上传记录已保留，请核对提示。');
      remember([result]); setNotice('参考图已添加；图片下方显示实际关联的分段，可另存图库。');
    });
  };
  const save = (asset: DrawerVisualAsset) => {
    if (!props.onSaveSelected || asset.saved || pending) return;
    const requested = scope;
    void perform(async () => {
      const receipts = await props.onSaveSelected!([asset]);
      if (!sameScope(requested)) return;
      const confirmed = receipts.find(item => item.planId === asset.planId && item.saved);
      if (!confirmed) throw new Error('图库保存未确认，原候选已保留。');
      remember([confirmed]); setNotice('已保存到图库。');
    });
  };
  const applyAsset = (asset: DrawerVisualAsset, slotId: string) => {
    if (props.canApply === false || !slotId) return;
    const requested = scope;
    void perform(async () => {
      if (!await props.onApply({ type: 'upsert', slotId, asset: { ...asset, planId: slotId } }, false)) throw new Error('引用未保存确认，请核对工作台提示，候选仍保留。');
      if (sameScope(requested)) setNotice('已确认项目参考；实际应用段数和项目默认请在工作台核对。');
    });
  };
  const removeBinding = (slotId: string) => {
    if (props.canApply === false) return;
    const requested = scope;
    void perform(async () => {
      if (!await props.onApply({ type: 'remove', slotId }, false)) throw new Error('移除未保存确认，请核对工作台提示。');
      if (sameScope(requested)) setNotice('已移除此项引用，其他参考图保留。');
    });
  };
  const deleteDraft = (draft: AssetDraft) => {
    if (!editable || props.pendingUploads?.some(item => item.planId === draft.planId)) return;
    const requested = scope;
    void perform(async () => {
      setBusyPlan(draft.planId);
      if (props.onDeleteDraft) {
        if (!await props.onDeleteDraft(draft.planId)) throw new Error('参考卡删除未保存确认，原卡片已保留。');
      } else if (props.selectedSlotIds?.includes(draft.planId) || props.selectedAssets.some(asset => asset.planId === draft.planId)) {
        throw new Error('此参考卡仍被项目引用，请返回分镜工作台删除。');
      }
      if (!sameScope(requested)) return;
      changeDrafts(items => items.filter(item => item.planId !== draft.planId));
      setGenerated(items => items.filter(item => item.planId !== draft.planId));
      if (creatorId === draft.planId) setCreatorId(null);
      setNotice('已删除参考卡，图库原图保留。');
    });
  };
  const loadImport = (offset = 0) => {
    if (!props.onLoadImportImages) return;
    const requested = scope;
    void perform(async () => {
      const result = await props.onLoadImportImages!(offset);
      if (!sameScope(requested)) return;
      setImportImages(items => offset ? [...new Map([...items, ...result.assets].map(item => [item.assetId, item])).values()] : result.assets);
      setImportOffset(result.nextOffset); setImportOpen(true);
    });
  };
  const confirmImport = () => {
    if (!importImage || !importRole || !importName.trim() || !props.onImportImage || props.canGenerate === false) return;
    const requested = scope;
    void perform(async () => {
      const slot = drafts.find(item => item.planId === props.targetSlotId);
      const planId = slot?.planId || createDraft(importRole).planId;
      if (!slot) changeDrafts(items => [...items, { ...createDraft(importRole), planId, name: importName.trim(), prompt: importPrompt }]);
      const candidate = await props.onImportImage!(importImage, { role: importRole, name: importName.trim(), prompt: importPrompt, planId });
      if (!sameScope(requested)) return;
      if (!candidate) throw new Error('导入未保存，原选择保留。');
      remember([candidate]); setImportOpen(false); setNotice('参考图已添加；图片下方显示实际采用与分段关联状态。');
      setCreatorId(planId);
    });
  };
  const usageLabel = (planId: string) => {
    const segments = props.assetUsageSegments?.[planId];
    if (segments) return segments.length ? `已用于分段 ${segments.join('、')}` : '已采用，尚未绑定分段';
    return `已应用 ${props.assetUsageCounts?.[planId] || 0} 段`;
  };
  const renderDraft = (draft: AssetDraft) => {
    const result = visibleStoryboardReference(draft.planId, props.projectId, generated, props.candidates, props.selectedAssets);
    const applied = props.selectedAssets.find(asset => asset.planId === draft.planId);
    const resultApplied = sameStoryboardVisualAssetIdentity(applied, result, props.projectId);
    const selectedSlot = props.selectedSlotIds?.includes(draft.planId) || Boolean(applied);
    const uploadPending = props.pendingUploads?.find(item => item.planId === draft.planId);
    const cardEditable = editable && !uploadPending;
    const prompt = <label className="svad-prompt-label">参考图提示词<textarea aria-label={`${roleLabel(draft.role)}参考提示词`} rows={6} value={draft.prompt} disabled={!cardEditable} placeholder={`粘贴${roleLabel(draft.role)}参考提示词…`} onChange={event => updateDraft(draft.planId, { prompt: event.target.value })} /></label>;
    return <section className="svad-reference-slot" key={draft.planId} data-plan-id={draft.planId} data-role={draft.role} aria-label={`${roleLabel(draft.role)}参考接收卡`}>
      <div className="svad-draft-heading"><strong>{roleIcon(draft.role)}{draft.name || roleLabel(draft.role)}<small>{draft.role === 'character' || draft.role === 'pet' ? '身份参考' : '可选'}</small></strong>
        <button type="button" className="svad-text-button svad-delete-draft" aria-label={`删除${draft.name || roleLabel(draft.role)}参考卡`} disabled={!cardEditable || Boolean(uploadPending) || (!props.onDeleteDraft && Boolean(selectedSlot))} onClick={() => deleteDraft(draft)}>删除</button>
        <details className="svad-draft-options"><summary aria-label={`${roleLabel(draft.role)}参考设置`}>设置</summary><div className="svad-metadata-fields">
          <label>名称（选填）<input aria-label="名称" value={draft.name} maxLength={100} disabled={!cardEditable} onChange={event => updateDraft(draft.planId, { name: event.target.value })} /></label>
          <label>类别<select aria-label="参考类别" value={draft.role === 'prop' && draft.customCategory === '产品' ? 'product' : draft.role} disabled={!cardEditable || Boolean(selectedSlot) || Boolean(uploadPending)} onChange={event => updateDraft(draft.planId, categoryPatch(event.target.value))}>{draft.role === 'environment' && <option value="environment">场景</option>}{referenceCategories.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
          <label>图库标签（选填）<input value={draft.tagsText} disabled={!cardEditable} onChange={event => updateDraft(draft.planId, { tagsText: event.target.value })} /></label>
          <label>自定义分类<input value={draft.customCategory} maxLength={40} disabled={!cardEditable} onChange={event => updateDraft(draft.planId, { customCategory: event.target.value })} /></label>

        </div></details>
      </div>
      {result ? <><div className="svad-slot-result" data-asset-id={result.assetId}><button type="button" className="svad-image-button" aria-label={`放大查看${result.name}`} onClick={() => setPreview(result)}><img src={result.previewUrl} alt={`${result.name}参考图`} /><span>放大预览</span></button><small>{resultApplied ? usageLabel(draft.planId) : applied ? '替换候选 · 当前参考仍生效，确认替换后更新关联' : '候选 · 尚未采用，点击“使用这张”后关联分镜'} · {result.saved ? '已存图库' : '项目图片（未存图库）'}</small></div><details className="svad-slot-prompt"><summary>编辑提示词</summary>{prompt}</details></> : prompt}
      {!selectedSlot && !result && <small role="status">待生成或从图库选择参考图</small>}
      {selectedSlot && !applied && <small role="status">项目已选择此参考，当前来源暂不可读取；可以重新选择同类图片或移除引用。</small>}
      <div className="svad-slot-actions">
        {result && <>{Boolean(props.projectId) && !resultApplied && <button type="button" className="svad-primary" disabled={busy || Boolean(uploadPending) || props.canApply === false} onClick={() => applyAsset(result, draft.planId)}>{applied ? '替换当前参考' : '使用这张'}</button>}{!result.saved && <button type="button" className="svad-secondary" disabled={busy || result.saved || !props.onSaveSelected} onClick={() => { try { save({ ...result, ...inputOf(draft) }); } catch (error) { setLocalError(error instanceof Error ? error.message : "请核对参考信息。"); } }}>保存到图库</button>}</>}
        <button type="button" className="svad-secondary" disabled={!cardEditable || Boolean(props.generationIssue) || pending > 0 || !props.modelName || !draft.prompt.trim()} onClick={() => generate(draft)}>{busyPlan === draft.planId ? '生成中…' : draft.role === 'character' || draft.role === 'pet' ? result ? '重新生成三视图' : '生成三视图' : result ? '重新生成' : '生成参考图'}</button>
        {(draft.role === 'character' || draft.role === 'pet') && <>
          {applied && <label><input type="checkbox" checked={Boolean(useIdentityReferences[draft.planId])} disabled={!cardEditable} onChange={event => setUseIdentityReferences(values => ({ ...values, [draft.planId]: event.target.checked }))} />使用已选图片辅助保持身份（可选）</label>}
        </>}
        {applied?.derivedFromAssetId && <small role="status">当前参考已是衍生三视图；原主图与历史结果仍保留。</small>}
        {props.onUploadReference && <><input type="file" accept="image/png,image/jpeg,image/webp" data-testid="reference-native-upload" aria-label={`上传${roleLabel(draft.role)}参考图`} className="hidden" disabled={!cardEditable || Boolean(uploadPending)} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) upload(draft, file); }} />
          <button type="button" className="svad-text-button" disabled={!cardEditable || Boolean(uploadPending)} onClick={event => (event.currentTarget.previousElementSibling as HTMLInputElement | null)?.click()}>上传参考图</button></>}
        {uploadPending?.canRead && <button type="button" className="svad-text-button" data-testid="reference-upload-read" disabled={!editable} onClick={() => upload(draft)}>重新读取上传图</button>}
        {uploadPending?.unknown && <small role="status">上传结果待确认，请到我的图片核对原图，勿重复上传。</small>}
        {!page && <button type="button" className="svad-text-button" disabled={busy || props.canApply === false} onClick={() => void props.onOpenLibrary?.(draft.planId, structuredClone(draftsRef.current))}>从图库选择</button>}

        {selectedSlot && <button type="button" className="svad-text-button" disabled={busy || props.canApply === false} onClick={() => removeBinding(draft.planId)}>移除引用</button>}
      </div>
    </section>;
  };
  if (!mounted) return null;
  const library = allAssets.filter(asset => (asset.saved || asset.source === 'platform-preset') && (source === 'all' || (source === 'platform') === (asset.source === 'platform-preset')) && (filter === 'all' || asset.role === filter) && drawerAssetMatchesSearch(asset, search));
  const creator = drafts.find(item => item.planId === creatorId);
  return <><section className={`svad-surface ${page ? 'svad-page' : 'svad-inline'}`} aria-labelledby={titleId}>
    <header className="svad-header"><div className="svad-header-row"><h2 id={titleId}>{page ? '参考图库' : '第一步 · 角色参考'}</h2><div className="svad-header-actions">
      {page ? <><button type="button" className="svad-secondary" disabled={!editable} onClick={() => { const draft = drafts.find(item => !item.prompt.trim() && !allAssets.some(asset => asset.planId === item.planId)) || createDraft('character'); if (!drafts.some(item => item.planId === draft.planId)) changeDrafts(items => [...items, draft]); setCreatorId(draft.planId); }}>制作参考图</button><button type="button" className="svad-secondary" disabled={busy} onClick={props.onReturn}>返回分镜工作台</button></> : <button type="button" className="svad-secondary" onClick={() => setCollapsed(value => !value)}>{collapsed ? '展开参考创作' : '收起参考创作'}</button>}
    </div></div><p className="svad-context-line">{page ? props.targetSlotId ? '选择该参考位置的图片，保留各段落的参考选择' : '我的参考图与平台样板，按类别选择' : props.continuesInWorkbench ? '角色三视图 → 逐张查看并点击“使用这张” → 本页连续制作分镜图和视频，无需返回智能体对话。' : props.requiresExplicitAdoption ? '生成角色三视图 → 查看图片并点击“使用这张” → 人物与宠物均确认后复制续写卡。' : '粘贴提示词 → 首张参考图自动关联 → 分镜生图 → 该段分镜图生成视频。每段可单独选择；已有参考重新生成后需确认替换。'}</p></header>
    {(props.error || localError) && <div className="svad-error" role="alert">{props.error || localError}</div>}{notice && <p role="status" className="svad-batch-status">{notice}</p>}
    {props.generationIssue && <p role="status" className="svad-context-line">{props.generationIssue}</p>}
    {pending > 0 && <div className="svad-recovery"><span>有{pending}个原请求待确认</span><button type="button" disabled={busy} onClick={() => void perform(async () => { await props.onRecoverPending?.(); })}>查询原请求</button></div>}
    {!page && (collapsed ? <div className="svad-bound-assets">{props.selectedAssets.map(asset => <button className="svad-bound-item" type="button" key={asset.planId} onClick={() => setPreview(asset)}><img src={asset.previewUrl} alt={asset.name} /><span>{asset.name} · {usageLabel(asset.planId)}</span></button>)}</div> : <><div className="svad-drafts">{drafts.map(renderDraft)}</div><div className="svad-add-reference"><label>参考类别<select aria-label="添加参考卡类别" value={newCategory} disabled={!editable} onChange={event => setNewCategory(event.target.value)}>{referenceCategories.map(category => <option key={category.value} value={category.value}>{category.label}</option>)}</select></label><button type="button" className="svad-text-button" disabled={!editable || drafts.length >= 32} onClick={() => { const category = categoryPatch(newCategory); const draft = { ...createDraft(category.role), ...category, name: referenceCategories.find(item => item.value === newCategory)?.label || '参考' }; changeDrafts(items => [...items, draft]); }}>＋添加参考卡</button></div></>)}
    {page && (creator ? <section className="svad-single-creator" aria-label="制作参考图"><div className="svad-create-actions"><button type="button" className="svad-secondary" disabled={busy} onClick={() => setCreatorId(null)}>返回图库</button></div>{props.modelControls}<label className="svad-creator-category">参考类别<select aria-label="制作参考类别" value={creator.role} disabled={!editable || Boolean(props.pendingUploads?.some(item => item.planId === creator.planId)) || Boolean(props.selectedSlotIds?.includes(creator.planId)) || props.selectedAssets.some(asset => asset.planId === creator.planId)} onChange={event => updateDraft(creator.planId, { role: event.target.value as DrawerVisualAssetRole })}>{roles.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>{renderDraft(creator)}</section> : <>
      <div className="svad-library-tools"><label>搜索<input aria-label="搜索参考图库" type="search" value={search} onChange={event => setSearch(event.target.value)} /></label><label>类别<select aria-label="图库类别" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">全部</option>{roles.map(role => <option value={role.value} key={role.value}>{role.label}</option>)}</select></label><label className="svad-source-filter">来源<select aria-label="图库来源" value={source} onChange={event => setSource(event.target.value as typeof source)}><option value="all">全部来源</option><option value="personal">我的参考图</option><option value="platform">平台样板</option></select></label><button type="button" className="svad-secondary" disabled={busy} onClick={() => void perform(async () => { await props.onReload(); await props.onReloadPresets?.(); })}>刷新</button>{props.onLoadImportImages && <button type="button" className="svad-secondary" data-testid="reference-import-open" disabled={busy} onClick={() => loadImport()}>从我的图片导入</button>}</div>
      <div className="svad-assets">{library.map(asset => <article className="svad-asset" data-asset-id={asset.assetId} key={asset.assetId}><button type="button" className="svad-image-button" aria-label={`放大查看${asset.name}`} onClick={() => setPreview(asset)}><img src={asset.previewUrl} alt={asset.name} loading="lazy" /></button><strong>{asset.name}</strong><p className="svad-muted">{roleLabel(asset.role)} · {asset.source === 'platform-preset' ? '平台样板' : '我的参考图'}</p>{asset.source !== 'platform-preset' && props.onUpdateAsset && <details className="svad-draft-options"><summary>编辑参考信息</summary><div className="svad-metadata-fields"><label>名称<input aria-label="图库参考名称" value={metadataEdits[asset.assetId]?.name ?? asset.name} maxLength={120} disabled={busy} onChange={event => setMetadataEdits(items => ({ ...items, [asset.assetId]: { ...items[asset.assetId], name: event.target.value } }))} /></label><label>自定义分类<input aria-label="图库自定义分类" value={metadataEdits[asset.assetId]?.customCategory ?? asset.customCategory ?? ''} maxLength={40} disabled={busy} onChange={event => setMetadataEdits(items => ({ ...items, [asset.assetId]: { ...items[asset.assetId], customCategory: event.target.value } }))} /></label><label>标签<input aria-label="图库参考标签" value={(metadataEdits[asset.assetId]?.tags ?? asset.tags ?? []).join('，')} disabled={busy} onChange={event => setMetadataEdits(items => ({ ...items, [asset.assetId]: { ...items[asset.assetId], tags: event.target.value.split(/[，,]/u).map(tag => tag.trim()).filter(Boolean) } }))} /></label><button type="button" className="svad-secondary" disabled={busy} onClick={() => void perform(async () => { const updated = { ...asset, ...metadataEdits[asset.assetId] }; if (!await props.onUpdateAsset!(updated)) throw new Error('参考信息保存未确认，编辑内容保留。'); })}>保存参考信息</button></div></details>}{props.targetSlotId && <button type="button" className="svad-primary" disabled={busy || props.canApply === false} onClick={() => applyAsset(asset, props.targetSlotId!)}>确认使用</button>}</article>)}</div>
      {!library.length && !props.loading && <p className="svad-empty">暂无符合条件的参考图</p>}{props.hasMore && <button type="button" disabled={busy} onClick={() => void perform(async () => { await props.onLoadMore?.(); })}>加载更多</button>}
      {importOpen && <section className="svad-import" aria-label="从我的图片导入"><button type="button" className="svad-secondary" disabled={busy} onClick={() => setImportOpen(false)}>关闭图片导入</button><div className="svad-assets">{importImages.map(image => <article className="svad-asset" data-import-asset-id={image.assetId} key={image.assetId}><button type="button" className="svad-image-button" onClick={() => setPreview(image)}><img src={image.previewUrl} alt={image.name} /></button><label><input type="radio" name="import-reference" aria-label={`选择图片库图片 ${image.name}`} checked={importImage?.assetId === image.assetId} disabled={busy} onChange={() => { setImportImage(image); setImportName(image.name); }} />{image.name}</label></article>)}</div>{importOffset !== null && <button type="button" disabled={busy} onClick={() => loadImport(importOffset)}>加载更多图片</button>}<label>类别<select aria-label="导入图片类别" value={importRole} disabled={busy} onChange={event => setImportRole(event.target.value as typeof importRole)}><option value="">请选择</option>{roles.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label><label>名称<input aria-label="导入图片名称" value={importName} maxLength={100} disabled={busy} onChange={event => setImportName(event.target.value)} /></label><label>提示词（可选）<textarea aria-label="导入图片提示词（可选）" value={importPrompt} disabled={busy} onChange={event => setImportPrompt(event.target.value)} /></label><button type="button" data-testid="reference-import-confirm" className="svad-primary" disabled={busy || !importImage || !importRole || !importName.trim() || props.canGenerate === false} onClick={confirmImport}>添加为候选</button></section>}
      {(drafts.length > 0 || allAssets.some(asset => !asset.saved)) && <section className="svad-existing" aria-label="继续制作"><h3>继续制作</h3>{drafts.map(draft => <button type="button" className="svad-secondary" key={draft.planId} data-draft-plan-id={draft.planId} disabled={busy} onClick={() => setCreatorId(draft.planId)}>{draft.name} · {allAssets.some(asset => asset.planId === draft.planId && !asset.saved) ? '查看候选' : '继续编辑'}</button>)}{allAssets.filter(asset => !asset.saved && !drafts.some(draft => draft.planId === asset.planId)).map(asset => <button type="button" className="svad-secondary" key={asset.assetId} data-asset-id={asset.assetId} disabled={!editable} onClick={() => { const draft = { planId: asset.planId, role: asset.role, name: asset.name, prompt: asset.prompt || '', tagsText: (asset.tags || []).join('，'), customCategory: asset.customCategory || '' }; changeDrafts(items => [...items, draft]); setCreatorId(draft.planId); }}>{asset.name} · 查看候选</button>)}</section>}
    </>)}
  </section>{createPortal(<dialog ref={previewRef} className="svad-preview" aria-labelledby={previewTitleId} onCancel={event => { event.preventDefault(); setPreview(null); }}><header><h2 id={previewTitleId}>{preview?.name || '参考图预览'}</h2><button type="button" className="svad-icon-button" aria-label="关闭大图预览" onClick={() => setPreview(null)}>×</button></header>{preview && <img src={preview.previewUrl} alt={`${preview.name}完整参考图`} />}</dialog>, document.body)}</>;
}
