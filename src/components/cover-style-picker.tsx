"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import type { CoverStylePublic } from "@/lib/cover-style-catalog";
import styles from "./cover-workbench.module.css";

export type CoverStyleChoice = Pick<CoverStylePublic, "styleKey" | "displayName" | "description">;

/** A single bounded selector, independent of the number of published styles. */
export function CoverStylePicker({ choices, value, disabled, loading, error, onChange, onReload }: {
  choices: CoverStyleChoice[]; value: string; disabled: boolean; loading: boolean; error: string;
  onChange: (value: string) => void; onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const selected = choices.find(item => item.styleKey === value);
  const filtered = choices.filter(item => `${item.displayName} ${item.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
      if (event.key === "Tab") {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])') || [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  return <>
    <button type="button" ref={trigger} id="cover-workbench-style" className={styles.styleTrigger}
      disabled={disabled || loading} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setQuery(""); setOpen(true); }}>
      <span><strong>{selected?.displayName || (loading ? "正在读取风格…" : "请选择画面风格")}</strong>
        <small>{selected?.description || "从已发布风格中选择"}</small></span><ChevronDown size={16} />
    </button>
    {error && <p className={styles.inlineError}>{error} <button type="button" className={styles.textButton} onClick={onReload}>重新读取</button></p>}
    {open && <div className={styles.styleChooserBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} className={styles.styleChooser} role="dialog" aria-modal="true" aria-labelledby="cover-style-chooser-title">
        <header><div><h2 id="cover-style-chooser-title">选择画面风格</h2><p>共 {choices.length} 种风格，选择后应用对应的内容拆解和画面规则。</p></div>
          <button type="button" aria-label="关闭风格选择" onClick={close}><X size={18} /></button></header>
        <label className={styles.styleSearch}><Search size={17} /><input autoFocus aria-label="搜索画面风格" value={query} placeholder="搜索名称或风格特点" onChange={event => setQuery(event.target.value)} /></label>
        <div className={styles.styleChoices} role="group" aria-label="可选画面风格">
          {filtered.map(item => <button type="button" key={item.styleKey} data-workbench-control="choice" aria-pressed={item.styleKey === value}
            onClick={() => { onChange(item.styleKey); close(); }}>
            <span><strong>{item.displayName}</strong><small>{item.description}</small></span>{item.styleKey === value && <Check size={17} />}
          </button>)}
          {!filtered.length && <p className={styles.help}>没有匹配的风格，请调整搜索词。</p>}
        </div>
      </div>
    </div>}
  </>;
}
