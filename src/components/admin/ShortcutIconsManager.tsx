"use client";

import { useState, useCallback, useEffect } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2, GripVertical, Eye, EyeOff, ArrowUp, ArrowDown, Pencil, Zap } from "lucide-react";
import { safeLocalStorageGet } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage-keys";

// ── 类型 ──
interface ShortcutIcon {
  id: string;
  title: string;
  icon_svg: string;
  icon_color: string;
  link_type: string;
  link_value: string;
  sort_order: number;
  is_active: boolean;
}

// ── 预设图标库（常用 Lucide 风格 SVG 内部内容）──
const PRESET_ICONS: { label: string; svg: string }[] = [
  { label: "网格", svg: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { label: "文档", svg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>' },
  { label: "剪刀", svg: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>' },
  { label: "视频", svg: '<rect x="2" y="3" width="20" height="14" rx="2.5"/><path d="m10 9 5 3-5 3z" fill="currentColor" fillOpacity="0.2"/><path d="M2 21h20"/>' },
  { label: "麦克风", svg: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>' },
  { label: "用户", svg: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>' },
  { label: "机器人", svg: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 2v6"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/><path d="M2 14v2M22 14v2"/>' },
  { label: "火箭", svg: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>' },
  { label: "闪电", svg: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>' },
  { label: "搜索", svg: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' },
  { label: "图片", svg: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L6 21"/>' },
  { label: "消息", svg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  { label: "设置", svg: '<circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 10v6M4.22 4.22l4.24 4.24m7.08 7.08l4.24 4.24M1 12h6m10 0h6M4.22 19.78l4.24-4.24m7.08-7.08l4.24-4.24"/>' },
  { label: "购物车", svg: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>' },
  { label: "日历", svg: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
  { label: "下载", svg: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>' },
  { label: "音乐", svg: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
  { label: "笔", svg: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>' },
  { label: "标签", svg: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>' },
  { label: "心", svg: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>' },
];

// ── 预设颜色 ──
const PRESET_COLORS = [
  "#7C5CFF", "#f59e0b", "#f43f5e", "#6366f1", "#a855f7", "#3b82f6",
  "#10b981", "#06b6d4", "#ec4899", "#8b5cf6", "#ef4444", "#14b8a6",
];

// ── 预览渲染 ──
function IconPreview({ svg, color, size = 16 }: { svg: string; color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

// ── 编辑对话框 ──
function EditDialog({
  open, onClose, onSave, editing,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<ShortcutIcon>) => void;
  editing: ShortcutIcon | null;
}) {
  const [title, setTitle] = useState("");
  const [iconSvg, setIconSvg] = useState("");
  const [iconColor, setIconColor] = useState("#7C5CFF");
  const [linkType, setLinkType] = useState("internal");
  const [linkValue, setLinkValue] = useState("");
  const [iconMode, setIconMode] = useState<"preset" | "custom">("preset");

  useEffect(() => {
    if (editing) {
      setTitle(editing.title);
      setIconSvg(editing.icon_svg);
      setIconColor(editing.icon_color);
      setLinkType(editing.link_type);
      setLinkValue(editing.link_value);
      // 如果图标不在预设里，切换到自定义模式
      const isPreset = PRESET_ICONS.some(p => p.svg === editing.icon_svg);
      setIconMode(isPreset ? "preset" : "custom");
    } else {
      setTitle("");
      setIconSvg(PRESET_ICONS[0].svg);
      setIconColor("#7C5CFF");
      setLinkType("internal");
      setLinkValue("");
      setIconMode("preset");
    }
  }, [editing, open]);

  if (!open) return null;

  const handleSave = () => {
    if (!title.trim()) return;
    if (!iconSvg.trim()) return;
    if (!linkValue.trim()) return;
    onSave({ title, icon_svg: iconSvg, icon_color: iconColor, link_type: linkType, link_value: linkValue });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[480px] max-h-[90vh] overflow-y-auto bg-[var(--card)] border border-[var(--border)] rounded-2xl p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-bold text-[var(--foreground)] mb-4">
          {editing ? "编辑快捷图标" : "添加快捷图标"}
        </h3>

        {/* 标题 */}
        <div className="mb-3">
          <label className="block text-xs text-[var(--secondary-foreground)] mb-1">标题</label>
          <input
            type="text" value={title} onChange={e => setTitle(e.target.value)}
            placeholder="如：文案提取"
            className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
          />
        </div>

        {/* 图标选择 */}
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-1.5">
            <label className="text-xs text-[var(--secondary-foreground)]">图标</label>
            <div className="flex gap-1 ml-auto">
              <button onClick={() => setIconMode("preset")}
                className={`px-2 py-0.5 rounded text-[10px] font-medium ${iconMode === "preset" ? "bg-[var(--primary)] text-white" : "bg-[var(--border)] text-[var(--secondary-foreground)]"}`}>
                预设
              </button>
              <button onClick={() => setIconMode("custom")}
                className={`px-2 py-0.5 rounded text-[10px] font-medium ${iconMode === "custom" ? "bg-[var(--primary)] text-white" : "bg-[var(--border)] text-[var(--secondary-foreground)]"}`}>
                自定义SVG
              </button>
            </div>
          </div>
          {iconMode === "preset" ? (
            <div className="grid grid-cols-5 gap-1.5 max-h-32 overflow-y-auto p-1 border border-[var(--border)] rounded-lg">
              {PRESET_ICONS.map((icon) => (
                <button
                  key={icon.label}
                  onClick={() => setIconSvg(icon.svg)}
                  className={`flex flex-col items-center gap-0.5 p-2 rounded-md transition-all ${iconSvg === icon.svg ? "bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]" : "hover:bg-[var(--accent)]"}`}
                  title={icon.label}
                >
                  <IconPreview svg={icon.svg} color={iconSvg === icon.svg ? iconColor : "var(--secondary-foreground)"} size={18} />
                </button>
              ))}
            </div>
          ) : (
            <textarea
              value={iconSvg} onChange={e => setIconSvg(e.target.value)}
              placeholder='<path d="M12 2L2 22h20L12 2z"/>'
              rows={3}
              className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)] font-mono"
            />
          )}
        </div>

        {/* 颜色 */}
        <div className="mb-3">
          <label className="block text-xs text-[var(--secondary-foreground)] mb-1">图标颜色</label>
          <div className="flex items-center gap-2 flex-wrap">
            {PRESET_COLORS.map(c => (
              <button
                key={c}
                onClick={() => setIconColor(c)}
                className={`w-6 h-6 rounded-full border-2 transition-all ${iconColor === c ? "border-white scale-110 shadow-md" : "border-transparent hover:scale-105"}`}
                style={{ backgroundColor: c }}
              />
            ))}
            <input
              type="color" value={iconColor} onChange={e => setIconColor(e.target.value)}
              className="w-6 h-6 rounded-full cursor-pointer p-0 border border-[var(--border)]"
            />
          </div>
        </div>

        {/* 链接类型 */}
        <div className="mb-3">
          <label className="block text-xs text-[var(--secondary-foreground)] mb-1">链接类型</label>
          <div className="flex gap-2">
            <button onClick={() => setLinkType("internal")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${linkType === "internal" ? "bg-[var(--primary)] text-white" : "bg-[var(--border)] text-[var(--secondary-foreground)]"}`}>
              内部页面
            </button>
            <button onClick={() => setLinkType("external")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${linkType === "external" ? "bg-[var(--primary)] text-white" : "bg-[var(--border)] text-[var(--secondary-foreground)]"}`}>
              外部链接
            </button>
            <button onClick={() => setLinkType("action")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${linkType === "action" ? "bg-[var(--primary)] text-white" : "bg-[var(--border)] text-[var(--secondary-foreground)]"}`}>
              站内动作
            </button>
          </div>
        </div>

        {/* 链接值 */}
        <div className="mb-4">
          <label className="block text-xs text-[var(--secondary-foreground)] mb-1">
            {linkType === "internal" ? "页面路径（如 /extract）" : linkType === "external" ? "完整URL（如 https://...）" : "动作名称（如 marketplace）"}
          </label>
          <input
            type="text" value={linkValue} onChange={e => setLinkValue(e.target.value)}
            placeholder={linkType === "internal" ? "/extract" : linkType === "external" ? "https://example.com" : "marketplace"}
            className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] font-mono"
          />
        </div>

        {/* 预览 */}
        <div className="mb-4 p-3 rounded-lg border border-[var(--border)] bg-[var(--background)]">
          <p className="text-[10px] text-[var(--muted-foreground)] mb-2">预览效果</p>
          <div className="flex flex-col items-center justify-center gap-1 p-2 rounded-xl border" style={{ borderColor: `${iconColor}22`, backgroundColor: `${iconColor}08` }}>
            <span className="flex items-center justify-center w-7 h-7 rounded-lg" style={{ backgroundColor: `${iconColor}12` }}>
              <IconPreview svg={iconSvg} color={iconColor} size={16} />
            </span>
            <span className="text-[10px] font-semibold text-[var(--foreground)]">{title || "标题"}</span>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-[var(--secondary-foreground)] rounded-lg hover:bg-[var(--border)] transition-colors">
            取消
          </button>
          <button onClick={handleSave} className="px-4 py-1.5 text-sm font-bold text-white rounded-lg bg-[var(--primary)] hover:opacity-90 transition-opacity">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 主组件 ──
export function ShortcutIconsManager() {
  const [shortcuts, setShortcuts] = useState<ShortcutIcon[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ShortcutIcon | null>(null);
  const [sectionOpen, setSectionOpen] = useState(false);

  // 获取 admin token
  const getAuthHeaders = (): Record<string, string> => {
    const token = safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN);
    return token ? { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
  };

  // 加载快捷图标列表
  const loadShortcuts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/shortcuts", { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.shortcuts) setShortcuts(data.shortcuts);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadShortcuts(); }, [loadShortcuts]);

  // 添加 / 编辑保存
  const handleSave = async (data: Partial<ShortcutIcon>) => {
    const headers = getAuthHeaders();
    if (editingItem) {
      // 编辑
      await fetch("/api/admin/shortcuts", {
        method: "PUT",
        headers,
        body: JSON.stringify({ id: editingItem.id, ...data }),
      });
    } else {
      // 添加
      await fetch("/api/admin/shortcuts", {
        method: "POST",
        headers,
        body: JSON.stringify(data),
      });
    }
    setEditingItem(null);
    loadShortcuts();
  };

  // 删除
  const handleDelete = async (id: string) => {
    if (!confirm("确定删除这个快捷图标？")) return;
    await fetch(`/api/admin/shortcuts?id=${id}`, { method: "DELETE", headers: getAuthHeaders() });
    loadShortcuts();
  };

  // 切换启用/禁用
  const toggleActive = async (item: ShortcutIcon) => {
    await fetch("/api/admin/shortcuts", {
      method: "PUT",
      headers: getAuthHeaders(),
      body: JSON.stringify({ id: item.id, is_active: !item.is_active }),
    });
    loadShortcuts();
  };

  // 上移 / 下移
  const moveItem = async (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= shortcuts.length) return;
    const current = shortcuts[index];
    const target = shortcuts[targetIndex];
    // 交换 sort_order
    const headers = getAuthHeaders();
    await Promise.all([
      fetch("/api/admin/shortcuts", { method: "PUT", headers, body: JSON.stringify({ id: current.id, sort_order: target.sort_order }) }),
      fetch("/api/admin/shortcuts", { method: "PUT", headers, body: JSON.stringify({ id: target.id, sort_order: current.sort_order }) }),
    ]);
    loadShortcuts();
  };

  return (
    <div className="mt-4 border border-[var(--border)] rounded-lg overflow-hidden">
      {/* 折叠头部 */}
      <button
        onClick={() => setSectionOpen(!sectionOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--muted)] hover:bg-[var(--accent)] transition-colors"
      >
        <Zap className="w-4 h-4 text-[var(--primary)]" />
        <span className="text-[13px] font-semibold text-[var(--foreground)] flex-1 text-left">快捷图标管理</span>
        <span className="text-[10px] text-[var(--muted-foreground)]">{shortcuts.filter(s => s.is_active).length} 个启用 / {shortcuts.length} 个总计</span>
        {sectionOpen ? <ChevronDown className="w-4 h-4 text-[var(--muted-foreground)]" /> : <ChevronRight className="w-4 h-4 text-[var(--muted-foreground)]" />}
      </button>

      {sectionOpen && (
        <div className="px-3 py-3 space-y-3">
          <p className="text-[10px] text-[var(--muted-foreground)]">
            管理侧边栏左上角的快捷导航图标，支持添加、编辑、删除、排序和启用/禁用。修改后前台侧边栏自动更新。
          </p>

          {/* 快捷图标列表 */}
          {loading ? (
            <div className="text-center py-4 text-xs text-[var(--muted-foreground)]">加载中...</div>
          ) : shortcuts.length === 0 ? (
            <div className="text-center py-4 text-xs text-[var(--muted-foreground)]">暂无快捷图标，点击下方按钮添加</div>
          ) : (
            <div className="space-y-1.5">
              {shortcuts.map((item, index) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-2 p-2 rounded-lg border transition-all ${item.is_active ? "border-[var(--border)] bg-[var(--card)]" : "border-[var(--border)] bg-[var(--muted)] opacity-50"}`}
                >
                  {/* 拖拽手柄 */}
                  <GripVertical className="w-3.5 h-3.5 text-[var(--muted-foreground)] shrink-0" />

                  {/* 图标预览 */}
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0" style={{ backgroundColor: `${item.icon_color}12` }}>
                    <IconPreview svg={item.icon_svg} color={item.icon_color} size={16} />
                  </div>

                  {/* 标题 + 链接 */}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-[var(--foreground)] truncate">{item.title}</div>
                    <div className="text-[10px] text-[var(--muted-foreground)] truncate font-mono">
                      {item.link_type === "action" ? "[动作] " : item.link_type === "external" ? "[外链] " : ""}
                      {item.link_value}
                    </div>
                  </div>

                  {/* 排序按钮 */}
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => moveItem(index, "up")}
                      disabled={index === 0}
                      className="p-0.5 rounded hover:bg-[var(--accent)] disabled:opacity-30 transition-colors"
                    >
                      <ArrowUp className="w-3 h-3 text-[var(--secondary-foreground)]" />
                    </button>
                    <button
                      onClick={() => moveItem(index, "down")}
                      disabled={index === shortcuts.length - 1}
                      className="p-0.5 rounded hover:bg-[var(--accent)] disabled:opacity-30 transition-colors"
                    >
                      <ArrowDown className="w-3 h-3 text-[var(--secondary-foreground)]" />
                    </button>
                  </div>

                  {/* 操作按钮 */}
                  <button
                    onClick={() => toggleActive(item)}
                    className="p-1 rounded hover:bg-[var(--accent)] transition-colors"
                    title={item.is_active ? "点击禁用" : "点击启用"}
                  >
                    {item.is_active ? <Eye className="w-3.5 h-3.5 text-green-500" /> : <EyeOff className="w-3.5 h-3.5 text-[var(--muted-foreground)]" />}
                  </button>
                  <button
                    onClick={() => { setEditingItem(item); setDialogOpen(true); }}
                    className="p-1 rounded hover:bg-[var(--accent)] transition-colors"
                    title="编辑"
                  >
                    <Pencil className="w-3.5 h-3.5 text-[var(--secondary-foreground)]" />
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="p-1 rounded hover:bg-red-500/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-500" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 添加按钮 */}
          <button
            onClick={() => { setEditingItem(null); setDialogOpen(true); }}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-[var(--border)] text-xs font-medium text-[var(--secondary-foreground)] hover:border-[var(--primary)] hover:text-[var(--primary)] transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            添加快捷图标
          </button>
        </div>
      )}

      {/* 编辑/添加对话框 */}
      <EditDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingItem(null); }}
        onSave={handleSave}
        editing={editingItem}
      />
    </div>
  );
}
