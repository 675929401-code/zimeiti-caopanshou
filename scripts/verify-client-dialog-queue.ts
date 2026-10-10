import assert from "node:assert/strict";
import {
  APP_DIALOG_PRIORITY,
  APP_TOAST_PRIORITY,
  claimAppDialog,
  claimAppToast,
  currentAppDialogOwner,
  currentAppDialogPriority,
  currentAppToastOwner,
  currentAppToastPriority,
  releaseAppDialog,
  releaseAppToast,
} from "../src/lib/client-dialog-queue";

const attributes = new Map<string, string>();
const events: Array<{ type: string; detail: unknown }> = [];

class TestCustomEvent<T = unknown> {
  readonly type: string;
  readonly detail: T;

  constructor(type: string, init?: { detail?: T }) {
    this.type = type;
    this.detail = init?.detail as T;
  }
}

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    },
  },
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    dispatchEvent: (event: TestCustomEvent) => {
      events.push({ type: event.type, detail: event.detail });
      return true;
    },
  },
});
Object.defineProperty(globalThis, "CustomEvent", {
  configurable: true,
  value: TestCustomEvent,
});

assert.equal(claimAppDialog("trial"), true);
assert.equal(currentAppDialogOwner(), "trial");
assert.equal(currentAppDialogPriority(), APP_DIALOG_PRIORITY.trial);

assert.equal(claimAppDialog("announcement"), true, "P3 announcement must preempt P4 trial");
assert.equal(currentAppDialogOwner(), "announcement");
assert.equal(claimAppDialog("trial"), false, "P4 trial must defer behind P3 announcement");

assert.equal(
  claimAppDialog("announcement", APP_DIALOG_PRIORITY.announcementUrgent),
  true,
  "the current announcement owner can raise itself from P3 to P2",
);
assert.equal(currentAppDialogPriority(), APP_DIALOG_PRIORITY.announcementUrgent);
assert.equal(
  claimAppDialog("announcement"),
  true,
  "a same-owner ordinary claim remains compatible",
);
assert.equal(currentAppDialogPriority(), APP_DIALOG_PRIORITY.announcementUrgent, "same-owner calls cannot lower active priority");

assert.equal(claimAppDialog("account"), true, "P1 account assets must preempt P2 urgent announcements");
assert.equal(currentAppDialogOwner(), "account");
assert.equal(
  claimAppDialog("announcement", APP_DIALOG_PRIORITY.announcementUrgent),
  false,
  "P2 announcement must defer behind P1 account assets",
);

assert.equal(claimAppDialog("security"), true, "P0 security must preempt every notification dialog");
assert.equal(currentAppDialogOwner(), "security");
assert.equal(claimAppDialog("account"), false, "P1 account dialog must defer behind P0 security");
releaseAppDialog("account");
assert.equal(currentAppDialogOwner(), "security", "a non-owner cannot release the active dialog");
releaseAppDialog("security");
assert.equal(currentAppDialogOwner(), null);
assert.equal(currentAppDialogPriority(), null);

assert.equal(claimAppDialog("forced-logout"), true);
assert.equal(currentAppDialogPriority(), 0);
releaseAppDialog("forced-logout");
assert.ok(events.some((event) => event.type === "app-dialog-claimed"));
assert.ok(events.some((event) => event.type === "app-dialog-released"));

assert.equal(claimAppToast("announcement", APP_TOAST_PRIORITY.announcement), true);
assert.equal(currentAppToastOwner(), "announcement");
assert.equal(currentAppToastPriority(), APP_TOAST_PRIORITY.announcement);
assert.equal(claimAppToast("account", APP_TOAST_PRIORITY.account), true, "account toast preempts ordinary announcement");
assert.equal(claimAppToast("announcement", APP_TOAST_PRIORITY.announcement), false, "ordinary announcement remains queued");
assert.equal(
  claimAppToast("announcement", APP_TOAST_PRIORITY.announcementUrgent),
  true,
  "urgent announcement preempts account toast",
);
assert.equal(currentAppToastOwner(), "announcement");
releaseAppToast("account");
assert.equal(currentAppToastOwner(), "announcement", "a non-owner cannot release the active toast");
releaseAppToast("announcement");
assert.equal(currentAppToastOwner(), null);
assert.equal(currentAppToastPriority(), null);
assert.ok(events.some((event) => event.type === "app-toast-claimed"));
assert.ok(events.some((event) => event.type === "app-toast-released"));

console.log("client dialog and toast priority queue verification passed");
