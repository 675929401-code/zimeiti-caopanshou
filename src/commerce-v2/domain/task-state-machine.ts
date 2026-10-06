import type { ProductionTaskEvent, ProductionTaskState } from "./contracts";

const transitions: Record<ProductionTaskState, Partial<Record<ProductionTaskEvent, ProductionTaskState>>> = {
  draft: { plan: "planned", cancel: "cancelled" },
  planned: { quote: "quoted", cancel: "cancelled" },
  quoted: { confirm: "confirmed", quote: "quoted", cancel: "cancelled" },
  confirmed: { enqueue: "queued", cancel: "cancelled" },
  queued: { start: "running", provider_failed: "failed", dispatch_unknown: "unknown", cancel: "cancelled" },
  running: { provider_succeeded: "saving", provider_failed: "failed", dispatch_unknown: "unknown" },
  saving: { save_succeeded: "succeeded", save_failed: "save_failed" },
  succeeded: {},
  failed: { begin_refund: "refunding" },
  unknown: { provider_succeeded: "saving", provider_failed: "failed", begin_refund: "refunding" },
  save_failed: { retry_save: "saving", begin_refund: "refunding" },
  cancelled: { begin_refund: "refunding" },
  refunding: { refund_succeeded: "refunded" },
  refunded: {},
};

export function nextProductionTaskState(state: ProductionTaskState, event: ProductionTaskEvent) {
  const next = transitions[state][event];
  if (!next) throw new Error(`任务状态 ${state} 不允许事件 ${event}`);
  return next;
}

export function isProductionTaskTerminal(state: ProductionTaskState) {
  return ["succeeded", "refunded"].includes(state);
}

export function productionTaskCanRecover(state: ProductionTaskState) {
  return ["unknown", "save_failed", "failed", "refunding"].includes(state);
}
