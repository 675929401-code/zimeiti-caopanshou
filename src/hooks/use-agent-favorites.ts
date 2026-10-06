"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useAgentFavorites(userId: string, token: string | null | undefined) {
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(new Set<string>());
  const owner = useRef(userId);
  const sequence = useRef(0);

  useEffect(() => {
    owner.current = userId;
  }, [userId]);

  const load = useCallback(async () => {
    const stamp = ++sequence.current;
    if (!userId || !token) {
      setFavorites(new Set());
      setLoaded(true);
      return;
    }
    try {
      const response = await fetch("/api/agent-favorites", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "收藏暂时无法读取");
      if (stamp !== sequence.current || owner.current !== userId) return;
      setFavorites(new Set((data.favorites || []).map((item: { agent_id?: unknown }) => String(item.agent_id || "")).filter(Boolean)));
      setError("");
      setLoaded(true);
    } catch (loadError) {
      if (stamp !== sequence.current || owner.current !== userId) return;
      setError(loadError instanceof Error ? loadError.message : "收藏暂时无法读取");
      setLoaded(true);
    }
  }, [token, userId]);

  useEffect(() => {
    sequence.current += 1;
    pending.current.clear();
    setFavorites(new Set());
    setLoaded(false);
    setError("");
    void load();
    const refresh = () => { if (pending.current.size === 0) void load(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("agent-favorites-updated", refresh);
    return () => {
      sequence.current += 1;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("agent-favorites-updated", refresh);
    };
  }, [load]);

  const toggleFavorite = useCallback(async (agentId: string) => {
    if (!userId || !token) throw new Error("请先登录，再保存收藏");
    if (pending.current.has(agentId)) return;
    pending.current.add(agentId);
    const removing = favorites.has(agentId);
    try {
      const response = await fetch(
        `/api/agent-favorites${removing ? `?agent_id=${encodeURIComponent(agentId)}` : ""}`,
        {
          method: removing ? "DELETE" : "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(removing ? {} : { body: JSON.stringify({ agent_id: agentId }) }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "收藏尚未保存，请重试");
      if (owner.current !== userId) return;
      setFavorites((current) => {
        const next = new Set(current);
        if (removing) next.delete(agentId);
        else next.add(agentId);
        return next;
      });
      setError("");
      window.dispatchEvent(new Event("agent-favorites-updated"));
    } catch (toggleError) {
      const message = toggleError instanceof Error ? toggleError.message : "收藏尚未保存，请重试";
      if (owner.current === userId) setError(message);
      throw toggleError;
    } finally {
      pending.current.delete(agentId);
    }
  }, [favorites, token, userId]);

  return {
    favorites,
    loaded,
    error,
    pending,
    toggleFavorite,
    refresh: load,
  };
}
