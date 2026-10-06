"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";

type PersistedValue<T> = { key: string; value: T; restored: boolean; cleared: boolean };

function readStoredValue<T>(key: string, initialValue: T, validate?: (value: unknown) => value is T): T {
  try {
    const stored = sessionStorage.getItem(`app_state_${key}`);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (!validate || validate(parsed)) return parsed as T;
      sessionStorage.removeItem(`app_state_${key}`);
    }
  } catch {
    try { sessionStorage.removeItem(`app_state_${key}`); } catch { /* Storage may be unavailable. */ }
  }
  return initialValue;
}

/**
 * 用 sessionStorage 持久化 React 状态的 Hook
 * 切换路由后重新进入页面时自动恢复状态
 *
 * @param key - 存储键名（建议用页面名前缀避免冲突）
 * @param initialValue - 默认值
 * @returns [value, setValue, clearValue] - 与 useState 类似
 *
 * @example
 * const [tasks, setTasks] = usePersistedState<TaskCard[]>("video_tasks", []);
 * const [prompt, setPrompt] = usePersistedState("cover_prompt", "");
 */
export function usePersistedState<T>(
  key: string,
  initialValue: T,
  validate?: (value: unknown) => value is T,
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  // Server and browser must render the same first value. Drafts are restored
  // only after commit; the persistence effect cannot write an unrestored default.
  const [state, setState] = useState<PersistedValue<T>>(() => ({ key, value: initialValue, restored: false, cleared: false }));
  const configuration = useRef({ key, initialValue, validate });
  const committedState = useRef(state);
  useLayoutEffect(() => { configuration.current = { key, initialValue, validate }; }, [key, initialValue, validate]);
  useLayoutEffect(() => { committedState.current = state; }, [state]);

  useEffect(() => {
    const current = configuration.current;
    const restoredValue = readStoredValue(key, current.initialValue, current.validate);
    // A setter/clear invoked before this effect already owns the current value.
    setState((previous) => previous.key === key && previous.restored
      ? previous : { key, value: restoredValue, restored: true, cleared: false });
  }, [key]);

  useEffect(() => {
    if (!state.restored || state.key !== key) return;
    try {
      const serialized = JSON.stringify(state.value);
      if (state.cleared || serialized === undefined) sessionStorage.removeItem(`app_state_${key}`);
      else sessionStorage.setItem(`app_state_${key}`, serialized);
    } catch { /* Keep the in-memory state usable when storage is unavailable. */ }
  }, [key, state]);

  // Keep setters stable, as with useState, even if callers pass inline defaults.
  const setValue = useCallback((value: T | ((previous: T) => T)) => {
    const current = configuration.current;
    const committed = committedState.current;
    const restoredValue = committed.key === current.key && committed.restored
      ? committed.value : readStoredValue(current.key, current.initialValue, current.validate);
    setState((previous) => {
      const base = previous.key === current.key && previous.restored ? previous.value : restoredValue;
      const next = typeof value === "function" ? (value as (previous: T) => T)(base) : value;
      if (previous.key === current.key && previous.restored && !previous.cleared && Object.is(previous.value, next)) return previous;
      return { key: current.key, value: next, restored: true, cleared: false };
    });
  }, []);

  const clearValue = useCallback(() => {
    const current = configuration.current;
    setState({ key: current.key, value: current.initialValue, restored: true, cleared: true });
    try { sessionStorage.removeItem(`app_state_${current.key}`); } catch { /* ignore */ }
  }, []);

  return [state.key === key ? state.value : initialValue, setValue, clearValue];
}
