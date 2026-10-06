/** Compare JSON values without treating object-key order or editor indentation as edits. */
export function manjuDraftFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(manjuDraftFingerprint).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${manjuDraftFingerprint(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function manjuJsonEditorChanged(editor: string, savedPayload: unknown): boolean {
  try {
    return manjuDraftFingerprint(JSON.parse(editor)) !== manjuDraftFingerprint(savedPayload);
  } catch {
    return true;
  }
}
