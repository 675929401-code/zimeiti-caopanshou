"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sortStoryboardProjectsBySubmission, type StoryboardProjectSummary } from "@/lib/storyboard-project-contract";

export function storyboardRetryAfterMs(header: string | null, body: unknown, now = Date.now()): number {
  if (header?.trim()) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, Math.ceil(seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(1000, date - now);
  }
  const seconds = typeof body === "number" || typeof body === "string" ? Number(body) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.max(1000, Math.ceil(seconds * 1000)) : 30000;
}

export class StoryboardProjectRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string | undefined, public readonly retryAfterMs: number) {
    super(message);
    this.name = "StoryboardProjectRequestError";
  }
}

function cooldownMessage(retryAt: number) {
  return `任务尚未保存，${Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))} 秒后可重试；已提交项目将自动重试，当前页面内容仍保留`;
}

function isExpectedRequestAbort(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return /(?:signal is )?aborted|aborterror/iu.test(error instanceof Error ? error.message : String(error || ""));
}

export function useStoryboardProjects<T extends { id: string }>(userId: string, token: string) {
  const [projects, setProjects] = useState<StoryboardProjectSummary[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [saveRetryAt, setSaveRetryAt] = useState(0);
  const retryAt = useRef(0);
  const versions = useRef<Record<string, number>>({});
  const fingerprints = useRef(new Map<string, string>());
  const unconfirmed = useRef(new Map<string, { body: string; fingerprint: string }>());
  const blocked = useRef(new Set<string>());
  const alive = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const listSequence = useRef(0);
  const mutations = useRef(0);
  const transientFailures = useRef(0);
  const owner = userId + "\0" + token;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const versionKey = `storyboard-project-versions:v1:${userId}`;

  const remember = useCallback((id: string, revision: number) => {
    if (!alive.current || ownerRef.current !== owner) return;
    versions.current[id] = revision;
    try { localStorage.setItem(versionKey, JSON.stringify(versions.current)); } catch { /* Revision hints are optional; project content stays server-owned. */ }
  }, [owner, versionKey]);

  const request = useCallback(async (suffix = "", options?: RequestInit) => {
    if (!alive.current || ownerRef.current !== owner) throw new DOMException("Session changed", "AbortError");
    const controller = new AbortController();
    requests.current.add(controller);
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    try {
      const response = await fetch(`/api/storyboard/projects${suffix}`, {
        ...options, signal: controller.signal, cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const result = await response.json().catch(() => ({}));
      if (!alive.current || ownerRef.current !== owner) throw new DOMException("Session changed", "AbortError");
      if (!response.ok) {
        const retryHeader = response.headers.get("Retry-After");
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const delay = retryable && (response.status === 429 || retryHeader || result.retryAfter !== undefined)
          ? storyboardRetryAfterMs(retryHeader, result.retryAfter) : 0;
        if (response.status === 429 && alive.current) {
          retryAt.current = Math.max(retryAt.current, Date.now() + delay);
          setSaveRetryAt(retryAt.current);
        }
        throw new StoryboardProjectRequestError(result.error || "任务服务暂时不可用", response.status, result.code, delay);
      }
      return result;
    } catch (error) {
      if (timedOut && alive.current && ownerRef.current === owner) {
        throw new StoryboardProjectRequestError("任务保存或读取超时，当前编辑仍保留", 408, "PROJECT_REQUEST_TIMEOUT", 0);
      }
      throw error;
    } finally { window.clearTimeout(timeout); requests.current.delete(controller); }
  }, [owner, token]);

  const refresh = useCallback(async (offset = 0) => {
    if (!alive.current || ownerRef.current !== owner) return;
    const sequence = ++listSequence.current;
    const mutation = mutations.current;
    setLoading(true);
    try {
      const result = await request(`?offset=${offset}`);
      if (!alive.current || ownerRef.current !== owner || sequence !== listSequence.current || mutation !== mutations.current) return;
      const rows = result.projects as StoryboardProjectSummary[];
      setProjects((current) => sortStoryboardProjectsBySubmission(
        offset ? [...current.filter((item) => !rows.some((row) => row.id === item.id)), ...rows] : rows,
      ));
      setNextOffset(result.nextOffset);
    } catch (error) {
      if (alive.current && ownerRef.current === owner && !isExpectedRequestAbort(error)) {
        setMessage(error instanceof Error ? error.message : "最近任务读取失败，请重试");
      }
    } finally { if (alive.current && ownerRef.current === owner && sequence === listSequence.current) setLoading(false); }
  }, [owner, request]);

  useEffect(() => {
    alive.current = true;
    const activeRequests = requests.current;
    // A new account/session cannot inherit confirmations, conflicts or queued
    // writes from the previous owner. Pending old requests also check owner.
    fingerprints.current.clear(); unconfirmed.current.clear(); blocked.current.clear(); transientFailures.current = 0;
    retryAt.current = 0; setSaveRetryAt(0); queue.current = Promise.resolve();
    setProjects([]); setNextOffset(null); setMessage("");
    try {
      const saved = JSON.parse(localStorage.getItem(versionKey) || "{}");
      versions.current = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && Number(entry[1]) > 0));
    } catch { versions.current = {}; }
    setReady(true);
    void refresh();
    return () => { alive.current = false; for (const controller of activeRequests) controller.abort(); };
  }, [refresh, versionKey]);

  // One wake-up per hook, shared by queued saves and manual saves.
  useEffect(() => {
    if (!saveRetryAt) return;
    const timer = window.setTimeout(() => {
      if (alive.current && retryAt.current <= Date.now()) setSaveRetryAt(0);
    }, Math.max(0, saveRetryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [saveRetryAt]);

  const save = useCallback((document: T, manual = false, canSave?: () => boolean): Promise<boolean> => {
    const fingerprint = JSON.stringify(document);
    const operation = queue.current.then(async () => {
      if (!alive.current || ownerRef.current !== owner || canSave?.() === false || (blocked.current.has(document.id) && !manual)) return false;
      if (retryAt.current > Date.now()) {
        setMessage(cooldownMessage(retryAt.current));
        return false;
      }
      if (!unconfirmed.current.has(document.id) && fingerprints.current.get(document.id) === fingerprint) return true;
      setMessage("正在保存任务…");
      try {
        // A timeout/lost response may have committed. Confirm the exact original
        // body first: the server's content-hash replay returns its revision even
        // when expectedRevision is old. Never adopt a GET revision to overwrite it.
        for (let pass = 0; pass < 2; pass++) {
          if (!alive.current || ownerRef.current !== owner || canSave?.() === false) return false;
          const attempt = unconfirmed.current.get(document.id) || {
            body: `{"document":${fingerprint},"expectedRevision":${versions.current[document.id] || 0}}`, fingerprint,
          };
          unconfirmed.current.set(document.id, attempt);
          const result = await request("", { method: "POST", body: attempt.body });
          if (!alive.current || ownerRef.current !== owner) return false;
          const project = result.project as StoryboardProjectSummary;
          if (!project || project.id !== document.id || !Number.isSafeInteger(project.revision) || project.revision < 1) {
            throw new StoryboardProjectRequestError("任务保存响应不完整，当前编辑仍保留", 503, "PROJECT_SAVE_UNCONFIRMED", 0);
          }
          mutations.current++;
          remember(project.id, project.revision);
          fingerprints.current.set(project.id, attempt.fingerprint);
          unconfirmed.current.delete(project.id);
          blocked.current.delete(project.id);
          transientFailures.current = 0;
          setProjects((current) => sortStoryboardProjectsBySubmission([project, ...current.filter((item) => item.id !== project.id)]));
          if (attempt.fingerprint === fingerprint) break;
        }
        setMessage("任务已保存");
        return true;
      } catch (error) {
        if (!alive.current || ownerRef.current !== owner) return false;
        if (isExpectedRequestAbort(error)) return false;
        const transient = !(error instanceof StoryboardProjectRequestError)
          || error.status === 408 || error.status === 429 || error.status >= 500;
        if (transient) {
          transientFailures.current += 1;
          const backoff = Math.min(30_000, 5_000 * (2 ** Math.min(3, transientFailures.current - 1)));
          const delay = error instanceof StoryboardProjectRequestError && error.retryAfterMs > 0 ? error.retryAfterMs : backoff;
          retryAt.current = Math.max(retryAt.current, Date.now() + delay);
          setSaveRetryAt(retryAt.current);
        } else { blocked.current.add(document.id); unconfirmed.current.delete(document.id); }
        setMessage(transient ? cooldownMessage(retryAt.current) : error instanceof Error ? error.message : "保存未确认，当前页面内容仍保留，请重试");
        return false;
      }
    });
    queue.current = operation;
    return operation;
  }, [owner, remember, request]);

  const restore = useCallback(async (id: string): Promise<T | null> => {
    try {
      await queue.current;
      const result = await request(`?id=${encodeURIComponent(id)}`);
      if (!alive.current || ownerRef.current !== owner) return null;
      remember(id, result.project.revision);
      blocked.current.delete(id);
      fingerprints.current.delete(id);
      unconfirmed.current.delete(id);
      setMessage("已读取任务");
      return result.project.document as T;
    } catch (error) {
      if (isExpectedRequestAbort(error)) return null;
      if (alive.current && ownerRef.current === owner) setMessage(error instanceof Error ? error.message : "任务读取失败，当前页面内容不变");
      return null;
    }
  }, [owner, remember, request]);

  const remove = useCallback(async (project: StoryboardProjectSummary) => {
    if (!alive.current || ownerRef.current !== owner) return false;
    blocked.current.add(project.id);
    await queue.current;
    try {
      await request("", { method: "DELETE", body: JSON.stringify({ id: project.id, expectedRevision: Math.max(project.revision, versions.current[project.id] || 0) }) });
      if (!alive.current || ownerRef.current !== owner) return false;
      mutations.current++;
      unconfirmed.current.delete(project.id);
      fingerprints.current.delete(project.id);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      setMessage("任务记录已删除，生成素材仍保留");
      return true;
    } catch (error) {
      if (isExpectedRequestAbort(error)) return false;
      if (alive.current && ownerRef.current === owner) setMessage(error instanceof Error ? error.message : "删除失败，原任务仍保留");
      return false;
    }
  }, [owner, request]);

  return { projects, ready, loading, message, nextOffset, saveRetryAt, refresh, save, restore, remove };
}
