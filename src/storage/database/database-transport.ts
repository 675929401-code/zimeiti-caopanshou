const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);

// PostgREST exposes functions through POST even when the database function is
// read-only. Keep this list deliberately narrow: only idempotent governance
// snapshots may inherit the single socket reconnect retry below. Mutation RPCs
// remain non-replayable unless they have their own atomic recovery contract.
const SAFE_READ_RPC_NAMES = new Set([
  "read_admin_access_snapshot",
  "read_admin_step_up_session",
  "read_admin_step_up_maintenance_lock",
]);

function isSocketFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;
  const value = error as { code?: string; name?: string; cause?: unknown; errors?: unknown[] };
  if (value.name === "AbortError" || value.name === "TimeoutError") return false;
  return TRANSIENT_SOCKET_CODES.has(value.code || "")
    || isSocketFailure(value.cause, depth + 1)
    || (Array.isArray(value.errors) && value.errors.length > 0
      && value.errors.every(item => isSocketFailure(item, depth + 1)));
}

async function waitForReconnect(signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 125);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry one dropped database connection, only for reads or the atomic recovery RPC.
 * The recovery function locks held reservations and releases each exactly once
 * (20260903074000_llm_stream_credit_reservations.sql). Never replay other writes.
 */
export function createDatabaseFetch(databaseUrl: string, transport: typeof fetch = fetch): typeof fetch {
  const base = new URL(databaseUrl);
  const restPath = `${base.pathname.replace(/\/$/, "")}/rest/v1/`;
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url || String(input));
    const method = (init?.method || request?.method || "GET").toUpperCase();
    const signal = init?.signal ?? request?.signal;
    const localDatabase = url.origin === base.origin && url.pathname.startsWith(restPath);
    const isRead = (method === "GET" || method === "HEAD") && !url.pathname.startsWith(`${restPath}rpc/`);
    const rpcName = url.pathname.startsWith(`${restPath}rpc/`)
      ? url.pathname.slice(`${restPath}rpc/`.length)
      : "";
    const isSafeReadRpc = method === "POST"
      && SAFE_READ_RPC_NAMES.has(rpcName)
      && typeof init?.body === "string";
    const isRecovery = method === "POST"
      && url.pathname === `${restPath}rpc/recover_llm_credit_reservations_atomic`
      && typeof init?.body === "string";
    const retryable = localDatabase && (isRead || isSafeReadRpc || isRecovery);
    // A Request can be consumed by fetch. Clone before the first call; streaming
    // POST bodies are never eligible, so this does not buffer uploads.
    const retryInput = retryable && request ? request.clone() : input;
    try {
      return await transport(input, init);
    } catch (error) {
      if (!retryable || signal?.aborted || !isSocketFailure(error)) throw error;
      await waitForReconnect(signal);
      return transport(retryInput, init);
    }
  };
}
