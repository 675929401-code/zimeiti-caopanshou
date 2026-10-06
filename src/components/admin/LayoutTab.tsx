"use client";

import { useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Grid3X3, Navigation, Tag, Type, Image } from "lucide-react";
import type { PageLayoutConfig, CardLayoutConfig, NavLayoutConfig, CategoryLayoutConfig } from "@/types/coze";
import { DEFAULT_PAGE_LAYOUT, DEFAULT_CARD_LAYOUT, DEFAULT_NAV_LAYOUT, DEFAULT_CATEGORY_LAYOUT } from "@/types/coze";
import { ShortcutIconsManager } from "@/components/admin/ShortcutIconsManager";

// ── 辅助：深度合并默认值 ──
function mergeDefaults(saved: Partial<PageLayoutConfig>): PageLayoutConfig {
  return {
    card: { ...DEFAULT_CARD_LAYOUT, ...(saved.card || {}) },
    nav: { ...DEFAULT_NAV_LAYOUT, ...(saved.nav || {}) },
    category: { ...DEFAULT_CATEGORY_LAYOUT, ...(saved.category || {}) },
    categoryOverrides: saved.categoryOverrides || undefined,
  };
}

// ── 折叠面板 ──
function Section({
  title, icon, children, defaultOpen = true
}: { title: string; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
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

// ── 滑块+数值双输入控件 ──
function SliderNum({
  label, value, min, max, step = 1, unit = "px", onChange
}: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5">
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
      <input
        type="number" min={min} max={max} step={step}
        value={value} onChange={e => {
          const v = Number(e.target.value);
          if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
        className="w-[68px] h-7 rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-xs text-center px-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--primary)] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-[10px] text-[var(--muted-foreground)] w-5 shrink-0">{unit}</span>
    </div>
  );
}

// ── 颜色选择控件 ──
function ColorPick({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-[12px] text-[var(--foreground)] opacity-70 w-[90px] shrink-0 truncate" title={label}>{label}</span>
      <input type="color" value={value || "#000000"} onChange={e => onChange(e.target.value)}
        className="w-8 h-7 rounded-md border border-[var(--border)] cursor-pointer p-0.5" />
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        className="flex-1 h-7 rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-xs px-2 focus:outline-none focus:ring-1 focus:ring-[var(--primary)] font-mono" />
    </div>
  );
}

// ── 下拉选择控件 ──
function SelectField({ label, value, options, onChange }: {
  label: string; value: string | number; options: { value: string | number; label: string }[]; onChange: (v: string | number) => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-[12px] text-[var(--foreground)] opacity-70 w-[90px] shrink-0 truncate" title={label}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="flex-1 h-7 rounded-md border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-xs px-2 focus:outline-none focus:ring-1 focus:ring-[var(--primary)]">
        {options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </div>
  );
}

// ── Props ──
interface LayoutTabProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSettings: (s: any | ((prev: Record<string, any>) => Record<string, any>)) => void;
  saveSettings: () => void;
  settingsSaving: boolean;
  categories?: { id: string; name: string; icon?: string }[];
}

export default function LayoutTab({ settings, setSettings, saveSettings, settingsSaving, categories = [] }: LayoutTabProps) {
  const [editMode, setEditMode] = useState<"global" | string>("global");

  // ── 解析 page_layout → PageLayoutConfig ──
  // page_layout 由父页面通过 brand scope + Authorization + step-up 读取，
  // 这里不再绕过权限单独请求旧 layout 接口。
  const parseLayout = useCallback((): PageLayoutConfig => {
    try {
      if (settings.page_layout) {
        const parsed = typeof settings.page_layout === "string" ? JSON.parse(settings.page_layout) : settings.page_layout;
        return mergeDefaults(parsed);
      }
      if (settings.card_layout) {
        const parsed = typeof settings.card_layout === "string" ? JSON.parse(settings.card_layout) : settings.card_layout;
        return { ...DEFAULT_PAGE_LAYOUT, card: { ...DEFAULT_CARD_LAYOUT, ...(parsed.card || parsed) } };
      }
    } catch { /* ignore */ }
    return DEFAULT_PAGE_LAYOUT;
  }, [settings.page_layout, settings.card_layout]);

  const pl = parseLayout();

  // ── 获取当前分类的覆盖配置 ──
  const getActiveOverrides = (): Partial<CardLayoutConfig> => {
    if (editMode !== "global" && pl.categoryOverrides?.[editMode]) {
      return pl.categoryOverrides[editMode];
    }
    return {};
  };

  // ── 更新配置并同步到 settings ──
  const updateLayout = useCallback((newPl: PageLayoutConfig) => {
    setSettings({ ...settings, page_layout: JSON.stringify(newPl) });
  }, [settings, setSettings]);

  // ── 更新 card ──
  const updateCard = (key: keyof CardLayoutConfig, value: number | string | boolean) => {
    if (editMode !== "global") {
      // 分类独立覆盖
      const existing = pl.categoryOverrides?.[editMode] || {};
      if (DEFAULT_CARD_LAYOUT[key] === value) {
        // 与默认值一致，从覆盖中移除
        const { [key]: _, ...rest } = existing;
        const newOverrides = { ...(pl.categoryOverrides || {}), [editMode]: rest };
        if (Object.keys(rest).length === 0) delete newOverrides[editMode];
        updateLayout({ ...pl, categoryOverrides: Object.keys(newOverrides).length > 0 ? newOverrides : undefined });
        return;
      }
      const newOverrides = { ...(pl.categoryOverrides || {}), [editMode]: { ...existing, [key]: value } };
      updateLayout({ ...pl, categoryOverrides: newOverrides });
    } else {
      updateLayout({ ...pl, card: { ...pl.card, [key]: value } });
    }
  };

  // ── 更新 nav ──
  const updateNav = (key: keyof NavLayoutConfig, value: number) => {
    updateLayout({ ...pl, nav: { ...pl.nav, [key]: value } });
  };

  // ── 更新 category ──
  const updateCategory = (key: keyof CategoryLayoutConfig, value: number) => {
    updateLayout({ ...pl, category: { ...pl.category, [key]: value } });
  };

  // ── 是否有独立配置 ──
  const hasOverride = (catId: string) => !!pl.categoryOverrides?.[catId] && Object.keys(pl.categoryOverrides[catId]).length > 0;

  // ── 恢复默认 ──
  const resetLayout = () => {
    if (editMode !== "global") {
      const overrides = { ...(pl.categoryOverrides || {}) };
      delete overrides[editMode];
      updateLayout({ ...pl, categoryOverrides: Object.keys(overrides).length > 0 ? overrides : undefined });
    } else {
      updateLayout(DEFAULT_PAGE_LAYOUT);
    }
  };

  return (
    <div>
      <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">布局编辑器</h2>

      {/* ── 分类筛选栏 ── */}
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <button
            onClick={() => setEditMode("global")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              editMode === "global"
                ? "bg-[var(--primary)] text-white shadow-sm"
                : "bg-[var(--card)] border border-[var(--border)] text-[var(--secondary-foreground)] hover:bg-[var(--accent)]"
            }`}
          >
            全局配置
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setEditMode(cat.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                editMode === cat.id
                  ? "bg-[var(--primary)] text-white shadow-sm"
                  : hasOverride(cat.id)
                    ? "bg-amber-500/10 border border-amber-500/30 text-amber-600"
                    : "bg-[var(--card)] border border-[var(--border)] text-[var(--secondary-foreground)] hover:bg-[var(--accent)]"
              }`}
            >
              {cat.icon || "📁"} {cat.name}
              {hasOverride(cat.id) && <span className="ml-1 text-[10px] opacity-70">✦</span>}
            </button>
          ))}
        </div>
      )}

      {/* ── 编辑区域 ── */}
      <div className="p-4 rounded-lg border border-[var(--border)] bg-[var(--card)]">
        <h3 className="text-sm font-semibold text-[var(--foreground)] mb-3 flex items-center gap-2">
          📐 {editMode === "global" ? "全局配置" : `「${categories.find(c => c.id === editMode)?.name || editMode}」独立配置`}
          {editMode !== "global" && (
            <span className="text-[10px] font-normal text-[var(--muted-foreground)]">
              {hasOverride(editMode) ? "已有独立设置" : "继承全局配置"}
            </span>
          )}
        </h3>

        <div className="space-y-3">
          {/* ═══ ① 卡片尺寸 ═══ */}
          <Section title="卡片尺寸" icon={<Grid3X3 className="w-4 h-4 text-[var(--primary)]" />}>
            {editMode === "global" && (
              <SliderNum label="每行列数" value={pl.card.columns} min={1} max={8} unit="列" onChange={v => updateCard("columns", v)} />
            )}
            <SliderNum label="卡片最小宽度" value={pl.card.cardMinWidth ?? 0} min={0} max={600} step={10} unit="px" onChange={v => updateCard("cardMinWidth", v)} />
            <span className="block text-[10px] text-[var(--muted-foreground)] -mt-1 ml-[98px]">0=自动均分, 设值后精确控制每张卡片宽度</span>
            <SliderNum label="卡片高度" value={pl.card.cardHeight} min={0} max={500} step={5} unit="px" onChange={v => updateCard("cardHeight", v)} />
            <span className="block text-[10px] text-[var(--muted-foreground)] -mt-1 ml-[98px]">0=自适应内容高度</span>
            <SliderNum label="水平间距" value={pl.card.gapX} min={0} max={200} unit="px" onChange={v => updateCard("gapX", v)} />
            <SliderNum label="垂直间距" value={pl.card.gapY} min={0} max={200} unit="px" onChange={v => updateCard("gapY", v)} />
            <SliderNum label="卡片圆角" value={pl.card.borderRadius} min={0} max={96} unit="px" onChange={v => updateCard("borderRadius", v)} />
            <SliderNum label="内边距-左右" value={pl.card.paddingX} min={0} max={80} unit="px" onChange={v => updateCard("paddingX", v)} />
            <SliderNum label="内边距-上下" value={pl.card.paddingY} min={0} max={80} unit="px" onChange={v => updateCard("paddingY", v)} />
            <SliderNum label="透明度" value={pl.card.opacity ?? 100} min={10} max={100} step={1} unit="%" onChange={v => updateCard("opacity", v)} />
            <ColorPick label="卡片背景色" value={pl.card.cardBg || ""} onChange={v => updateCard("cardBg", v)} />
            {editMode === "global" && (
              <div className="flex items-center gap-2 py-1.5">
                <span className="text-[12px] text-[var(--foreground)] opacity-70 w-[90px] shrink-0">显示阴影</span>
                <input type="checkbox" checked={pl.card.showShadow} onChange={e => updateCard("showShadow", e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary)]" />
              </div>
            )}
          </Section>

          {/* ═══ ② 头像设置 ═══ */}
          <Section title="头像设置" icon={<Image className="w-4 h-4 text-[var(--primary)]" />} defaultOpen={false}>
            <SliderNum label="头像宽度" value={pl.card.avatarWidth || pl.card.avatarSize} min={16} max={260} unit="px" onChange={v => updateCard("avatarWidth", v)} />
            <SliderNum label="头像高度" value={pl.card.avatarHeight || pl.card.avatarSize} min={16} max={260} unit="px" onChange={v => updateCard("avatarHeight", v)} />
            <SliderNum label="头像圆角" value={pl.card.avatarRadius} min={0} max={80} unit="px" onChange={v => updateCard("avatarRadius", v)} />
            <SelectField label="头像位置" value={pl.card.avatarPosition} onChange={v => updateCard("avatarPosition", v as CardLayoutConfig["avatarPosition"])}
              options={[
                { value: "left", label: "左侧" }, { value: "right", label: "右侧" },
                { value: "top", label: "顶部" }, { value: "top-center", label: "顶部居中" },
                { value: "top-left", label: "左上角" }, { value: "top-right", label: "右上角" },
                { value: "bottom-left", label: "左下角" }, { value: "bottom-right", label: "右下角" },
              ]} />
          </Section>

          {/* ═══ ③ 标题样式 ═══ */}
          <Section title="标题样式" icon={<Type className="w-4 h-4 text-[var(--primary)]" />} defaultOpen={false}>
            <SliderNum label="标题字号" value={pl.card.titleFontSize} min={10} max={64} unit="px" onChange={v => updateCard("titleFontSize", v)} />
            <SliderNum label="标题粗细" value={pl.card.titleFontWeight} min={100} max={900} step={100} unit="" onChange={v => updateCard("titleFontWeight", v)} />
            <SliderNum label="标题字距" value={pl.card.titleLetterSpacing ?? 0} min={-5} max={8} step={0.1} unit="px" onChange={v => updateCard("titleLetterSpacing", v)} />
            <SliderNum label="标题水平偏移" value={pl.card.titleOffsetX ?? 0} min={-60} max={60} unit="px" onChange={v => updateCard("titleOffsetX", v)} />
            <SliderNum label="标题垂直偏移" value={pl.card.titleOffsetY ?? 0} min={-60} max={60} unit="px" onChange={v => updateCard("titleOffsetY", v)} />
            <ColorPick label="标题颜色" value={pl.card.titleColor || ""} onChange={v => updateCard("titleColor", v)} />
          </Section>

          {/* ═══ ④ 描述样式 ═══ */}
          <Section title="描述样式" icon={<Type className="w-4 h-4 text-[var(--primary)]" />} defaultOpen={false}>
            <SliderNum label="描述字号" value={pl.card.descFontSize} min={8} max={48} unit="px" onChange={v => updateCard("descFontSize", v)} />
            <SliderNum label="描述粗细" value={pl.card.descFontWeight} min={100} max={900} step={100} unit="" onChange={v => updateCard("descFontWeight", v)} />
            <SliderNum label="描述字距" value={pl.card.descLetterSpacing ?? 0} min={-1} max={8} step={0.5} unit="px" onChange={v => updateCard("descLetterSpacing", v)} />
            <SliderNum label="描述行高" value={pl.card.descLineHeight ?? 1.5} min={1} max={3} step={0.1} unit="倍" onChange={v => updateCard("descLineHeight", v)} />
            <SliderNum label="描述最大行数" value={pl.card.descMaxLines} min={0} max={8} unit={pl.card.descMaxLines === 0 ? "不限" : "行"} onChange={v => updateCard("descMaxLines", v)} />
            <SliderNum label="文字水平偏移" value={pl.card.textOffsetX ?? 0} min={-60} max={60} unit="px" onChange={v => updateCard("textOffsetX", v)} />
            <SliderNum label="文字垂直偏移" value={pl.card.textOffsetY ?? 0} min={-60} max={60} unit="px" onChange={v => updateCard("textOffsetY", v)} />
            <ColorPick label="描述颜色" value={pl.card.descColor || ""} onChange={v => updateCard("descColor", v)} />
          </Section>

          {/* ═══ ⑤ 导航栏 ═══ */}
          <Section title="导航栏" icon={<Navigation className="w-4 h-4 text-[var(--primary)]" />} defaultOpen={true}>
            <p className="text-[10px] text-[var(--muted-foreground)] mb-1 ml-[98px]">控制顶部一级导航按钮的样式</p>
            <SliderNum label="导航字号" value={pl.nav.fontSize} min={10} max={32} unit="px" onChange={v => updateNav("fontSize", v)} />
            <SliderNum label="描述/副标题字号" value={pl.nav.descFontSize} min={8} max={20} unit="px" onChange={v => updateNav("descFontSize", v)} />
            <SliderNum label="图标大小" value={pl.nav.iconSize} min={12} max={48} unit="px" onChange={v => updateNav("iconSize", v)} />
            <SliderNum label="按钮水平内距" value={pl.nav.buttonPaddingX} min={2} max={60} unit="px" onChange={v => updateNav("buttonPaddingX", v)} />
            <SliderNum label="按钮垂直内距" value={pl.nav.buttonPaddingY} min={0} max={40} unit="px" onChange={v => updateNav("buttonPaddingY", v)} />
            <span className="block text-[10px] text-[var(--muted-foreground)] -mt-1 ml-[98px]">控制导航栏高度, 0=最紧凑模式</span>
            <SliderNum label="按钮间距" value={pl.nav.buttonGap} min={0} max={40} unit="px" onChange={v => updateNav("buttonGap", v)} />
            <SliderNum label="按钮圆角" value={pl.nav.buttonBorderRadius} min={0} max={48} unit="px" onChange={v => updateNav("buttonBorderRadius", v)} />
          </Section>

          {/* ═══ ⑥ 分类栏 ═══ */}
          <Section title="分类栏" icon={<Tag className="w-4 h-4 text-[var(--primary)]" />} defaultOpen={true}>
            <p className="text-[10px] text-[var(--muted-foreground)] mb-1 ml-[98px]">控制品类标签（智能体/视频生成/文案撰写等）样式</p>
            <SliderNum label="标签字号" value={pl.category.fontSize} min={10} max={28} unit="px" onChange={v => updateCategory("fontSize", v)} />
            <SliderNum label="标签水平内距" value={pl.category.tagPaddingX} min={4} max={60} unit="px" onChange={v => updateCategory("tagPaddingX", v)} />
            <SliderNum label="标签垂直内距" value={pl.category.tagPaddingY} min={0} max={32} unit="px" onChange={v => updateCategory("tagPaddingY", v)} />
            <span className="block text-[10px] text-[var(--muted-foreground)] -mt-1 ml-[98px]">控制分类栏高度, 0=最紧凑模式</span>
            <SliderNum label="标签间距" value={pl.category.tagGap} min={0} max={40} unit="px" onChange={v => updateCategory("tagGap", v)} />
            <SliderNum label="标签圆角" value={pl.category.tagBorderRadius} min={0} max={48} unit="px" onChange={v => updateCategory("tagBorderRadius", v)} />
          </Section>
        </div>

        <div className="flex items-center gap-3 pt-3 mt-3 border-t border-[var(--border)]">
          <button onClick={saveSettings} disabled={settingsSaving} className="px-4 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-bold text-xs hover:opacity-90 transition disabled:opacity-50">
            {settingsSaving ? "保存中..." : "保存"}
          </button>
          <button onClick={resetLayout} className="px-4 py-1.5 text-[var(--secondary-foreground)] rounded-xl text-sm hover:bg-[var(--border)] transition-colors">恢复默认</button>
          {editMode !== "global" && <span className="text-[10px] text-amber-500 ml-auto">仅影响「{categories.find(c => c.id === editMode)?.name || editMode}」分类</span>}
        </div>
      </div>

      {/* ── 快捷图标管理 ── */}
      <ShortcutIconsManager />
    </div>
  );
}
