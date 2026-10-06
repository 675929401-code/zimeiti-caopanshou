"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  X, Undo2, Redo2, RotateCcw, Layout, Type, Grid3X3,
  Navigation, Tag, ChevronDown, ChevronRight,
  AlertTriangle, Check, Minimize2, Maximize2, Loader2, Save
} from "lucide-react";
import {
  PageLayoutConfig, DEFAULT_PAGE_LAYOUT,
  CardLayoutConfig, NavLayoutConfig, CategoryLayoutConfig,
  DEFAULT_CARD_LAYOUT, DEFAULT_NAV_LAYOUT, DEFAULT_CATEGORY_LAYOUT,
  TITLE_FONT_PRESETS,
} from "@/types/coze";

// ---- 滑块控件 ----
interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step = 1, unit = "px", onChange }: SliderProps) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-[12px] text-[var(--foreground)] opacity-70 w-[90px] shrink-0 truncate" title={label}>{label}</span>
      <input
        type="range" min={min} max={max} step={step}
        value={value} onChange={e => onChange(Number(e.target.value))}
        className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer
          bg-[var(--border)]
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary)]
          [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer"
      />
      <span className="text-[12px] font-mono text-[var(--primary)] w-[52px] text-right shrink-0">
        {value}{unit}
      </span>
    </div>
  );
}

// ---- 折叠面板 ----
function Section({
  title, icon, children, defaultOpen = true
}: {
  title: string; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--muted)] hover:bg-[var(--accent)] transition-colors"
      >
        {icon}
        <span className="text-[13px] font-semibold text-[var(--foreground)] flex-1 text-left">{title}</span>
        {open ? <ChevronDown className="w-4 h-4 text-[var(--muted-foreground)]" /> : <ChevronRight className="w-4 h-4 text-[var(--muted-foreground)]" />}
      </button>
      {open && <div className="px-3 py-2 space-y-0.5">{children}</div>}
    </div>
  );
}

// ---- 辅助函数：头像位置名称 ----
function avatarPositionLabel(pos: string): string {
  const map: Record<string, string> = {
    "left": "左侧", "right": "右侧", "top": "顶部", "top-center": "顶部居中",
    "top-left": "左上角", "top-right": "右上角", "bottom-left": "左下角", "bottom-right": "右下角",
  };
  return map[pos] || pos;
}

// ---- 主编辑器 ----
interface LayoutEditorProps {
  layout: PageLayoutConfig;
  onChange: (layout: PageLayoutConfig) => void;
  onSave: () => Promise<void>;
  onReset: () => Promise<void>;
  onClose: () => void;
}

