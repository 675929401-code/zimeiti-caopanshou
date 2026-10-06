"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sortStoryboardProjectsBySubmission, type StoryboardProjectSummary } from "@/lib/storyboard-project-contract";

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
  const versions = useRef<Record<string, number>>({});
  const fingerprints = useRef(new Map<string, string>());
  const blocked = useRef(new Set<string>());
  const alive = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const listSequence = useRef(0);
  const mutations = useRef(0);
  const versionKey = `storyboard-project-versions:v1:${userId}`;

  const remember = useCallback((id: string, revision: number) => {
    versions.current[id] = revision;
    try { localStorage.setItem(versionKey, JSON.stringify(versions.current)); } catch { /* Revision hints are optional; project content stays server-owned. */ }
  }, [versionKey]);

  const request = useCallback(async (suffix = "", options?: RequestInit) => {
    const controller = new AbortController();
    requests.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/storyboard/projects${suffix}`, {
        ...options, signal: controller.signal, cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "任务服务暂时不可用");
      return result;
    } finally { window.clearTimeout(timeout); requests.current.delete(controller); }
  }, [token]);

  const refresh = useCallback(async (offset = 0) => {
    if (!alive.current) return;
    const sequence = ++listSequence.current;
    const mutation = mutations.current;
    setLoading(true);
    try {
      const result = await request(`?offset=${offset}`);
      if (!alive.current || sequence !== listSequence.current || mutation !== mutations.current) return;
      const rows = result.projects as StoryboardProjectSummary[];
      setProjects((current) => sortStoryboardProjectsBySubmission(
        offset ? [...current.filter((item) => !rows.some((row) => row.id === item.id)), ...rows] : rows,
      ));
      setNextOffset(result.nextOffset);
    } catch (error) {
      if (alive.current && !isExpectedRequestAbort(error)) {
        setMessage(error instanceof Error ? error.message : "最近任务读取失败，请重试");
      }
    } finally { if (alive.current && sequence === listSequence.current) setLoading(false); }
  }, [request]);

  useEffect(() => {
    alive.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(versionKey) || "{}");
      versions.current = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && Number(entry[1]) > 0));
    } catch { versions.current = {}; }
    setReady(true);
    void refresh();
    return () => { alive.current = false; for (const controller of requests.current) controller.abort(); };
  }, [refresh, versionKey]);

  const save = useCallback((document: T, manual = false): Promise<boolean> => {
    const fingerprint = JSON.stringify(document);
    const operation = queue.current.then(async () => {
      if (!alive.current || (blocked.current.has(document.id) && !manual)) return false;
      if (fingerprints.current.get(document.id) === fingerprint) return true;
      setMessage("正在保存任务…");
      try {
        const result = await request("", { method: "POST", body: JSON.stringify({ document, expectedRevision: versions.current[document.id] || 0 }) });
        if (!alive.current) return false;
        const project = result.project as StoryboardProjectSummary;
        mutations.current++;
        remember(project.id, project.revision);
        fingerprints.current.set(project.id, fingerprint);
        blocked.current.delete(project.id);
        setProjects((current) => sortStoryboardProjectsBySubmission([project, ...current.filter((item) => item.id !== project.id)]));
        setMessage("任务已保存");
        return true;
      } catch (error) {
        if (isExpectedRequestAbort(error)) return false;
        blocked.current.add(document.id);
        if (alive.current) setMessage(error instanceof Error ? error.message : "保存未确认，当前页面内容仍保留，请重试");
        return false;
      }
    });
    queue.current = operation;
    return operation;
  }, [remember, request]);

  const restore = useCallback(async (id: string): Promise<T | null> => {
    try {
      await queue.current;
      const result = await request(`?id=${encodeURIComponent(id)}`);
      if (!alive.current) return null;
      remember(id, result.project.revision);
      blocked.current.delete(id);
      fingerprints.current.delete(id);
      setMessage("已读取任务");
      return result.project.document as T;
    } catch (error) {
      if (isExpectedRequestAbort(error)) return null;
      if (alive.current) setMessage(error instanceof Error ? error.message : "任务读取失败，当前页面内容不变");
      return null;
    }
  }, [remember, request]);

  const remove = useCallback(async (project: StoryboardProjectSummary) => {
    blocked.current.add(project.id);
    await queue.current;
    try {
      await request("", { method: "DELETE", body: JSON.stringify({ id: project.id, expectedRevision: Math.max(project.revision, versions.current[project.id] || 0) }) });
      if (!alive.current) return false;
      mutations.current++;
      setProjects((current) => current.filter((item) => item.id !== project.id));
      setMessage("任务记录已删除，生成素材仍保留");
      return true;
    } catch (error) {
      if (isExpectedRequestAbort(error)) return false;
      if (alive.current) setMessage(error instanceof Error ? error.message : "删除失败，原任务仍保留");
      return false;
    }
  }, [request]);

  return { projects, ready, loading, message, nextOffset, refresh, save, restore, remove };
}
