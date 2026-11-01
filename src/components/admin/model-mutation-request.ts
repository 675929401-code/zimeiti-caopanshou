export interface ModelMutationAttempt { payload: string; id: string }

/** Keep an operation identity for the same unresolved logical form, only in memory. */
export function modelMutationAttempt(previous: ModelMutationAttempt | null, method: string, body: unknown): ModelMutationAttempt {
  const payload = JSON.stringify([method, body]);
  return previous?.payload === payload ? previous : { payload, id: crypto.randomUUID() };
}
