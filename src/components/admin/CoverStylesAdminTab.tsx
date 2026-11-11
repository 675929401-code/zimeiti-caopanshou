"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import type { CoverStyleDraftInput, CoverWorkflowDraftInput } from "@/lib/server/cover-style-config";
import type { coverStyleAdminDto } from "@/lib/server/cover-style-store";
import type { CoverAdminPreviewInput, CoverAdminRuntimePreview, CoverAnalysisModelOption } from "@/lib/server/cover-admin-runtime";
import styles from "./CoverStylesAdminTab.module.css";

type Catalog = ReturnType<typeof coverStyleAdminDto> & { modelOptions?: CoverAnalysisModelOption[]; modelOptionsUnavailable?: boolean };
type Props = { token: string; canEdit: boolean; unlocked: boolean; onDirtyChange?: (dirty: boolean) => void };
type ReadOptions = { styleKey?: string; releaseId?: string; workflowReleaseId?: string; replaceWorkflow?: boolean; replaceStyle?: boolean };
const emptyStyle = (): CoverStyleDraftInput => ({ displayName: "", description: "", analysisPrompt: "", generationPrompt: "", completeRules: true });
const emptyWorkflow = (): CoverWorkflowDraftInput => ({ sharedRules: "", textModelId: null, imageModelId: null });
const errorText = (error: unknown) => error instanceof Error ? error.message : "读取失败，请稍后重试";
const styleEditor = (data: Catalog): CoverStyleDraftInput | null => data.selected?.editable ?? null;
const workflowEditor = (data: Catalog): CoverWorkflowDraftInput => ({ sharedRules: data.workflow.viewed.sharedRules, textModelId: data.workflow.viewed.textModelId, imageModelId: data.workflow.viewed.imageModelId });
const modelName = (id: string | null, options: CoverAnalysisModelOption[]) => id === null ? "自动选择当前可用模型" : options.find(option => option.id === id)?.displayName ?? "原选模型当前不在可用目录中";
const modeLabels: Record<CoverAdminPreviewInput["mode"], string> = { script: "纯文字口播", product: "商品介绍", reference: "参考图片", compose: "多图智能合成" };

