"use client";

/**
 * Page-local request coalescing for root client bootstrap data.
 *
 * The cache is intentionally tiny and short-lived: it only absorbs concurrent
 * root effects (including React Strict Mode remounts). Auth data is held in a
 * single token-scoped slot so switching tokens immediately evicts the previous
 * user's response.
 */

export const CLIENT_BOOTSTRAP_CACHE_TTL_MS = 1_500;

export interface ClientBootstrapRequestOptions {
  /** Bypass a settled TTL value. An equivalent request already in flight is still shared. */
  force?: boolean;
}

interface CachedResponseEntry {
  scopeKey: string | null;
  response: Response | null;
  expiresAt: number;
  inFlight: Promise<Response> | null;
  generation: number;
}

function createEntry(): CachedResponseEntry {
  return {
    scopeKey: null,
    response: null,
    expiresAt: 0,
    inFlight: null,
    generation: 0,
  };
}

const settingsEntry = createEntry();
const appearanceEntry = createEntry();
const authMeEntry = createEntry();
const layoutEntry = createEntry();

function clearEntry(entry: CachedResponseEntry): void {
  entry.generation += 1;
  entry.scopeKey = null;
  entry.response = null;
  entry.expiresAt = 0;
  entry.inFlight = null;
}

export class ClientBootstrapRequestInvalidatedError extends Error {
  constructor() {
    super("The client bootstrap request was invalidated before it completed.");
    this.name = "ClientBootstrapRequestInvalidatedError";
  }
}

function cloneResponse(response: Response): Response {
  // Keep the cached response body untouched so every consumer can parse its own clone.
  return response.clone();
}

function cloneIfCurrent(
  entry: CachedResponseEntry,
  scopeKey: string,
  generation: number,
  response: Response,
): Response {
  if (entry.scopeKey !== scopeKey || entry.generation !== generation) {
    throw new ClientBootstrapRequestInvalidatedError();
  }
  return cloneResponse(response);
}

function readResponse(
  entry: CachedResponseEntry,
  scopeKey: string,
  request: () => Promise<Response>,
  options: ClientBootstrapRequestOptions = {},
): Promise<Response> {
  if (entry.scopeKey !== scopeKey) {
    // Auth uses the token itself as the private in-memory scope. Only one token
    // is retained, so a user/token switch cannot reuse the previous response.
    clearEntry(entry);
    entry.scopeKey = scopeKey;
  }

  const generation = entry.generation;

  // Single-flight always wins, including for simultaneous explicit refreshes.
  if (entry.inFlight) {
    return entry.inFlight.then((response) => cloneIfCurrent(entry, scopeKey, generation, response));
  }

  const now = Date.now();
  if (!options.force && entry.response && entry.expiresAt > now) {
    return Promise.resolve(cloneIfCurrent(entry, scopeKey, generation, entry.response));
  }

  entry.response = null;
  entry.expiresAt = 0;

  const inFlight = request()
    .then((response) => {
      // An invalidation or token switch may have replaced this request while it
      // was pending. In that case it is not written into the current cache slot,
      // and cloneIfCurrent rejects every stale caller below.
      if (entry.scopeKey === scopeKey && entry.inFlight === inFlight) {
        entry.inFlight = null;
        if (response.ok) {
          entry.response = response;
          entry.expiresAt = Date.now() + CLIENT_BOOTSTRAP_CACHE_TTL_MS;
        } else {
          // HTTP failures are shared only while in flight. A later caller must
          // be able to retry immediately instead of inheriting a cached 401/5xx.
          entry.response = null;
          entry.expiresAt = 0;
        }
      }
      return response;
    })
    .catch((error: unknown) => {
      // Transport failures are retryable and must never poison the short cache.
      if (entry.scopeKey === scopeKey && entry.inFlight === inFlight) {
        clearEntry(entry);
      }
      throw error;
    });

  entry.inFlight = inFlight;
  return inFlight.then((response) => cloneIfCurrent(entry, scopeKey, generation, response));
}

export function getClientBootstrapSettings(
  options: ClientBootstrapRequestOptions = {},
): Promise<Response> {
  return readResponse(
    settingsEntry,
    "public-settings",
    () => fetch("/api/settings", { cache: "no-store", credentials: "same-origin" }),
    options,
  );
}

export function getClientBootstrapAppearance(
  options: ClientBootstrapRequestOptions = {},
): Promise<Response> {
  return readResponse(
    appearanceEntry,
    "public-appearance",
    () => fetch("/api/settings/appearance", { cache: "no-store", credentials: "same-origin" }),
    options,
  );
}

export function getClientBootstrapAuthMe(
  token: string,
  options: ClientBootstrapRequestOptions = {},
): Promise<Response> {
  if (!token) {
    return Promise.reject(new Error("An auth token is required for the bootstrap auth request."));
  }

  return readResponse(
    authMeEntry,
    token,
    () => fetch("/api/auth/me", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Authorization: `Bearer ${token}` },
    }),
    options,
  );
}

export function getClientBootstrapLayout(
  options: ClientBootstrapRequestOptions = {},
): Promise<Response> {
  return readResponse(
    layoutEntry,
    "public-layout",
    () => fetch("/api/settings/layout", { cache: "no-store", credentials: "same-origin" }),
    options,
  );
}

export function invalidateClientBootstrapSettings(): void {
  clearEntry(settingsEntry);
}

export function invalidateClientBootstrapAppearance(): void {
  clearEntry(appearanceEntry);
}

export function invalidateClientBootstrapAuthMe(): void {
  clearEntry(authMeEntry);
}

export function invalidateClientBootstrapLayout(): void {
  clearEntry(layoutEntry);
}

/** Clears all page-local bootstrap state. Also used by the offline contract verifier. */
export function invalidateClientBootstrapCache(): void {
  invalidateClientBootstrapSettings();
  invalidateClientBootstrapAppearance();
  invalidateClientBootstrapAuthMe();
  invalidateClientBootstrapLayout();
}
