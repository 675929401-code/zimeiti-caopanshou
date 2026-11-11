/** Only known module-resource failures require a fresh document to retry imports. */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  if (typeof message !== "string") return false;

  return (
    /^Loading (?:CSS )?chunk [\w-]+ failed(?:[.\s:(]|$)/iu.test(message) ||
    /^Failed to fetch dynamically imported module(?:[.\s:]|$)/iu.test(message) ||
    /^error loading dynamically imported module(?:[.\s:]|$)/iu.test(message) ||
    /^Importing a module script failed(?:[.\s:]|$)/iu.test(message)
  );
}
