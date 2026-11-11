"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { FolderOpen, X } from "lucide-react";
import { PUBLISHING_COMMERCIAL_PLATFORMS } from "@/lib/publishing-contract";
import styles from "../PublishingWorkbench.module.css";
export function WorkbenchDialog({ title, children, onClose, footer, wide = false }: { title: string; children: ReactNode; onClose(): void; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null); const titleId = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`${styles.dialog} ${wide ? styles.wideDialog : ""}`} aria-labelledby={titleId} data-publishing-dialog="" onCancel={event => { event.preventDefault(); onClose(); }}><div className={styles.dialogHeading}><h2 id={titleId}>{title}</h2><button type="button" aria-label="关闭弹窗" onClick={onClose}><X size={18} /></button></div><div className={styles.dialogBody}>{children}</div>{footer && <div className={styles.dialogFooter}>{footer}</div>}</dialog>;
}
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) { return <div className={styles.emptyState}><span className={styles.emptyIcon}><FolderOpen size={28} /></span><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>; }
export function SectionHeading({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) { return <div className={styles.sectionHeading}><div><h2>{title}</h2>{children && <p>{children}</p>}</div>{action && <div className={styles.actions}>{action}</div>}</div>; }
export const platformLabel = (platform: string) => PUBLISHING_COMMERCIAL_PLATFORMS.find(item => item.key === platform)?.name || platform;
export const dateLabel = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
export const moneyLabel = (value: number) => value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fileSizeLabel = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
