"use client";
/* Local thumbnails retain their object URLs without an optimizer request. */
/* eslint-disable @next/next/no-img-element */
import { ArrowDown, ArrowUp, Film, ImageIcon } from "lucide-react";
import type { StudioMedia } from "./types";
import { fileSize } from "./StudioPrimitives";
import styles from "./Studio.module.css";

export function StudioTargetMedia({ accountId, contentType, media, mediaIds, disabled, onChange }: { accountId: string; contentType: "video" | "image"; media: StudioMedia[]; mediaIds?: string[]; disabled: boolean; onChange(ids: string[] | undefined): void }) {
  const inherited = mediaIds === undefined;
  const selected = mediaIds ?? media.map(item => item.id);
  const ordered = [...selected.map(id => media.find(item => item.id === id)).filter((item): item is StudioMedia => !!item), ...media.filter(item => !selected.includes(item.id))];
  const missing = selected.some(id => !media.some(item => item.id === id));
  const toggle = (id: string) => { if (contentType === "video") onChange([id]); else onChange(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]); };
  const move = (id: string, direction: -1 | 1) => { const index = selected.indexOf(id); const destination = index + direction; if (index < 0 || destination < 0 || destination >= selected.length) return; const next = [...selected]; [next[index], next[destination]] = [next[destination], next[index]]; onChange(next); };
  return <fieldset className={styles.targetMedia} data-testid="studio-target-media"><legend>本账号素材</legend><label className={styles.checkboxLabel}><input type="checkbox" disabled={disabled} checked={inherited} data-testid="studio-target-media-inherit" onChange={event => onChange(event.target.checked ? undefined : contentType === "video" ? [] : media.map(item => item.id))} />沿用公共素材</label><p className={styles.fieldHint}>{inherited ? `随公共素材更新，当前 ${selected.length} 个。` : contentType === "video" ? "为这个账号选择一条视频。" : "勾选本账号的图片，用箭头调整发布顺序。"}</p>
    {(missing || (contentType === "video" && selected.length > 1) || (!inherited && !selected.length)) && <p className={styles.targetMediaWarning} role="status">{missing ? "有素材已不在当前素材池中，请重新选择或恢复公共素材。" : contentType === "video" && selected.length > 1 ? "公共素材包含多条视频，请关闭沿用并为这个账号选定一条。" : "尚未选定素材，发布前需要补充。"}</p>}
    {!media.length ? <p className={styles.fieldHint}>先在发布编辑页选入素材。</p> : <div className={styles.targetMediaList}>{ordered.map(item => { const index = selected.indexOf(item.id); const checked = index >= 0 && (contentType !== "video" || selected.length === 1); return <div className={styles.targetMediaRow} key={item.id} data-selected={checked}><label><input type={contentType === "video" ? "radio" : "checkbox"} name={`studio-target-media-${accountId}`} checked={checked} disabled={disabled || inherited} data-testid={`studio-target-media-${item.id}`} onChange={() => toggle(item.id)} /><span className={styles.targetMediaThumb}>{item.kind === "image" && item.url ? <img src={item.url} alt="" /> : item.kind === "video" ? <Film size={18} /> : <ImageIcon size={18} />}</span><span className={styles.targetMediaName}><strong title={item.name}>{checked && contentType === "image" ? `${index + 1}. ` : ""}{item.name}</strong><small>{fileSize(item.size)}{item.duration ? ` · ${Math.round(item.duration)} 秒` : ""}</small></span></label>{!inherited && checked && contentType === "image" && <span className={styles.targetMediaOrder}><button type="button" className={styles.iconButton} aria-label={`上移图片 ${item.name}`} disabled={disabled || index === 0} onClick={() => move(item.id, -1)}><ArrowUp size={15} /></button><button type="button" className={styles.iconButton} aria-label={`下移图片 ${item.name}`} disabled={disabled || index === selected.length - 1} onClick={() => move(item.id, 1)}><ArrowDown size={15} /></button></span>}</div>; })}</div>}
    {!inherited && <button type="button" className={styles.quietButton} disabled={disabled} onClick={() => onChange(undefined)}>恢复公共素材</button>}
  </fieldset>;
}
