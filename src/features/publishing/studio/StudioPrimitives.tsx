"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Check, CircleAlert, Clock3, Loader2, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import type { StudioCheck } from "./types";
import styles from "./Studio.module.css";

export function StudioDialog({ title, description, children, footer, onClose, testId, wide = false }: { title: string; description?: string; children: ReactNode; footer?: ReactNode; onClose(): void; testId?: string; wide?: boolean }) {
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className={styles.dialogOverlay} /><Dialog.Content ref={content} className={`${styles.dialog} ${wide ? styles.dialogWide : ""}`} data-testid={testId} onOpenAutoFocus={event => { if (document.activeElement instanceof HTMLElement && !content.current?.contains(document.activeElement)) opener.current = document.activeElement; const preferred = content.current?.querySelector<HTMLElement>("[data-studio-focus]"); if (preferred) { event.preventDefault(); preferred.focus(); } }} onCloseAutoFocus={event => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }}>
    <div className={styles.dialogHeader}><Dialog.Title className={styles.dialogTitle}>{title}</Dialog.Title><Dialog.Close asChild><button type="button" className={styles.iconButton} aria-label="关闭弹窗"><X size={19} /></button></Dialog.Close></div>
    <Dialog.Description className={description ? styles.dialogDescription : styles.hiddenInput}>{description || "核对当前操作"}</Dialog.Description>
    <div className={styles.dialogBody}>{children}</div>{footer && <div className={styles.dialogFooter}>{footer}</div>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function CheckIcon({ status }: { status: StudioCheck["status"] }) {
  return <span className={styles.checkIcon} data-state={status}>{status === "pass" ? <Check size={14} /> : status === "pending" ? <Clock3 size={14} /> : <CircleAlert size={14} />}</span>;
}

export function BusyLabel({ busy, children }: { busy?: boolean; children: ReactNode }) { return <>{busy && <Loader2 size={15} className={styles.spin} />}{children}</>; }
export function fileSize(bytes: number) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`; }
export function dateText(value?: string) { if (!value) return ""; const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); }
export function localDateTime(value?: string) { if (!value) return ""; const date = new Date(value); if (Number.isNaN(date.getTime())) return ""; return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }
