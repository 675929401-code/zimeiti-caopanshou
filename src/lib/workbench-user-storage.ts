export interface WorkbenchIdentity {
  userId: string;
  token: string;
}

export interface WorkbenchStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** AppContext updates user and token together. Unresolved/logged-out identities cannot read drafts. */
export function resolveWorkbenchIdentity(auth: {
  isAuthenticated: boolean;
  user: { id: string } | null;
  token: string | null;
}): WorkbenchIdentity | null {
  const userId = auth.user?.id.trim();
  const token = auth.token?.trim();
  return auth.isAuthenticated && userId && token ? { userId, token } : null;
}

/** Never fall back to an ownerless legacy key: those bytes remain untouched for separate recovery. */
export function workbenchUserStorageKey(baseKey: string, userId: string): string {
  if (!baseKey.trim() || !userId.trim()) throw new Error("WORKBENCH_STORAGE_IDENTITY_REQUIRED");
  return `${baseKey}:user:${encodeURIComponent(userId.trim())}`;
}

export function createUserScopedWorkbenchStorage(storage: WorkbenchStorageLike, userId: string): WorkbenchStorageLike {
  const scopeKey = (key: string) => workbenchUserStorageKey(key, userId);
  return {
    getItem: (key) => storage.getItem(scopeKey(key)),
    setItem: (key, value) => storage.setItem(scopeKey(key), value),
    removeItem: (key) => storage.removeItem(scopeKey(key)),
  };
}

/** Local storage routing only; the server remains responsible for authenticating every API call. */
export function readBrowserWorkbenchIdentity(storage?: Pick<WorkbenchStorageLike, "getItem">): WorkbenchIdentity | null {
  if (!storage && typeof window === "undefined") return null;
  try {
    const source = storage || window.localStorage;
    const token = source.getItem("auth_token")?.trim();
    const cached = JSON.parse(source.getItem("auth_user") || "null") as { id?: unknown } | null;
    if (!token || typeof cached?.id !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const raw = parts[1].replace(/-/gu, "+").replace(/_/gu, "/");
    const claims = JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "="))) as { userId?: unknown; exp?: unknown };
    if (typeof claims.userId !== "string" || claims.userId !== cached.id) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    return resolveWorkbenchIdentity({ isAuthenticated: true, user: { id: cached.id }, token });
  } catch { return null; }
}
