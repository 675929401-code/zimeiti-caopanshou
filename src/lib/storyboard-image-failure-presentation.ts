type PostFailure = {
  code?: string;
  requestAccepted?: boolean;
  confirmedRejected?: boolean;
  upstreamCalled?: boolean;
  billed?: boolean;
};
type OriginalStatus = {
  state?: string;
  message?: string;
  canRecover?: boolean;
  canResubmit?: boolean;
  sameKeyCanResubmit?: boolean;
} | null;

/** A generic missing receipt cannot erase the reason a POST was refused. */
export function storyboardImageFailurePresentation(post: PostFailure, status: OriginalStatus, message: string) {
  const emptyStatus = !status || status.state === "not_found";
  const conflictingPost = post.requestAccepted === true || post.upstreamCalled === true || post.billed === true;
  const authoritativePreclaim = !conflictingPost && (post.requestAccepted === false
    || post.code === "IMAGE_REQUEST_SNAPSHOT_INVALID"
    || post.upstreamCalled === false && post.billed === false);
  const rejectedReceipt = status?.state === "rejected" && status.canResubmit === true
    && status.sameKeyCanResubmit === false;
  // Any accepted, processing, completed or unknown receipt wins over a stale
  // POST flag. Preserve its keys and billing until the original task resolves.
  const confirmedRejected = status?.canRecover !== true && (rejectedReceipt
    || emptyStatus && !conflictingPost && (post.confirmedRejected === true || authoritativePreclaim));
  const retainPost = authoritativePreclaim && emptyStatus;
  const code = retainPost && /^[A-Z][A-Z0-9_]{1,80}$/u.test(post.code || "") ? post.code : undefined;
  return {
    confirmedRejected,
    message: retainPost ? `${code ? `[${code}] ` : ""}${message}` : status?.message || message,
  };
}