export function CoverStylesAdminTab({ token, canEdit, unlocked, onDirtyChange }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState(""), [styleKey, setStyleKey] = useState("");
  const [styleDraft, setStyleDraft] = useState<CoverStyleDraftInput>(emptyStyle), [workflowDraft, setWorkflowDraft] = useState<CoverWorkflowDraftInput>(emptyWorkflow);
  const [currentStyle, setCurrentStyle] = useState<CoverStyleDraftInput | null>(null);
  const [styleDirty, setStyleDirty] = useState(false), [workflowDirty, setWorkflowDirty] = useState(false);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState(""), [readError, setReadError] = useState(false);
  const [preview, setPreview] = useState<CoverAdminRuntimePreview | null>(null), [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState("");
  const [previewMode, setPreviewMode] = useState<CoverAdminPreviewInput["mode"]>("script"), [previewSource, setPreviewSource] = useState<"current" | "editor">("current");
  const [previewText, setPreviewText] = useState("忙碌一天后，我把手机放到桌上，认真听家人说话。那些被回应的小事，让关系慢慢变暖。");
  const writeLock = useRef(false), readSequence = useRef(0), previewSequence = useRef(0), accessSequence = useRef(0);
  const dirty = styleDirty || workflowDirty;
  const invalidateReads = useCallback(() => { readSequence.current++; }, []);
  const clearPreview = useCallback(() => { previewSequence.current++; setPreview(null); setPreviewError(""); setPreviewBusy(false); }, []);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const load = useCallback(async (options: ReadOptions = {}) => {
    const sequence = ++readSequence.current;
    setReading(true); setReadError(false);
    const fetchCatalog = async (key?: string, releaseId?: string) => {
      const query = new URLSearchParams();
      if (key) query.set("styleKey", key);
      if (releaseId) query.set("releaseId", releaseId);
      if (options.workflowReleaseId) query.set("workflowReleaseId", options.workflowReleaseId);
      const response = await fetch(`/api/admin/cover-styles?${query}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const data = await response.json();
      if (sequence !== readSequence.current) return null;
      if (!response.ok) throw new Error(data.error || "制作配置读取失败");
      return data as Catalog;
    };
    try {
      let data = await fetchCatalog(options.styleKey, options.releaseId);
      if (!data) return;
      if (!options.styleKey && options.replaceStyle !== false && data.styles[0]) { data = await fetchCatalog(data.styles[0].styleKey); if (!data) return; }
      let activeStyle = styleEditor(data);
      if (options.replaceStyle !== false && data.selected?.currentReleaseId && data.selected.currentReleaseId !== data.selected.viewed?.releaseId) {
        const current = await fetchCatalog(data.selected.styleKey, data.selected.currentReleaseId);
        if (!current) return;
        activeStyle = styleEditor(current);
      }
      if (sequence !== readSequence.current) return;
      const loadedData = data;
      setCatalog(previous => ({ ...loadedData,
        ...(options.replaceStyle === false && previous ? { selected: previous.selected } : {}),
        ...(options.replaceWorkflow === false && previous ? { workflow: previous.workflow } : {}),
      }));
      setUncertain(false); clearPreview();
      if (options.replaceStyle !== false) {
        const editable = styleEditor(data);
        setSelected(data.selected?.styleKey ?? ""); setStyleKey(data.selected?.styleKey ?? "");
        setStyleDraft(editable ? { ...editable, completeRules: true } : emptyStyle()); setCurrentStyle(activeStyle); setStyleDirty(false);
      }
      if (options.replaceWorkflow !== false) { setWorkflowDraft(workflowEditor(data)); setWorkflowDirty(false); }
      return data;
    } catch (error) { if (sequence === readSequence.current) { setMessage(errorText(error)); setReadError(true); } }
    finally { if (sequence === readSequence.current) setReading(false); }
  }, [clearPreview, token]);

  useEffect(() => {
    accessSequence.current++;
    if (!unlocked) {
      invalidateReads(); clearPreview(); setCatalog(null); setCurrentStyle(null); setStyleDraft(emptyStyle()); setWorkflowDraft(emptyWorkflow());
      setStyleDirty(false); setWorkflowDirty(false); setReading(false); return;
    }
    void load();
    return () => { accessSequence.current++; invalidateReads(); previewSequence.current++; };
  }, [clearPreview, invalidateReads, load, unlocked]);

  const changeStyle = (name: keyof CoverStyleDraftInput, value: string) => { invalidateReads(); clearPreview(); setStyleDraft(previous => ({ ...previous, [name]: value, completeRules: true })); setStyleDirty(true); };
  const changeWorkflow = (patch: Partial<CoverWorkflowDraftInput>) => { invalidateReads(); clearPreview(); setWorkflowDraft(previous => ({ ...previous, ...patch })); setWorkflowDirty(true); };
  const selectStyle = (key: string) => { if (busy || reading || (styleDirty && !window.confirm("当前风格有尚未保存的修改，是否切换？"))) return; setMessage(""); void load({ styleKey: key, replaceWorkflow: false }); };
  const chooseNew = () => {
    if (busy || reading || (styleDirty && !window.confirm("当前风格有尚未保存的修改，是否新建？"))) return;
    invalidateReads(); clearPreview(); setSelected(""); setStyleKey(""); setStyleDraft(emptyStyle()); setCurrentStyle(null); setStyleDirty(false); setMessage("");
  };
  const reload = () => {
    if (busy || reading || (dirty && !window.confirm("读取最新状态会放弃尚未保存的修改，是否继续？"))) return;
    void load({ styleKey: selected || undefined }).then(data => { if (data) setMessage("已读取最新状态，请核对当前发布与草稿。"); });
  };
  const mutate = async (payload: Record<string, unknown>) => {
    if (!catalog || !canEdit || !unlocked || reading || writeLock.current || uncertain) return;
    const access = accessSequence.current;
    invalidateReads(); clearPreview(); writeLock.current = true; setBusy(true); setMessage(""); setReadError(false);
    let responseReceived = false;
    try {
      const response = await fetch("/api/admin/cover-styles", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...payload, expectedRevision: catalog.revision, expectedHash: catalog.hash }) });
      const data = await response.json().catch(() => null) as (Catalog & { ok?: boolean; error?: string; outcome?: string }) | null;
      responseReceived = true;
      if (access !== accessSequence.current) return;
      if (!response.ok || !data?.ok) { if (data?.outcome === "unknown" || !data || response.status >= 500) setUncertain(true); throw new Error(data?.error || "保存结果待核对，请先读取最新状态，不要重复提交"); }
      const workflowAction = String(payload.action).startsWith("workflow-");
      setCatalog(workflowAction ? { ...data, selected: catalog.selected }
        : { ...data, workflow: catalog.workflow, ...(!data.selected ? { selected: catalog.selected } : {}) });
      if (workflowAction) { setWorkflowDraft(workflowEditor(data)); setWorkflowDirty(false); }
      else if (["draft", "publish", "rollback"].includes(String(payload.action)) && data.selected?.viewed) {
        const editable = styleEditor(data); setSelected(data.selected.styleKey); setStyleKey(data.selected.styleKey);
        if (editable) setStyleDraft({ ...editable, completeRules: true });
        if (data.selected.viewed.releaseId === data.selected.currentReleaseId) setCurrentStyle(editable);
        else if (payload.action === "rollback" && data.selected.currentReleaseId) {
          // Rollback leaves an unrelated draft intact, so the default viewed
          // release can still be that draft. Read only the committed target for
          // the current-content summary; never replace either editor here.
          setCurrentStyle(null);
          try {
            const query = new URLSearchParams({ styleKey: data.selected.styleKey, releaseId: data.selected.currentReleaseId });
            const currentResponse = await fetch(`/api/admin/cover-styles?${query}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
            const current = await currentResponse.json() as Catalog;
            if (access !== accessSequence.current) return;
            if (currentResponse.ok && current.selected?.viewed?.releaseId === data.selected.currentReleaseId) setCurrentStyle(styleEditor(current));
            else { setMessage("回退已保存并读回；当前提示词正文暂不可读，请读取最新状态。未保存的其他编辑仍保留。"); setStyleDirty(false); return; }
          } catch {
            if (access !== accessSequence.current) return;
            setMessage("回退已保存并读回；当前提示词正文暂不可读，请读取最新状态。未保存的其他编辑仍保留。"); setStyleDirty(false); return;
          }
        }
        setStyleDirty(false);
      }
      setMessage(String(payload.action).endsWith("draft") ? "新草稿已保存；当前生效规则保持原发布版本。" : "操作已保存并读回。");
    } catch (error) { setMessage(errorText(error)); if (!responseReceived) setUncertain(true); }
    finally { writeLock.current = false; setBusy(false); }
  };
  const move = (index: number, delta: number) => {
    if (!catalog || dirty) return;
    const keys = catalog.styles.map(style => style.styleKey), target = index + delta;
    if (target < 0 || target >= keys.length) return;
    [keys[index], keys[target]] = [keys[target], keys[index]]; void mutate({ action: "reorder", styleKeys: keys });
  };
  const runPreview = async () => {
    if (!unlocked || !catalog || previewBusy || reading || busy) return;
    if (previewSource === "current" && previewMode === "script" && (!styleKey || !catalog.styles.some(style => style.styleKey === styleKey && style.currentVersion))) {
      setPreviewError("此风格尚未发布，请选择已发布风格，或切换到“编辑区内容”预览草稿。"); return;
    }
    const sequence = ++previewSequence.current; setPreviewBusy(true); setPreviewError(""); setPreview(null);
    const input: CoverAdminPreviewInput = { mode: previewMode, text: previewText, ...(styleKey ? { styleKey } : {}),
      ...(previewSource === "editor" ? { workflowDraft, ...(styleKey ? { styleDraft: { ...styleDraft, completeRules: true } } : {}) } : {}) };
    try {
      const response = await fetch("/api/admin/cover-styles", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "preview", ...input }) });
      const data = await response.json(); if (sequence !== previewSequence.current) return;
      if (!response.ok || !data?.ok) throw new Error(data.error || "编译预览暂不可用");
      setPreview(data.preview as CoverAdminRuntimePreview);
    } catch (error) { if (sequence === previewSequence.current) setPreviewError(errorText(error)); }
    finally { if (sequence === previewSequence.current) setPreviewBusy(false); }
  };
  const guardLink = (event: MouseEvent<HTMLAnchorElement>) => { if (dirty && !window.confirm("当前有尚未保存的修改，是否离开封面制作管理？")) event.preventDefault(); };
  const detail = catalog?.selected?.styleKey === selected ? catalog.selected : null, viewed = detail?.viewed;
  const viewedMeta = detail?.releases.find(release => release.releaseId === viewed?.releaseId), selectedRow = catalog?.styles.find(style => style.styleKey === selected);
  const modelOptions = catalog?.modelOptions ?? [], workflow = catalog?.workflow;
  const disabled = busy || reading || !canEdit || !unlocked || uncertain || !catalog, readOnly = !canEdit || uncertain;
  const selectedModelMissing = (id: string | null, vision: boolean) => id !== null && !modelOptions.some(option => option.id === id && (!vision || option.imageParsing));
  const workflowHistoryPublished = workflow?.releases.some(release => release.releaseId === workflow.viewed.releaseId && release.published);

  if (!unlocked) return <div className={styles.locked}>请先完成上方敏感配置验证，再读取封面制作规则。提示词与模型配置仅向已解锁的管理员开放。</div>;
  return <div data-testid="cover-styles-admin" className={styles.root}>
    <header className={styles.header}><div><h2>封面制作管理</h2><p>编辑内容拆解规则、分析模型与风格提示词，检查实际生效内容后发布。</p></div><button className={styles.button} disabled={busy || reading} onClick={reload}>{reading ? "读取中…" : "读取最新状态"}</button></header>
    {message && <p role={readError ? "alert" : "status"} className={styles.notice}>{message}{uncertain && " 当前暂停写入，请先读取最新状态并核对；编辑内容仍保留。"}</p>}
    {!canEdit && <p className={styles.notice}>当前具有查看权限，规则可以选中和复制。修改与发布需要“编辑内部提示词”权限。</p>}
    {catalog?.modelOptionsUnavailable && <p className={styles.notice}>模型目录暂不可读取；已保存的模型标识仍保留，请读取最新状态后再选择模型。</p>}
    <section className={styles.panel} data-testid="cover-workflow-admin">
      <div className={styles.sectionHeading}><div><h3>全局内容拆解</h3><p>适用于口播、商品、参考图与多图合成。这里选择的是文案分析模型；图片生成模型仍在前台单独选择。</p></div><span className={styles.badge}>当前生效 {workflow?.current.version ?? "读取中"}</span></div>
      <div className={styles.currentSummary} data-testid="cover-workflow-current"><div><span>纯文字分析</span><strong>{modelName(workflow?.current.textModelId ?? null, modelOptions)}</strong></div><div><span>含图片分析</span><strong>{modelName(workflow?.current.imageModelId ?? null, modelOptions)}</strong></div><div><span>编辑区状态</span><strong>{workflowDirty ? "尚未保存" : workflow?.viewed.releaseId === workflow?.current.releaseId ? "当前发布内容" : workflow?.viewed.releaseId === workflow?.draft?.releaseId ? "已保存草稿" : "历史快照"}</strong></div></div>
      <div className={styles.modelGrid}>
        <label className={styles.label}>纯文字拆解模型<select data-testid="cover-workflow-text-model" value={workflowDraft.textModelId ?? ""} disabled={disabled || catalog?.modelOptionsUnavailable} onChange={event => changeWorkflow({ textModelId: event.target.value || null })}><option value="">自动选择当前可用模型</option>{selectedModelMissing(workflowDraft.textModelId, false) && <option value={workflowDraft.textModelId!}>原选模型（当前目录不可用，保留原选择）</option>}{modelOptions.map(option => <option key={option.id} value={option.id} disabled={!option.available}>{option.displayName}{!option.available ? ` · ${option.reason || "当前不可用"}` : ""}</option>)}</select><small>用于没有图片的口播与商品介绍；自动选项按当前目录选取。</small></label>
        <label className={styles.label}>含图片拆解模型<select data-testid="cover-workflow-image-model" value={workflowDraft.imageModelId ?? ""} disabled={disabled || catalog?.modelOptionsUnavailable} onChange={event => changeWorkflow({ imageModelId: event.target.value || null })}><option value="">自动选择支持看图的可用模型</option>{selectedModelMissing(workflowDraft.imageModelId, true) && <option value={workflowDraft.imageModelId!}>原选模型（当前看图目录不可用，保留原选择）</option>}{modelOptions.filter(option => option.imageParsing).map(option => <option key={option.id} value={option.id} disabled={!option.available}>{option.displayName}{!option.available ? ` · ${option.reason || "当前不可用"}` : ""}</option>)}</select><small>用于商品照片、参考图和多图合成；需要已发布的图片解析能力。</small></label>
      </div>
      <label className={styles.label}>内容理解与拆解规则<textarea data-testid="cover-workflow-shared-rules" rows={12} maxLength={16_000} spellCheck={false} readOnly={readOnly} disabled={busy || reading || !catalog} value={workflowDraft.sharedRules} onChange={event => changeWorkflow({ sharedRules: event.target.value })} /><small>可修改主旨、重点、关系、标题和选镜的业务要求。JSON 输出结构、来源证据、素材归属与安全协议由平台保持，完整内容可在下方免费预览中查看。</small></label>
      <div className={styles.actions}><button data-testid="cover-workflow-save-draft" className={styles.primaryButton} disabled={disabled || !workflowDirty} onClick={() => void mutate({ action: "workflow-draft", draft: workflowDraft })}>保存拆解规则草稿</button><button data-testid="cover-workflow-publish" className={styles.button} disabled={disabled || workflowDirty || !workflow?.draft || workflow.viewed.releaseId !== workflow.draft.releaseId} onClick={() => void mutate({ action: "workflow-publish" })}>发布拆解规则草稿</button><span>{workflowDirty ? "尚未保存，当前发布内容不受影响" : `正在查看 ${workflow?.viewed.version ?? "—"}`}</span></div>
      {workflow?.draft && <details className={styles.details} data-testid="cover-workflow-publish-review"><summary>发布前检查：当前生效与已保存草稿</summary><div className={styles.comparison}><div><h4>当前生效 {workflow.current.version}</h4><p>文字：{modelName(workflow.current.textModelId, modelOptions)}<br />图片：{modelName(workflow.current.imageModelId, modelOptions)}</p><pre>{workflow.current.sharedRules}</pre></div><div><h4>待发布 {workflow.draft.version}</h4><p>文字：{modelName(workflow.draft.textModelId, modelOptions)}<br />图片：{modelName(workflow.draft.imageModelId, modelOptions)}</p><pre>{workflow.draft.sharedRules}</pre></div></div></details>}
      <details className={styles.details}><summary>当前生效规则与历史版本</summary><pre>{workflow?.current.sharedRules || "配置读取后显示"}</pre><div className={styles.actions}><select data-testid="cover-workflow-history" aria-label="全局拆解历史版本" value={workflow?.viewed.releaseId ?? ""} disabled={busy || reading || workflowDirty} onChange={event => void load({ workflowReleaseId: event.target.value, replaceStyle: false })}>{workflow?.releases.map(release => <option key={release.releaseId} value={release.releaseId}>{release.version} · {release.published ? "曾发布" : "草稿"} · {new Date(release.createdAt).toLocaleString("zh-CN")}</option>)}</select><button className={styles.button} disabled={disabled || workflowDirty || !workflowHistoryPublished || workflow?.viewed.releaseId === workflow?.current.releaseId} onClick={() => workflow && void mutate({ action: "workflow-rollback", releaseId: workflow.viewed.releaseId })}>将此拆解版本设为当前</button></div></details>
    </section>
    <section className={styles.panel}>
      <div className={styles.sectionHeading}><div><h3>纯文字口播的画面风格</h3><p>以下两段完整规则仅用于无图片的口播封面。商品与图片模式由全局拆解规则及其素材约束规划。</p></div><button className={styles.button} disabled={disabled} onClick={chooseNew}>新增风格</button></div>
      <div className={styles.styleGrid}><aside className={styles.styleList}>{catalog?.styles.map((style, index) => <article key={style.styleKey} data-selected={selected === style.styleKey}><button className={styles.styleSelect} disabled={busy || reading} onClick={() => selectStyle(style.styleKey)}><strong>{style.displayName}</strong><span>{style.currentVersion ? `当前 ${style.currentVersion}` : "尚未发布"}{style.draftVersion ? ` · 草稿 ${style.draftVersion}` : ""} · {style.enabled ? "启用" : "停用"}</span></button><div className={styles.rowActions}><button className={styles.button} disabled={disabled || dirty || index === 0} onClick={() => move(index, -1)}>上移</button><button className={styles.button} disabled={disabled || dirty || index === catalog.styles.length - 1} onClick={() => move(index, 1)}>下移</button><button className={styles.button} disabled={disabled || dirty} onClick={() => void mutate({ action: "set-enabled", styleKey: style.styleKey, enabled: !style.enabled })}>{style.enabled ? "停用" : "启用"}</button></div></article>)}</aside>
        <div className={styles.styleEditor}>
          <div className={styles.currentSummary}><div><span>当前生效</span><strong>{selectedRow?.currentVersion || "尚未发布"}</strong></div><div><span>编辑区</span><strong>{styleDirty ? "尚未保存" : viewed ? `${viewed.version} · ${viewed.releaseId === detail?.currentReleaseId ? "当前发布" : viewed.releaseId === detail?.draftReleaseId ? "待发布" : "历史快照"}` : "新风格"}</strong></div></div>
          <div className={styles.modelGrid}><label className={styles.label}>风格标识<input value={styleKey} disabled={Boolean(selected) || disabled} placeholder="例如 warm-editorial" onChange={event => { invalidateReads(); clearPreview(); setStyleKey(event.target.value); setStyleDirty(true); }} /></label><label className={styles.label}>显示名称<input maxLength={60} readOnly={readOnly} disabled={busy || reading || !catalog} value={styleDraft.displayName} onChange={event => changeStyle("displayName", event.target.value)} /></label></div>
          <label className={styles.label}>用户可见说明<textarea rows={2} maxLength={240} readOnly={readOnly} disabled={busy || reading || !catalog} value={styleDraft.description} onChange={event => changeStyle("description", event.target.value)} /></label>
          <label className={styles.label}>内容分析提示词<textarea data-testid="cover-style-analysis-prompt" rows={10} maxLength={50_000} spellCheck={false} readOnly={readOnly} disabled={busy || reading || !catalog} value={styleDraft.analysisPrompt} onChange={event => changeStyle("analysisPrompt", event.target.value)} /><small>包括该风格的语义、标题与选镜要求；这里的完整编辑内容会随草稿一起保存。</small></label>
          <label className={styles.label}>画面生成提示词<textarea data-testid="cover-style-generation-prompt" rows={10} maxLength={50_000} spellCheck={false} readOnly={readOnly} disabled={busy || reading || !catalog} value={styleDraft.generationPrompt} onChange={event => changeStyle("generationPrompt", event.target.value)} /></label>
          <div className={styles.actions}><button className={styles.primaryButton} disabled={disabled || !styleKey || !styleDirty} onClick={() => { if (!selected && catalog?.styles.some(style => style.styleKey === styleKey)) { setMessage("该标识已存在，请从左侧选择后编辑。"); return; } void mutate({ action: "draft", styleKey, draft: { ...styleDraft, completeRules: true } }); }}>{busy ? "保存中…" : "保存为新草稿版本"}</button><button className={styles.button} disabled={disabled || styleDirty || !selectedRow?.draftVersion || viewed?.releaseId !== detail?.draftReleaseId} onClick={() => void mutate({ action: "publish", styleKey: selected })}>发布待发布版本</button></div>
          {detail?.draftReleaseId && <details className={styles.details}><summary>发布前检查：当前风格与编辑区内容</summary><div className={styles.comparison}><div><h4>当前生效 {selectedRow?.currentVersion || "无"}</h4><pre>{currentStyle ? `${currentStyle.analysisPrompt}\n\n【画面生成】\n${currentStyle.generationPrompt}` : selectedRow?.currentVersion ? "当前已发布提示词正文暂未读取，请读取最新状态。" : "尚未发布"}</pre></div><div><h4>编辑区 {styleDirty ? "尚未保存" : viewed?.version}</h4><pre>{styleDraft.analysisPrompt}{"\n\n【画面生成】\n"}{styleDraft.generationPrompt}</pre></div></div></details>}
          {selected && detail && <details className={styles.details}><summary>当前生效提示词与风格历史</summary><pre>{currentStyle ? `${currentStyle.analysisPrompt}\n\n【画面生成】\n${currentStyle.generationPrompt}` : selectedRow?.currentVersion ? "当前已发布提示词正文暂未读取，请读取最新状态。" : "尚未发布"}</pre><div className={styles.actions}><select aria-label="风格历史版本" value={viewed?.releaseId || ""} disabled={busy || reading || styleDirty} onChange={event => void load({ styleKey: selected, releaseId: event.target.value, replaceWorkflow: false })}>{detail.releases.map(release => <option key={release.releaseId} value={release.releaseId}>{release.version} · {release.published ? "曾发布" : "草稿快照"} · {new Date(release.createdAt).toLocaleString("zh-CN")}</option>)}</select><button className={styles.button} disabled={disabled || styleDirty || !viewedMeta?.published || viewed?.releaseId === detail.currentReleaseId} onClick={() => viewed && void mutate({ action: "rollback", styleKey: selected, releaseId: viewed.releaseId })}>将此已发布版本设为当前</button></div></details>}
        </div>
      </div>
    </section>
    <section className={styles.panel} data-testid="cover-runtime-preview">
      <div className={styles.sectionHeading}><div><h3>实际生效规则 · 免费编译预览</h3><p>使用真实拆解编译器组装完整规则，不调用模型，不创建任务，也不扣费。图片模式使用示意素材绑定，不分析真实图片。</p></div></div>
      <div className={styles.modelGrid}><label className={styles.label}>制作模式<select data-testid="cover-preview-mode" value={previewMode} disabled={previewBusy} onChange={event => { clearPreview(); setPreviewMode(event.target.value as CoverAdminPreviewInput["mode"]); }}>{Object.entries(modeLabels).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}</select></label><label className={styles.label}>预览内容<select data-testid="cover-preview-source" value={previewSource} disabled={previewBusy} onChange={event => { clearPreview(); setPreviewSource(event.target.value as "current" | "editor"); }}><option value="current">当前已发布规则</option><option value="editor">编辑区内容（包含未保存修改或已选历史）</option></select></label></div>
      <label className={styles.label}>示例文案<textarea rows={3} maxLength={20_000} value={previewText} disabled={previewBusy} onChange={event => { clearPreview(); setPreviewText(event.target.value); }} /><small>只使用示例内容；当前风格：{styleDraft.displayName || "未选择"}。商品与图片模式不应用纯文字口播风格。</small></label>
      <div className={styles.actions}><button data-testid="cover-workflow-preview" className={styles.primaryButton} disabled={!catalog || busy || reading || previewBusy} onClick={() => void runPreview()}>{previewBusy ? "编译中…" : "免费预览完整规则"}</button><span>结构化 JSON、来源证据、素材绑定和安全协议只读。</span></div>
      {previewError && <p role="alert" className={styles.notice}>{previewError}</p>}
      {preview && <div data-testid="cover-runtime-preview-result" className={styles.previewResult}><div className={styles.currentSummary}><div><span>模式与风格</span><strong>{modeLabels[preview.mode]} · {preview.styleApplied ? "应用所选风格" : "按当前素材模式规划"}</strong></div><div><span>分析模型</span><strong>{preview.model.displayName} · {preview.model.source === "configured" ? "指定模型" : "自动选择"}</strong>{!preview.model.available && <small>{preview.model.reason || "当前不可用"}</small>}</div><div><span>只读协议</span><strong>{preview.readonlyProtocolVersion}</strong><small>{preview.textUnits.toLocaleString("zh-CN")} 字符</small></div></div><h4>完整系统规则</h4><pre data-testid="cover-runtime-system-prompt">{preview.systemPrompt}</pre><details className={styles.details}><summary>编译后的示例材料消息（含示意图片绑定）</summary><pre>{preview.userMessage}</pre></details></div>}
    </section>
    <footer className={styles.footer}><span>图片生成资源、用户价格和封面模型顺序在模型配置中管理。</span><Link href="/admin?tab=models" onClick={guardLink}>模型资源池</Link><Link href="/admin?tab=workspace-models&project=cover" onClick={guardLink}>封面图片模型与顺序</Link></footer>
  </div>;
}
