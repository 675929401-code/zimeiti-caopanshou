"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function StoryboardWorkbenchModal({ open, onClose, children }: {
  open: boolean; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const element = dialog.current;
    if (!mounted || !element) return;
    if (!open) { element.close(); return; }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!element.open) element.showModal();
    return () => { element.close(); document.body.style.overflow = previous; };
  }, [mounted, open]);
  return mounted ? createPortal(
    <dialog ref={dialog} className="sbw-root sbw-model-dialog" data-workbench-layout="director" aria-label="选择生成模型"
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className="sbw-dialog-heading"><div><strong>选择生成模型</strong><p>查看模型能力、价格与可用状态</p></div><button type="button" onClick={onClose} aria-label="关闭模型选择">×</button></header>
      {children}
    </dialog>, document.body,
  ) : null;
}
