"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  Eye,
  FilePlus2,
  History,
  ImageIcon,
  Loader2,
  LockKeyhole,
  Pin,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useApp } from "@/contexts/app-context";
import type {
  HelpArticle,
  HelpArticleVersion,
  HelpCatalog,
  HelpFailure,
  HelpMediaInternal,
} from "@/lib/help-center-domain";
import styles from "./help-admin.module.css";

interface AdminResponse {
  catalog?: HelpCatalog;
  source?: string;
  warning?: string;
  error?: string;
}

function AdminHelpSurface({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${styles.adminRoot} admin-light-shell`}
      data-admin-theme="soft-white"
      data-theme="soft-white"
      data-mode="light"
    >
      {children}
    </div>
  );
}

function toLines(items: string[]): string {
  return items.join("\n");
}

function fromLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 40);
}

function toLocalDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromLocalDateTime(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function statusLabel(article: HelpArticle): string {
  if (article.status === "draft") return "草稿";
  if (article.publishedAt && new Date(article.publishedAt) > new Date()) return "待发布";
  return "已发布";
}

function newArticle(): HelpArticle {
  const stamp = Date.now();
  return {
    id: `article-${stamp}`,
    slug: `draft-${stamp}`,
    categoryId: "guides",
    articleType: "guide",
    title: "未命名教程",
    summary: "",
    keywords: [],
    body: "",
    applicability: "",
    preparation: [],
    steps: [],
    costAndWait: "",
    successCriteria: [],
    failures: [],
    notes: "等待真实案例。",
    returnPath: "/help",
    returnLabel: "返回学习中心",
    status: "draft",
    pinned: false,
    recommended: false,
    sortOrder: 100,
    visibility: "public",
    publishedAt: null,
    updatedAt: new Date().toISOString(),
    readMinutes: 3,
    mediaIds: [],
    coverMediaId: null,
  };
}

function publishingIssues(article: HelpArticle, media: HelpMediaInternal[]): string[] {
  if (article.status !== "published") return [];
  const issues: string[] = [];
  if (!article.title.trim()) issues.push("标题不能为空");
  if (!article.summary.trim()) issues.push("摘要不能为空");
  if (!article.body.trim()) issues.push("正文不能为空");
  if (!article.applicability.trim()) issues.push("缺少适用场景");
  if (!article.preparation.length) issues.push("缺少准备内容");
  if (!article.steps.length) issues.push("缺少操作步骤");
  if (!article.costAndWait.trim()) issues.push("缺少费用与等待说明");
  if (!article.successCriteria.length) issues.push("缺少成功判定");
  if (!article.failures.length) issues.push("缺少常见失败");
  if (!article.publishedAt || Number.isNaN(new Date(article.publishedAt).getTime())) issues.push("缺少有效发布时间");
  if (!article.mediaIds.length) issues.push("发布文章必须选择真实页面或真实生成媒体");
  const selected = article.mediaIds.map((id) => media.find((item) => item.id === id)).filter(Boolean) as HelpMediaInternal[];
  if (selected.some((item) => item.verificationStatus !== "verified")) issues.push("存在等待核验或失效媒体");
  if (article.articleType === "case" && selected.some((item) => item.sourceKind !== "generated_result")) issues.push("案例只能使用真实生成结果");
  return issues;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className={styles.field}><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>{children}</label>;
}

function ArticleList({
  catalog,
  selectedId,
  onSelect,
  onCreate,
}: {
  catalog: HelpCatalog;
  selectedId: string;
  onSelect: (article: HelpArticle) => void;
  onCreate: () => void;
}) {
  const articles = [...catalog.articles].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder);
  return (
    <aside className={styles.articleRail} aria-label="教程列表">
      <header><div><BookOpen aria-hidden="true" /><span><strong>教程内容</strong><small>{catalog.articles.length} 篇 · 数据修订 {catalog.revision}</small></span></div><button type="button" onClick={onCreate} aria-label="新建教程"><FilePlus2 aria-hidden="true" /></button></header>
      <div className={styles.adminArticleList}>
        {articles.map((article) => (
          <button key={article.id} type="button" className={selectedId === article.id ? styles.selectedArticle : ""} onClick={() => onSelect(article)}>
            <span className={`${styles.statusDot} ${article.status === "published" ? styles.publishedDot : ""}`} aria-hidden="true" />
            <span><strong>{article.title}</strong><small>{statusLabel(article)} · {catalog.categories.find((category) => category.id === article.categoryId)?.label}</small></span>
            {article.pinned ? <Pin aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
        ))}
      </div>
      <footer><button type="button" onClick={onCreate}><Plus aria-hidden="true" />新建草稿</button></footer>
    </aside>
  );
}

function MediaLibrary({ media, article, onChange }: { media: HelpMediaInternal[]; article: HelpArticle; onChange: (article: HelpArticle) => void }) {
  const toggle = (item: HelpMediaInternal) => {
    const active = article.mediaIds.includes(item.id);
    const mediaIds = active ? article.mediaIds.filter((id) => id !== item.id) : [...article.mediaIds, item.id];
    onChange({ ...article, mediaIds, coverMediaId: active && article.coverMediaId === item.id ? mediaIds[0] || null : article.coverMediaId || item.id });
  };
  return (
    <section className={styles.mediaLibrary} aria-labelledby="admin-media-title">
      <div className={styles.panelHeading}><div><ImageIcon aria-hidden="true" /><span><strong id="admin-media-title">真实媒体选择</strong><small>内部追溯字段只在后台显示</small></span></div><em>{article.mediaIds.length} 已选</em></div>
      <div className={styles.mediaOptions}>
        {media.map((item) => {
          const active = article.mediaIds.includes(item.id);
          const verified = item.verificationStatus === "verified";
          return (
            <article key={item.id} className={active ? styles.mediaActive : ""}>
              <button type="button" onClick={() => toggle(item)} aria-pressed={active}>
                <span className={styles.mediaPreview}>
                  {item.assetPath ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={item.kind === "video" ? item.posterPath : item.assetPath} alt="" />
                    </>
                  ) : <ImageIcon aria-hidden="true" />}
                  {active && <i><Check aria-hidden="true" /></i>}
                </span>
                <span className={styles.mediaInfo}><strong>{item.title}</strong><small>{item.sourceKind === "generated_result" ? "真实生成" : item.sourceKind === "ui_capture" ? "页面实拍" : "非案例素材"} · {verified ? "已核验" : "等待核验"}</small></span>
              </button>
              <dl><div><dt>task</dt><dd>{item.trace.taskId || "—"}</dd></div><div><dt>run</dt><dd>{item.trace.runId || "—"}</dd></div><div><dt>history</dt><dd>{item.trace.historyId || "—"}</dd></div><div><dt>模型</dt><dd>{item.publicModelName}</dd></div></dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function VersionPanel({ versions, onRollback, busy }: { versions: HelpArticleVersion[]; onRollback: (version: HelpArticleVersion) => void; busy: boolean }) {
  return (
    <aside className={styles.versionPanel} aria-labelledby="version-title">
      <div className={styles.panelHeading}><div><History aria-hidden="true" /><span><strong id="version-title">版本历史</strong><small>保存前自动保留上一版</small></span></div></div>
      {versions.length ? <div className={styles.versionList}>{versions.map((version) => <article key={version.id}><span><strong>修订 {version.revision}</strong><small>{new Date(version.savedAt).toLocaleString("zh-CN")} · {version.savedBy}</small></span><button type="button" disabled={busy || !version.snapshot} onClick={() => onRollback(version)}><RotateCcw aria-hidden="true" />回滚</button></article>)}</div> : <p className={styles.noVersions}>保存一次后会在这里出现可回滚版本。</p>}
    </aside>
  );
}

export default function HelpAdminPage() {
  const { state } = useApp();
  const token = state.auth.token || "";
  const isAdmin = state.auth.user?.role === "admin";
  const [catalog, setCatalog] = useState<HelpCatalog | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<HelpArticle | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState("");

  useEffect(() => {
    const body = document.body;
    const previousAdminSurface = body.getAttribute("data-admin-surface-active");
    body.setAttribute("data-admin-surface-active", "true");
    return () => {
      if (previousAdminSurface === null) body.removeAttribute("data-admin-surface-active");
      else body.setAttribute("data-admin-surface-active", previousAdminSurface);
    };
  }, []);

  useEffect(() => {
    if (!token || !isAdmin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch("/api/admin/help", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as AdminResponse;
        if (!response.ok || !data.catalog) throw new Error(data.error || "帮助内容读取失败");
        return data;
      })
      .then((data) => {
        if (cancelled || !data.catalog) return;
        setCatalog(data.catalog);
        setSource(data.source || "");
        const first = data.catalog.articles[0];
        if (first) { setSelectedId(first.id); setDraft(structuredClone(first)); }
        if (data.warning) setMessage(data.warning);
      })
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : "帮助内容读取失败"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [isAdmin, token]);

  const versions = useMemo(() => (catalog?.history || []).filter((version) => version.articleId === selectedId), [catalog?.history, selectedId]);
  const issues = draft && catalog ? publishingIssues(draft, catalog.media) : [];

  const selectArticle = (article: HelpArticle) => {
    setSelectedId(article.id);
    setDraft(structuredClone(article));
    setMessage("");
    setError("");
  };

  const createDraft = () => {
    const article = newArticle();
    setSelectedId(article.id);
    setDraft(article);
    setMessage("新草稿尚未保存");
    setError("");
  };

  const save = async () => {
    if (!catalog || !draft || !token) return;
    if (issues.length) { setError(`暂不能发布：${issues.join("；")}`); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/help", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "upsertArticle", expectedRevision: catalog.revision, article: draft }),
      });
      const data = await response.json().catch(() => ({})) as AdminResponse;
      if (!response.ok || !data.catalog) throw new Error(data.error || "保存失败");
      setCatalog(data.catalog);
      const saved = data.catalog.articles.find((article) => article.id === draft.id) || data.catalog.articles.find((article) => article.slug === draft.slug);
      if (saved) { setSelectedId(saved.id); setDraft(structuredClone(saved)); }
      setSource(data.source || source);
      setMessage("已保存；上一版已与本次更新一并写入版本历史。 ");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally { setBusy(false); }
  };

  const rollback = async (version: HelpArticleVersion) => {
    if (!catalog || !draft || !token || !version.snapshot) return;
    if (!window.confirm(`确认把“${draft.title}”回滚到修订 ${version.revision}？当前版本会先进入历史。`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/help", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "rollback", expectedRevision: catalog.revision, articleId: draft.id, versionId: version.id }),
      });
      const data = await response.json().catch(() => ({})) as AdminResponse;
      if (!response.ok || !data.catalog) throw new Error(data.error || "回滚失败");
      setCatalog(data.catalog);
      const restored = data.catalog.articles.find((article) => article.id === draft.id);
      if (restored) setDraft(structuredClone(restored));
      setMessage("已回滚，回滚前版本仍保留在历史中。 ");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "回滚失败"); }
    finally { setBusy(false); }
  };

  if (loading) return <AdminHelpSurface><div className={styles.centerState}><Loader2 className={styles.spin} aria-hidden="true" /><h1>正在验证管理员身份</h1><p>不会进行任何云端写入。</p></div></AdminHelpSurface>;
  if (!isAdmin) return <AdminHelpSurface><div className={styles.centerState}><LockKeyhole aria-hidden="true" /><h1>仅管理员可访问学习中心后台</h1><p>{state.auth.isAuthenticated ? "当前账号没有管理员权限。" : "请先使用管理员账号登录。"}</p><div><Link href={state.auth.isAuthenticated ? "/help" : "/login"}>{state.auth.isAuthenticated ? "返回学习中心" : "前往登录"}</Link><span aria-hidden="true"> · </span><Link href="/">返回主页</Link></div></div></AdminHelpSurface>;
  if (error && !catalog) return <AdminHelpSurface><div className={styles.centerState}><AlertCircle aria-hidden="true" /><h1>后台数据读取失败</h1><p>{error}</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></div></AdminHelpSurface>;
  if (!catalog || !draft) return <AdminHelpSurface><div className={styles.centerState}><BookOpen aria-hidden="true" /><h1>暂无可编辑内容</h1><button type="button" onClick={createDraft}>新建草稿</button></div></AdminHelpSurface>;

  return (
    <AdminHelpSurface>
      <header className={styles.adminHeader}>
        <div>
          <Link href="/admin"><ArrowLeft aria-hidden="true" /><span>后台首页</span></Link>
          <span><BookOpen aria-hidden="true" /><span><strong>学习中心管理</strong><small>草稿、发布、证据、版本与预览</small></span></span>
          <div><em>{source === "seed" ? "内置种子" : "云端目录"}</em><Link href="/help"><Eye aria-hidden="true" /><span>前台预览</span></Link></div>
        </div>
      </header>
      <main className={styles.adminShell}>
        <ArticleList catalog={catalog} selectedId={selectedId} onSelect={selectArticle} onCreate={createDraft} />
        <section className={styles.editor}>
          <header className={styles.editorHeader}><div><span className={`${styles.editorStatus} ${draft.status === "published" ? styles.editorPublished : ""}`}>{statusLabel(draft)}</span><h1>{draft.title}</h1><p>修订 {catalog.revision} · 更新于 {new Date(draft.updatedAt).toLocaleString("zh-CN")}</p></div><div><button type="button" onClick={() => window.open(`/help/${encodeURIComponent(draft.slug)}?preview=1`, "_blank")}><Eye aria-hidden="true" />预览</button><button type="button" className={styles.saveButton} disabled={busy || issues.length > 0} onClick={save}>{busy ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Save aria-hidden="true" />}保存</button></div></header>
          {(message || error || issues.length > 0) && <div className={`${styles.feedback} ${error || issues.length ? styles.feedbackError : ""}`} role={error || issues.length ? "alert" : "status"}>{error || (issues.length ? `发布前还需：${issues.join("；")}` : message)}</div>}
          <div className={styles.formSections}>
            <section className={styles.formCard}><h2>发布与分类</h2><div className={styles.metaGrid}>
              <Field label="状态"><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as HelpArticle["status"] })}><option value="draft">草稿</option><option value="published">发布</option></select></Field>
              <Field label="分类"><select value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value as HelpArticle["categoryId"] })}>{catalog.categories.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></Field>
              <Field label="类型"><select value={draft.articleType} onChange={(event) => setDraft({ ...draft, articleType: event.target.value as HelpArticle["articleType"] })}><option value="guide">教程</option><option value="case">真实案例</option><option value="faq">常见问题</option><option value="troubleshooting">故障排查</option></select></Field>
              <Field label="可见范围"><select value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: event.target.value as HelpArticle["visibility"] })}><option value="public">所有人</option><option value="authenticated">登录用户</option><option value="admins">仅管理员</option></select></Field>
              <Field label="发布时间"><input type="datetime-local" value={toLocalDateTime(draft.publishedAt)} onChange={(event) => setDraft({ ...draft, publishedAt: fromLocalDateTime(event.target.value) })} /></Field>
              <Field label="排序"><input type="number" min="0" max="9999" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: Number(event.target.value) || 0 })} /></Field>
              <Field label="阅读分钟"><input type="number" min="1" max="60" value={draft.readMinutes} onChange={(event) => setDraft({ ...draft, readMinutes: Number(event.target.value) || 1 })} /></Field>
              <div className={styles.checks}><label><input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} />置顶</label><label><input type="checkbox" checked={draft.recommended} onChange={(event) => setDraft({ ...draft, recommended: event.target.checked })} />推荐</label></div>
            </div></section>
            <section className={styles.formCard}><h2>标题、摘要与正文</h2><div className={styles.stack}>
              <Field label="标题"><input value={draft.title} maxLength={180} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
              <Field label="Slug" hint="公开详情地址，只能使用小写字母、数字和连字符"><input value={draft.slug} maxLength={80} onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></Field>
              <Field label="摘要"><textarea rows={2} value={draft.summary} maxLength={500} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></Field>
              <Field label="关键词" hint="用逗号分隔"><input value={draft.keywords.join(", ")} onChange={(event) => setDraft({ ...draft, keywords: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })} /></Field>
              <Field label="正文"><textarea rows={7} value={draft.body} maxLength={20000} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></Field>
            </div></section>
            <section className={styles.formCard}><h2>标准教程结构</h2><div className={styles.stack}>
              <Field label="适用场景"><textarea rows={3} value={draft.applicability} onChange={(event) => setDraft({ ...draft, applicability: event.target.value })} /></Field>
              <Field label="准备内容" hint="每行一项"><textarea rows={4} value={toLines(draft.preparation)} onChange={(event) => setDraft({ ...draft, preparation: fromLines(event.target.value) })} /></Field>
              <div className={styles.repeater}><div className={styles.repeaterHeading}><strong>操作步骤</strong><button type="button" onClick={() => setDraft({ ...draft, steps: [...draft.steps, { title: "新步骤", body: "" }] })}><Plus aria-hidden="true" />添加步骤</button></div>{draft.steps.map((step, index) => <div key={index} className={styles.repeatRow}><span>{index + 1}</span><input value={step.title} aria-label={`步骤 ${index + 1} 标题`} onChange={(event) => { const next = [...draft.steps]; next[index] = { ...step, title: event.target.value }; setDraft({ ...draft, steps: next }); }} /><textarea rows={2} value={step.body} aria-label={`步骤 ${index + 1} 说明`} onChange={(event) => { const next = [...draft.steps]; next[index] = { ...step, body: event.target.value }; setDraft({ ...draft, steps: next }); }} /><button type="button" aria-label={`删除步骤 ${index + 1}`} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 aria-hidden="true" /></button></div>)}</div>
              <Field label="费用与等待说明"><textarea rows={4} value={draft.costAndWait} onChange={(event) => setDraft({ ...draft, costAndWait: event.target.value })} /></Field>
              <Field label="成功判定" hint="每行一项"><textarea rows={4} value={toLines(draft.successCriteria)} onChange={(event) => setDraft({ ...draft, successCriteria: fromLines(event.target.value) })} /></Field>
              <div className={styles.repeater}><div className={styles.repeaterHeading}><strong>常见失败</strong><button type="button" onClick={() => setDraft({ ...draft, failures: [...draft.failures, { problem: "新问题", action: "" }] })}><Plus aria-hidden="true" />添加失败项</button></div>{draft.failures.map((failure, index) => <div key={index} className={styles.repeatRow}><span>!</span><input value={failure.problem} aria-label={`失败项 ${index + 1} 问题`} onChange={(event) => { const next: HelpFailure[] = [...draft.failures]; next[index] = { ...failure, problem: event.target.value }; setDraft({ ...draft, failures: next }); }} /><textarea rows={2} value={failure.action} aria-label={`失败项 ${index + 1} 处理`} onChange={(event) => { const next: HelpFailure[] = [...draft.failures]; next[index] = { ...failure, action: event.target.value }; setDraft({ ...draft, failures: next }); }} /><button type="button" aria-label={`删除失败项 ${index + 1}`} onClick={() => setDraft({ ...draft, failures: draft.failures.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 aria-hidden="true" /></button></div>)}</div>
              <Field label="证据/安全备注"><textarea rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
              <div className={styles.twoColumns}><Field label="返回入口"><input value={draft.returnPath} onChange={(event) => setDraft({ ...draft, returnPath: event.target.value })} /></Field><Field label="返回按钮文字"><input value={draft.returnLabel} onChange={(event) => setDraft({ ...draft, returnLabel: event.target.value })} /></Field></div>
            </div></section>
            <MediaLibrary media={catalog.media} article={draft} onChange={setDraft} />
          </div>
        </section>
        <VersionPanel versions={versions} onRollback={rollback} busy={busy} />
      </main>
      <footer className={styles.safetyBar}><ShieldCheck aria-hidden="true" /><span>公共 API 会移除 trace、run、task、history、provider、channel、内部模型 ID 与密钥字段；真实追溯仅管理员可见。</span><Clock3 aria-hidden="true" /><span>保存使用修订号并发检查，冲突时拒绝覆盖。</span></footer>
    </AdminHelpSurface>
  );
}
