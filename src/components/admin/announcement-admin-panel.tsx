"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Copy,
  Eye,
  Megaphone,
  Pencil,
  Plus,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import type {
  AnnouncementAudience,
  AnnouncementPriority,
  AnnouncementRecord,
  AnnouncementStatus,
} from "@/lib/announcement-domain";

interface AnnouncementForm {
  id?: string;
  title: string;
  summary: string;
  content: string;
  priority: AnnouncementPriority;
  status: AnnouncementStatus;
  image_url: string;
  link_url: string;
  link_text: string;
  is_pinned: boolean;
  publish_at: string;
  expires_at: string;
  target_audience: AnnouncementAudience;
  target_user_ids: string;
  frequency_hours: number;
  max_impressions: number;
  require_ack: boolean;
}

interface AnnouncementDeliveryStatus {
  availability: "ready" | "unavailable";
  error: string | null;
  revision: number;
  pushedAt: string | null;
  targetCount: number;
  readCount: number;
  unreadCount: number;
  readRate: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function recordValue(record: Record<string, unknown> | null, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record && record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function normalizeDeliveryStatus(payload: unknown, announcement: AnnouncementRecord): AnnouncementDeliveryStatus {
  const root = isRecord(payload) ? payload : {};
  const summary = isRecord(root.summary) ? root.summary : {};
  const pushRun = isRecord(root.pushRun) ? root.pushRun : {};
  const item = announcement as unknown as Record<string, unknown>;
  const revision = finiteNumber(
    recordValue(root, "revision", "pushRevision", "push_revision"),
    recordValue(pushRun, "revision", "pushRevision", "push_revision"),
    recordValue(item, "push_revision", "pushRevision", "revision"),
    0,
  ) || 0;
  const targetCount = finiteNumber(recordValue(summary, "targetCount", "target_count"), 0) || 0;
  const readCount = finiteNumber(recordValue(summary, "readCount", "read_count"), 0) || 0;
  const unreadCount = finiteNumber(
    recordValue(summary, "unreadCount", "unread_count"),
    Math.max(0, targetCount - readCount),
  ) || 0;
  const rawReadRate = finiteNumber(recordValue(summary, "readRate", "read_rate"), targetCount > 0 ? readCount / targetCount : 0) || 0;
  const pushedAtValue = recordValue(pushRun, "pushedAt", "pushed_at")
    ?? recordValue(root, "pushedAt", "pushed_at")
    ?? recordValue(item, "last_pushed_at", "lastPushedAt");

  return {
    availability: "ready",
    error: null,
    revision: Math.max(0, Math.trunc(revision)),
    pushedAt: typeof pushedAtValue === "string" && pushedAtValue ? pushedAtValue : null,
    targetCount: Math.max(0, Math.trunc(targetCount)),
    readCount: Math.max(0, Math.trunc(readCount)),
    unreadCount: Math.max(0, Math.trunc(unreadCount)),
    readRate: Math.max(0, Math.min(100, rawReadRate <= 1 ? rawReadRate * 100 : rawReadRate)),
  };
}

function unavailableDeliveryStatus(
  announcement: AnnouncementRecord,
  error: string,
): AnnouncementDeliveryStatus {
  return {
    ...normalizeDeliveryStatus(null, announcement),
    availability: "unavailable",
    error,
  };
}

function isDeliveryStatusPayload(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.summary)) return false;
  return finiteNumber(recordValue(payload, "revision", "pushRevision", "push_revision")) !== null
    && finiteNumber(recordValue(payload.summary, "targetCount", "target_count")) !== null
    && finiteNumber(recordValue(payload.summary, "readCount", "read_count")) !== null
    && finiteNumber(recordValue(payload.summary, "unreadCount", "unread_count")) !== null
    && finiteNumber(recordValue(payload.summary, "readRate", "read_rate")) !== null;
}

async function deliveryStatusError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as unknown;
    if (isRecord(payload) && typeof payload.error === "string" && payload.error.trim()) {
      return payload.error.trim();
    }
  } catch {
    // Preserve the status-based message for non-JSON upstream failures.
  }
  return `投递统计读取失败（HTTP ${response.status}）`;
}

