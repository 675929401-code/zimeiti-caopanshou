"use client";

const SESSION_PREFIX = "media-history-denied-v1:";
const TASK_PREFIX = "media-history-task-denied-v1:";
const LOCAL_EVENT = "media-history-offline-auth-change";
const TASK_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const deniedSessions = new Set<string>();
const deniedTasks = new Set<string>();
// A previous page's grant cannot authorize offline access after reload.
const verifiedSessions = new Set<string>();
// An account-level list response cannot reauthorize a specific asset that was
// denied in another tab while durable storage was unavailable. A task must
// also receive its own successful ticket in this page lifetime.
const verifiedTasks = new Set<string>();
const sessionVersions = new Map<string, number>();
const taskVersions = new Map<string, number>();
let revocationVersion = 0;
let coordinationReady = false;
let channel: BroadcastChannel | null = null;
const revocationListeners = new Set<() => void>();
const sessionMemoryKey = (userId: string, token: string) => `${userId}\0${token}`;
const taskMemoryKey = (userId: string, taskId: string) => `${userId}\0${taskId}`;
const verifiedTaskKey = (userId: string, token: string, taskId: string) => `${userId}\0${token}\0${taskId}`;

/** Capture before a request so an older success cannot undo a newer denial. */
export function captureOfflineAuthVersions(userId: string, token: string, taskId?: string): { session: number; task: number } {
  ensureCoordination();
  return { session: (sessionVersions.get(sessionMemoryKey(userId, token)) || 0) + revocationVersion,
    task: (taskId ? taskVersions.get(taskMemoryKey(userId, taskId)) || 0 : 0) + revocationVersion };
}

function revokePageGrants() {
  revocationVersion++;
  verifiedSessions.clear();
  verifiedTasks.clear();
  for (const listener of revocationListeners) listener();
}

function ensureCoordination() {
  if (coordinationReady || typeof window === "undefined") return;
  coordinationReady = true;
  try {
    channel = new BroadcastChannel("media-history-offline-revocations-v1");
    channel.onmessage = event => { if (event.data === "denied") revokePageGrants(); };
  } catch { channel = null; }
  window.addEventListener("storage", event => {
    if (event.newValue === "denied" && (event.key?.startsWith(SESSION_PREFIX) || event.key?.startsWith(TASK_PREFIX))) revokePageGrants();
  });
}

function broadcastDenial() {
  ensureCoordination();
  revokePageGrants();
  try { channel?.postMessage("denied"); } catch { /* Local grant is already revoked. */ }
}

/** A native media error has no observable HTTP status: require fresh online validation. */
export function suspendOfflineTask(userId: string, taskId: string): void {
  if (!userId || !TASK_ID.test(taskId)) return;
  const key = taskMemoryKey(userId, taskId);
  deniedTasks.add(key);
  taskVersions.set(key, (taskVersions.get(key) || 0) + 1);
  broadcastDenial();
}

async function digest(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("OFFLINE_AUTH_STATE_UNAVAILABLE");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function offlineSessionKey(userId: string, token: string): Promise<string> {
  if (!userId || !token) throw new Error("OFFLINE_AUTH_SCOPE_INVALID");
  return SESSION_PREFIX + await digest(`${userId}\0${token}`);
}

async function offlineTaskKey(userId: string, token: string, taskId: string): Promise<string> {
  if (!userId || !token || !TASK_ID.test(taskId)) throw new Error("OFFLINE_AUTH_SCOPE_INVALID");
  // A task denial survives token rotation for the same account. A newly
  // verified session alone does not resurrect a task confirmed missing/expired.
  return TASK_PREFIX + await digest(`${userId}\0${taskId}`);
}

function emit(key: string, value: "verified" | "denied" | null) {
  try { window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: { key, value } })); } catch { /* The durable marker still applies. */ }
}

