"use client";

export type AppDialogOwner = "security" | "forced-logout" | "account" | "announcement" | "trial";
export type AppDialogPriority = 0 | 1 | 2 | 3 | 4;

export const APP_DIALOG_PRIORITY = {
  security: 0,
  "forced-logout": 0,
  account: 1,
  announcementUrgent: 2,
  announcement: 3,
  trial: 4,
} as const satisfies Record<string, AppDialogPriority>;

const OWNER_ATTRIBUTE = "data-app-dialog-owner";
const PRIORITY_ATTRIBUTE = "data-app-dialog-priority";
export const APP_DIALOG_CLAIMED_EVENT = "app-dialog-claimed";
export const APP_DIALOG_RELEASED_EVENT = "app-dialog-released";

function isAppDialogOwner(value: string | null): value is AppDialogOwner {
  return value === "security"
    || value === "forced-logout"
    || value === "account"
    || value === "announcement"
    || value === "trial";
}

export function defaultAppDialogPriority(owner: AppDialogOwner): AppDialogPriority {
  if (owner === "security" || owner === "forced-logout") return APP_DIALOG_PRIORITY.security;
  if (owner === "account") return APP_DIALOG_PRIORITY.account;
  if (owner === "announcement") return APP_DIALOG_PRIORITY.announcement;
  return APP_DIALOG_PRIORITY.trial;
}

export function currentAppDialogOwner(): AppDialogOwner | null {
  if (typeof document === "undefined") return null;
  const value = document.documentElement.getAttribute(OWNER_ATTRIBUTE);
  return isAppDialogOwner(value) ? value : null;
}

export function currentAppDialogPriority(): AppDialogPriority | null {
  if (typeof document === "undefined") return null;
  const owner = currentAppDialogOwner();
  if (!owner) return null;
  const value = Number(document.documentElement.getAttribute(PRIORITY_ATTRIBUTE));
  return Number.isInteger(value) && value >= 0 && value <= 4
    ? value as AppDialogPriority
    : defaultAppDialogPriority(owner);
}

/**
 * Claims the single global dialog surface. Lower numeric priorities win:
 * P0 security/forced logout, P1 account assets, P2 urgent announcement,
 * P3 ordinary announcement, P4 trial guidance. Existing one-argument callers
 * retain their previous owner defaults.
 */
export function claimAppDialog(
  owner: AppDialogOwner,
  requestedPriority: AppDialogPriority = defaultAppDialogPriority(owner),
): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const previous = currentAppDialogOwner();
  const previousPriority = currentAppDialogPriority();
  const priority = Math.max(0, Math.min(4, Math.trunc(requestedPriority))) as AppDialogPriority;

  if (previous && previous !== owner && previousPriority !== null && priority >= previousPriority) {
    return false;
  }

  const effectivePriority = previous === owner && previousPriority !== null
    ? Math.min(previousPriority, priority) as AppDialogPriority
    : priority;
  document.documentElement.setAttribute(OWNER_ATTRIBUTE, owner);
  document.documentElement.setAttribute(PRIORITY_ATTRIBUTE, String(effectivePriority));
  if (previous !== owner) {
    window.dispatchEvent(new CustomEvent(APP_DIALOG_CLAIMED_EVENT, {
      detail: { owner, priority: effectivePriority, previous, previousPriority },
    }));
  }
  return true;
}

export function releaseAppDialog(owner: AppDialogOwner): void {
  if (typeof window === "undefined" || currentAppDialogOwner() !== owner) return;
  const priority = currentAppDialogPriority();
  document.documentElement.removeAttribute(OWNER_ATTRIBUTE);
  document.documentElement.removeAttribute(PRIORITY_ATTRIBUTE);
  window.dispatchEvent(new CustomEvent(APP_DIALOG_RELEASED_EVENT, { detail: { owner, priority } }));
}
