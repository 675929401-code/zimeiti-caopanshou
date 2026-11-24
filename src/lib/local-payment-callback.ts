import { randomUUID } from "node:crypto";
import { request } from "node:https";
import { safeFetchJsonPost } from "@/lib/safe-fetch";

// The single-process local preview and the public site use separate order books.
const state = globalThis as typeof globalThis & { localPaymentProbes?: Set<string> };
const awaiting = state.localPaymentProbes ??= new Set<string>();
const header = "x-local-payment-route-check";
const previewNotifyUrl = "https://zyuani8.com/__preview-payment/notify";

// The desktop proxy can return a reserved address for the merchant hostname.
// This loopback port is an SSH forward to the public TLS listener on the project host.
function probeThroughMerchantTls(nonce: string): Promise<boolean> {
  const url = new URL(previewNotifyUrl);
  return new Promise(resolve => {
    const check = request({
      host: "127.0.0.1", port: 19573, servername: url.hostname, rejectUnauthorized: true,
      method: "POST", path: url.pathname, agent: false, signal: AbortSignal.timeout(5000),
      headers: { host: url.hostname, [header]: nonce, "content-type": "application/json", "content-length": 2 },
    }, response => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("error", () => resolve(false));
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024) { response.destroy(); resolve(false); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(response.statusCode === 200 && JSON.parse(Buffer.concat(chunks).toString("utf8")).received === true); }
        catch { resolve(false); }
      });
    });
    check.on("error", () => resolve(false));
    check.end("{}");
  });
}

export function localCallbackProbe(request: Request): Response | null {
  const nonce = request.headers.get(header);
  if (process.env.LOCAL_ACCEPTANCE_PREVIEW !== "true" || !nonce) return null;
  const received = awaiting.delete(nonce);
  return Response.json({ received }, { status: received ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}

export async function callbackReachesLocalOrders(notifyUrl: string): Promise<boolean> {
  if (process.env.LOCAL_ACCEPTANCE_PREVIEW !== "true") return true;
  if (notifyUrl !== previewNotifyUrl) return false;
  const nonce = randomUUID();
  awaiting.add(nonce);
  try {
    if (await probeThroughMerchantTls(nonce)) return !awaiting.has(nonce);
    const response = await safeFetchJsonPost<{ received?: boolean }>(notifyUrl, "{}", {
      headers: { [header]: nonce }, timeoutMs: 5000, maxBytes: 1024,
    });
    return response.json?.received === true && !awaiting.has(nonce);
  } catch {
    return false;
  } finally {
    awaiting.delete(nonce);
  }
}
