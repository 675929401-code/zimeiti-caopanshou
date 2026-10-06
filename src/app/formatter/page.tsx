"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { copyToClipboard } from "@/lib/utils";
import { Trash2, Zap, Copy, Check, Sparkles, ClipboardPaste, History, X, Clock, FileText } from "lucide-react";
import { SubPageHeader, NavButton } from "@/components/sub-page-header";
import { BrandFooter } from "@/components/brand-footer";
import { useApp } from "@/contexts/app-context";
import { resolveWorkbenchIdentity, workbenchUserStorageKey } from "@/lib/workbench-user-storage";
import { useToolboxHost } from "@/components/toolbox-context";

/* ───────── 排版规则 ───────── */
const FIXED_FORMAT_RULES = {
  removeExtraSpaces: true,
  removeEmptyLines: true,
  trimIndent: true,
  mergeParagraphs: true,
} as const;

function formatText(input: string): string {
  if (!input.trim()) return "";
  // 固定流程：去缩进与空行 -> 清理中文间多余空格 -> 去换行并合并段落。
  // 英文与数字之间保留一个必要空格，避免破坏型号、网址和英文短语。
  return input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[\s\t　]+/, "").trim())
    .filter(Boolean)
    .join("")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/([\u4e00-\u9fff])[^\S\r\n]+(?=[\u4e00-\u9fff])/g, "$1")
    .replace(/([\u4e00-\u9fff])[^\S\r\n]+([，。！？、；：“”‘’「」『』（）【】《》〈〉])/g, "$1$2")
    .replace(/([，。！？、；：“”‘’「」『』（）【】《》〈〉])[^\S\r\n]+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/([a-zA-Z0-9])[^\S\r\n]{2,}/g, "$1 ")
    .trim();
}

/* ───────── 统计信息 ───────── */
function getTextStats(text: string) {
  const chars = text.length;
  const lines = text ? text.split("\n").length : 0;
  const paragraphs = text ? text.split(/\n\s*\n/).filter((p) => p.trim()).length : 0;
  return { chars, lines, paragraphs };
}

/* ───────── 历史记录类型 ───────── */
interface FormatterRecord {
  id: string;
  title: string;
  original_text?: string;
  result_text?: string;
  char_count: number;
  line_count: number;
  created_at: string;
}

type FormatterHistorySaveStatus = "idle" | "saving" | "saved" | "failed";

type FormatterHistorySaveDraft = {
  original: string;
  result: string;
  rules: Record<string, boolean>;
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHr < 24) return `${diffHr}小时前`;
  if (diffDay < 7) return `${diffDay}天前`;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function getPreview(text: string, maxLen = 50): string {
  if (!text) return "";
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + "..." : clean;
}

/* ───────── 页面组件 ───────── */
export default function FormatterPage() {
  const { state } = useApp();
  const ownerUserId = resolveWorkbenchIdentity(state.auth)?.userId || "";
  return <FormatterForAccount key={ownerUserId || "signed-out"} ownerUserId={ownerUserId} />;
}

