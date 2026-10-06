'use client';

import React, { useState, useEffect } from 'react';
import { useApp } from '@/contexts/app-context';
import { resolveWorkbenchIdentity, workbenchUserStorageKey } from '@/lib/workbench-user-storage';

interface RunningTask {
  ownerUserId: string;
  taskId: string;
  text: string;
  speaker: string;
  startTime: number;
  page: string;
}

const STORAGE_KEY = 'tts_running_task';
const RUNNING_TASK_POINTER_VERSION = 1;
const RUNNING_TASK_POINTER_TTL_MS = 24 * 60 * 60 * 1_000;
type RunningTaskPointer = {
  version: typeof RUNNING_TASK_POINTER_VERSION;
  ownerUserId: string;
  taskId: string;
  startedAt: number;
  sourcePage: string;
  expiresAt: number;
};
let activeTaskInMemory: RunningTask | null = null;

function runningTaskKey(ownerUserId: string) {
  return workbenchUserStorageKey(STORAGE_KEY, ownerUserId);
}

function persistRunningTaskPointer(task: Pick<RunningTask, 'ownerUserId' | 'taskId' | 'startTime' | 'page'>) {
  const pointer: RunningTaskPointer = {
    version: RUNNING_TASK_POINTER_VERSION,
    ownerUserId: task.ownerUserId,
    taskId: task.taskId,
    startedAt: task.startTime,
    sourcePage: task.page.startsWith('/') ? task.page.split(/[?#]/u)[0].slice(0, 160) : '',
    expiresAt: task.startTime + RUNNING_TASK_POINTER_TTL_MS,
  };
  localStorage.setItem(runningTaskKey(task.ownerUserId), JSON.stringify(pointer));
}

export function setRunningTask(task: RunningTask) {
  try {
    if (!task.ownerUserId.trim()) return;
    activeTaskInMemory = task;
    persistRunningTaskPointer(task);
    window.dispatchEvent(new Event('tts_task_update'));
  } catch {}
}

export function clearRunningTask(ownerUserId: string, taskId?: string) {
  try {
    if (!ownerUserId.trim()) return;
    if (taskId && getRunningTask(ownerUserId)?.taskId !== taskId) return;
    if (!taskId || activeTaskInMemory?.taskId === taskId) activeTaskInMemory = null;
    localStorage.removeItem(runningTaskKey(ownerUserId));
    window.dispatchEvent(new Event('tts_task_update'));
  } catch {}
}

export function getRunningTask(ownerUserId: string): RunningTask | null {
  try {
    if (!ownerUserId.trim()) return null;
    const key = runningTaskKey(ownerUserId);
    const raw = localStorage.getItem(key);
    const stored = raw ? JSON.parse(raw) as Partial<RunningTaskPointer & RunningTask> : null;
    if (!stored || stored.ownerUserId !== ownerUserId || typeof stored.taskId !== 'string' || !stored.taskId) {
      localStorage.removeItem(key);
      return null;
    }

    const legacyStartedAt = Number(stored.startedAt ?? stored.startTime);
    const legacySourcePage = String(stored.sourcePage ?? stored.page ?? '');
    const expiresAt = Number(stored.expiresAt || legacyStartedAt + RUNNING_TASK_POINTER_TTL_MS);
    const now = Date.now();
    if (!Number.isFinite(legacyStartedAt) || !Number.isFinite(expiresAt)
      || legacyStartedAt > now || expiresAt <= now || expiresAt > legacyStartedAt + RUNNING_TASK_POINTER_TTL_MS) {
      localStorage.removeItem(key);
      if (activeTaskInMemory?.ownerUserId === ownerUserId) activeTaskInMemory = null;
      return null;
    }

    // Legacy values contained the full synthesis text and speaker. Rewrite the
    // record immediately as an opaque task pointer before exposing any state.
    if (stored.version !== RUNNING_TASK_POINTER_VERSION || 'text' in stored || 'speaker' in stored) {
      persistRunningTaskPointer({ ownerUserId, taskId: stored.taskId, startTime: legacyStartedAt, page: legacySourcePage });
    }
    if (activeTaskInMemory?.ownerUserId === ownerUserId && activeTaskInMemory.taskId === stored.taskId) {
      return activeTaskInMemory;
    }
    return { ownerUserId, taskId: stored.taskId, text: '', speaker: '', startTime: legacyStartedAt, page: legacySourcePage };
  } catch {
    return null;
  }
}

export default function GlobalTaskBar() {
  const { state } = useApp();
  const ownerUserId = resolveWorkbenchIdentity(state.auth)?.userId;
  const [task, setTask] = useState<RunningTask | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const update = () => setTask(ownerUserId ? getRunningTask(ownerUserId) : null);
    update();
    setCollapsed(false);
    window.addEventListener('tts_task_update', update);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || (ownerUserId && event.key === workbenchUserStorageKey(STORAGE_KEY, ownerUserId))) update();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('tts_task_update', update);
      window.removeEventListener('storage', onStorage);
    };
  }, [ownerUserId]);

  // 计时器
  useEffect(() => {
    if (!task || task.ownerUserId !== ownerUserId) return;
    setElapsed(Math.max(0, Math.floor((Date.now() - task.startTime) / 1000)));
    const timer = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - task.startTime) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [task, ownerUserId]);

  if (!task || task.ownerUserId !== ownerUserId) return null;

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;

  if (collapsed) {
    return (
      <div className="sticky top-16 z-30 bg-[var(--vs-surface)]/90 backdrop-blur-xl border-b border-[var(--vs-border)]">
        <button
          onClick={() => setCollapsed(false)}
          className="w-full px-4 py-1.5 flex items-center justify-center gap-2 text-xs text-sky-400 hover:text-sky-300 transition-colors"
        >
          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          正在合成中... {timeStr}
        </button>
      </div>
    );
  }

  return (
    <div className="sticky top-16 z-30 bg-[var(--vs-surface)]/95 backdrop-blur-xl border-b border-[var(--vs-border)]">
      <div className="px-4 py-2.5 flex items-center gap-3">
        {/* 动画指示器 */}
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-indigo-500 flex items-center justify-center animate-pulse shadow-lg shadow-cyan-500/20">
          <svg className="w-4 h-4 text-white animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>

        {/* 任务信息 */}
        <div className="flex-1 min-w-0">
          <p className="text-xs text-sky-200 font-medium">
            正在合成 · 已用时 {timeStr}
          </p>
          <p className="text-[10px] text-[var(--vs-text-muted)] truncate">
            {task.text ? `🎤 ${task.speaker} · ${task.text.slice(0, 30)}` : `任务 ${task.taskId.slice(0, 16)} · 正文从服务端历史读取`}
          </p>
        </div>

        {/* 操作按钮 */}
        <button
          onClick={() => setCollapsed(true)}
          className="text-xs text-[var(--vs-text-muted)] hover:text-[var(--vs-text-muted)] px-2 py-1 rounded transition-colors"
          title="折叠"
        >
          收起
        </button>
      </div>
    </div>
  );
}
