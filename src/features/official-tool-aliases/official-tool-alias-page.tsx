"use client";
import { useApp } from "@/contexts/app-context";
import { readOfficialPrivateCache, writeOfficialPrivateCache } from "@/lib/official-agent-private-cache";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CirclePause,
  FileText,
  ImageIcon,
  Mic2,
  Save,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { OfficialToolAliasDefinition } from "./official-tool-alias-map";
import styles from "./official-tool-alias-page.module.css";

const CATEGORY_LABELS = {
  text: "文本创作",
  image: "视觉创作",
  audio: "音频创作",
  video: "视频创作",
} as const;

const CATEGORY_WORKSPACE: Record<
  OfficialToolAliasDefinition["category"],
  {
    Icon: LucideIcon;
    promptLabel: string;
    placeholder: string;
    inputHint: string;
    outputHint: string;
    accept: string;
  }
> = {
  text: {
    Icon: FileText,
    promptLabel: "创作要求",
    placeholder: "写下题材、人物、冲突、时长和希望呈现的情绪……",
    inputHint: "文本与已有剧本",
    outputHint: "结构化文本草稿",
    accept: ".txt,.md,.doc,.docx",
  },
  image: {
    Icon: ImageIcon,
    promptLabel: "画面提示词",
    placeholder: "描述主体、环境、构图、光线、材质和需要避免的内容……",
    inputHint: "提示词与参考图片",
    outputHint: "单图或组图方案",
    accept: "image/*",
  },
  audio: {
    Icon: Mic2,
    promptLabel: "声音内容与表达要求",
    placeholder: "输入台词、声音性格、情绪、语速和使用场景……",
    inputHint: "文本与参考音频",
    outputHint: "音频创作方案",
    accept: "audio/*",
  },
  video: {
    Icon: Video,
    promptLabel: "视频提示词",
    placeholder: "描述主体动作、镜头运动、场景变化、时长和声音设计……",
    inputHint: "提示词与参考素材",
    outputHint: "镜头任务草稿",
    accept: "image/*,video/*,audio/*",
  },
};