function FormatterForAccount({ ownerUserId }: { ownerUserId: string }) {
  const router = useRouter();
  const toolboxHost = useToolboxHost();
  const embedded = Boolean(toolboxHost);
  const { state } = useApp();
  const auth = state.auth;
  const authToken = auth?.token || "";
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  const [copied, setCopied] = useState(false);
  const [formatterNotice, setFormatterNotice] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<FormatterRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historySaveStatus, setHistorySaveStatus] = useState<FormatterHistorySaveStatus>("idle");
  const [historySaveMessage, setHistorySaveMessage] = useState("");
  const [pendingHistorySave, setPendingHistorySave] = useState<FormatterHistorySaveDraft | null>(null);
  const historySaveRequestRef = useRef(0);

  useEffect(() => {
    const keys = [
      "app_state_formatter_input",
      "app_state_formatter_output",
      "app_state_formatter_options",
      "app_state_formatter_input:anonymous",
      "app_state_formatter_output:anonymous",
      "app_state_formatter_options:anonymous",
    ];
    if (ownerUserId) {
      for (const base of ["formatter_input", "formatter_output", "formatter_options"]) {
        keys.push("app_state_" + workbenchUserStorageKey(base, ownerUserId));
      }
    }
    for (const key of keys) {
      try { sessionStorage.removeItem(key); } catch { /* The editor already starts from in-memory defaults. */ }
    }
  }, [ownerUserId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === "Escape" && !inInput && !embedded) router.push("/");
      if ((e.key === "Backspace" || e.key === "Delete") && !inInput) e.preventDefault();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [embedded, router]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);

  /* ─── 历史记录加载 ─── */
  const loadHistory = useCallback(async () => {
    if (!authToken) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const res = await fetch("/api/formatter/history", {
        headers: { Authorization: `Bearer ${authToken}` },
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.records)) throw new Error(data.error || "排版历史暂时无法读取");
      setHistoryList(data.records);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "排版历史暂时无法读取");
    } finally { setHistoryLoading(false); }
  }, [authToken]);

  useEffect(() => {
    if (showHistory && authToken) loadHistory();
  }, [showHistory, authToken, loadHistory]);

  /* ─── 保存记录 ─── */
  const saveRecord = useCallback(async (draft: FormatterHistorySaveDraft) => {
    if (!draft.result.trim()) return false;
    const requestId = ++historySaveRequestRef.current;
    if (!authToken) {
      setPendingHistorySave(null);
      setHistorySaveStatus("failed");
      setHistorySaveMessage("当前未登录，排版结果仅保留在本页。");
      return false;
    }
    setPendingHistorySave(draft);
    setHistorySaveStatus("saving");
    setHistorySaveMessage("正在保存到账号历史…");
    try {
      const response = await fetch("/api/formatter/history", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          title: getPreview(draft.original, 30),
          original_text: draft.original,
          result_text: draft.result,
          char_count: draft.result.length,
          line_count: draft.result.split("\n").length,
          rules: draft.rules,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "排版结果未保存到历史");
      if (historySaveRequestRef.current !== requestId) return false;
      if (data.record?.id) {
        setHistoryList((current) => [
          data.record as FormatterRecord,
          ...current.filter((record) => record.id !== data.record.id),
        ].slice(0, 100));
      }
      setPendingHistorySave(null);
      setHistorySaveStatus("saved");
      setHistorySaveMessage("已保存到账号历史");
      return true;
    } catch (error) {
      if (historySaveRequestRef.current !== requestId) return false;
      setHistorySaveStatus("failed");
      setHistorySaveMessage(error instanceof Error ? error.message : "排版结果未保存到历史");
      return false;
    }
  }, [authToken]);

  /* ─── 删除记录 ─── */
  const deleteRecord = useCallback(async (id: string) => {
    if (!authToken) return;
    setHistoryError("");
    try {
      const response = await fetch(`/api/formatter/history?id=${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) throw new Error(data.error || "排版历史删除失败");
      setHistoryList((prev) => prev.filter((r) => r.id !== id));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "排版历史删除失败");
    }
  }, [authToken]);

  const handleFormat = useCallback(async () => {
    const result = formatText(inputText);
    setOutputText(result);
    setFormatterNotice("已完成去空格、去空行、去缩进并合并段落。");
    await saveRecord({ original: inputText, result, rules: { ...FIXED_FORMAT_RULES } });
  }, [inputText, saveRecord]);

  const retryHistorySave = useCallback(async () => {
    if (!pendingHistorySave || historySaveStatus === "saving") return;
    await saveRecord(pendingHistorySave);
  }, [historySaveStatus, pendingHistorySave, saveRecord]);

  const handleClear = useCallback(() => {
    historySaveRequestRef.current += 1;
    setInputText("");
    setOutputText("");
    setPendingHistorySave(null);
    setHistorySaveStatus("idle");
    setHistorySaveMessage("");
    setFormatterNotice("");
    inputRef.current?.focus();
  }, []);

  const handleCopy = useCallback(async () => {
    if (!outputText) return;
    const ok = await copyToClipboard(outputText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setFormatterNotice("复制失败，请选中结果后手动复制。");
    }
  }, [outputText]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setInputText(text);
      setOutputText("");
      setCopied(false);
      setPendingHistorySave(null);
      setHistorySaveStatus("idle");
      setHistorySaveMessage("");
      setFormatterNotice(text ? "已从剪贴板粘贴文案。" : "剪贴板中没有可粘贴的文字。");
    } catch {
      setFormatterNotice("浏览器未授予剪贴板读取权限，请使用 Ctrl+V 粘贴。");
    }
  }, []);

  const handleInputChange = useCallback((value: string) => {
    historySaveRequestRef.current += 1;
    setInputText(value);
    setOutputText("");
    setCopied(false);
    setPendingHistorySave(null);
    setHistorySaveStatus("idle");
    setHistorySaveMessage("");
    setFormatterNotice("");
  }, []);

  const toggleHistory = useCallback(() => {
    if (!authToken) {
      setFormatterNotice("登录后可查看账号排版历史。");
      return;
    }
    setShowHistory((current) => !current);
  }, [authToken]);

  /* ─── 从历史记录恢复 ─── */
  const restoreRecord = useCallback(async (summary: FormatterRecord) => {
    if (!authToken) return;
    setHistoryError("");
    let record = summary;
    if (typeof record.original_text !== "string" || typeof record.result_text !== "string") {
      try {
        const response = await fetch(`/api/formatter/history/detail?id=${encodeURIComponent(summary.id)}`, {
          headers: { Authorization: `Bearer ${authToken}` },
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.record) throw new Error(data.error || "排版历史详情暂时无法读取");
        record = data.record as FormatterRecord;
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : "排版历史详情暂时无法读取");
        return;
      }
    }
    if (typeof record.original_text !== "string" || typeof record.result_text !== "string") {
      setHistoryError("排版历史内容不完整，请稍后重试");
      return;
    }
    setInputText(record.original_text);
    setOutputText(record.result_text);
    historySaveRequestRef.current += 1;
    setPendingHistorySave(null);
    setHistorySaveStatus("idle");
    setHistorySaveMessage("");
    setFormatterNotice("已恢复这条排版记录。");
    setShowHistory(false);
  }, [authToken]);

  const inputStats = getTextStats(inputText);
  const outputStats = getTextStats(outputText);
  const reducedChars = inputStats.chars - outputStats.chars;

  return (
    <div
      className={`voice-studio-root vs-workbench flex flex-col ${embedded ? "toolbox-embedded-workspace h-full min-h-0 overflow-hidden" : "min-h-screen"}`}
    >
      {/* 顶部导航 */}
      {!embedded && <SubPageHeader
        title="文案排版工具"
        subtitle="一键整理正文 · 登录后保存历史"
        icon={<Sparkles className="w-5 h-5" style={{ color: "var(--primary)" }} />}
        rightSlot={
          <div className="flex items-center gap-1.5">
             <NavButton icon={Zap} label="分段工具" href="/segmenter" title="前往分段工具" />
              <NavButton icon={History} label="历史" variant="ghost" active={showHistory} onClick={toggleHistory} />
           </div>
        }
      />}

      {embedded && (
        <div className="toolbox-embedded-toolbar toolbox-format-toolbar">
          <div className="toolbox-fixed-rule" role="note">
            <span className="toolbox-toolbar-label">固定排版</span>
            <strong>去空格、去空行、去缩进并合并段落</strong>
            <small>一次完成，无需逐项设置</small>
          </div>
          <button
            type="button"
            onClick={toggleHistory}
            aria-pressed={showHistory}
            className="toolbox-toolbar-action"
          >
            {showHistory ? <X className="h-3.5 w-3.5" /> : <History className="h-3.5 w-3.5" />}
            {showHistory ? "返回排版" : "历史记录"}
          </button>
        </div>
      )}

      {historyError && (
        <div role="alert" className="mx-auto mt-3 flex w-[calc(100%-1.5rem)] max-w-[1400px] items-center justify-between gap-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-[var(--error)]">
          <span>{historyError}</span>
          <button type="button" className="underline" onClick={() => setHistoryError("")}>关闭</button>
        </div>
      )}
      {!showHistory && !embedded && (
        <p role="status" className="mx-auto mt-3 w-[calc(100%-1.5rem)] max-w-[1400px] rounded-lg border border-[var(--border)] bg-[var(--accent)]/40 px-3 py-2 text-xs text-[var(--muted-foreground)]">
          固定排版规则：去空格、去空行、去缩进并合并段落 · <strong className="text-[var(--foreground)]">本地处理，免费使用</strong>
        </p>
      )}
      {historySaveStatus !== "idle" && (
        <div
          role={historySaveStatus === "failed" ? "alert" : "status"}
          aria-live="polite"
          className={`mx-auto mt-2 flex w-[calc(100%-1.5rem)] max-w-[1400px] items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs ${historySaveStatus === "failed" ? "border-red-400/30 bg-red-400/10 text-[var(--error)]" : historySaveStatus === "saved" ? "border-emerald-400/30 bg-emerald-400/10 text-[var(--success)]" : "border-[var(--border)] bg-[var(--accent)]/40 text-[var(--muted-foreground)]"}`}
        >
          <span>{historySaveMessage}</span>
          {historySaveStatus === "failed" && pendingHistorySave && (
            <button type="button" className="shrink-0 font-semibold underline" onClick={() => void retryHistorySave()}>
              重新保存
            </button>
          )}
        </div>
      )}

      {/* 历史记录侧边栏 */}
      {showHistory && (
        <div
          className="border-b animate-fade-up"
          style={{ background: "var(--card)", borderColor: "var(--border)" }}
        >
          <div className={`max-w-[1400px] mx-auto ${embedded ? "px-3 sm:px-4 py-3" : "px-4 sm:px-6 py-4"}`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold flex items-center gap-2" style={{ color: "var(--foreground)" }}>
                <Clock className="w-4 h-4" style={{ color: "var(--primary)" }} />
                排版历史
                <span className="text-xs font-normal" style={{ color: "var(--muted-foreground)" }}>
                  （最近100条 · 按提交时间）
                </span>
              </h3>
              <button onClick={() => setShowHistory(false)} className="p-1 rounded-lg hover:opacity-70">
                <X className="w-4 h-4" style={{ color: "var(--muted-foreground)" }} />
              </button>
            </div>
            {historyLoading ? (
              <div className="text-center py-8 text-sm" style={{ color: "var(--muted-foreground)" }}>
                加载中...
              </div>
            ) : historyError ? (
              <div role="alert" className="py-8 text-center text-sm text-[var(--error)]">
                <p>{historyError}</p>
                <button type="button" className="mt-2 underline" onClick={() => void loadHistory()}>重新读取</button>
              </div>
            ) : historyList.length === 0 ? (
              <div className="text-center py-8 text-sm" style={{ color: "var(--muted-foreground)" }}>
                暂无排版记录，排版后自动保存
              </div>
            ) : (
              <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                {historyList.map((record) => (
                  <div
                    key={record.id}
                    data-formatter-history-id={record.id}
                    className="flex items-start gap-3 p-3 rounded-xl border transition-all cursor-pointer group hover:shadow-md"
                    style={{ background: "var(--background)", borderColor: "var(--border)" }}
                    onClick={() => void restoreRecord(record)}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: "var(--foreground)" }}>
                        {record.title || "未命名"}
                      </p>
                      <p className="text-xs mt-1 truncate" style={{ color: "var(--muted-foreground)" }}>
                        点击查看并恢复完整排版结果
                      </p>
                      <div className="flex items-center gap-3 mt-1.5 text-xs" style={{ color: "var(--muted-foreground)" }}>
                        <span>{formatTime(record.created_at)}</span>
                        <span>{record.char_count}字</span>
                        <span>{record.line_count}行</span>
                      </div>
                    </div>
                    <button
                      aria-label={`删除排版历史 ${record.id}`}
                      onClick={(e) => { e.stopPropagation(); deleteRecord(record.id); }}
                      className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/10"
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 主内容区 */}
      <main className={`flex-1 max-w-[1400px] mx-auto w-full ${embedded ? "toolbox-two-column toolbox-balanced-layout toolbox-format-layout min-h-0 overflow-hidden px-4 py-4" : "overflow-y-auto flex flex-col px-4 sm:px-6 py-6 gap-5"}`}>
        <div className={embedded ? "toolbox-primary-pane" : "contents"}>
        {/* 输入区 */}
        <section
          className="toolbox-input-surface toolbox-format-panel toolbox-balanced-panel rounded-xl border overflow-hidden transition-shadow duration-200"
          style={{
            background: embedded ? "var(--toolbox-crystal-panel)" : "var(--card)",
            borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)",
            boxShadow: embedded ? "var(--toolbox-crystal-shadow)" : undefined,
          }}
        >
          <div
            className="toolbox-input-heading flex items-center justify-between px-5 py-3.5 border-b"
            style={{ borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)" }}
          >
            <span className="toolbox-input-title flex items-center gap-2 text-sm font-bold" style={{ color: "var(--primary)" }}>
              <FileText className="h-4 w-4" aria-hidden="true" />
              原始文案
            </span>
            <span className="toolbox-input-meta text-xs" style={{ color: "var(--muted-foreground)" }}>
              粘贴含空行/空格/换行的文本
            </span>
            <button
              onClick={handlePaste}
              className="toolbox-paste-button flex items-center gap-1.5 text-xs px-3.5 py-1.5 rounded-lg font-semibold transition-colors hover:opacity-90"
              style={{
                background: "var(--muted)",
                color: "var(--muted-foreground)",
              }}
            >
              <ClipboardPaste className="w-3.5 h-3.5" />
              粘贴
            </button>
          </div>
          <textarea
            ref={inputRef}
            aria-label="原始文案"
            value={inputText}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={"在此粘贴需要排版的文案...\n\n点击开始排版后，将自动清理空格、空行和缩进，并合并段落。"}
            className={`toolbox-balanced-textarea w-full text-base leading-[1.75] focus:outline-none placeholder:opacity-60 ${embedded ? "h-[132px] min-h-[132px] resize-none overflow-y-auto p-4" : "min-h-[220px] resize-y p-5"}`}
            style={{
              background: "transparent",
              color: "var(--foreground)",
            }}
          />
          {inputText && (
            <div
              className="px-5 py-3 border-t text-xs flex gap-6"
              style={{ borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)", color: "var(--muted-foreground)" }}
            >
              <span>字符 <strong className="font-bold" style={{ color: "var(--foreground)" }}>{inputStats.chars}</strong></span>
              <span>行数 <strong className="font-bold" style={{ color: "var(--foreground)" }}>{inputStats.lines}</strong></span>
              <span>段落 <strong className="font-bold" style={{ color: "var(--foreground)" }}>{inputStats.paragraphs}</strong></span>
            </div>
          )}
        {/* 操作按钮与输入框属于同一个功能卡片，保持结果区起始线稳定 */}
        <div className={`toolbox-card-actions toolbox-command-row ${embedded ? "toolbox-command-row-two" : ""} flex items-center justify-end gap-3`}>
          <button
            onClick={handleClear}
            className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
            style={{
              background: embedded ? "var(--toolbox-crystal-field)" : "var(--muted)",
              color: "var(--muted-foreground)",
            }}
          >
            <Trash2 className="w-4 h-4" />
            清空
          </button>
          <button
            onClick={() => void handleFormat()}
            disabled={!inputText.trim() || historySaveStatus === "saving"}
            className="toolbox-primary-action flex items-center gap-2.5 px-12 py-3.5 rounded-xl text-base font-bold transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed shadow-lg btn-ripple"
            style={{
              background: !inputText.trim() || historySaveStatus === "saving" ? "var(--muted)" : "var(--primary)",
              color: !inputText.trim() || historySaveStatus === "saving" ? "var(--muted-foreground)" : "var(--primary-foreground)",
              boxShadow: embedded || !inputText.trim() || historySaveStatus === "saving" ? "none" : "0 4px 24px var(--theme-glow)",
            }}
          >
            {historySaveStatus === "saving" ? <Clock className="w-5 h-5 animate-pulse" /> : <Zap className="w-5 h-5" />}
            {historySaveStatus === "saving" ? "正在保存" : "开始排版"}
          </button>
        </div>
        {formatterNotice && (
          <p className="toolbox-inline-notice toolbox-card-notice" role="status" aria-live="polite">{formatterNotice}</p>
        )}
        </section>
        </div>

        <div className={embedded ? "toolbox-result-pane" : "contents"}>
        {/* 输出区 */}
        {outputText && (
          <section
            className="toolbox-results-block toolbox-format-panel toolbox-balanced-panel rounded-xl border overflow-hidden animate-fade-up transition-shadow duration-200"
            style={{
              background: embedded ? "var(--toolbox-crystal-panel)" : "var(--card)",
              borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)",
              boxShadow: embedded ? "var(--toolbox-crystal-shadow)" : undefined,
            }}
          >
            <div
              className="toolbox-results-heading flex items-center justify-between px-5 py-3.5 border-b"
              style={{ borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)" }}
            >
              <div className="flex items-center gap-3">
                <span
                  className="text-xs font-bold px-3.5 py-1.5 rounded-full tracking-wide"
                  style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
                >
                  排版结果
                </span>
                {reducedChars > 0 && (
                  <span
                    className="text-xs font-semibold px-2.5 py-1 rounded-full"
                    style={{ background: "color-mix(in srgb, var(--primary) 15%, transparent)", color: "var(--primary)" }}
                  >
                    减少 {reducedChars} 字符
                  </span>
                )}
              </div>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all hover:opacity-90 active:scale-95"
                style={{
                  background: "var(--primary)",
                  color: "var(--primary-foreground)",
                }}
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    一键复制
                  </>
                )}
              </button>
            </div>
            <textarea
              ref={outputRef}
              aria-label="排版结果"
              value={outputText}
              readOnly
              className={`toolbox-balanced-textarea w-full p-5 text-[15px] leading-[1.9] focus:outline-none ${embedded ? "min-h-[220px] resize-none" : "min-h-[200px] resize-y"}`}
              style={{
                background: "transparent",
                color: "var(--foreground)",
              }}
            />
            <div
              className="toolbox-results-footer px-5 py-3 border-t text-xs flex gap-6"
              style={{ borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)", color: "var(--muted-foreground)" }}
            >
              <span>字符 <strong className="font-bold" style={{ color: "var(--foreground)" }}>{outputStats.chars}</strong></span>
              <span>行数 <strong className="font-bold" style={{ color: "var(--foreground)" }}>{outputStats.lines}</strong></span>
              <span>段落 <strong className="font-bold" style={{ color: "var(--foreground)" }}>{outputStats.paragraphs}</strong></span>
            </div>
          </section>
        )}

        {/* 空状态提示 */}
        {!outputText && (
          <section className={embedded ? "toolbox-empty-result toolbox-format-panel toolbox-result-empty-card animate-fade-up" : "flex-1 flex items-center justify-center py-16 animate-fade-up"}>
            {embedded && (
              <div className="toolbox-empty-heading">
                <FileText className="h-4 w-4" aria-hidden="true" />
                排版结果
              </div>
            )}
            <div className={embedded ? "toolbox-empty-body" : undefined}>
            <div className="text-center max-w-lg" style={{ color: "var(--muted-foreground)" }}>
              {!embedded && <div className="text-5xl mb-5 animate-float">🧹</div>}
              <h3 className={`${embedded ? "text-sm mb-1.5" : "text-xl mb-3"} font-bold`} style={{ color: "var(--foreground)" }}>
                {inputText ? "等待排版结果" : "粘贴文案，一键排版"}
              </h3>
              <p className={`${embedded ? "text-xs" : "text-sm"} leading-relaxed mb-2`}>
                {inputText ? "点击开始排版，清理后的完整文案会在此列显示。" : "固定执行去空格、去空行、去缩进并合并段落"}
              </p>
              {!embedded && <p className="text-sm leading-relaxed">
                将AI生成或复制来的文案粘贴到上方，点击「开始排版」即可得到干净文本
              </p>}
              {!embedded && <div className="mt-6 flex flex-wrap justify-center gap-2.5">
                {["去空格", "去空行", "去缩进", "合并段落"].map((tag) => (
                  <span
                    key={tag}
                    className={`text-xs font-semibold border ${embedded ? "px-2.5 py-1 rounded-md" : "px-4 py-2 rounded-full"}`}
                    style={{ background: "var(--muted)", color: "var(--muted-foreground)", borderColor: "var(--border)" }}
                  >
                    {tag}
                  </span>
                ))}
              </div>}
            </div>
            </div>
          </section>
        )}
        </div>
      </main>

      {/* 统一品牌底部栏 */}
      {!embedded && <BrandFooter privacyNote="排版本身在当前页面完成；登录用户的原文与结果会保存到个人历史" />}
    </div>
  );
}
