const signalKey = "wallet-settlement-refresh.v1";
const checkoutReloadKey = "payment-checkout-on-reload.v1";

export type PaymentWallet = { userId: string; credits: number; cashBalance: number };

// Keep an open checkout watching its order even when payment or delivery is slow.
export function paymentPollDelay(startedAt: number) {
  return Date.now() - startedAt < 10 * 60_000 ? 5_000 : 30_000;
}

// Retain only the order reference when a tab leaves an open cashier. The
// authenticated result page reads both payment and wallet state from the server.
export function watchCheckoutReload(orderId: string) {
  const token = localStorage.getItem("auth_token") || "";
  const userId = currentUserId(token);
  const page = location.pathname + location.search;
  const remember = (event: PageTransitionEvent) => {
    if (event.persisted || !userId || currentUserId(token) !== userId) return;
    try {
      sessionStorage.setItem(checkoutReloadKey, JSON.stringify({ userId, orderId, page, time: Date.now() }));
    } catch { /* Storage can be disabled. The order remains in the member's records. */ }
  };
  window.addEventListener("pagehide", remember);
  return () => window.removeEventListener("pagehide", remember);
}

export function consumeReloadedCheckout(userId: string): string | null {
  try {
    const raw = sessionStorage.getItem(checkoutReloadKey);
    if (!raw) return null;
    sessionStorage.removeItem(checkoutReloadKey);
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const saved = JSON.parse(raw);
    if (navigation?.type === "reload" && saved?.userId === userId
      && saved.page === location.pathname + location.search
      && typeof saved.orderId === "string" && /^[A-Za-z0-9_-]{1,160}$/u.test(saved.orderId)
      && Number.isFinite(saved.time) && Date.now() - saved.time >= 0 && Date.now() - saved.time < 30 * 60_000) return saved.orderId;
  } catch { /* A missing browser record never changes settlement. */ }
  return null;
}

function currentUserId(token: string): string | null {
  if (!token || localStorage.getItem("auth_token") !== token) return null;
  try { return JSON.parse(localStorage.getItem("auth_user") || "null")?.id || null; }
  catch { return null; }
}

let pending: { token: string; userId: string; request: Promise<PaymentWallet | null> } | undefined;

export function readPaymentWallet(token: string): Promise<PaymentWallet | null> {
  const userId = currentUserId(token);
  if (!userId) return Promise.resolve(null);
  if (pending?.token === token && pending.userId === userId) return pending.request;
  const request = (async () => {
    const response = await fetch(`/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`, {
      cache: "no-store", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (currentUserId(token) !== userId || !Number.isFinite(data.credits) || !Number.isFinite(data.cashBalance)) return null;
    return { userId, credits: data.credits as number, cashBalance: data.cashBalance as number };
  })().catch(() => null).finally(() => { if (pending?.request === request) pending = undefined; });
  pending = { token, userId, request };
  return request;
}

// Only an invalidation crosses tabs. Each tab reads the authenticated user's own wallet.
export function notifyPaymentCredited(token: string) {
  const userId = currentUserId(token);
  if (!userId) return;
  window.dispatchEvent(new CustomEvent(signalKey, { detail: userId }));
  try { localStorage.setItem(signalKey, JSON.stringify([userId, Date.now(), Math.random()])); } catch { /* Same-tab refresh remains available. */ }
}

export function subscribePaymentWallet(callback: (userId: string) => void) {
  const local = (e: Event) => { const id = (e as CustomEvent).detail; if (typeof id === "string") callback(id); };
  const storage = (e: StorageEvent) => {
    if (e.key !== signalKey || !e.newValue) return;
    try { const [id] = JSON.parse(e.newValue); if (typeof id === "string") callback(id); } catch { /* Ignore invalid notifications. */ }
  };
  window.addEventListener(signalKey, local);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(signalKey, local); window.removeEventListener("storage", storage); };
}
