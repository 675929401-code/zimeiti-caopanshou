export interface ClientSubmissionIdentity {
  readonly fingerprint: string;
  readonly requestId: string;
}

function canonicalizeClientValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeClientValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalizeClientValue(source[key])]),
    );
  }
  return value;
}

export function fingerprintClientSubmission(value: unknown): string {
  return JSON.stringify(canonicalizeClientValue(value));
}

/**
 * Reuse the request ID while the paid input is unchanged. Callers retain this
 * identity for failures with an ambiguous provider outcome and clear it only
 * after a confirmed successful response.
 */
export function resolveClientSubmissionIdentity(
  current: ClientSubmissionIdentity | null,
  fingerprint: string,
  createRequestId: () => string,
): ClientSubmissionIdentity {
  if (current?.fingerprint === fingerprint) return current;
  return { fingerprint, requestId: createRequestId() };
}

export function clearConfirmedClientSubmissionIdentity(
  current: ClientSubmissionIdentity | null,
  confirmedRequestId: string,
): ClientSubmissionIdentity | null {
  return current?.requestId === confirmedRequestId ? null : current;
}
