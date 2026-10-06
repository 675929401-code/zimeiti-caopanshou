"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { copyToClipboard } from "@/lib/utils";
import { Zap, Trash2, Copy, Check, ClipboardPaste, Type, AlignLeft, Sparkles, History, X, ChevronRight, Clock, Home } from "lucide-react";
import { SubPageHeader, NavButton } from "@/components/sub-page-header";
import { BrandFooter } from "@/components/brand-footer";
import { useApp } from "@/contexts/app-context";
import { resolveWorkbenchIdentity } from "@/lib/workbench-user-storage";
import { clearRetiredSegmenterDraft, consumeExtractSegmentDraft } from "@/lib/extract-segment-handoff";
import {
  countChars,
  DURATION_MODES,
  normalizeForIntegrity,
  reconstructSegmentedText,
  segmentTextRule,
  type SegmentResult,
} from "@/lib/segmenter-core";
import { useToolboxHost } from "@/components/toolbox-context";

const DURATION_HINTS: Record<number, string> = {
  8: "快节奏",
  10: "轻快口播",
  12: "常规口播",
  15: "舒缓口播",
  16: "剧情旁白",
  20: "深度讲述",
  25: "长段配音",
};

function getSegmentCountLabel(count: number, min: number, max: number, accepted: boolean, last: boolean) {
  if (count >= min && count <= max) return { label: '✓ 目标范围内', kind: 'target' as const };
  if (accepted && last && count < min) return { label: '尾段偏短，保留完整句子', kind: 'tail' as const };
  return { label: count < min ? '偏短' : '偏长', kind: 'outside' as const };
}

/* ========== 历史记录类型 ========== */
interface HistoryRecord {
  id: string;
  title: string | null;
  mode: string;
  char_count: number;
  segment_count: number;
  created_at: string;
}

/* ========== UI 组件 ========== */

export default function SegmenterPage() {
  const { state } = useApp();
  const ownerUserId = resolveWorkbenchIdentity(state.auth)?.userId || "";
  return <SegmenterForAccount key={ownerUserId || "signed-out"} ownerUserId={ownerUserId} />;
}

