"use client";

import {
  dispatchVideoTaskTransfer,
  makeVideoTaskTransferPayload,
  VIDEO_SMART_IMPORT_KEY,
} from "@/lib/video-task-transfer";
import { readBrowserWorkbenchIdentity, workbenchUserStorageKey } from "@/lib/workbench-user-storage";

export const YOUCAI_MUSIC_PREFILL_KEY = "youcai_music_brief_prefill_v1";
export const YOUCAI_VIDEO_PREFILL_KEY = VIDEO_SMART_IMPORT_KEY;
export const YOUCAI_PREFILL_TTL_MS = 2 * 60 * 1000;

interface YoucaiMusicPrefill {
  version: 1;
  ownerUserId: string;
  prompt: string;
  expiresAt: number;
}

export const YOUCAI_AGENT_WORKBENCH_ROUTES = {
  image: "/tools/image/image-chat",
  video: "/video",
  music: "/tools/audio/minimax-music",
} as const;

export type YoucaiAgentMediaSkill = keyof typeof YOUCAI_AGENT_WORKBENCH_ROUTES;

export function storeYoucaiMusicPrefill(prompt: string): boolean {
  if (typeof window === "undefined") return false;
  const normalized = prompt.trim();
  if (!normalized) return true;
  const identity = readBrowserWorkbenchIdentity();
  if (!identity) return false;
  const storageKey = workbenchUserStorageKey(YOUCAI_MUSIC_PREFILL_KEY, identity.userId);
  try {
    window.localStorage.removeItem(YOUCAI_MUSIC_PREFILL_KEY);
    window.sessionStorage.removeItem(YOUCAI_MUSIC_PREFILL_KEY);
    const payload: YoucaiMusicPrefill = {
      version: 1,
      ownerUserId: identity.userId,
      prompt: normalized,
      expiresAt: Date.now() + YOUCAI_PREFILL_TTL_MS,
    };
    window.sessionStorage.setItem(storageKey, JSON.stringify(payload));
    return window.sessionStorage.getItem(storageKey) !== null;
  } catch {
    return false;
  }
}

export function consumeYoucaiMusicPrefill(): string {
  if (typeof window === "undefined") return "";
  const identity = readBrowserWorkbenchIdentity();
  if (!identity) return "";
  const storageKey = workbenchUserStorageKey(YOUCAI_MUSIC_PREFILL_KEY, identity.userId);
  try {
    window.localStorage.removeItem(YOUCAI_MUSIC_PREFILL_KEY);
    window.sessionStorage.removeItem(YOUCAI_MUSIC_PREFILL_KEY);
    const raw = window.sessionStorage.getItem(storageKey);
    window.sessionStorage.removeItem(storageKey);
    if (!raw) return "";
    const value = JSON.parse(raw) as YoucaiMusicPrefill;
    const now = Date.now();
    if (value?.version !== 1 || value.ownerUserId !== identity.userId || value.expiresAt <= now || value.expiresAt > now + YOUCAI_PREFILL_TTL_MS) return "";
    return typeof value.prompt === "string" ? value.prompt.trim() : "";
  } catch {
    return "";
  }
}

export function storeYoucaiVideoPrefill(prompt: string): boolean {
  if (typeof window === "undefined") return false;
  const normalized = prompt.trim();
  if (!normalized) return true;
  return dispatchVideoTaskTransfer(makeVideoTaskTransferPayload([{
    order: 1,
    prompt: normalized,
    label: "任务1",
    title: "来自创作 Agent",
    source: "manual",
  }], "single"));
}
