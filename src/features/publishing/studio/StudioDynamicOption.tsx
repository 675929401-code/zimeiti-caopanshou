"use client";

import { useState } from "react";
import { PublishingDynamicOptionsSchema, type PublishingDynamicField, type PublishingOptionValue } from "@/lib/publishing-dynamic-options";
import { studioRequest } from "./studio-api";
import styles from "./Studio.module.css";

function selectableOptions(items: PublishingOptionValue[], parent = ""): PublishingOptionValue[] {
  return items.flatMap(item => {
    const label = parent ? `${parent} / ${item.label}` : item.label;
    return item.children?.length ? selectableOptions(item.children, label) : [{ ...item, label }];
  });
}

export function StudioDynamicOption({ accountId, field, label, value, required, disabled, onChange }: {
  accountId: string; field: PublishingDynamicField; label: string; value: unknown; required: boolean; disabled: boolean; onChange(value: string | number | undefined): void;
}) {
  const [items, setItems] = useState<PublishingOptionValue[]>([]);
  const [filter, setFilter] = useState(field === "categoryId" ? "US" : "");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const loading = status === "loading";
  const chosen = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const searchParam = field === "location_id" ? "keyword" : field === "community_id" ? "query" : null;
  const searchLabel = field === "community_id" ? "社区" : "位置";
  const hasRegion = field === "categoryId";
  function editFilter(next: string) {
    setFilter(hasRegion ? next.toUpperCase() : next);
    setItems([]);
    setStatus("idle");
  }
  async function load() {
    const query = searchParam ? `?${searchParam}=${encodeURIComponent(filter.trim())}` : hasRegion ? `?regionCode=${filter}` : "";
    setStatus("loading");
    setItems([]);
    try {
      const path = `v2/channels/accounts/${encodeURIComponent(accountId)}/publish-options/${field}/values${query}`;
      const data = PublishingDynamicOptionsSchema.parse(await studioRequest(path, "GET", undefined, AbortSignal.timeout(15_000)));
      if (data.field !== field) throw new Error("Unexpected option field");
      const unique = new Map(selectableOptions(data.items).filter(item => field !== "tid" || /^[1-9]\d*$/u.test(item.value) && Number.isSafeInteger(Number(item.value))).map(item => [item.value, item]));
      setItems([...unique.values()]);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }
  return <fieldset className={styles.schemaGroup}>
    <legend>{label}{required ? " · 必填" : ""}</legend>
    {searchParam && <label className={styles.field}><span className={styles.fieldLabel}>{field === "location_id" ? "地点关键词" : "社区关键词"}</span><input className={styles.input} placeholder="输入至少两个字符" maxLength={100} disabled={disabled || loading} value={filter} onChange={event => editFilter(event.target.value)} /></label>}
    {hasRegion && <label className={styles.field}><span className={styles.fieldLabel}>分类地区 <small>例如 US、HK</small></span><input className={styles.input} maxLength={2} disabled={disabled || loading} value={filter} onChange={event => editFilter(event.target.value)} /></label>}
    <button type="button" className={styles.smallButton} data-testid={`studio-option-load-${field}`} disabled={disabled || loading || (!!searchParam && filter.trim().length < 2) || (hasRegion && !/^[A-Z]{2}$/u.test(filter))} onClick={() => void load()}>{loading ? "读取中…" : searchParam ? `搜索${searchLabel}` : `读取${label}`}</button>
    <select className={styles.input} aria-label={label} data-testid={`studio-option-${field}`} disabled={disabled || loading || (!items.length && !chosen)} value={chosen} onChange={event => { const next = event.target.value; onChange(next ? field === "tid" ? Number(next) : next : undefined); }}>
      <option value="">{required ? `请选择${label}` : "不设置"}</option>
      {chosen && !items.some(item => item.value === chosen) && <option value={chosen}>已保存的选项（{chosen}）</option>}
      {items.map(item => <option key={item.value} value={item.value} disabled={item.disabled}>{item.label}</option>)}
    </select>
    {status === "error" && <p role="status" className={styles.fieldHint}>暂时无法读取{label}，请核对平台账号授权后重试。</p>}
    {status === "ready" && !items.length && <p role="status" className={styles.fieldHint}>{field === "boardId" ? "该账号还没有可选画板，请先在 Pinterest 创建画板。" : `没有找到可选的${label}。`}</p>}
  </fieldset>;
}
