"use client";

type VerifiedClientAuth = {
  isAuthenticated: boolean;
  user: { id: string } | null;
  token: string | null;
};

export type ClientAccountScope = {
  /** Opaque, memory-only React identity. Never derive it from a credential. */
  readonly epoch: string;
  readonly userId: string;
  readonly token: string;
  isCurrent: () => boolean;
  beginRequest: (lane: string) => () => boolean;
};

let nextEpoch = 0;

/** One owner per component tree; auth context is the sole identity authority. */
export function createClientAccountScope() {
  let current: ClientAccountScope | null = null;
  let prepared: ClientAccountScope | null = null;
  let generation = 0;
  return {
    /** Render may prepare an identity, but must not revoke the committed tree. */
    prepare(auth: VerifiedClientAuth): ClientAccountScope | null {
      const userId = auth.isAuthenticated ? auth.user?.id : null;
      const token = auth.isAuthenticated ? auth.token : null;
      if (!userId || !token) {
        return null;
      }
      if (current?.userId === userId && current.token === token) return current;
      if (prepared?.userId === userId && prepared.token === token) return prepared;
      const requests = new Map<string, number>();
      const scope: ClientAccountScope = {
        epoch: `account-scope-${++nextEpoch}`,
        userId,
        token,
        isCurrent: () => current === scope,
        beginRequest(lane) {
          const lease = generation;
          const sequence = (requests.get(lane) || 0) + 1;
          requests.set(lane, sequence);
          return () => current === scope && generation === lease && requests.get(lane) === sequence;
        },
      };
      prepared = scope;
      return scope;
    },
    /** Activate only after React commits; cleanup owns exactly this lease. */
    activate(scope: ClientAccountScope | null) {
      const lease = ++generation;
      current = scope;
      prepared = null;
      return () => {
        if (generation === lease) {
          current = null;
          generation++;
        }
      };
    },
  };
}
