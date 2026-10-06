"use client";

import Link from "next/link";
import { AlertTriangle, ArrowLeft, LoaderCircle, RotateCcw } from "lucide-react";

const shellStyle = {
  minHeight: "100dvh",
  display: "grid",
  placeItems: "center",
  padding: "24px",
  color: "var(--foreground)",
  background: "var(--background)",
} as const;

const cardStyle = {
  width: "min(100%, 520px)",
  display: "grid",
  gap: "14px",
  justifyItems: "center",
  padding: "28px",
  border: "1px solid var(--border)",
  borderRadius: "18px",
  textAlign: "center",
  background: "var(--card)",
  boxShadow: "0 18px 50px rgba(3, 7, 18, 0.18)",
} as const;

const actionStyle = {
  minHeight: "40px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  padding: "0 16px",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  color: "var(--foreground)",
  background: "var(--card)",
  fontWeight: 600,
} as const;

export function SecondaryRouteLoading({ label }: { label: string }) {
  return (
    <main style={shellStyle}>
      <section style={cardStyle} role="status" aria-live="polite" aria-busy="true">
        <LoaderCircle size={30} aria-hidden="true" className="animate-spin text-[var(--primary)]" />
        <strong>正在打开{label}…</strong>
        <span className="text-sm text-[var(--muted-foreground)]">正在加载页面资源，不会创建任务或产生费用。</span>
        <Link href="/" style={actionStyle}>
          <ArrowLeft size={17} aria-hidden="true" />
          返回应用广场
        </Link>
      </section>
    </main>
  );
}

export function SecondaryRouteError({
  label,
  reset,
}: {
  label: string;
  reset: () => void;
}) {
  return (
    <main style={shellStyle}>
      <section style={cardStyle} role="alert">
        <AlertTriangle size={30} aria-hidden="true" className="text-[var(--destructive)]" />
        <strong>{label}暂时无法打开</strong>
        <span className="text-sm text-[var(--muted-foreground)]">
          页面运行发生异常。若刚才已经提交过任务，请先到任务历史或消费记录核对状态；状态不明时不要重复提交。
          重新加载只恢复页面，不会自动重放刚才的请求。
        </span>
        <div className="flex flex-wrap justify-center gap-3">
          <button type="button" onClick={reset} style={actionStyle}>
            <RotateCcw size={17} aria-hidden="true" />
            重新加载
          </button>
          <Link href="/" style={actionStyle}>
            <ArrowLeft size={17} aria-hidden="true" />
            返回应用广场
          </Link>
        </div>
      </section>
    </main>
  );
}
