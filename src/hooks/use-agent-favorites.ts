"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type FavoritesStatus = "loading" | "ready" | "error";

type FavoriteOperation = {
  lifecycle: number;
  token: string;
};

const normalizeFavoriteIds = (value: unknown): Set<string> => {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .map((item) => {
        if (typeof item === "string" || typeof item === "number") return String(item).trim();
        if (!item || typeof item !== "object") return "";
        const agentId = (item as { agent_id?: unknown }).agent_id;
        return String(agentId || "").trim();
      })
      .filter(Boolean),
  );
};

export function useAgentFavorites(userId: string, token: string | null | undefined) {
  const identityKey = `${userId}\u0000${token || ""}`;
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(!userId);
  const [status, setStatus] = useState<FavoritesStatus>(userId ? "loading" : "ready");
  const [error, setError] = useState("");
  const [pendingAgentIds, setPendingAgentIds] = useState<Set<string>>(new Set());

  // Refs are the concurrency source of truth. React state can lag behind a
  // response, while these refs let every request check the current identity,
  // snapshot and operation owner before touching the UI.
  const favoritesRef = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const pendingOwners = useRef(new Map<string, FavoriteOperation>());
  const lifecycle = useRef(0);
  const currentIdentity = useRef(identityKey);
  const readSequence = useRef(0);
  const operationSequence = useRef(0);
  const snapshotKnown = useRef(!userId);

  const replaceSnapshot = useCallback((next: Set<string>) => {
    const copy = new Set(next);
    favoritesRef.current = copy;
    setFavorites(copy);
  }, []);

  const setPending = useCallback(() => {
    setPendingAgentIds(new Set(pending.current));
  }, []);

  const load = useCallback(async () => {
    const requestIdentity = identityKey;
    const requestLifecycle = lifecycle.current;
    const requestSequence = ++readSequence.current;
    const isCurrentRead = () => (
      currentIdentity.current === requestIdentity
      && lifecycle.current === requestLifecycle
      && readSequence.current === requestSequence
    );

    if (!userId) {
      if (!isCurrentRead()) return;
      snapshotKnown.current = true;
      replaceSnapshot(new Set());
      setLoaded(true);
      setStatus("ready");
      setError("");
      return;
    }

    if (!token) {
      if (!isCurrentRead()) return;
      snapshotKnown.current = false;
      setLoaded(false);
      setStatus("error");
      setError("收藏状态尚未准备好，请重新登录后重试");
      return;
    }

    // Keep a known snapshot visible while a background refresh is in flight.
    // An unknown first read remains in the loading state until it succeeds or
    // reports a durable error.
    if (!snapshotKnown.current) setStatus("loading");

    try {
      const response = await fetch("/api/agent-favorites", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await response.json() as { error?: unknown; favorites?: unknown };
      if (!response.ok) throw new Error(String(data.error || "收藏暂时无法读取"));
      if (!isCurrentRead()) return;

      snapshotKnown.current = true;
      replaceSnapshot(normalizeFavoriteIds(data.favorites));
      setLoaded(true);
      setStatus("ready");
      setError("");
    } catch (loadError) {
      if (!isCurrentRead()) return;
      // A failed refresh must not erase a previously known snapshot. The first
      // failed read stays unknown so the UI cannot infer “no favorites” and
      // submit the wrong inverse operation.
      setLoaded(snapshotKnown.current);
      setStatus("error");
      setError(loadError instanceof Error ? loadError.message : "收藏暂时无法读取");
    }
  }, [identityKey, replaceSnapshot, token, userId]);

  useEffect(() => {
    const requestLifecycle = ++lifecycle.current;
    const pendingSet = pending.current;
    const pendingOwnerMap = pendingOwners.current;
    currentIdentity.current = identityKey;
    readSequence.current += 1;
    pendingSet.clear();
    pendingOwnerMap.clear();
    setPendingAgentIds(new Set());
    favoritesRef.current = new Set();
    setFavorites(new Set());
    snapshotKnown.current = !userId;
    setLoaded(!userId);
    setStatus(userId ? "loading" : "ready");
    setError("");
    void load();

    const refresh = () => {
      if (pending.current.size === 0) void load();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("agent-favorites-updated", refresh);
    return () => {
      // Invalidate every request from this account/token lifecycle. A later
      // login with the same user id receives a new lifecycle number as well.
      if (lifecycle.current === requestLifecycle) lifecycle.current += 1;
      readSequence.current += 1;
      pendingSet.clear();
      pendingOwnerMap.clear();
      setPendingAgentIds(new Set());
      window.removeEventListener("focus", refresh);
      window.removeEventListener("agent-favorites-updated", refresh);
    };
  }, [identityKey, load, userId]);

  const toggleFavorite = useCallback(async (agentId: string) => {
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) throw new Error("缺少智能体标识");
    if (!userId || !token) throw new Error("请先登录，再保存收藏");
    if (!snapshotKnown.current) {
      const message = "收藏状态尚未读取完成，请先重试读取收藏";
      setError(message);
      setStatus("error");
      throw new Error(message);
    }
    if (pending.current.has(normalizedAgentId)) return;

    const requestIdentity = identityKey;
    const requestLifecycle = lifecycle.current;
    const removing = favoritesRef.current.has(normalizedAgentId);
    const operation: FavoriteOperation = {
      lifecycle: requestLifecycle,
      token: `${requestLifecycle}:${++operationSequence.current}:${normalizedAgentId}`,
    };
    const isCurrentOperation = () => (
      currentIdentity.current === requestIdentity
      && lifecycle.current === requestLifecycle
      && pendingOwners.current.get(normalizedAgentId)?.token === operation.token
    );

    pending.current.add(normalizedAgentId);
    pendingOwners.current.set(normalizedAgentId, operation);
    setPending();
    // Any GET that was already in flight is now stale. The final event below
    // starts a fresh read after this operation releases its lock.
    readSequence.current += 1;

    try {
      const response = await fetch(
        `/api/agent-favorites${removing ? `?agent_id=${encodeURIComponent(normalizedAgentId)}` : ""}`,
        {
          method: removing ? "DELETE" : "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(removing ? {} : { body: JSON.stringify({ agent_id: normalizedAgentId }) }),
        },
      );
      const data = await response.json() as { error?: unknown };
      if (!response.ok) throw new Error(String(data.error || "收藏尚未保存，请重试"));
      if (!isCurrentOperation()) return;

      setFavorites((current) => {
        const next = new Set(current);
        if (removing) next.delete(normalizedAgentId);
        else next.add(normalizedAgentId);
        favoritesRef.current = next;
        return next;
      });
      snapshotKnown.current = true;
      setLoaded(true);
      setStatus("ready");
      setError("");
    } catch (toggleError) {
      if (!isCurrentOperation()) return;
      setStatus("error");
      setError(toggleError instanceof Error ? toggleError.message : "收藏尚未保存，请重试");
      throw toggleError;
    } finally {
      // Only the operation that owns this agent may release its lock. An old
      // account/session response cannot clear a new account's pending state.
      if (pendingOwners.current.get(normalizedAgentId)?.token === operation.token) {
        pendingOwners.current.delete(normalizedAgentId);
        pending.current.delete(normalizedAgentId);
        setPending();
        if (currentIdentity.current === requestIdentity && lifecycle.current === requestLifecycle && pending.current.size === 0) {
          window.dispatchEvent(new Event("agent-favorites-updated"));
        }
      }
    }
  }, [identityKey, setPending, token, userId]);

  return {
    favorites,
    loaded,
    status,
    snapshotKnown: loaded,
    error,
    pending,
    pendingAgentIds,
    toggleFavorite,
    refresh: load,
  };
}
