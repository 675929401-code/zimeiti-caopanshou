"use client";

import { StoryboardLocalVideoSession } from "./storyboard-local-video-cache";
import { recordOfflineTask } from "./media-history-offline-auth";
import type { VideoHistorySurface } from "./video-history-policy";

const TASK_ID = /^[a-zA-Z0-9_-]{8,128}$/u;
const MAX_IDS = 10_000;
const LOCAL_EVENT = "platform-video-history-removed";
const LOCAL_PENDING_EVENT = "platform-video-history-removal-pending";

type RemovalSession = Pick<StoryboardLocalVideoSession, "applyTombstones" | "dispose">;
type RemovalSessionFactory = (userId: string, token: string, fetcher: typeof fetch, surface: VideoHistorySurface) => RemovalSession;
export type RemovalPublishResult = "synced" | "local_only" | "local_failed" | "invalid";

function scopedKey(userId: string, surface: VideoHistorySurface): string | null {
  if (!userId || userId.trim() !== userId || userId.length > 128 ||
      (surface !== "storyboard-workbench" && surface !== "video-page")) return null;
  return `video-history-changed:${surface}:${userId}`;
}

function validatedIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_IDS ||
      value.some(id => typeof id !== "string" || !TASK_ID.test(id))) return null;
  return [...new Set(value as string[])];
}

function payloadIds(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return validatedIds((value as { ids?: unknown }).ids);
}

/** Existing legacy history panels publish {ids} on this account/surface key. */
export function subscribeVideoHistoryRemovals(userId: string, surface: VideoHistorySurface, onRemoved: (ids: string[]) => void, onPending?: (ids: string[]) => void): () => void {
  const key = scopedKey(userId, surface);
  if (!key || typeof window === "undefined") return () => {};
  let active = true;
  const deliver = (payload: unknown) => {
    const ids = payloadIds(payload);
    if (active && ids) onRemoved(ids);
  };
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object" || (detail as { key?: unknown }).key !== key) return;
    deliver(detail);
  };
  const onLocalPending = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!active || !detail || typeof detail !== "object" || (detail as { key?: unknown }).key !== key) return;
    const ids = payloadIds(detail);
    if (ids) onPending?.(ids);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key || !event.newValue || event.newValue.length > 1_500_000) return;
    try { deliver(JSON.parse(event.newValue)); } catch { /* Ignore malformed external signals. */ }
  };
  window.addEventListener(LOCAL_EVENT, onLocal);
  window.addEventListener(LOCAL_PENDING_EVENT, onLocalPending);
  window.addEventListener("storage", onStorage);
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(key);
      channel.onmessage = event => deliver(event.data);
    }
  } catch { /* Storage events remain a fallback. */ }
  return () => {
    if (!active) return;
    active = false;
    window.removeEventListener(LOCAL_EVENT, onLocal);
    window.removeEventListener(LOCAL_PENDING_EVENT, onLocalPending);
    window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}

/**
 * Call only after this account's server has confirmed removal. Local markers
 * must be durable before a success signal is delivered to any other context.
 * No credential is written to the signal, the browser storage key or payload.
 */
export async function publishVideoHistoryRemoval(options: {
  userId: string;
  token: string;
  surface: VideoHistorySurface;
  taskIds: readonly string[];
  fetcher?: typeof fetch;
  sessionFactory?: RemovalSessionFactory;
}): Promise<RemovalPublishResult> {
  const key = scopedKey(options.userId, options.surface);
  const ids = validatedIds(options.taskIds);
  if (!key || !ids || !options.token || options.token.trim() !== options.token) return "invalid";
  // This function is called only after the server confirms the deletion. A
  // failure to write local tombstones must never leave an old offline grant.
  const revocations = Promise.all(ids.map(id => recordOfflineTask(options.userId, options.token, id, true)));
  // Block same-document work immediately, including when local storage fails.
  // This is deliberately local only; cross-tab success is sent after commit.
  if (typeof window !== "undefined") {
    try { window.dispatchEvent(new CustomEvent(LOCAL_PENDING_EVENT, { detail: { key, ids } })); } catch { /* The result still reports persistence failure. */ }
  }
  let session: RemovalSession | null = null;
  try {
    const factory = options.sessionFactory || ((userId, token, fetcher, surface) => new StoryboardLocalVideoSession(userId, token, fetcher, surface));
    session = factory(options.userId, options.token, options.fetcher || fetch, options.surface);
    await session.applyTombstones(ids);
  } catch { await revocations; return "local_failed"; }
  finally { try { session?.dispose(); } catch { /* Marker result is unchanged by cleanup failure. */ } }

  await revocations;

  const payload = { ids, at: Date.now() };
  if (typeof window === "undefined") return "local_only";
  try { window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: { key, ...payload } })); } catch { /* Another context may still receive a broadcast. */ }
  let sent = false;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(key);
      try { channel.postMessage(payload); sent = true; } finally { channel.close(); }
    }
  } catch { /* Storage events remain a fallback. */ }
  try { window.localStorage.setItem(key, JSON.stringify(payload)); sent = true; } catch { /* Private mode may disable storage. */ }
  return sent ? "synced" : "local_only";
}
