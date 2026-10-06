"use client";

import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import styles from "@/app/short-drama/short-drama.module.css";

interface RouteErrorPanelProps {
  title: string;
  message: string;
  reset: () => void;
}

export function RouteErrorPanel({ title, message, reset }: RouteErrorPanelProps) {
  return (
    <main className={styles.routeStateRoot}>
      <section className={styles.routeStateCard} role="alert">
        <span className={styles.routeStateIcon} aria-hidden="true">
          <AlertTriangle size={24} />
        </span>
        <p className={styles.eyebrow}>页面状态</p>
        <h1>{title}</h1>
        <p>{message}</p>
        <div className={styles.stateActions}>
          <button type="button" className={styles.primaryButton} onClick={reset}>
            <RotateCcw size={16} />
            重新加载
          </button>
          <Link className={styles.secondaryButton} href="/">
            返回主站
          </Link>
        </div>
      </section>
    </main>
  );
}

export function RouteLoadingPanel({ label }: { label: string }) {
  return (
    <main className={styles.routeStateRoot} aria-busy="true">
      <section className={styles.routeStateCard} role="status">
        <span className={styles.loadingOrb} aria-hidden="true" />
        <p className={styles.eyebrow}>正在准备</p>
        <h1>{label}</h1>
        <p>正在加载页面结构与本地配置，不会在此阶段触发生成任务。</p>
        <div className={styles.loadingLines} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>
    </main>
  );
}

