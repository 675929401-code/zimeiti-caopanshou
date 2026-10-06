"use client";

import { readBrowserWorkbenchIdentity, workbenchUserStorageKey } from "@/lib/workbench-user-storage";

export const VIDEO_WORKFLOW_DRAFT_KEY = "agent_hub_video_workflow_draft_v1";
export const VIDEO_WORKFLOW_DRAFT_EVENT = "agent-hub-video-workflow-draft";
export const VIDEO_WORKFLOW_DRAFT_TTL_MS = 2 * 60 * 1000;
export const VIDEO_WORKFLOW_MAX_TASKS = 40;

export type VideoWorkflowImageMode = "reference" | "first-last";
export type VideoWorkflowImageTarget = "reference" | "first-frame" | "last-frame";
export type VideoWorkflowPromptKind = "video" | "image";

export interface VideoWorkflowSlot {
  order: number;
  prompt?: string;
  promptKind?: VideoWorkflowPromptKind;
  label?: string;
  title?: string;
  referenceImageUrl?: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  updatedAt: number;
}

export interface VideoWorkflowDraft {
  version: 1;
  ownerUserId?: string;
  imageMode: VideoWorkflowImageMode;
  slots: VideoWorkflowSlot[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface VideoWorkflowDraftUpdate {
  order: number;
  prompt?: string;
  promptKind?: VideoWorkflowPromptKind;
  label?: string;
  title?: string;
  imageUrl?: string;
  imageTarget?: VideoWorkflowImageTarget;
  clearPrompt?: boolean;
  clearImageTarget?: VideoWorkflowImageTarget;
}

function normalizeOrder(value: unknown, fallback = 1) {
  const order = Number(value);
  if (!Number.isFinite(order)) return fallback;
  return Math.min(VIDEO_WORKFLOW_MAX_TASKS, Math.max(1, Math.floor(order)));
}

function isImageMode(value: unknown): value is VideoWorkflowImageMode {
  return value === "reference" || value === "first-last";
}

function isDraft(value: unknown): value is VideoWorkflowDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as VideoWorkflowDraft;
  return draft.version === 1 &&
    isImageMode(draft.imageMode) &&
    typeof draft.createdAt === "number" &&
    typeof draft.updatedAt === "number" &&
    typeof draft.expiresAt === "number" &&
    Array.isArray(draft.slots) &&
    draft.slots.every((slot) => typeof slot?.order === "number" && typeof slot?.updatedAt === "number");
}

export function clearLegacyVideoWorkflowDraft(): void {
  if (typeof window === "undefined") return;
  const identity = readBrowserWorkbenchIdentity();
  try {
    window.localStorage.removeItem(VIDEO_WORKFLOW_DRAFT_KEY);
    window.sessionStorage.removeItem(VIDEO_WORKFLOW_DRAFT_KEY);
    if (identity) {
      window.localStorage.removeItem(workbenchUserStorageKey(VIDEO_WORKFLOW_DRAFT_KEY, identity.userId));
    }
  } catch {
    // Legacy cleanup must not block an explicit handoff.
  }
}

export function readVideoWorkflowDraft(): VideoWorkflowDraft | null {
  if (typeof window === "undefined") return null;
  const identity = readBrowserWorkbenchIdentity();
  if (!identity) return null;
  clearLegacyVideoWorkflowDraft();
  const storageKey = workbenchUserStorageKey(VIDEO_WORKFLOW_DRAFT_KEY, identity.userId);
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const draft = JSON.parse(raw) as unknown;
    if (!isDraft(draft) || draft.ownerUserId !== identity.userId) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    const now = Date.now();
    if (draft.expiresAt <= now || draft.expiresAt > now + VIDEO_WORKFLOW_DRAFT_TTL_MS) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function clearVideoWorkflowDraft() {
  if (typeof window !== "undefined") {
    const identity = readBrowserWorkbenchIdentity();
    if (identity) window.sessionStorage.removeItem(workbenchUserStorageKey(VIDEO_WORKFLOW_DRAFT_KEY, identity.userId));
    clearLegacyVideoWorkflowDraft();
  }
}

export function mergeVideoWorkflowDraft(
  updates: VideoWorkflowDraftUpdate[],
  imageMode?: VideoWorkflowImageMode,
): VideoWorkflowDraft | null {
  if (typeof window === "undefined") return null;
  const identity = readBrowserWorkbenchIdentity();
  if (!identity) return null;
  const validUpdates = updates.filter((item) => item.prompt?.trim() || item.imageUrl || item.clearPrompt || item.clearImageTarget);
  if (validUpdates.length === 0) return readVideoWorkflowDraft();

  const previous = readVideoWorkflowDraft();
  const now = Date.now();
  const slots = new Map<number, VideoWorkflowSlot>();
  for (const slot of previous?.slots || []) slots.set(slot.order, { ...slot });

  for (const update of validUpdates) {
    const order = normalizeOrder(update.order, slots.size + 1);
    const current = slots.get(order) || { order, updatedAt: now };
    const next: VideoWorkflowSlot = { ...current, updatedAt: now };
    if (update.clearPrompt) {
      delete next.prompt;
      delete next.promptKind;
    }
    if (update.clearImageTarget === "reference") delete next.referenceImageUrl;
    if (update.clearImageTarget === "first-frame") delete next.firstFrameUrl;
    if (update.clearImageTarget === "last-frame") delete next.lastFrameUrl;
    if (update.prompt?.trim() && (update.promptKind === "video" || !next.prompt || next.promptKind !== "video")) {
      next.prompt = update.prompt.trim();
      next.promptKind = update.promptKind || "video";
    }
    if (update.label) next.label = update.label;
    if (update.title) next.title = update.title;
    if (update.imageUrl) {
      const target = update.imageTarget || "reference";
      if (target === "reference") next.referenceImageUrl = update.imageUrl;
      if (target === "first-frame") next.firstFrameUrl = update.imageUrl;
      if (target === "last-frame") next.lastFrameUrl = update.imageUrl;
    }
    slots.set(order, next);
  }

  const draft: VideoWorkflowDraft = {
    version: 1,
    ownerUserId: identity.userId,
    imageMode: imageMode || previous?.imageMode || "reference",
    slots: Array.from(slots.values()).sort((left, right) => left.order - right.order),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    expiresAt: now + VIDEO_WORKFLOW_DRAFT_TTL_MS,
  };
  try {
    window.sessionStorage.setItem(workbenchUserStorageKey(VIDEO_WORKFLOW_DRAFT_KEY, identity.userId), JSON.stringify(draft));
    window.dispatchEvent(new CustomEvent(VIDEO_WORKFLOW_DRAFT_EVENT, { detail: draft }));
    return draft;
  } catch {
    return null;
  }
}
