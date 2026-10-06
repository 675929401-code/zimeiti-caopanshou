'use client';

import React, { useState, useEffect } from 'react';

interface RunningTask {
  taskId: string;
  text: string;
  speaker: string;
  startTime: number;
  page: string;
}

const STORAGE_KEY = 'tts_running_task';

export function setRunningTask(task: RunningTask) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(task));
    window.dispatchEvent(new Event('tts_task_update'));
  } catch {}
}

export function clearRunningTask() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event('tts_task_update'));
  } catch {}
}

export function getRunningTask(): RunningTask | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function GlobalTaskBar() {
  const [task, setTask] = useState<RunningTask | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const update = () => setTask(getRunningTask());
    update();
    window.addEventListener('tts_task_update', update);
    return () => window.removeEventListener('tts_task_update', update);
  }, []);

  // 计时器
  useEffect(() => {
    if (!task) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - task.startTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [task?.taskId]);

  if (!task) return null;

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;

  if (collapsed) {
    return (
      <div className="sticky top-16 z-30 bg-vp-card/90 backdrop-blur-xl border-b border-vp-border">
        <button
          onClick={() => setCollapsed(false)}
          className="w-full px-4 py-1.5 flex items-center justify-center gap-2 text-xs text-sky-400 hover:text-vp-primary transition-colors"
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
    <div className="sticky top-16 z-30 bg-vp-card/95 backdrop-blur-xl border-b border-vp-border">
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
          <p className="text-xs text-vp-primary font-medium">
            正在合成 · 已用时 {timeStr}
          </p>
          <p className="text-[10px] text-vp-muted-foreground truncate">
            🎤 {task.speaker} · {task.text.slice(0, 30)}
          </p>
        </div>

        {/* 操作按钮 */}
        <button
          onClick={() => setCollapsed(true)}
          className="text-xs text-vp-muted-foreground hover:text-vp-muted-foreground px-2 py-1 rounded transition-colors"
          title="折叠"
        >
          收起
        </button>
      </div>
    </div>
  );
}