function SegmenterForAccount({ ownerUserId }: { ownerUserId: string }) {
  const router = useRouter();
  const toolboxHost = useToolboxHost();
  const embedded = Boolean(toolboxHost);
  const { state, checkAuth } = useApp();
  const auth = state.auth;
  const [inputReady, setInputReady] = useState(false);
  const [authRestoring, setAuthRestoring] = useState(true);
  const [inputText, setInputText] = useState("");
  const [duration, setDuration] = useState(8);
  const [result, setResult] = useState<SegmentResult | null>(null);
  const [segmenting, setSegmenting] = useState(false);
  const [segmentNotice, setSegmentNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputInitializedRef = useRef(false);

  // 历史记录状态
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<HistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void checkAuth().catch(() => undefined).finally(() => {
      if (mounted) setAuthRestoring(false);
    });
    return () => { mounted = false; };
  }, [checkAuth]);

  // checkAuth keeps fetching balances after it has already restored identity.
  // A slow balance refresh must not keep a confirmed account's form locked.
  useEffect(() => {
    if (auth.isAuthenticated && auth.user?.id && auth.token) setAuthRestoring(false);
  }, [auth]);

  // Only an explicit "送去分段" handoff may prefill this editor. Consume it
  // once; ordinary typing and results never survive a refresh or later visit.
  useEffect(() => {
    if (inputInitializedRef.current) return;
    if (!ownerUserId && authRestoring) return;
    clearRetiredSegmenterDraft(ownerUserId);
    if (ownerUserId) {
      try { setInputText(consumeExtractSegmentDraft(ownerUserId)); } catch { setInputText(""); }
    }
    inputInitializedRef.current = true;
    setInputReady(true);
  }, [authRestoring, ownerUserId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === "Escape" && !inInput && !embedded) router.push("/");
      if ((e.key === "Backspace" || e.key === "Delete") && !inInput) e.preventDefault();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [embedded, router]);

  const mode = DURATION_MODES[duration];
  const inputCharCount = countChars(inputText);

  /* 加载历史记录 */
  const loadHistory = useCallback(async () => {
    if (!auth?.user?.id) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const res = await fetch("/api/segmenter/history", {
        headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.history)) throw new Error(data.error || '分段历史暂时无法读取');
      setHistoryList(data.history);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '分段历史暂时无法读取');
    } finally { setHistoryLoading(false); }
  }, [auth]);

  /* 打开/关闭历史面板 */
  const toggleHistory = useCallback(() => {
    if (!auth?.isAuthenticated || !auth.user?.id || !auth.token) {
      setSegmentNotice('登录后可查看个人分段历史。');
      return;
    }
    if (!showHistory) loadHistory();
    setShowHistory(prev => !prev);
  }, [auth, showHistory, loadHistory]);

  /* 查看历史详情 */
  const viewHistoryDetail = useCallback(async (id: string) => {
    if (!auth?.user?.id) return;
    setSelectedHistoryId(id);
    setHistoryError("");
    try {
      const res = await fetch(`/api/segmenter/history/detail?id=${encodeURIComponent(id)}`, {
        headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.record) throw new Error(data.error || '分段历史详情暂时无法读取');
        if (data.record) {
        const originalText = typeof data.record.original_text === "string" ? data.record.original_text : "";
        if (!originalText.trim()) throw new Error("分段历史原文不完整");
        try {
          const parsed = data.record.result_text ? JSON.parse(data.record.result_text) : null;
          if (!parsed || !Array.isArray(parsed.segments) || parsed.segments.length === 0
            || parsed.segments.some((segment: unknown) => typeof segment !== "string" || !segment.trim())) {
            throw new Error("分段历史结果不完整");
          }
          const restoredModeEntry = Object.entries(DURATION_MODES).find(([, value]) => value.label === data.record.mode);
          const restoredDuration = restoredModeEntry ? Number(restoredModeEntry[0]) : duration;
          const restoredMode = DURATION_MODES[restoredDuration] || mode;
          if (parsed.paragraphBreakBefore === undefined) {
            parsed.paragraphBreakBefore = parsed.segments.map(() => false);
          } else if (!Array.isArray(parsed.paragraphBreakBefore)
            || parsed.paragraphBreakBefore.length !== parsed.segments.length
            || parsed.paragraphBreakBefore.some((value: unknown) => typeof value !== "boolean")) {
            throw new Error("分段历史段落边界不完整");
          }
          const derivedCounts = parsed.segments.map((segment: string) => countChars(segment));
          if (!Array.isArray(parsed.counts) || parsed.counts.length !== parsed.segments.length
            || parsed.counts.some((value: unknown, index: number) => !Number.isFinite(value) || value !== derivedCounts[index])) {
            parsed.counts = derivedCounts;
          }
          if (!Array.isArray(parsed.compliant) || parsed.compliant.length !== parsed.segments.length
            || parsed.compliant.some((value: unknown) => typeof value !== "boolean")) {
            parsed.compliant = derivedCounts.map((value: number, index: number) => (
              index === derivedCounts.length - 1 && value < restoredMode.min
                ? true
                : value >= restoredMode.min && value <= restoredMode.max
            ));
          }
          if (parsed.overlapPrefixes !== undefined && (
            !Array.isArray(parsed.overlapPrefixes)
            || parsed.overlapPrefixes.length !== parsed.segments.length
            || parsed.overlapPrefixes.some((value: unknown) => typeof value !== "string")
          )) {
            parsed.overlapPrefixes = parsed.segments.map(() => "");
          }
          if (normalizeForIntegrity(reconstructSegmentedText(parsed.segments, parsed.overlapPrefixes))
            !== normalizeForIntegrity(originalText)) {
            throw new Error("分段历史结果与原文不一致");
          }
          setInputText(originalText);
          setResult(parsed);
        } catch (error) {
          throw error instanceof Error ? error : new Error("分段历史结果无法读取");
        }
        if (data.record.mode) {
          const sec = Object.entries(DURATION_MODES).find(([, value]) => value.label === data.record.mode);
          if (sec) setDuration(Number(sec[0]));
        }
        setSaved(true);
        setShowHistory(false);
      }
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '分段历史详情暂时无法读取');
    }
  }, [auth.user, auth.token, duration, mode]);

  /* 删除历史记录 */
  const deleteHistory = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistoryError("");
    try {
      const response = await fetch(`/api/segmenter/history?id=${id}`, {
        method: 'DELETE',
        headers: auth?.token ? { Authorization: `Bearer ${auth.token}` } : {},
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) throw new Error(data.error || '分段历史删除失败');
      setHistoryList(prev => prev.filter(h => h.id !== id));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '分段历史删除失败');
    }
  }, [auth]);

  const saveResultToHistory = useCallback(async (nextResult: SegmentResult) => {
    if (!auth?.user?.id) return false;
    try {
      const res = await fetch('/api/segmenter/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify({
          title: inputText.slice(0, 30) + (inputText.length > 30 ? '...' : ''),
          original_text: inputText,
          result_text: JSON.stringify(nextResult),
          mode: mode.label,
          rules: {
            engine: 'local_rule_v2',
            duration,
            min: mode.min,
            max: mode.max,
          },
          char_count: inputCharCount,
          segment_count: nextResult.segments.length,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '分段结果未保存到历史');
      setSaved(true);
      void loadHistory();
      return true;
    } catch (error) {
      setSegmentNotice(error instanceof Error ? `结果已生成，但${error.message}` : '结果已生成，但分段历史保存失败');
      return false;
    }
  }, [auth, duration, inputText, mode, inputCharCount, loadHistory]);

  /* 保存到历史记录 */
  const saveToHistory = useCallback(async () => {
    if (!result || saved) return;
    await saveResultToHistory(result);
  }, [result, saved, saveResultToHistory]);

  const handleSegment = useCallback(async () => {
    if (!inputText.trim() || segmenting) return;
    if (!inputReady) {
      setSegmentNotice('正在恢复文案输入，请稍后再分段');
      return;
    }
    setSegmenting(true);
    setSaved(false);
    setSegmentNotice(null);
    try {
      const nextResult = segmentTextRule(inputText, duration);
      setResult(nextResult);
      if (auth?.isAuthenticated && auth.user?.id && auth.token) {
        const historySaved = await saveResultToHistory(nextResult);
        if (historySaved) setSegmentNotice('已按所选时长、字数范围和标点规则完成分段，并保存到个人历史。');
      } else {
        setSegmentNotice('已按所选时长、字数范围和标点规则完成分段；登录后可保存到个人历史。');
      }
    } finally {
      setSegmenting(false);
    }
  }, [inputText, inputReady, duration, auth, segmenting, saveResultToHistory]);

  const handleClear = useCallback(() => {
    setInputText('');
    setResult(null);
    setCopied(false);
    setSaved(false);
    setSegmentNotice(null);
    textareaRef.current?.focus();
  }, [setInputText, setResult]);

  const handleInputChange = useCallback((value: string) => {
    setInputText(value);
    setResult(null);
    setCopied(false);
    setSaved(false);
    setSegmentNotice(null);
  }, []);

  const handleDurationChange = useCallback((nextDuration: number) => {
    if (nextDuration === duration) return;
    setDuration(nextDuration);
    setResult(null);
    setCopied(false);
    setSaved(false);
    setSegmentNotice(inputText.trim() ? '分段时长已更新，请点击开始分段。' : null);
  }, [duration, inputText]);

  const handleCopy = useCallback(() => {
    if (!result) return;
    const text = result.segments
      .map((seg, i) => `${i + 1}.【${seg}】`)
      .join('\n');
    copyToClipboard(text).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        setSegmentNotice('复制失败，请选中结果后手动复制。');
      }
    });
  }, [result]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setInputText(text);
      setResult(null);
      setCopied(false);
      setSaved(false);
      setSegmentNotice(text ? '已从剪贴板粘贴文案。' : '剪贴板中没有可粘贴的文字。');
    } catch {
      setSegmentNotice('浏览器未授予剪贴板读取权限，请使用 Ctrl+V 粘贴。');
    }
  }, [setInputText, setResult]);

  const totalSegments = result?.segments.length ?? 0;
  const totalChars = result ? result.counts.reduce((a, b) => a + b, 0) : 0;
  const avgChars = totalSegments > 0
    ? Math.round(totalChars / totalSegments)
    : 0;
  const segmentCountLabels = result?.counts.map((count, index) => getSegmentCountLabel(
    count, mode.min, mode.max, Boolean(result.compliant[index]), index === result.counts.length - 1,
  )) || [];
  const targetRangeCount = segmentCountLabels.filter((item) => item.kind === 'target').length;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (showHistory || (embedded && toolboxHost?.activeTab !== "segment")) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSegment();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [embedded, handleSegment, showHistory, toolboxHost?.activeTab]);

  /* 按日期分组 */
  const groupedHistory = historyList.reduce<Record<string, HistoryRecord[]>>((acc, rec) => {
    const d = new Date(rec.created_at);
    const now = new Date();
    let key: string;
    if (d.toDateString() === now.toDateString()) key = '今天';
    else {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      key = d.toDateString() === yesterday.toDateString() ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`;
    }
    if (!acc[key]) acc[key] = [];
    acc[key].push(rec);
    return acc;
  }, {});

  return (
    <div className={`secondary-workbench voice-studio-root vs-workbench flex flex-col overflow-hidden ${embedded ? "toolbox-embedded-workspace h-full" : "h-screen"}`}>
      {/* 顶部导航 */}
      {!embedded && <SubPageHeader
        title="智能文案分段"
        subtitle="按目标时长、字数范围与标点规则快速切分"
        icon={<Sparkles className="w-5 h-5" style={{ color: "var(--primary)" }} />}
        rightSlot={
          <div className="flex items-center gap-1.5">
            <NavButton icon={Home} label="应用广场" href="/" title="返回应用广场" />
            <NavButton icon={History} label="历史" variant="ghost" active={showHistory} onClick={toggleHistory} title={showHistory ? "返回创作" : "历史记录"} />
          </div>
        }
      />}

      {embedded && (
        <div className="toolbox-embedded-toolbar toolbox-duration-toolbar">
          <div className="toolbox-duration-control">
            <span className="toolbox-toolbar-label">分段时长</span>
            <div className="toolbox-duration-options" role="group" aria-label="选择分段时长">
              {Object.entries(DURATION_MODES).map(([sec, cfg]) => {
                const isActive = duration === Number(sec);
                return (
                  <button
                    key={sec}
                    type="button"
                    aria-label={`${cfg.label}，每段${cfg.desc}`}
                    aria-pressed={isActive}
                    onClick={() => handleDurationChange(Number(sec))}
                    className="toolbox-duration-chip"
                    data-active={isActive ? "true" : "false"}
                    data-duration={sec}
                    title={`${cfg.desc} · ${DURATION_HINTS[Number(sec)]}`}
                  >
                    {sec}秒
                  </button>
                );
              })}
            </div>
            <span className="toolbox-duration-summary" role="status">
              {mode.desc}/段 · {DURATION_HINTS[duration]}
            </span>
          </div>
          <button
            type="button"
            onClick={toggleHistory}
            aria-pressed={showHistory}
            className="toolbox-toolbar-action"
          >
            {showHistory ? <X className="h-3.5 w-3.5" /> : <History className="h-3.5 w-3.5" />}
            {showHistory ? "返回分段" : "历史记录"}
          </button>
        </div>
      )}

      <main className={`flex-1 w-full ${embedded ? "min-h-0 overflow-hidden" : "overflow-y-auto"}`}>
        <div className={`max-w-[1400px] mx-auto w-full flex flex-col ${embedded ? "toolbox-segment-shell h-full min-h-0 px-4 py-4 gap-3" : "px-4 sm:px-6 py-6 gap-5"}`}>
        {historyError && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-[var(--error)]">
            <span>{historyError}</span>
            <button type="button" className="underline" onClick={() => setHistoryError("")}>关闭</button>
          </div>
        )}
        {!embedded && <div role="note" className="rounded-lg border border-[var(--border)] bg-[var(--accent)]/40 px-3 py-2 text-xs text-[var(--muted-foreground)]">
          分段规则：按所选时长对应的字数范围，在标点和原文段落处自动切分。
        </div>}
        {/* ===== 历史记录面板 ===== */}
        {showHistory ? (
          <section className="animate-fade-up">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <History className="w-5 h-5" style={{ color: "var(--primary)" }} />
                <h3 className="text-lg font-bold" style={{ color: "var(--foreground)" }}>分段历史记录</h3>
                <span className="text-xs px-3 py-1 rounded-full font-medium" style={{ background: "var(--muted)", color: "var(--muted-foreground)" }}>
                  最近100条 · 按提交时间
                </span>
              </div>
            </div>

            {historyLoading ? (
              <div className={`text-center ${embedded ? "py-8" : "py-16"}`}>
                <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: "var(--primary)", borderTopColor: "transparent" }} />
                <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>加载中...</p>
              </div>
            ) : historyError ? (
              <div role="alert" className={`text-center text-[var(--error)] ${embedded ? "py-8" : "py-16"}`}>
                <p className="text-sm">{historyError}</p>
                <button type="button" className="mt-2 text-xs underline" onClick={() => void loadHistory()}>重新读取</button>
              </div>
            ) : historyList.length === 0 ? (
              <div className={`text-center ${embedded ? "py-8" : "py-16"}`}>
                {!embedded && <div className="text-4xl mb-4">📭</div>}
                <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>暂无历史记录</p>
                <p className="text-xs mt-1" style={{ color: "var(--muted-foreground)" }}>分段结果会自动保存到历史</p>
              </div>
            ) : (
              <div className="space-y-6">
                {Object.entries(groupedHistory).map(([date, records]) => (
                  <div key={date}>
                    <div className="flex items-center gap-2 mb-3">
                      <Clock className="w-3.5 h-3.5" style={{ color: "var(--primary)" }} />
                      <span className="text-xs font-bold tracking-wide" style={{ color: "var(--primary)" }}>{date}</span>
                      <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>({records.length}条)</span>
                    </div>
                    <div className="space-y-2">
                      {records.map((rec) => (
                        <div
                          key={rec.id}
                          data-segmenter-history-id={rec.id}
                          onClick={() => { void viewHistoryDetail(rec.id); }}
                          className="group flex items-center justify-between px-4 py-3.5 rounded-xl border cursor-pointer transition-all duration-200 hover:shadow-md"
                          style={{
                            background: "var(--card)",
                            borderColor: selectedHistoryId === rec.id ? "var(--primary)" : "var(--border)",
                          }}
                        >
                          <div className="flex-1 min-w-0 mr-3">
                            <p className="text-sm font-semibold truncate" style={{ color: "var(--foreground)" }}>
                              {rec.title || '未命名分段'}
                            </p>
                            <div className="flex items-center gap-3 mt-1">
                              <span className="text-xs font-medium" style={{ color: "var(--muted-foreground)" }}>
                                {rec.mode}
                              </span>
                              <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                                {rec.char_count}字 · {rec.segment_count}段
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                              {new Date(rec.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <ChevronRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: "var(--primary)" }} />
                            <button
                              aria-label={`删除分段历史 ${rec.id}`}
                              onClick={(e) => deleteHistory(rec.id, e)}
                              className="opacity-0 group-hover:opacity-100 p-1 rounded-lg transition-all hover:bg-red-500/10"
                            >
                              <X className="w-3.5 h-3.5 text-[var(--error)]" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : (
          <div className={embedded ? "toolbox-two-column toolbox-balanced-layout toolbox-segment-layout flex-1 min-h-0" : "contents"}>
            {/* ===== 创作模式：上下分栏布局 ===== */}
            {/* 上半部分：sticky 固定区域（输入+模式+按钮） */}
            <div className={`${embedded ? "toolbox-primary-pane" : "sticky top-0 z-10 pb-3 space-y-4"}`} style={{ background: embedded ? "transparent" : "var(--vs-bg)" }}>
              {/* 输入区 */}
              <section
                className={`toolbox-input-surface toolbox-balanced-panel ${embedded ? "rounded-xl" : "rounded-2xl"} border overflow-hidden transition-shadow duration-200`}
                style={{
                  background: embedded ? "var(--toolbox-crystal-panel)" : "var(--vs-glass-bg)",
                  borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--vs-glass-border)",
                  backdropFilter: embedded ? "none" : "blur(12px)",
                  boxShadow: embedded ? "var(--toolbox-crystal-shadow)" : "var(--vs-glass-shadow)",
                }}
              >
                <div
                  className="toolbox-input-heading flex items-center justify-between px-5 py-3 border-b"
                  style={{ borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)" }}
                >
                  <div className="toolbox-input-title flex items-center gap-3">
                    <Type className="w-4 h-4" style={{ color: "var(--primary)" }} />
                    <span className="text-sm font-bold" style={{ color: "var(--primary)" }}>输入文案</span>
                  </div>
                  <span className="toolbox-input-meta text-xs font-medium" style={{ color: "var(--muted-foreground)" }}>
                    {inputCharCount}字（仅统计汉字和数字）
                  </span>
                  <button
                    onClick={handlePaste}
                    disabled={!inputReady}
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
                {!inputReady && <p role="status" aria-live="polite" className="px-4 py-2 text-xs text-muted-foreground">正在恢复文案输入...</p>}
                <textarea
                  ref={textareaRef}
                  aria-label="需要分段的文案"
                  aria-busy={!inputReady}
                  disabled={!inputReady}
                  value={inputText}
                  onChange={e => handleInputChange(e.target.value)}
                  placeholder={"在此粘贴或输入需要分段的文案内容...\n\n支持 Ctrl+Enter 快捷分段"}
                  className={`toolbox-balanced-textarea w-full resize-none text-base leading-[1.75] focus:outline-none placeholder:opacity-60 ${embedded ? "h-[132px] min-h-[132px] overflow-y-auto p-4" : "h-[180px] p-5"}`}
                  style={{
                    background: "transparent",
                    color: "var(--vs-text)",
                  }}
                />
              {/* 时长模式与操作按钮属于输入功能卡片 */}
              <div className={`toolbox-card-actions flex items-center gap-3 flex-wrap ${embedded ? "justify-end" : "justify-between"}`}>
                {!embedded && <div className="flex flex-wrap gap-2">
                  {Object.entries(DURATION_MODES).map(([sec, cfg]) => {
                    const isActive = duration === Number(sec);
                    return (
                      <button
                        key={sec}
                        onClick={() => handleDurationChange(Number(sec))}
                        className="px-4 py-2 rounded-lg text-xs font-bold transition-all duration-200 border"
                        style={{
                          background: isActive ? "var(--vs-primary)" : "var(--vs-surface)",
                          color: isActive ? "var(--primary-foreground)" : "var(--vs-text-muted)",
                          borderColor: isActive ? "var(--vs-primary)" : "var(--vs-border)",
                          boxShadow: isActive ? "0 0 16px color-mix(in srgb, var(--vs-glow) 40%, transparent)" : "none",
                        }}
                      >
                        {cfg.label}
                        <span className="ml-1.5 opacity-60 text-[10px]">({cfg.desc})</span>
                      </button>
                    );
                  })}
                </div>}
                <div className={`toolbox-command-row ${embedded ? "toolbox-command-row-two" : ""} flex items-center gap-2`}>
                  <button
                    onClick={handleClear}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
                    style={{ background: "var(--muted)", color: "var(--muted-foreground)" }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    清空
                  </button>
                  <button
                    onClick={handleSegment}
                    disabled={!inputReady || !inputText.trim() || segmenting}
                    className="toolbox-primary-action flex items-center gap-1.5 px-8 py-2 rounded-lg text-sm font-bold transition-all active:scale-[0.98] disabled:cursor-not-allowed btn-ripple"
                    style={{
                      background: !inputReady || !inputText.trim() || segmenting ? "var(--muted)" : "var(--primary)",
                      color: !inputReady || !inputText.trim() || segmenting ? "var(--muted-foreground)" : "var(--primary-foreground)",
                      boxShadow: embedded || !inputReady || !inputText.trim() || segmenting ? "none" : "0 2px 16px var(--theme-glow)",
                    }}
                  >
                    <Zap className="w-4 h-4" />
                    {segmenting ? '正在分段...' : '开始分段'}
                  </button>
                </div>

                {embedded && segmentNotice && (
                  <div
                    className="rounded-lg border px-3 py-2 text-xs font-medium animate-fade-up"
                    style={{
                      background: "color-mix(in srgb, var(--vs-primary) 8%, transparent)",
                      borderColor: "var(--vs-border)",
                      color: "var(--muted-foreground)",
                    }}
                  >
                    {segmentNotice}
                  </div>
                )}
              </div>
              </section>
            </div>

            {!embedded && segmentNotice && (
              <div
                className="rounded-xl border px-4 py-2.5 text-xs font-medium animate-fade-up"
                style={{
                  background: "color-mix(in srgb, var(--vs-primary) 8%, transparent)",
                  borderColor: "var(--vs-border)",
                  color: "var(--muted-foreground)",
                }}
              >
                {segmentNotice}
              </div>
            )}

            {/* 下半部分：分段结果区（独立滚动） */}
            <div className={embedded ? "toolbox-result-pane" : "contents"} aria-busy={segmenting}>
            {result && result.segments.length > 0 ? (
              <section
                data-segmenter-result="true"
                className="toolbox-results-block toolbox-balanced-panel h-full rounded-xl border p-5 space-y-4 animate-fade-up"
                style={{
                  background: embedded ? "var(--toolbox-crystal-panel)" : "var(--vs-glass-bg)",
                  borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--vs-glass-border)",
                  backdropFilter: embedded ? "none" : "blur(12px)",
                  boxShadow: embedded ? "var(--toolbox-crystal-shadow)" : "var(--vs-glass-shadow)",
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <AlignLeft className="w-4 h-4" style={{ color: "var(--primary)" }} />
                    <span className="text-sm font-bold" style={{ color: "var(--primary)" }}>分段结果</span>
                    <span className="text-xs font-medium" style={{ color: "var(--muted-foreground)" }}>
                      {mode.label}（{mode.desc}）
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleCopy}
                      className="toolbox-result-action flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors hover:opacity-90"
                      style={{ borderColor: embedded ? "var(--toolbox-crystal-line)" : "var(--border)", background: embedded ? "var(--toolbox-crystal-field)" : "var(--card)", color: "var(--foreground)" }}
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? '已复制' : '复制结果'}
                    </button>
                    {!saved && auth.isAuthenticated && auth.user?.id && auth.token && (
                      <button
                        onClick={saveToHistory}
                        className="text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors hover:opacity-90"
                        style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
                      >
                        保存记录
                      </button>
                    )}
                    {!saved && (!auth.isAuthenticated || !auth.user?.id || !auth.token) && (
                      <span className="text-xs font-medium text-[var(--muted-foreground)]">登录后可保存历史</span>
                    )}
                    {saved && (
                      <span className="text-xs font-semibold text-[var(--success)] flex items-center gap-1">
                        <Check className="w-3 h-3" /> 已保存
                      </span>
                    )}
                  </div>
                </div>

                <div className="toolbox-segment-result-list pr-1 flex flex-col gap-[2px]">
                  {result.segments.map((seg, i) => {
                    const charCount = result.counts[i];
                    const countLabel = segmentCountLabels[i];
                    const hasBreak = result.paragraphBreakBefore?.[i];
                    const overlapPrefix = result.overlapPrefixes?.[i];
                    return (
                      <div key={i} data-segment-index={i}>
                        {/* 段落分隔：原文空行处插入视觉间隔 */}
                        {hasBreak && (
                          <div className="my-1 flex items-center gap-2" style={{ color: "var(--muted-foreground)" }}>
                            <div className="flex-1 border-t border-dashed" style={{ borderColor: "var(--border)" }} />
                            <span className="text-[10px] opacity-50 whitespace-nowrap">段落分隔</span>
                            <div className="flex-1 border-t border-dashed" style={{ borderColor: "var(--border)" }} />
                          </div>
                        )}
                        {/* 分段卡片：深色圆角背景 + 序号 + 【】括号 + 字数标签 */}
                        <div
                          className="rounded-lg px-3 py-1.5 transition-colors hover:bg-[var(--vs-surface-hover)]"
                          style={{ background: "color-mix(in srgb, var(--vs-primary) 8%, transparent)" }}
                        >
                          <div className="flex items-start gap-1.5">
                            <span
                              className="shrink-0 text-xs font-bold mt-0.5 select-none"
                              style={{ color: "var(--muted-foreground)" }}
                            >
                              {i + 1}.
                            </span>
                            <p className="text-sm leading-[1.5] break-all" style={{ color: "var(--foreground)" }}>
                              【{seg}】
                            </p>
                          </div>
                          <span
                            className={`inline-flex items-center gap-0.5 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                               countLabel.kind === 'target'
                                 ? 'bg-emerald-500/15 text-[var(--success)] dark:text-[var(--success)]'
                                : countLabel.kind === 'tail' ? 'bg-sky-500/15 text-[var(--info)] dark:text-[var(--info)]'
                                 : 'bg-amber-500/15 text-[var(--warning)] dark:text-[var(--warning)]'
                            }`}
                          >
                            {charCount}字 {countLabel.label}
                          </span>
                          {overlapPrefix && (
                            <span className="ml-1 inline-flex items-center rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-bold text-[var(--info)] dark:text-[var(--info)]" title={`承接上一段原文：${overlapPrefix}`}>
                              含{countChars(overlapPrefix)}字衔接复述
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* 统计栏 */}
                <div
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-3 border-t text-xs font-medium"
                  style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
                >
                  <span>{totalChars}字（仅统计汉字和数字）</span>
                  <span>当前模式 <strong className="font-bold" style={{ color: "var(--primary)" }}>{mode.desc}</strong></span>
                  <span>共 <strong className="font-bold" style={{ color: "var(--foreground)" }}>{totalSegments}</strong> 段</span>
                  <span>均 <strong className="font-bold" style={{ color: "var(--foreground)" }}>{avgChars}</strong> 字</span>
                  <span>
                    目标范围内 <strong className={`font-bold ${targetRangeCount === totalSegments ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>{targetRangeCount}</strong>/{totalSegments}
                  </span>
                </div>
              </section>
            ) : (
              /* 空状态 */
              <section className={embedded ? "toolbox-empty-result toolbox-result-empty-card" : "flex items-center justify-center py-12 animate-fade-up"}>
                {embedded && (
                  <div className="toolbox-empty-heading">
                    <AlignLeft className="h-4 w-4" aria-hidden="true" />
                    分段结果
                    <span className="ml-auto text-xs font-medium text-[var(--muted-foreground)]">{duration}秒 · {mode.desc}/段</span>
                  </div>
                )}
                <div className={embedded ? "toolbox-empty-body" : undefined}>
                <div className="text-center max-w-md">
                  {!embedded && <div className="text-5xl mb-5 animate-float">✂️</div>}
                  <h3 className={`${embedded ? "text-sm mb-1.5" : "text-xl mb-3"} font-bold`} style={{ color: "var(--foreground)" }}>
                    {segmenting ? "正在分段" : inputText ? "等待生成分段" : "粘贴文案，快速分段"}
                  </h3>
                  <p className={`${embedded ? "text-xs" : "text-sm"} leading-relaxed`} style={embedded ? undefined : { color: "var(--muted-foreground)" }}>
                    {segmenting ? "正在按字数范围、标点和原文段落拆分文案。" : inputText ? "选择时长后点击开始分段，结果会在此列显示。" : "按口播时长对应的字数范围切分，优先在标点和原文段落处断开。"}
                  </p>
                  {!embedded && <div className="mt-6 flex flex-wrap justify-center gap-2.5">
                    {Object.values(DURATION_MODES).map((cfg) => (
                      <span
                        key={cfg.label}
                        className={`text-xs font-semibold border ${embedded ? "px-2.5 py-1 rounded-md" : "px-4 py-2 rounded-full"}`}
                        style={{ background: "var(--muted)", color: "var(--muted-foreground)", borderColor: "var(--border)" }}
                      >
                        {cfg.label}({cfg.desc})
                      </span>
                    ))}
                  </div>}
                </div>
                </div>
              </section>
            )}
            </div>
          </div>
        )}
        </div>
      </main>

      {/* 统一品牌底部栏 */}
      {!embedded && <BrandFooter privacyNote="分段按字数、标点和原文段落规则在当前页面完成；登录后可保存到个人历史" />}
    </div>
  );
}
