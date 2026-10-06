export const ACTIVE_PROVIDER_JOB_STATES = new Set([
  'preparing', 'dispatching', 'running', 'submission_unknown', 'finalizing',
]);

export type ProviderQueueJob = { providerKey: string; state: string };

/**
 * Executable queue contract mirrored by the SQL claim RPCs. It exists so the
 * bidirectional exclusion can be regression-tested without a live database.
 */
export function providerChannelCanClaim(input: {
  providerKey: string;
  ownActive: ProviderQueueJob[];
  oppositeActive: ProviderQueueJob[];
}) {
  const sameProviderActive = (job: ProviderQueueJob) => job.providerKey === input.providerKey
    && ACTIVE_PROVIDER_JOB_STATES.has(job.state);
  return !input.ownActive.some(sameProviderActive) && !input.oppositeActive.some(sameProviderActive);
}

