"use client";

import { readBrowserWorkbenchIdentity, workbenchUserStorageKey } from "@/lib/workbench-user-storage";

export const YOUCAI_AGENT_PREFILL_STORAGE_KEY = "youcai_agent_prefill";
export const YOUCAI_AGENT_PREFILL_TTL_MS = 2 * 60 * 1_000;

const GUEST_POINTER_KEY = `${YOUCAI_AGENT_PREFILL_STORAGE_KEY}:guest-pointer:v1`;

type AgentPrefillEnvelope = {
  version: 1;
  ownerKind: "user" | "guest";
  ownerId: string;
  prompt: string;
  expiresAt: number;
};

type GuestPointer = { nonce: string; expiresAt: number };

function randomGuestNonce(): string {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function guestStorageKey(nonce: string): string {
  return `${YOUCAI_AGENT_PREFILL_STORAGE_KEY}:guest:${nonce}`;
}

function validExpiry(expiresAt: unknown, now: number): expiresAt is number {
  return typeof expiresAt === "number"
    && Number.isFinite(expiresAt)
    && expiresAt > now
    && expiresAt <= now + YOUCAI_AGENT_PREFILL_TTL_MS;
}

function clearLegacyPrefill(storage: Storage): void {
  storage.removeItem(YOUCAI_AGENT_PREFILL_STORAGE_KEY);
}

function clearPriorGuestPrefill(storage: Storage): void {
  const raw = storage.getItem(GUEST_POINTER_KEY);
  storage.removeItem(GUEST_POINTER_KEY);
  if (!raw) return;
  try {
    const pointer = JSON.parse(raw) as Partial<GuestPointer>;
    if (typeof pointer.nonce === "string" && /^[A-Za-z0-9-]{8,80}$/u.test(pointer.nonce)) {
      storage.removeItem(guestStorageKey(pointer.nonce));
    }
  } catch {
    // Invalid legacy pointers are deleted without deriving another key.
  }
}

export function storeYoucaiAgentPrefill(prompt: string): boolean {
  if (typeof window === "undefined") return false;
  const normalized = prompt.trim();
  if (!normalized) return true;
  const now = Date.now();
  const identity = readBrowserWorkbenchIdentity();
  try {
    clearLegacyPrefill(window.sessionStorage);
    clearPriorGuestPrefill(window.sessionStorage);
    let ownerKind: AgentPrefillEnvelope["ownerKind"] = "guest";
    let ownerId = randomGuestNonce();
    let storageKey = guestStorageKey(ownerId);
    if (identity) {
      ownerKind = "user";
      ownerId = identity.userId;
      storageKey = workbenchUserStorageKey(YOUCAI_AGENT_PREFILL_STORAGE_KEY, identity.userId);
    } else {
      const pointer: GuestPointer = { nonce: ownerId, expiresAt: now + YOUCAI_AGENT_PREFILL_TTL_MS };
      window.sessionStorage.setItem(GUEST_POINTER_KEY, JSON.stringify(pointer));
    }
    const envelope: AgentPrefillEnvelope = {
      version: 1,
      ownerKind,
      ownerId,
      prompt: normalized,
      expiresAt: now + YOUCAI_AGENT_PREFILL_TTL_MS,
    };
    window.sessionStorage.setItem(storageKey, JSON.stringify(envelope));
    return window.sessionStorage.getItem(storageKey) !== null;
  } catch {
    return false;
  }
}

export function consumeYoucaiAgentPrefill(): string {
  if (typeof window === "undefined") return "";
  const identity = readBrowserWorkbenchIdentity();
  const now = Date.now();
  try {
    clearLegacyPrefill(window.sessionStorage);
    const candidates: Array<{ key: string; ownerKind: AgentPrefillEnvelope["ownerKind"]; ownerId: string }> = [];
    if (identity) {
      candidates.push({
        key: workbenchUserStorageKey(YOUCAI_AGENT_PREFILL_STORAGE_KEY, identity.userId),
        ownerKind: "user",
        ownerId: identity.userId,
      });
    }

    const guestPointerRaw = window.sessionStorage.getItem(GUEST_POINTER_KEY);
    window.sessionStorage.removeItem(GUEST_POINTER_KEY);
    if (guestPointerRaw) {
      try {
        const pointer = JSON.parse(guestPointerRaw) as GuestPointer;
        if (typeof pointer?.nonce === "string" && pointer.nonce && validExpiry(pointer.expiresAt, now)) {
          candidates.push({ key: guestStorageKey(pointer.nonce), ownerKind: "guest", ownerId: pointer.nonce });
        }
      } catch {
        // Invalid guest pointers are discarded without recovering their content.
      }
    }

    for (const candidate of candidates) {
      const raw = window.sessionStorage.getItem(candidate.key);
      window.sessionStorage.removeItem(candidate.key);
      if (!raw) continue;
      try {
        const envelope = JSON.parse(raw) as AgentPrefillEnvelope;
        if (
          envelope?.version === 1
          && envelope.ownerKind === candidate.ownerKind
          && envelope.ownerId === candidate.ownerId
          && validExpiry(envelope.expiresAt, now)
          && typeof envelope.prompt === "string"
        ) return envelope.prompt.trim();
      } catch {
        // Read-once semantics also discard malformed envelopes.
      }
    }
    return "";
  } catch {
    return "";
  }
}
