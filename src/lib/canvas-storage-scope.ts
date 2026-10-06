export const CANVAS_ANONYMOUS_PRINCIPAL_KEY = "ai-creation-studio-free-canvas-anonymous-principal-v1";
export const CANVAS_LAST_PRINCIPAL_SCOPE_KEY = "ai-creation-studio-free-canvas-last-principal-scope-v1";

export interface CanvasStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CanvasStorageScope = `user-${string}` | `anonymous-${string}`;

function fingerprint(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function createAnonymousPrincipalId() {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function readAnonymousPrincipalId(storage: CanvasStorageLike) {
  const stored = storage.getItem(CANVAS_ANONYMOUS_PRINCIPAL_KEY)?.trim();
  if (stored && /^[a-z0-9-]{12,160}$/iu.test(stored)) return stored;
  const created = createAnonymousPrincipalId();
  storage.setItem(CANVAS_ANONYMOUS_PRINCIPAL_KEY, created);
  return created;
}

function anonymousScopeForPrincipal(principalId: string): CanvasStorageScope {
  return `anonymous-${fingerprint(principalId)}`;
}

export function userCanvasStorageScope(userId: string): CanvasStorageScope {
  const normalized = userId.trim();
  if (!normalized) throw new Error("Canvas user scope requires a stable user id");
  return `user-${fingerprint(normalized)}`;
}

export function rotateCanvasAnonymousScope(storage: CanvasStorageLike): CanvasStorageScope {
  const principalId = createAnonymousPrincipalId();
  storage.setItem(CANVAS_ANONYMOUS_PRINCIPAL_KEY, principalId);
  const scope = anonymousScopeForPrincipal(principalId);
  storage.setItem(CANVAS_LAST_PRINCIPAL_SCOPE_KEY, scope);
  return scope;
}

export function resolveCanvasStorageScope(
  storage: CanvasStorageLike,
  stableUserId?: string | null,
): CanvasStorageScope {
  if (stableUserId?.trim()) {
    const scope = userCanvasStorageScope(stableUserId);
    storage.setItem(CANVAS_LAST_PRINCIPAL_SCOPE_KEY, scope);
    return scope;
  }

  const lastScope = storage.getItem(CANVAS_LAST_PRINCIPAL_SCOPE_KEY);
  if (lastScope?.startsWith("user-")) {
    return rotateCanvasAnonymousScope(storage);
  }
  const scope = anonymousScopeForPrincipal(readAnonymousPrincipalId(storage));
  storage.setItem(CANVAS_LAST_PRINCIPAL_SCOPE_KEY, scope);
  return scope;
}

export function canvasScopedStorageKey(baseKey: string, scope: CanvasStorageScope) {
  const normalized = baseKey.trim();
  if (!normalized) throw new Error("Canvas storage key cannot be empty");
  return `${normalized}:scope:${scope}`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(globalThis.atob(normalized)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function canvasUserIdFromToken(token: string | null | undefined) {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) return null;
  const userId = typeof payload.userId === "string"
    ? payload.userId
    : typeof payload.sub === "string"
      ? payload.sub
      : "";
  return userId.trim() || null;
}

function cachedAuthUserId(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { id?: unknown };
    return typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
  } catch {
    return null;
  }
}

export function resolveCanvasAuthenticatedUserId(input: {
  token: string | null | undefined;
  appUserId?: string | null;
  connectedUserId?: string | null;
  cachedAuthUser?: string | null;
}) {
  if (!input.token) return null;
  return canvasUserIdFromToken(input.token)
    || input.connectedUserId?.trim()
    || input.appUserId?.trim()
    || cachedAuthUserId(input.cachedAuthUser)
    || null;
}