const EMPTY_FORM: AnnouncementForm = {
  title: "",
  summary: "",
  content: "",
  priority: "normal",
  status: "draft",
  image_url: "",
  link_url: "",
  link_text: "查看详情",
  is_pinned: false,
  publish_at: "",
  expires_at: "",
  target_audience: "all",
  target_user_ids: "",
  frequency_hours: 24,
  max_impressions: 3,
  require_ack: false,
};

const inputClass = "mt-1.5 h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)] outline-none transition-colors placeholder:text-[var(--muted-foreground)]/60 focus:border-[var(--primary)]";
const textAreaClass = `${inputClass} h-auto min-h-24 resize-y py-2.5 leading-relaxed`;
const labelClass = "block text-xs font-semibold text-[var(--secondary-foreground)]";

function toLocalDateTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromAnnouncement(item: AnnouncementRecord): AnnouncementForm {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary || "",
    content: item.content,
    priority: item.priority,
    status: item.status,
    image_url: item.image_url || "",
    link_url: item.link_url || "",
    link_text: item.link_text || "查看详情",
    is_pinned: item.is_pinned,
    publish_at: toLocalDateTime(item.publish_at),
    expires_at: toLocalDateTime(item.expires_at),
    target_audience: item.target_audience,
    target_user_ids: item.target_user_ids.join("\n"),
    frequency_hours: item.frequency_hours,
    max_impressions: item.max_impressions,
    require_ack: item.require_ack,
  };
}

function statusLabel(status: AnnouncementStatus) {
  return { draft: "草稿", scheduled: "待发布", published: "已发布", withdrawn: "已撤回" }[status];
}

function priorityLabel(priority: AnnouncementPriority) {
  return { normal: "普通", important: "重要", urgent: "紧急" }[priority];
}

