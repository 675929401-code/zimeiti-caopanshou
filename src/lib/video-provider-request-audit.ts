import { AsyncLocalStorage } from "node:async_hooks";

export type VideoProviderRequestReceipt = {
  endpointHost: string;
  submittedModel: string | null;
  submittedWorkflow: string | null;
};

type Audit = (receipt: VideoProviderRequestReceipt) => Promise<void>;
const audits = new AsyncLocalStorage<Audit>();

export function withVideoProviderRequestAudit<T>(audit: Audit | undefined, work: () => Promise<T>): Promise<T> {
  return audit ? audits.run(audit, work) : work();
}

/** A small allowlist of routing fields from the actual request, never its content or credentials. */
export function videoProviderRequestReceipt(input: string | URL | Request, init?: RequestInit): VideoProviderRequestReceipt | null {
  if (String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase() !== "POST") return null;
  let url: URL;
  try { url = new URL(input instanceof Request ? input.url : input.toString()); } catch { return null; }
  const safeId = (value: unknown) => typeof value === "string" && /^[\p{L}\p{N}_.:/ -]{1,160}$/u.test(value) && !value.includes("://") ? value : null;
  let model: unknown;
  if (typeof init?.body === "string") {
    try { const body = JSON.parse(init.body); model = body.model ?? body.model_name ?? (url.hostname === 'visual.volcengineapi.com' && ['RealmanChangeLipsSubmitTask', 'CVSubmitTask'].includes(url.searchParams.get('Action') || '') ? body.req_key : undefined); } catch { /* Opaque bodies are never recorded. */ }
  } else if (init?.body instanceof FormData) model = init.body.get("model") || init.body.get("model_name");
  const submittedModel = safeId(model);
  const submittedWorkflow = safeId(url.pathname.match(/\/comfyui\/comfyui_workflow\/([a-zA-Z0-9_]+)\/?$/u)?.[1]);
  // A POST without an explicit model field is still a real provider dispatch
  // (several task/cancel/workflow protocols encode identity in the path). The
  // caller needs this fact to distinguish a local preflight failure from an
  // ambiguous network outcome without recording request contents.
  return { endpointHost: url.host, submittedModel, submittedWorkflow };
}

export async function videoProviderFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const audit = audits.getStore();
  const receipt = audit ? videoProviderRequestReceipt(input, init) : null;
  if (audit && receipt) {
    // This callback is the durable before-dispatch barrier. Swallowing its
    // failure would let the provider accept a paid task while our database has
    // no evidence, making a later timeout look safe to resubmit.
    await audit(receipt);
  }
  return globalThis.fetch(input, init);
}
