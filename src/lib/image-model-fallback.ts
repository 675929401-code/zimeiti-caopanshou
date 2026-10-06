export type ImageModelFallbackCandidate = {
  id: string;
  model_name: string;
  provider: string;
  api_endpoint: string;
  api_key: string;
  supports_image_input?: boolean;
};

function normalized(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isUsable(candidate: ImageModelFallbackCandidate): boolean {
  return Boolean(
    candidate.id
    && candidate.model_name
    && candidate.api_endpoint
    && candidate.api_key,
  );
}

function isEquivalent(
  primary: ImageModelFallbackCandidate,
  candidate: ImageModelFallbackCandidate,
): boolean {
  return normalized(candidate.model_name) === normalized(primary.model_name)
    && normalized(candidate.provider) === normalized(primary.provider)
    && Boolean(candidate.supports_image_input) === Boolean(primary.supports_image_input);
}

export function orderEquivalentImageModelCandidates<T extends ImageModelFallbackCandidate>(
  primary: T,
  rows: T[],
): T[] {
  const alternatives = rows
    .filter((candidate) => candidate.id !== primary.id && isUsable(candidate) && isEquivalent(primary, candidate))
    .sort((left, right) => {
      const leftSameEndpoint = normalized(left.api_endpoint) === normalized(primary.api_endpoint) ? 0 : 1;
      const rightSameEndpoint = normalized(right.api_endpoint) === normalized(primary.api_endpoint) ? 0 : 1;
      return leftSameEndpoint - rightSameEndpoint;
    });

  return isUsable(primary) ? [primary, ...alternatives] : alternatives;
}

export function isRetryableImageUpstreamStatus(status: number): boolean {
  // 网关 5xx 也可能发生在供应商已经受理之后。仅 HTTP 状态不能证明
  // 本次未生成或未计费，因此不得据此向同渠道或其他渠道重新 POST。
  void status;
  return false;
}
