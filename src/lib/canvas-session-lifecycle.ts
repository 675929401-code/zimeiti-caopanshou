export interface CanvasSessionIdentity {
  id: string;
}

function defaultRandomUUID() {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function createCanvasSessionId(randomUUID: () => string = defaultRandomUUID) {
  const value = randomUUID().trim();
  if (!value) throw new Error("Canvas session id generator returned an empty value");
  return `canvas:${value}`;
}

export function prependFreshCanvasCopy<T extends CanvasSessionIdentity>(
  sessions: readonly T[],
  createCopy: () => T,
) {
  const copy = createCopy();
  if (sessions.some((session) => session.id === copy.id)) {
    throw new Error(`Canvas copy id must be unique: ${copy.id}`);
  }
  return {
    sessions: [copy, ...sessions],
    activeSession: copy,
  };
}

export function restoreActiveCanvasSession<T extends CanvasSessionIdentity>(
  sessions: readonly T[],
  savedActiveId: string | null | undefined,
) {
  if (sessions.length === 0) return null;
  return sessions.find((session) => session.id === savedActiveId) || sessions[0];
}