export function OfficialToolAliasPage({ definition }: { definition: OfficialToolAliasDefinition }) {
  const { state } = useApp();
  const ownerId = state.auth.isAuthenticated ? String(state.auth.user?.id || "").trim() : "";
  const ownerRef = useRef(ownerId);
  useLayoutEffect(() => { ownerRef.current = ownerId; }, [ownerId]);
  const categoryHref = `/tools/${definition.category}`;
  const workspace = CATEGORY_WORKSPACE[definition.category];
  const WorkspaceIcon = workspace.Icon;
  const unavailable = definition.status === "unavailable";
  const destinationHref = unavailable ? definition.relatedHref : definition.targetHref;
  const destinationLabel = unavailable ? definition.relatedLabel : definition.targetLabel;
  const [prompt, setPrompt] = useState("");
  const [referenceName, setReferenceName] = useState("");
  const [saved, setSaved] = useState(false);
  const [draftOwner, setDraftOwner] = useState("");
  const [draftError, setDraftError] = useState("");
  const draftKey = useMemo(() => `youcai_tool_draft:${definition.officialPath}`, [definition.officialPath]);
  useEffect(() => {
    setPrompt(""); setReferenceName(""); setSaved(false); setDraftOwner(""); setDraftError("");
    if (!ownerId) return;
    try {
      const draft = readOfficialPrivateCache<unknown>(window.sessionStorage, ownerId, draftKey);
      if (!draft.ok) throw new Error("DRAFT_READ_FAILED");
      if (draft.value !== null) {
        const value = draft.value as Record<string, unknown>;
        if (typeof value.prompt !== "string" || value.prompt.length > 50_000 || typeof value.referenceName !== "string" || value.referenceName.length > 240) throw new Error("DRAFT_INVALID");
        if (ownerRef.current !== ownerId) return;
        setPrompt(value.prompt); setReferenceName(value.referenceName);
      }
      setDraftOwner(ownerId);
    } catch { setDraftError("草稿未能读取，已阻止覆盖；请检查浏览器存储权限。"); }
  }, [draftKey, ownerId]);

  const saveDraft = () => {
    if (unavailable) return;
    if (!ownerId || draftOwner !== ownerId || ownerRef.current !== ownerId) { setDraftError("请登录并读取当前账户草稿后再保存。"); return; }
    try {
      if (!writeOfficialPrivateCache(window.sessionStorage, ownerId, draftKey, {
        prompt: prompt.trim(),
        referenceName,
        savedAt: new Date().toISOString(),
      }, () => ownerRef.current)) throw new Error("DRAFT_SAVE_FAILED");
      setDraftError("");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2200);
    } catch {
      setSaved(false);
      setDraftError("草稿未能保存，请检查浏览器存储权限后重试。");
    }
  };

  return (
    <main
      className={styles.page}
      data-official-tool-alias={definition.officialPath}
      data-alias-status={definition.status}
      data-testid="youcai-independent-tool-workspace"
    >
      <div className={styles.container}>
        <nav className={styles.breadcrumb} aria-label="面包屑导航">
          <Link href="/tools">创作中心</Link><span>/</span>
          <Link href={categoryHref}>{CATEGORY_LABELS[definition.category]}</Link><span>/</span>
          <span aria-current="page">{definition.title}</span>
        </nav>

        <section className={styles.workspaceShell}>
          <header className={styles.workspaceHeader}>
            <div className={styles.titleGroup}>
              <span className={styles.workspaceIcon}><WorkspaceIcon size={23} /></span>
              <div>
                <span className={styles.eyebrow}><Sparkles size={13} />漫剧工作台 · {CATEGORY_LABELS[definition.category]}</span>
                <h1>{definition.title}</h1>
                <p>{definition.officialIntent}</p>
              </div>
            </div>
            <span className={unavailable ? styles.unavailableState : styles.readyState}>
              {unavailable ? <CirclePause size={15} /> : <CheckCircle2 size={15} />}
              {unavailable ? "能力筹备中" : "创作准备区"}
            </span>
          </header>

          <div className={styles.parameterBar} aria-label="当前工具参数">
            <span><SlidersHorizontal size={15} />当前工具</span><strong>{definition.title}</strong>
            <span className={styles.parameterDivider} /><span>输入</span><strong>{workspace.inputHint}</strong>
            <span className={styles.parameterDivider} /><span>输出</span><strong>{workspace.outputHint}</strong>
          </div>

          <div className={styles.workspaceBody}>
            <section className={styles.controlPanel} aria-label="创作输入">
              <label className={styles.promptField}>
                <span>{workspace.promptLabel}</span>
                <textarea
                  value={draftOwner === ownerId ? prompt : ""}
                  maxLength={50_000}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={workspace.placeholder}
                  rows={8}
                  disabled={unavailable}
                />
                <small>{prompt.length} 字 · 本页草稿不会自动提交模型，也不会产生费用</small>
              </label>

              <label className={styles.uploadField} data-disabled={unavailable ? "true" : undefined}>
                <Upload size={20} />
                <span>{draftOwner === ownerId && referenceName || "选择素材名称作备忘（不上传）"}</span>
                <small>{unavailable ? "该专项能力尚未开放素材提交" : "文件只在你选择后进入当前独立页面"}</small>
                <input
                  key={ownerId}
                  type="file"
                  accept={workspace.accept}
                  disabled={unavailable}
                  onChange={(event) => setReferenceName((event.target.files?.[0]?.name || "").slice(0, 240))}
                />
              </label>

              <div className={styles.boundaryNote}>
                <strong>能力边界</strong>
                <p>{unavailable
                  ? "该专项能力尚未开放；本页不提交生成或收费，未保存输入刷新后会清空。"
                  : "本页保存当前账户的会话草稿和素材名称，不上传文件。进入实际工作台后，请填写创作要求、重新选择素材并确认价格。"}</p>
              </div>
            </section>

            <section className={styles.previewPanel} aria-label="创作预览">
              <span className={styles.previewIcon}><WorkspaceIcon size={28} /></span>
              <h2>{unavailable ? "该工具正在准备中" : "准备创作要求"}</h2>
              <p>{unavailable
                ? "专项能力尚未开放，请按需要进入相邻的现有工作台。"
                : "草稿可在本页当前会话恢复；目标工作台尚不自动导入本页内容。"}</p>
              <div className={styles.previewSteps}>
                {(unavailable
                  ? ["填写创作要求", "添加参考素材", "等待服务开放", "开放后继续"]
                  : ["填写创作要求", "添加参考素材", "前往对应工作台", "确认后提交"]
                ).map((step, index) => (
                  <span key={`${step}-${index}`}><b>{index + 1}</b>{step}</span>
                ))}
              </div>
            </section>
          </div>

          <footer className={styles.workspaceFooter}>
            <Link className={styles.secondaryAction} href={categoryHref}><ArrowLeft size={16} />返回{CATEGORY_LABELS[definition.category]}</Link>
            <div>
              {saved && draftOwner === ownerId ? <span className={styles.savedMessage}><CheckCircle2 size={14} />草稿已保存在当前会话</span> : null}
              {draftError ? <span role="status">{draftError}</span> : null}
              <button type="button" className={styles.secondaryAction} onClick={saveDraft} disabled={unavailable || !prompt.trim()}>
                <Save size={16} />保存创作草稿
              </button>
              {destinationHref ? (
                <Link
                  className={styles.primaryAction}
                  href={destinationHref}
                  data-testid="official-tool-target-link"
                >
                  {destinationLabel || "进入实际工作台"}<ArrowRight size={16} />
                </Link>
              ) : (
                <button type="button" className={styles.primaryAction} disabled>
                  <CirclePause size={16} />暂未开放
                </button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </main>
  );
}