export default function LayoutEditor({ layout, onChange, onSave, onReset, onClose }: LayoutEditorProps) {
  // 撤销历史栈
  const [history, setHistory] = useState<PageLayoutConfig[]>([layout]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // 保存状态
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const lastSavedJson = useRef<string>(JSON.stringify(layout));

  // 折叠/最小化状态
  const [minimized, setMinimized] = useState(false);

  // 当前是否修改过（与最近保存版本比较）
  const isDirty = JSON.stringify(layout) !== lastSavedJson.current;

  // 能否撤销/重做
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  // 记录历史
  const pushHistory = useCallback((newLayout: PageLayoutConfig) => {
    setHistory(prev => {
      const next = prev.slice(0, historyIndex + 1);
      next.push(newLayout);
      if (next.length > 50) next.shift();
      return next;
    });
    setHistoryIndex(prev => Math.min(prev + 1, 49));
  }, [historyIndex]);

  // 撤销
  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      onChange(history[newIndex]);
    }
  }, [history, historyIndex, onChange]);

  // 重做
  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      onChange(history[newIndex]);
    }
  }, [history, historyIndex, onChange]);

  // 更新卡片布局
  const updateCard = useCallback((key: keyof CardLayoutConfig, value: number | string | boolean) => {
    const newLayout = { ...layout, card: { ...layout.card, [key]: value } };
    onChange(newLayout);
    pushHistory(newLayout);
  }, [layout, onChange, pushHistory]);

  // 更新导航栏布局
  const updateNav = useCallback((key: keyof NavLayoutConfig, value: number) => {
    const newLayout = { ...layout, nav: { ...layout.nav, [key]: value } };
    onChange(newLayout);
    pushHistory(newLayout);
  }, [layout, onChange, pushHistory]);

  // 更新分类栏布局
  const updateCategory = useCallback((key: keyof CategoryLayoutConfig, value: number) => {
    const newLayout = { ...layout, category: { ...layout.category, [key]: value } };
    onChange(newLayout);
    pushHistory(newLayout);
  }, [layout, onChange, pushHistory]);

  // 手动保存
  const handleSave = useCallback(async () => {
    const json = JSON.stringify(layout);
    if (json === lastSavedJson.current) return;
    setSaving(true);
    try {
      await onSave();
      lastSavedJson.current = json;
      setLastSaved(new Date());
    } finally {
      setSaving(false);
    }
  }, [layout, onSave]);

  // 恢复默认
  const handleReset = async () => {
    onChange(DEFAULT_PAGE_LAYOUT);
    pushHistory(DEFAULT_PAGE_LAYOUT);
    try {
      await onReset();
      lastSavedJson.current = JSON.stringify(DEFAULT_PAGE_LAYOUT);
      setLastSaved(new Date());
    } finally {
      setShowResetConfirm(false);
    }
  };

  // 关闭前提示未保存
  const handleClose = useCallback(() => {
    if (isDirty) {
      const ok = window.confirm("有未保存的修改，确定关闭吗？关闭后修改将丢失。");
      if (!ok) return;
    }
    onClose();
  }, [isDirty, onClose]);

  // ESC关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose, undo, redo, handleSave]);

  return (
    <>
      {/* 最小化浮动按钮 */}
      {minimized && (
        <button
          onClick={() => setMinimized(false)}
          className="fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5
            bg-[var(--card)] border border-[var(--border)] rounded-full shadow-2xl
            hover:shadow-[var(--primary)]/20 hover:border-[var(--primary)]/40 transition-all group"
          title="展开布局编辑器"
        >
          <Layout className="w-4 h-4 text-[var(--primary)]" />
          <span className="text-[13px] font-semibold text-[var(--foreground)]">布局编辑器</span>
          {isDirty && <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" title="有未保存的修改" />}
          <Maximize2 className="w-3.5 h-3.5 text-[var(--muted-foreground)] group-hover:text-[var(--primary)] transition-colors" />
        </button>
      )}

      {/* 浮动面板 */}
      {!minimized && (
      <div className="fixed top-4 right-4 bottom-4 w-[340px] z-50 flex flex-col
        bg-[var(--card)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]"
          style={{ background: "color-mix(in srgb, var(--primary) 8%, var(--card))" }}>
          <Layout className="w-5 h-5 text-[var(--primary)]" />
          <span className="text-[14px] font-bold text-[var(--foreground)] flex-1">布局编辑器</span>

          {/* 撤销/重做 */}
          <button onClick={undo} disabled={!canUndo}
            className="p-1.5 rounded-md hover:bg-[var(--accent)] disabled:opacity-30 transition-colors"
            title="撤销 (Ctrl+Z)">
            <Undo2 className="w-4 h-4 text-[var(--foreground)]" />
          </button>
          <button onClick={redo} disabled={!canRedo}
            className="p-1.5 rounded-md hover:bg-[var(--accent)] disabled:opacity-30 transition-colors"
            title="重做 (Ctrl+Y)">
            <Redo2 className="w-4 h-4 text-[var(--foreground)]" />
          </button>
          <button onClick={() => setMinimized(true)}
            className="p-1.5 rounded-md hover:bg-[var(--accent)] transition-colors" title="最小化">
            <Minimize2 className="w-4 h-4 text-[var(--foreground)]" />
          </button>
          <button onClick={handleClose}
            className="p-1.5 rounded-md hover:bg-[var(--accent)] transition-colors" title="关闭">
            <X className="w-4 h-4 text-[var(--foreground)]" />
          </button>
        </div>

        {/* 内容区 - 可滚动 */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* ① 智能体卡片 — 基础尺寸 */}
          <Section title="卡片尺寸" icon={<Grid3X3 className="w-4 h-4 text-[var(--primary)]" />}>
            <Slider label="列数" value={layout.card.columns} min={1} max={8} onChange={v => updateCard("columns", v)} unit="列" />
            <Slider label="卡片高度" value={layout.card.cardHeight} min={0} max={500} onChange={v => updateCard("cardHeight", v)} />
            <Slider label="水平间距" value={layout.card.gapX} min={0} max={200} onChange={v => updateCard("gapX", v)} />
            <Slider label="垂直间距" value={layout.card.gapY} min={0} max={200} onChange={v => updateCard("gapY", v)} />
            <Slider label="卡片圆角" value={layout.card.borderRadius} min={0} max={96} onChange={v => updateCard("borderRadius", v)} />
            <Slider label="内边距-左右" value={layout.card.paddingX} min={4} max={80} onChange={v => updateCard("paddingX", v)} />
            <Slider label="内边距-上下" value={layout.card.paddingY} min={4} max={80} onChange={v => updateCard("paddingY", v)} />
            <Slider label="透明度" value={layout.card.opacity ?? 72} min={10} max={100} step={2} onChange={v => updateCard("opacity", v)} unit="%" />
          </Section>

          {/* ② 头像设置 */}
          <Section title="头像设置" icon={<Type className="w-4 h-4 text-[var(--primary)]" />}>
            <Slider label="头像宽度" value={layout.card.avatarWidth || layout.card.avatarSize} min={16} max={260} onChange={v => updateCard("avatarWidth", v)} />
            <Slider label="头像高度" value={layout.card.avatarHeight || layout.card.avatarSize} min={16} max={260} onChange={v => updateCard("avatarHeight", v)} />
            <Slider label="头像圆角" value={layout.card.avatarRadius} min={0} max={50} onChange={v => updateCard("avatarRadius", v)} />
            {/* 头像位置可视化九宫格 */}
            <div className="flex items-start gap-4 py-2">
              <div className="relative shrink-0">
                <div className="w-[80px] h-[56px] rounded-lg border-2 border-[var(--border)] bg-[var(--muted)]/50 relative overflow-hidden">
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-full h-px bg-[var(--border)]" />
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="h-full w-px bg-[var(--border)]" />
                  </div>
                  <div className="absolute inset-[2px] grid grid-cols-3 grid-rows-3 gap-0">
                    {([
                      { pos: "top-left", label: "↖" },
                      { pos: "top-center", label: "↑" },
                      { pos: "top-right", label: "↗" },
                      { pos: "left", label: "←" },
                      { pos: "center", label: "⊕" },
                      { pos: "right", label: "→" },
                      { pos: "bottom-left", label: "↙" },
                      { pos: "bottom-center", label: "↓" },
                      { pos: "bottom-right", label: "↘" },
                    ] as { pos: string; label: string }[]).map((item, i) => {
                      const isActive = layout.card.avatarPosition === item.pos;
                      return (
                        <button
                          key={i}
                          onClick={() => updateCard("avatarPosition", item.pos === "center" ? "left" : item.pos)}
                          className={`flex items-center justify-center text-[10px] transition-all rounded-sm
                            ${isActive
                              ? "bg-[var(--primary)] text-white scale-110 shadow-sm"
                              : "hover:bg-[var(--primary)]/20 text-[var(--muted-foreground)]"
                            }`}
                          title={item.pos}
                        >
                          {isActive ? (
                            <span className="w-2 h-2 rounded-full bg-white inline-block" />
                          ) : item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="text-center mt-1.5 text-[10px] text-[var(--muted-foreground)]">
                  {avatarPositionLabel(layout.card.avatarPosition)}
                </div>
              </div>
              <div className="flex-1 grid grid-cols-2 gap-1 min-w-0">
                {[
                  { pos: "left", label: "左侧" },
                  { pos: "right", label: "右侧" },
                  { pos: "top", label: "顶部" },
                  { pos: "top-center", label: "顶部居中" },
                  { pos: "top-left", label: "左上角" },
                  { pos: "top-right", label: "右上角" },
                  { pos: "bottom-left", label: "左下角" },
                  { pos: "bottom-right", label: "右下角" },
                ].map(item => (
                  <button
                    key={item.pos}
                    onClick={() => updateCard("avatarPosition", item.pos)}
                    className={`px-2 py-1 rounded-md text-[10px] font-medium transition-all truncate
                      ${layout.card.avatarPosition === item.pos
                        ? "bg-[var(--primary)] text-white shadow-sm"
                        : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
                      }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          {/* ③ 标题样式 */}
          <Section title="标题样式" icon={<Type className="w-4 h-4 text-[var(--primary)]" />}>
            <Slider label="标题字号" value={layout.card.titleFontSize} min={10} max={64} onChange={v => updateCard("titleFontSize", v)} />
            <Slider label="标题粗细" value={layout.card.titleFontWeight} min={100} max={900} step={100} onChange={v => updateCard("titleFontWeight", v)} unit="" />
            <Slider label="标题字距" value={layout.card.titleLetterSpacing ?? 0} min={-5} max={8} step={0.1} onChange={v => updateCard("titleLetterSpacing", v)} />
            {/* 标题字体选择 */}
            <div className="flex items-start gap-3 py-1.5">
              <span className="text-[12px] text-[var(--foreground)] opacity-70 w-[90px] shrink-0 pt-1">标题字体</span>
              <div className="flex-1 min-w-0">
                <div className="grid grid-cols-3 gap-1">
                  {TITLE_FONT_PRESETS.map(font => {
                    const isActive = (layout.card.titleFontFamily || "noto-serif-sc") === font.id;
                    return (
                      <button
                        key={font.id}
                        onClick={() => updateCard("titleFontFamily", font.id)}
                        className={`px-1.5 py-1.5 rounded-md text-[10px] font-medium transition-all truncate text-center
                          ${isActive
                            ? "bg-[var(--primary)] text-white shadow-sm"
                            : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
                          }`}
                        style={{ fontFamily: font.family }}
                        title={font.name}
                      >
                        {font.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <Slider label="标题水平" value={layout.card.titleOffsetX ?? 0} min={-60} max={60} onChange={v => updateCard("titleOffsetX", v)} />
            <Slider label="标题垂直" value={layout.card.titleOffsetY ?? 0} min={-60} max={60} onChange={v => updateCard("titleOffsetY", v)} />
            <button
              onClick={() => { updateCard("titleOffsetX", 0); updateCard("titleOffsetY", 0); }}
              className="w-full mt-1 px-3 py-1.5 rounded-lg text-[12px] font-medium
                bg-[var(--primary)]/10 text-[var(--primary)] border border-[var(--primary)]/20
                hover:bg-[var(--primary)]/20 transition-colors"
            >
              重置标题偏移
            </button>
          </Section>

          {/* ④ 描述样式 */}
          <Section title="描述样式" icon={<Type className="w-4 h-4 text-[var(--primary)]" />}>
            <Slider label="描述字号" value={layout.card.descFontSize} min={8} max={48} onChange={v => updateCard("descFontSize", v)} />
            <Slider label="描述粗细" value={layout.card.descFontWeight} min={100} max={900} step={100} onChange={v => updateCard("descFontWeight", v)} unit="" />
            <Slider label="描述字距" value={layout.card.descLetterSpacing ?? 0} min={-1} max={8} step={0.5} onChange={v => updateCard("descLetterSpacing", v)} />
            <Slider label="描述行高" value={layout.card.descLineHeight ?? 1.5} min={1} max={3} step={0.1} onChange={v => updateCard("descLineHeight", v)} unit="倍" />
            <Slider label="描述行数" value={layout.card.descMaxLines} min={0} max={8} onChange={v => updateCard("descMaxLines", v)} unit={layout.card.descMaxLines === 0 ? "不限" : "行"} />
            <Slider label="文字水平" value={layout.card.textOffsetX ?? 0} min={-60} max={60} onChange={v => updateCard("textOffsetX", v)} />
            <Slider label="文字垂直" value={layout.card.textOffsetY ?? 0} min={-60} max={60} onChange={v => updateCard("textOffsetY", v)} />
            {/* 对齐方式 */}
            <div className="flex items-start gap-4 py-2">
              <span className="text-[12px] text-[var(--foreground)] opacity-70 w-[90px] shrink-0 pt-1">对齐方式</span>
              <div className="flex-1 grid grid-cols-3 gap-2 min-w-0">
                {([
                  { value: "left", label: "左对齐" },
                  { value: "center", label: "居中" },
                  { value: "stretch", label: "拉伸" },
                ] as { value: string; label: string }[]).map(item => {
                  const isActive = layout.card.alignment === item.value;
                  return (
                    <button
                      key={item.value}
                      onClick={() => updateCard("alignment", item.value)}
                      className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-all border
                        ${isActive
                          ? "bg-[var(--primary)] text-white border-[var(--primary)] shadow-sm"
                          : "bg-[var(--muted)] text-[var(--muted-foreground)] border-transparent hover:bg-[var(--accent)] hover:border-[var(--primary)]/30"
                        }`}
                    >
                      <div className="flex flex-col gap-[2px] w-full">
                        {[100, 80, 60].map((w, li) => (
                          <div
                            key={li}
                            className={`h-[3px] rounded-full ${isActive ? "bg-white/80" : "bg-current opacity-30"}`}
                            style={{
                              width: `${w}%`,
                              marginLeft: item.value === "center" ? "auto" : "0",
                              marginRight: item.value === "center" ? "auto" : "0",
                            }}
                          />
                        ))}
                      </div>
                      <span className="text-[10px] font-medium">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </Section>

          {/* ⑤ 导航栏 */}
          <Section title="导航栏" icon={<Navigation className="w-4 h-4 text-[var(--primary)]" />} defaultOpen={false}>
            <Slider label="标题字号" value={layout.nav.fontSize} min={13} max={32} onChange={v => updateNav("fontSize", v)} />
            <Slider label="描述字号" value={layout.nav.descFontSize} min={10} max={20} onChange={v => updateNav("descFontSize", v)} />
            <Slider label="图标大小" value={layout.nav.iconSize} min={16} max={64} onChange={v => updateNav("iconSize", v)} />
            <Slider label="按钮宽度" value={layout.nav.buttonPaddingX} min={4} max={60} onChange={v => updateNav("buttonPaddingX", v)} />
            <Slider label="按钮高度" value={layout.nav.buttonPaddingY} min={2} max={40} onChange={v => updateNav("buttonPaddingY", v)} />
            <Slider label="按钮间距" value={layout.nav.buttonGap} min={2} max={40} onChange={v => updateNav("buttonGap", v)} />
            <Slider label="按钮圆角" value={layout.nav.buttonBorderRadius} min={0} max={60} onChange={v => updateNav("buttonBorderRadius", v)} />
          </Section>

          {/* ⑥ 分类栏 */}
          <Section title="分类栏" icon={<Tag className="w-4 h-4 text-[var(--primary)]" />} defaultOpen={false}>
            <Slider label="标签字号" value={layout.category.fontSize} min={12} max={24} onChange={v => updateCategory("fontSize", v)} />
            <Slider label="标签宽度" value={layout.category.tagPaddingX} min={8} max={60} onChange={v => updateCategory("tagPaddingX", v)} />
            <Slider label="标签高度" value={layout.category.tagPaddingY} min={2} max={32} onChange={v => updateCategory("tagPaddingY", v)} />
            <Slider label="标签间距" value={layout.category.tagGap} min={2} max={40} onChange={v => updateCategory("tagGap", v)} />
            <Slider label="标签圆角" value={layout.category.tagBorderRadius} min={0} max={48} onChange={v => updateCategory("tagBorderRadius", v)} />
          </Section>
        </div>

        {/* 底部操作栏 — 手动保存 */}
        <div className="px-4 py-3 border-t border-[var(--border)] space-y-2">
          {/* 状态行 */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[12px]">
              {saving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 text-[var(--primary)] animate-spin" />
                  <span className="text-[var(--primary)]">保存中...</span>
                </>
              ) : isDirty ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
                  <span className="text-orange-500 font-medium">未保存</span>
                </>
              ) : lastSaved ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-[var(--muted-foreground)]">
                    已保存 {lastSaved.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </>
              ) : (
                <span className="text-[var(--muted-foreground)]">点击保存生效</span>
              )}
            </div>
          </div>

          {/* 操作按钮行 */}
          <div className="flex items-center gap-2">
            {/* 保存按钮 — 核心操作 */}
            <button
              onClick={handleSave}
              disabled={!isDirty || saving}
              className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl
                bg-[var(--primary)] text-white text-[13px] font-semibold
                hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed
                shadow-sm"
            >
              <Save className="w-3.5 h-3.5" />
              保存
            </button>

            {/* 撤销按钮 */}
            <button
              onClick={undo}
              disabled={!canUndo}
              className="flex items-center justify-center gap-1 px-3 py-2 rounded-xl
                border border-[var(--border)] text-[var(--muted-foreground)] text-[12px]
                hover:bg-[var(--accent)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="撤销上一步 (Ctrl+Z)"
            >
              <Undo2 className="w-3.5 h-3.5" />
              撤销
            </button>

            {/* 恢复默认按钮 */}
            <button
              onClick={() => setShowResetConfirm(true)}
              className="flex items-center justify-center gap-1 px-3 py-2 rounded-xl
                border border-[var(--border)] text-[var(--muted-foreground)] text-[12px]
                hover:bg-[var(--accent)] transition-colors"
              title="恢复默认布局"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              默认
            </button>
          </div>

          <p className="text-[10px] text-[var(--muted-foreground)] text-center">
            Ctrl+Z 撤销 · Ctrl+Y 重做 · Ctrl+S 保存 · 不保存刷新后修改丢失
          </p>
        </div>
      </div>
      )}

      {/* 重置确认弹窗 */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-2xl p-6 w-[360px] shadow-2xl">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-orange-500" />
              <span className="text-[15px] font-bold text-[var(--foreground)]">恢复默认布局</span>
            </div>
            <p className="text-[13px] text-[var(--muted-foreground)] mb-4">
              将重置所有布局调整为出厂默认值并保存，此操作不可撤销。确定继续？
            </p>
            <div className="flex gap-2">
              <button onClick={() => setShowResetConfirm(false)}
                className="flex-1 px-4 py-2 rounded-xl border border-[var(--border)] text-[var(--foreground)] text-[13px] hover:bg-[var(--accent)] transition-colors">
                取消
              </button>
              <button onClick={handleReset}
                className="flex-1 px-4 py-2 rounded-xl bg-orange-500 text-white text-[13px] font-semibold hover:opacity-90 transition-opacity">
                确认重置
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
