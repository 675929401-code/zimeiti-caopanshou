"use client";

export type AdminWalletKind = "cash_topup" | "credit_topup" | "credit_set";
export type AdminWalletPayload = { userId: string; amount?: number; credits?: number; description?: string; notifyUser?: boolean };
export type PendingAdminWalletAttempt = {
  kind: AdminWalletKind;
  idempotencyKey: string;
  payload: AdminWalletPayload;
  submissions: number;
};
type WalletResponse = Record<string, unknown>;
const kinds: AdminWalletKind[] = ["cash_topup", "credit_topup", "credit_set"];
const inFlight = new Set<string>();

function storageKey(adminId: string, kind: AdminWalletKind) {
  return `admin-wallet-pending:v1:${adminId}:${kind}`;
}

function readAttempt(storage: Storage, key: string): PendingAdminWalletAttempt | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingAdminWalletAttempt;
    if (kinds.includes(value.kind) && typeof value.idempotencyKey === "string"
      && value.idempotencyKey.length > 8 && typeof value.payload?.userId === "string"
      && Number.isInteger(value.submissions) && value.submissions >= 0) return value;
  } catch { /* Keep malformed evidence instead of silently replacing its key. */ }
  throw new Error("有一笔余额操作记录无法读取，请先核对该记录，暂未发起新操作");
}

export function readPendingAdminWalletAttempts(adminId: string): PendingAdminWalletAttempt[] {
  if (!adminId || typeof window === "undefined") return [];
  return kinds.flatMap(kind => {
    const attempt = readAttempt(window.localStorage, storageKey(adminId, kind));
    return attempt ? [attempt] : [];
  });
}

function normalizedPayload(payload: AdminWalletPayload): AdminWalletPayload {
  return {
    userId: payload.userId,
    ...(payload.amount !== undefined ? { amount: payload.amount } : {}),
    ...(payload.credits !== undefined ? { credits: payload.credits } : {}),
    ...(payload.description !== undefined ? { description: payload.description } : {}),
    ...(payload.notifyUser !== undefined ? { notifyUser: payload.notifyUser } : {}),
  };
}

/** A terminal receipt must identify this request and contain its exact balances. */
function hasReceipt(data: WalletResponse, attempt: PendingAdminWalletAttempt): boolean {
  const validId = (value: unknown) => typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
  return data.success === true && data.idempotencyKey === attempt.idempotencyKey
    && typeof data.balanceBefore === "number" && Number.isFinite(data.balanceBefore)
    && typeof data.balanceAfter === "number" && Number.isFinite(data.balanceAfter)
    && typeof data.delta === "number" && Number.isFinite(data.delta)
    && data.balanceBefore >= 0 && data.balanceAfter >= 0
    && Math.abs(data.balanceAfter - data.balanceBefore - data.delta) < 0.000001
    && (attempt.kind === "credit_set"
      ? validId(data.adjustmentId) && data.balanceAfter === attempt.payload.credits
      : typeof attempt.payload.amount === "number" && attempt.payload.amount > 0
        && Math.abs(data.delta - attempt.payload.amount) < 0.000001)
    && (data.noChange === true
      ? attempt.kind === "credit_set" && data.delta === 0 && !data.operationId
      : validId(data.operationId));
}

export async function submitAdminWalletRequest(input: {
  adminId: string;
  kind: AdminWalletKind;
  payload: AdminWalletPayload;
  headers: Record<string, string>;
}): Promise<WalletResponse> {
  if (!input.adminId) throw new Error("管理员身份尚未加载，请稍后重试");
  const key = storageKey(input.adminId, input.kind);
  if (inFlight.has(key)) throw new Error("这笔操作正在处理，请勿重复提交");
  inFlight.add(key);
  const execute = async () => {
    const storage = window.localStorage;
    const payload = normalizedPayload(input.payload);
    const previous = readAttempt(storage, key);
    if (previous && (previous.kind !== input.kind || JSON.stringify(previous.payload) !== JSON.stringify(payload))) {
      throw new Error("同类操作还有一笔结果待确认，请先点击“核对原操作”，再提交新的金额或学员");
    }
    const attempt = previous || {
      kind: input.kind, idempotencyKey: `admin-${input.kind}:${crypto.randomUUID()}`,
      payload, submissions: 0,
    };
    attempt.submissions += 1;
    // Persist BEFORE sending; storage failure must not leave an unrecoverable payment request.
    storage.setItem(key, JSON.stringify(attempt));
    if (storage.getItem(key) !== JSON.stringify(attempt)) throw new Error("无法保存本次操作编号，本次未提交，请检查浏览器存储空间");
    let response: Response;
    let data: WalletResponse;
    try {
      response = await fetch(input.kind === "cash_topup" ? "/api/admin/cash" : "/api/admin/credits", {
        method: input.kind === "credit_set" ? "PUT" : "POST",
        headers: { ...input.headers, "Idempotency-Key": attempt.idempotencyKey },
        body: JSON.stringify({ ...attempt.payload, idempotencyKey: attempt.idempotencyKey }),
      });
      data = await response.json();
      if (!data || typeof data !== "object") throw new Error("Invalid receipt");
    } catch {
      throw new Error("网络中断，操作结果尚未确认。已保留原操作，请点击“核对原操作”查询，避免重复入账");
    }
    if (response.ok && hasReceipt(data, attempt)) {
      // If cleanup fails, keep the identity: another click can only replay the confirmed receipt.
      try { storage.removeItem(key); } catch { /* Durable receipt is still safe to replay. */ }
      return data;
    }
    const firstSubmissionRejected = attempt.submissions === 1 && (
      [400, 401, 403, 404, 429].includes(response.status)
      || (data.outcome === "not_applied" && data.code !== "ADMIN_WALLET_IDEMPOTENCY_CONFLICT")
    );
    // A rejection of a RETRY cannot prove that its earlier lost response did not commit.
    if (firstSubmissionRejected) {
      try { storage.removeItem(key); } catch { /* Preserve the original request if cleanup fails. */ }
    }
    const detail = typeof data.error === "string" ? data.error : "未收到可核对的入账结果";
    throw new Error(firstSubmissionRejected ? detail : `${detail}。已保留原操作，请核对后继续`);
  };
  try {
    // Browser locks serialize the same account/action across tabs as well as this page.
    if (typeof navigator !== "undefined" && navigator.locks) {
      return await navigator.locks.request(key, { ifAvailable: true }, lock => {
        if (!lock) throw new Error("另一页面正在处理同类操作，请稍后核对结果");
        return execute();
      });
    }
    return await execute();
  } finally {
    inFlight.delete(key);
  }
}
