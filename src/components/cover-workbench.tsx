"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, FileText, History, ImagePlus, Images, Loader2, RefreshCw, Save, ShoppingBag, Sparkles, X } from "lucide-react";
import { AppScopedLink } from "@/components/app-scoped-link";
import { UserThemeSwitcher } from "@/components/user-theme-switcher";
import { SubPageHeader } from "@/components/sub-page-header";
import { useApp } from "@/contexts/app-context";
import { resolveWorkbenchIdentity, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import {
  COVER_CREATION_SCENARIOS, coverMaterialLabels, coverOutputSizes, isSavedCoverTask, useCoverWorkbench,
  type CoverCreationScenario, type CoverMaterialRole, type CoverOutputRatio,
} from "./cover-workbench-client";
import styles from "./cover-workbench.module.css";
import { CoverStylePicker } from "./cover-style-picker";
import { CoverPlanReview, COVER_REVIEW_MATERIAL_ROLE_LABELS, coverReviewedMaterialUsage, coverReviewMaterialRoleEditorId } from "./cover-plan-review";

const ratios: CoverOutputRatio[] = ["16:9", "9:16", "4:3", "3:4"];
const scenarios: { key: CoverCreationScenario; icon: typeof FileText }[] = [
  { key: "script", icon: FileText }, { key: "product", icon: ShoppingBag },
  { key: "reference", icon: Images }, { key: "background", icon: ImagePlus },
];
type CoverProgressState = "pending" | "active" | "complete" | "skipped" | "blocked";
type CoverProgressInput = Pick<ReturnType<typeof useCoverWorkbench>, "busy" | "selected" | "analysis" | "uncertain" | "originalLayout" | "error" | "freshBinding">;

function hasSavedCover(workbench: Pick<CoverProgressInput, "selected">) {
  return isSavedCoverTask(workbench.selected);
}

function coverProgressFor(workbench: CoverProgressInput, pendingPhase?: NonNullable<ReturnType<typeof useCoverWorkbench>["pending"]>["phase"]): { steps: CoverProgressState[]; summary: string } {
  const { busy, selected, analysis, uncertain, error, freshBinding } = workbench;
  const analyzed = analysis?.status === "ready";
  if (uncertain && pendingPhase) {
    if (pendingPhase === "generation") return { steps: ["complete", "complete", "blocked"], summary: "原单的生图或保存状态待核对。" };
    if (pendingPhase === "confirmation" || pendingPhase === "review") return { steps: ["complete", "blocked", "pending"], summary: "原单的方案确认状态待核对。" };
    return { steps: ["blocked", "pending", "pending"], summary: "原单的内容拆解状态待核对。" };
  }
  if (uncertain || selected?.status === "unknown") return { steps: [analyzed ? "complete" : "blocked", "blocked", "pending"], summary: "查询原任务状态，不会重复提交。" };
  if (busy === "preparing") return { steps: ["active", "pending", "pending"], summary: "正在准备拆解并核对费用。" };
  if (busy === "analyzing") return { steps: ["active", "pending", "pending"], summary: "正在拆解内容，完成后由你确认方案。" };
  if (busy === "generating" || busy === "rendering" || selected?.status === "running") return { steps: ["complete", "complete", "active"], summary: "正在按已确认的方案制作封面。" };
  if (hasSavedCover(workbench)) return { steps: ["complete", "complete", "complete"], summary: "封面已保存，可检查并下载。" };
  if (freshBinding?.result.status === "review_ready") return { steps: ["complete", "active", "pending"], summary: "拆解完成，检查并编辑方案后再生成。" };
  if (error) return { steps: [analyzed ? "complete" : "blocked", "pending", "pending"], summary: "请根据提示调整材料或查询原任务。" };
  return { steps: ["pending", "pending", "pending"], summary: "填写内容并拆解，确认方案后生成。" };
}

export function CoverWorkbench({ mainWorkspace = false }: { mainWorkspace?: boolean }) {
  const { state } = useApp();
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return (
    <div data-cover-workbench="" className={`secondary-workbench ${styles.root}`}>
      <SubPageHeader title="封面工作台" icon={<ImagePlus className="h-5 w-5" />} />
      <main className={styles.signedOut}>
        <ImagePlus size={38} aria-hidden="true" />
        <h2>登录后制作和管理封面</h2>
        <p>使用文案或图片制作封面，编辑标题并保存到自己的作品中。</p>
        <AppScopedLink href="/" data-workbench-action="primary" className={styles.primaryLink}>返回主页登录</AppScopedLink>
      </main>
    </div>
  );
  return <AccountCoverWorkbench key={identity.userId} identity={identity} mainWorkspace={mainWorkspace} />;
}

function AccountCoverWorkbench({ identity, mainWorkspace }: { identity: WorkbenchIdentity; mainWorkspace: boolean }) {
  const workbench = useCoverWorkbench(identity, mainWorkspace);
  const upload = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const historyTrigger = useRef<HTMLButtonElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(300);
  const [thumbnail, setThumbnail] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"plan" | "result">("plan");
  useEffect(() => { if (workbench.reviewReady) setWorkspaceTab("plan"); }, [workbench.reviewReady, workbench.freshBinding?.result.operationId]);
  useEffect(() => { if (workbench.selected) setWorkspaceTab("result"); }, [workbench.selected]);
  const historyPanel = useRef<HTMLElement>(null);
  const { historyOpen, setHistoryOpen } = workbench;
  const output = coverOutputSizes[workbench.ratio];
  const previewOutput = workbench.selected && !workbench.editableSelected
    ? { width: workbench.selected.outputWidth || workbench.selected.renderPlan?.outputSpec?.width || coverOutputSizes[workbench.selected.ratio].width,
      height: workbench.selected.outputHeight || workbench.selected.renderPlan?.outputSpec?.height || coverOutputSizes[workbench.selected.ratio].height }
    : output;
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const resize = () => {
      const width = Math.max(1, node.clientWidth - 48);
      const height = Math.max(1, node.clientHeight - 48);
      const aspect = previewOutput.width / previewOutput.height;
      setCanvasWidth(Math.min(thumbnail ? 160 : aspect > 1 ? 620 : 430, width, height * aspect));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node); resize();
    return () => observer.disconnect();
  }, [previewOutput.width, previewOutput.height, thumbnail]);
  useEffect(() => {
    if (!historyOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setHistoryOpen(false); historyTrigger.current?.focus(); }
      if (event.key === "Tab") {
        const controls = [...(historyPanel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]') || [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [historyOpen, setHistoryOpen]);

  const showEditableBackground = Boolean(workbench.selected ? workbench.editableSelected && workbench.dirty && workbench.backgroundUrl : workbench.originalLayout && workbench.originalMaterial?.previewUrl);
  const imageUrl = workbench.renderedPreviewUrl || (workbench.generatedOverlayLayout && workbench.dirty ? undefined : showEditableBackground
    ? workbench.selected ? workbench.backgroundUrl : workbench.originalMaterial?.previewUrl
    : workbench.previewUrl);
  const canEdit = workbench.draftReady && (!workbench.selected || workbench.editableSelected);
  const savedCover = hasSavedCover(workbench);
  const manualLayoutAvailable = !workbench.selected && workbench.originalLayout && Boolean(workbench.originalMaterial?.assetId);
  const progress = coverProgressFor(workbench, mainWorkspace ? workbench.pending?.phase : undefined);
  const currentStep = progress.steps.findIndex(step => step !== "complete" && step !== "skipped");
  const previewUnconfirmed = workbench.previewBusy || Boolean(workbench.renderedPreviewError);
  const canSave = Boolean(workbench.title.trim() && (workbench.editableSelected || manualLayoutAvailable));
  const canDownload = savedCover || manualLayoutAvailable && canSave;
  const selectedModelMissing = Boolean(workbench.modelId && !workbench.activeModel && workbench.modelsState === "ready");
  const resolutions = workbench.activeModel?.resolutions.length ? workbench.activeModel.resolutions : ["2K"];
  const processing = Boolean(workbench.busy);
  const emptyPreviewMessage = workbench.previewError || (
    mainWorkspace && workbench.uncertain && workbench.pending?.phase !== "generation" ? (["confirmation", "review"].includes(workbench.pending?.phase || "") ? "原方案确认状态待核对。" : "原任务的拆解结果待核对。")
    : workbench.uncertain || workbench.selected?.status === "unknown" ? "成品交付待确认，请查询原任务。"
    : mainWorkspace && workbench.recoverable ? "原任务已找到。恢复原任务材料后，可在这里继续。"
    : workbench.selected?.status === "done" && !savedCover ? "画面已生成，封面保存尚未确认；原费用记录已保留。"
    : processing ? workbench.processText
    : workspaceTab === "plan" ? "拆解内容后，在这里检查标题和画面方案。" : "确认方案并生成后，在这里查看封面成品。"
  );
  const originalOrder = workbench.originalOrderDisplay;
  const analysisPrice = originalOrder ? workbench.confirmed?.originalAnalysisBilling?.creditsCharged
    : workbench.freshBinding?.result.analysisBilling?.creditsCharged ?? (workbench.confirmed?.quote || workbench.freshBinding?.result.quote)?.analysis?.amount;
  const queryInsteadOfPreparing = mainWorkspace && !originalOrder && workbench.uncertain && Boolean(workbench.pending);
  const visibleScenario = originalOrder?.scenario || workbench.scenario;
  const uploading = workbench.materials.some(asset => asset.status === "uploading");
  const inputsLocked = processing || workbench.uncertain || Boolean(workbench.confirmed) || uploading || !workbench.draftReady;
  const reviewedComposition = workbench.customComposition && Boolean(workbench.analysis && workbench.reviewDraft);
  const focusMaterialRole = (assetId: string, imageNumber: number) => {
    if (inputsLocked) return;
    setWorkspaceTab("plan");
    requestAnimationFrame(() => {
      const editor = document.getElementById(coverReviewMaterialRoleEditorId(assetId, imageNumber));
      editor?.scrollIntoView({ block: "center", behavior: "auto" });
      editor?.focus({ preventScroll: true });
    });
  };
  const scenario = COVER_CREATION_SCENARIOS[workbench.scenario];
  const acceptsImages = workbench.scenario !== "script";
  const canAddImages = acceptsImages && !inputsLocked && workbench.materials.length < 3;
  const animationStyle = workbench.scenario === "script";
  const showImageMode = workbench.scenario === "product" && workbench.materials.length > 0;
  const firstImageNumber = workbench.materials[0]?.imageNumber || 1;
  const secondImageNumber = workbench.materials[1]?.imageNumber || firstImageNumber + 1;
  const thirdImageNumber = workbench.materials[2]?.imageNumber || secondImageNumber + 1;
  const analysisIssue = workbench.analysisIssue;
  const buttonText = workbench.busy === "preparing" ? "准备拆解中…" : workbench.busy === "analyzing" ? "拆解内容中…"
    : workbench.reviewReady ? "拆解已完成" : workbench.freshBinding ? "确认费用并拆解" : "下一步：拆解内容";
  const processingNote = workbench.originalLayout
    ? `完整保留“${workbench.originalMaterial?.name || "背景图片"}”，自动提炼标题并完成中文排版。`
    : workbench.customComposition && workbench.materials.length > 0 ? "按文案中的制作要求组合图片，生成新画面，再自动完成中文标题排版。图片用途是补充提示，文案中的明确要求优先。"
      : workbench.scenario === "product" ? "根据商品介绍制作创意商品画面，并自动完成标题排版；添加真实照片后，可选择智能合成或保留原图。"
        : "先理解完整口播，提炼有依据的标题，再按所选风格制作画面与文字融合的完整封面。成品中的中文需要核对。";

  return (
    <div data-cover-workbench="" className={`secondary-workbench ${styles.root}`} onPaste={(event) => {
      if (event.clipboardData.files.length) { event.preventDefault(); if (canAddImages) void workbench.addFiles(event.clipboardData.files); }
    }}>
      <SubPageHeader
        title="封面工作台"
        subtitle="先拆解内容，编辑确认方案，再生成封面。"
        icon={<ImagePlus className="h-5 w-5" />}
        rightSlot={<div className={styles.headerActions}>
          <UserThemeSwitcher />
          <button type="button" className="sub-page-nav-button flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap" data-variant="ghost" data-workbench-action="secondary" ref={historyTrigger} disabled={processing} onClick={() => { workbench.setHistoryOpen(true); void workbench.refreshHistory(); }}>
            <History className="sub-page-nav-icon shrink-0" /><span>历史作品</span>
          </button>
        </div>}
      />

      <nav className={styles.scenarios} aria-label="封面制作方式">
        {scenarios.map(({ key, icon: Icon }) => <button type="button" key={key} data-scenario={key}
          aria-label={COVER_CREATION_SCENARIOS[key].label} aria-pressed={visibleScenario === key}
          disabled={inputsLocked} onClick={() => workbench.setScenario(key)}>
          <span className={styles.scenarioIcon}><Icon size={19} /></span>
          <span><strong>{COVER_CREATION_SCENARIOS[key].label}</strong><small>{COVER_CREATION_SCENARIOS[key].description}</small></span>
          {visibleScenario === key && <Check size={15} className={styles.scenarioCheck} />}
        </button>)}
      </nav>
      <div className={styles.workflow} aria-label="封面制作进度" aria-live="polite">
        <ol>{["拆解内容", "确认方案", "生成封面"].map((label, index) => {
          const state = progress.steps[index];
          const status = { complete: "已完成", active: "进行中", skipped: "无需执行", blocked: "待处理", pending: index === currentStep ? "当前步骤" : "" }[state];
          return <li key={label} data-state={state} aria-current={index === currentStep ? "step" : undefined}>
            <span className={styles.stepMarker} aria-hidden="true">{state === "complete" ? <Check size={12} /> : state === "skipped" ? "−" : index + 1}</span>
            <span>{label}</span>{status && <small>{status}</small>}
          </li>;
        })}</ol>
        {progress.steps.some(step => step !== "pending") && <p>{progress.summary}</p>}
      </div>


      <main className={styles.workspace}>
        <section className={`${styles.panel} ${styles.editor}`} aria-label="文案、图片与制作设置">
          <div className={styles.editorBody}>
            {originalOrder ? <section aria-label="原单信息（只读）">
              <h2>原单信息（只读）</h2>
              <p className={styles.help}>{workbench.uncertain ? "结果仍待确认。以下文案、模型和报价属于原确认单，本页只查询原任务。" : "以下为原确认方案。恢复原任务材料后可继续原单，当前草稿保留不变。"}</p>
              <label className={styles.fieldLabel} htmlFor="cover-original-text">原单文案与制作要求</label>
              <textarea id="cover-original-text" className={styles.brief} readOnly value={originalOrder.text}
                placeholder="原文尚未读取，请保留原单并继续查询。" />
              <div className={styles.settings}>
                <span className={styles.fieldLabel}>已确认标题</span>
                <p className={styles.small} style={{ whiteSpace: "pre-wrap" }}>{originalOrder.title || "原标题尚未读取"}{originalOrder.subtitle ? `\n${originalOrder.subtitle}` : ""}</p>
                <span className={styles.fieldLabel}>原单模型</span>
                <p className={styles.small} data-original-model-name>{originalOrder.modelName}</p>
                {!originalOrder.originalLayout && originalOrder.modelId && workbench.modelsState === "ready" && !workbench.models.some(model => model.id === originalOrder.modelId)
                  && <p className={styles.small}>原模型当前不在目录中，原单信息与报价仍保留；查询不会改用其他模型。</p>}
                <span className={styles.fieldLabel}>原单尺寸与清晰度</span>
                <p className={styles.small}>{originalOrder.ratio || "原比例待查询"}{originalOrder.width && originalOrder.height ? ` · ${originalOrder.width}×${originalOrder.height}` : ""}{originalOrder.resolution ? ` · ${originalOrder.resolution}` : ""}</p>
                <span className={styles.fieldLabel}>原单风格</span><p className={styles.small}>{originalOrder.styleName}</p>
                {originalOrder.assets.length > 0 && <><span className={styles.fieldLabel}>原单图片素材</span>
                  {originalOrder.assets.map((asset, index) => <p key={asset.assetId} className={styles.small}>@图{asset.imageNumber || index + 1} · {coverMaterialLabels[asset.role]}</p>)}</>}
              </div>
            </section> : <>
            <h2>{scenario.textLabel}</h2>
            <p className={styles.help}>{scenario.description}</p>
            <label className={styles.fieldLabel} htmlFor="cover-workbench-text">文案与制作要求 <span className={styles.required}>必填</span></label>
            <textarea id="cover-workbench-text" className={styles.brief} value={workbench.text} maxLength={20000} disabled={inputsLocked}
              placeholder={scenario.placeholder}
              onChange={(event) => workbench.setText(event.target.value)} />
            {workbench.customComposition && <p className={styles.requirementsHint}>先填写商品或视频内容，再用图片编号说明制作要求；明确的文字要求优先于图片用途。
              <span>两张图片：@图{firstImageNumber} 是模特，@图{secondImageNumber} 是商品，让模特自然展示商品。</span>
              <span>三张图片：再用 @图{thirdImageNumber} 指定背景场景，或参考它的配色和标题布局；请说明要保留哪些外观、替换哪些内容。</span></p>}
            {!acceptsImages && <div className={styles.noImages}><FileText size={15} /><p>{scenario.imagesHint}
              {workbench.inactiveImageCount > 0 && <span>{workbench.inactiveImageCount} 张图片已保留在草稿中，本次口播生成不会使用。切换回其他方式可继续使用。</span>}</p></div>}
            {acceptsImages && <>
            <div className={styles.materialHeading}><strong>{scenario.imagesLabel} <span>{workbench.scenario === "product" ? "选填" : "必填"}</span></strong><span>{workbench.materials.length} / 3 张</span></div>
            <p className={styles.materialHint}>{scenario.imagesHint}</p>
            {showImageMode && <div className={styles.imageModes} role="group" aria-label="商品图片处理方式">
              <button type="button" data-workbench-control="choice" aria-label="智能合成" aria-pressed={workbench.imageMode === "compose"} disabled={inputsLocked} onClick={() => workbench.setImageMode("compose")}>
                <Sparkles size={15} /><span><strong>智能合成</strong><small>结合多图生成新画面</small></span>
              </button>
              <button type="button" data-workbench-control="choice" aria-label="保留原图" aria-pressed={workbench.imageMode === "preserve"} disabled={inputsLocked} onClick={() => workbench.setImageMode("preserve")}>
                <ImagePlus size={15} /><span><strong>保留原图</strong><small>保留整图，自动加字</small></span>
              </button>
            </div>}
            <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={!canAddImages} onChange={(event) => {
              if (event.target.files) void workbench.addFiles(event.target.files);
              event.target.value = "";
            }} />
            <div className={`${styles.drop} ${dragging ? styles.dragging : ""}`} role="button" tabIndex={canAddImages ? 0 : -1} aria-disabled={!canAddImages}
              aria-label="添加封面图片，支持选择、拖入或粘贴" onClick={() => { if (canAddImages) upload.current?.click(); }}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (canAddImages) upload.current?.click(); } }}
              onDragOver={(event) => { event.preventDefault(); if (canAddImages) setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); if (canAddImages) void workbench.addFiles(event.dataTransfer.files); }}>
              <span className={styles.dropIcon}><ImagePlus size={23} /></span>
              <div><strong>{workbench.materials.length >= 3 ? "已添加 3 张图片" : "选择、拖入或粘贴图片"}</strong><span>PNG、JPEG、WebP，单张不超过 5MB</span></div>
            </div>
            {workbench.materials.length > 0 && <div className={styles.materialList}>
              {workbench.materials.map((asset) => {
                const reviewedUsage = reviewedComposition ? coverReviewedMaterialUsage(asset, workbench.reviewDraft) : undefined;
                return <div className={styles.material} key={asset.id} data-image-number={asset.imageNumber}>
                {/* Account-owned local blob URLs only; remote assets are read with authentication. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={asset.previewUrl} alt={asset.name} className={styles.materialImage} />
                <div className={styles.materialMeta}><strong title={asset.name}>{workbench.customComposition && <span className={styles.imageNumber}>@图{asset.imageNumber}</span>}{asset.name}</strong>
                  {workbench.customComposition ? reviewedUsage ? <>
                    <span className={styles.materialRole} aria-label={`@图${asset.imageNumber}方案用途`}>方案用途：{COVER_REVIEW_MATERIAL_ROLE_LABELS[reviewedUsage.role]}</span>
                    <button type="button" className={styles.textButton} disabled={inputsLocked}
                      aria-label={`编辑@图${asset.imageNumber}方案用途`} aria-controls={coverReviewMaterialRoleEditorId(reviewedUsage.assetId, reviewedUsage.imageNumber)}
                      onClick={() => focusMaterialRole(reviewedUsage.assetId, reviewedUsage.imageNumber)}>在方案中调整用途</button>
                  </> : <select aria-label={`${asset.name}的图片用途`} value={asset.role} disabled={inputsLocked || reviewedComposition}
                    onChange={(event) => workbench.changeRole(asset.id, event.target.value as CoverMaterialRole)}>
                    {Object.entries(COVER_REVIEW_MATERIAL_ROLE_LABELS).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
                  </select> : <span className={styles.materialRole} aria-label={`${asset.name}的图片用途`}>{asset.role === "identity_subject" ? "商品照片 · 保留整张原图" : asset.role === "background_canvas" ? "背景图 · 保留整张原图" : "参考封面 · 参考配色与布局"}</span>}
                  <span className={asset.status === "failed" ? styles.inlineError : styles.small} role="status">
                    {asset.status === "uploading" ? "正在上传…" : asset.status === "failed" ? asset.error : asset.width && asset.height ? `${asset.width} × ${asset.height}` : "图片已就绪"}
                  </span>
                </div>
                <button type="button" className={styles.iconButton} disabled={inputsLocked} aria-label={`移除图片${asset.name}`} onClick={() => workbench.removeMaterial(asset.id)}><X size={14} /></button>
              </div>; })}
            </div>}
            </>}
            <details className={styles.instructions}><summary>本模式制作说明</summary><p>{processingNote}</p></details>
            <div className={styles.settings}>
              <label className={styles.fieldLabel} htmlFor="cover-workbench-style">画面风格</label>
              {animationStyle ? <CoverStylePicker choices={workbench.styleChoices} value={workbench.styleKey} disabled={inputsLocked}
                loading={workbench.stylesLoading} error={workbench.stylesError} onChange={workbench.setStyleKey} onReload={() => void workbench.reloadStyles()} />
                : <p className={styles.small}>{workbench.originalLayout ? "保留原图，添加标题和排版。" : "根据素材与文案要求规划画面。"}</p>}
              <div className={styles.settingGrid}>
                <div><div className={styles.labelRow}><label className={styles.fieldLabel} htmlFor="cover-workbench-model">图片生成模型</label><button type="button" className={styles.textButton} disabled={processing || workbench.modelsState === "loading"} onClick={() => void workbench.reloadModels()} aria-label="刷新图片模型列表"><RefreshCw size={12} />刷新</button></div>
                  <select id="cover-workbench-model" value={workbench.modelId} disabled={inputsLocked || workbench.originalLayout || workbench.modelsState === "loading"}
                    onChange={(event) => workbench.setModelId(event.target.value)}>
                    {!workbench.models.length && <option value="">{workbench.modelsState === "loading" ? "正在读取模型…" : "模型列表暂不可用"}</option>}
                    {selectedModelMissing && <option value={workbench.modelId}>原模型已不在当前目录</option>}
                    {workbench.models.map((model) => <option key={model.id} value={model.id}>{model.name}{!model.available ? "（暂不可用）" : ""}</option>)}
                  </select>
                </div>
                <div className={styles.resolution}><label className={styles.fieldLabel} htmlFor="cover-workbench-resolution">生成清晰度</label>
                  <select id="cover-workbench-resolution" value={workbench.resolution} disabled={inputsLocked || workbench.originalLayout} onChange={(event) => workbench.setResolution(event.target.value)}>
                    {!resolutions.includes(workbench.resolution) && <option value={workbench.resolution} disabled={workbench.resolution === "1K"}>{workbench.resolution === "1K" ? "1K（不满足导出要求）" : `${workbench.resolution}（未声明）`}</option>}
                    {resolutions.map((resolution) => <option value={resolution} key={resolution} disabled={resolution === "1K"}>{resolution === "1K" ? "1K（不满足导出要求）" : resolution}</option>)}
                  </select>
                </div>
              </div>
              {workbench.modelsState === "error" && <p className={styles.inlineError}>{workbench.modelsError} <button type="button" className={styles.textButton} onClick={() => void workbench.reloadModels()}>重新读取</button></p>}
              <span className={styles.fieldLabel}>封面尺寸</span>
              <div className={styles.ratios}>{ratios.map((ratio) => <button key={ratio} type="button" data-workbench-control="choice" disabled={inputsLocked} aria-pressed={workbench.ratio === ratio}
                onClick={() => workbench.setRatio(ratio)}><span>{ratio}{workbench.ratio === ratio && <Check size={11} />}</span>
                <small>{coverOutputSizes[ratio].width}×{coverOutputSizes[ratio].height}</small></button>)}</div>
              <p className={styles.small}>先拆解，检查右侧方案后再生成。原图排版保留整张图片。</p>
            </div>
            </>}
          </div>
          <footer className={styles.actionFooter} data-testid="cover-fee-summary">
            <div className={styles.currentSettings} aria-live="polite">
              <strong data-testid="cover-image-model-name">{originalOrder ? `原单生图模型：${originalOrder.modelName}` : workbench.originalLayout ? "原图添加标题 · 不生成新图片" : `生图模型：${workbench.activeModel?.name || "待选择"}`}</strong>
              <span>{originalOrder ? `${originalOrder.ratio || "原比例待查询"}${originalOrder.width && originalOrder.height ? ` · ${originalOrder.width}×${originalOrder.height}` : ""} · 1 张` : `${workbench.ratio} · ${output.width}×${output.height} · 1 张`}</span>
            </div>
            <div className={styles.cost} data-testid="cover-image-fee"><span>{originalOrder ? "原单图片报价" : "图片费用"}</span><strong>{originalOrder?.imageFeeText || workbench.feeText}</strong></div>
            {typeof analysisPrice === "number" && analysisPrice > 0 && <p className={styles.analysisFee} data-testid="cover-analysis-fee">{originalOrder ? "原单分析已计费" : "分析费用"}：{analysisPrice} 积分</p>}
            {(originalOrder ? originalOrder.analysisModelName : workbench.analysisModelName) && <p className={styles.analysisFee} data-testid="cover-analysis-model-name">分析模型：{originalOrder?.analysisModelName || workbench.analysisModelName}</p>}
            {workbench.blockedReason && workbench.blockedReason !== analysisIssue?.message && (!originalOrder || workbench.uncertain) && <p className={styles.blockingReason} role="status">{workbench.blockedReason}</p>}
            {queryInsteadOfPreparing ? <button type="button" data-workbench-action="primary" className={styles.primary} disabled={processing} onClick={() => void workbench.recover(workbench.pending?.workflowVersion === 3)}>
              <RefreshCw size={17} />{processing ? "正在查询原任务…" : "查询原任务状态"}
            </button> : <button type="button" data-workbench-action="primary" className={styles.primary} disabled={Boolean(originalOrder) || processing || workbench.reviewReady || Boolean(workbench.blockedReason)} onClick={() => void workbench.primaryAction()}>
              {processing ? <Loader2 size={17} className={styles.spinning} /> : <Sparkles size={17} />}{originalOrder ? workbench.uncertain ? "原单待确认，仅可查询" : "原确认方案已保留" : buttonText}
            </button>}
            {workbench.pending && !queryInsteadOfPreparing && !(mainWorkspace && workbench.reviewReady && !workbench.uncertain) && (workbench.uncertain || ["prepare", "review", "confirmation", "generation"].includes(workbench.pending.phase || "") || analysisIssue?.canRecoverFromReceipt) && <button type="button" data-workbench-action="secondary" className={styles.recover} disabled={processing} onClick={() => void workbench.recover()}><RefreshCw size={14} />查询原任务状态</button>}
            {workbench.recoverable && <button type="button" data-workbench-action="secondary" className={styles.recover} disabled={processing} onClick={() => void workbench.restorePrepared().then(() => setWorkspaceTab("plan"))}><RefreshCw size={14} />恢复原任务材料</button>}
          </footer>
        </section>

        <section className={`${styles.panel} ${styles.previewPanel}`} aria-label="封面预览与标题编辑">
          <div className={styles.previewTop}><div><div className={styles.workspaceTabs}>
            <button type="button" data-workbench-control="choice" aria-pressed={workspaceTab === "plan"} onClick={() => setWorkspaceTab("plan")}>拆解方案</button>
            <button type="button" data-workbench-control="choice" aria-pressed={workspaceTab === "result"} onClick={() => setWorkspaceTab("result")}>封面成品</button>
          </div>{(imageUrl || (workspaceTab === "plan" && workbench.reviewDraft)) && <p aria-live="polite"><span className={processing ? styles.activeDot : styles.dot} />{workbench.processText}</p>}</div>
            {workspaceTab === "result" && <div className={styles.viewTabs}><button type="button" data-workbench-control="choice" aria-pressed={!thumbnail} onClick={() => setThumbnail(false)}>大图</button><button type="button" data-workbench-control="choice" aria-pressed={thumbnail} onClick={() => setThumbnail(true)}>缩略图</button></div>}
          </div>
          {workspaceTab === "plan" && analysisIssue && <div className={styles.analysisIssue} role="alert">
            <strong>内容拆解未就绪</strong><p>{analysisIssue.message}</p>
          </div>}
          {workspaceTab === "plan" && workbench.analysis && workbench.reviewDraft && <CoverPlanReview analysis={workbench.analysis} draft={workbench.reviewDraft}
            animationBrief={workbench.freshBinding?.result.style?.sceneBriefVersion === 1 ? { style: workbench.freshBinding.result.style.displayName!, ratio: workbench.ratio } : undefined}
            disabled={processing || workbench.uncertain} onChange={workbench.changeReviewDraft} onReset={workbench.resetReviewDraft}
            onGenerate={() => void workbench.confirmAndGenerate()} canGenerate={workbench.reviewReady && !workbench.blockedReason}
            editableMaterialRoles={workbench.customComposition} feeText={workbench.feeText} error={workbench.blockedReason} generating={workbench.busy === "generating"} confirmed={Boolean(workbench.confirmed)} />}
          <div ref={stage} className={styles.stage} style={workspaceTab === "plan" && (workbench.reviewDraft || analysisIssue) ? { display: "none" } : undefined} aria-busy={workbench.previewBusy}>
            {imageUrl ? <div className={styles.canvas} style={{ width: canvasWidth, aspectRatio: `${previewOutput.width}/${previewOutput.height}` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt={workbench.selected ? `封面：${workbench.selected.title}` : "已添加的封面图片"} className={styles.coverImage}
                style={{ objectFit: workbench.nativeSelected || showEditableBackground && workbench.originalLayout ? "contain" : "cover" }} />
            </div> : <div className={styles.emptyPreview} role="status">
              {processing ? <Loader2 size={30} className={styles.spinning} aria-hidden="true" /> : <ImagePlus size={32} aria-hidden="true" />}
              <p>{emptyPreviewMessage}</p>
            </div>}
            {(workbench.previewBusy || workbench.renderedPreviewError) && <p className={`${styles.previewHint} ${workbench.renderedPreviewError ? styles.inlineError : ""}`} role="status">
              {workbench.previewBusy ? <><Loader2 size={13} className={styles.spinning} />预览更新中…</> : workbench.renderedPreviewError}
            </p>}
          </div>
          {workspaceTab === "result" && (savedCover || manualLayoutAvailable) && <div className={styles.previewBottom}>
            {savedCover && <div className={styles.resultActions}>
              <div><strong>{workbench.dirty ? "封面已有新修改" : "封面已完成"}</strong>
                <span>{previewUnconfirmed ? "当前修改正在更新预览" : workbench.dirty ? "下载时自动保存当前修改" : workbench.selected?.outputWidth ? `${workbench.selected.outputWidth}×${workbench.selected.outputHeight} · 已保存` : "已保存，可直接下载"}</span>
              </div>
              <div><button type="button" data-workbench-action="secondary" disabled={processing} onClick={workbench.newDraft}>制作下一张</button>
                <button type="button" data-workbench-action="primary" className={styles.download} disabled={!canDownload || processing || workbench.uncertain || previewUnconfirmed} onClick={() => void workbench.saveOrDownload(true)}>
                  <Download size={16} />{workbench.dirty ? "保存并下载" : "下载封面"}
                </button></div>
            </div>}
            {canEdit ? <details key={workbench.selected?.id || workbench.originalMaterial?.assetId} className={styles.optionalEditor}>
              <summary>{savedCover ? "调整标题和排版（可选）" : "手动填写标题和调整排版（可选）"}</summary>
              <div className={styles.editingBody}>
                <p className={styles.editingHelp}>{savedCover ? "成品可直接下载；只有需要修改时才调整这里。改字不会重新生成画面。" : "默认将自动提炼标题。也可以在这里指定标题，手动完成原图排版。"}</p>
                <div className={styles.titleHeader}><label htmlFor="cover-workbench-title">封面标题</label><span>可编辑，按回车换行</span></div>
                <textarea id="cover-workbench-title" className={styles.titleInput} rows={2} maxLength={80} value={workbench.title}
                  disabled={processing} placeholder="填写希望使用的标题" onChange={(event) => workbench.changeTitle(event.target.value)} />
                {workbench.canApplyAutomaticLayout && !workbench.generatedOverlayLayout && <button type="button" disabled={processing || workbench.uncertain} onClick={workbench.applyAutomaticLayout}>自动留白排版</button>}
                {workbench.generatedOverlayLayout ? <p className={styles.editingHelp}>自动留白排版：一至两行标题位于独立顶栏，字号自动适配；整张图片完整放在下方，文字与图片分开。保存后保留原作品。</p> : <div className={styles.titleControls}>
                  <label>左右位置 <span>{Math.round(workbench.titleStyle.x * 100)}%</span><input type="range" min="2" max="70" disabled={processing} value={Math.round(workbench.titleStyle.x * 100)}
                    onChange={(event) => workbench.changeTitleStyle({ x: Number(event.target.value) / 100 })} /></label>
                  <label>上下位置 <span>{Math.round(workbench.titleStyle.y * 100)}%</span><input type="range" min="2" max="50" disabled={processing} value={Math.round(workbench.titleStyle.y * 100)}
                    onChange={(event) => workbench.changeTitleStyle({ y: Number(event.target.value) / 100 })} /></label>
                  <label>字号大小 <span>{Math.round(workbench.titleStyle.scale * 100)}%</span><input type="range" min="70" max="130" disabled={processing} value={Math.round(workbench.titleStyle.scale * 100)}
                    onChange={(event) => workbench.changeTitleStyle({ scale: Number(event.target.value) / 100 })} /></label>
                  <label className={styles.colorControl}>标题颜色<input type="color" disabled={processing} value={workbench.titleStyle.color} onChange={(event) => workbench.changeTitleStyle({ color: event.target.value.toUpperCase() })} /></label>
                </div>}
                <div className={styles.toolbar}><span className={styles.versionNote}>{previewUnconfirmed ? "请等待当前排版预览完成后保存或下载" : "下载时会保存当前排版，无需先点保存。"}</span>
                  <div><button type="button" data-workbench-action="secondary" disabled={!canSave || processing || workbench.uncertain || previewUnconfirmed} onClick={() => void workbench.saveOrDownload(false)}><Save size={15} />保存排版</button>
                    {!savedCover && <button type="button" data-workbench-action="primary" className={styles.download} disabled={!canDownload || processing || workbench.uncertain || previewUnconfirmed} onClick={() => void workbench.saveOrDownload(true)}><Download size={15} />完成排版并下载</button>}</div>
                </div>
              </div>
            </details> : savedCover && <p className={styles.legacyResultNote}>{workbench.nativeSelected
              ? "完整含字封面已保存。请核对图片中的中文、主体和裁切；系统尚未自动核验文字。文字已融入画面，修改标题需要制作新封面并确认费用。"
              : "此历史版本可直接下载；完整编辑需要原始图层。"}</p>}
          </div>}
        </section>
      </main>
      {(workbench.error || workbench.notice) && (workspaceTab !== "plan" || workbench.error !== analysisIssue?.message) && <div className={`${styles.feedback} ${workbench.error ? styles.errorFeedback : ""}`} role={workbench.error ? "alert" : "status"}>{workbench.error || workbench.notice}</div>}

      {workbench.historyOpen && <div className={styles.historyBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) workbench.setHistoryOpen(false); }}>
        <section ref={historyPanel} className={styles.historyPanel} role="dialog" aria-modal="true" aria-labelledby="cover-workbench-history-heading">
          <header><div><h2 id="cover-workbench-history-heading">历史作品</h2><p>打开保存版本或查询仍在处理的任务</p></div><button type="button" autoFocus aria-label="关闭历史作品" onClick={() => { workbench.setHistoryOpen(false); historyTrigger.current?.focus(); }}><X size={18} /></button></header>
          <div className={styles.historyBody}>
            {workbench.historyBusy && <p className={styles.historyNotice}><Loader2 size={16} className={styles.spinning} />正在读取历史作品…</p>}
            {workbench.historyError && <p className={styles.inlineError}>{workbench.historyError}</p>}
            {!workbench.historyBusy && !workbench.results.length && <p className={styles.historyNotice}>还没有封面作品，制作完成后会显示在这里。</p>}
            {workbench.results.map((task) => <button type="button" key={task.id} className={styles.historyCard}
              data-cover-asset-id={task.assetId} data-cover-history-id={task.historyRecordId} onClick={() => workbench.openHistory(task)}>
              <span className={styles.historyIcon}><ImagePlus size={24} /></span><span><strong>{task.title || "未命名封面"}</strong><small>{task.ratio} · {task.modelName || "封面作品"}</small>
                <small>{new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</small></span>
              <em>{isSavedCoverTask(task) ? task.status === "display_pending" ? "预览待载入" : "已保存" : task.status === "done" || task.status === "display_pending" ? "交付待确认" : task.status === "unknown" ? "待确认" : task.status === "running" ? "处理中" : task.status === "cancelled" ? "已停止" : "未完成"}</em>
            </button>)}
          </div>
          <footer><button type="button" disabled={workbench.historyBusy} onClick={() => void workbench.refreshHistory()}><RefreshCw size={14} />刷新历史</button>
            {workbench.historyNext && <button type="button" disabled={workbench.historyBusy} onClick={() => void workbench.refreshHistory(workbench.historyNext!)}>加载更多</button>}</footer>
        </section>
      </div>}
    </div>
  );
}
