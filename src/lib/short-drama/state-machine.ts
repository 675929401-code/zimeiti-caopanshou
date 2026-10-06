import type { ShortDramaJobState } from "./contracts";

export const SHORT_DRAMA_JOB_TRANSITIONS: Readonly<
  Record<ShortDramaJobState, readonly ShortDramaJobState[]>
> = {
  accepted: ["queued", "cancelled", "failed"],
  queued: ["running", "cancelled", "failed"],
  running: ["result_staging", "retry_wait", "failed", "cancelled"],
  result_staging: ["persisting", "retry_wait", "failed"],
  persisting: ["finalizing", "retry_wait", "failed"],
  finalizing: ["succeeded", "retry_wait", "failed"],
  retry_wait: ["queued", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const SHORT_DRAMA_TERMINAL_JOB_STATES: ReadonlySet<ShortDramaJobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export class InvalidShortDramaJobTransitionError extends Error {
  readonly code = "SHORT_DRAMA_JOB_TRANSITION_INVALID";

  constructor(
    readonly currentState: ShortDramaJobState,
    readonly requestedState: ShortDramaJobState,
  ) {
    super(`不允许从 ${currentState} 转换到 ${requestedState}`);
    this.name = "InvalidShortDramaJobTransitionError";
  }
}

export function isShortDramaJobTerminal(state: ShortDramaJobState): boolean {
  return SHORT_DRAMA_TERMINAL_JOB_STATES.has(state);
}

export function canTransitionShortDramaJob(
  currentState: ShortDramaJobState,
  requestedState: ShortDramaJobState,
): boolean {
  return SHORT_DRAMA_JOB_TRANSITIONS[currentState].includes(requestedState);
}

export function assertShortDramaJobTransition(
  currentState: ShortDramaJobState,
  requestedState: ShortDramaJobState,
): void {
  if (!canTransitionShortDramaJob(currentState, requestedState)) {
    throw new InvalidShortDramaJobTransitionError(currentState, requestedState);
  }
}

export function transitionShortDramaJob(
  currentState: ShortDramaJobState,
  requestedState: ShortDramaJobState,
): ShortDramaJobState {
  assertShortDramaJobTransition(currentState, requestedState);
  return requestedState;
}

