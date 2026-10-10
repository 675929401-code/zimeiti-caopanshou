"use client";

export type AppDialogOwner = "security" | "forced-logout" | "account" | "announcement" | "trial";
export type AppDialogPriority = 0 | 1 | 2 | 3 | 4;
export type AppToastOwner = "account" | "announcement";
export type AppToastPriority = 0 | 1 | 2;

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
const TOAST_OWNER_ATTRIBUTE = "data-app-toast-owner";
const TOAST_PRIORITY_ATTRIBUTE = "data-app-toast-priority";
export const APP_TOAST_CLAIMED_EVENT = "app-toast-claimed";
export const APP_TOAST_RELEASED_EVENT = "app-toast-released";
export const APP_TOAST_PRIORITY = {
  announcementUrgent: 0,
  account: 1,
  announcement: 2,
} as const satisfies Record<string, AppToastPriority>;

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

function isAppToastOwner(value: string | null): value is AppToastOwner {
  return value === "account" || value === "announcement";
}

export function currentAppToastOwner(): AppToastOwner | null {
  if (typeof document === "undefined") return null;
  const value = document.documentElement.getAttribute(TOAST_OWNER_ATTRIBUTE);
  return isAppToastOwner(value) ? value : null;
}

export function currentAppToastPriority(): AppToastPriority | null {
  if (typeof document === "undefined") return null;
  const owner = currentAppToastOwner();
  if (!owner) return null;
  const value = Number(document.documentElement.getAttribute(TOAST_PRIORITY_ATTRIBUTE));
  if (Number.isInteger(value) && value >= 0 && value <= 2) return value as AppToastPriority;
  return owner === "account" ? APP_TOAST_PRIORITY.account : APP_TOAST_PRIORITY.announcement;
}

/**
 * Owns the single bottom-right notification surface. A losing notification
 * keeps its local pending item and retries after APP_TOAST_RELEASED_EVENT, so
 * simultaneous account and announcement deliveries cannot overlap or vanish.
 */
export function claimAppToast(owner: AppToastOwner, requestedPriority: AppToastPriority): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const previous = currentAppToastOwner();
  const previousPriority = currentAppToastPriority();
  const priority = Math.max(0, Math.min(2, Math.trunc(requestedPriority))) as AppToastPriority;

  if (previous && previous !== owner && previousPriority !== null && priority >= previousPriority) {
    return false;
  }

  document.documentElement.setAttribute(TOAST_OWNER_ATTRIBUTE, owner);
  document.documentElement.setAttribute(TOAST_PRIORITY_ATTRIBUTE, String(priority));
  if (previous !== owner) {
    window.dispatchEvent(new CustomEvent(APP_TOAST_CLAIMED_EVENT, {
      detail: { owner, priority, previous, previousPriority },
    }));
  }
  return true;
}

export function releaseAppToast(owner: AppToastOwner): void {
  if (typeof window === "undefined" || currentAppToastOwner() !== owner) return;
  const priority = currentAppToastPriority();
  document.documentElement.removeAttribute(TOAST_OWNER_ATTRIBUTE);
  document.documentElement.removeAttribute(TOAST_PRIORITY_ATTRIBUTE);
  window.dispatchEvent(new CustomEvent(APP_TOAST_RELEASED_EVENT, { detail: { owner, priority } }));
}
