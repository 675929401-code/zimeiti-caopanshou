type PrivateStorage = Pick<Storage, "getItem" | "setItem">;
export function officialPrivateCacheKey(ownerId: string, kind: string): string | null {
  if (!/^[A-Za-z0-9:_-]{1,160}$/u.test(ownerId) || !kind || kind.length > 240 || /[\r\n\0]/u.test(kind)) return null;
  return `official-private.v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(kind)}`;
}
/** Old global keys have no proven owner and are deliberately never imported. */
export function readOfficialPrivateCache<T>(storage: PrivateStorage, ownerId: string, kind: string): { ok: boolean; value: T | null } {
  const key = officialPrivateCacheKey(ownerId, kind);
  if (!key) return { ok: true, value: null };
  try {
    const raw = storage.getItem(key);
    return { ok: true, value: raw === null ? null : JSON.parse(raw) as T };
  } catch { return { ok: false, value: null }; }
}
/** Check captured ownership again at the actual write, including delayed UI callbacks. */
export function writeOfficialPrivateCache<T>(storage: PrivateStorage, ownerId: string, kind: string, value: T, currentOwner: () => string): boolean {
  const key = officialPrivateCacheKey(ownerId, kind);
  if (!key || currentOwner() !== ownerId) return false;
  try {
    const encoded = JSON.stringify(value);
    if (currentOwner() !== ownerId) return false;
    storage.setItem(key, encoded);
    return true;
  } catch { return false; }
}