/** Fail closed if the exact session was never verified or the marker is unreadable. */
export async function offlineAccessAllowed(userId: string, token: string, taskId?: string): Promise<boolean> {
  try {
    ensureCoordination();
    if (!channel || !verifiedSessions.has(sessionMemoryKey(userId, token)) || (taskId && !verifiedTasks.has(verifiedTaskKey(userId, token, taskId)))) return false;
    if (deniedSessions.has(sessionMemoryKey(userId, token)) || (taskId && deniedTasks.has(taskMemoryKey(userId, taskId)))) return false;
    // A browser that cannot write a denial marker cannot safely enable an
    // offline read; the probe contains no identity or token.
    const probe = `${SESSION_PREFIX}probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    if (window.localStorage.getItem(await offlineSessionKey(userId, token)) === "denied") return false;
    if (taskId && window.localStorage.getItem(await offlineTaskKey(userId, token, taskId)) === "denied") return false;
    return verifiedSessions.has(sessionMemoryKey(userId, token)) && !deniedSessions.has(sessionMemoryKey(userId, token)) && (!taskId || (verifiedTasks.has(verifiedTaskKey(userId, token, taskId)) && !deniedTasks.has(taskMemoryKey(userId, taskId))));
  } catch { return false; }
}

/** Store only a hash of account and token; never store the token itself. */
export async function recordOfflineSession(userId: string, token: string, state: "verified" | "denied", stillCurrent: () => boolean = () => true, expectedVersion?: number): Promise<void> {
  const memoryKey = sessionMemoryKey(userId, token);
  const acceptedDenial = state === "denied" && stillCurrent();
  if (acceptedDenial) {
    deniedSessions.add(memoryKey);
    sessionVersions.set(memoryKey, (sessionVersions.get(memoryKey) || 0) + 1);
    broadcastDenial();
  }
  try {
    const key = await offlineSessionKey(userId, token);
    if (state === "denied" ? !acceptedDenial : (!stillCurrent() || (expectedVersion !== undefined && expectedVersion !== captureOfflineAuthVersions(userId, token).session))) return;
    // A delayed success from another tab must not undo an explicit denial.
    // Reauthentication receives a new token and therefore a new session key.
    if (state === "verified" && window.localStorage.getItem(key) === "denied") return;
    if (state === "denied") window.localStorage.setItem(key, state);
    else { deniedSessions.delete(memoryKey); verifiedSessions.add(memoryKey); }
    emit(key, state);
  } catch { /* Unreadable markers fail closed at the next offline read. */ }
}

/** A 404/410 is scoped to one task, not a revocation of the whole account. */
export async function recordOfflineTask(userId: string, token: string, taskId: string, denied: boolean, stillCurrent: () => boolean = () => true, expectedVersion?: number): Promise<void> {
  const memoryKey = taskMemoryKey(userId, taskId);
  const acceptedDenial = denied && stillCurrent();
  if (acceptedDenial) {
    deniedTasks.add(memoryKey);
    taskVersions.set(memoryKey, (taskVersions.get(memoryKey) || 0) + 1);
    broadcastDenial();
  }
  try {
    const key = await offlineTaskKey(userId, token, taskId);
    if (denied ? !acceptedDenial : (!stillCurrent() || (expectedVersion !== undefined && expectedVersion !== captureOfflineAuthVersions(userId, token, taskId).task))) return;
    // A confirmed removed/expired task must not be resurrected by an older
    // successful ticket response from another browsing context.
    if (!denied && window.localStorage.getItem(key) === "denied") return;
    if (denied) window.localStorage.setItem(key, "denied"); else window.localStorage.removeItem(key);
    if (!denied) { deniedTasks.delete(memoryKey); verifiedTasks.add(verifiedTaskKey(userId, token, taskId)); }
    emit(key, denied ? "denied" : null);
  } catch { /* Failure to store the marker is handled conservatively by callers. */ }
}

/** Revocation in this or another tab stops any already-open local preview. */
export function subscribeOfflineAuthRevocation(userId: string, token: string, taskId: string | null, onRevoked: () => void): () => void {
  if (typeof window === "undefined" || !userId || !token) return () => {};
  void taskId;
  ensureCoordination();
  revocationListeners.add(onRevoked);
  return () => { revocationListeners.delete(onRevoked); };
}