export function AnnouncementAdminPanel({ token }: { token: string }) {
  const [items, setItems] = useState<AnnouncementRecord[]>([]);
  const [form, setForm] = useState<AnnouncementForm>(EMPTY_FORM);
  const [editorOpen, setEditorOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [deliveryStatuses, setDeliveryStatuses] = useState<Record<string, AnnouncementDeliveryStatus>>({});
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }), [token]);

  const loadDeliveryStatuses = useCallback(async (announcements: AnnouncementRecord[]) => {
    if (announcements.length === 0) {
      setDeliveryStatuses({});
      setStatusLoading(false);
      return;
    }
    setStatusLoading(true);
    const entries = await Promise.all(announcements.map(async (announcement) => {
      try {
        const response = await fetch(
          `/api/admin/announcements/${encodeURIComponent(announcement.id)}/delivery-status?page=1&pageSize=1`,
          { headers, cache: "no-store" },
        );
        if (!response.ok) {
          return [
            announcement.id,
            unavailableDeliveryStatus(announcement, await deliveryStatusError(response)),
          ] as const;
        }
        const payload = await response.json() as unknown;
        if (!isDeliveryStatusPayload(payload)) {
          return [
            announcement.id,
            unavailableDeliveryStatus(announcement, "投递统计响应格式无效"),
          ] as const;
        }
        return [announcement.id, normalizeDeliveryStatus(payload, announcement)] as const;
      } catch (error) {
        return [
          announcement.id,
          unavailableDeliveryStatus(
            announcement,
            error instanceof Error && error.message ? error.message : "投递统计服务暂时不可用",
          ),
        ] as const;
      }
    }));
    setDeliveryStatuses(Object.fromEntries(entries));
    setStatusLoading(false);
  }, [headers]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/announcements?admin=1", { headers, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "公告加载失败");
      const announcements: AnnouncementRecord[] = data.announcements || [];
      setItems(announcements);
      void loadDeliveryStatuses(announcements);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "公告加载失败" });
    } finally {
      setLoading(false);
    }
  }, [headers, loadDeliveryStatuses]);

  useEffect(() => { void load(); }, [load]);

  const resetEditor = () => {
    setForm(EMPTY_FORM);
    setEditorOpen(false);
    setPreviewOpen(false);
  };

  const payload = () => ({
    ...form,
    target_user_ids: form.target_user_ids.split(/[\n,，\s]+/).map((value) => value.trim()).filter(Boolean),
    publish_at: form.publish_at ? new Date(form.publish_at).toISOString() : null,
    expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
  });

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/announcements", {
        method: form.id ? "PUT" : "POST",
        headers,
        body: JSON.stringify(payload()),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setMessage({ type: "success", text: form.status === "published" ? "公告已发布" : "公告已保存" });
      resetEditor();
      await load();
      window.dispatchEvent(new Event("refresh-announcements"));
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (item: AnnouncementRecord, status: AnnouncementStatus) => {
    try {
      const response = await fetch("/api/announcements", {
        method: "PUT",
        headers,
        body: JSON.stringify({ id: item.id, status }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "状态更新失败");
      setMessage({ type: "success", text: status === "published" ? "公告已发布" : "公告已撤回" });
      await load();
      window.dispatchEvent(new Event("refresh-announcements"));
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "状态更新失败" });
    }
  };

  const publishFirstAnnouncement = async (item: AnnouncementRecord) => {
    const confirmed = window.confirm(
      `确定首次发布并推送“${item.title}”吗？发布范围内的用户会立即收到这条公告。`,
    );
    if (!confirmed) return;
    await changeStatus(item, "published");
  };

  const pushAnnouncement = async (item: AnnouncementRecord) => {
    const deliveryStatus = deliveryStatuses[item.id] || normalizeDeliveryStatus(null, item);
    const isRepush = deliveryStatus.revision > 0;
    const confirmed = window.confirm(
      isRepush
        ? `确定再次强推“${item.title}”吗？推送版本将从 V${deliveryStatus.revision} 升级，已读用户会重新收到。`
        : `确定首次推送“${item.title}”吗？发布范围内的用户将收到此公告。`,
    );
    if (!confirmed) return;

    setPushingId(item.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/announcements/${encodeURIComponent(item.id)}/push`, {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedRevision: deliveryStatus.revision }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "公告推送失败");
      const nextRevision = Number(data.revision) || deliveryStatus.revision + 1;
      setMessage({
        type: "success",
        text: `${isRepush ? "再次强推" : "首次推送"}成功，当前版本 V${nextRevision}`,
      });
      await load();
      window.dispatchEvent(new Event("refresh-announcements"));
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("announcement-inbox-v1");
        channel.postMessage({ type: "refresh" });
        channel.close();
      }
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "公告推送失败" });
    } finally {
      setPushingId(null);
    }
  };

  const remove = async (item: AnnouncementRecord) => {
    if (!window.confirm(`确定永久删除“${item.title}”吗？`)) return;
    try {
      const response = await fetch(`/api/announcements?id=${encodeURIComponent(item.id)}`, { method: "DELETE", headers });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除失败");
      setMessage({ type: "success", text: "公告已删除" });
      await load();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "删除失败" });
    }
  };

  const edit = (item: AnnouncementRecord) => {
    setForm(fromAnnouncement(item));
    setEditorOpen(true);
    setPreviewOpen(false);
  };

  const duplicate = (item: AnnouncementRecord) => {
    setForm({ ...fromAnnouncement(item), id: undefined, title: `${item.title}（副本）`, status: "draft" });
    setEditorOpen(true);
    setPreviewOpen(false);
  };

  return (
    <section aria-labelledby="announcement-admin-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="announcement-admin-title" className="flex items-center gap-2 text-lg font-bold text-[var(--foreground)]">
            <Megaphone className="h-5 w-5 text-[var(--primary)]" />公告管理
          </h2>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">控制发布时机、目标账号与推送版本；送达与已读按账号回执统计。</p>
        </div>
        <button type="button" onClick={() => { setForm(EMPTY_FORM); setEditorOpen(true); }} className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--primary)] px-4 text-sm font-bold text-[var(--primary-foreground)] hover:brightness-110">
          <Plus className="h-4 w-4" />新建公告
        </button>
      </div>

      {message && (
        <div role="status" className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-rose-500/30 bg-rose-500/10 text-rose-400"}`}>
          {message.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          {message.text}
        </div>
      )}

      {editorOpen && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 sm:p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-bold text-[var(--foreground)]">{form.id ? "编辑公告" : "新建公告"}</h3>
              <button type="button" onClick={resetEditor} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-[var(--muted-foreground)] hover:bg-[var(--muted)]"><Undo2 className="h-3.5 w-3.5" />取消</button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2 rounded-lg border border-[var(--border)] bg-[var(--muted)]/45 px-3.5 py-3 text-xs leading-5 text-[var(--secondary-foreground)]">
                所有公告均需点击“已阅读”；关闭仅在本次登录中收起，未读公告会在下次登录继续出现。
              </div>
              <label className={`${labelClass} md:col-span-2`}>标题 *
                <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={inputClass} maxLength={255} placeholder="一句话说明这条公告的重点" />
              </label>
              <label className={`${labelClass} md:col-span-2`}>摘要
                <input value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} className={inputClass} maxLength={300} placeholder="弹窗首屏显示，建议 30 至 60 字" />
              </label>
              <label className={`${labelClass} md:col-span-2`}>正文 *
                <textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} className={`${textAreaClass} min-h-36`} maxLength={20_000} placeholder="说明影响范围、用户需要做什么，以及遇到问题如何处理。" />
              </label>
              <label className={labelClass}>级别
                <select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as AnnouncementPriority })} className={inputClass}>
                  <option value="normal">普通通知</option><option value="important">重要通知</option><option value="urgent">紧急通知</option>
                </select>
              </label>
              <label className={labelClass}>状态
                <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as AnnouncementStatus })} className={inputClass}>
                  <option value="draft">草稿</option><option value="scheduled">定时发布</option><option value="published">立即发布</option><option value="withdrawn">撤回</option>
                </select>
              </label>
              <label className={labelClass}>发布时间
                <input type="datetime-local" value={form.publish_at} onChange={(event) => setForm({ ...form, publish_at: event.target.value })} className={inputClass} />
              </label>
              <label className={labelClass}>有效期至
                <input type="datetime-local" value={form.expires_at} onChange={(event) => setForm({ ...form, expires_at: event.target.value })} className={inputClass} />
              </label>
              <label className={labelClass}>目标用户
                <select value={form.target_audience} onChange={(event) => setForm({ ...form, target_audience: event.target.value as AnnouncementAudience })} className={inputClass}>
                  <option value="all">全部有效账号</option>
                  <option value="authenticated">全部登录账号</option>
                  <option value="admins">仅管理员账号</option>
                  <option value="selected">指定账号</option>
                  {form.target_audience === "guests" && <option value="guests" disabled>历史访客配置（不支持账号已读）</option>}
                </select>
              </label>
              {form.target_audience === "selected" && (
                <label className={`${labelClass} md:col-span-2`}>用户 ID（换行或逗号分隔）
                  <textarea value={form.target_user_ids} onChange={(event) => setForm({ ...form, target_user_ids: event.target.value })} className={textAreaClass} placeholder="user-id-1&#10;user-id-2" />
                </label>
              )}
              <label className={labelClass}>图片地址
                <input value={form.image_url} onChange={(event) => setForm({ ...form, image_url: event.target.value })} className={inputClass} placeholder="https://... 或 /public-path" />
              </label>
              <label className={labelClass}>操作链接
                <input value={form.link_url} onChange={(event) => setForm({ ...form, link_url: event.target.value })} className={inputClass} placeholder="/help 或 https://..." />
              </label>
              <label className={labelClass}>按钮文字
                <input value={form.link_text} onChange={(event) => setForm({ ...form, link_text: event.target.value })} className={inputClass} maxLength={80} placeholder="查看详情" />
              </label>
              <div className="flex flex-wrap items-center gap-5 md:col-span-2">
                <label className="inline-flex items-center gap-2 text-sm text-[var(--secondary-foreground)]"><input type="checkbox" checked={form.is_pinned} onChange={(event) => setForm({ ...form, is_pinned: event.target.checked })} className="h-4 w-4 accent-[var(--primary)]" />置顶</label>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-[var(--border)] pt-4">
              <button type="button" onClick={() => setPreviewOpen((value) => !value)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-xs font-semibold text-[var(--secondary-foreground)] hover:bg-[var(--muted)]"><Eye className="h-4 w-4" />{previewOpen ? "收起预览" : "预览"}</button>
              <button type="button" disabled={saving || !form.title.trim() || !form.content.trim()} onClick={() => void save()} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 text-xs font-bold text-[var(--primary-foreground)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"><Send className="h-4 w-4" />{saving ? "保存中..." : form.status === "published" ? "发布" : "保存"}</button>
            </div>
          </div>

          <aside className={`${previewOpen ? "block" : "hidden xl:block"} rounded-lg border border-[var(--border)] bg-[var(--background)]/50 p-4`} aria-label="公告预览">
            <p className="mb-3 text-xs font-bold text-[var(--muted-foreground)]">用户侧预览</p>
            <div className={`rounded-lg border p-4 ${form.priority === "urgent" ? "border-rose-500/40 bg-rose-500/10" : form.priority === "important" ? "border-amber-500/35 bg-amber-500/10" : "border-sky-500/30 bg-sky-500/10"}`}>
              <div className="mb-2 flex items-center justify-between text-[10px] font-bold text-[var(--muted-foreground)]"><span>{priorityLabel(form.priority)}公告</span><span>{statusLabel(form.status)}</span></div>
              <h4 className="text-base font-bold text-[var(--foreground)]">{form.title || "公告标题"}</h4>
              <p className="mt-2 text-xs leading-relaxed text-[var(--secondary-foreground)]">{form.summary || form.content || "公告摘要将在这里显示。"}</p>
            </div>
            <dl className="mt-4 space-y-2 text-xs text-[var(--muted-foreground)]">
              <div className="flex justify-between gap-3"><dt>目标</dt><dd>{form.target_audience}</dd></div>
              <div className="flex justify-between gap-3"><dt>阅读规则</dt><dd>点击“已阅读”后记入账号回执</dd></div>
              <div className="flex justify-between gap-3"><dt>关闭规则</dt><dd>仅本次登录收起</dd></div>
            </dl>
          </aside>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]">
        {loading ? (
          <div className="py-12 text-center text-sm text-[var(--muted-foreground)]">正在加载公告...</div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-sm text-[var(--muted-foreground)]">暂无公告</div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {items.map((item) => {
              const deliveryStatus = deliveryStatuses[item.id]
                || unavailableDeliveryStatus(item, "投递统计尚未读取");
              const hasDeliveryStatus = Boolean(deliveryStatuses[item.id]);
              const deliveryStatsLoading = statusLoading && !hasDeliveryStatus;
              const deliveryStatsUnavailable = !deliveryStatsLoading
                && (!hasDeliveryStatus || deliveryStatus.availability === "unavailable");
              const canFirstPublish = deliveryStatus.revision === 0 && item.status === "draft";
              const canRepush = deliveryStatus.revision > 0 && item.status === "published";
              const pushDisabled = (!canFirstPublish && !canRepush) || pushingId === item.id;
              const pushLabel = pushingId === item.id
                ? "推送中..."
                : canFirstPublish
                  ? "首次发布并推送"
                  : canRepush
                    ? "再次强推"
                    : item.status === "published"
                      ? "推送状态异常"
                      : "发布后可强推";
              return (
                <article key={item.id} className="p-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${item.priority === "urgent" ? "border-rose-500/30 bg-rose-500/10 text-rose-400" : item.priority === "important" ? "border-amber-500/30 bg-amber-500/10 text-amber-400" : "border-sky-500/30 bg-sky-500/10 text-sky-400"}`}>{priorityLabel(item.priority)}</span>
                      <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">{statusLabel(item.status)}</span>
                      {item.is_pinned && <span className="text-[10px] font-semibold text-[var(--primary)]">置顶</span>}
                      <h3 className="truncate text-sm font-bold text-[var(--foreground)]">{item.title}</h3>
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-[var(--muted-foreground)]">{item.summary || item.content}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[var(--muted-foreground)]">
                      <span>{item.target_audience}</span>
                      {item.publish_at && <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" />{new Date(item.publish_at).toLocaleString("zh-CN")}</span>}
                      {item.expires_at && <span>有效至 {new Date(item.expires_at).toLocaleString("zh-CN")}</span>}
                    </div>
                  </div>

                  <dl className="mt-4 grid grid-cols-6 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)]/32">
                    <div className="border-r border-[var(--border)] px-3 py-2.5"><dt className="text-[10px] text-[var(--muted-foreground)]">当前推送版本</dt><dd className="mt-1 text-sm font-black text-[var(--foreground)]">V{deliveryStatus.revision}</dd></div>
                    <div className="border-r border-[var(--border)] px-3 py-2.5"><dt className="text-[10px] text-[var(--muted-foreground)]">最后推送</dt><dd className="mt-1 truncate text-xs font-semibold text-[var(--secondary-foreground)]">{deliveryStatus.pushedAt ? new Date(deliveryStatus.pushedAt).toLocaleString("zh-CN", { hour12: false }) : deliveryStatsLoading ? "读取中..." : "尚未推送"}</dd></div>
                    <div className="border-r border-[var(--border)] px-3 py-2.5"><dt className="text-[10px] text-[var(--muted-foreground)]">目标用户</dt><dd className="mt-1 text-sm font-black text-[var(--foreground)]">{deliveryStatsLoading ? "…" : deliveryStatsUnavailable ? "--" : deliveryStatus.targetCount}</dd></div>
                    <div className="border-r border-[var(--border)] px-3 py-2.5"><dt className="text-[10px] text-[var(--muted-foreground)]">已读</dt><dd className="mt-1 text-sm font-black text-emerald-500">{deliveryStatsLoading ? "…" : deliveryStatsUnavailable ? "--" : deliveryStatus.readCount}</dd></div>
                    <div className="border-r border-[var(--border)] px-3 py-2.5"><dt className="text-[10px] text-[var(--muted-foreground)]">未读</dt><dd className="mt-1 text-sm font-black text-amber-500">{deliveryStatsLoading ? "…" : deliveryStatsUnavailable ? "--" : deliveryStatus.unreadCount}</dd></div>
                    <div className="px-3 py-2.5"><dt className="text-[10px] text-[var(--muted-foreground)]">已读率</dt><dd className="mt-1 text-sm font-black text-[var(--primary)]">{deliveryStatsLoading ? "…" : deliveryStatsUnavailable ? "--" : `${deliveryStatus.readRate.toFixed(1)}%`}</dd></div>
                  </dl>

                  {deliveryStatsUnavailable && (
                    <p role="alert" className="mt-2 text-xs font-semibold text-rose-400">
                      投递统计不可用：{deliveryStatus.error || "请稍后重试"}
                    </p>
                  )}

                  <div className="mt-4 flex items-center gap-1 border-t border-[var(--border)] pt-3">
                    <button type="button" onClick={() => edit(item)} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" title="编辑"><Pencil className="h-4 w-4" /></button>
                    <button type="button" onClick={() => duplicate(item)} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]" title="复制为草稿"><Copy className="h-4 w-4" /></button>
                    {item.status === "published" ? (
                      <button type="button" onClick={() => void changeStatus(item, "withdrawn")} className="h-8 rounded-lg px-2.5 text-xs font-semibold text-amber-400 hover:bg-amber-500/10">撤回</button>
                    ) : !canFirstPublish ? (
                      <button type="button" onClick={() => void changeStatus(item, "published")} className="h-8 rounded-lg px-2.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/10">发布</button>
                    ) : null}
                    <button type="button" onClick={() => void remove(item)} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] hover:bg-rose-500/10 hover:text-rose-400" title="永久删除"><Trash2 className="h-4 w-4" /></button>
                    <button
                      type="button"
                      onClick={() => void (canFirstPublish ? publishFirstAnnouncement(item) : pushAnnouncement(item))}
                      disabled={pushDisabled}
                      title={canFirstPublish ? "首次发布并向目标用户推送" : canRepush ? "生成新推送版本，让已读用户重新收到" : "请先恢复或完成公告发布"}
                      className="ml-auto inline-flex h-9 min-w-32 items-center justify-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 text-xs font-bold text-[var(--primary-foreground)] shadow-sm hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <Send className="h-4 w-4" />{pushLabel}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
