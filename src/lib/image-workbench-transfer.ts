"use client";

import { readBrowserWorkbenchIdentity, workbenchUserStorageKey } from "@/lib/workbench-user-storage";

export const IMAGE_WORKBENCH_TRANSFER_KEY = "agent_hub_image_workbench_transfer_v1";
export const IMAGE_WORKBENCH_TRANSFER_SESSION_KEY = "agent_hub_image_workbench_transfer_session_v1";
export const IMAGE_WORKBENCH_TRANSFER_EVENT = "agent-hub-image-workbench-transfer";
export const IMAGE_WORKBENCH_TRANSFER_CHANNEL = "agent-hub-image-workbench-transfer-channel";
export const IMAGE_WORKBENCH_TRANSFER_TTL_MS = 2 * 60 * 1_000;

export interface ImageWorkbenchPromptTransferItem {
  id: string;
  prompt: string;
  createdAt: number;
  source: "chat-code";
}

export interface ImageWorkbenchPromptTransferPayload {
  version: 1;
  ownerUserId?: string;
  items: ImageWorkbenchPromptTransferItem[];
  createdAt: number;
}

function isPayload(value: unknown): value is ImageWorkbenchPromptTransferPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as ImageWorkbenchPromptTransferPayload;
  return payload.version === 1 && Array.isArray(payload.items) && payload.items.every((item) =>
    typeof item?.id === "string" &&
    typeof item?.prompt === "string" &&
    typeof item?.createdAt === "number" &&
    item?.source === "chat-code"
  );
}

function clearRetiredImageTransferKeys(identityUserId: string): void {
  for (const storage of [window.sessionStorage, window.localStorage]) {
    for (const key of [
      IMAGE_WORKBENCH_TRANSFER_KEY,
      IMAGE_WORKBENCH_TRANSFER_SESSION_KEY,
      workbenchUserStorageKey(IMAGE_WORKBENCH_TRANSFER_KEY, identityUserId),
    ]) {
      try { storage.removeItem(key); } catch { /* Retired prompt bytes are never restored. */ }
    }
  }
}

export function readPendingImageWorkbenchPromptTransfer(): ImageWorkbenchPromptTransferPayload | null {
  if (typeof window === "undefined") return null;
  const identity = readBrowserWorkbenchIdentity();
  if (!identity) return null;
  const sessionKey = workbenchUserStorageKey(IMAGE_WORKBENCH_TRANSFER_SESSION_KEY, identity.userId);
  try {
    clearRetiredImageTransferKeys(identity.userId);
    const raw = window.sessionStorage.getItem(sessionKey);
    if (!raw) return null;
    // Delete before parsing so malformed data, render errors, and refreshes
    // cannot replay creative text.
    window.sessionStorage.removeItem(sessionKey);
    const payload = JSON.parse(raw) as unknown;
    const ageMs = isPayload(payload) ? Date.now() - payload.createdAt : Number.NaN;
    if (!isPayload(payload) || payload.ownerUserId !== identity.userId
      || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > IMAGE_WORKBENCH_TRANSFER_TTL_MS) {
      return null;
    }
    return payload;
  } catch {
    try {
      window.sessionStorage.removeItem(sessionKey);
      clearRetiredImageTransferKeys(identity.userId);
    } catch { /* An unavailable browser store cannot be used as a draft source. */ }
    return null;
  }
}

export function clearPendingImageWorkbenchPromptTransfer() {
  if (typeof window !== "undefined") {
    const identity = readBrowserWorkbenchIdentity();
    if (!identity) return;
    window.sessionStorage.removeItem(workbenchUserStorageKey(IMAGE_WORKBENCH_TRANSFER_SESSION_KEY, identity.userId));
    clearRetiredImageTransferKeys(identity.userId);
  }
}

export function appendImageWorkbenchPromptTransfer(prompt: string): ImageWorkbenchPromptTransferPayload | null {
  const cleanPrompt = prompt.trim();
  if (typeof window === "undefined" || !cleanPrompt) return null;
  const identity = readBrowserWorkbenchIdentity();
  if (!identity) return null;

  const now = Date.now();
  const current = readPendingImageWorkbenchPromptTransfer();
  const item: ImageWorkbenchPromptTransferItem = {
    id: `image-prompt-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    prompt: cleanPrompt,
    createdAt: now,
    source: "chat-code",
  };
  const payload: ImageWorkbenchPromptTransferPayload = {
    version: 1,
    ownerUserId: identity.userId,
    items: [...(current?.items || []), item],
    createdAt: now,
  };

  const serializedPayload = JSON.stringify(payload);
  window.sessionStorage.setItem(workbenchUserStorageKey(IMAGE_WORKBENCH_TRANSFER_SESSION_KEY, identity.userId), serializedPayload);
  clearRetiredImageTransferKeys(identity.userId);
  window.dispatchEvent(new CustomEvent(IMAGE_WORKBENCH_TRANSFER_EVENT, { detail: payload }));
  try {
    const channel = new BroadcastChannel(IMAGE_WORKBENCH_TRANSFER_CHANNEL);
    channel.postMessage(payload);
    channel.close();
  } catch {
    // sessionStorage + same-window CustomEvent remain the compatibility fallback.
  }
  return payload;
}

export function parseImageWorkbenchPromptTransfer(value: string | null): ImageWorkbenchPromptTransferPayload | null {
  if (!value) return null;
  try {
    const payload = JSON.parse(value) as unknown;
    const ageMs = isPayload(payload) ? Date.now() - payload.createdAt : Number.NaN;
    if (!isPayload(payload) || !Number.isFinite(ageMs)
      || ageMs < 0 || ageMs > IMAGE_WORKBENCH_TRANSFER_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}
