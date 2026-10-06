/** A deletion tombstone is authoritative, even when another source still has the old agent. */
export async function resolveAgentLookup<T extends Record<string, unknown>>(
  primary: T | null,
  fallback: () => Promise<T | null>,
  allowFallback: boolean,
): Promise<T | null> {
  if (primary) return primary.deleted_at == null ? primary : null;
  if (!allowFallback) return null;
  const remote = await fallback();
  return remote && remote.deleted_at == null ? remote : null;
}
